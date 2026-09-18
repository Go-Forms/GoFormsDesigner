package main

import "testing"

// Every event whose argument is not a bare EventArgs must say so, or
// ensure-handler writes a stub whose signature does not satisfy
// Event.Handle and wiring the event stops the project compiling.
//
// This list is the core's own (grep for `Event[` in GoForms); when the
// framework grows an event with its own argument type, it belongs here too.
func TestEveryTypedEventDeclaresItsArgument(t *testing.T) {
	want := map[string]map[string]string{
		"DataGridView": {
			"CellClick":        "GridCellEventArgs",
			"SelectionChanged": "GridCellEventArgs",
			"CellButtonClick":  "GridCellEventArgs",
			"CellValueChanged": "GridCellValueEventArgs",
			"RowsChanged":      "EventArgs",
		},
	}
	for typ, events := range want {
		desc := catalog[typ]
		if desc == nil {
			t.Fatalf("no catalog entry for %q", typ)
		}
		for ev, arg := range events {
			got, ok := eventArgType(desc, ev)
			if !ok {
				t.Errorf("%s has no %q event", typ, ev)
				continue
			}
			if got != arg {
				t.Errorf("%s.%s argument = %q, want %q", typ, ev, got, arg)
			}
		}
	}
}
