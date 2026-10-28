package main

import (
	"strings"
	"testing"
)

const tableForm = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	tbl  *goforms.TableLayoutPanel
	btnA *goforms.Button
	btnB *goforms.Button
	btnC *goforms.Button
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.tbl = goforms.NewTableLayoutPanel(300, 200, 2, 3)
	mf.tbl.SetBounds(10, 10, 300, 200)
	mf.tbl.SetColumnStyle(0, goforms.Absolute(80))
	mf.tbl.SetRowStyle(2, goforms.Percent(50))
	mf.AddControl(mf.tbl)

	mf.btnA = goforms.NewButton("A")
	mf.btnA.SetBounds(0, 0, 80, 30)
	mf.tbl.AddControl(mf.btnA)

	mf.btnB = goforms.NewButton("B")
	mf.btnB.SetBounds(0, 0, 80, 30)
	mf.tbl.AddControlAt(mf.btnB, 1, 1)

	mf.btnC = goforms.NewButton("C")
	mf.btnC.SetBounds(0, 0, 80, 30)
	mf.tbl.AddControlSpanning(mf.btnC, 0, 2, 2, 1)
}
`

func TestTableIsReadBackByCell(t *testing.T) {
	path := writeFixture(t, tableForm)
	r, err := parseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tbl := findControl(t, r.model, "tbl")
	if len(tbl.TableColumns) != 2 || len(tbl.TableRows) != 3 {
		t.Fatalf("tracks %v x %v", tbl.TableColumns, tbl.TableRows)
	}
	if tbl.TableColumns[0] != (TrackSpec{Type: "Absolute", Value: 80}) || tbl.TableColumns[1].Type != "AutoSize" {
		t.Errorf("columns = %v", tbl.TableColumns)
	}
	if tbl.TableRows[2] != (TrackSpec{Type: "Percent", Value: 50}) {
		t.Errorf("rows = %v", tbl.TableRows)
	}
	// A plain AddControl has no cell of its own: the framework picks it.
	if c := findControl(t, r.model, "btnA"); c.Parent != "tbl" || c.Cell != nil {
		t.Errorf("btnA = parent %q cell %v", c.Parent, c.Cell)
	}
	if c := findControl(t, r.model, "btnB"); c.Parent != "tbl" || *c.Cell != (CellSpec{Column: 1, Row: 1}) {
		t.Errorf("btnB = parent %q cell %v", c.Parent, c.Cell)
	}
	if c := findControl(t, r.model, "btnC"); *c.Cell != (CellSpec{Column: 0, Row: 2, ColumnSpan: 2}) {
		t.Errorf("btnC cell %v", c.Cell)
	}
}

func TestSetCellRewritesTheAddCall(t *testing.T) {
	path := writeFixture(t, tableForm)
	_, src := mustApply(t, path,
		Op{Op: "setCell", ID: "btnA", Cell: &CellSpec{Column: 1, Row: 0}},
		Op{Op: "setCell", ID: "btnB", Cell: &CellSpec{Column: 0, Row: 1, RowSpan: 2}},
		Op{Op: "setCell", ID: "btnC"},
	)
	for _, want := range []string{
		"mf.tbl.AddControlAt(mf.btnA, 1, 0)",
		"mf.tbl.AddControlSpanning(mf.btnB, 0, 1, 1, 2)",
		"mf.tbl.AddControl(mf.btnC)",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("want %s in\n%s", want, src)
		}
	}
}

func TestSetCellRefusesACellOutsideTheTable(t *testing.T) {
	path := writeFixture(t, tableForm)
	if _, err := applyOps(path, []Op{{Op: "setCell", ID: "btnA", Cell: &CellSpec{Column: 2, Row: 0}}}); err == nil {
		t.Fatal("placed a control in column 2 of a two-column table")
	}
}

func TestSetTableRewritesCountsAndStyles(t *testing.T) {
	path := writeFixture(t, tableForm)
	model, src := mustApply(t, path, Op{Op: "setTable", ID: "tbl",
		TableColumns: []TrackSpec{{Type: "Percent", Value: 30}, {Type: "Percent", Value: 70}, {Type: "AutoSize"}},
		TableRows:    []TrackSpec{{Type: "AutoSize"}, {Type: "AutoSize"}, {Type: "Absolute", Value: 40}},
	})
	if !strings.Contains(src, "goforms.NewTableLayoutPanel(300, 200, 3, 3)") {
		t.Errorf("counts not rewritten:\n%s", src)
	}
	for _, want := range []string{"SetColumnStyle(0, goforms.Percent(30))", "SetColumnStyle(1, goforms.Percent(70))", "SetRowStyle(2, goforms.Absolute(40))"} {
		if !strings.Contains(src, want) {
			t.Errorf("want %s in\n%s", want, src)
		}
	}
	if strings.Contains(src, "Absolute(80)") || strings.Contains(src, "Percent(50)") {
		t.Errorf("old styles survived:\n%s", src)
	}
	if n := strings.Count(src, "SetColumnStyle") + strings.Count(src, "SetRowStyle"); n != 3 {
		t.Errorf("%d style calls, want 3:\n%s", n, src)
	}
	if tbl := findControl(t, model, "tbl"); len(tbl.TableColumns) != 3 {
		t.Errorf("columns = %v", tbl.TableColumns)
	}
}

func TestSetTableRefusesToDropAnOccupiedRow(t *testing.T) {
	path := writeFixture(t, tableForm)
	_, err := applyOps(path, []Op{{Op: "setTable", ID: "tbl",
		TableColumns: []TrackSpec{{Type: "AutoSize"}, {Type: "AutoSize"}},
		TableRows:    []TrackSpec{{Type: "AutoSize"}, {Type: "AutoSize"}},
	}})
	if err == nil || !strings.Contains(err.Error(), "btnC") {
		t.Fatalf("want a refusal naming btnC, got %v", err)
	}
}

func TestMovingIntoATableCellAndOut(t *testing.T) {
	path := writeFixture(t, tableForm+"")
	mustApply(t, path, Op{Op: "add", ID: "lbl", Type: "Label", Text: "x", W: 50, H: 20})
	_, src := mustApply(t, path, Op{Op: "setParent", ID: "lbl", Parent: "tbl", Cell: &CellSpec{Column: 0, Row: 1}})
	if !strings.Contains(src, "mf.tbl.AddControlAt(mf.lbl, 0, 1)") {
		t.Errorf("not placed in its cell:\n%s", src)
	}
	_, src = mustApply(t, path, Op{Op: "setParent", ID: "lbl", Parent: ""})
	if !strings.Contains(src, "mf.AddControl(mf.lbl)") {
		t.Errorf("not moved back to the form:\n%s", src)
	}
}

func TestAPastedTableKeepsItsTracksAndCells(t *testing.T) {
	path := writeFixture(t, designerFixture)
	_, src := mustApply(t, path,
		Op{Op: "add", ID: "tbl2", Type: "TableLayoutPanel", W: 200, H: 100,
			TableColumns: []TrackSpec{{Type: "Absolute", Value: 50}, {Type: "AutoSize"}, {Type: "AutoSize"}},
			TableRows:    []TrackSpec{{Type: "AutoSize"}}},
		Op{Op: "add", ID: "btn9", Type: "Button", Text: "9", Parent: "tbl2", W: 50, H: 20, Cell: &CellSpec{Column: 2, Row: 0}},
	)
	for _, want := range []string{"goforms.NewTableLayoutPanel(200, 100, 3, 1)", "mf.tbl2.SetColumnStyle(0, goforms.Absolute(50))", "mf.tbl2.AddControlAt(mf.btn9, 2, 0)"} {
		if !strings.Contains(src, want) {
			t.Errorf("want %s in\n%s", want, src)
		}
	}
}

func TestTidyKeepsTableAddsAndCollapsesDuplicates(t *testing.T) {
	src := strings.Replace(tableForm, "\tmf.tbl.AddControlAt(mf.btnB, 1, 1)\n", "\tmf.tbl.AddControl(mf.btnB)\n\tmf.tbl.AddControlAt(mf.btnB, 1, 1)\n", 1)
	path := writeFixture(t, src)
	if _, err := tidyFile(path); err != nil {
		t.Fatal(err)
	}
	got := readBack(t, path)
	if strings.Contains(got, "mf.tbl.AddControl(mf.btnB)") || !strings.Contains(got, "mf.tbl.AddControlAt(mf.btnB, 1, 1)") {
		t.Errorf("tidy did not keep the last add only:\n%s", got)
	}
	if !strings.Contains(got, "SetColumnStyle(0, goforms.Absolute(80))") {
		t.Errorf("tidy dropped a track style:\n%s", got)
	}
}
