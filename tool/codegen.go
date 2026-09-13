package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// fnum formats a float the way gofmt would want it in source: no
// unnecessary decimals.
func fnum(f float64) string {
	return strconv.FormatFloat(f, 'g', -1, 64)
}

func quote(s string) string {
	return strconv.Quote(s)
}

// numOrDefault reads a numeric prop, falling back to def if absent/invalid -
// used so freshly-added Trackbar/NumericUpDown instances get sane min/max
// even though the toolbox doesn't prompt for them up front.
func numOrDefault(spec *ControlSpec, prop, def string) string {
	if v, ok := spec.Props[prop]; ok && v != "" {
		return v
	}
	return def
}

// ctorCall returns the `goforms.NewX(args...)` call expression text for a
// freshly added control, choosing among a type's constructor variants via
// spec.Props["variant"]/["orientation"] where relevant. recvVar is only
// needed by ColorPickerButton, whose constructor takes the owning Form.
func ctorCall(spec *ControlSpec, recvVar string) (string, error) {
	desc, ok := catalog[spec.Type]
	if !ok {
		return "", fmt.Errorf("unknown control type %q", spec.Type)
	}
	switch spec.Type {
	case "Label", "Button", "CheckBox", "RadioButton":
		return fmt.Sprintf("goforms.New%s(%s)", spec.Type, quote(spec.Text)), nil
	case "TextBox":
		switch spec.Props["variant"] {
		case "multiline":
			return "goforms.NewMultilineTextBox()", nil
		case "password":
			return "goforms.NewPasswordTextBox()", nil
		default:
			return "goforms.NewTextBox()", nil
		}
	case "ComboBox", "ListBox":
		args := make([]string, len(spec.Items))
		for i, it := range spec.Items {
			args[i] = quote(it)
		}
		return fmt.Sprintf("goforms.New%s(%s)", spec.Type, strings.Join(args, ", ")), nil
	case "GroupBox":
		return fmt.Sprintf("goforms.NewGroupBox(%s, %s, %s)", quote(spec.Text), fnum(spec.W), fnum(spec.H)), nil
	case "Panel":
		return fmt.Sprintf("goforms.NewPanel(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "PictureBox":
		return fmt.Sprintf("goforms.NewPictureBox(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "ProgressBar":
		return "goforms.NewProgressBar()", nil
	case "TrackBar":
		return fmt.Sprintf("goforms.NewTrackBar(%s, %s)", numOrDefault(spec, "min", "0"), numOrDefault(spec, "max", "100")), nil
	case "NumericUpDown":
		return fmt.Sprintf("goforms.NewNumericUpDown(%s, %s, %s)",
			numOrDefault(spec, "min", "0"), numOrDefault(spec, "max", "100"), numOrDefault(spec, "value", "0")), nil
	case "DateTimePicker":
		// Requires the file to already `import "time"` - a known v1
		// limitation (this tool never manages imports); see catalog.go.
		return "goforms.NewDateTimePicker(time.Now())", nil
	case "LinkLabel":
		if url, ok := spec.Props["url"]; ok && url != "" {
			return fmt.Sprintf("goforms.NewLinkLabelWithURL(%s, %s)", quote(spec.Text), quote(url)), nil
		}
		return fmt.Sprintf("goforms.NewLinkLabel(%s)", quote(spec.Text)), nil
	case "ListView":
		args := make([]string, len(spec.Items))
		for i, it := range spec.Items {
			args[i] = quote(it)
		}
		return fmt.Sprintf("goforms.NewListView([]string{%s})", strings.Join(args, ", ")), nil
	case "DataGridView":
		// A grid with no columns renders as an empty box, which reads as a
		// broken drop rather than a new control - so seed it.
		items := spec.Items
		if len(items) == 0 {
			items = []string{"Column 1", "Column 2", "Column 3"}
		}
		args := make([]string, len(items))
		for i, it := range items {
			args[i] = quote(it)
		}
		return fmt.Sprintf("goforms.NewDataGridView(%s)", strings.Join(args, ", ")), nil
	case "TreeView":
		return "goforms.NewTreeView()", nil
	case "TabControl":
		return fmt.Sprintf("goforms.NewTabControl(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "ToolStrip":
		return "goforms.NewToolStrip()", nil
	case "StatusStrip":
		return fmt.Sprintf("goforms.NewStatusStrip(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "Splitter":
		if spec.Props["orientation"] == "vertical" {
			return fmt.Sprintf("goforms.NewVerticalSplitter(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
		}
		return fmt.Sprintf("goforms.NewHorizontalSplitter(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "ScrollBox":
		return fmt.Sprintf("goforms.NewScrollBox(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "MaskedTextBox":
		return fmt.Sprintf("goforms.NewMaskedTextBox(%s)", quote(spec.Props["mask"])), nil
	case "RichTextBox":
		return fmt.Sprintf("goforms.NewRichTextBox(%s)", quote(spec.Text)), nil
	case "CheckedListBox", "DomainUpDown":
		args := make([]string, len(spec.Items))
		for i, it := range spec.Items {
			args[i] = quote(it)
		}
		return fmt.Sprintf("goforms.New%s(%s)", spec.Type, strings.Join(args, ", ")), nil
	case "MonthCalendar":
		// Requires the file to already import "time" - the same known v1
		// limitation DateTimePicker has (this tool never manages imports).
		return "goforms.NewMonthCalendar(time.Now())", nil
	case "ScrollBar":
		ctor := "NewHScrollBar"
		if spec.Props["orientation"] == "vertical" {
			ctor = "NewVScrollBar"
		}
		return fmt.Sprintf("goforms.%s(%s, %s)", ctor,
			numOrDefault(spec, "min", "0"), numOrDefault(spec, "max", "100")), nil
	case "ViewContainer":
		return fmt.Sprintf("goforms.NewViewContainer(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "FlowLayoutPanel":
		return fmt.Sprintf("goforms.NewFlowLayoutPanel(%s, %s)", fnum(spec.W), fnum(spec.H)), nil
	case "TableLayoutPanel":
		return fmt.Sprintf("goforms.NewTableLayoutPanel(%s, %s, %s, %s)",
			fnum(spec.W), fnum(spec.H),
			numOrDefault(spec, "columns", "2"), numOrDefault(spec, "rows", "2")), nil
	case "SplitContainer":
		vertical := "true"
		if spec.Props["orientation"] == "horizontal" {
			vertical = "false"
		}
		return fmt.Sprintf("goforms.NewSplitContainer(%s, %s, %s)", fnum(spec.W), fnum(spec.H), vertical), nil
	case "ColorPickerButton":
		return fmt.Sprintf("goforms.NewColorPickerButton(%s, %s.Form)", quote(spec.Text), recvVar), nil
	case "Timer":
		// One second, because a timer added from the toolbox and left alone
		// should be visibly a timer rather than a busy loop.
		return fmt.Sprintf("goforms.NewTimer(%s)", numOrDefault(spec, "interval", "1000")), nil
	case "OpenFileDialog", "SaveFileDialog", "FolderBrowserDialog", "ColorDialog":
		return fmt.Sprintf("goforms.New%s()", spec.Type), nil
	}
	_ = desc
	return "", fmt.Errorf("no constructor template for %q", spec.Type)
}

// controlBlock renders the full statement sequence for one control:
// construction, bounds, recognized property setters, event wiring, and the
// AddControl call - i.e. exactly the shape parse.go knows how to read back.
// indent is the leading whitespace (e.g. "\t") applied to every line.
// parentType is the control type of spec.Parent ("" when it hangs off the
// Form), needed to tell an accessor slot from a page slot.
func controlBlock(recvVar string, spec *ControlSpec, parentType, indent string) (string, error) {
	ctor, err := ctorCall(spec, recvVar)
	if err != nil {
		return "", err
	}
	desc := catalog[spec.Type]
	nonVisual := desc != nil && desc.NonVisual

	var b strings.Builder
	fmt.Fprintf(&b, "%s%s.%s = %s\n", indent, recvVar, spec.ID, ctor)
	if !nonVisual {
		fmt.Fprintf(&b, "%s%s.%s.SetBounds(%s, %s, %s, %s)\n", indent, recvVar, spec.ID, fnum(spec.X), fnum(spec.Y), fnum(spec.W), fnum(spec.H))
	}

	// Emit every prop that has a real setter, sorted for deterministic
	// output. "text" and "items" are skipped: both are already carried by
	// the constructor above, and emitting them again would either duplicate
	// the value or overwrite it with a stale one.
	props := make([]string, 0, len(spec.Props))
	for p := range spec.Props {
		if p == "text" || p == "items" {
			continue
		}
		if _, ok := setterForProp(desc, p); ok {
			props = append(props, p)
		}
	}
	sort.Strings(props)
	for _, p := range props {
		method, _ := setterForProp(desc, p)
		val, err := formatPropValue(desc, p, spec.Props[p])
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&b, "%s%s.%s.%s(%s)\n", indent, recvVar, spec.ID, method, val)
	}

	b.WriteString(fieldLines(recvVar, spec, desc, indent))

	// events, sorted for deterministic output
	names := make([]string, 0, len(spec.Events))
	for ev := range spec.Events {
		names = append(names, ev)
	}
	sort.Strings(names)
	for _, ev := range names {
		fmt.Fprintf(&b, "%s%s.%s.%s.Handle(%s.%s)\n", indent, recvVar, spec.ID, ev, recvVar, spec.Events[ev])
	}

	// The item list goes *before* AddControl so it lives inside the block
	// planRemove deletes - otherwise removing the control would leave orphan
	// `mf.<gone>.AddButton(...)` lines behind.
	b.WriteString(collectionLines(recvVar, spec, indent))

	if nonVisual {
		// No AddControl: a Timer is not on the form. The Start() call, if
		// any, goes last, so everything it depends on is already set - a
		// timer started before its Tick is wired would fire into nothing.
		b.WriteString(callLines(recvVar, spec, desc, indent))
		return b.String(), nil
	}

	b.WriteString(addControlLine(recvVar, spec.ID, spec.Parent, parentType, spec.ParentSlot, indent))
	return b.String(), nil
}

// fieldLines renders the `<recv>.<id>.<Field> = <value>` statements for the
// components configured by assignment. Only props with a real value are
// written: a dialog whose Title is empty is a dialog with the default
// caption, and saying so explicitly would just be noise in the file.
func fieldLines(recvVar string, spec *ControlSpec, desc *ControlDesc, indent string) string {
	if desc == nil || len(desc.Fields) == 0 {
		return ""
	}
	props := make([]string, 0, len(spec.Props))
	for p, v := range spec.Props {
		if v == "" {
			continue
		}
		if _, ok := fieldForProp(desc, p); ok {
			props = append(props, p)
		}
	}
	sort.Strings(props)

	var b strings.Builder
	for _, p := range props {
		field, _ := fieldForProp(desc, p)
		val, err := formatPropValue(desc, p, spec.Props[p])
		if err != nil {
			continue // an unparseable value is left out rather than written broken
		}
		fmt.Fprintf(&b, "%s%s.%s.%s = %s\n", indent, recvVar, spec.ID, field, val)
	}
	return b.String()
}

// callLines renders the no-argument methods a bool prop stands for - a
// Timer's Start(). False emits nothing, which is already what "not started"
// means, so there is no Stop() to write.
func callLines(recvVar string, spec *ControlSpec, desc *ControlDesc, indent string) string {
	if desc == nil || len(desc.Calls) == 0 {
		return ""
	}
	props := make([]string, 0, len(desc.Calls))
	for p := range desc.Calls {
		if spec.Props[p] == "true" {
			props = append(props, p)
		}
	}
	sort.Strings(props)

	var b strings.Builder
	for _, p := range props {
		fmt.Fprintf(&b, "%s%s.%s.%s()\n", indent, recvVar, spec.ID, desc.Calls[p])
	}
	return b.String()
}

// addControlLine renders the statement that parents a control, onto whichever
// of the four kinds of container holds it. parentType is the parent's control
// type ("" when the parent is the Form itself), which is what decides whether
// a slot is an accessor call or a page variable.
func addControlLine(recvVar, id, parent, parentType, slot, indent string) string {
	return fmt.Sprintf("%s%s.AddControl(%s.%s)\n", indent, containerExpr(recvVar, parent, parentType, slot), recvVar, id)
}

// containerExpr renders the Go expression that owns a control's children:
//
//	mf                          the Form
//	mf.pnlSide                  a container field
//	mf.splitMain.Panel1()       one half of a SplitContainer
//	mf.tabsMain.TabPages()[1]   the second page of a TabControl
func containerExpr(recvVar, parent, parentType, slot string) string {
	switch {
	case parent == "":
		return recvVar
	case slot == "":
		return recvVar + "." + parent
	case hasSlot(parentType, slot):
		return recvVar + "." + parent + "." + slot + "()"
	}
	if i := pageSlotIndex(parentType, slot); i >= 0 {
		return fmt.Sprintf("%s.%s.%s()[%d]", recvVar, parent, catalog[parentType].Collection.ItemsAccessor, i)
	}
	// checkParent refuses an unknown slot long before this, so reaching here
	// would be a bug; fall back to the plain container form rather than
	// emitting something syntactically broken.
	return recvVar + "." + parent
}

// collectionLines renders a control's item list as the exact statement
// sequence parse.go reads back: one add call per item, in order. It is the
// whole output of the "setCollection" op, and is also spliced into a freshly
// added control's block.
func collectionLines(recvVar string, spec *ControlSpec, indent string) string {
	cd := collectionFor(spec.Type)
	if cd == nil || len(spec.Collection) == 0 {
		return ""
	}
	var b strings.Builder
	if cd.Tree {
		writeTreeCollection(&b, recvVar, spec, cd, indent)
		return b.String()
	}
	// A page collection needs nothing special here: pages are addressed by
	// index at the point of use (see containerExpr), so adding one is the
	// same plain call as adding a StatusStrip panel.
	for _, item := range spec.Collection {
		if cd.Separator && item.Kind == "separator" {
			fmt.Fprintf(&b, "%s%s.%s.AddSeparator()\n", indent, recvVar, spec.ID)
			continue
		}
		if cd.Handler {
			// A button with no handler still needs an argument; fyne's
			// widget.Button treats a nil callback as "not clickable", which is
			// exactly what an unwired designer button should be.
			handler := "nil"
			if item.Handler != "" {
				handler = recvVar + "." + item.Handler
			}
			fmt.Fprintf(&b, "%s%s.%s.%s(%s, %s)\n", indent, recvVar, spec.ID, cd.Method, quote(item.Text), handler)
			continue
		}
		fmt.Fprintf(&b, "%s%s.%s.%s(%s)\n", indent, recvVar, spec.ID, cd.Method, quote(item.Text))
	}
	return b.String()
}

// writeTreeCollection emits a nesting collection (TreeView), where each add
// call takes the parent node returned by an earlier one.
func writeTreeCollection(b *strings.Builder, recvVar string, spec *ControlSpec, cd *CollectionDesc, indent string) {
	depths := normalizedDepths(spec.Collection)
	// parentVar[d] is the variable holding the most recent node at depth d,
	// which is what the next depth-d+1 item hangs off.
	parentVar := map[int]string{}
	for i, item := range spec.Collection {
		d := depths[i]
		parent := "nil"
		if d > 0 {
			parent = parentVar[d-1]
		}
		call := fmt.Sprintf("%s.%s.%s(%s, %s)", recvVar, spec.ID, cd.Method, parent, quote(item.Text))
		// Only name the node when a later item actually nests under it: an
		// unused variable doesn't compile in Go.
		if i+1 < len(depths) && depths[i+1] > d {
			v := fmt.Sprintf("%sNode%d", spec.ID, i+1)
			parentVar[d] = v
			fmt.Fprintf(b, "%s%s := %s\n", indent, v, call)
			continue
		}
		fmt.Fprintf(b, "%s%s\n", indent, call)
	}
}

// normalizedDepths clamps an item list's nesting to something that can
// actually be generated: the first item is always a root, and no item is
// deeper than one level below the item before it. Without this a list edited
// to start at depth 2 would emit a node parented to a variable that was never
// declared.
func normalizedDepths(items []CollectionItem) []int {
	out := make([]int, len(items))
	prev := -1
	for i, item := range items {
		d := item.Depth
		if d < 0 {
			d = 0
		}
		if d > prev+1 {
			d = prev + 1
		}
		out[i] = d
		prev = d
	}
	return out
}

// fieldDecl renders the struct field line for a control, e.g.
// "\tbtnGreet *goforms.Button\n".
func fieldDecl(spec *ControlSpec, indent string) string {
	return fmt.Sprintf("%s%s *goforms.%s\n", indent, spec.ID, spec.Type)
}
