package main

import (
	"os"
	"strings"
	"testing"
)

// slotFixture parents a control onto one half of a SplitContainer, the form
// parse.go has to recognize through the accessor call in the middle of the
// chain.
const slotFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	splitMain *goforms.SplitContainer
	pnlSide   *goforms.Panel
	btnLeft   *goforms.Button
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.splitMain = goforms.NewSplitContainer(400, 250, true)
	mf.splitMain.SetBounds(10, 10, 400, 250)
	mf.AddControl(mf.splitMain)

	mf.pnlSide = goforms.NewPanel(200, 150)
	mf.pnlSide.SetBounds(430, 10, 200, 150)
	mf.AddControl(mf.pnlSide)

	mf.btnLeft = goforms.NewButton("Left")
	mf.btnLeft.SetBounds(8, 8, 90, 30)
	mf.btnLeft.Click.Handle(mf.btnLeft_Click)
	mf.splitMain.Panel1().AddControl(mf.btnLeft)
}
`

func TestParseSlotParent(t *testing.T) {
	path := writeFixture(t, slotFixture)
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	btn := controlByID(r.model, "btnLeft")
	if btn == nil {
		t.Fatal("btnLeft missing from model - the slot AddControl was not recognized")
	}
	if btn.Parent != "splitMain" || btn.ParentSlot != "Panel1" {
		t.Errorf("parent/slot = %q/%q, want splitMain/Panel1", btn.Parent, btn.ParentSlot)
	}
}

func TestAddIntoSlot(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path, Op{
		Op: "add", ID: "btnRight", Type: "Button", Parent: "splitMain", ParentSlot: "Panel2",
		X: 5, Y: 5, W: 90, H: 30, Text: "Right",
	})

	if !strings.Contains(src, "mf.splitMain.Panel2().AddControl(mf.btnRight)") {
		t.Errorf("slot AddControl not generated:\n%s", src)
	}
	got := controlByID(model, "btnRight")
	if got == nil || got.Parent != "splitMain" || got.ParentSlot != "Panel2" {
		t.Errorf("added control = %+v, want parent splitMain slot Panel2", got)
	}
}

// A SplitContainer has no AddControl of its own, so parenting straight onto
// it would generate code that doesn't compile.
func TestAddOntoSlotContainerWithoutSlotFails(t *testing.T) {
	path := writeFixture(t, slotFixture)
	_, err := applyOps(path, []Op{{
		Op: "add", ID: "btnNope", Type: "Button", Parent: "splitMain", W: 90, H: 30,
	}})
	if err == nil {
		t.Fatal("parenting onto a SplitContainer without naming a half should fail")
	}
	if !strings.Contains(err.Error(), "Panel1") {
		t.Errorf("error should name the available slots, got: %v", err)
	}
}

func TestAddIntoUnknownSlotFails(t *testing.T) {
	path := writeFixture(t, slotFixture)
	if _, err := applyOps(path, []Op{{
		Op: "add", ID: "btnNope", Type: "Button", Parent: "splitMain", ParentSlot: "Panel9", W: 90, H: 30,
	}}); err == nil {
		t.Fatal("an unknown slot should be refused")
	}
	// A plain container has no slots to name either.
	if _, err := applyOps(path, []Op{{
		Op: "add", ID: "btnNope", Type: "Button", Parent: "pnlSide", ParentSlot: "Panel1", W: 90, H: 30,
	}}); err == nil {
		t.Fatal("naming a slot on a slotless container should be refused")
	}
}

// Moving a control must keep everything it already has - remove-then-add
// would quietly drop its event wiring.
func TestSetParentKeepsWiring(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path,
		Op{Op: "setParent", ID: "btnLeft", Parent: "splitMain", ParentSlot: "Panel2"},
		Op{Op: "setBounds", ID: "btnLeft", X: 12, Y: 12, W: 90, H: 30},
	)

	btn := controlByID(model, "btnLeft")
	if btn.Parent != "splitMain" || btn.ParentSlot != "Panel2" {
		t.Errorf("parent/slot = %q/%q, want splitMain/Panel2\n%s", btn.Parent, btn.ParentSlot, src)
	}
	if btn.Events["Click"] != "btnLeft_Click" {
		t.Errorf("Click wiring lost by the move: %+v\n%s", btn.Events, src)
	}
	if btn.X != 12 || btn.Y != 12 {
		t.Errorf("bounds = %v,%v want 12,12", btn.X, btn.Y)
	}
	if strings.Contains(src, "Panel1().AddControl") {
		t.Errorf("old parenting line left behind:\n%s", src)
	}
}

func TestSetParentOutToForm(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path, Op{Op: "setParent", ID: "btnLeft", Parent: ""})

	btn := controlByID(model, "btnLeft")
	if btn.Parent != "" || btn.ParentSlot != "" {
		t.Errorf("parent/slot = %q/%q, want the Form\n%s", btn.Parent, btn.ParentSlot, src)
	}
	if !strings.Contains(src, "mf.AddControl(mf.btnLeft)") {
		t.Errorf("form-level AddControl not generated:\n%s", src)
	}
}

func TestSetParentIntoPlainContainer(t *testing.T) {
	path := writeFixture(t, slotFixture)
	_, src := mustApply(t, path, Op{Op: "setParent", ID: "btnLeft", Parent: "pnlSide"})
	if !strings.Contains(src, "mf.pnlSide.AddControl(mf.btnLeft)") {
		t.Errorf("container AddControl not generated:\n%s", src)
	}
}

// A container moved into its own descendant would take the whole subtree off
// the form, and nothing downstream would notice.
func TestSetParentRefusesCycle(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path, Op{
		Op: "add", ID: "pnlInner", Type: "Panel", Parent: "pnlSide", X: 5, Y: 5, W: 100, H: 80,
	})

	before, _ := os.ReadFile(path)
	if _, err := applyOps(path, []Op{{Op: "setParent", ID: "pnlSide", Parent: "pnlInner"}}); err == nil {
		t.Fatal("moving a container into its own child should fail")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("refused setParent still modified the file")
	}
}

// A child parented through a slot still has to be removable: its block ends
// at the slot AddControl line, not the plain one.
func TestRemoveSlotChild(t *testing.T) {
	path := writeFixture(t, slotFixture)
	_, src := mustApply(t, path, Op{Op: "remove", ID: "btnLeft"})
	if strings.Contains(src, "btnLeft") {
		t.Errorf("removed control left references behind:\n%s", src)
	}
	if !strings.Contains(src, "mf.splitMain") {
		t.Errorf("removing the child took the SplitContainer with it:\n%s", src)
	}
}

// An accessor that isn't a declared slot must not be mistaken for one - the
// control is then simply not part of the recognized form, which is the same
// outcome as any other unrecognized setup code.
func TestUnknownAccessorIsNotASlot(t *testing.T) {
	src := strings.Replace(slotFixture, "mf.splitMain.Panel1().AddControl(mf.btnLeft)",
		"mf.splitMain.Somewhere().AddControl(mf.btnLeft)", 1)
	path := writeFixture(t, src)
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if btn := controlByID(r.model, "btnLeft"); btn != nil {
		t.Errorf("btnLeft = %+v, want it left out rather than parented to a made-up slot", btn)
	}
}

// pageFixture puts a control on the second tab of a TabControl, addressed by
// index rather than through a local variable.
const pageFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	tabsMain *goforms.TabControl
	btnOnTab *goforms.Button
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.tabsMain = goforms.NewTabControl(400, 300)
	mf.tabsMain.SetBounds(10, 10, 400, 300)
	mf.tabsMain.AddTab("General")
	mf.tabsMain.AddTab("Advanced")
	mf.AddControl(mf.tabsMain)

	mf.btnOnTab = goforms.NewButton("On tab 2")
	mf.btnOnTab.SetBounds(12, 12, 90, 30)
	mf.tabsMain.TabPages()[1].AddControl(mf.btnOnTab)
}
`

func TestParsePageSlot(t *testing.T) {
	path := writeFixture(t, pageFixture)
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	btn := controlByID(r.model, "btnOnTab")
	if btn == nil {
		t.Fatal("btnOnTab missing - the indexed page AddControl was not recognized")
	}
	if btn.Parent != "tabsMain" || btn.ParentSlot != "Tab2" {
		t.Errorf("parent/slot = %q/%q, want tabsMain/Tab2", btn.Parent, btn.ParentSlot)
	}
}

func TestAddOntoPage(t *testing.T) {
	path := writeFixture(t, pageFixture)
	model, src := mustApply(t, path, Op{
		Op: "add", ID: "lblFirst", Type: "Label", Parent: "tabsMain", ParentSlot: "Tab1",
		X: 5, Y: 5, W: 120, H: 24, Text: "First",
	})
	if !strings.Contains(src, "mf.tabsMain.TabPages()[0].AddControl(mf.lblFirst)") {
		t.Errorf("indexed page AddControl not generated:\n%s", src)
	}
	if got := controlByID(model, "lblFirst"); got.ParentSlot != "Tab1" {
		t.Errorf("slot = %q, want Tab1", got.ParentSlot)
	}
}

// A TabControl has no AddControl of its own - this is what used to generate
// code that didn't compile.
func TestAddOntoTabControlDirectlyFails(t *testing.T) {
	path := writeFixture(t, pageFixture)
	if _, err := applyOps(path, []Op{{
		Op: "add", ID: "btnNope", Type: "Button", Parent: "tabsMain", W: 90, H: 30,
	}}); err == nil {
		t.Fatal("parenting straight onto a TabControl should fail")
	}
}

// With no pages there is genuinely nowhere to put a control, and the error
// should say that rather than complain about an unknown slot.
func TestAddOntoPagelessContainerFails(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "viewsMain", Type: "ViewContainer", X: 10, Y: 10, W: 300, H: 200})
	mustApply(t, path, Op{Op: "setCollection", ID: "viewsMain", Collection: nil})

	_, err := applyOps(path, []Op{{
		Op: "add", ID: "btnNope", Type: "Button", Parent: "viewsMain", ParentSlot: "Page1", W: 90, H: 30,
	}})
	if err == nil {
		t.Fatal("adding onto a ViewContainer with no pages should fail")
	}
	if !strings.Contains(err.Error(), "pages") {
		t.Errorf("error should mention the missing pages, got: %v", err)
	}
}

// Deleting a page that still has controls on it would leave them pointing at
// an index that no longer exists - a runtime panic, so it is refused.
func TestSetCollectionRefusesDroppingOccupiedPage(t *testing.T) {
	path := writeFixture(t, pageFixture)
	before, _ := os.ReadFile(path)
	_, err := applyOps(path, []Op{{
		Op: "setCollection", ID: "tabsMain", Collection: []CollectionItem{{Text: "General"}},
	}})
	if err == nil {
		t.Fatal("dropping a page that still holds controls should fail")
	}
	if !strings.Contains(err.Error(), "Tab2") {
		t.Errorf("error should name the page, got: %v", err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("refused setCollection still modified the file")
	}
}

// Renaming pages leaves the controls on them alone: a page is identified by
// its position, not its caption.
func TestSetCollectionRenamesPagesKeepingChildren(t *testing.T) {
	path := writeFixture(t, pageFixture)
	model, src := mustApply(t, path, Op{
		Op: "setCollection", ID: "tabsMain",
		Collection: []CollectionItem{{Text: "Basics"}, {Text: "Expert"}, {Text: "Extra"}},
	})
	btn := controlByID(model, "btnOnTab")
	if btn == nil || btn.ParentSlot != "Tab2" {
		t.Fatalf("child lost its page: %+v\n%s", btn, src)
	}
	if !strings.Contains(src, `mf.tabsMain.AddTab("Expert")`) {
		t.Errorf("renamed tab not written:\n%s", src)
	}
	if !strings.Contains(src, "mf.tabsMain.TabPages()[1].AddControl(mf.btnOnTab)") {
		t.Errorf("child's page reference was disturbed:\n%s", src)
	}
}

func TestSetParentOntoPage(t *testing.T) {
	path := writeFixture(t, pageFixture)
	_, src := mustApply(t, path,
		Op{Op: "setParent", ID: "btnOnTab", Parent: "tabsMain", ParentSlot: "Tab1"},
		Op{Op: "setBounds", ID: "btnOnTab", X: 4, Y: 4, W: 90, H: 30},
	)
	if !strings.Contains(src, "mf.tabsMain.TabPages()[0].AddControl(mf.btnOnTab)") {
		t.Errorf("move between pages not generated:\n%s", src)
	}
	if strings.Contains(src, "TabPages()[1]") {
		t.Errorf("old page reference left behind:\n%s", src)
	}
}

// The four properties every control inherits from ControlBase have to read
// back like any other. They did not: only the `catalog` command merged them
// in, so parse never recognised SetDock/SetAnchor/SetTabIndex/SetTabStop.
// The panel showed them unset however the file was written, every edit
// appended another call instead of replacing the existing one, and a docked
// control was reported as undocked - so the designer drew it in the wrong
// place entirely.
func TestInheritedPropsRoundTrip(t *testing.T) {
	src := strings.Replace(designerFixture,
		"\tmf.lblWelcome.SetBounds(20, 20, 300, 24)\n",
		"\tmf.lblWelcome.SetBounds(20, 20, 300, 24)\n"+
			"\tmf.lblWelcome.SetDock(goforms.DockLeft)\n"+
			"\tmf.lblWelcome.SetAnchor(goforms.AnchorTop | goforms.AnchorRight)\n"+
			"\tmf.lblWelcome.SetTabIndex(3)\n"+
			"\tmf.lblWelcome.SetTabStop(false)\n", 1)
	path := writeFixture(t, src)

	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := controlByID(r.model, "lblWelcome").Props
	for prop, want := range map[string]string{
		"dock":     "DockLeft",
		"anchor":   "AnchorTop,AnchorRight",
		"tabIndex": "3",
		"tabStop":  "false",
	} {
		if got[prop] != want {
			t.Errorf("props[%q] = %q, want %q", prop, got[prop], want)
		}
	}
}

// Changing an inherited property must rewrite the call that is there, not
// add a second one beside it.
func TestSetInheritedPropReplacesInPlace(t *testing.T) {
	src := strings.Replace(designerFixture,
		"\tmf.lblWelcome.SetBounds(20, 20, 300, 24)\n",
		"\tmf.lblWelcome.SetBounds(20, 20, 300, 24)\n\tmf.lblWelcome.SetDock(goforms.DockBottom)\n", 1)
	path := writeFixture(t, src)

	model, out := mustApply(t, path, Op{Op: "setProp", ID: "lblWelcome", Prop: "dock", Value: "DockLeft"})

	if n := strings.Count(out, "SetDock("); n != 1 {
		t.Errorf("file has %d SetDock calls, want 1:\n%s", n, out)
	}
	if !strings.Contains(out, "mf.lblWelcome.SetDock(goforms.DockLeft)") {
		t.Errorf("dock not updated:\n%s", out)
	}
	if got := controlByID(model, "lblWelcome").Props["dock"]; got != "DockLeft" {
		t.Errorf("model reports dock = %q, want DockLeft", got)
	}
}
