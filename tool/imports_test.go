package main

import (
	"strings"
	"testing"
)

// Dropping a DateTimePicker used to write time.Now() into a file that had no
// reason to import "time" - a palette item that broke the build.
func TestAddBringsTheImportItNeeds(t *testing.T) {
	path := writeFixture(t, slotFixture)
	_, src := mustApply(t, path, Op{
		Op: "add", ID: "dtpWhen", Type: "DateTimePicker", X: 10, Y: 10, W: 150, H: 30,
	})

	if !strings.Contains(src, `"time"`) {
		t.Errorf("time.Now() was written without the import:\n%s", src)
	}
	if !strings.Contains(src, "goforms.NewDateTimePicker(time.Now())") {
		t.Errorf("the control was not generated:\n%s", src)
	}
}

// A file that already imports it must not get a second copy.
func TestAddDoesNotDuplicateAnImport(t *testing.T) {
	path := writeFixture(t, slotFixture)
	mustApply(t, path, Op{Op: "add", ID: "dtpOne", Type: "DateTimePicker", W: 150, H: 30})
	_, src := mustApply(t, path, Op{Op: "add", ID: "dtpTwo", Type: "MonthCalendar", W: 260, H: 271})

	if got := strings.Count(src, `"time"`); got != 1 {
		t.Errorf(`"time" appears %d times, want 1:%s`, got, src)
	}
}

// Everything else keeps the single-import file it had.
func TestAddLeavesImportsAloneWhenNothingIsNeeded(t *testing.T) {
	path := writeFixture(t, slotFixture)
	_, src := mustApply(t, path, Op{Op: "add", ID: "btnPlain", Type: "Button", W: 90, H: 30, Text: "x"})
	if strings.Contains(src, "import (") {
		t.Errorf("the import was widened into a block for no reason:\n%s", src)
	}
}
