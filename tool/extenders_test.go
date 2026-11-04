package main

import (
	"strings"
	"testing"
)

func TestAToolTipGivesAControlATip(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "toolTip1", Type: "ToolTip"},
		Op{Op: "setToolTip", ID: "lblWelcome", Prop: "toolTip1", Value: "Says hello"},
	)
	if !strings.Contains(src, `mf.toolTip1.SetToolTip(mf.lblWelcome, "Says hello")`) {
		t.Fatalf("no tip:\n%s", src)
	}
	if got := findControl(t, model, "lblWelcome").ToolTips["toolTip1"]; got != "Says hello" {
		t.Errorf("tip reads %q", got)
	}
	// The ToolTip, added last, is moved above the label that uses it, and
	// the tip sits in the label's block.
	if indexOfLine(t, src, "mf.toolTip1 = goforms.NewToolTip()") > indexOfLine(t, src, "mf.lblWelcome = goforms.NewLabel(\"Hello\")") {
		t.Errorf("the ToolTip is made after the label:\n%s", src)
	}
	if indexOfLine(t, src, "SetToolTip") > indexOfLine(t, src, "mf.AddControl(mf.lblWelcome)") {
		t.Errorf("the tip is outside the label's block:\n%s", src)
	}

	_, src = mustApply(t, path, Op{Op: "setToolTip", ID: "lblWelcome", Prop: "toolTip1", Value: "Hi"})
	if strings.Count(src, "SetToolTip") != 1 || !strings.Contains(src, `"Hi")`) {
		t.Errorf("rewrite:\n%s", src)
	}
	_, src = mustApply(t, path, Op{Op: "setToolTip", ID: "lblWelcome", Prop: "toolTip1", Value: ""})
	if strings.Contains(src, "SetToolTip") {
		t.Errorf("an empty tip was kept:\n%s", src)
	}
}

func TestDeletingAToolTipTakesItsTipsAlong(t *testing.T) {
	path := writeFixture(t, designerFixture)
	mustApply(t, path, Op{Op: "add", ID: "toolTip1", Type: "ToolTip"}, Op{Op: "setToolTip", ID: "lblWelcome", Prop: "toolTip1", Value: "x"})
	model, src := mustApply(t, path, Op{Op: "remove", ID: "toolTip1"})
	if strings.Contains(src, "toolTip1") {
		t.Errorf("toolTip1 survived:\n%s", src)
	}
	findControl(t, model, "lblWelcome")
}

func TestABindingSourceBindsGridsListsAndFields(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "grid", Type: "DataGridView", W: 200, H: 100, Items: []string{"Name"}},
		Op{Op: "add", ID: "lst", Type: "ListBox", W: 100, H: 100},
		Op{Op: "add", ID: "txt", Type: "TextBox", W: 100, H: 30},
		Op{Op: "add", ID: "bsCustomers", Type: "BindingSource"},
		Op{Op: "setProp", ID: "grid", Prop: "dataSource", Value: "bsCustomers"},
		Op{Op: "setColumns", ID: "grid", Columns: []GridColumnSpec{{Title: "Name", DataPropertyName: "Name"}}},
		Op{Op: "setProp", ID: "lst", Prop: "dataSource", Value: "bsCustomers"},
		Op{Op: "setProp", ID: "lst", Prop: "displayMember", Value: "Name"},
		Op{Op: "setBinding", ID: "txt", Prop: "Text", Value: "bsCustomers.Name"},
	)
	for _, want := range []string{
		"mf.grid.SetDataSource(mf.bsCustomers)",
		`mf.grid.SetColumnDataPropertyName(0, "Name")`,
		"mf.lst.SetDataSource(mf.bsCustomers)",
		`mf.lst.SetDisplayMember("Name")`,
		`mf.bsCustomers.Bind(mf.txt, "Text", "Name")`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("want %s in\n%s", want, src)
		}
	}
	if indexOfLine(t, src, "mf.bsCustomers = goforms.NewBindingSource()") > indexOfLine(t, src, "mf.grid.SetDataSource(mf.bsCustomers)") {
		t.Errorf("the source is made after the grid that uses it:\n%s", src)
	}
	if b := findControl(t, model, "txt").Bindings["Text"]; b != (BindingSpec{Source: "bsCustomers", Member: "Name"}) {
		t.Errorf("binding reads %+v", b)
	}
	if c := findControl(t, model, "grid").Columns[0]; c.DataPropertyName != "Name" {
		t.Errorf("column reads %+v", c)
	}

	// A property the control cannot bind is refused.
	if _, err := applyOps(path, []Op{{Op: "setBinding", ID: "txt", Prop: "Checked", Value: "bsCustomers.Active"}}); err == nil {
		t.Error("bound a TextBox's Checked")
	}
	// Unbinding, and deleting the source with everything that names it.
	_, src = mustApply(t, path, Op{Op: "setBinding", ID: "txt", Prop: "Text", Value: ""})
	if strings.Contains(src, ".Bind(") {
		t.Errorf("an unbound binding survived:\n%s", src)
	}
	_, src = mustApply(t, path, Op{Op: "remove", ID: "bsCustomers"})
	if strings.Contains(src, "bsCustomers") {
		t.Errorf("bsCustomers survived:\n%s", src)
	}
}

func TestAPastedControlBringsItsTipAndBinding(t *testing.T) {
	path := writeFixture(t, designerFixture)
	_, src := mustApply(t, path,
		Op{Op: "add", ID: "toolTip1", Type: "ToolTip"},
		Op{Op: "add", ID: "bs", Type: "BindingSource"},
		Op{Op: "add", ID: "txt2", Type: "TextBox", W: 100, H: 30,
			ToolTips: map[string]string{"toolTip1": "Name"},
			Bindings: map[string]BindingSpec{"Text": {Source: "bs", Member: "Name"}}},
	)
	if !strings.Contains(src, `mf.toolTip1.SetToolTip(mf.txt2, "Name")`) || !strings.Contains(src, `mf.bs.Bind(mf.txt2, "Text", "Name")`) {
		t.Errorf("paste lost its tip or binding:\n%s", src)
	}
	if _, err := applyOps(path, []Op{{Op: "add", ID: "txt3", Type: "TextBox", W: 1, H: 1, ToolTips: map[string]string{"nope": "x"}}}); err == nil {
		t.Error("a tip from a ToolTip that is not on the form was written")
	}
}
