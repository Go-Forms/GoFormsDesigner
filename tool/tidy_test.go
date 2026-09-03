package main

import (
	"os"
	"strings"
	"testing"
)

// mustTidy tidies path, failing the test on error, and returns the result
// alongside the file's new contents.
func mustTidy(t *testing.T, path string) (*TidyResult, string) {
	t.Helper()
	res, err := tidyFile(path)
	if err != nil {
		t.Fatalf("tidyFile: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	return res, string(b)
}

// countOf is how many times sub appears in src.
func countOf(src, sub string) int { return strings.Count(src, sub) }

func TestTidyCollapsesStackedEventWiring(t *testing.T) {
	path := writeFixture(t, strings.Replace(designerFixture,
		"\tmf.AddControl(mf.lblWelcome)",
		"\tmf.lblWelcome.Click.Handle(mf.onFirst)\n"+
			"\tmf.lblWelcome.Click.Handle(mf.onSecond)\n"+
			"\tmf.lblWelcome.Click.Handle(mf.onThird)\n"+
			"\tmf.AddControl(mf.lblWelcome)", 1))

	res, src := mustTidy(t, path)
	if !res.Changed || res.Statements != 2 {
		t.Fatalf("want 2 statements removed, got %+v", res)
	}
	if got := countOf(src, ".Click.Handle("); got != 1 {
		t.Fatalf("want a single Handle call left, got %d:\n%s", got, src)
	}
	// The last wiring is the one the designer reports, so it is the one that
	// must survive - dropping it would silently change behaviour.
	if !strings.Contains(src, "mf.onThird") || strings.Contains(src, "mf.onFirst") {
		t.Fatalf("wrong wiring survived:\n%s", src)
	}
}

func TestTidyCollapsesRepeatedSetters(t *testing.T) {
	path := writeFixture(t, strings.Replace(designerFixture,
		"\tmf.lblWelcome.SetBounds(20, 20, 300, 24)",
		"\tmf.lblWelcome.SetBounds(1, 1, 1, 1)\n"+
			"\tmf.lblWelcome.SetBounds(10, 10, 10, 10)\n"+
			"\tmf.lblWelcome.SetBounds(20, 20, 300, 24)\n"+
			"\tmf.lblWelcome.SetDock(goforms.DockTop)\n"+
			"\tmf.lblWelcome.SetDock(goforms.DockFill)", 1))

	res, src := mustTidy(t, path)
	if res.Statements != 3 {
		t.Fatalf("want 3 statements removed, got %+v", res)
	}
	if got := countOf(src, "SetBounds("); got != 1 {
		t.Fatalf("want 1 SetBounds left, got %d:\n%s", got, src)
	}
	if !strings.Contains(src, "SetBounds(20, 20, 300, 24)") || !strings.Contains(src, "SetDock(goforms.DockFill)") {
		t.Fatalf("the last value of each setter should survive:\n%s", src)
	}
}

func TestTidyDropsDuplicateAddControl(t *testing.T) {
	path := writeFixture(t, strings.Replace(designerFixture,
		"\tmf.AddControl(mf.lblWelcome)",
		"\tmf.AddControl(mf.lblWelcome)\n\tmf.AddControl(mf.lblWelcome)", 1))

	res, src := mustTidy(t, path)
	if res.Statements != 1 {
		t.Fatalf("want 1 statement removed, got %+v", res)
	}
	if got := countOf(src, "AddControl(mf.lblWelcome)"); got != 1 {
		t.Fatalf("want 1 AddControl left, got %d:\n%s", got, src)
	}
}

func TestTidyDropsCommentedOutStatements(t *testing.T) {
	path := writeFixture(t, strings.Replace(designerFixture,
		"\tmf.AddControl(mf.lblWelcome)",
		"\t// mf.lblWelcome.SetText(\"old\")\n"+
			"\t// The label greets the user; keep it first.\n"+
			"\tmf.AddControl(mf.lblWelcome) // mf.oldParent.AddControl(mf.lblWelcome)", 1))

	res, src := mustTidy(t, path)
	if res.Comments != 1 {
		t.Fatalf("want 1 comment removed, got %+v", res)
	}
	if strings.Contains(src, `SetText("old")`) {
		t.Fatalf("the disabled statement should be gone:\n%s", src)
	}
	// Prose stays, and so does a trailing comment - removing it would take
	// the live statement sharing its line with it.
	if !strings.Contains(src, "greets the user") || !strings.Contains(src, "mf.oldParent") {
		t.Fatalf("only whole-line disabled statements should go:\n%s", src)
	}
}

func TestTidyKeepsIndexedAndCumulativeCalls(t *testing.T) {
	// A tab title repeated twice is two tabs, and an indexed setter says
	// something different on every call. Collapsing either by method name
	// would silently destroy the layout.
	path := writeFixture(t, strings.Replace(designerFixture,
		"\tmf.AddControl(mf.lblWelcome)",
		"\tmf.AddControl(mf.lblWelcome)\n\n"+
			"\tmf.tabs = goforms.NewTabControl(400, 300)\n"+
			"\tmf.tabs.SetBounds(0, 60, 400, 300)\n"+
			"\tmf.tabs.AddTab(\"Page\")\n"+
			"\tmf.tabs.AddTab(\"Page\")\n"+
			"\tmf.tabs.SetColumnStyle(0, goforms.Absolute(110))\n"+
			"\tmf.tabs.SetColumnStyle(1, goforms.Absolute(110))\n"+
			"\tmf.AddControl(mf.tabs)", 1))
	path = rewriteStruct(t, path, "\tlblWelcome *goforms.Label", "\tlblWelcome *goforms.Label\n\ttabs *goforms.TabControl")

	res, src := mustTidy(t, path)
	if res.Statements != 0 {
		t.Fatalf("nothing here is redundant, got %+v\n%s", res, src)
	}
	if countOf(src, `AddTab("Page")`) != 2 || countOf(src, "SetColumnStyle(") != 2 {
		t.Fatalf("cumulative and indexed calls must survive:\n%s", src)
	}
}

func TestTidyDropsDuplicateStructFields(t *testing.T) {
	path := rewriteStruct(t, writeFixture(t, designerFixture),
		"\tlblWelcome *goforms.Label",
		"\tlblWelcome *goforms.Label\n\tlblWelcome *goforms.Label")

	res, src := mustTidy(t, path)
	if res.Fields != 1 {
		t.Fatalf("want 1 field removed, got %+v", res)
	}
	if countOf(src, "lblWelcome *goforms.Label") != 1 {
		t.Fatalf("want 1 field declaration left:\n%s", src)
	}
}

func TestTidyLeavesACleanFileAlone(t *testing.T) {
	path := writeFixture(t, designerFixture)
	res, src := mustTidy(t, path)
	if res.Changed || res.Total() != 0 {
		t.Fatalf("a clean file should not be rewritten, got %+v", res)
	}
	if src != designerFixture {
		t.Fatalf("file changed:\n%s", src)
	}
}

// rewriteStruct swaps one span of a fixture already on disk, for the tests
// that need a struct writeFixture's constant does not declare.
func rewriteStruct(t *testing.T, path, old, new string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if !strings.Contains(string(b), old) {
		t.Fatalf("fixture has no %q", old)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(b), old, new, 1)), 0o644); err != nil {
		t.Fatalf("rewrite fixture: %v", err)
	}
	return path
}

func TestSetEventRewiresInPlace(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "setEvent", ID: "lblWelcome", Event: "Click", Handler: "onFirst"})
	model, src := mustApply(t, path, Op{Op: "setEvent", ID: "lblWelcome", Event: "Click", Handler: "onSecond"})

	if got := countOf(src, ".Click.Handle("); got != 1 {
		t.Fatalf("re-wiring should replace, not stack: %d Handle calls\n%s", got, src)
	}
	if got := findControl(t, model, "lblWelcome").Events["Click"]; got != "onSecond" {
		t.Fatalf("Click = %q, want onSecond", got)
	}
}
