package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestGeneratedCodeCompilesAgainstGoForms is the check no other test here
// can make: that what the tool writes is code the real framework accepts.
// Every control type is added with every property it has set to a sample
// value, a table holds controls by cell, and the result is built against a
// GoForms checkout.
//
// It needs that checkout, so it only runs when GOFORMS_DIR names one:
//
//	GOFORMS_DIR=../../GoForms go test -run TestGeneratedCodeCompiles .
//
// The build is for js/wasm, which needs no C toolchain or GL headers, so it
// runs on any machine that has Go.
func TestGeneratedCodeCompilesAgainstGoForms(t *testing.T) {
	framework := os.Getenv("GOFORMS_DIR")
	if framework == "" {
		t.Skip("set GOFORMS_DIR to a GoForms checkout to build generated code against it")
	}
	framework, err := filepath.Abs(framework)
	if err != nil {
		t.Fatal(err)
	}

	root, write := compileModule(t, framework, "mainform.NewMainForm().Form", "example.com/compilecheck/Forms/MainForm")
	write("Forms/MainForm/MainForm-designer.go", `package mainform

import "github.com/Go-Forms/GoForms"

type MainForm struct {
	*goforms.Form
}

func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("check", 800, 600)}
	mf.initializeComponent()
	return mf
}

func (mf *MainForm) initializeComponent() {
}
`)
	designer := filepath.Join(root, "Forms/MainForm/MainForm-designer.go")

	sample := func(desc *ControlDesc, prop string) string {
		if t := refKind(kindOf(desc, prop)); t != "" {
			return "c" + t // the component of that type added below
		}
		switch kindOf(desc, prop) {
		case KindImage:
			return "resources/dot.png"
		case KindBool:
			return "true"
		case KindNumber:
			return "1"
		case KindEnum, KindFlags:
			return enumsFor(desc, prop)[0]
		case KindColor:
			return "#336699"
		case KindFont:
			return "Sans, 12, Bold"
		case KindPadding:
			return "1, 2, 3, 4"
		}
		return "x"
	}

	var types []string
	for typ, d := range catalog {
		if d.Custom == nil {
			types = append(types, typ)
		}
	}
	// Components first, so the controls' references to them - a
	// ContextMenu, a BindingSource - have something to name.
	sort.Slice(types, func(i, j int) bool {
		a, b := catalog[types[i]].NonVisual, catalog[types[j]].NonVisual
		if a != b {
			return a
		}
		return types[i] < types[j]
	})
	write("Forms/MainForm/resources/dot.png", "\x89PNG\r\n\x1a\n")

	var ops []Op
	var handlers []string
	for _, typ := range types {
		desc := catalog[typ]
		id := "c" + typ
		props := map[string]string{}
		for _, p := range propNames(desc) {
			if !isCtorProp(desc, p) && p != "text" {
				props[p] = sample(desc, p)
			}
		}
		if !desc.NonVisual {
			for _, p := range baseProps {
				props[p] = sample(nil, p)
			}
		}
		events := map[string]string{}
		for _, ev := range allEventsFor(desc) {
			h := id + "_" + ev
			events[ev] = h
			arg, _ := eventArgType(desc, ev)
			handlers = append(handlers, h+" "+arg)
		}
		var special []Op
		for _, p := range desc.Special {
			special = append(special, Op{Op: "setProp", ID: id, Prop: p, Value: sample(desc, p)})
			delete(props, p)
		}
		var tips map[string]string
		var binds map[string]BindingSpec
		if !desc.NonVisual {
			tips = map[string]string{"cToolTip": "tip"}
			for _, p := range desc.Bindable {
				binds = map[string]BindingSpec{p: {Source: "cBindingSource", Member: "Name"}}
			}
		}
		var items []CollectionItem
		if cd := desc.Collection; cd != nil && cd.InCtor {
			h := id + "_Item"
			items = []CollectionItem{{Text: "Top"}, {Text: "Item", Depth: 1, Handler: h, Disabled: true}, {Kind: "separator", Depth: 1}, {Text: "Sub", Depth: 1}, {Text: "Leaf", Depth: 2}}
			if cd.TopLevel == "" {
				items[0].Handler = id + "_Top"
				handlers = append(handlers, id+"_Top EventArgs")
			}
			handlers = append(handlers, h+" EventArgs")
		}
		ops = append(ops, Op{Op: "add", ID: id, Type: typ, X: 1, Y: 1, W: 50, H: 50, Text: typ, Props: props, Events: events, ToolTips: tips, Bindings: binds, Collection: items})
		ops = append(ops, special...)
	}
	ops = append(ops, Op{Op: "setProp", Prop: "icon", Value: "resources/dot.png"})
	// Every column setting the designer writes.
	ops = append(ops, Op{Op: "setColumns", ID: "cDataGridView", Columns: []GridColumnSpec{
		{Title: "ID", Width: 60, ReadOnly: true, Hidden: true},
		{Title: "Name", SizeMode: "SizeFill", DataPropertyName: "Name", Align: "AlignCenter"},
		{Title: "Go", Kind: "Button", ButtonText: "Open", SizeMode: "SizeToContent"},
		{Title: "On", Kind: "CheckBox", Align: "AlignRight"},
	}})
	ops = append(ops,
		Op{Op: "setTable", ID: "cTableLayoutPanel",
			TableColumns: []TrackSpec{{Type: "Absolute", Value: 40}, {Type: "Percent", Value: 100}},
			TableRows:    []TrackSpec{{Type: "AutoSize"}, {Type: "AutoSize"}}},
		Op{Op: "add", ID: "inCell", Type: "Button", Text: "in", Parent: "cTableLayoutPanel", W: 10, H: 10, Cell: &CellSpec{Column: 1, Row: 1}},
		Op{Op: "add", ID: "spanning", Type: "Label", Text: "span", Parent: "cTableLayoutPanel", W: 10, H: 10, Cell: &CellSpec{Column: 0, Row: 0, ColumnSpan: 2}},
		Op{Op: "setProp", Prop: "backColor", Value: "#ffffff"},
		Op{Op: "setProp", Prop: "padding", Value: "4"},
	)
	// A control of the project's own, found the way the toolbox finds it.
	write("Controls/Widgets/widgets.go", gaugeSource)
	if _, err := projectControls(root); err != nil {
		t.Fatal(err)
	}
	ops = append(ops,
		Op{Op: "add", ID: "gauge1", Type: "widgets.Gauge", Custom: catalog["widgets.Gauge"].Custom, W: 100, H: 50,
			Props: map[string]string{"anchor": "AnchorTop,AnchorLeft", "visible": "false"}},
		Op{Op: "add", ID: "inGauge", Type: "Button", Text: "in", Parent: "gauge1", W: 10, H: 10},
		Op{Op: "add", ID: "badge1", Type: "widgets.Badge", Custom: catalog["widgets.Badge"].Custom, W: 50, H: 20},
	)
	if _, err := applyOps(designer, ops); err != nil {
		t.Fatal(err)
	}
	for _, h := range handlers {
		f := strings.Fields(h)
		param := "goforms." + strings.TrimPrefix(f[1], "*")
		if strings.HasPrefix(f[1], "*") {
			param = "*" + param
		}
		if _, err := ensureHandler(designer, "MainForm", "mf", f[0], param); err != nil {
			t.Fatal(err)
		}
	}

	if out, err := buildWasm(root); err != nil {
		src, _ := os.ReadFile(designer)
		t.Fatalf("generated code does not build:\n%s\n--- designer file ---\n%s", out, src)
	}

	// And the tool reads back everything it wrote.
	back, err := parseFile(designer)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range back.model.Controls {
		desc := catalog[c.Type]
		if c.ID != "c"+c.Type {
			continue // the extra controls added after the sweep
		}
		if !c.Supported || c.CollectionReadOnly || c.TableReadOnly {
			t.Errorf("%s read back as unsupported or read-only", c.ID)
		}
		if desc != nil && !desc.NonVisual && desc.Custom == nil && c.ToolTips["cToolTip"] != "tip" {
			t.Errorf("%s lost its tip", c.ID)
		}
		if desc != nil && len(desc.Bindable) > 0 && c.Bindings[desc.Bindable[0]].Member != "Name" {
			t.Errorf("%s lost its binding", c.ID)
		}
		for _, p := range desc.Special {
			if c.Props[p] != "resources/dot.png" {
				t.Errorf("%s.%s reads %q", c.ID, p, c.Props[p])
			}
		}
	}
	if back.model.FormProps["icon"] != "resources/dot.png" {
		t.Errorf("the form's icon reads %q", back.model.FormProps["icon"])
	}
}

// compileModule lays out an app module that builds against the framework
// checkout, with a main.go running the given form, and returns its root and
// a writer for further files.
func compileModule(t *testing.T, framework, run, formImport string) (string, func(rel, content string)) {
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
	gomod, err := os.ReadFile(filepath.Join(framework, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	gosum, _ := os.ReadFile(filepath.Join(framework, "go.sum"))
	// The app needs the framework's own requirements; borrowing its go.mod
	// lines keeps the versions identical to what it was tested with.
	require := gomod[strings.Index(string(gomod), "require"):]
	write("go.mod", "module example.com/compilecheck\n\ngo 1.23.0\n\nrequire "+goformsImportPath+" v0.0.0\n\nreplace "+goformsImportPath+" => "+filepath.ToSlash(framework)+"\n\n"+string(require))
	write("go.sum", string(gosum))
	write("main.go", `package main

import (
	"github.com/Go-Forms/GoForms"

	form "`+formImport+`"
)

func main() {
	goforms.NewApplication("com.example.compilecheck")
	goforms.Run(form.`+strings.TrimPrefix(run, "mainform.")+`)
}
`)
	return root, write
}

// buildWasm builds the module for js/wasm, which needs no C toolchain.
func buildWasm(root string) ([]byte, error) {
	cmd := exec.Command("go", "build", "-o", os.DevNull, ".")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm", "GOFLAGS=-mod=mod")
	return cmd.CombinedOutput()
}

// TestFormTemplatesBuildAndOpen checks the extension's New Form templates
// (templates/forms): each one must open in the designer with every control
// recognized, and build against the framework.
func TestFormTemplatesBuildAndOpen(t *testing.T) {
	kinds, err := os.ReadDir(filepath.Join("..", "templates", "forms"))
	if err != nil {
		t.Fatal(err)
	}
	framework := os.Getenv("GOFORMS_DIR")
	for _, k := range kinds {
		t.Run(k.Name(), func(t *testing.T) {
			sub := func(b []byte) string {
				return strings.NewReplacer("{{FORM}}", "SampleForm", "{{PACKAGE}}", "sampleform").Replace(string(b))
			}
			designer, err := os.ReadFile(filepath.Join("..", "templates", "forms", k.Name(), "FORM-designer.go"))
			if err != nil {
				t.Fatal(err)
			}
			logic, err := os.ReadFile(filepath.Join("..", "templates", "forms", k.Name(), "FORM.go"))
			if err != nil {
				t.Fatal(err)
			}
			path := writeFixture(t, sub(designer))
			r, err := parseFile(path)
			if err != nil {
				t.Fatal(err)
			}
			fields := strings.Count(sub(designer), "*goforms.") - 1 // the embedded *goforms.Form
			if len(r.model.Controls) != fields {
				t.Errorf("the designer reads %d controls, the template declares %d", len(r.model.Controls), fields)
			}
			if framework == "" {
				return
			}
			fw, _ := filepath.Abs(framework)
			root, write := compileModule(t, fw, "NewSampleForm().Form", "example.com/compilecheck/Forms/SampleForm")
			write("Forms/SampleForm/SampleForm-designer.go", sub(designer))
			write("Forms/SampleForm/SampleForm.go", sub(logic))
			if out, err := buildWasm(root); err != nil {
				t.Fatalf("template does not build:\n%s", out)
			}
		})
	}
}
