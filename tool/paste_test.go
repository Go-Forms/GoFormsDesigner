package main

import (
	"strings"
	"testing"
)

// A paste is an "add" that carries the whole copied control: its
// properties, events, items and place. What comes back must be the control
// that was copied, under its new name.
func TestAddCarriesACopiedControlWhole(t *testing.T) {
	path := writeFixture(t, designerFixture)
	model, src := mustApply(t, path,
		Op{Op: "add", ID: "cmbSize", Type: "ComboBox", X: 10, Y: 40, W: 120, H: 30,
			Items:  []string{"Small", "Large"},
			Props:  map[string]string{"placeholder": "Pick one", "anchor": "AnchorTop,AnchorRight", "visible": "false"},
			Events: map[string]string{"SelectedIndexChanged": "cmbSize_SelectedIndexChanged"}},
	)
	c := findControl(t, model, "cmbSize")
	if strings.Join(c.Items, "|") != "Small|Large" {
		t.Errorf("items = %v", c.Items)
	}
	for prop, want := range map[string]string{"placeholder": "Pick one", "anchor": "AnchorTop,AnchorRight", "visible": "false"} {
		if c.Props[prop] != want {
			t.Errorf("%s = %q, want %q", prop, c.Props[prop], want)
		}
	}
	if c.Events["SelectedIndexChanged"] != "cmbSize_SelectedIndexChanged" {
		t.Errorf("events = %v", c.Events)
	}
	if !strings.Contains(src, `goforms.NewComboBox("Small", "Large")`) {
		t.Errorf("items not in the constructor:\n%s", src)
	}
}

func TestAddRefusesAPastedEventTheTypeDoesNotRaise(t *testing.T) {
	path := writeFixture(t, designerFixture)
	_, err := applyOps(path, []Op{{Op: "add", ID: "lbl2", Type: "Label", W: 50, H: 20,
		Events: map[string]string{"CellClick": "x_CellClick"}}})
	if err == nil || !strings.Contains(err.Error(), "CellClick") {
		t.Fatalf("want an error naming the event, got %v", err)
	}
	if got := readBack(t, path); got != designerFixture {
		t.Errorf("a refused add changed the file")
	}
}

func TestAddRefusesAHandlerThatIsNotAnIdentifier(t *testing.T) {
	path := writeFixture(t, designerFixture)
	if _, err := applyOps(path, []Op{{Op: "add", ID: "btn2", Type: "Button", W: 50, H: 20,
		Events: map[string]string{"Click": "do it"}}}); err == nil {
		t.Fatal("a handler name with a space was written")
	}
}
