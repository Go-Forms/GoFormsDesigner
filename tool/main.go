// Command goformsdesigner is the headless engine behind the GoForms VS Code
// extension: it parses and edits *-designer.go files (see parse.go/apply.go)
// and manages paired event-handler stub methods (see ensurehandler.go). It
// is a plain CLI so the extension can shell out to it as a subprocess and
// exchange JSON over stdout/stdin, without embedding a Go parser in
// TypeScript.
//
// Usage:
//
//	goformsdesigner parse <designer.go>
//	goformsdesigner apply <designer.go>   (ops JSON array on stdin)
//	goformsdesigner ensure-handler <designer.go> <receiverType> <recvVar> <method> [paramType|none]
//	goformsdesigner tidy <designer.go>
//	goformsdesigner catalog
//	goformsdesigner categories
package main

import (
	"encoding/json"
	"io"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		stderrf("usage: goformsdesigner parse|apply|tidy|ensure-handler|catalog|categories ...")
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "parse":
		err = cmdParse(os.Args[2:])
	case "apply":
		err = cmdApply(os.Args[2:])
	case "tidy":
		err = cmdTidy(os.Args[2:])
	case "ensure-handler":
		err = cmdEnsureHandler(os.Args[2:])
	case "catalog":
		err = cmdCatalog()
	case "categories":
		err = cmdCategories()
	default:
		stderrf("unknown command %q", os.Args[1])
		os.Exit(2)
	}
	if err != nil {
		stderrf("error: %v", err)
		os.Exit(1)
	}
}

func cmdParse(args []string) error {
	if len(args) != 1 {
		return errUsage("parse <designer.go>")
	}
	r, err := parseFile(args[0])
	if err != nil {
		return err
	}
	return printJSON(r.model)
}

func cmdApply(args []string) error {
	if len(args) != 1 {
		return errUsage("apply <designer.go> (ops JSON array on stdin)")
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var ops []Op
	if err := json.Unmarshal(raw, &ops); err != nil {
		return err
	}
	model, err := applyOps(args[0], ops)
	if err != nil {
		return err
	}
	// Tidy after every batch, so the litter an edit creates - a superseded
	// setter, a re-wired event's old Handle line - never survives the edit
	// that created it. Best-effort: an un-tidyable file is still a file the
	// user successfully edited (see tidyIfNeeded).
	if res := tidyIfNeeded(args[0]); res.Changed {
		if fresh, err := parseFile(args[0]); err == nil {
			model = fresh.model
		}
	}
	return printJSON(model)
}

// cmdTidy is the same cleanup on demand, for the "GoForms: Tidy Designer
// File" command and for files edited by hand outside the designer.
func cmdTidy(args []string) error {
	if len(args) != 1 {
		return errUsage("tidy <designer.go>")
	}
	res, err := tidyFile(args[0])
	if err != nil {
		return err
	}
	return printJSON(res)
}

func cmdEnsureHandler(args []string) error {
	if len(args) < 4 || len(args) > 5 {
		// paramType "none" generates a parameterless stub - see noParams.
		return errUsage("ensure-handler <designer.go> <receiverType> <recvVar> <method> [paramType|none]")
	}
	paramType := "goforms.EventArgs"
	if len(args) == 5 {
		paramType = args[4]
	}
	res, err := ensureHandler(args[0], args[1], args[2], args[3], paramType)
	if err != nil {
		return err
	}
	return printJSON(res)
}

// cmdCatalog dumps the known control type table so the extension's toolbox
// palette and property panel can build themselves from a single source of
// truth instead of duplicating this list in TypeScript.
// cmdCatalog emits the palette with each type's Events already merged with
// the inherited ControlBase ones and EventArgs filled in for every entry, so
// the webview needs no second source of truth for what a control can raise
// or what argument type a generated handler must take.
func cmdCatalog() error {
	out := make(map[string]*ControlDesc, len(catalog))
	for name, desc := range catalog {
		merged := *desc
		// Merge the inherited ControlBase properties into every type, so the
		// webview has a single source of truth for what is editable.
		merged.Setters = map[string]string{}
		for m, p := range desc.Setters {
			merged.Setters[m] = p
		}
		merged.Kinds = map[string]string{}
		for p, k := range desc.Kinds {
			merged.Kinds[p] = k
		}
		merged.Enums = map[string][]string{}
		for p, v := range desc.Enums {
			merged.Enums[p] = v
		}
		for m, p := range baseProps {
			merged.Setters[m] = p
			merged.Kinds[p] = basePropKinds[p]
			if v, ok := basePropEnums[p]; ok {
				merged.Enums[p] = v
			}
		}
		merged.OwnEventCount = len(desc.Events)
		merged.Events = allEventsFor(desc)
		merged.EventArgs = map[string]string{}
		for _, ev := range merged.Events {
			if t, ok := eventArgType(desc, ev); ok {
				merged.EventArgs[ev] = t
			}
		}
		out[name] = &merged
	}
	return printJSON(out)
}

// cmdCategories emits the toolbox groups in display order, so the designer's
// Controls tab doesn't have to hardcode either the names or their sequence.
func cmdCategories() error {
	return printJSON(categoryOrder)
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

type usageError string

func (e usageError) Error() string { return "usage: goformsdesigner " + string(e) }

func errUsage(s string) error { return usageError(s) }
