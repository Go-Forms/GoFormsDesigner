package main

import (
	"strings"
	"testing"
)

// Each style kind is written as the goforms call it stands for and read back
// as the same wire value, so a round trip through the file changes nothing.
func TestStylePropsRoundTrip(t *testing.T) {
	cases := []struct {
		prop, value, code string
	}{
		{"foreColor", "#c81e1e", "SetForeColor(goforms.RGB(200, 30, 30))"},
		{"backColor", "#00000080", "SetBackColor(goforms.RGBA(0, 0, 0, 128))"},
		{"font", "Sans, 14, Bold", `SetFont(goforms.NewFont("Sans", 14, true, false))`},
		{"font", ", 9.5, Bold, Italic", `SetFont(goforms.NewFont("", 9.5, true, true))`},
		{"padding", "8", "SetPadding(goforms.NewPadding(8))"},
		{"padding", "4, 2, 4, 2", "SetPadding(goforms.Padding{Left: 4, Top: 2, Right: 4, Bottom: 2})"},
		{"visible", "false", "SetVisible(false)"},
		{"enabled", "false", "SetEnabled(false)"},
	}
	for _, c := range cases {
		path := writeFixture(t, designerFixture)
		model, src := mustApply(t, path, Op{Op: "setProp", ID: "lblWelcome", Prop: c.prop, Value: c.value})
		if !strings.Contains(src, "mf.lblWelcome."+c.code) {
			t.Errorf("%s=%q: want %s in\n%s", c.prop, c.value, c.code, src)
		}
		if got := findControl(t, model, "lblWelcome").Props[c.prop]; got != strings.TrimPrefix(c.value, " ") && got != c.value {
			t.Errorf("%s=%q read back as %q", c.prop, c.value, got)
		}
	}
}

func TestPaddingWithTheSameSideAllRoundIsWrittenShort(t *testing.T) {
	path := writeFixture(t, designerFixture)
	_, src := mustApply(t, path, Op{Op: "setProp", ID: "lblWelcome", Prop: "padding", Value: "3, 3, 3, 3"})
	if !strings.Contains(src, "goforms.NewPadding(3)") {
		t.Errorf("want NewPadding(3):\n%s", src)
	}
}

func TestStylePropsRejectGarbage(t *testing.T) {
	for prop, v := range map[string]string{"foreColor": "red", "font": "Sans", "padding": "1, 2"} {
		path := writeFixture(t, designerFixture)
		if _, err := applyOps(path, []Op{{Op: "setProp", ID: "lblWelcome", Prop: prop, Value: v}}); err == nil {
			t.Errorf("%s accepted %q", prop, v)
		}
	}
}

func TestFormBackColorAndPadding(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path, Op{Op: "setProp", Prop: "backColor", Value: "#ffffff"}, Op{Op: "setProp", Prop: "padding", Value: "12"})
	if !strings.Contains(src, "mf.SetBackColor(goforms.RGB(255, 255, 255))") || !strings.Contains(src, "mf.SetPadding(goforms.NewPadding(12))") {
		t.Errorf("form style not written:\n%s", src)
	}
	if model.FormProps["backColor"] != "#ffffff" || model.FormProps["padding"] != "12" {
		t.Errorf("form props = %v", model.FormProps)
	}
}
