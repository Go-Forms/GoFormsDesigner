package main

import (
	"os"
	"strings"
	"testing"
)

// orderFixture is the shape a form takes when the controls were dropped first
// and the container second: btnOne/btnTwo are constructed above where any
// container will land.
const orderFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	btnOne *goforms.Button
	btnTwo *goforms.Button
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.btnOne = goforms.NewButton("One")
	mf.btnOne.SetBounds(20, 20, 90, 30)
	mf.AddControl(mf.btnOne)

	mf.btnTwo = goforms.NewButton("Two")
	mf.btnTwo.SetBounds(20, 60, 90, 30)
	mf.AddControl(mf.btnTwo)
}
`

// indexOfLine is the byte offset of a statement in the generated file, for
// asserting that one block really does come before another.
func indexOfLine(t *testing.T, src, want string) int {
	t.Helper()
	i := strings.Index(src, want)
	if i < 0 {
		t.Fatalf("expected %q in:\n%s", want, src)
	}
	return i
}

// Dropping a GroupBox after the buttons and then dragging the buttons into it
// used to emit `mf.grp.AddControl(mf.btnOne)` above the line that constructs
// mf.grp - a nil dereference the moment the form loads.
func TestSetParentMovesBlockBelowParent(t *testing.T) {
	path := writeFixture(t, orderFixture)
	mustApply(t, path, Op{
		Op: "add", ID: "grpBox", Type: "GroupBox", X: 10, Y: 10, W: 300, H: 200, Text: "Group",
	})
	_, src := mustApply(t, path,
		Op{Op: "setParent", ID: "btnOne", Parent: "grpBox"},
		Op{Op: "setBounds", ID: "btnOne", X: 10, Y: 25, W: 90, H: 30},
	)

	ctor := indexOfLine(t, src, "mf.grpBox = goforms.NewGroupBox")
	add := indexOfLine(t, src, "mf.grpBox.AddControl(mf.btnOne)")
	if add < ctor {
		t.Errorf("child is parented before its container exists (nil at runtime):\n%s", src)
	}
}

// Everything a moved block carries - its setters, its event wiring, its own
// children - has to come with it, and the whole file still has to read as one
// block per control.
func TestSetParentMovesWholeBlock(t *testing.T) {
	path := writeFixture(t, orderFixture)
	mustApply(t, path, Op{
		Op: "add", ID: "grpBox", Type: "GroupBox", X: 10, Y: 10, W: 300, H: 200, Text: "Group",
	})
	_, src := mustApply(t, path,
		Op{Op: "setEvent", ID: "btnOne", Event: "Click", Handler: "onOne"},
		Op{Op: "setParent", ID: "btnOne", Parent: "grpBox"},
		Op{Op: "setParent", ID: "btnTwo", Parent: "grpBox"},
	)

	want := []string{
		"mf.grpBox = goforms.NewGroupBox",
		"mf.btnOne = goforms.NewButton",
		"mf.btnOne.Click.Handle(mf.onOne)",
		"mf.grpBox.AddControl(mf.btnOne)",
		"mf.btnTwo = goforms.NewButton",
		"mf.grpBox.AddControl(mf.btnTwo)",
	}
	at := -1
	for _, line := range want {
		next := indexOfLine(t, src, line)
		if next < at {
			t.Fatalf("%q is out of order:\n%s", line, src)
		}
		at = next
	}
}

// The same thing one level down: a Panel dropped last and then dragged into a
// GroupBox has to take the controls standing on it along.
func TestSetParentMovesNestedSubtree(t *testing.T) {
	path := writeFixture(t, orderFixture)
	mustApply(t, path,
		Op{Op: "add", ID: "pnlInner", Type: "Panel", X: 5, Y: 5, W: 150, H: 100},
		Op{Op: "add", ID: "btnDeep", Type: "Button", Parent: "pnlInner", X: 5, Y: 5, W: 90, H: 30, Text: "Deep"},
		Op{Op: "add", ID: "grpBox", Type: "GroupBox", X: 10, Y: 10, W: 300, H: 200, Text: "Group"},
	)
	_, src := mustApply(t, path, Op{Op: "setParent", ID: "pnlInner", Parent: "grpBox"})

	grp := indexOfLine(t, src, "mf.grpBox = goforms.NewGroupBox")
	pnl := indexOfLine(t, src, "mf.pnlInner = goforms.NewPanel")
	deep := indexOfLine(t, src, "mf.pnlInner.AddControl(mf.btnDeep)")
	if !(grp < pnl && pnl < deep) {
		t.Errorf("subtree did not follow its new container:\n%s", src)
	}
}

// The pass must be invisible when the file is already in order: a designer
// that reshuffles blocks on every unrelated edit makes its own diffs
// unreadable.
func TestReorderLeavesOrderedFileAlone(t *testing.T) {
	path := writeFixture(t, slotFixture)
	before, _ := os.ReadFile(path)
	mustApply(t, path, Op{Op: "setBounds", ID: "btnLeft", X: 12, Y: 12, W: 90, H: 30})
	after, _ := os.ReadFile(path)

	if strings.Count(string(before), "\n") != strings.Count(string(after), "\n") {
		t.Errorf("an ordered file gained or lost lines:\n%s", after)
	}
	for _, id := range []string{"splitMain", "pnlSide", "btnLeft"} {
		if indexOfLine(t, string(before), "mf."+id+" = ") != indexOfLine(t, string(after), "mf."+id+" = ") {
			t.Errorf("block %q moved for no reason:\n%s", id, after)
		}
	}
}

// tidy is the only command that reaches a file the designer never wrote, so a
// form already broken this way - by an older release, or by hand - is fixed
// there rather than only on the next edit.
func TestTidyRepairsOrder(t *testing.T) {
	path := writeFixture(t, brokenOrderFixture)
	res, err := tidyFile(path)
	if err != nil {
		t.Fatalf("tidy: %v", err)
	}
	if res.Moved == 0 {
		t.Error("tidy did not report moving anything")
	}
	src := readBack(t, path)
	if indexOfLine(t, src, "mf.grpBox = goforms.NewGroupBox") > indexOfLine(t, src, "mf.grpBox.AddControl(mf.btnOne)") {
		t.Errorf("tidy left the child above its container:\n%s", src)
	}
}

// brokenOrderFixture is what the designer used to write: btnOne is added to a
// GroupBox that is constructed further down.
const brokenOrderFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	btnOne *goforms.Button
	grpBox *goforms.GroupBox
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.btnOne = goforms.NewButton("One")
	mf.btnOne.SetBounds(20, 20, 90, 30)
	mf.grpBox.AddControl(mf.btnOne)

	mf.grpBox = goforms.NewGroupBox("Group", 300, 200)
	mf.grpBox.SetBounds(10, 10, 300, 200)
	mf.AddControl(mf.grpBox)
}
`

// A hand-written statement the tool does not model stays where it is, so a
// block that would have to hop over one that names it is left alone rather
// than moved into a line that no longer reaches it.
func TestReorderKeepsUnmodelledStatementsSafe(t *testing.T) {
	path := writeFixture(t, pinnedFixture)
	before := readBack(t, path)
	if _, err := reorderFile(path); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if after := readBack(t, path); after != before {
		t.Errorf("reorder moved a block past the statement pinning it:\n%s", after)
	}
}

// pinnedFixture has rbOne wired into a hand-written radio group between the
// two blocks: moving rbOne below grpBox would put mf.optGroup.Add(mf.rbOne)
// above the line that creates mf.rbOne.
const pinnedFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	rbOne    *goforms.RadioButton
	grpBox   *goforms.GroupBox
	optGroup *goforms.RadioButtonGroup
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.rbOne = goforms.NewRadioButton("One")
	mf.rbOne.SetBounds(20, 20, 90, 30)
	mf.grpBox.AddControl(mf.rbOne)

	mf.optGroup = goforms.NewRadioButtonGroup()
	mf.optGroup.Add(mf.rbOne)

	mf.grpBox = goforms.NewGroupBox("Group", 300, 200)
	mf.grpBox.SetBounds(10, 10, 300, 200)
	mf.AddControl(mf.grpBox)
}
`

func readBack(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	return string(b)
}
