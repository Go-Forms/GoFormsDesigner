package main

import (
	"strings"
	"testing"
)

const threeButtons = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	btnA *goforms.Button
	pnl  *goforms.Panel
	btnB *goforms.Button
	btnC *goforms.Button
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.btnA = goforms.NewButton("A")
	mf.btnA.SetBounds(0, 0, 80, 30)
	mf.AddControl(mf.btnA)

	mf.pnl = goforms.NewPanel(200, 100)
	mf.pnl.SetBounds(0, 40, 200, 100)
	mf.AddControl(mf.pnl)

	mf.btnB = goforms.NewButton("B")
	mf.btnB.SetBounds(10, 10, 80, 30)
	mf.pnl.AddControl(mf.btnB)

	mf.btnC = goforms.NewButton("C")
	mf.btnC.SetBounds(100, 0, 80, 30)
	mf.AddControl(mf.btnC)
}
`

func idsIn(m *FormModel, parent string) string {
	var out []string
	for _, c := range m.Controls {
		if c.Parent == parent {
			out = append(out, c.ID)
		}
	}
	return strings.Join(out, ",")
}

// Bring to Front is the control moved to the end of its container's list:
// the framework draws the last child added on top.
func TestReorderBringsAControlToTheFront(t *testing.T) {
	path := writeFixture(t, threeButtons)
	model, src := mustApply(t, path, Op{Op: "reorder", ID: "", Order: []string{"pnl", "btnC", "btnA"}})
	if got := idsIn(model, ""); got != "pnl,btnC,btnA" {
		t.Fatalf("form children = %s", got)
	}
	// The panel's own child goes with the panel, after it.
	if indexOfLine(t, src, "mf.pnl.AddControl(mf.btnB)") < indexOfLine(t, src, "mf.pnl = goforms.NewPanel(200, 100)") {
		t.Errorf("a container's child ended up above it:\n%s", src)
	}
}

func TestReorderMustNameEveryChild(t *testing.T) {
	path := writeFixture(t, threeButtons)
	if _, err := applyOps(path, []Op{{Op: "reorder", ID: "", Order: []string{"btnC", "btnA"}}}); err == nil {
		t.Fatal("a reorder that leaves out a child was accepted")
	}
	if _, err := applyOps(path, []Op{{Op: "reorder", ID: "", Order: []string{"btnC", "btnA", "btnB"}}}); err == nil {
		t.Fatal("a reorder naming a control from another container was accepted")
	}
}

func TestReorderInsideAContainer(t *testing.T) {
	src := strings.Replace(threeButtons, "\tmf.btnC = goforms.NewButton(\"C\")\n\tmf.btnC.SetBounds(100, 0, 80, 30)\n\tmf.AddControl(mf.btnC)",
		"\tmf.btnC = goforms.NewButton(\"C\")\n\tmf.btnC.SetBounds(100, 0, 80, 30)\n\tmf.pnl.AddControl(mf.btnC)", 1)
	path := writeFixture(t, src)
	model, _ := mustApply(t, path, Op{Op: "reorder", ID: "pnl", Order: []string{"btnC", "btnB"}})
	if got := idsIn(model, "pnl"); got != "btnC,btnB" {
		t.Fatalf("panel children = %s", got)
	}
}

func TestResetPropDeletesTheSetter(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "setProp", ID: "lblWelcome", Prop: "dock", Value: "DockTop"})
	model, src := mustApply(t, path, Op{Op: "resetProp", ID: "lblWelcome", Prop: "dock"})
	if strings.Contains(src, "SetDock") {
		t.Errorf("SetDock survived a reset:\n%s", src)
	}
	if v, ok := findControl(t, model, "lblWelcome").Props["dock"]; ok {
		t.Errorf("dock still reads %q", v)
	}
	// Resetting what is already default is a no-op, not an error.
	mustApply(t, path, Op{Op: "resetProp", ID: "lblWelcome", Prop: "dock"})
}

func TestResetPropOnTheForm(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "setProp", Prop: "fixedSize", Value: "true"}, Op{Op: "setProp", Prop: "centerOnScreen", Value: "true"})
	model, src := mustApply(t, path, Op{Op: "resetProp", Prop: "fixedSize"}, Op{Op: "resetProp", Prop: "centerOnScreen"})
	if strings.Contains(src, "SetFixedSize") || strings.Contains(src, "CenterOnScreen") {
		t.Errorf("form settings survived a reset:\n%s", src)
	}
	if len(model.FormProps) != 0 {
		t.Errorf("form props = %v", model.FormProps)
	}
}

func TestResetPropRefusesAConstructorArgument(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "tmr", Type: "Timer"})
	if _, err := applyOps(path, []Op{{Op: "resetProp", ID: "tmr", Prop: "interval"}}); err == nil {
		t.Fatal("reset an interval the constructor needs")
	}
}

// A file whose other blocks cannot be moved - a Timer's wiring written
// further down - still lets one container's children trade places.
func TestReorderWorksBesideBlocksThatCannotMove(t *testing.T) {
	src := strings.Replace(threeButtons, "\tmf.btnA = goforms.NewButton(\"A\")", "\tmf.tmr = goforms.NewTimer(1000)\n\n\tmf.btnA = goforms.NewButton(\"A\")", 1)
	src = strings.Replace(src, "\tbtnC *goforms.Button\n", "\tbtnC *goforms.Button\n\ttmr  *goforms.Timer\n", 1)
	src = strings.Replace(src, "\tmf.AddControl(mf.btnC)\n}", "\tmf.AddControl(mf.btnC)\n\n\tmf.tmr.Tick.Handle(mf.tick)\n}", 1)
	path := writeFixture(t, src)
	model, _ := mustApply(t, path, Op{Op: "reorder", ID: "", Order: []string{"btnC", "btnA", "pnl"}})
	if got := idsIn(model, ""); got != "tmr,btnC,btnA,pnl" {
		t.Fatalf("form children = %s", got)
	}
}

// Deleting the last control that needs an import takes the import with it:
// a Go file with an unused import does not compile.
func TestRemovingTheLastDatePickerDropsTheTimeImport(t *testing.T) {
	path := writeFixture(t, designerFixture)
	_, src := mustApply(t, path, Op{Op: "add", ID: "dtp", Type: "DateTimePicker", W: 120, H: 30})
	if !strings.Contains(src, `"time"`) {
		t.Fatalf("adding a date picker did not import time:\n%s", src)
	}
	_, src = mustApply(t, path, Op{Op: "remove", ID: "dtp"})
	if strings.Contains(src, `"time"`) {
		t.Errorf("the unused import survived:\n%s", src)
	}
}

func TestRemoveEventUnwiresAndKeepsTheMethodName(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "setEvent", ID: "lblWelcome", Event: "Click", Handler: "lbl_Click"},
		Op{Op: "setEvent", Event: "Load", Handler: "form_Load"})
	model, src := mustApply(t, path, Op{Op: "removeEvent", ID: "lblWelcome", Event: "Click"}, Op{Op: "removeEvent", Event: "Load"})
	if strings.Contains(src, ".Handle(") {
		t.Errorf("a wiring survived:\n%s", src)
	}
	if len(findControl(t, model, "lblWelcome").Events) != 0 || len(model.FormEvents) != 0 {
		t.Errorf("events still read back")
	}
	// Unwiring what is not wired is a no-op.
	mustApply(t, path, Op{Op: "removeEvent", ID: "lblWelcome", Event: "Click"})
}
