package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writePicture drops a picture into the form's folder.
func writePicture(t *testing.T, designer, rel string) {
	t.Helper()
	p := filepath.Join(filepath.Dir(designer), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAPictureIsEmbeddedAndLoaded(t *testing.T) {
	path := writeFixture(t, designerFixture)
	writePicture(t, path, "resources/logo.png")
	writePicture(t, path, "resources/other.png")
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "picLogo", Type: "PictureBox", W: 100, H: 100},
		Op{Op: "setProp", ID: "picLogo", Prop: "image", Value: "resources/logo.png"},
	)
	for _, want := range []string{
		`_ "embed"`,
		"//go:embed resources/logo.png\nvar picLogoImage []byte",
		`mf.picLogo.LoadBytes("logo.png", picLogoImage)`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("want %q in\n%s", want, src)
		}
	}
	if got := findControl(t, model, "picLogo").Props["image"]; got != "resources/logo.png" {
		t.Errorf("image reads %q", got)
	}

	// Another picture rewrites the directive and the call, not a second set.
	_, src = mustApply(t, path, Op{Op: "setProp", ID: "picLogo", Prop: "image", Value: "resources/other.png"})
	if strings.Count(src, "//go:embed") != 1 || !strings.Contains(src, "//go:embed resources/other.png") || !strings.Contains(src, `LoadBytes("other.png", picLogoImage)`) {
		t.Errorf("rewrite:\n%s", src)
	}

	// Deleting the box takes the variable and, with the last one, the import.
	_, src = mustApply(t, path, Op{Op: "remove", ID: "picLogo"})
	if strings.Contains(src, "go:embed") || strings.Contains(src, `"embed"`) || strings.Contains(src, "picLogoImage") {
		t.Errorf("remove left:\n%s", src)
	}
}

func TestTheFormsIconIsEmbedded(t *testing.T) {
	path := writeFixture(t, designerFixture)
	writePicture(t, path, "resources/app.png")
	model, src := mustApply(t, path, Op{Op: "setProp", Prop: "icon", Value: "resources/app.png"})
	if !strings.Contains(src, `mf.SetIcon(goforms.NewResource("app.png", formIcon))`) || !strings.Contains(src, "//go:embed resources/app.png\nvar formIcon []byte") {
		t.Fatalf("icon:\n%s", src)
	}
	if model.FormProps["icon"] != "resources/app.png" {
		t.Errorf("icon reads %q", model.FormProps["icon"])
	}
	_, src = mustApply(t, path, Op{Op: "resetProp", Prop: "icon"})
	if strings.Contains(src, "SetIcon") || strings.Contains(src, "embed") {
		t.Errorf("reset left:\n%s", src)
	}
}

func TestAPictureMustBeInTheFormsFolder(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "pic", Type: "PictureBox", W: 10, H: 10})
	for _, bad := range []string{"../logo.png", "/etc/logo.png", "resources/missing.png", "notes.txt"} {
		if _, err := applyOps(path, []Op{{Op: "setProp", ID: "pic", Prop: "image", Value: bad}}); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestAnEmbedVariableAnotherFileUsesIsKept(t *testing.T) {
	path := writeFixture(t, designerFixture)
	writePicture(t, path, "resources/logo.png")
	mustApply(t, path, Op{Op: "add", ID: "pic", Type: "PictureBox", W: 10, H: 10}, Op{Op: "setProp", ID: "pic", Prop: "image", Value: "resources/logo.png"})
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "MainForm.go"), []byte("package mainform\n\nvar _ = picImage\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, src := mustApply(t, path, Op{Op: "resetProp", ID: "pic", Prop: "image"})
	if !strings.Contains(src, "var picImage []byte") {
		t.Errorf("deleted a variable MainForm.go uses:\n%s", src)
	}
}
