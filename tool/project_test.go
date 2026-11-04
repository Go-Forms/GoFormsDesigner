package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const gaugeSource = `package widgets

import "github.com/Go-Forms/GoForms"

// Gauge is a control of the project's own, built on a Panel.
type Gauge struct {
	*goforms.Panel
	value float64
}

func NewGauge(w, h float32) *Gauge {
	return &Gauge{Panel: goforms.NewPanel(w, h)}
}

// Badge is built on a Label and takes no size.
type Badge struct {
	*goforms.Label
}

func NewBadge() *Badge { return &Badge{Label: goforms.NewLabel("badge")} }

// notAControl has a constructor but embeds nothing of the framework's.
type NotAControl struct{ n int }

func NewNotAControl() *NotAControl { return &NotAControl{} }
`

const projectForm = `package mainform

import "github.com/Go-Forms/GoForms"

type MainForm struct {
	*goforms.Form
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("test", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
}
`

// projectModule lays out a module with a widgets package and a form, and
// returns the module root and the form's designer file.
func projectModule(t *testing.T) (string, string) {
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
	write("Controls/Widgets/widgets.go", gaugeSource)
	write("main.go", "package main\n\nimport \"github.com/Go-Forms/GoForms\"\n\ntype Local struct{ *goforms.Panel }\n\nfunc NewLocal() *Local { return nil }\n\nfunc main() {}\n")
	write("Forms/MainForm/MainForm-designer.go", projectForm)
	return root, filepath.Join(root, "Forms/MainForm/MainForm-designer.go")
}

func TestProjectControlsAreFoundInTheModule(t *testing.T) {
	root, _ := projectModule(t)
	found, err := projectControls(filepath.Join(root, "Forms"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, d := range found {
		names = append(names, d.Type)
	}
	if strings.Join(names, ",") != "widgets.Badge,widgets.Gauge" {
		t.Fatalf("found %v", names)
	}
	gauge := catalog["widgets.Gauge"]
	if gauge.Custom.Import != "example.com/app/Controls/Widgets" || !gauge.Custom.SizeArgs || !gauge.IsContainer {
		t.Errorf("gauge = %+v container %v", gauge.Custom, gauge.IsContainer)
	}
	if catalog["widgets.Badge"].IsContainer {
		t.Error("a control built on a Label is not a container")
	}
}

func TestAProjectControlIsWrittenAndReadBack(t *testing.T) {
	root, designer := projectModule(t)
	if _, err := projectControls(root); err != nil {
		t.Fatal(err)
	}
	gauge := catalog["widgets.Gauge"].Custom
	model, src := mustApply(t, designer,
		Op{Op: "add", ID: "gauge1", Type: "widgets.Gauge", Custom: gauge, X: 10, Y: 20, W: 200, H: 80},
		Op{Op: "setProp", ID: "gauge1", Prop: "dock", Value: "DockTop"},
		Op{Op: "add", ID: "lbl", Type: "Label", Text: "in", Parent: "gauge1", W: 50, H: 20},
	)
	for _, want := range []string{
		`widgets "example.com/app/Controls/Widgets"`,
		"gauge1 *widgets.Gauge",
		"mf.gauge1 = widgets.NewGauge(200, 80)",
		"mf.gauge1.SetDock(goforms.DockTop)",
		"mf.gauge1.AddControl(mf.lbl)",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("want %q in\n%s", want, src)
		}
	}
	g := findControl(t, model, "gauge1")
	if g.Type != "widgets.Gauge" || !g.Supported || g.Props["dock"] != "DockTop" || g.W != 200 {
		t.Errorf("read back as %+v", g)
	}

	// Removing the last control from a package takes its import with it:
	// an unused import does not compile.
	_, src = mustApply(t, designer, Op{Op: "remove", ID: "gauge1"})
	if strings.Contains(src, "Controls/Widgets") {
		t.Errorf("the unused import survived:\n%s", src)
	}
}

func TestAProjectControlFromAnotherModuleIsRefusedOnRead(t *testing.T) {
	_, designer := projectModule(t)
	src := strings.Replace(projectForm, `import "github.com/Go-Forms/GoForms"`, "import (\n\t\"github.com/Go-Forms/GoForms\"\n\t\"example.org/other/widgets\"\n)", 1)
	src = strings.Replace(src, "\t*goforms.Form\n", "\t*goforms.Form\n\n\tw *widgets.Gauge\n", 1)
	src = strings.Replace(src, "func (mf *MainForm) initializeComponent() {\n", "func (mf *MainForm) initializeComponent() {\n\tmf.w = widgets.NewGauge()\n\tmf.AddControl(mf.w)\n", 1)
	if err := os.WriteFile(designer, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := parseFile(designer)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.model.Controls) != 0 {
		t.Errorf("a control from outside the module was taken for a project control: %+v", r.model.Controls[0])
	}
}

func TestAddRefusesAProjectControlDescribedAsSomethingElse(t *testing.T) {
	_, designer := projectModule(t)
	bad := &CustomType{Import: "example.com/app/Controls/Widgets", Package: "widgets", Name: "Gauge", Ctor: "NewGauge"}
	if _, err := applyOps(designer, []Op{{Op: "add", ID: "g", Type: "widgets.Other", Custom: bad, W: 10, H: 10}}); err == nil {
		t.Fatal("accepted a type key that does not match its description")
	}
}

func TestTheProjectsRecordTypesAreListed(t *testing.T) {
	root, _ := projectModule(t)
	if err := os.WriteFile(filepath.Join(root, "Controls/Widgets/models.go"), []byte("package widgets\n\ntype Customer struct {\n\tID   int\n\tName string\n\tnote string\n\tTags []string\n}\n\ntype hidden struct{ A int }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	types, err := projectTypes(root)
	if err != nil {
		t.Fatal(err)
	}
	var customer *DataType
	for i := range types {
		if types[i].Name == "Customer" {
			customer = &types[i]
		}
		if types[i].Name == "hidden" {
			t.Error("an unexported type was listed")
		}
	}
	if customer == nil {
		t.Fatalf("Customer not found in %+v", types)
	}
	want := []DataField{{"ID", "int"}, {"Name", "string"}, {"Tags", "[]string"}}
	if len(customer.Fields) != 3 || customer.Fields[0] != want[0] || customer.Fields[2] != want[2] {
		t.Errorf("fields %+v", customer.Fields)
	}
}
