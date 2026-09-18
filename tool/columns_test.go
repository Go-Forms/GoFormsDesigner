package main

import (
	"strings"
	"testing"
)

const gridFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	grdOrders *goforms.DataGridView
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.grdOrders = goforms.NewDataGridView("ID", "Customer", "Action")
	mf.grdOrders.SetBounds(10, 10, 400, 200)
	mf.AddControl(mf.grdOrders)
}
`

func gridColumns(t *testing.T, model *FormModel) []GridColumnSpec {
	t.Helper()
	c := controlByID(model, "grdOrders")
	if c == nil {
		t.Fatal("grdOrders missing from the model")
	}
	return c.Columns
}

// The titles come from the constructor, so a grid nobody has configured
// still reports one column per title.
func TestColumnsMirrorTheTitles(t *testing.T) {
	path := writeFixture(t, gridFixture)
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cols := gridColumns(t, r.model)
	if len(cols) != 3 {
		t.Fatalf("got %d columns, want 3: %+v", len(cols), cols)
	}
	for i, want := range []string{"ID", "Customer", "Action"} {
		if cols[i].Title != want {
			t.Errorf("column %d title = %q, want %q", i, cols[i].Title, want)
		}
		if cols[i].Kind != "" || cols[i].Hidden {
			t.Errorf("column %d came back configured: %+v", i, cols[i])
		}
	}
}

func TestSetColumnsWritesTitlesAndSetters(t *testing.T) {
	path := writeFixture(t, gridFixture)
	model, src := mustApply(t, path, Op{Op: "setColumns", ID: "grdOrders", Columns: []GridColumnSpec{
		{Title: "ID", Hidden: true},
		{Title: "Customer"},
		{Title: "Action", Kind: "Button", ButtonText: "Assign"},
	}})

	for _, want := range []string{
		`goforms.NewDataGridView("ID", "Customer", "Action")`,
		`mf.grdOrders.SetColumnHidden(0, true)`,
		`mf.grdOrders.SetColumnKind(2, goforms.GridColumnButton)`,
		`mf.grdOrders.SetColumnButtonText(2, "Assign")`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing %q in:\n%s", want, src)
		}
	}
	// A plain column writes nothing: that is what the constructor already did.
	if strings.Contains(src, "SetColumnKind(1,") || strings.Contains(src, "SetColumnHidden(1,") {
		t.Errorf("an untouched column was configured anyway:\n%s", src)
	}

	cols := gridColumns(t, model)
	if !cols[0].Hidden {
		t.Errorf("column 0 did not read back hidden: %+v", cols[0])
	}
	if cols[2].Kind != "Button" || cols[2].ButtonText != "Assign" {
		t.Errorf("column 2 did not round-trip: %+v", cols[2])
	}
}

// Editing again must replace the previous setters, not stack a second set on
// top of them - the file would then hold two answers for one column.
func TestSetColumnsReplacesTheOldSetters(t *testing.T) {
	path := writeFixture(t, gridFixture)
	mustApply(t, path, Op{Op: "setColumns", ID: "grdOrders", Columns: []GridColumnSpec{
		{Title: "ID", Hidden: true},
		{Title: "Customer"},
		{Title: "Action", Kind: "Button", ButtonText: "Assign"},
	}})
	model, src := mustApply(t, path, Op{Op: "setColumns", ID: "grdOrders", Columns: []GridColumnSpec{
		{Title: "ID"},
		{Title: "Customer"},
		{Title: "Action", Kind: "CheckBox"},
	}})

	if strings.Contains(src, "SetColumnHidden") {
		t.Errorf("un-hiding a column left the old call behind:\n%s", src)
	}
	if strings.Contains(src, "GridColumnButton") || strings.Contains(src, "SetColumnButtonText") {
		t.Errorf("the previous kind survived the change:\n%s", src)
	}
	if !strings.Contains(src, "SetColumnKind(2, goforms.GridColumnCheckBox)") {
		t.Errorf("the new kind was not written:\n%s", src)
	}
	if got := gridColumns(t, model); got[0].Hidden || got[2].Kind != "CheckBox" {
		t.Errorf("model did not follow the file: %+v", got)
	}
}

// Renaming and reordering columns rewrites the constructor.
func TestSetColumnsRewritesTitles(t *testing.T) {
	path := writeFixture(t, gridFixture)
	model, src := mustApply(t, path, Op{Op: "setColumns", ID: "grdOrders", Columns: []GridColumnSpec{
		{Title: "Order"},
		{Title: "Total"},
	}})
	if !strings.Contains(src, `goforms.NewDataGridView("Order", "Total")`) {
		t.Errorf("titles were not rewritten:\n%s", src)
	}
	if got := len(gridColumns(t, model)); got != 2 {
		t.Errorf("got %d columns, want 2", got)
	}
}

// A grid with no columns draws as an empty box, which reads as a broken
// control rather than an edit.
func TestSetColumnsRefusesAnEmptyList(t *testing.T) {
	path := writeFixture(t, gridFixture)
	before := readFile(t, path)
	if _, err := applyOps(path, []Op{{Op: "setColumns", ID: "grdOrders"}}); err == nil {
		t.Fatal("an empty column list should be refused")
	}
	if readFile(t, path) != before {
		t.Error("the refused edit still changed the file")
	}
}

func TestSetColumnsRejectsOtherTypes(t *testing.T) {
	path := writeFixture(t, slotFixture)
	if _, err := applyOps(path, []Op{{Op: "setColumns", ID: "btnLeft", Columns: []GridColumnSpec{{Title: "x"}}}}); err == nil {
		t.Fatal("a Button has no columns")
	}
}

// A control added from the palette reports its seeded columns straight away,
// so the editor has a table to show rather than an empty one.
func TestAddedGridReportsItsColumns(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, _ := mustApply(t, path, Op{
		Op: "add", ID: "grdNew", Type: "DataGridView", X: 10, Y: 10, W: 400, H: 200,
	})
	c := controlByID(model, "grdNew")
	if c == nil || len(c.Columns) == 0 {
		t.Fatalf("a fresh grid reported no columns: %+v", c)
	}
	if c.Columns[0].Title != c.Items[0] {
		t.Errorf("column titles and items disagree: %q vs %q", c.Columns[0].Title, c.Items[0])
	}
}

// A hand-written file that configures a column the constructor never named
// must not have that line silently dropped by the next edit.
func TestColumnsKeepSettersBeyondTheTitles(t *testing.T) {
	path := writeFixture(t, strings.Replace(gridFixture,
		"\tmf.AddControl(mf.grdOrders)",
		"\tmf.grdOrders.SetColumnHidden(4, true)\n\tmf.AddControl(mf.grdOrders)", 1))
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cols := gridColumns(t, r.model)
	if len(cols) != 5 {
		t.Fatalf("got %d columns, want 5 (the list grows to the furthest index used): %+v", len(cols), cols)
	}
	if !cols[4].Hidden {
		t.Errorf("the setter beyond the titles was lost: %+v", cols[4])
	}
}
