package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stylesFixture is the shape the scaffold writes: one goforms.Theme literal
// returned from a function, with a mixture of set and unset fields.
const stylesFixture = `package main

import "github.com/Go-Forms/GoForms"

// Theme is this application's look.
func Theme() goforms.Theme {
	return goforms.Theme{
		Name:       "MyApp",
		Dark:       true,
		Background: goforms.RGB(0x1E, 0x1F, 0x22),
		Primary:    goforms.RGB(0x4C, 0x97, 0xFF),
		Padding:    6,
	}
}
`

func writeStyles(t *testing.T, src string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "myapp-styles.go")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

func mustThemeParse(t *testing.T, path string) *ThemeModel {
	t.Helper()
	r, err := parseThemeFile(path)
	if err != nil {
		t.Fatalf("parseThemeFile: %v", err)
	}
	return r.model
}

func field(t *testing.T, m *ThemeModel, name string) ThemeValue {
	t.Helper()
	for _, f := range m.Fields {
		if f.Name == name {
			return f
		}
	}
	t.Fatalf("no field %q in the model", name)
	return ThemeValue{}
}

// mustThemeApply runs ops and returns the model plus the file's new text.
func mustThemeApply(t *testing.T, path string, ops ...ThemeOp) (*ThemeModel, string) {
	t.Helper()
	m, err := applyThemeOps(path, ops)
	if err != nil {
		t.Fatalf("applyThemeOps: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	return m, string(b)
}

func TestThemeParseReadsEveryKind(t *testing.T) {
	m := mustThemeParse(t, writeStyles(t, stylesFixture))

	if m.FuncName != "Theme" {
		t.Fatalf("FuncName = %q, want Theme", m.FuncName)
	}
	if len(m.Fields) != len(themeFields) {
		t.Fatalf("want every field reported, got %d of %d", len(m.Fields), len(themeFields))
	}

	if got := field(t, m, "Name"); !got.Set || got.Text != "MyApp" {
		t.Fatalf("Name = %+v", got)
	}
	if got := field(t, m, "Dark"); !got.Set || !got.Bool {
		t.Fatalf("Dark = %+v", got)
	}
	if got := field(t, m, "Background"); !got.Set || got.Color != "#1e1f22" {
		t.Fatalf("Background = %+v", got)
	}
	if got := field(t, m, "Padding"); !got.Set || got.Number != 6 {
		t.Fatalf("Padding = %+v", got)
	}
}

// An absent field is not a blank: it means "keep Fyne's default", so the
// editor has to be able to tell the two apart.
func TestThemeParseReportsAbsentFieldsAsUnset(t *testing.T) {
	m := mustThemeParse(t, writeStyles(t, stylesFixture))

	got := field(t, m, "Hover")
	if got.Set {
		t.Fatalf("Hover should be unset, got %+v", got)
	}
	if !got.Editable {
		t.Fatal("an absent field should still be editable - it can be added")
	}
}

func TestThemeParseReadsRGBA(t *testing.T) {
	src := strings.Replace(stylesFixture,
		"Background: goforms.RGB(0x1E, 0x1F, 0x22),",
		"Background: goforms.RGBA(0x1E, 0x1F, 0x22, 0x80),", 1)

	if got := field(t, mustThemeParse(t, writeStyles(t, src)), "Background"); got.Color != "#1e1f2280" {
		t.Fatalf("Background = %+v", got)
	}
}

// A colour built from a constant is someone's deliberate choice. The editor
// shows it and refuses to overwrite it, rather than flattening it to a hex
// literal behind their back.
func TestThemeParseMarksExpressionsReadOnly(t *testing.T) {
	src := strings.Replace(stylesFixture,
		"Background: goforms.RGB(0x1E, 0x1F, 0x22),",
		"Background: brandBackground,", 1)

	got := field(t, mustThemeParse(t, writeStyles(t, src)), "Background")
	if !got.Set {
		t.Fatal("the field is present, so it is set")
	}
	if got.Editable {
		t.Fatal("a named constant should be reported read-only")
	}
	if got.Raw != "brandBackground" {
		t.Fatalf("Raw = %q", got.Raw)
	}
}

func TestThemeApplyRefusesToOverwriteAnExpression(t *testing.T) {
	src := strings.Replace(stylesFixture,
		"Background: goforms.RGB(0x1E, 0x1F, 0x22),",
		"Background: brandBackground,", 1)
	path := writeStyles(t, src)

	_, err := applyThemeOps(path, []ThemeOp{{Op: "set", Field: "Background", Color: "#ff0000"}})
	if err == nil {
		t.Fatal("want an error, got none")
	}
	if !strings.Contains(err.Error(), "brandBackground") {
		t.Fatalf("the error should name what is there, got: %v", err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "brandBackground") {
		t.Fatalf("the file was changed anyway:\n%s", b)
	}
}

func TestThemeApplyChangesAColour(t *testing.T) {
	path := writeStyles(t, stylesFixture)
	m, src := mustThemeApply(t, path, ThemeOp{Op: "set", Field: "Primary", Color: "#ff8800"})

	if !strings.Contains(src, "Primary:    goforms.RGB(0xFF, 0x88, 0x00),") {
		t.Fatalf("Primary was not rewritten:\n%s", src)
	}
	if got := field(t, m, "Primary"); got.Color != "#ff8800" {
		t.Fatalf("Primary = %+v", got)
	}
}

// An opaque colour is written as RGB: the alpha would be noise on every line.
func TestThemeApplyDropsAnOpaqueAlpha(t *testing.T) {
	_, src := mustThemeApply(t, writeStyles(t, stylesFixture),
		ThemeOp{Op: "set", Field: "Primary", Color: "#11223344"},
		ThemeOp{Op: "set", Field: "Foreground", Color: "#aabbccff"})

	if !strings.Contains(src, "goforms.RGBA(0x11, 0x22, 0x33, 0x44)") {
		t.Fatalf("a translucent colour should keep its alpha:\n%s", src)
	}
	if !strings.Contains(src, "goforms.RGB(0xAA, 0xBB, 0xCC)") {
		t.Fatalf("an opaque colour should drop its alpha:\n%s", src)
	}
}

// Fields are inserted where the struct declares them, so a theme filled in
// by clicking around still reads in a predictable order.
func TestThemeApplyInsertsInDeclarationOrder(t *testing.T) {
	_, src := mustThemeApply(t, writeStyles(t, stylesFixture),
		ThemeOp{Op: "set", Field: "Hover", Color: "#333333"},
		ThemeOp{Op: "set", Field: "Foreground", Color: "#eeeeee"})

	iFore := strings.Index(src, "Foreground:")
	iPrimary := strings.Index(src, "Primary:")
	iHover := strings.Index(src, "Hover:")
	if !(iFore > 0 && iFore < iPrimary && iPrimary < iHover) {
		t.Fatalf("want Foreground before Primary before Hover:\n%s", src)
	}
}

func TestThemeApplyAddsToAnEmptyLiteral(t *testing.T) {
	src := `package main

import "github.com/Go-Forms/GoForms"

func Theme() goforms.Theme {
	return goforms.Theme{}
}
`
	path := writeStyles(t, src)
	m, out := mustThemeApply(t, path,
		ThemeOp{Op: "set", Field: "Dark", Bool: true},
		ThemeOp{Op: "set", Field: "Padding", Number: 8})

	if !field(t, m, "Dark").Bool || field(t, m, "Padding").Number != 8 {
		t.Fatalf("fields were not added:\n%s", out)
	}
	// The result is a file someone reads, so it should look like one.
	if !strings.Contains(out, "\n\t\tPadding: 8,\n\t}") {
		t.Fatalf("the literal is not laid out cleanly:\n%s", out)
	}
}

func TestThemeApplyUnsetRemovesTheLine(t *testing.T) {
	m, src := mustThemeApply(t, writeStyles(t, stylesFixture),
		ThemeOp{Op: "unset", Field: "Padding"})

	if strings.Contains(src, "Padding") {
		t.Fatalf("Padding should be gone:\n%s", src)
	}
	if field(t, m, "Padding").Set {
		t.Fatal("Padding should read back as unset")
	}
}

func TestThemeApplyUnsetOfAnAbsentFieldIsANoOp(t *testing.T) {
	path := writeStyles(t, stylesFixture)
	before, _ := os.ReadFile(path)
	mustThemeApply(t, path, ThemeOp{Op: "unset", Field: "Hover"})
	after, _ := os.ReadFile(path)

	if string(before) != string(after) {
		t.Fatalf("the file changed:\n%s", after)
	}
}

// Comments and unrecognised fields inside the literal are not the tool's to
// discard, which is why fields are spliced rather than the literal rebuilt.
func TestThemeApplyPreservesWhatItDoesNotModel(t *testing.T) {
	src := strings.Replace(stylesFixture,
		"		Dark:       true,",
		"		// Brand decision, do not change without asking.\n		Dark:       true,", 1)

	_, out := mustThemeApply(t, writeStyles(t, src), ThemeOp{Op: "set", Field: "Primary", Color: "#010203"})

	if !strings.Contains(out, "Brand decision") {
		t.Fatalf("the comment was lost:\n%s", out)
	}
}

func TestThemeApplyIsAtomic(t *testing.T) {
	path := writeStyles(t, stylesFixture)
	before, _ := os.ReadFile(path)

	_, err := applyThemeOps(path, []ThemeOp{
		{Op: "set", Field: "Primary", Color: "#00ff00"},
		{Op: "set", Field: "Nonsense", Color: "#000000"},
	})
	if err == nil {
		t.Fatal("want an error for the unknown field")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("the first op should have been rolled back:\n%s", after)
	}
}

func TestThemeApplyRejectsABadColour(t *testing.T) {
	for _, bad := range []string{"", "#12", "#gggggg", "red"} {
		if _, err := applyThemeOps(writeStyles(t, stylesFixture),
			[]ThemeOp{{Op: "set", Field: "Primary", Color: bad}}); err == nil {
			t.Fatalf("colour %q should have been rejected", bad)
		}
	}
}

func TestThemeParseFailsWithoutALiteral(t *testing.T) {
	path := writeStyles(t, "package main\n\nfunc main() {}\n")
	if _, err := parseThemeFile(path); err == nil {
		t.Fatal("want an error when there is no goforms.Theme literal")
	}
}

// The model crosses to the webview as JSON, so it has to survive the trip.
func TestThemeModelMarshals(t *testing.T) {
	m := mustThemeParse(t, writeStyles(t, stylesFixture))
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back ThemeModel
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(back.Fields) != len(m.Fields) {
		t.Fatalf("fields lost in transit: %d vs %d", len(back.Fields), len(m.Fields))
	}
}
