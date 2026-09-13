package main

import (
	"os"
	"strings"
	"testing"
)

// The tray: components that live on the form as fields but have no place on
// it. They break every assumption the rest of this tool was built on - no
// bounds, no AddControl to end the block, properties written as field
// assignments and as bare method calls - so each of those is checked here
// rather than left to be discovered in the designer.

func TestAddTimerWritesNoBoundsAndNoAddControl(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path, Op{Op: "add", ID: "tmrPoll", Type: "Timer"})

	spec := findControl(t, model, "tmrPoll")
	if spec.Type != "Timer" {
		t.Fatalf("type = %q, want Timer", spec.Type)
	}
	if spec.Props["interval"] != "1000" {
		t.Errorf("interval = %q, want the 1000ms default", spec.Props["interval"])
	}
	if strings.Contains(src, "tmrPoll.SetBounds") {
		t.Error("a Timer was given bounds; it has none")
	}
	if strings.Contains(src, "AddControl(mf.tmrPoll)") {
		t.Error("a Timer was added to the form; it is not on it")
	}
	// gofmt aligns struct fields, so the gap between name and type is
	// whatever the widest neighbour needs.
	if !strings.Contains(strings.Join(strings.Fields(src), " "), "tmrPoll *goforms.Timer") {
		t.Errorf("no struct field was declared for the timer:\n%s", src)
	}
}

func TestTimerIntervalIsEditedInTheConstructor(t *testing.T) {
	// The interval lives in exactly one place. Editing it must rewrite that
	// argument rather than append an Interval assignment beside it, or the
	// file would carry two values for one property.
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "tmrPoll", Type: "Timer"})
	model, src := mustApply(t, path, Op{Op: "setProp", ID: "tmrPoll", Prop: "interval", Value: "250"})

	if got := findControl(t, model, "tmrPoll").Props["interval"]; got != "250" {
		t.Errorf("interval = %q, want 250", got)
	}
	if !strings.Contains(src, "goforms.NewTimer(250)") {
		t.Errorf("the constructor still holds the old interval:\n%s", src)
	}
	if strings.Contains(src, ".Interval =") {
		t.Errorf("a second writer for the interval was added:\n%s", src)
	}
}

func TestTimerEnabledIsAStartCall(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "tmrPoll", Type: "Timer"})

	model, src := mustApply(t, path, Op{Op: "setProp", ID: "tmrPoll", Prop: "enabled", Value: "true"})
	if got := findControl(t, model, "tmrPoll").Props["enabled"]; got != "true" {
		t.Errorf("enabled = %q, want true", got)
	}
	if !strings.Contains(src, "mf.tmrPoll.Start()") {
		t.Errorf("no Start() call:\n%s", src)
	}

	// And off again: there is no Stop() to write, so the line goes away.
	model, src = mustApply(t, path, Op{Op: "setProp", ID: "tmrPoll", Prop: "enabled", Value: "false"})
	if got := findControl(t, model, "tmrPoll").Props["enabled"]; got == "true" {
		t.Error("enabled stayed true after being turned off")
	}
	if strings.Contains(src, "Start()") {
		t.Errorf("the Start() call survived being turned off:\n%s", src)
	}
}

func TestTimerStartGoesAfterItsHandler(t *testing.T) {
	// A timer started before its Tick is wired is a timer whose first ticks
	// go nowhere. Generation order is the only thing preventing that.
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "tmrPoll", Type: "Timer"})
	mustApply(t, path, Op{Op: "setEvent", ID: "tmrPoll", Event: "Tick", Handler: "tmrPoll_Tick"})
	_, src := mustApply(t, path, Op{Op: "setProp", ID: "tmrPoll", Prop: "enabled", Value: "true"})

	handle := strings.Index(src, "Tick.Handle")
	start := strings.Index(src, "Start()")
	if handle < 0 || start < 0 {
		t.Fatalf("expected both a Tick.Handle and a Start():\n%s", src)
	}
	if start < handle {
		t.Errorf("Start() comes before the handler is wired:\n%s", src)
	}
}

func TestDialogPropertiesAreFieldAssignments(t *testing.T) {
	// A dialog has no setters at all; Title and InitialDirectory are
	// exported fields.
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "dlgOpen", Type: "OpenFileDialog"})
	model, src := mustApply(t, path,
		Op{Op: "setProp", ID: "dlgOpen", Prop: "title", Value: "Choose a report"})

	if got := findControl(t, model, "dlgOpen").Props["title"]; got != "Choose a report" {
		t.Errorf("title = %q", got)
	}
	if !strings.Contains(src, `mf.dlgOpen.Title = "Choose a report"`) {
		t.Errorf("the title was not written as a field assignment:\n%s", src)
	}

	// Editing it again must rewrite that assignment, not add a second one.
	_, src = mustApply(t, path, Op{Op: "setProp", ID: "dlgOpen", Prop: "title", Value: "Open"})
	if n := strings.Count(src, "dlgOpen.Title ="); n != 1 {
		t.Errorf("%d Title assignments, want 1:\n%s", n, src)
	}
}

func TestRemovingATrayComponentTakesItsWholeBlock(t *testing.T) {
	// Without an AddControl to close the block, the range comes from the
	// last statement that mentioned the component. If that is wrong, remove
	// leaves statements behind referring to a field that no longer exists -
	// which does not compile.
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "dlgSave", Type: "SaveFileDialog"})
	mustApply(t, path,
		Op{Op: "setProp", ID: "dlgSave", Prop: "title", Value: "Save"},
		Op{Op: "setProp", ID: "dlgSave", Prop: "defaultFileName", Value: "report.csv"})

	model, src := mustApply(t, path, Op{Op: "remove", ID: "dlgSave"})
	for _, c := range model.Controls {
		if c.ID == "dlgSave" {
			t.Fatal("the dialog is still in the model after remove")
		}
	}
	if strings.Contains(src, "dlgSave") {
		t.Errorf("remove left the dialog behind:\n%s", src)
	}
}

func TestTrayComponentsRoundTrip(t *testing.T) {
	// Everything the designer writes, it must be able to read back - all of
	// it, not just the constructor.
	path := writeFixture(t, designerFixture)
	mustApply(t, path,
		Op{Op: "add", ID: "tmrPoll", Type: "Timer"},
		Op{Op: "add", ID: "dlgOpen", Type: "OpenFileDialog"},
		Op{Op: "add", ID: "dlgColor", Type: "ColorDialog"},
	)
	model, _ := mustApply(t, path,
		Op{Op: "setProp", ID: "tmrPoll", Prop: "interval", Value: "500"},
		Op{Op: "setProp", ID: "tmrPoll", Prop: "enabled", Value: "true"},
		Op{Op: "setProp", ID: "dlgOpen", Prop: "initialDirectory", Value: "/tmp"},
		Op{Op: "setProp", ID: "dlgColor", Prop: "message", Value: "Pick one"},
	)

	tmr := findControl(t, model, "tmrPoll")
	if tmr.Props["interval"] != "500" || tmr.Props["enabled"] != "true" {
		t.Errorf("timer read back as %v", tmr.Props)
	}
	if got := findControl(t, model, "dlgOpen").Props["initialDirectory"]; got != "/tmp" {
		t.Errorf("initialDirectory = %q", got)
	}
	if got := findControl(t, model, "dlgColor").Props["message"]; got != "Pick one" {
		t.Errorf("message = %q", got)
	}
	// The visual control that was there all along is untouched.
	if lbl := findControl(t, model, "lblWelcome"); lbl.W != 300 {
		t.Errorf("the label's bounds changed: %v", lbl)
	}
}

func TestRenamingATrayComponentMovesEveryReference(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "tmrPoll", Type: "Timer"})
	mustApply(t, path, Op{Op: "setProp", ID: "tmrPoll", Prop: "enabled", Value: "true"})

	model, src := mustApply(t, path, Op{Op: "rename", ID: "tmrPoll", Value: "tmrRefresh"})
	findControl(t, model, "tmrRefresh")
	if strings.Contains(src, "tmrPoll") {
		t.Errorf("the old name survives somewhere:\n%s", src)
	}
	if !strings.Contains(src, "mf.tmrRefresh.Start()") {
		t.Errorf("the Start() call was not renamed:\n%s", src)
	}
}

func TestTrayComponentsHaveNoControlBaseProperties(t *testing.T) {
	// A Timer is not a ControlBase. Offering it an Anchor would generate
	// mf.tmr.SetAnchor(...), which does not compile.
	for _, typ := range []string{"Timer", "OpenFileDialog", "SaveFileDialog", "ColorDialog", "FolderBrowserDialog"} {
		desc := catalog[typ]
		if desc == nil {
			t.Fatalf("%s is not in the catalog", typ)
		}
		if !desc.NonVisual {
			t.Errorf("%s should be NonVisual", typ)
		}
		for _, prop := range []string{"anchor", "dock", "tabIndex", "tabStop"} {
			if _, ok := setterForProp(desc, prop); ok {
				t.Errorf("%s offers %q, which it does not have", typ, prop)
			}
		}
		for _, ev := range allEventsFor(desc) {
			if _, isBase := baseEvents[ev]; isBase {
				t.Errorf("%s offers the inherited event %q, which it does not have", typ, ev)
			}
		}
	}
}

func TestTidyCollapsesRepeatedFieldAssignments(t *testing.T) {
	// The designer shows one value per property, so the file must hold one.
	// A dialog's Title is an assignment, not a call, which is a shape the
	// cleanup pass could not see before the tray existed.
	const src = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	dlgOpen *goforms.OpenFileDialog
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.dlgOpen = goforms.NewOpenFileDialog()
	mf.dlgOpen.Title = "Old"
	mf.dlgOpen.Title = "New"
}
`
	path := writeFixture(t, src)
	res, err := tidyFile(path)
	if err != nil {
		t.Fatalf("tidy: %v", err)
	}
	if res.Statements != 1 {
		t.Errorf("removed %d statements, want 1: %v", res.Statements, res.Removed)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	out := string(b)
	if strings.Contains(out, `"Old"`) {
		t.Errorf("the stale assignment survived:\n%s", out)
	}
	if !strings.Contains(out, `"New"`) {
		t.Errorf("the live assignment was removed:\n%s", out)
	}
}

func TestHandWrittenTrayCodeIsRecognized(t *testing.T) {
	// The designer is not the only thing that writes these files. Code
	// someone typed must read back the same as code the designer generated,
	// or opening a hand-written form would show an empty tray and then
	// duplicate what is already there.
	const src = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	tmrPoll *goforms.Timer
	dlgOpen *goforms.OpenFileDialog
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.tmrPoll = goforms.NewTimer(2500)
	mf.tmrPoll.Tick.Handle(mf.tmrPoll_Tick)
	mf.tmrPoll.Start()

	mf.dlgOpen = goforms.NewOpenFileDialog()
	mf.dlgOpen.Title = "Open"
	mf.dlgOpen.InitialDirectory = "/home"
}
`
	path := writeFixture(t, src)
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	tmr := findControl(t, r.model, "tmrPoll")
	if tmr.Props["interval"] != "2500" {
		t.Errorf("interval = %q, want 2500", tmr.Props["interval"])
	}
	if tmr.Props["enabled"] != "true" {
		t.Errorf("enabled = %q, want true - Start() is there", tmr.Props["enabled"])
	}
	if tmr.Events["Tick"] != "tmrPoll_Tick" {
		t.Errorf("Tick handler = %q", tmr.Events["Tick"])
	}

	dlg := findControl(t, r.model, "dlgOpen")
	if dlg.Props["title"] != "Open" || dlg.Props["initialDirectory"] != "/home" {
		t.Errorf("dialog read back as %v", dlg.Props)
	}
}
