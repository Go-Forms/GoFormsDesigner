package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
)

// pcontrol is the internal, parse-time counterpart of ControlSpec: it keeps
// the AST/position details apply.go needs to splice text, which have no
// business being serialized to the extension.
type pcontrol struct {
	spec       *ControlSpec
	blockStart token.Pos
	blockEnd   token.Pos // set once AddControl is seen; zero until finalized
	// lastEnd is the end of the last statement attributed to this control.
	// A tray component has no AddControl to end its block, so this is what
	// closes it - which also means every statement that touches one must
	// extend it, or removing the component would leave half its setup behind.
	lastEnd token.Pos
	// fieldStmts spans each `<recv>.<field>.<Name> = <value>` assignment by
	// prop name, so setProp rewrites the statement instead of appending a
	// second assignment to the same field.
	fieldStmts map[string]ByteRangeTok
	// callStmts spans each no-argument call standing for a bool prop (a
	// Timer's Start()), so turning the prop off deletes the line.
	callStmts map[string]ByteRangeTok
	// boundsArgs are the 4 numeric literal arg nodes of the SetBounds call,
	// in x,y,w,h order, so apply.go can replace just their text.
	boundsArgs []ast.Expr
	textArg    ast.Expr // arg node of SetText(...), or the ctor's text arg if no setter call exists yet
	// itemsRange spans the comma-joined string list backing ComboBox/ListBox
	// items - either the ctor's variadic args or a later SetItems([]string{...})
	// call's element list, whichever was seen last (same replacement text
	// shape either way: `"a", "b", "c"`).
	itemsRange *ByteRangeTok
	// singleArgs holds the arg node for other single-value setters
	// (SetPlaceholder, SetChecked, LoadFile, SetSizeMode, SetValue) keyed by
	// the JSON prop name, for setProp to replace in place.
	singleArgs map[string]ast.Expr
	// fieldRange is this control's whole struct field declaration line
	// (including trailing newline), for remove to delete cleanly.
	fieldRange ByteRangeTok
	// addCtlRange spans the AddControl statement itself, which is the one
	// line "setParent" rewrites to move a control into another container.
	addCtlRange ByteRangeTok
	// eventStmts spans the `<recv>.<field>.<Event>.Handle(...)` statement
	// already wiring each event, so re-wiring an event rewrites that line
	// instead of stacking a second Handle call on top of it - Event.Handle
	// is multicast (GoForms/events.go), so an appended duplicate would make
	// the handler run twice rather than replace the old wiring.
	eventStmts map[string]ByteRangeTok
	// collectionStmts spans each item-adding call statement (AddButton,
	// AddTab, AddNode, ...) in file order, so setCollection can rewrite the
	// first and delete the rest, leaving any unrelated statement that happens
	// to sit between them alone.
	collectionStmts []ByteRangeTok
	// nodeVars maps a local variable bound to an AddNode result to that
	// node's depth, so `mf.tv.AddNode(node1, "Child")` knows how deep it is.
	nodeVars map[string]int
}

// ByteRangeTok mirrors ByteRange but in token.Pos terms, before conversion
// to file-relative byte offsets.
type ByteRangeTok struct {
	Start, End token.Pos
}

type pgroup struct {
	spec       *RadioGroupSpec
	blockStart token.Pos
}

// parseResult bundles the public FormModel with the position details apply.go
// needs. Every CLI command re-parses the file fresh rather than trying to
// keep state across invocations - simpler and always reflects what's really
// on disk.
type parseResult struct {
	fset  *token.FileSet
	file  *ast.File
	src   []byte
	model *FormModel

	controls map[string]*pcontrol // by ID, includes unfinished ones
	groups   map[string]*pgroup
	order    []string // control IDs in AddControl-encounter order

	// structType is the receiver struct's type node and initBody the body of
	// initializeComponent - the two regions tidy.go rewrites wholesale.
	structType *ast.StructType
	initBody   *ast.BlockStmt

	// formSizeArgs are the (title, width, height) arg nodes of the
	// goforms.NewForm(...) call found in the New<ReceiverType> constructor,
	// for the "setForm" apply op to splice in place.
	formSizeArgs []ast.Expr
	// clientSizeArgs are the (width, height) arg nodes of a
	// `<recv>.SetClientSize(w, h)` call inside initializeComponent, if
	// present - the scaffolded form templates call this in addition to
	// goforms.NewForm's own w/h, and it runs *after* NewForm at runtime, so
	// it would silently override a form resize that only touched NewForm's
	// args. "setForm" must keep both in sync when both exist.
	clientSizeArgs []ast.Expr
}

func selChain(e ast.Expr) ([]string, bool) {
	var parts []string
	for {
		switch v := e.(type) {
		case *ast.SelectorExpr:
			parts = append([]string{v.Sel.Name}, parts...)
			e = v.X
		case *ast.Ident:
			parts = append([]string{v.Name}, parts...)
			return parts, true
		default:
			return nil, false
		}
	}
}

func litString(e ast.Expr) (string, bool) {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(bl.Value)
	if err != nil {
		return "", false
	}
	return s, true
}

func litFloat(e ast.Expr) (float64, bool) {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.INT && bl.Kind != token.FLOAT {
		return 0, false
	}
	f, err := strconv.ParseFloat(bl.Value, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func offset(fset *token.FileSet, p token.Pos) int {
	return fset.Position(p).Offset
}

func byteRange(fset *token.FileSet, start, end token.Pos) ByteRange {
	return ByteRange{Start: offset(fset, start), End: offset(fset, end)}
}

func parseFile(path string) (*parseResult, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	res := &parseResult{
		fset:     fset,
		file:     f,
		src:      src,
		controls: map[string]*pcontrol{},
		groups:   map[string]*pgroup{},
		// Controls/RadioGroups start as non-nil empty slices, not nil: Go's
		// encoding/json marshals a nil slice as JSON `null`, and the webview
		// does `model.controls.filter(...)` etc. without a null-check, which
		// throws (silently, in a webview) for any form with zero controls -
		// most visibly a freshly created new form via `GoForms: New Form...`.
		model: &FormModel{
			Package:     f.Name.Name,
			Controls:    []*ControlSpec{},
			RadioGroups: []*RadioGroupSpec{},
		},
	}

	// 1. Find the receiver struct type: `type X struct { *goforms.Form; ... }`.
	var receiverType string
	var structRange ByteRange
	var structType *ast.StructType
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		for _, spec := range gd.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				continue
			}
			for _, field := range st.Fields.List {
				if len(field.Names) != 0 {
					continue
				}
				se, ok := field.Type.(*ast.StarExpr)
				if !ok {
					continue
				}
				if parts, ok := selChain(se.X); ok && len(parts) == 2 && parts[0] == "goforms" && parts[1] == "Form" {
					receiverType = ts.Name.Name
					structRange = byteRange(fset, st.Fields.Opening+1, st.Fields.Closing)
					structType = st
					res.structType = st
				}
			}
		}
	}
	if receiverType == "" {
		return nil, fmt.Errorf("no struct embedding *goforms.Form found in %s", path)
	}
	res.model.ReceiverType = receiverType
	res.model.StructRange = structRange

	// 1b. Find `func New<ReceiverType>(...) *ReceiverType { ... goforms.NewForm(title, w, h) ... }`
	// to recover the Form's title/size, wherever in that constructor it is
	// (typically inside a `&ReceiverType{Form: goforms.NewForm(...)}` composite literal).
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Name.Name != "New"+receiverType || fd.Recv != nil || fd.Body == nil {
			continue
		}
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			parts, ok := selChain(call.Fun)
			if !ok || len(parts) != 2 || parts[0] != "goforms" || parts[1] != "NewForm" || len(call.Args) != 3 {
				return true
			}
			if title, ok := litString(call.Args[0]); ok {
				res.model.FormTitle = title
			}
			if w, ok := litFloat(call.Args[1]); ok {
				res.model.FormWidth = w
			}
			if h, ok := litFloat(call.Args[2]); ok {
				res.model.FormHeight = h
			}
			res.formSizeArgs = call.Args
			return false
		})
	}

	// 2. Find `func (recv *ReceiverType) initializeComponent() { ... }`.
	var initBody *ast.BlockStmt
	var recvVar string
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Name.Name != "initializeComponent" || fd.Recv == nil || len(fd.Recv.List) != 1 {
			continue
		}
		se, ok := fd.Recv.List[0].Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		if id, ok := se.X.(*ast.Ident); ok && id.Name == receiverType {
			if len(fd.Recv.List[0].Names) == 1 {
				recvVar = fd.Recv.List[0].Names[0].Name
			}
			initBody = fd.Body
			res.initBody = fd.Body
		}
	}
	if initBody == nil {
		return nil, fmt.Errorf("no initializeComponent method on %s found in %s", receiverType, path)
	}
	res.model.RecvVar = recvVar
	res.model.InitRange = byteRange(fset, initBody.Lbrace+1, initBody.Rbrace)

	// 3. Walk the function body statement-by-statement.
	for _, stmt := range initBody.List {
		res.visitStmt(stmt, recvVar)
	}

	// 3b. Locate each control's struct field line, extended to cover the
	// whole line (leading indentation through trailing newline), so remove
	// can delete it cleanly without leaving a blank or half-indented line.
	tfile := fset.File(structType.Pos())
	for _, field := range structType.Fields.List {
		if len(field.Names) != 1 {
			continue
		}
		pc, ok := res.controls[field.Names[0].Name]
		if !ok {
			continue
		}
		startOff := offset(fset, field.Pos())
		for startOff > 0 && src[startOff-1] != '\n' {
			startOff--
		}
		endOff := offset(fset, field.End())
		for endOff < len(src) && src[endOff] != '\n' {
			endOff++
		}
		if endOff < len(src) {
			endOff++ // include the newline itself
		}
		pc.fieldRange = ByteRangeTok{Start: tfile.Pos(startOff), End: tfile.Pos(min(endOff, tfile.Size()))}
	}

	// 4. Assemble the ordered, finalized control list.
	for _, id := range res.order {
		pc := res.controls[id]
		end := pc.blockEnd
		if isNonVisual(pc.spec.Type) {
			// A tray component has no AddControl to end its block, so the
			// last statement that mentioned it does.
			end = pc.lastEnd
		}
		if end == token.NoPos {
			continue // never AddControl'd - treat as not part of the form
		}
		pc.spec.Range = byteRange(fset, pc.blockStart, end)
		res.model.Controls = append(res.model.Controls, pc.spec)
	}
	for _, g := range res.groups {
		res.model.RadioGroups = append(res.model.RadioGroups, g.spec)
	}

	res.model.Note = "Only the control types listed in the designer palette are recognized here; " +
		"anything else in initializeComponent (MenuStrip, ContextMenu, ToolTip, Load/Closing wiring, ...) " +
		"is left completely untouched by apply."

	return res, nil
}

func (r *parseResult) visitStmt(stmt ast.Stmt, recvVar string) {
	// Collection calls are checked first: `node := mf.tv.AddNode(...)` is an
	// assignment that visitAssign would otherwise reject and drop.
	if r.visitCollectionStmt(stmt, recvVar) {
		return
	}
	switch s := stmt.(type) {
	case *ast.AssignStmt:
		r.visitAssign(s, recvVar)
	case *ast.ExprStmt:
		r.visitExprStmt(s, recvVar)
	}
}

// visitCollectionStmt recognizes one item-adding call on a control that owns
// an editable collection - `mf.ts.AddButton("New", mf.onNew)`,
// `mf.ts.AddSeparator()`, `mf.tv.AddNode(nil, "Root")`, or the
// `node1 := mf.tv.AddNode(...)` form that names a node so children can hang
// off it. It reports whether the statement was consumed.
//
// Anything it recognizes as a collection call but can't fully read back (a
// non-literal title, a node parented to an unknown variable) marks the
// control's collection read-only rather than dropping the item silently: a
// rewrite would delete source the designer never understood.
func (r *parseResult) visitCollectionStmt(stmt ast.Stmt, recvVar string) bool {
	var call *ast.CallExpr
	var bindVar string
	switch s := stmt.(type) {
	case *ast.ExprStmt:
		call, _ = s.X.(*ast.CallExpr)
	case *ast.AssignStmt:
		if s.Tok != token.DEFINE || len(s.Lhs) != 1 || len(s.Rhs) != 1 {
			return false
		}
		id, ok := s.Lhs[0].(*ast.Ident)
		if !ok {
			return false
		}
		call, _ = s.Rhs[0].(*ast.CallExpr)
		bindVar = id.Name
	default:
		return false
	}
	if call == nil {
		return false
	}
	parts, ok := selChain(call.Fun)
	if !ok || len(parts) != 3 || parts[0] != recvVar {
		return false
	}
	pc, ok := r.controls[parts[1]]
	if !ok {
		return false
	}
	cd := collectionFor(pc.spec.Type)
	if cd == nil {
		return false
	}
	method := parts[2]
	isSeparator := cd.Separator && method == "AddSeparator"
	if !isSeparator && method != cd.Method {
		return false
	}

	pc.collectionStmts = append(pc.collectionStmts, ByteRangeTok{Start: stmt.Pos(), End: stmt.End()})

	if isSeparator {
		pc.spec.Collection = append(pc.spec.Collection, CollectionItem{Kind: "separator"})
		return true
	}

	item, ok := r.readCollectionItem(pc, cd, call, recvVar)
	if !ok {
		pc.spec.CollectionReadOnly = true
		return true
	}
	if bindVar != "" {
		if pc.nodeVars == nil {
			pc.nodeVars = map[string]int{}
		}
		pc.nodeVars[bindVar] = item.Depth
	}
	pc.spec.Collection = append(pc.spec.Collection, item)
	return true
}

// readCollectionItem pulls one item out of its add call, per the shape the
// type's CollectionDesc declares.
func (r *parseResult) readCollectionItem(pc *pcontrol, cd *CollectionDesc, call *ast.CallExpr, recvVar string) (CollectionItem, bool) {
	var item CollectionItem
	if cd.Tree {
		// AddNode(parent, text): the parent is either nil (a root) or a
		// variable bound to an earlier node.
		if len(call.Args) != 2 {
			return item, false
		}
		switch p := call.Args[0].(type) {
		case *ast.Ident:
			if p.Name == "nil" {
				item.Depth = 0
			} else if d, ok := pc.nodeVars[p.Name]; ok {
				item.Depth = d + 1
			} else {
				return item, false
			}
		default:
			return item, false
		}
		text, ok := litString(call.Args[1])
		if !ok {
			return item, false
		}
		item.Text = text
		return item, true
	}

	if len(call.Args) < 1 {
		return item, false
	}
	text, ok := litString(call.Args[0])
	if !ok {
		return item, false
	}
	item.Text = text

	if cd.Handler && len(call.Args) >= 2 {
		switch h := call.Args[1].(type) {
		case *ast.Ident:
			if h.Name != "nil" {
				return item, false // a bare func literal or local - can't round-trip
			}
		default:
			hp, ok := selChain(call.Args[1])
			if !ok || len(hp) != 2 || hp[0] != recvVar {
				return item, false
			}
			item.Handler = hp[1]
		}
	}
	return item, true
}

func (r *parseResult) visitAssign(s *ast.AssignStmt, recvVar string) {
	if s.Tok != token.ASSIGN || len(s.Lhs) != 1 || len(s.Rhs) != 1 {
		return
	}
	lhsParts, ok := selChain(s.Lhs[0])
	if !ok || len(lhsParts) < 2 || lhsParts[0] != recvVar {
		return
	}
	// `mf.dlgOpen.Title = "Open a file"` - a property written as an
	// assignment rather than a setter call. Only the components that have no
	// setters use this shape, so it is checked before the construction case
	// and never competes with it.
	if len(lhsParts) == 3 {
		r.visitFieldAssign(s, lhsParts[1], lhsParts[2])
		return
	}
	if len(lhsParts) != 2 {
		return
	}
	fieldName := lhsParts[1]

	call, ok := s.Rhs[0].(*ast.CallExpr)
	if !ok {
		return
	}
	funParts, ok := selChain(call.Fun)
	if !ok || len(funParts) != 2 || funParts[0] != "goforms" {
		return
	}
	ctor := funParts[1]

	if ctor == "NewRadioButtonGroup" {
		r.groups[fieldName] = &pgroup{
			spec:       &RadioGroupSpec{ID: fieldName},
			blockStart: s.Pos(),
		}
		return
	}

	desc, ok := ctorToType[ctor]
	if !ok {
		return // unrecognized constructor (e.g. NewMenuItem, NewContextMenu) - not a canvas control
	}

	spec := &ControlSpec{
		ID:        fieldName,
		Type:      desc.Type,
		Supported: true,
		W:         desc.DefaultW,
		H:         desc.DefaultH,
		Props:     map[string]string{},
		Events:    map[string]string{},
	}
	pc := &pcontrol{
		spec:       spec,
		blockStart: s.Pos(),
		lastEnd:    s.End(),
		eventStmts: map[string]ByteRangeTok{},
		fieldStmts: map[string]ByteRangeTok{},
		callStmts:  map[string]ByteRangeTok{},
	}
	if desc.NonVisual {
		// Nothing later will finalize a tray component - there is no
		// AddControl - so it joins the ordered list at construction, where
		// it also gets its place in tray order.
		r.order = append(r.order, fieldName)
	}

	switch desc.Type {
	case "Label", "Button", "CheckBox", "RadioButton":
		if len(call.Args) >= 1 {
			if txt, ok := litString(call.Args[0]); ok {
				spec.Text = txt
				pc.textArg = call.Args[0]
			}
		}
	case "TextBox":
		switch ctor {
		case "NewMultilineTextBox":
			spec.Props["variant"] = "multiline"
		case "NewPasswordTextBox":
			spec.Props["variant"] = "password"
		default:
			spec.Props["variant"] = "single"
		}
	// All three take a variadic list of string literals, so the same
	// extraction works; only the meaning differs (options vs column titles).
	case "ComboBox", "ListBox", "DataGridView", "CheckedListBox", "DomainUpDown":
		for _, a := range call.Args {
			if txt, ok := litString(a); ok {
				spec.Items = append(spec.Items, txt)
			}
		}
		pc.itemsRange = &ByteRangeTok{Start: call.Lparen + 1, End: call.Rparen}
	case "GroupBox":
		if len(call.Args) >= 1 {
			if txt, ok := litString(call.Args[0]); ok {
				spec.Text = txt
				pc.textArg = call.Args[0]
			}
		}
		if len(call.Args) >= 3 {
			if w, ok := litFloat(call.Args[1]); ok {
				spec.W = w
			}
			if h, ok := litFloat(call.Args[2]); ok {
				spec.H = h
			}
		}
	case "MaskedTextBox":
		if len(call.Args) >= 1 {
			if mask, ok := litString(call.Args[0]); ok {
				spec.Props["mask"] = mask
			}
		}
	case "RichTextBox":
		if len(call.Args) >= 1 {
			if md, ok := litString(call.Args[0]); ok {
				spec.Text = md
				pc.textArg = call.Args[0]
			}
		}
	case "ScrollBar":
		if ctor == "NewVScrollBar" {
			spec.Props["orientation"] = "vertical"
		} else {
			spec.Props["orientation"] = "horizontal"
		}
		if len(call.Args) >= 2 {
			if v, ok := litFloat(call.Args[0]); ok {
				spec.Props["min"] = strconv.FormatFloat(v, 'g', -1, 64)
			}
			if v, ok := litFloat(call.Args[1]); ok {
				spec.Props["max"] = strconv.FormatFloat(v, 'g', -1, 64)
			}
		}
	case "TableLayoutPanel":
		if len(call.Args) >= 4 {
			if w, ok := litFloat(call.Args[0]); ok {
				spec.W = w
			}
			if h, ok := litFloat(call.Args[1]); ok {
				spec.H = h
			}
			if v, ok := litFloat(call.Args[2]); ok {
				spec.Props["columns"] = strconv.FormatFloat(v, 'g', -1, 64)
			}
			if v, ok := litFloat(call.Args[3]); ok {
				spec.Props["rows"] = strconv.FormatFloat(v, 'g', -1, 64)
			}
		}
	case "SplitContainer":
		if len(call.Args) >= 3 {
			if w, ok := litFloat(call.Args[0]); ok {
				spec.W = w
			}
			if h, ok := litFloat(call.Args[1]); ok {
				spec.H = h
			}
			if id, ok := call.Args[2].(*ast.Ident); ok && id.Name == "false" {
				spec.Props["orientation"] = "horizontal"
			} else {
				spec.Props["orientation"] = "vertical"
			}
		}
	case "Panel", "PictureBox", "TabControl", "ScrollBox", "StatusStrip", "FlowLayoutPanel", "ViewContainer":
		if len(call.Args) >= 2 {
			if w, ok := litFloat(call.Args[0]); ok {
				spec.W = w
			}
			if h, ok := litFloat(call.Args[1]); ok {
				spec.H = h
			}
		}
	case "TrackBar":
		if len(call.Args) >= 2 {
			if min, ok := litFloat(call.Args[0]); ok {
				spec.Props["min"] = strconv.FormatFloat(min, 'g', -1, 64)
			}
			if max, ok := litFloat(call.Args[1]); ok {
				spec.Props["max"] = strconv.FormatFloat(max, 'g', -1, 64)
			}
		}
	case "NumericUpDown":
		if len(call.Args) >= 3 {
			if min, ok := litFloat(call.Args[0]); ok {
				spec.Props["min"] = strconv.FormatFloat(min, 'g', -1, 64)
			}
			if max, ok := litFloat(call.Args[1]); ok {
				spec.Props["max"] = strconv.FormatFloat(max, 'g', -1, 64)
			}
			if v, ok := litFloat(call.Args[2]); ok {
				spec.Props["value"] = strconv.FormatFloat(v, 'g', -1, 64)
			}
		}
	case "LinkLabel":
		if len(call.Args) >= 1 {
			if txt, ok := litString(call.Args[0]); ok {
				spec.Text = txt
				pc.textArg = call.Args[0]
			}
		}
		if len(call.Args) >= 2 {
			if url, ok := litString(call.Args[1]); ok {
				spec.Props["url"] = url
			}
		}
	case "ListView":
		if len(call.Args) >= 1 {
			if cl, ok := call.Args[0].(*ast.CompositeLit); ok {
				for _, elt := range cl.Elts {
					if txt, ok := litString(elt); ok {
						spec.Items = append(spec.Items, txt)
					}
				}
				pc.itemsRange = &ByteRangeTok{Start: cl.Lbrace + 1, End: cl.Rbrace}
			}
		}
	case "Splitter":
		if ctor == "NewVerticalSplitter" {
			spec.Props["orientation"] = "vertical"
		} else {
			spec.Props["orientation"] = "horizontal"
		}
		if len(call.Args) >= 2 {
			if w, ok := litFloat(call.Args[0]); ok {
				spec.W = w
			}
			if h, ok := litFloat(call.Args[1]); ok {
				spec.H = h
			}
		}
	case "ColorPickerButton":
		if len(call.Args) >= 1 {
			if txt, ok := litString(call.Args[0]); ok {
				spec.Text = txt
				pc.textArg = call.Args[0]
			}
		}
	case "Timer":
		// The interval is a constructor argument, so setProp replaces it
		// there rather than appending an assignment to Timer.Interval - two
		// places holding the same value is how they come to disagree.
		if len(call.Args) >= 1 {
			if ms, ok := litFloat(call.Args[0]); ok {
				spec.Props["interval"] = strconv.FormatFloat(ms, 'g', -1, 64)
				pc.setSingleArg("interval", call.Args[0])
			}
		}
	}

	r.controls[fieldName] = pc
}

// visitFieldAssign reads `<recv>.<field>.<Name> = <value>` - how the tray
// components are configured, since a dialog's Title is an exported field and
// not a SetTitle call.
func (r *parseResult) visitFieldAssign(s *ast.AssignStmt, field, name string) {
	pc, known := r.controls[field]
	if !known {
		return
	}
	desc := catalog[pc.spec.Type]
	prop, ok := fieldProp(desc, name)
	if !ok {
		return
	}
	// The statement belongs to this component whether or not its value can
	// be read back, so the block covers it either way - otherwise removing
	// the component would leave the assignment behind, referring to a field
	// that no longer exists.
	pc.lastEnd = maxPos(pc.lastEnd, s.End())
	pc.fieldStmts[prop] = ByteRangeTok{Start: s.Pos(), End: s.End()}
	if v, ok := readPropValue(s.Rhs[0], kindOf(desc, prop)); ok {
		pc.spec.Props[prop] = v
		pc.setSingleArg(prop, s.Rhs[0])
	}
}

// blockEnd is where a control's generated block stops: its AddControl call,
// or - for a tray component, which has none - the last statement that
// mentioned it. Everything that splices a control out of the file has to go
// through this, or removing a Timer would delete nothing and leave the rest.
func (pc *pcontrol) end() token.Pos {
	if pc.blockEnd != token.NoPos {
		return pc.blockEnd
	}
	return pc.lastEnd
}

func maxPos(a, b token.Pos) token.Pos {
	if b > a {
		return b
	}
	return a
}

func (r *parseResult) visitExprStmt(s *ast.ExprStmt, recvVar string) {
	call, ok := s.X.(*ast.CallExpr)
	if !ok {
		return
	}

	// Adding into part of a container (a SplitContainer half, a tab page) -
	// a call in the middle of the chain, so selChain below can't see it.
	if sc, ok := slotTarget(call, recvVar); ok {
		if pp, known := r.controls[sc.parent]; known {
			if slot, valid := resolveSlot(pp.spec.Type, sc); valid {
				if pc := r.controlArg(call, recvVar); pc != nil {
					pc.spec.Parent = sc.parent
					pc.spec.ParentSlot = slot
					pc.addCtlRange = ByteRangeTok{Start: s.Pos(), End: s.End()}
					pc.blockEnd = s.End()
					r.order = append(r.order, pc.spec.ID)
				}
				return
			}
		}
	}

	parts, ok := selChain(call.Fun)
	if !ok || len(parts) < 2 || parts[0] != recvVar {
		return
	}

	switch {
	// mf.SetClientSize(w, h) - see clientSizeArgs' doc comment for why this
	// must be tracked and kept in sync with goforms.NewForm's own w/h.
	case len(parts) == 2 && parts[1] == "SetClientSize":
		if len(call.Args) == 2 {
			r.clientSizeArgs = call.Args
		}

	// mf.AddControl(mf.field)
	case len(parts) == 2 && parts[1] == "AddControl":
		if pc := r.controlArg(call, recvVar); pc != nil {
			pc.spec.Parent = ""
			pc.addCtlRange = ByteRangeTok{Start: s.Pos(), End: s.End()}
			pc.blockEnd = s.End()
			r.order = append(r.order, pc.spec.ID)
		}

	// mf.container.AddControl(mf.field)
	case len(parts) == 3 && parts[2] == "AddControl":
		if pc := r.controlArg(call, recvVar); pc != nil {
			pc.spec.Parent = parts[1]
			pc.addCtlRange = ByteRangeTok{Start: s.Pos(), End: s.End()}
			pc.blockEnd = s.End()
			r.order = append(r.order, pc.spec.ID)
		}

	// mf.group.Add(mf.field)
	case len(parts) == 3 && parts[2] == "Add":
		if g, ok := r.groups[parts[1]]; ok {
			if pc := r.controlArg(call, recvVar); pc != nil {
				g.spec.Members = append(g.spec.Members, pc.spec.ID)
				pc.spec.Group = parts[1]
			}
		}

	// mf.field.Event.Handle(mf.method)
	case len(parts) == 4 && parts[3] == "Handle":
		if pc, ok := r.controls[parts[1]]; ok && len(call.Args) == 1 {
			if argParts, ok := selChain(call.Args[0]); ok && len(argParts) == 2 && argParts[0] == recvVar {
				pc.spec.Events[parts[2]] = argParts[1]
				pc.eventStmts[parts[2]] = ByteRangeTok{Start: s.Pos(), End: s.End()}
				pc.lastEnd = maxPos(pc.lastEnd, s.End())
			}
		}

	// mf.field.AddRow(cell1, cell2, ...) - ListView grid data, accumulated
	// in encounter order. Read-only: there is no op that rewrites rows (see
	// ControlSpec.Rows).
	case len(parts) == 3 && parts[2] == "AddRow":
		if pc, ok := r.controls[parts[1]]; ok {
			row := make([]string, 0, len(call.Args))
			for _, a := range call.Args {
				if txt, ok := litString(a); ok {
					row = append(row, txt)
				}
			}
			pc.spec.Rows = append(pc.spec.Rows, row)
		}

	// mf.field.Start() - a no-argument call standing for a bool property.
	// Checked before the setter case because a Timer has no setters at all
	// and applySetter would just drop it, losing the statement from the
	// block along with it.
	case len(parts) == 3 && len(call.Args) == 0 && isCallProp(r, parts[1], parts[2]):
		if pc, ok := r.controls[parts[1]]; ok {
			prop, _ := setterProp(catalog[pc.spec.Type], parts[2])
			pc.spec.Props[prop] = "true"
			pc.callStmts[prop] = ByteRangeTok{Start: s.Pos(), End: s.End()}
			pc.lastEnd = maxPos(pc.lastEnd, s.End())
		}

	// mf.field.SetXxx(args...)
	case len(parts) == 3:
		if pc, ok := r.controls[parts[1]]; ok {
			r.applySetter(pc, parts[2], call.Args)
			pc.lastEnd = maxPos(pc.lastEnd, s.End())
		}
	}
}

// isCallProp reports whether a no-argument method on this control is one of
// the bool properties expressed as a call (a Timer's Start).
func isCallProp(r *parseResult, field, method string) bool {
	pc, ok := r.controls[field]
	if !ok {
		return false
	}
	desc := catalog[pc.spec.Type]
	if desc == nil {
		return false
	}
	for _, m := range desc.Calls {
		if m == method {
			return true
		}
	}
	return false
}

// slotCall is a recognized "add into part of a container" statement, before
// the part has been resolved to a ParentSlot name.
type slotCall struct {
	parent   string // the container's field name
	accessor string // the method reached through: "Panel1" or "TabPages"
	index    int    // element index for an indexed accessor, else -1
}

// slotTarget matches the two shapes that add a control into part of a
// container rather than into the container itself:
//
//	mf.splitMain.Panel1().AddControl(mf.btn)      a fixed half
//	mf.tabsMain.TabPages()[1].AddControl(mf.btn)  the second page
//
// Both put a call in the middle of the selector chain, which is why neither
// can go through selChain like every other recognized statement.
func slotTarget(call *ast.CallExpr, recvVar string) (slotCall, bool) {
	sel, isSel := call.Fun.(*ast.SelectorExpr)
	if !isSel || sel.Sel.Name != "AddControl" {
		return slotCall{}, false
	}

	target := sel.X
	index := -1
	if ix, isIndex := target.(*ast.IndexExpr); isIndex {
		n, ok := litFloat(ix.Index)
		if !ok || n < 0 || n != float64(int(n)) {
			return slotCall{}, false
		}
		index = int(n)
		target = ix.X
	}

	accessor, isCall := target.(*ast.CallExpr)
	if !isCall || len(accessor.Args) != 0 {
		return slotCall{}, false
	}
	parts, chained := selChain(accessor.Fun)
	if !chained || len(parts) != 3 || parts[0] != recvVar {
		return slotCall{}, false
	}
	return slotCall{parent: parts[1], accessor: parts[2], index: index}, true
}

// resolveSlot turns a recognized slot call into the ParentSlot name the model
// carries, checking it against the parent's catalog entry so an unrelated
// `mf.x.Something().AddControl(...)` isn't mistaken for one.
func resolveSlot(parentType string, sc slotCall) (string, bool) {
	if sc.index < 0 {
		return sc.accessor, hasSlot(parentType, sc.accessor)
	}
	desc, ok := catalog[parentType]
	if !ok || desc.Collection == nil || desc.Collection.ItemsAccessor != sc.accessor {
		return "", false
	}
	return pageSlotName(desc.Collection.ItemSlot, sc.index), true
}

// controlArg extracts the pcontrol referenced by a call's single
// `<recvVar>.<field>` argument, e.g. the argument to AddControl or Add.
func (r *parseResult) controlArg(call *ast.CallExpr, recvVar string) *pcontrol {
	if len(call.Args) != 1 {
		return nil
	}
	parts, ok := selChain(call.Args[0])
	if !ok || len(parts) != 2 || parts[0] != recvVar {
		return nil
	}
	return r.controls[parts[1]]
}

func (r *parseResult) applySetter(pc *pcontrol, method string, args []ast.Expr) {
	desc := catalog[pc.spec.Type]
	switch method {
	case "SetBounds":
		if len(args) == 4 {
			pc.boundsArgs = args
			if x, ok := litFloat(args[0]); ok {
				pc.spec.X = x
			}
			if y, ok := litFloat(args[1]); ok {
				pc.spec.Y = y
			}
			if w, ok := litFloat(args[2]); ok {
				pc.spec.W = w
			}
			if h, ok := litFloat(args[3]); ok {
				pc.spec.H = h
			}
		}
		return
	case "SetItems":
		if len(args) == 1 {
			if cl, ok := args[0].(*ast.CompositeLit); ok {
				pc.spec.Items = nil
				for _, elt := range cl.Elts {
					if txt, ok := litString(elt); ok {
						pc.spec.Items = append(pc.spec.Items, txt)
					}
				}
				pc.itemsRange = &ByteRangeTok{Start: cl.Lbrace + 1, End: cl.Rbrace}
			}
		}
		return
	case "LoadFile":
		if len(args) == 1 {
			if txt, ok := litString(args[0]); ok {
				pc.spec.Props["file"] = txt
			}
			pc.setSingleArg("file", args[0])
		}
		return
	case "SetSizeMode":
		if len(args) == 1 {
			if parts, ok := selChain(args[0]); ok {
				pc.spec.Props["sizeMode"] = parts[len(parts)-1]
			}
			pc.setSingleArg("sizeMode", args[0])
		}
		return
	case "SetRange":
		if len(args) == 2 {
			if min, ok := litFloat(args[0]); ok {
				pc.spec.Props["min"] = strconv.FormatFloat(min, 'g', -1, 64)
			}
			if max, ok := litFloat(args[1]); ok {
				pc.spec.Props["max"] = strconv.FormatFloat(max, 'g', -1, 64)
			}
		}
		return
	case "SetValue":
		if len(args) == 1 {
			if v, ok := litFloat(args[0]); ok {
				pc.spec.Props["value"] = strconv.FormatFloat(v, 'g', -1, 64)
			}
			pc.setSingleArg("value", args[0])
		}
		return
	}

	if prop, ok := setterProp(desc, method); ok && len(args) == 1 {
		pc.setSingleArg(prop, args[0])
		if v, ok := readPropValue(args[0], kindOf(desc, prop)); ok {
			pc.spec.Props[prop] = v
			if prop == "text" {
				pc.spec.Text = v
				pc.textArg = args[0]
			}
		}
	}
}

// readPropValue converts one setter argument node back to the plain string
// the JSON model carries, according to the prop's declared kind. Returning
// false leaves the prop unset, which is the right outcome for an argument
// the designer can't round-trip (a variable, an expression, a call) - the
// file keeps working, the property panel just shows nothing for it.
func readPropValue(arg ast.Expr, kind string) (string, bool) {
	switch kind {
	case KindBool:
		if b, ok := arg.(*ast.Ident); ok && (b.Name == "true" || b.Name == "false") {
			return b.Name, true
		}
	case KindNumber:
		if f, ok := litFloat(arg); ok {
			return strconv.FormatFloat(f, 'g', -1, 64), true
		}
	case KindEnum:
		// `goforms.ScrollBarsBoth` round-trips as the bare "ScrollBarsBoth";
		// the qualifier is re-added on the way out (see apply.go).
		if parts, ok := selChain(arg); ok && len(parts) > 0 {
			return parts[len(parts)-1], true
		}
	case KindFlags:
		// `goforms.AnchorTop | goforms.AnchorLeft` round-trips as the
		// comma-joined "AnchorTop,AnchorLeft".
		names := flagNames(arg)
		if len(names) == 0 {
			return "", false
		}
		return strings.Join(names, ","), true
	default:
		if txt, ok := litString(arg); ok {
			return txt, true
		}
		// A bool-valued setter that was never declared in Kinds still reads
		// back correctly rather than silently vanishing.
		if b, ok := arg.(*ast.Ident); ok && (b.Name == "true" || b.Name == "false") {
			return b.Name, true
		}
	}
	return "", false
}

func (pc *pcontrol) setSingleArg(prop string, arg ast.Expr) {
	if pc.singleArgs == nil {
		pc.singleArgs = map[string]ast.Expr{}
	}
	pc.singleArgs[prop] = arg
}

// flagNames flattens an OR-ed chain of qualified constants into their bare
// names, so `goforms.AnchorTop | goforms.AnchorLeft` reads back as
// ["AnchorTop", "AnchorLeft"]. Anything else in the expression yields no
// names at all, which leaves the prop unset rather than half-parsed.
func flagNames(e ast.Expr) []string {
	switch v := e.(type) {
	case *ast.BinaryExpr:
		if v.Op != token.OR {
			return nil
		}
		left := flagNames(v.X)
		right := flagNames(v.Y)
		if left == nil || right == nil {
			return nil
		}
		return append(left, right...)
	case *ast.ParenExpr:
		return flagNames(v.X)
	default:
		if parts, ok := selChain(e); ok && len(parts) > 0 {
			return []string{parts[len(parts)-1]}
		}
	}
	return nil
}

// stderrf is a small convenience for main.go's error path.
func stderrf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
}
