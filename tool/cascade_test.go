package main

import (
	"strings"
	"testing"
)

// Deleting a container used to leave its children calling AddControl on a
// field that had just been removed - a file that does not compile at all.
// media/designer.js has always assumed the tool cascades: it sends one
// remove for the container and filters the children out of the batch.
func TestRemoveTakesTheWholeSubtree(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path,
		Op{Op: "add", ID: "pnlInner", Type: "Panel", Parent: "pnlSide", X: 5, Y: 5, W: 120, H: 90},
		Op{Op: "add", ID: "btnDeep", Type: "Button", Parent: "pnlInner", X: 5, Y: 5, W: 90, H: 30, Text: "Deep"},
		Op{Op: "add", ID: "btnShallow", Type: "Button", Parent: "pnlSide", X: 5, Y: 100, W: 90, H: 30, Text: "Shallow"},
	)

	model, src := mustApply(t, path, Op{Op: "remove", ID: "pnlSide"})

	for _, gone := range []string{"pnlSide", "pnlInner", "btnDeep", "btnShallow"} {
		if strings.Contains(src, gone) {
			t.Errorf("%q survived the removal of its container:\n%s", gone, src)
		}
		if controlByID(model, gone) != nil {
			t.Errorf("%q is still in the model", gone)
		}
	}
	// Everything outside the subtree is untouched.
	for _, kept := range []string{"splitMain", "btnLeft"} {
		if controlByID(model, kept) == nil {
			t.Errorf("%q was taken along with an unrelated container:\n%s", kept, src)
		}
	}
}

// A control standing on a tab page is parented through an index into
// TabPages(), which is just as dangling once the tab control is gone.
func TestRemoveTakesControlsOffPages(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path,
		Op{Op: "add", ID: "tabsMain", Type: "TabControl", X: 10, Y: 300, W: 300, H: 200},
	)
	mustApply(t, path,
		Op{Op: "add", ID: "btnOnTab", Type: "Button", Parent: "tabsMain", ParentSlot: "Tab1", W: 90, H: 30, Text: "T"},
	)

	_, src := mustApply(t, path, Op{Op: "remove", ID: "tabsMain"})
	if strings.Contains(src, "btnOnTab") || strings.Contains(src, "tabsMain") {
		t.Errorf("a control on a removed tab control was left behind:\n%s", src)
	}
}

// A radio group's Add sits outside the button's block, so removing the
// button has to delete it by hand.
func TestRemoveDropsRadioGroupMembership(t *testing.T) {
	path := writeFixture(t, radioGroupFixture)
	_, src := mustApply(t, path, Op{Op: "remove", ID: "rbOne"})

	if strings.Contains(src, "rbOne") {
		t.Errorf("the group still names a field that no longer exists:\n%s", src)
	}
	// The group and the other member stay.
	if !strings.Contains(src, "mf.optGroup.Add(mf.rbTwo)") {
		t.Errorf("removing one member took the rest of the group with it:\n%s", src)
	}
}

const radioGroupFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	rbOne    *goforms.RadioButton
	rbTwo    *goforms.RadioButton
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
	mf.AddControl(mf.rbOne)

	mf.rbTwo = goforms.NewRadioButton("Two")
	mf.rbTwo.SetBounds(20, 60, 90, 30)
	mf.AddControl(mf.rbTwo)

	mf.optGroup = goforms.NewRadioButtonGroup()
	mf.optGroup.Add(mf.rbOne)
	mf.optGroup.Add(mf.rbTwo)
}
`

// Removing a leaf is still just that leaf.
func TestRemoveLeafTakesNothingElse(t *testing.T) {
	path := writeFixture(t, slotFixture)
	model, src := mustApply(t, path, Op{Op: "remove", ID: "btnLeft"})

	if strings.Contains(src, "btnLeft") {
		t.Errorf("the control was not removed:\n%s", src)
	}
	for _, kept := range []string{"splitMain", "pnlSide"} {
		if controlByID(model, kept) == nil {
			t.Errorf("removing a leaf took %q with it:\n%s", kept, src)
		}
	}
}

// The batch the designer actually sends when the user selects a container
// *and* something inside it and presses Delete: the child is filtered out,
// so the cascade must not then trip over it.
func TestRemoveContainerTwiceOverIsNotAnError(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path,
		Op{Op: "add", ID: "pnlInner", Type: "Panel", Parent: "pnlSide", X: 5, Y: 5, W: 120, H: 90},
	)
	// Both, in the order the webview would list them.
	_, src := mustApply(t, path,
		Op{Op: "remove", ID: "pnlSide"},
	)
	if strings.Contains(src, "pnlInner") {
		t.Errorf("the nested container survived:\n%s", src)
	}
}
