package main

import (
	"strings"
	"testing"
)

// The Form is addressed by an empty ID, the way "setForm" already addresses
// it: it is not a control and has no name to give.

func TestFormPropIsWrittenAndReadBack(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path, Op{Op: "setProp", Prop: "fixedSize", Value: "true"})

	if !strings.Contains(src, "mf.SetFixedSize(true)") {
		t.Errorf("the setter was not written:\n%s", src)
	}
	if got := model.FormProps["fixedSize"]; got != "true" {
		t.Errorf("fixedSize read back as %q, want \"true\"", got)
	}
}

// Setting it again rewrites the argument rather than appending a second call,
// so the file never holds two answers for one property.
func TestFormPropRewritesInPlace(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path, Op{Op: "setProp", Prop: "fixedSize", Value: "true"})
	model, src := mustApply(t, path, Op{Op: "setProp", Prop: "fixedSize", Value: "false"})

	if got := strings.Count(src, "SetFixedSize"); got != 1 {
		t.Errorf("SetFixedSize appears %d times, want 1:\n%s", got, src)
	}
	if got := model.FormProps["fixedSize"]; got != "false" {
		t.Errorf("fixedSize read back as %q, want \"false\"", got)
	}
}

// CenterOnScreen takes no argument, so the bool is the presence of the line.
func TestFormCallPropTogglesTheLine(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path, Op{Op: "setProp", Prop: "centerOnScreen", Value: "true"})
	if !strings.Contains(src, "mf.CenterOnScreen()") {
		t.Errorf("the call was not written:\n%s", src)
	}
	if model.FormProps["centerOnScreen"] != "true" {
		t.Errorf("centerOnScreen did not read back: %+v", model.FormProps)
	}

	model, src = mustApply(t, path, Op{Op: "setProp", Prop: "centerOnScreen", Value: "false"})
	if strings.Contains(src, "CenterOnScreen") {
		t.Errorf("turning it off should delete the line:\n%s", src)
	}
	if _, still := model.FormProps["centerOnScreen"]; still {
		t.Errorf("centerOnScreen is still set: %+v", model.FormProps)
	}
}

// The form's settings belong above the controls: a Load handler wired after
// half the form is built is a different thing from one wired before it.
func TestFormStatementsGoAboveTheControls(t *testing.T) {
	path := writeFixture(t, slotFixture)
	_, src := mustApply(t, path,
		Op{Op: "setProp", Prop: "fixedSize", Value: "true"},
		Op{Op: "setEvent", Event: "Load", Handler: "MainForm_Load"},
	)
	firstControl := strings.Index(src, "mf.splitMain = ")
	for _, line := range []string{"mf.SetFixedSize(true)", "mf.Load.Handle(mf.MainForm_Load)"} {
		at := strings.Index(src, line)
		if at < 0 {
			t.Fatalf("missing %q in:\n%s", line, src)
		}
		if at > firstControl {
			t.Errorf("%q was written below the first control:\n%s", line, src)
		}
	}
}

func TestFormEventIsWiredAndReadBack(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path, Op{Op: "setEvent", Event: "Closing", Handler: "MainForm_Closing"})

	if !strings.Contains(src, "mf.Closing.Handle(mf.MainForm_Closing)") {
		t.Errorf("the event was not wired:\n%s", src)
	}
	if got := model.FormEvents["Closing"]; got != "MainForm_Closing" {
		t.Errorf("Closing read back as %q", got)
	}
}

// Event.Handle is multicast, so re-wiring has to rewrite the line rather than
// stack a second one - or one close would run two handlers.
func TestFormEventRewiresInPlace(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path, Op{Op: "setEvent", Event: "Load", Handler: "first"})
	model, src := mustApply(t, path, Op{Op: "setEvent", Event: "Load", Handler: "second"})

	if got := strings.Count(src, "mf.Load.Handle"); got != 1 {
		t.Errorf("Load is wired %d times, want 1:\n%s", got, src)
	}
	if got := model.FormEvents["Load"]; got != "second" {
		t.Errorf("Load read back as %q, want \"second\"", got)
	}
}

// A control's events and the form's are different events; wiring one must not
// be read back as the other.
func TestFormEventsAreNotControlEvents(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, _ := mustApply(t, path, Op{Op: "setEvent", Event: "Click", Handler: "MainForm_Click"})

	if got := model.FormEvents["Click"]; got != "MainForm_Click" {
		t.Errorf("the form's Click read back as %q", got)
	}
	if btn := controlByID(model, "btnLeft"); btn != nil && btn.Events["Click"] == "MainForm_Click" {
		t.Error("the form's Click landed on a control")
	}
}

func TestFormRejectsUnknownPropsAndEvents(t *testing.T) {
	path := writeFixture(t, slotFixture)
	before := readFile(t, path)
	if _, err := applyOps(path, []Op{{Op: "setProp", Prop: "nosuch", Value: "1"}}); err == nil {
		t.Error("an unknown form property should be refused")
	}
	if _, err := applyOps(path, []Op{{Op: "setEvent", Event: "NoSuch", Handler: "x"}}); err == nil {
		t.Error("an unknown form event should be refused")
	}
	if readFile(t, path) != before {
		t.Error("a refused form op still changed the file")
	}
}

// A hand-written file's own settings are found, not just ones the designer
// wrote itself.
func TestFormPropsAreReadFromAHandWrittenFile(t *testing.T) {
	path := writeFixture(t, strings.Replace(slotFixture,
		"\tmf.SetClientSize(800, 600)",
		"\tmf.SetClientSize(800, 600)\n\tmf.SetFixedSize(true)\n\tmf.CenterOnScreen()\n\tmf.Load.Handle(mf.onLoad)", 1))

	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if r.model.FormProps["fixedSize"] != "true" {
		t.Errorf("fixedSize not found: %+v", r.model.FormProps)
	}
	if r.model.FormProps["centerOnScreen"] != "true" {
		t.Errorf("centerOnScreen not found: %+v", r.model.FormProps)
	}
	if r.model.FormEvents["Load"] != "onLoad" {
		t.Errorf("Load not found: %+v", r.model.FormEvents)
	}
	// And the controls are still there - the new cases must not swallow
	// mf.AddControl, which is also a one-argument call on the receiver.
	if len(r.model.Controls) != 3 {
		t.Errorf("got %d controls, want 3", len(r.model.Controls))
	}
}

// The Form is served with the catalog but is not a palette entry.
func TestFormDescIsNotInTheToolbox(t *testing.T) {
	if _, ok := catalog["Form"]; ok {
		t.Error("the Form must not be in the catalog, or it appears in the toolbox")
	}
	if _, ok := eventArgType(formDesc, "Closing"); !ok {
		t.Error("the form descriptor has no Closing event")
	}
	if got, _ := eventArgType(formDesc, "Closing"); got != "*CancelEventArgs" {
		t.Errorf("Closing's argument = %q, want *CancelEventArgs - a handler has to be able to say no", got)
	}
}
