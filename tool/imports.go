package main

// imports.go teaches "add" to bring an import with the control that needs it.
//
// Most constructors need nothing but goforms, which a designer file imports
// by definition. Two do not: DateTimePicker and MonthCalendar are seeded with
// time.Now(), and dropping one on a form that had no reason to import "time"
// produced a file that simply did not compile - a palette item that broke the
// build. The catalog says which paths a type needs and this adds the ones the
// file is missing, as part of the same atomic batch as the control itself.

import (
	"go/ast"
	"go/token"
	"os"
	"strconv"
	"strings"
)

// planImportEdits returns the edits that add every import spec in need that
// the file does not already import, or nothing when it has them all. A spec
// is a quoted path, `"time"`, or a named one, `widgets "example.com/app/widgets"`.
//
// Everything is inserted at one point, so the result is a single edit and can
// never overlap the block insertion that goes with it.
func planImportEdits(r *parseResult, need []string) []edit {
	if len(need) == 0 || r.file == nil {
		return nil
	}

	have := map[string]bool{}
	for _, imp := range r.file.Imports {
		if p, err := strconv.Unquote(imp.Path.Value); err == nil {
			have[p] = true
		}
	}
	var missing []string
	for _, spec := range need {
		quoted := spec[strings.Index(spec, `"`):]
		p, err := strconv.Unquote(quoted)
		if err != nil || have[p] {
			continue
		}
		have[p] = true // a type listing the same path twice asks for it once
		missing = append(missing, spec)
	}
	if len(missing) == 0 {
		return nil
	}

	for _, decl := range r.file.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.IMPORT {
			continue
		}
		if gd.Lparen.IsValid() {
			// Straight into the existing block; gofmt sorts it afterwards.
			at := offset(r.fset, gd.Lparen) + 1
			var text string
			for _, p := range missing {
				text += "\n\t" + p
			}
			return []edit{{at, at, text}}
		}
		// A single unparenthesized import - `import "goforms"` - has to be
		// widened into a block before anything can join it.
		start, end := offset(r.fset, gd.Pos()), offset(r.fset, gd.End())
		text := "import (\n\t" + string(r.src[start+len("import "):end])
		for _, p := range missing {
			text += "\n\t" + p
		}
		text += "\n)"
		return []edit{{start, end, text}}
	}

	// No import declaration at all: open one after the package clause.
	at := offset(r.fset, r.file.Name.End())
	text := "\n\nimport ("
	for _, p := range missing {
		text += "\n\t" + p
	}
	text += "\n)"
	return []edit{{at, at, text}}
}

// pruneImports deletes the imports the designer file no longer uses - the
// package of the last project control removed from the form, or "time" once
// its date picker is gone. An unused import does not compile, so deleting
// one can never break a file; blank and dot imports are left alone, being
// used in ways a reference count cannot see.
func pruneImports(path string) error {
	r, err := parseFile(path)
	if err != nil {
		return nil // not this pass's to report; the caller re-parses anyway
	}
	used := map[string]bool{}
	ast.Inspect(r.file, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok {
				used[id.Name] = true
			}
		}
		return true
	})
	var edits []edit
	for _, imp := range r.file.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			continue
		}
		name := p[strings.LastIndex(p, "/")+1:]
		if p == goformsImportPath {
			name = goformsPkg
		}
		if imp.Name != nil {
			name = imp.Name.Name
		}
		if name == "_" || name == "." || used[name] {
			continue
		}
		edits = addLineDelete(edits, r.src, offset(r.fset, imp.Pos()), offset(r.fset, imp.End()))
	}
	if len(edits) == 0 {
		return nil
	}
	buf, err := spliceEdits(r.src, edits)
	if err != nil {
		return err
	}
	return os.WriteFile(path, buf, 0o644)
}
