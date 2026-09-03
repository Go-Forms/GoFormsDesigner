package main

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// designerFixture is the minimum shape parseFile insists on: a struct
// embedding *goforms.Form, a New<Type> constructor calling goforms.NewForm,
// and an initializeComponent method.
const designerFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	lblWelcome *goforms.Label
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.lblWelcome = goforms.NewLabel("Hello")
	mf.lblWelcome.SetBounds(20, 20, 300, 24)
	mf.AddControl(mf.lblWelcome)
}
`

// writeFixture drops the fixture in a temp dir and returns its path.
func writeFixture(t *testing.T, src string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "MainForm-designer.go")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

// mustApply runs ops and fails the test on error, returning the fresh model
// and the file's new contents.
func mustApply(t *testing.T, path string, ops ...Op) (*FormModel, string) {
	t.Helper()
	model, err := applyOps(path, ops)
	if err != nil {
		t.Fatalf("applyOps%v: %v", ops, err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	// Every edit must leave the file compilable; a syntax error here means
	// the splicing produced garbage even if the assertions below pass.
	if _, err := parser.ParseFile(token.NewFileSet(), path, b, parser.ParseComments); err != nil {
		t.Fatalf("apply produced unparseable Go:\n%s\nerror: %v", b, err)
	}
	return model, string(b)
}

func findControl(t *testing.T, m *FormModel, id string) *ControlSpec {
	t.Helper()
	for _, c := range m.Controls {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("control %q not found in model (have %d controls)", id, len(m.Controls))
	return nil
}

func TestAddDataGridViewGeneratesSeededColumns(t *testing.T) {
	path := writeFixture(t, designerFixture)

	model, src := mustApply(t, path, Op{
		Op: "add", ID: "grid1", Type: "DataGridView",
		X: 30, Y: 60, W: 400, H: 200,
	})

	if !strings.Contains(src, `mf.grid1 = goforms.NewDataGridView("Column 1", "Column 2", "Column 3")`) {
		t.Fatalf("grid should be seeded with default columns:\n%s", src)
	}
	if !strings.Contains(src, "grid1 *goforms.DataGridView") {
		t.Fatalf("struct field should be declared:\n%s", src)
	}
	if !strings.Contains(src, "mf.grid1.SetBounds(30, 60, 400, 200)") {
		t.Fatalf("bounds should be emitted:\n%s", src)
	}
	if !strings.Contains(src, "mf.AddControl(mf.grid1)") {
		t.Fatalf("grid should be added to the form:\n%s", src)
	}

	spec := findControl(t, model, "grid1")
	if spec.Type != "DataGridView" || !spec.Supported {
		t.Fatalf("grid should round-trip as a supported DataGridView, got %+v", spec)
	}
	if len(spec.Items) != 3 || spec.Items[0] != "Column 1" {
		t.Fatalf("columns should round-trip as Items, got %v", spec.Items)
	}
}

func TestSetPropInsertsSetterWhenAbsent(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})

	// None of these setters exist in the file yet - each must be synthesized.
	model, src := mustApply(t, path,
		Op{Op: "setProp", ID: "grid1", Prop: "scrollBars", Value: "ScrollBarsVertical"},
		Op{Op: "setProp", ID: "grid1", Prop: "readOnly", Value: "true"},
		Op{Op: "setProp", ID: "grid1", Prop: "rowHeight", Value: "28"},
	)

	for _, want := range []string{
		"mf.grid1.SetScrollBars(goforms.ScrollBarsVertical)",
		"mf.grid1.SetReadOnly(true)",
		"mf.grid1.SetRowHeight(28)",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing %q in:\n%s", want, src)
		}
	}

	spec := findControl(t, model, "grid1")
	if spec.Props["scrollBars"] != "ScrollBarsVertical" {
		t.Errorf("enum should round-trip unqualified, got %q", spec.Props["scrollBars"])
	}
	if spec.Props["readOnly"] != "true" {
		t.Errorf("bool should round-trip, got %q", spec.Props["readOnly"])
	}
	if spec.Props["rowHeight"] != "28" {
		t.Errorf("number should round-trip, got %q", spec.Props["rowHeight"])
	}
}

func TestSetPropReplacesExistingSetterInPlace(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})
	mustApply(t, path, Op{Op: "setProp", ID: "grid1", Prop: "scrollBars", Value: "ScrollBarsVertical"})

	model, src := mustApply(t, path,
		Op{Op: "setProp", ID: "grid1", Prop: "scrollBars", Value: "ScrollBarsNone"})

	if strings.Contains(src, "ScrollBarsVertical") {
		t.Errorf("the old value should be gone, not duplicated:\n%s", src)
	}
	if n := strings.Count(src, "mf.grid1.SetScrollBars("); n != 1 {
		t.Errorf("expected exactly one SetScrollBars call, got %d:\n%s", n, src)
	}
	if got := findControl(t, model, "grid1").Props["scrollBars"]; got != "ScrollBarsNone" {
		t.Errorf("value should be updated, got %q", got)
	}
}

func TestSetPropRejectsWrongKind(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})
	before, _ := os.ReadFile(path)

	cases := []struct {
		name string
		op   Op
	}{
		{"enum outside the allowed set",
			Op{Op: "setProp", ID: "grid1", Prop: "scrollBars", Value: "Nonsense"}},
		{"non-numeric number",
			Op{Op: "setProp", ID: "grid1", Prop: "rowHeight", Value: "tall"}},
		{"non-boolean bool",
			Op{Op: "setProp", ID: "grid1", Prop: "readOnly", Value: "yes"}},
		{"unknown property",
			Op{Op: "setProp", ID: "grid1", Prop: "nosuchprop", Value: "x"}},
	}
	for _, c := range cases {
		if _, err := applyOps(path, []Op{c.op}); err == nil {
			t.Errorf("%s: expected an error, got none", c.name)
		}
	}

	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("a rejected op must leave the file untouched")
	}
}

func TestSetItemsRewritesGridColumns(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})

	model, src := mustApply(t, path,
		Op{Op: "setItems", ID: "grid1", Items: []string{"Name", "Qty"}})

	if !strings.Contains(src, `goforms.NewDataGridView("Name", "Qty")`) {
		t.Fatalf("columns should be rewritten:\n%s", src)
	}
	if got := findControl(t, model, "grid1").Items; len(got) != 2 || got[1] != "Qty" {
		t.Fatalf("columns should round-trip, got %v", got)
	}
}

func TestAddRowsAreReadBackAsGridData(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})

	// Hand-written AddRow calls (the tool never emits these) must still be
	// picked up so the canvas can show real rows.
	src, _ := os.ReadFile(path)
	injected := strings.Replace(string(src),
		"mf.AddControl(mf.grid1)",
		"mf.grid1.AddRow(\"a1\", \"b1\", \"c1\")\n\tmf.grid1.AddRow(\"a2\", \"b2\", \"c2\")\n\tmf.AddControl(mf.grid1)", 1)
	if err := os.WriteFile(path, []byte(injected), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	spec := findControl(t, res.model, "grid1")
	if len(spec.Rows) != 2 || spec.Rows[1][2] != "c2" {
		t.Fatalf("rows should round-trip for rendering, got %v", spec.Rows)
	}
}

func TestSetEventWiresGridHandler(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})

	model, src := mustApply(t, path,
		Op{Op: "setEvent", ID: "grid1", Event: "CellValueChanged", Handler: "grid1_CellValueChanged"})

	if !strings.Contains(src, "mf.grid1.CellValueChanged.Handle(mf.grid1_CellValueChanged)") {
		t.Fatalf("handler should be wired:\n%s", src)
	}
	if got := findControl(t, model, "grid1").Events["CellValueChanged"]; got != "grid1_CellValueChanged" {
		t.Fatalf("event should round-trip, got %q", got)
	}

	// Click is inherited from ControlBase, so every control accepts it.
	if _, err := applyOps(path, []Op{{Op: "setEvent", ID: "grid1", Event: "Click", Handler: "grid1_Click"}}); err != nil {
		t.Errorf("Click is inherited by every control and should be wirable: %v", err)
	}

	// A name that is neither the type's own nor inherited must be refused.
	if _, err := applyOps(path, []Op{{Op: "setEvent", ID: "grid1", Event: "NoSuchEvent", Handler: "x"}}); err == nil {
		t.Error("expected an error for an event that does not exist")
	}
}

func TestCatalogReportsEventArgTypes(t *testing.T) {
	// A generated handler stub takes its parameter type from here; getting
	// it wrong produces code that doesn't compile, so every advertised
	// event must name a type.
	for typeName, desc := range catalog {
		for _, ev := range allEventsFor(desc) {
			argType, ok := eventArgType(desc, ev)
			if !ok || argType == "" {
				t.Errorf("%s.%s has no argument type", typeName, ev)
			}
		}
	}

	// The base events every control inherits must all be present and typed.
	btn := catalog["Button"]
	if got, _ := eventArgType(btn, "Click"); got != "MouseEventArgs" {
		t.Errorf("Click should carry MouseEventArgs, got %q", got)
	}
	if got, _ := eventArgType(btn, "KeyPress"); got != "KeyPressEventArgs" {
		t.Errorf("KeyPress should carry KeyPressEventArgs, got %q", got)
	}
	if got, _ := eventArgType(btn, "MouseEnter"); got != "EventArgs" {
		t.Errorf("MouseEnter carries no data, got %q", got)
	}
	// A control's own event keeps its own type rather than picking up a
	// same-named base one.
	if got, _ := eventArgType(catalog["TextBox"], "TextChanged"); got != "EventArgs" {
		t.Errorf("TextChanged should be EventArgs, got %q", got)
	}
}

func TestBaseEventOrderCoversEveryBaseEvent(t *testing.T) {
	// baseEventOrder drives both the panel's ordering and the boundary the
	// webview draws; an event missing from it would simply never be offered.
	if len(baseEventOrder) != len(baseEvents) {
		t.Fatalf("baseEventOrder lists %d events but baseEvents has %d", len(baseEventOrder), len(baseEvents))
	}
	for _, ev := range baseEventOrder {
		if _, ok := baseEvents[ev]; !ok {
			t.Errorf("baseEventOrder mentions %q, which baseEvents doesn't define", ev)
		}
	}
}

func TestOwnEventsComeBeforeInheritedOnes(t *testing.T) {
	// The Events panel relies on this ordering to place its divider.
	desc := catalog["TextBox"]
	all := allEventsFor(desc)
	if len(all) <= len(desc.Events) {
		t.Fatal("inherited events should be appended to the type's own")
	}
	for i, ev := range desc.Events {
		if all[i] != ev {
			t.Fatalf("the type's own events must come first, got %v", all)
		}
	}
	if all[len(desc.Events)] != baseEventOrder[0] {
		t.Fatalf("inherited events should follow immediately, got %v", all)
	}
}

func TestRemoveGridDeletesFieldAndBlock(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200})

	model, src := mustApply(t, path, Op{Op: "remove", ID: "grid1"})

	if strings.Contains(src, "grid1") {
		t.Fatalf("every trace of the control should be gone:\n%s", src)
	}
	if len(model.Controls) != 1 || model.Controls[0].ID != "lblWelcome" {
		t.Fatalf("only the original label should remain, got %+v", model.Controls)
	}
}

func TestBatchedOpsSeeEachOthersChanges(t *testing.T) {
	path := writeFixture(t, designerFixture)

	// The later ops all target a control that only the first op creates,
	// which only works because each op is planned against a fresh parse.
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "grid1", Type: "DataGridView", X: 10, Y: 10, W: 500, H: 200},
		Op{Op: "setItems", ID: "grid1", Items: []string{"Order", "Customer", "Total"}},
		Op{Op: "setProp", ID: "grid1", Prop: "columnsMode", Value: "SizeFill"},
		Op{Op: "setProp", ID: "grid1", Prop: "rowHeight", Value: "28"},
		Op{Op: "setBounds", ID: "grid1", X: 40, Y: 450, W: 600, H: 180},
	)

	spec := findControl(t, model, "grid1")
	if len(spec.Items) != 3 || spec.Items[2] != "Total" {
		t.Errorf("columns should be set, got %v", spec.Items)
	}
	if spec.Props["columnsMode"] != "SizeFill" || spec.Props["rowHeight"] != "28" {
		t.Errorf("props should be set, got %v", spec.Props)
	}
	if spec.X != 40 || spec.W != 600 {
		t.Errorf("bounds should be the last value applied, got %v,%v %vx%v", spec.X, spec.Y, spec.W, spec.H)
	}
	if !strings.Contains(src, `goforms.NewDataGridView("Order", "Customer", "Total")`) {
		t.Errorf("source should carry the final columns:\n%s", src)
	}
}

func TestFailedBatchRollsBackEveryEarlierOp(t *testing.T) {
	path := writeFixture(t, designerFixture)
	before, _ := os.ReadFile(path)

	// The first two ops are perfectly valid; the third is not. Nothing at
	// all should survive.
	_, err := applyOps(path, []Op{
		{Op: "add", ID: "grid1", Type: "DataGridView", W: 400, H: 200},
		{Op: "setProp", ID: "grid1", Prop: "rowHeight", Value: "28"},
		{Op: "setProp", ID: "grid1", Prop: "scrollBars", Value: "Nonsense"},
	})
	if err == nil {
		t.Fatal("expected the batch to fail")
	}

	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("a failed batch must roll back completely, file became:\n%s", after)
	}
}

func TestEveryCatalogEnumPropDeclaresItsValues(t *testing.T) {
	// A prop declared as an enum with no Enums entry can never be set:
	// formatPropValue would reject every value. Catch that at test time
	// rather than in the property panel.
	for typeName, desc := range catalog {
		for prop, kind := range desc.Kinds {
			if kind != KindEnum {
				continue
			}
			if len(desc.Enums[prop]) == 0 {
				t.Errorf("%s.%s is an enum but lists no allowed values", typeName, prop)
			}
		}
	}
}

func TestEveryDeclaredKindHasASetter(t *testing.T) {
	// Kinds keys are prop names; a typo there would silently fall back to
	// KindString and quote a number or enum into the generated source.
	for typeName, desc := range catalog {
		for prop := range desc.Kinds {
			if _, ok := setterForProp(desc, prop); !ok {
				t.Errorf("%s declares a kind for %q but has no setter producing it", typeName, prop)
			}
		}
	}
}

// --- rename -------------------------------------------------------------

// writePair drops a designer file plus its hand-written counterpart in a
// temp dir and returns the designer path.
func writePair(t *testing.T, designer, logic string) string {
	t.Helper()
	dir := t.TempDir()
	dPath := filepath.Join(dir, "MainForm-designer.go")
	if err := os.WriteFile(dPath, []byte(designer), 0o644); err != nil {
		t.Fatal(err)
	}
	if logic != "" {
		if err := os.WriteFile(filepath.Join(dir, "MainForm.go"), []byte(logic), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dPath
}

func TestRenameUpdatesFieldAndEveryReference(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "btnOld", Type: "Button", X: 5, Y: 5, W: 80, H: 30})

	model, src := mustApply(t, path, Op{Op: "rename", ID: "btnOld", Value: "btnSave"})

	if strings.Contains(src, "btnOld") {
		t.Fatalf("no trace of the old name should remain:\n%s", src)
	}
	for _, want := range []string{
		"btnSave *goforms.Button",
		"mf.btnSave = goforms.NewButton(",
		"mf.btnSave.SetBounds(5, 5, 80, 30)",
		"mf.AddControl(mf.btnSave)",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("missing %q in:\n%s", want, src)
		}
	}
	if findControl(t, model, "btnSave").Type != "Button" {
		t.Error("the renamed control should still parse as a Button")
	}
}

func TestRenameAlsoRenamesGeneratedHandlers(t *testing.T) {
	const logic = `package mainform

import "goforms"

func (mf *MainForm) btnOld_Click(sender any, e goforms.MouseEventArgs) {
	_ = sender
}
`
	path := writePair(t, designerFixture, logic)
	mustApply(t, path,
		Op{Op: "add", ID: "btnOld", Type: "Button", W: 80, H: 30},
		Op{Op: "setEvent", ID: "btnOld", Event: "Click", Handler: "btnOld_Click"})

	_, src := mustApply(t, path, Op{Op: "rename", ID: "btnOld", Value: "btnSave"})

	if !strings.Contains(src, "mf.btnSave.Click.Handle(mf.btnSave_Click)") {
		t.Fatalf("the wiring should point at the renamed handler:\n%s", src)
	}

	logicSrc, err := os.ReadFile(filepath.Join(filepath.Dir(path), "MainForm.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logicSrc), "func (mf *MainForm) btnSave_Click(") {
		t.Fatalf("the handler method itself should be renamed:\n%s", logicSrc)
	}
	if strings.Contains(string(logicSrc), "btnOld") {
		t.Fatalf("no trace of the old handler name should remain:\n%s", logicSrc)
	}
}

func TestRenameLeavesCustomHandlerNamesAlone(t *testing.T) {
	const logic = `package mainform

import "goforms"

func (mf *MainForm) saveEverything(sender any, e goforms.MouseEventArgs) {
}
`
	path := writePair(t, designerFixture, logic)
	mustApply(t, path,
		Op{Op: "add", ID: "btnOld", Type: "Button", W: 80, H: 30},
		Op{Op: "setEvent", ID: "btnOld", Event: "Click", Handler: "saveEverything"})

	_, src := mustApply(t, path, Op{Op: "rename", ID: "btnOld", Value: "btnSave"})

	// A handler the developer named themselves has nothing to do with the
	// control's name, so it must survive untouched.
	if !strings.Contains(src, "mf.btnSave.Click.Handle(mf.saveEverything)") {
		t.Fatalf("a custom handler name should be left alone:\n%s", src)
	}
	logicSrc, _ := os.ReadFile(filepath.Join(filepath.Dir(path), "MainForm.go"))
	if !strings.Contains(string(logicSrc), "func (mf *MainForm) saveEverything(") {
		t.Fatalf("the custom handler method should be untouched:\n%s", logicSrc)
	}
}

func TestRenameRejectsBadNames(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "btnOld", Type: "Button", W: 80, H: 30})
	before, _ := os.ReadFile(path)

	cases := []struct{ name, to string }{
		{"empty", ""},
		{"starts with a digit", "1btn"},
		{"contains punctuation", "btn-save"},
		{"a Go keyword", "func"},
		{"already taken", "lblWelcome"},
	}
	for _, c := range cases {
		if _, err := applyOps(path, []Op{{Op: "rename", ID: "btnOld", Value: c.to}}); err == nil {
			t.Errorf("%s: expected the rename to be refused", c.name)
		}
	}

	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("a refused rename must leave the file untouched")
	}
}

func TestRenameToTheSameNameIsANoOp(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "btnOld", Type: "Button", W: 80, H: 30})
	before, _ := os.ReadFile(path)

	if _, err := applyOps(path, []Op{{Op: "rename", ID: "btnOld", Value: "btnOld"}}); err != nil {
		t.Fatalf("renaming to the same name should be harmless, got %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("a no-op rename should not rewrite the file")
	}
}

func TestRenameOnlyTouchesTheReceiversField(t *testing.T) {
	// A local variable or another struct's field with the same name must not
	// be swept up by the rename.
	src := strings.Replace(designerFixture,
		"\tmf.lblWelcome = goforms.NewLabel(\"Hello\")",
		"\tother := struct{ btnOld int }{}\n\t_ = other.btnOld\n\tmf.lblWelcome = goforms.NewLabel(\"Hello\")", 1)
	path := writeFixture(t, src)
	mustApply(t, path, Op{Op: "add", ID: "btnOld", Type: "Button", W: 80, H: 30})

	_, out := mustApply(t, path, Op{Op: "rename", ID: "btnOld", Value: "btnSave"})

	if !strings.Contains(out, "other.btnOld") {
		t.Fatalf("an unrelated field of the same name should be left alone:\n%s", out)
	}
	if !strings.Contains(out, "mf.btnSave") {
		t.Fatalf("the control itself should still be renamed:\n%s", out)
	}
}
