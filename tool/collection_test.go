package main

import (
	"os"
	"strings"
	"testing"
)

// collectionFixture has one control of each collection shape already set up
// by hand, in the exact call forms parse.go is expected to read back.
const collectionFixture = `package mainform

import "goforms"

type MainForm struct {
	*goforms.Form

	tsMain *goforms.ToolStrip
	tvTree *goforms.TreeView
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(800, 600)

	mf.tsMain = goforms.NewToolStrip()
	mf.tsMain.SetBounds(0, 0, 400, 34)
	mf.tsMain.AddButton("New", mf.tsMain_New)
	mf.tsMain.AddSeparator()
	mf.tsMain.AddButton("Open", nil)
	mf.AddControl(mf.tsMain)

	mf.tvTree = goforms.NewTreeView()
	mf.tvTree.SetBounds(10, 50, 200, 200)
	tvTreeNode1 := mf.tvTree.AddNode(nil, "Root")
	mf.tvTree.AddNode(tvTreeNode1, "Child A")
	mf.tvTree.AddNode(nil, "Second root")
	mf.AddControl(mf.tvTree)
}
`

func controlByID(m *FormModel, id string) *ControlSpec {
	for _, c := range m.Controls {
		if c.ID == id {
			return c
		}
	}
	return nil
}

func TestParseCollections(t *testing.T) {
	path := writeFixture(t, collectionFixture)
	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	ts := controlByID(r.model, "tsMain")
	if ts == nil {
		t.Fatal("tsMain missing from model")
	}
	want := []CollectionItem{
		{Text: "New", Handler: "tsMain_New"},
		{Kind: "separator"},
		{Text: "Open"},
	}
	if len(ts.Collection) != len(want) {
		t.Fatalf("ToolStrip collection = %+v, want %+v", ts.Collection, want)
	}
	for i, w := range want {
		if ts.Collection[i] != w {
			t.Errorf("ToolStrip item %d = %+v, want %+v", i, ts.Collection[i], w)
		}
	}
	if ts.CollectionReadOnly {
		t.Error("ToolStrip collection reported read-only, want editable")
	}

	tv := controlByID(r.model, "tvTree")
	if tv == nil {
		t.Fatal("tvTree missing from model")
	}
	wantTree := []CollectionItem{
		{Text: "Root"},
		{Text: "Child A", Depth: 1},
		{Text: "Second root"},
	}
	for i, w := range wantTree {
		if i >= len(tv.Collection) || tv.Collection[i] != w {
			t.Fatalf("TreeView collection = %+v, want %+v", tv.Collection, wantTree)
		}
	}
}

// A collection edit must survive a round trip: what setCollection writes is
// what parse reads back, or the designer silently loses items.
func TestSetCollectionRoundTrips(t *testing.T) {
	path := writeFixture(t, collectionFixture)
	next := []CollectionItem{
		{Text: "Save", Handler: "tsMain_Save"},
		{Text: "Print"},
		{Kind: "separator"},
		{Text: "Exit", Handler: "tsMain_Exit"},
	}
	model, src := mustApply(t, path, Op{Op: "setCollection", ID: "tsMain", Collection: next})

	got := controlByID(model, "tsMain").Collection
	if len(got) != len(next) {
		t.Fatalf("collection = %+v, want %+v\n%s", got, next, src)
	}
	for i := range next {
		if got[i] != next[i] {
			t.Errorf("item %d = %+v, want %+v", i, got[i], next[i])
		}
	}
	if !strings.Contains(src, `mf.tsMain.AddButton("Exit", mf.tsMain_Exit)`) {
		t.Errorf("handler not wired into the generated call:\n%s", src)
	}
	if !strings.Contains(src, `mf.tsMain.AddButton("Print", nil)`) {
		t.Errorf("handler-less button should pass nil:\n%s", src)
	}
	// The control's other statements must survive a collection rewrite.
	if !strings.Contains(src, "mf.tsMain.SetBounds(0, 0, 400, 34)") {
		t.Errorf("SetBounds lost during collection rewrite:\n%s", src)
	}
	if !strings.Contains(src, "mf.AddControl(mf.tsMain)") {
		t.Errorf("AddControl lost during collection rewrite:\n%s", src)
	}
}

func TestSetCollectionNesting(t *testing.T) {
	path := writeFixture(t, collectionFixture)
	next := []CollectionItem{
		{Text: "A"},
		{Text: "A1", Depth: 1},
		{Text: "A1a", Depth: 2},
		{Text: "A2", Depth: 1},
		{Text: "B"},
	}
	model, src := mustApply(t, path, Op{Op: "setCollection", ID: "tvTree", Collection: next})

	got := controlByID(model, "tvTree").Collection
	if len(got) != len(next) {
		t.Fatalf("collection = %+v, want %+v\n%s", got, next, src)
	}
	for i := range next {
		if got[i] != next[i] {
			t.Errorf("item %d = %+v, want %+v\n%s", i, got[i], next[i], src)
		}
	}
	// A leaf must not be bound to a variable: Go rejects unused variables, so
	// naming every node would produce a file that doesn't compile.
	if strings.Contains(src, `:= mf.tvTree.AddNode(nil, "B")`) {
		t.Errorf("leaf node bound to an unused variable:\n%s", src)
	}
}

// Nesting that can't exist in generated code (a first item already indented,
// or a jump of two levels) is flattened rather than emitted as a call to an
// undeclared variable.
func TestSetCollectionClampsImpossibleNesting(t *testing.T) {
	path := writeFixture(t, collectionFixture)
	model, src := mustApply(t, path, Op{Op: "setCollection", ID: "tvTree", Collection: []CollectionItem{
		{Text: "Orphan", Depth: 3},
		{Text: "Jump", Depth: 9},
	}})

	got := controlByID(model, "tvTree").Collection
	if len(got) != 2 || got[0].Depth != 0 || got[1].Depth != 1 {
		t.Fatalf("depths not clamped: %+v\n%s", got, src)
	}
}

func TestSetCollectionEmptyRemovesEveryCall(t *testing.T) {
	path := writeFixture(t, collectionFixture)
	model, src := mustApply(t, path, Op{Op: "setCollection", ID: "tsMain", Collection: nil})

	if got := controlByID(model, "tsMain").Collection; len(got) != 0 {
		t.Fatalf("collection = %+v, want empty", got)
	}
	if strings.Contains(src, "AddButton") || strings.Contains(src, "AddSeparator") {
		t.Errorf("item calls left behind:\n%s", src)
	}
	if !strings.Contains(src, "mf.AddControl(mf.tsMain)") {
		t.Errorf("AddControl deleted along with the items:\n%s", src)
	}
}

// A statement sitting between two add calls belongs to the user, not the
// collection - rewriting the list must step over it.
func TestSetCollectionKeepsInterleavedStatements(t *testing.T) {
	src := strings.Replace(collectionFixture,
		"\tmf.tsMain.AddSeparator()\n",
		"\tmf.tsMain.AddSeparator()\n\tmf.tsMain.SetTabIndex(3)\n", 1)
	path := writeFixture(t, src)

	_, out := mustApply(t, path, Op{Op: "setCollection", ID: "tsMain", Collection: []CollectionItem{{Text: "Only"}}})
	if !strings.Contains(out, "mf.tsMain.SetTabIndex(3)") {
		t.Errorf("interleaved statement was swallowed:\n%s", out)
	}
}

// Add calls a hand-written file put after AddControl are outside the block
// remove deletes; leaving them would reference a field that no longer exists.
func TestRemoveDeletesTrailingCollectionCalls(t *testing.T) {
	src := strings.Replace(collectionFixture,
		"\tmf.AddControl(mf.tsMain)\n",
		"\tmf.AddControl(mf.tsMain)\n\tmf.tsMain.AddButton(\"Late\", nil)\n", 1)
	path := writeFixture(t, src)

	_, out := mustApply(t, path, Op{Op: "remove", ID: "tsMain"})
	if strings.Contains(out, "mf.tsMain") {
		t.Errorf("orphaned reference to the removed control:\n%s", out)
	}
}

// A collection the tool can't regenerate must be refused, not rewritten -
// rewriting would delete the code it failed to understand.
func TestSetCollectionRefusesUnreadableList(t *testing.T) {
	src := strings.Replace(collectionFixture,
		`mf.tsMain.AddButton("Open", nil)`,
		`mf.tsMain.AddButton(openLabel, nil)`, 1)
	src = strings.Replace(src, "mf.SetClientSize(800, 600)", "openLabel := \"Open\"\n\tmf.SetClientSize(800, 600)", 1)
	path := writeFixture(t, src)

	r, err := parseFile(path)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !controlByID(r.model, "tsMain").CollectionReadOnly {
		t.Fatal("collection with a non-literal title should be read-only")
	}

	before, _ := os.ReadFile(path)
	if _, err := applyOps(path, []Op{{Op: "setCollection", ID: "tsMain", Collection: []CollectionItem{{Text: "X"}}}}); err == nil {
		t.Fatal("setCollection on a read-only collection should fail")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Error("refused setCollection still modified the file")
	}
}

// A freshly dropped TabControl with no tabs renders as an empty box, which
// reads as a broken drop - the catalog's Default seeds it.
func TestAddSeedsDefaultCollection(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path, Op{
		Op: "add", ID: "tabsMain", Type: "TabControl", X: 10, Y: 10, W: 400, H: 300,
	})

	got := controlByID(model, "tabsMain").Collection
	if len(got) != 2 || got[0].Text != "Tab 1" {
		t.Fatalf("seeded tabs = %+v\n%s", got, src)
	}
	// The seed lives inside the control's block, so removing the control
	// takes it along instead of orphaning it.
	_, after := mustApply(t, path, Op{Op: "remove", ID: "tabsMain"})
	if strings.Contains(after, "tabsMain") {
		t.Errorf("seeded items outlived the control:\n%s", after)
	}
}

func TestEnsureHandlerParameterless(t *testing.T) {
	dir := t.TempDir()
	designer := dir + "/MainForm-designer.go"
	if err := os.WriteFile(designer, []byte(collectionFixture), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ensureHandler(designer, "MainForm", "mf", "tsMain_Save", noParams)
	if err != nil {
		t.Fatalf("ensureHandler: %v", err)
	}
	b, err := os.ReadFile(res.File)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "func (mf *MainForm) tsMain_Save() {") {
		t.Errorf("want a parameterless stub, got:\n%s", b)
	}
}

// Two add calls sharing a source line must not produce overlapping edits -
// the rewrite has to notice the second one is already covered.
func TestSetCollectionHandlesCallsSharingALine(t *testing.T) {
	src := strings.Replace(collectionFixture,
		"\tmf.tsMain.AddSeparator()\n\tmf.tsMain.AddButton(\"Open\", nil)\n",
		"\tmf.tsMain.AddSeparator()\n\tmf.tsMain.AddButton(\"Open\", nil); mf.tsMain.AddButton(\"Close\", nil)\n", 1)
	path := writeFixture(t, src)

	model, out := mustApply(t, path, Op{Op: "setCollection", ID: "tsMain", Collection: []CollectionItem{{Text: "Only"}}})
	if got := controlByID(model, "tsMain").Collection; len(got) != 1 || got[0].Text != "Only" {
		t.Fatalf("collection = %+v\n%s", got, out)
	}
	if strings.Contains(out, "Close") {
		t.Errorf("call sharing a line survived the rewrite:\n%s", out)
	}
}
