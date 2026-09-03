package main

import (
	"fmt"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
)

// edit is one planned text replacement, in absolute byte offsets into the
// original file content.
type edit struct {
	start, end int
	text       string
}

// applyOps applies every op to path in order and returns the freshly
// re-parsed model.
//
// Each op is planned against a *fresh* parse of the file rather than all of
// them against one initial parse. That is what makes a batch like
// [add gridOrders, setItems gridOrders] work: the second op needs to see the
// control the first one created, and it needs byte offsets that account for
// the text the first one inserted. Planning everything up front could only
// ever handle ops that touch disjoint, already-existing regions.
//
// The whole batch is atomic: if any op fails to plan or apply, the file is
// restored to exactly what it was before the call.
func applyOps(path string, ops []Op) (*FormModel, error) {
	original, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	rollback := func(cause error) (*FormModel, error) {
		if wErr := os.WriteFile(path, original, 0o644); wErr != nil {
			return nil, fmt.Errorf("%w (and restoring %s failed: %v)", cause, path, wErr)
		}
		return nil, cause
	}

	for i, op := range ops {
		r, err := parseFile(path)
		if err != nil {
			return rollback(err)
		}
		edits, err := planOp(r, op)
		if err != nil {
			return rollback(fmt.Errorf("op %d (%q on %q): %w", i, op.Op, op.ID, err))
		}
		buf, err := spliceEdits(r.src, edits)
		if err != nil {
			return rollback(fmt.Errorf("op %d (%q on %q): %w", i, op.Op, op.ID, err))
		}
		if err := os.WriteFile(path, buf, 0o644); err != nil {
			return rollback(fmt.Errorf("write %s: %w", path, err))
		}

		// A rename also touches the hand-written counterpart file, which is
		// outside the edit model - do it once the designer file is written
		// so both halves move together.
		if op.Op == "rename" {
			if pc, ok := r.controls[op.ID]; ok {
				renames := renamedHandlers(pc, op.ID, op.Value)
				if err := renameHandlersInPairedFile(path, r.model.ReceiverType, renames); err != nil {
					return rollback(fmt.Errorf("op %d (rename %q): %w", i, op.ID, err))
				}
			}
		}
	}

	fresh, err := parseFile(path)
	if err != nil {
		return rollback(fmt.Errorf("re-parse after apply: %w", err))
	}
	return fresh.model, nil
}

// spliceEdits applies one op's edits to src, working from the end of the
// file backwards so earlier offsets stay valid.
func spliceEdits(src []byte, edits []edit) ([]byte, error) {
	sorted := append([]edit(nil), edits...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].start > sorted[j].start })

	buf := append([]byte(nil), src...)
	for i, e := range sorted {
		if i > 0 && e.end > sorted[i-1].start {
			return nil, fmt.Errorf("internal error: overlapping edits")
		}
		if e.start < 0 || e.end > len(buf) || e.start > e.end {
			return nil, fmt.Errorf("internal error: invalid edit range [%d,%d) in %d-byte file", e.start, e.end, len(buf))
		}
		buf = append(buf[:e.start], append([]byte(e.text), buf[e.end:]...)...)
	}
	return buf, nil
}

func planOp(r *parseResult, op Op) ([]edit, error) {
	switch op.Op {
	case "setBounds":
		return one(planSetBounds(r, op))
	case "setText":
		return one(planSetText(r, op))
	case "setItems":
		return one(planSetItems(r, op))
	case "setCollection":
		return planSetCollection(r, op)
	case "setProp":
		return one(planSetProp(r, op))
	case "setEvent":
		return one(planSetEvent(r, op))
	case "add":
		return planAdd(r, op)
	case "setParent":
		return one(planSetParent(r, op))
	case "remove":
		return planRemove(r, op)
	case "setForm":
		return planSetForm(r, op)
	case "rename":
		return planRename(r, op)
	default:
		return nil, fmt.Errorf("unknown op %q", op.Op)
	}
}

func one(e *edit, err error) ([]edit, error) {
	if err != nil {
		return nil, err
	}
	if e == nil {
		return nil, nil
	}
	return []edit{*e}, nil
}

func mustControl(r *parseResult, id string) (*pcontrol, error) {
	pc, ok := r.controls[id]
	if !ok || pc.blockEnd == 0 {
		return nil, fmt.Errorf("no such control %q", id)
	}
	return pc, nil
}

// planSetForm resizes the Form itself: goforms.NewForm(title, w, h)'s w/h
// args in the New<ReceiverType> constructor, and - if present - a
// `<recv>.SetClientSize(w, h)` call inside initializeComponent, which runs
// after NewForm and would otherwise silently override this resize. Neither
// is a "control" (no ID), so this can't reuse mustControl/planSetBounds.
func planSetForm(r *parseResult, op Op) ([]edit, error) {
	if len(r.formSizeArgs) != 3 {
		return nil, fmt.Errorf("could not locate goforms.NewForm(title, w, h) to resize")
	}
	newArgs := fmt.Sprintf("%s, %s", fnum(op.W), fnum(op.H))
	edits := []edit{{
		offset(r.fset, r.formSizeArgs[1].Pos()),
		offset(r.fset, r.formSizeArgs[2].End()),
		newArgs,
	}}
	if len(r.clientSizeArgs) == 2 {
		edits = append(edits, edit{
			offset(r.fset, r.clientSizeArgs[0].Pos()),
			offset(r.fset, r.clientSizeArgs[1].End()),
			newArgs,
		})
	}
	return edits, nil
}

func planSetBounds(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	newArgs := fmt.Sprintf("%s, %s, %s, %s", fnum(op.X), fnum(op.Y), fnum(op.W), fnum(op.H))
	if len(pc.boundsArgs) == 4 {
		start := offset(r.fset, pc.boundsArgs[0].Pos())
		end := offset(r.fset, pc.boundsArgs[3].End())
		return &edit{start, end, newArgs}, nil
	}
	// No existing SetBounds call (hand-written file that omitted it) - insert
	// one right after the control's construction line.
	insertAt, indent := afterConstructionLine(r, pc)
	stmt := fmt.Sprintf("%s%s.%s.SetBounds(%s)\n", indent, r.model.RecvVar, op.ID, newArgs)
	return &edit{insertAt, insertAt, stmt}, nil
}

func planSetText(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	if pc.textArg != nil {
		return &edit{offset(r.fset, pc.textArg.Pos()), offset(r.fset, pc.textArg.End()), quote(op.Text)}, nil
	}
	desc := catalog[pc.spec.Type]
	if _, ok := desc.Setters["SetText"]; !ok {
		return nil, fmt.Errorf("control type %q has no settable text", pc.spec.Type)
	}
	insertAt, indent := afterConstructionLine(r, pc)
	stmt := fmt.Sprintf("%s%s.%s.SetText(%s)\n", indent, r.model.RecvVar, op.ID, quote(op.Text))
	return &edit{insertAt, insertAt, stmt}, nil
}

func planSetItems(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	// ListView and DataGridView reuse Items for their column titles, which
	// is the same comma-joined string list on the wire.
	switch pc.spec.Type {
	case "ComboBox", "ListBox", "ListView", "DataGridView", "CheckedListBox", "DomainUpDown":
	default:
		return nil, fmt.Errorf("control type %q has no items", pc.spec.Type)
	}
	joined := make([]string, len(op.Items))
	for i, it := range op.Items {
		joined[i] = quote(it)
	}
	text := strings.Join(joined, ", ")
	if pc.itemsRange != nil {
		return &edit{offset(r.fset, pc.itemsRange.Start), offset(r.fset, pc.itemsRange.End), text}, nil
	}
	return nil, fmt.Errorf("could not locate an items list to replace for %q", op.ID)
}

// planSetCollection rewrites a control's whole item list - ToolStrip buttons,
// tab titles, tree nodes. The new list replaces the *first* existing add call
// and the remaining ones are deleted, rather than replacing one span covering
// all of them: an unrelated statement (a SetBounds, an event wiring) that
// happens to sit between two add calls would otherwise be swallowed.
func planSetCollection(r *parseResult, op Op) ([]edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	cd := collectionFor(pc.spec.Type)
	if cd == nil {
		return nil, fmt.Errorf("control type %q has no editable item list", pc.spec.Type)
	}
	if pc.spec.CollectionReadOnly {
		return nil, fmt.Errorf("%q's %s are built by code this designer can't regenerate - edit them in the .go file",
			op.ID, strings.ToLower(cd.Label))
	}

	// collectionLines reads the item list off a spec; give it the new one
	// without disturbing the parse result the remaining ops are planned from.
	next := *pc.spec
	next.Collection = op.Collection

	occupied := occupiedSlots(r, op.ID)
	// Pages are identified by position, so a shorter list drops the last
	// pages - and any control standing on one would be left referring to a
	// page variable that is no longer declared. Refusing beats emitting a
	// file that doesn't compile.
	if cd.ItemSlot != "" {
		for slot := range occupied {
			if i := pageSlotIndex(pc.spec.Type, slot); i >= len(op.Collection) {
				return nil, fmt.Errorf("%s %q still has controls on it; move or delete them before removing it",
					strings.ToLower(singularLabel(cd.Label)), slot)
			}
		}
	}

	if len(pc.collectionStmts) == 0 {
		insertAt, indent := beforeAddControlLine(r, pc)
		return []edit{{insertAt, insertAt, collectionLines(r.model.RecvVar, &next, indent)}}, nil
	}

	first := pc.collectionStmts[0]
	firstStart := offset(r.fset, first.Start)
	start, end := wholeLines(r.src, firstStart, offset(r.fset, first.End))
	edits := []edit{{start, end, collectionLines(r.model.RecvVar, &next, leadingIndent(r.src, firstStart))}}
	for _, st := range pc.collectionStmts[1:] {
		edits = addLineDelete(edits, r.src, offset(r.fset, st.Start), offset(r.fset, st.End))
	}
	return edits, nil
}

// parentTypeOf reports the control type of a parent ID, or "" for the Form
// (and for a parent that isn't there, which checkParent has already refused
// by the time this matters).
func parentTypeOf(r *parseResult, parent string) string {
	if pc, ok := r.controls[parent]; ok {
		return pc.spec.Type
	}
	return ""
}

// occupiedSlots names the slots of one control that currently hold children.
// Page collections use it to decide which pages need a variable bound to
// them, and to refuse a rewrite that would delete a page still in use.
func occupiedSlots(r *parseResult, id string) map[string]bool {
	out := map[string]bool{}
	for _, c := range r.model.Controls {
		if c.Parent == id && c.ParentSlot != "" {
			out[c.ParentSlot] = true
		}
	}
	return out
}

// singularLabel turns a collection's plural label into the name of one item,
// for error messages ("Pages" -> "Page").
func singularLabel(label string) string {
	return strings.TrimSuffix(label, "s")
}

func planSetProp(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	desc := catalog[pc.spec.Type]
	text, err := formatPropValue(desc, op.Prop, op.Value)
	if err != nil {
		return nil, err
	}

	// The usual case: a setter call already exists, so just replace its
	// argument in place.
	if arg, ok := pc.singleArgs[op.Prop]; ok {
		return &edit{offset(r.fset, arg.Pos()), offset(r.fset, arg.End()), text}, nil
	}

	// Otherwise synthesize the whole call. Without this, any property left
	// at its default (which is every property of a freshly dropped control,
	// since the toolbox emits no setters) would be permanently uneditable.
	method, ok := setterForProp(desc, op.Prop)
	if !ok {
		return nil, fmt.Errorf("control type %q has no setter for property %q", pc.spec.Type, op.Prop)
	}
	insertAt, indent := afterConstructionLine(r, pc)
	stmt := fmt.Sprintf("%s%s.%s.%s(%s)\n", indent, r.model.RecvVar, op.ID, method, text)
	return &edit{insertAt, insertAt, stmt}, nil
}

// formatPropValue renders a property value as the Go expression its setter
// expects, per the prop's declared kind.
func formatPropValue(desc *ControlDesc, prop, value string) (string, error) {
	switch kindOf(desc, prop) {
	case KindBool:
		if value != "true" && value != "false" {
			return "", fmt.Errorf("property %q is a bool, got %q", prop, value)
		}
		return value, nil
	case KindNumber:
		f, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return "", fmt.Errorf("property %q is a number, got %q", prop, value)
		}
		return fnum(f), nil
	case KindEnum:
		allowed := enumsFor(desc, prop)
		for _, a := range allowed {
			if a == value {
				return "goforms." + value, nil
			}
		}
		return "", fmt.Errorf("property %q must be one of %v, got %q", prop, allowed, value)
	case KindFlags:
		allowed := enumsFor(desc, prop)
		if strings.TrimSpace(value) == "" {
			// An empty flag set still has to name a constant.
			return "goforms." + flagsZeroValue(allowed), nil
		}
		var parts []string
		for _, name := range strings.Split(value, ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			ok := false
			for _, a := range allowed {
				if a == name {
					ok = true
					break
				}
			}
			if !ok {
				return "", fmt.Errorf("property %q must be a combination of %v, got %q", prop, allowed, name)
			}
			parts = append(parts, "goforms."+name)
		}
		return strings.Join(parts, " | "), nil
	default:
		// A bare true/false stays an identifier even when the prop wasn't
		// declared in Kinds, matching how parse.go reads it back.
		if value == "true" || value == "false" {
			return value, nil
		}
		return quote(value), nil
	}
}

func planSetEvent(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	desc := catalog[pc.spec.Type]
	// Validate against the control's own events *and* the ones every
	// control inherits from ControlBase.
	if _, ok := eventArgType(desc, op.Event); !ok {
		return nil, fmt.Errorf("control type %q has no %q event", pc.spec.Type, op.Event)
	}
	if existing, ok := pc.spec.Events[op.Event]; ok && existing == op.Handler {
		return nil, nil // already wired to this exact handler, nothing to do
	}

	// Re-wiring an event rewrites the Handle line already there. Appending a
	// second one would not replace the old wiring: Event.Handle is multicast
	// (GoForms/events.go), so both handlers would run, and each further
	// re-wire would stack another line on the pile.
	if rng, ok := pc.eventStmts[op.Event]; ok {
		start, end := wholeLines(r.src, offset(r.fset, rng.Start), offset(r.fset, rng.End))
		indent := lineIndent(r.src, start)
		stmt := fmt.Sprintf("%s%s.%s.%s.Handle(%s.%s)\n", indent, r.model.RecvVar, op.ID, op.Event, r.model.RecvVar, op.Handler)
		return &edit{start, end, stmt}, nil
	}

	insertAt, indent := afterConstructionLine(r, pc)
	stmt := fmt.Sprintf("%s%s.%s.%s.Handle(%s.%s)\n", indent, r.model.RecvVar, op.ID, op.Event, r.model.RecvVar, op.Handler)
	return &edit{insertAt, insertAt, stmt}, nil
}

// lineIndent returns the leading whitespace of the line starting at off.
func lineIndent(src []byte, off int) string {
	end := off
	for end < len(src) && (src[end] == ' ' || src[end] == '\t') {
		end++
	}
	return string(src[off:end])
}

// planAdd emits two edits: the new struct field (just before the struct's
// closing brace) and the new control block (just before initializeComponent's
// closing brace).
func planAdd(r *parseResult, op Op) ([]edit, error) {
	if _, exists := r.controls[op.ID]; exists {
		return nil, fmt.Errorf("control %q already exists", op.ID)
	}
	if _, ok := catalog[op.Type]; !ok {
		return nil, fmt.Errorf("unknown control type %q", op.Type)
	}
	if err := checkParent(r, op.ID, op.Parent, op.ParentSlot); err != nil {
		return nil, err
	}

	spec := &ControlSpec{
		ID: op.ID, Type: op.Type, Parent: op.Parent, ParentSlot: op.ParentSlot,
		X: op.X, Y: op.Y, W: op.W, H: op.H, Text: op.Text,
		Collection: op.Collection,
		Props:      map[string]string{}, Events: map[string]string{},
	}
	// A tab control with no tabs (or a tree with no nodes) renders as an
	// empty box, which reads as a broken drop rather than a new control - so
	// seed the types that declare a default item list.
	if len(spec.Collection) == 0 {
		if cd := collectionFor(op.Type); cd != nil {
			spec.Collection = cd.Default
		}
	}

	block, err := controlBlock(r.model.RecvVar, spec, parentTypeOf(r, op.Parent), "\t")
	if err != nil {
		return nil, err
	}
	initInsertAt := r.model.InitRange.End
	fieldInsertAt := r.model.StructRange.End
	field := fieldDecl(spec, "\t")

	return []edit{
		{initInsertAt, initInsertAt, block},
		{fieldInsertAt, fieldInsertAt, field},
	}, nil
}

// checkParent validates a requested parent/slot pairing. A container that
// exposes slots (SplitContainer) has no AddControl of its own, so a child
// must name one; a plain container (Panel) has no slots to name.
func checkParent(r *parseResult, childID, parent, slot string) error {
	if parent == "" {
		if slot != "" {
			return fmt.Errorf("a control parented to the Form cannot be in a slot (%q)", slot)
		}
		return nil
	}
	if parent == childID {
		return fmt.Errorf("a control cannot be its own parent")
	}
	pc, ok := r.controls[parent]
	if !ok {
		return fmt.Errorf("no such control %q to parent onto", parent)
	}
	desc := catalog[pc.spec.Type]
	if desc == nil || !acceptsChildren(pc.spec.Type) {
		return fmt.Errorf("%q is a %s, which does not take child controls", parent, pc.spec.Type)
	}
	if takesChildrenThroughSlots(pc.spec.Type) {
		slots := slotsOf(pc.spec)
		if len(slots) == 0 {
			// A tab control with no tabs yet: there is genuinely nowhere to
			// put the control, and saying so beats a confusing "no such slot".
			return fmt.Errorf("%s %q has no %s yet - add one first",
				pc.spec.Type, parent, strings.ToLower(desc.Collection.Label))
		}
		if slot == "" {
			return fmt.Errorf("%s %q takes children through one of %v, not directly", pc.spec.Type, parent, slots)
		}
		for _, s := range slots {
			if s == slot {
				return nil
			}
		}
		return fmt.Errorf("%s %q has no %q; expected one of %v", pc.spec.Type, parent, slot, slots)
	}
	if slot != "" {
		return fmt.Errorf("%s %q has no slots, so %q is not a place to put a control", pc.spec.Type, parent, slot)
	}
	return nil
}

// planSetParent moves an existing control into another container - or out to
// the Form - by rewriting just its AddControl line. Doing it this way rather
// than remove-then-add keeps every property, event wiring and item list the
// control already has.
//
// It deliberately does not touch the control's bounds: they are relative to
// whatever now contains it, so the caller decides where it lands and sends a
// setBounds alongside.
func planSetParent(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	if err := checkParent(r, op.ID, op.Parent, op.ParentSlot); err != nil {
		return nil, err
	}
	// Moving a container into its own descendant would detach that whole
	// subtree from the form, and nothing downstream would notice.
	for ancestor := op.Parent; ancestor != ""; {
		if ancestor == op.ID {
			return nil, fmt.Errorf("cannot move %q into its own child %q", op.ID, op.Parent)
		}
		next, ok := r.controls[ancestor]
		if !ok {
			break
		}
		ancestor = next.spec.Parent
	}
	if pc.spec.Parent == op.Parent && pc.spec.ParentSlot == op.ParentSlot {
		return nil, nil // already there
	}
	if pc.addCtlRange.Start == token.NoPos {
		return nil, fmt.Errorf("could not locate the AddControl call for %q", op.ID)
	}

	start := offset(r.fset, pc.addCtlRange.Start)
	end := offset(r.fset, pc.addCtlRange.End)
	line := addControlLine(r.model.RecvVar, op.ID, op.Parent, parentTypeOf(r, op.Parent), op.ParentSlot, "")
	// The recorded range is the statement, not the whole line, so replace it
	// without its trailing newline.
	return &edit{start, end, strings.TrimSuffix(line, "\n")}, nil
}

// planRemove deletes both the control's struct field line and its whole
// initializeComponent statement block, each extended to full lines
// (leading indentation through trailing newline) so no blank/whitespace-only
// line is left behind.
func planRemove(r *parseResult, op Op) ([]edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	start, end := wholeLines(r.src, offset(r.fset, pc.blockStart), offset(r.fset, pc.blockEnd))
	edits := []edit{{start, end, ""}}
	// Item-adding calls a hand-written file put *after* AddControl fall
	// outside the block; leaving them would orphan `mf.<gone>.AddButton(...)`
	// lines referencing a field that no longer exists.
	for _, st := range pc.collectionStmts {
		s, e := offset(r.fset, st.Start), offset(r.fset, st.End)
		if s >= start && e <= end {
			continue
		}
		edits = addLineDelete(edits, r.src, s, e)
	}
	if pc.fieldRange.Start != 0 {
		// fieldRange is already line-aligned (see parse.go step 3b), so it is
		// spliced directly. Running it through wholeLines again would read
		// its End - the first byte of the *next* line - as a mid-line offset
		// and swallow that line as well, taking the struct's closing brace
		// with it.
		edits = append(edits, edit{offset(r.fset, pc.fieldRange.Start), offset(r.fset, pc.fieldRange.End), ""})
	}
	return edits, nil
}

// wholeLines extends [start, end) backward to the start of its line and
// forward through the trailing newline, so deleting it removes complete
// lines rather than leaving stray indentation or a blank line behind.
func wholeLines(src []byte, start, end int) (int, int) {
	for start > 0 && src[start-1] != '\n' {
		start--
	}
	for end < len(src) && src[end] != '\n' {
		end++
	}
	if end < len(src) {
		end++
	}
	return start, end
}

// addLineDelete appends a whole-line deletion, unless those lines are already
// covered by a planned edit. Two add calls sharing one source line
// (`ts.AddButton("A", nil); ts.AddSeparator()`) would otherwise yield two
// identical ranges, which spliceEdits rejects as overlapping - and the first
// edit already accounts for the whole line.
func addLineDelete(edits []edit, src []byte, start, end int) []edit {
	ls, le := wholeLines(src, start, end)
	for _, ex := range edits {
		if ls < ex.end && ex.start < le {
			return edits
		}
	}
	return append(edits, edit{ls, le, ""})
}

// leadingIndent returns the whitespace from the start of the line containing
// offset off up to off itself.
func leadingIndent(src []byte, off int) string {
	start := off
	for start > 0 && src[start-1] != '\n' {
		start--
	}
	i := start
	for i < off && (src[i] == ' ' || src[i] == '\t') {
		i++
	}
	return string(src[start:i])
}

// beforeAddControlLine returns the insertion offset and indent for a
// statement that must land at the end of a control's block but still inside
// it - i.e. on the line just above its AddControl call, so remove still takes
// it with the rest of the block.
func beforeAddControlLine(r *parseResult, pc *pcontrol) (int, string) {
	end := offset(r.fset, pc.blockEnd)
	insertAt := end
	for insertAt > 0 && r.src[insertAt-1] != '\n' {
		insertAt--
	}
	return insertAt, leadingIndent(r.src, end)
}

// afterConstructionLine returns the insertion offset and indent for a new
// statement right after a control's `New...` construction line.
func afterConstructionLine(r *parseResult, pc *pcontrol) (int, string) {
	insertAt := offset(r.fset, pc.blockStart)
	indent := leadingIndent(r.src, insertAt)
	for insertAt < len(r.src) && r.src[insertAt] != '\n' {
		insertAt++
	}
	if insertAt < len(r.src) {
		insertAt++
	}
	return insertAt, indent
}
