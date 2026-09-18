package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pairFixture writes both halves of a form and returns the designer file's
// path. The hand-written half uses the control it handles, which is the
// ordinary case and the one that used to break.
func pairFixture(t *testing.T, logic string) (designer, paired string) {
	t.Helper()
	dir := t.TempDir()
	designer = filepath.Join(dir, "MainForm-designer.go")
	paired = filepath.Join(dir, "MainForm.go")

	if err := os.WriteFile(designer, []byte(`package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	btnGreet *goforms.Button
	lblOut   *goforms.Label
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.btnGreet = goforms.NewButton("Greet")
	mf.btnGreet.SetBounds(20, 20, 90, 30)
	mf.btnGreet.Click.Handle(mf.btnGreet_Click)
	mf.AddControl(mf.btnGreet)

	mf.lblOut = goforms.NewLabel("")
	mf.lblOut.SetBounds(20, 60, 200, 24)
	mf.AddControl(mf.lblOut)
}
`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paired, []byte(logic), 0o644); err != nil {
		t.Fatal(err)
	}
	return designer, paired
}

// Renaming used to move the handler *method* and leave every reference to
// the field itself pointing at a name that no longer existed.
func TestRenameFixesFieldReferencesInPairedFile(t *testing.T) {
	designer, paired := pairFixture(t, `package mainform

import "goforms"

func (mf *MainForm) btnGreet_Click(_ goforms.EventArgs) {
	mf.lblOut.SetText("hello")
	mf.btnGreet.SetEnabled(false)
}
`)
	if _, err := applyOps(designer, []Op{{Op: "rename", ID: "btnGreet", Value: "btnHello"}}); err != nil {
		t.Fatalf("rename: %v", err)
	}

	got := readFile(t, paired)
	if strings.Contains(got, "btnGreet") {
		t.Errorf("the old name survives in the hand-written file:\n%s", got)
	}
	if !strings.Contains(got, "mf.btnHello.SetEnabled(false)") {
		t.Errorf("the field reference was not renamed:\n%s", got)
	}
	if !strings.Contains(got, "func (mf *MainForm) btnHello_Click") {
		t.Errorf("the handler method was not renamed:\n%s", got)
	}
	// An unrelated control is left alone.
	if !strings.Contains(got, "mf.lblOut.SetText") {
		t.Errorf("an unrelated field was touched:\n%s", got)
	}
}

// The receiver is named per method, so a file that spells it differently in
// different methods still has to be handled.
func TestRenameHandlesPerMethodReceivers(t *testing.T) {
	designer, paired := pairFixture(t, `package mainform

import "goforms"

func (mf *MainForm) btnGreet_Click(_ goforms.EventArgs) {
	mf.btnGreet.SetEnabled(false)
}

func (f *MainForm) Reset() {
	f.btnGreet.SetEnabled(true)
}

func (*MainForm) Unrelated() {}
`)
	if _, err := applyOps(designer, []Op{{Op: "rename", ID: "btnGreet", Value: "btnHello"}}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	got := readFile(t, paired)
	if strings.Contains(got, "btnGreet") {
		t.Errorf("a reference through a differently-named receiver was missed:\n%s", got)
	}
	if !strings.Contains(got, "f.btnHello.SetEnabled(true)") {
		t.Errorf("the second method was not updated:\n%s", got)
	}
}

// A local variable that merely shares the receiver's name in another type's
// method must not be rewritten.
func TestRenameLeavesOtherTypesAlone(t *testing.T) {
	designer, paired := pairFixture(t, `package mainform

import "goforms"

type Other struct{ btnGreet *goforms.Button }

func (o *Other) Use() {
	o.btnGreet.SetEnabled(false)
}

func (mf *MainForm) btnGreet_Click(_ goforms.EventArgs) {}
`)
	if _, err := applyOps(designer, []Op{{Op: "rename", ID: "btnGreet", Value: "btnHello"}}); err != nil {
		t.Fatalf("rename: %v", err)
	}
	got := readFile(t, paired)
	if !strings.Contains(got, "o.btnGreet.SetEnabled(false)") {
		t.Errorf("another type's field of the same name was renamed:\n%s", got)
	}
	if !strings.Contains(got, "btnHello_Click") {
		t.Errorf("the handler method was not renamed:\n%s", got)
	}
}

// Renaming before any handler exists is normal and must not fail.
func TestRenameWithoutAPairedFile(t *testing.T) {
	path := writeFixture(t, slotFixture)
	if _, err := applyOps(path, []Op{{Op: "rename", ID: "btnLeft", Value: "btnMoved"}}); err != nil {
		t.Fatalf("rename with no counterpart file should be fine, got: %v", err)
	}
}

// --- names that would hide a member of the form -------------------------

func TestRenameRefusesToShadowAFormMember(t *testing.T) {
	for _, name := range []string{"AddControl", "Close", "Text", "Load", "Click", "SetBounds"} {
		path := writeFixture(t, slotFixture)
		before := readFile(t, path)
		_, err := applyOps(path, []Op{{Op: "rename", ID: "btnLeft", Value: name}})
		if err == nil {
			t.Errorf("renaming a control to %q was allowed; it hides the form's own member", name)
			continue
		}
		if !strings.Contains(err.Error(), "form") {
			t.Errorf("the error for %q should say why: %v", name, err)
		}
		if after := readFile(t, path); after != before {
			t.Errorf("the refused rename of %q still changed the file", name)
		}
	}
}

func TestAddRefusesBadNames(t *testing.T) {
	for _, name := range []string{"AddControl", "for", "my-btn", "1btn", ""} {
		path := writeFixture(t, slotFixture)
		before := readFile(t, path)
		if _, err := applyOps(path, []Op{{
			Op: "add", ID: name, Type: "Button", W: 90, H: 30, Text: "x",
		}}); err == nil {
			t.Errorf("adding a control named %q was allowed", name)
		}
		if after := readFile(t, path); after != before {
			t.Errorf("the refused add of %q still changed the file", name)
		}
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
