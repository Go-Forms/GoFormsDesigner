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
	"strconv"
)

// planImportEdits returns the edits that add every path in need that the file
// does not already import, or nothing when it has them all.
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
	for _, p := range need {
		if have[p] {
			continue
		}
		have[p] = true // a type listing the same path twice asks for it once
		missing = append(missing, p)
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
				text += "\n\t" + strconv.Quote(p)
			}
			return []edit{{at, at, text}}
		}
		// A single unparenthesized import - `import "goforms"` - has to be
		// widened into a block before anything can join it.
		start, end := offset(r.fset, gd.Pos()), offset(r.fset, gd.End())
		text := "import (\n\t" + string(r.src[start+len("import "):end])
		for _, p := range missing {
			text += "\n\t" + strconv.Quote(p)
		}
		text += "\n)"
		return []edit{{start, end, text}}
	}

	// No import declaration at all: open one after the package clause.
	at := offset(r.fset, r.file.Name.End())
	text := "\n\nimport ("
	for _, p := range missing {
		text += "\n\t" + strconv.Quote(p)
	}
	text += "\n)"
	return []edit{{at, at, text}}
}
