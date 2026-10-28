package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const startupMain = `package main

import (
	"github.com/Go-Forms/GoForms"

	mainform "example.com/app/Forms/MainForm"
)

func main() {
	goforms.NewApplication("com.example.app")
	goforms.Run(mainform.NewMainForm().Form)
}
`

func settingsDesigner(pkg, typ string) string {
	return strings.NewReplacer("PKG", pkg, "TYP", typ).Replace(`package PKG

import "github.com/Go-Forms/GoForms"

type TYP struct {
	*goforms.Form
}

func NewTYP() *TYP {
	f := &TYP{Form: goforms.NewForm("TYP", 400, 300)}
	f.initializeComponent()
	return f
}

func (f *TYP) initializeComponent() {
}
`)
}

// startupProject lays out a module with main.go and two forms, and returns
// its root.
func startupProject(t *testing.T, main string) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/app\n\ngo 1.23\n")
	write("main.go", main)
	write("Forms/MainForm/MainForm-designer.go", settingsDesigner("mainform", "MainForm"))
	write("Forms/SettingsForm/SettingsForm-designer.go", settingsDesigner("settingsform", "SettingsForm"))
	return root
}

func TestSetStartupPointsRunAtTheFormAndSwapsTheImport(t *testing.T) {
	root := startupProject(t, startupMain)
	res, err := setStartup(filepath.Join(root, "main.go"), filepath.Join(root, "Forms/SettingsForm/SettingsForm-designer.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Changed || res.Form != "settingsform.NewSettingsForm().Form" {
		t.Fatalf("result %+v", res)
	}
	got := readBack(t, filepath.Join(root, "main.go"))
	for _, want := range []string{
		`settingsform "example.com/app/Forms/SettingsForm"`,
		"goforms.Run(settingsform.NewSettingsForm().Form)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("main.go lacks %q:\n%s", want, got)
		}
	}
	// The old form's package was only used by Run, and an unused import
	// does not compile.
	if strings.Contains(got, "Forms/MainForm") {
		t.Errorf("the unused import of the old form was kept:\n%s", got)
	}
}

func TestSetStartupKeepsAnImportStillInUse(t *testing.T) {
	main := strings.Replace(startupMain, "\tgoforms.Run(", "\t_ = mainform.NewMainForm\n\tgoforms.Run(", 1)
	root := startupProject(t, main)
	if _, err := setStartup(filepath.Join(root, "main.go"), filepath.Join(root, "Forms/SettingsForm/SettingsForm-designer.go")); err != nil {
		t.Fatal(err)
	}
	if got := readBack(t, filepath.Join(root, "main.go")); !strings.Contains(got, `mainform "example.com/app/Forms/MainForm"`) {
		t.Errorf("an import main.go still uses was removed:\n%s", got)
	}
}

func TestSetStartupOnTheCurrentFormChangesNothing(t *testing.T) {
	root := startupProject(t, startupMain)
	res, err := setStartup(filepath.Join(root, "main.go"), filepath.Join(root, "Forms/MainForm/MainForm-designer.go"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed {
		t.Errorf("setting the startup form to itself rewrote main.go")
	}
	if got := readBack(t, filepath.Join(root, "main.go")); got != startupMain {
		t.Errorf("main.go changed:\n%s", got)
	}
}
