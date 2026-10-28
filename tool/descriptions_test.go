package main

import "testing"

// Every property and event the panel can show has a line of help under it.
// A new property without one is not wrong, just unexplained - so this keeps
// the list complete rather than letting it rot one control at a time.
func TestEveryPropertyAndEventIsDescribed(t *testing.T) {
	check := func(typ string, desc *ControlDesc, events []string) {
		got := descriptionsFor(typ, propNames(desc), events)
		for _, p := range propNames(desc) {
			if got[p] == "" {
				t.Errorf("%s.%s has no description", typ, p)
			}
		}
		for _, ev := range events {
			if got[ev] == "" {
				t.Errorf("%s's %s event has no description", typ, ev)
			}
		}
	}
	for typ, desc := range catalog {
		merged := *desc
		merged.Setters = map[string]string{}
		for m, p := range desc.Setters {
			merged.Setters[m] = p
		}
		if !desc.NonVisual {
			for m, p := range baseProps {
				merged.Setters[m] = p
			}
		}
		check(typ, &merged, allEventsFor(desc))
	}
	check("Form", formDesc, allEventsFor(formDesc))
}
