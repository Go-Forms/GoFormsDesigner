package main

// table.go is the TableLayoutPanel's part of the model: which cell each
// child is in, and how each column and row is sized.
//
// The framework places a child in one of three ways (GoForms/layoutpanels.go):
//
//	mf.tbl.AddControl(mf.btn)                    the next cell, reading order
//	mf.tbl.AddControlAt(mf.btn, 1, 0)            column 1, row 0
//	mf.tbl.AddControlSpanning(mf.btn, 0, 1, 2, 1) column 0, row 1, two columns wide
//
// and sizes its tracks with indexed setters after the constructor:
//
//	mf.tbl = goforms.NewTableLayoutPanel(300, 200, 2, 2)
//	mf.tbl.SetColumnStyle(0, goforms.Absolute(80))
//	mf.tbl.SetRowStyle(1, goforms.Percent(100))
//
// The designer reads all of these back and writes them, so a table can be
// laid out by its cells instead of being a box whose children flow into
// whatever cell comes next.

import (
	"fmt"
	"go/ast"
	"strconv"
	"strings"
)

// Track size types, as the goforms constructor each one is written with.
const (
	TrackAbsolute = "Absolute"
	TrackPercent  = "Percent"
	TrackAutoSize = "AutoSize"
)

// addMethods are the calls that parent a control, by the number of
// arguments each takes. The child is always the first.
var addMethods = map[string]int{
	"AddControl":         1,
	"AddControlAt":       3,
	"AddControlSpanning": 5,
}

// addedChild returns the child expression of a call that parents a control
// in any of its shapes, and the method used.
func addedChild(call *ast.CallExpr) (ast.Expr, string, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return nil, "", false
	}
	n, known := addMethods[sel.Sel.Name]
	if !known || len(call.Args) != n {
		return nil, "", false
	}
	return call.Args[0], sel.Sel.Name, true
}

// readCell reads the cell arguments of an AddControlAt/AddControlSpanning
// call. A plain AddControl has none, and any argument that is not an integer
// literal makes the cell unreadable - the control is then treated as placed
// by the framework, which is what the designer can still draw.
func readCell(method string, args []ast.Expr) *CellSpec {
	if method == "AddControl" {
		return nil
	}
	ints := make([]int, 0, len(args)-1)
	for _, a := range args[1:] {
		n, ok := litInt(a)
		if !ok || n < 0 {
			return nil
		}
		ints = append(ints, n)
	}
	cell := &CellSpec{Column: ints[0], Row: ints[1]}
	if len(ints) == 4 {
		cell.ColumnSpan, cell.RowSpan = ints[2], ints[3]
	}
	return normalizeCell(cell)
}

// normalizeCell drops spans of one, which is what no span means, so a cell
// read back from AddControlSpanning(x, 0, 0, 1, 1) and one written as
// AddControlAt compare equal.
func normalizeCell(c *CellSpec) *CellSpec {
	if c == nil {
		return nil
	}
	out := *c
	if out.ColumnSpan <= 1 {
		out.ColumnSpan = 0
	}
	if out.RowSpan <= 1 {
		out.RowSpan = 0
	}
	return &out
}

// addCall renders the method and trailing arguments that parent a control
// into a cell: `AddControl(mf.btn)`, `AddControlAt(mf.btn, 1, 0)` or
// `AddControlSpanning(mf.btn, 0, 1, 2, 1)`.
func addCall(recvVar, id string, cell *CellSpec) string {
	child := recvVar + "." + id
	cell = normalizeCell(cell)
	switch {
	case cell == nil:
		return fmt.Sprintf("AddControl(%s)", child)
	case cell.ColumnSpan == 0 && cell.RowSpan == 0:
		return fmt.Sprintf("AddControlAt(%s, %d, %d)", child, cell.Column, cell.Row)
	default:
		return fmt.Sprintf("AddControlSpanning(%s, %d, %d, %d, %d)", child, cell.Column, cell.Row,
			max(1, cell.ColumnSpan), max(1, cell.RowSpan))
	}
}

// readTrack reads `goforms.Absolute(80)`, `goforms.Percent(50)` or
// `goforms.AutoSize()`.
func readTrack(e ast.Expr) (TrackSpec, bool) {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return TrackSpec{}, false
	}
	parts, ok := selChain(call.Fun)
	if !ok || len(parts) != 2 || parts[0] != "goforms" {
		return TrackSpec{}, false
	}
	switch parts[1] {
	case TrackAutoSize:
		if len(call.Args) == 0 {
			return TrackSpec{Type: TrackAutoSize}, true
		}
	case TrackAbsolute, TrackPercent:
		if len(call.Args) == 1 {
			if v, ok := litFloat(call.Args[0]); ok {
				return TrackSpec{Type: parts[1], Value: v}, true
			}
		}
	}
	return TrackSpec{}, false
}

// trackExpr renders a track style as the goforms call that builds it.
func trackExpr(t TrackSpec) string {
	switch t.Type {
	case TrackAbsolute, TrackPercent:
		return fmt.Sprintf("goforms.%s(%s)", t.Type, fnum(t.Value))
	default:
		return "goforms.AutoSize()"
	}
}

// validTrack checks a track sent by the designer before it is written.
func validTrack(t TrackSpec) error {
	switch t.Type {
	case TrackAutoSize:
		return nil
	case TrackAbsolute:
		if t.Value < 0 {
			return fmt.Errorf("an absolute track cannot be %s pixels", fnum(t.Value))
		}
		return nil
	case TrackPercent:
		if t.Value < 0 || t.Value > 100 {
			return fmt.Errorf("a percent track must be 0-100, got %s", fnum(t.Value))
		}
		return nil
	}
	return fmt.Errorf("unknown track type %q (want Absolute, Percent or AutoSize)", t.Type)
}

// tableTracks builds a table's column or row list: count tracks, AutoSize
// unless a style call said otherwise. A style for an index past the count is
// dropped, as the framework drops it.
func tableTracks(count int, styles map[int]TrackSpec) []TrackSpec {
	count = max(1, count)
	out := make([]TrackSpec, count)
	for i := range out {
		out[i] = TrackSpec{Type: TrackAutoSize}
		if s, ok := styles[i]; ok {
			out[i] = s
		}
	}
	return out
}

// tableCount reads the column or row count a table spec carries: its track
// list when it has one (a copy being pasted), else the constructor's number.
func tableCount(spec *ControlSpec, tracks []TrackSpec, prop string) string {
	if len(tracks) > 0 {
		return strconv.Itoa(len(tracks))
	}
	return numOrDefault(spec, prop, "2")
}

// tableLines renders a table's non-default track styles as the indexed
// setter calls parse reads back. An AutoSize track is what the constructor
// already made, so it is not written.
func tableLines(recvVar string, spec *ControlSpec, indent string) string {
	if spec.Type != "TableLayoutPanel" {
		return ""
	}
	var b strings.Builder
	for i, t := range spec.TableColumns {
		if t.Type != TrackAutoSize && t.Type != "" {
			fmt.Fprintf(&b, "%s%s.%s.SetColumnStyle(%d, %s)\n", indent, recvVar, spec.ID, i, trackExpr(t))
		}
	}
	for i, t := range spec.TableRows {
		if t.Type != TrackAutoSize && t.Type != "" {
			fmt.Fprintf(&b, "%s%s.%s.SetRowStyle(%d, %s)\n", indent, recvVar, spec.ID, i, trackExpr(t))
		}
	}
	return b.String()
}

// applyTrackSetter folds one SetColumnStyle/SetRowStyle call into the
// table's pending styles. They become TableColumns/TableRows once the whole
// file has been read, because the count comes from the constructor and a
// style may in principle precede nothing else.
func (r *parseResult) applyTrackSetter(pc *pcontrol, method string, args []ast.Expr) {
	if len(args) != 2 {
		return
	}
	idx, ok := litInt(args[0])
	if !ok || idx < 0 || idx > 512 {
		return
	}
	t, ok := readTrack(args[1])
	if !ok {
		// A style the designer cannot read back - a variable, a computed
		// size - is left to the file. Rewriting the table's styles would
		// delete it, so the table's layout is read-only from here on.
		pc.spec.TableReadOnly = true
		return
	}
	styles := pc.colStyles
	if method == "SetRowStyle" {
		styles = pc.rowStyles
	}
	styles[idx] = t
}

// isTrackSetter reports whether a method is one of TableLayoutPanel's
// indexed track styles.
func isTrackSetter(typ, method string) bool {
	return typ == "TableLayoutPanel" && (method == "SetColumnStyle" || method == "SetRowStyle")
}

// planSetCell moves a control to another cell of the table it is in, by
// rewriting the call that parents it. A nil Cell goes back to a plain
// AddControl - the framework's next free cell.
func planSetCell(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	if parentTypeOf(r, pc.spec.Parent) != "TableLayoutPanel" || pc.spec.ParentSlot != "" {
		return nil, fmt.Errorf("%q is not in a TableLayoutPanel, so it has no cell", op.ID)
	}
	if err := checkCell(r, pc.spec.Parent, op.Cell); err != nil {
		return nil, err
	}
	if pc.addCtlRange.Start == 0 {
		return nil, fmt.Errorf("could not locate the call that adds %q to its table", op.ID)
	}
	start := offset(r.fset, pc.addCtlRange.Start)
	end := offset(r.fset, pc.addCtlRange.End)
	line := addControlLine(r.model.RecvVar, op.ID, pc.spec.Parent, "TableLayoutPanel", "", op.Cell, "")
	return &edit{start, end, strings.TrimSuffix(line, "\n")}, nil
}

// checkCell refuses a cell outside the table. The framework would quietly
// leave such a control wherever it last was, which is a layout nobody asked
// for.
func checkCell(r *parseResult, table string, cell *CellSpec) error {
	if cell == nil {
		return nil
	}
	pc, ok := r.controls[table]
	if !ok {
		return fmt.Errorf("no such table %q", table)
	}
	cols, rows := len(pc.spec.TableColumns), len(pc.spec.TableRows)
	if cell.Column < 0 || cell.Row < 0 || cell.Column >= cols || cell.Row >= rows {
		return fmt.Errorf("%s has %d columns and %d rows, so there is no cell (%d, %d)",
			table, cols, rows, cell.Column, cell.Row)
	}
	return nil
}

// planSetTable rewrites a table's columns and rows: the counts in its
// constructor and the style calls after it.
//
// A control standing in a column or row that would no longer exist is
// refused rather than dropped: the framework would leave it unplaced, and
// the designer would have no cell to draw it in. The designer moves such
// controls first, in the same batch, when it means to.
func planSetTable(r *parseResult, op Op) ([]edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	if pc.spec.Type != "TableLayoutPanel" {
		return nil, fmt.Errorf("%q is a %s, not a TableLayoutPanel", op.ID, pc.spec.Type)
	}
	if pc.spec.TableReadOnly {
		return nil, fmt.Errorf("%q's columns and rows are styled by code this designer can't regenerate - edit them in the .go file", op.ID)
	}
	if len(op.TableColumns) == 0 || len(op.TableRows) == 0 {
		return nil, fmt.Errorf("a table needs at least one column and one row")
	}
	for _, t := range append(append([]TrackSpec{}, op.TableColumns...), op.TableRows...) {
		if err := validTrack(t); err != nil {
			return nil, err
		}
	}
	for _, c := range r.model.Controls {
		if c.Parent != op.ID || c.Cell == nil {
			continue
		}
		if c.Cell.Column >= len(op.TableColumns) || c.Cell.Row >= len(op.TableRows) {
			return nil, fmt.Errorf("%s is in column %d, row %d; move or delete it before removing that %s",
				c.ID, c.Cell.Column, c.Cell.Row, map[bool]string{true: "column", false: "row"}[c.Cell.Column >= len(op.TableColumns)])
		}
	}
	if len(pc.tableCountArgs) != 2 {
		return nil, fmt.Errorf("could not locate %q's column and row counts", op.ID)
	}

	edits := []edit{
		{offset(r.fset, pc.tableCountArgs[0].Pos()), offset(r.fset, pc.tableCountArgs[0].End()), strconv.Itoa(len(op.TableColumns))},
		{offset(r.fset, pc.tableCountArgs[1].Pos()), offset(r.fset, pc.tableCountArgs[1].End()), strconv.Itoa(len(op.TableRows))},
	}

	next := *pc.spec
	next.TableColumns = op.TableColumns
	next.TableRows = op.TableRows
	if len(pc.trackStmts) == 0 {
		lines := tableLines(r.model.RecvVar, &next, "\t")
		if lines == "" {
			return edits, nil
		}
		insertAt, indent := beforeAddControlLine(r, pc)
		return append(edits, edit{insertAt, insertAt, tableLines(r.model.RecvVar, &next, indent)}), nil
	}
	first := pc.trackStmts[0]
	firstStart := offset(r.fset, first.Start)
	start, end := wholeLines(r.src, firstStart, offset(r.fset, first.End))
	edits = append(edits, edit{start, end, tableLines(r.model.RecvVar, &next, leadingIndent(r.src, firstStart))})
	for _, st := range pc.trackStmts[1:] {
		edits = addLineDelete(edits, r.src, offset(r.fset, st.Start), offset(r.fset, st.End))
	}
	return edits, nil
}

// sameCell compares two cells, nil meaning "the next free one".
func sameCell(a, b *CellSpec) bool {
	a, b = normalizeCell(a), normalizeCell(b)
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
