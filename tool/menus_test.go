package main

import (
	"strings"
	"testing"
)

func TestAMenuStripIsOneExpressionAndTheFormsMenu(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "menuStrip1", Type: "MenuStrip", Collection: []CollectionItem{
			{Text: "File"},
			{Text: "Open...", Depth: 1, Handler: "mnuOpen_Click"},
			{Text: "Recent", Depth: 1},
			{Text: "a.txt", Depth: 2},
			{Kind: "separator", Depth: 1},
			{Text: "Exit", Depth: 1, Disabled: true},
			{Text: "Help"},
		}},
	)
	for _, want := range []string{
		"mf.menuStrip1 = goforms.NewMenuStrip(",
		`goforms.NewTopMenu("File",`,
		`goforms.NewMenuItem("Open...").OnClick(mf.mnuOpen_Click),`,
		`goforms.NewMenuItem("Recent").Add(`,
		"goforms.NewMenuSeparator(),",
		`goforms.NewMenuItem("Exit").SetEnabled(false),`,
		`goforms.NewTopMenu("Help"),`,
		"mf.SetMainMenu(mf.menuStrip1)",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("want %s in\n%s", want, src)
		}
	}
	m := findControl(t, model, "menuStrip1")
	if m.CollectionReadOnly || len(m.Collection) != 7 {
		t.Fatalf("read back %+v", m.Collection)
	}
	if m.Collection[3] != (CollectionItem{Text: "a.txt", Depth: 2}) || m.Collection[5] != (CollectionItem{Text: "Exit", Depth: 1, Disabled: true}) {
		t.Errorf("items %+v", m.Collection)
	}

	// Rewriting the list rewrites the constructor, and nothing else.
	_, src = mustApply(t, path, Op{Op: "setCollection", ID: "menuStrip1", Collection: []CollectionItem{{Text: "Edit"}, {Text: "Copy", Depth: 1}}})
	if strings.Contains(src, "File") || !strings.Contains(src, `goforms.NewTopMenu("Edit",`) || strings.Count(src, "SetMainMenu") != 1 {
		t.Errorf("rewrite:\n%s", src)
	}

	// Deleting it takes SetMainMenu with it.
	_, src = mustApply(t, path, Op{Op: "remove", ID: "menuStrip1"})
	if strings.Contains(src, "SetMainMenu") || strings.Contains(src, "NewMenuStrip") {
		t.Errorf("remove left:\n%s", src)
	}
}

func TestAMenuBarRefusesASeparatorOnTheBar(t *testing.T) {
	path := writeFixture(t, designerFixture)
	if _, err := applyOps(path, []Op{{Op: "add", ID: "m", Type: "MenuStrip", Collection: []CollectionItem{{Kind: "separator"}}}}); err == nil {
		t.Fatal("a separator on the menu bar itself was written")
	}
}

func TestAContextMenuIsAttachedToAControl(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "cmsLabel", Type: "ContextMenu", Collection: []CollectionItem{{Text: "Copy", Handler: "mnuCopy_Click"}}},
		Op{Op: "setProp", ID: "lblWelcome", Prop: "contextMenu", Value: "cmsLabel"},
	)
	if !strings.Contains(src, "mf.lblWelcome.SetContextMenu(mf.cmsLabel)") {
		t.Fatalf("not attached:\n%s", src)
	}
	if findControl(t, model, "lblWelcome").Props["contextMenu"] != "cmsLabel" {
		t.Errorf("contextMenu reads %q", findControl(t, model, "lblWelcome").Props["contextMenu"])
	}
	// The menu, added after the label, is moved above it: the label's block
	// names it.
	if indexOfLine(t, src, "mf.cmsLabel = goforms.NewContextMenu(") > indexOfLine(t, src, "mf.lblWelcome.SetContextMenu(mf.cmsLabel)") {
		t.Errorf("the menu is made after the line that uses it:\n%s", src)
	}
	// A reference to something that is not a ContextMenu is refused.
	if _, err := applyOps(path, []Op{{Op: "setProp", ID: "lblWelcome", Prop: "contextMenu", Value: "lblWelcome"}}); err == nil {
		t.Error("attached a label as a context menu")
	}
	// Deleting the menu takes the attachment with it.
	_, src = mustApply(t, path, Op{Op: "remove", ID: "cmsLabel"})
	if strings.Contains(src, "SetContextMenu") {
		t.Errorf("a dangling SetContextMenu survived:\n%s", src)
	}
}

func TestAMenuWrittenByHandIsReadOnlyWhenItCannotBeRead(t *testing.T) {
	src := strings.Replace(designerFixture, "\tlblWelcome *goforms.Label\n", "\tlblWelcome *goforms.Label\n\tcms        *goforms.ContextMenu\n", 1)
	src = strings.Replace(src, "func (mf *MainForm) initializeComponent() {\n", "func (mf *MainForm) initializeComponent() {\n\tmf.cms = goforms.NewContextMenu(items()...)\n", 1)
	path := writeFixture(t, src)
	r, err := parseFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if c := findControl(t, r.model, "cms"); !c.CollectionReadOnly {
		t.Errorf("a menu built from code was taken as editable")
	}
}
