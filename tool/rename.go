package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// planRename renames a control: its struct field, every `<recv>.<old>`
// reference in the designer file, and - because the designer generates
// handler names from the control's name - any wired handler still called
// `<old>_<Event>`.
//
// The handler rename spans a second file (the hand-written counterpart), so
// it can't be expressed as an edit to the designer file. planRename returns
// the designer-file edits and reports the handler renames it also performed
// separately; applyOps calls renameHandlersInPairedFile for those.
func planRename(r *parseResult, op Op) ([]edit, error) {
	oldID := op.ID
	newID := op.Value

	pc, err := mustControl(r, oldID)
	if err != nil {
		return nil, err
	}
	if err := validateGoIdent(newID); err != nil {
		return nil, err
	}
	if newID == oldID {
		return nil, nil
	}
	if _, taken := r.controls[newID]; taken {
		return nil, fmt.Errorf("a control named %q already exists", newID)
	}
	if _, taken := r.groups[newID]; taken {
		return nil, fmt.Errorf("a radio group named %q already exists", newID)
	}

	recv := r.model.RecvVar
	var edits []edit

	// 1. Every `<recv>.<old>` selector anywhere in the file. Matching on the
	// receiver as well as the name is what keeps an unrelated local variable
	// or another type's field of the same name from being renamed too.
	ast.Inspect(r.file, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != oldID {
			return true
		}
		if id, ok := sel.X.(*ast.Ident); !ok || id.Name != recv {
			return true
		}
		edits = append(edits, edit{
			offset(r.fset, sel.Sel.Pos()),
			offset(r.fset, sel.Sel.End()),
			newID,
		})
		return true
	})

	// 2. The struct field declaration itself, which is not a selector.
	fieldPos, ok := findStructFieldIdent(r, oldID)
	if !ok {
		return nil, fmt.Errorf("could not find the struct field for %q", oldID)
	}
	edits = append(edits, edit{
		offset(r.fset, fieldPos.Pos()),
		offset(r.fset, fieldPos.End()),
		newID,
	})

	// 3. Handler references that follow the generated `<id>_<Event>` naming.
	// Renaming the reference here and the method in the paired file keeps
	// the pair consistent; a handler the developer named something else is
	// deliberately left alone.
	for event, handler := range pc.spec.Events {
		if !strings.HasPrefix(handler, oldID+"_") {
			continue
		}
		newHandler := newID + strings.TrimPrefix(handler, oldID)
		ast.Inspect(r.file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != handler {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); !ok || id.Name != recv {
				return true
			}
			edits = append(edits, edit{
				offset(r.fset, sel.Sel.Pos()),
				offset(r.fset, sel.Sel.End()),
				newHandler,
			})
			return true
		})
		_ = event
	}

	return edits, nil
}

// renamedHandlers lists the `<old>_<Event>` -> `<new>_<Event>` method
// renames a rename implies, for the paired file.
func renamedHandlers(pc *pcontrol, oldID, newID string) map[string]string {
	out := map[string]string{}
	for _, handler := range pc.spec.Events {
		if strings.HasPrefix(handler, oldID+"_") {
			out[handler] = newID + strings.TrimPrefix(handler, oldID)
		}
	}
	return out
}

// renameHandlersInPairedFile renames handler *methods* in the hand-written
// counterpart of a designer file. It is a no-op when the file doesn't exist
// or doesn't declare the method - a control can perfectly well be renamed
// before any handler is wired.
func renameHandlersInPairedFile(designerPath, receiverType string, renames map[string]string) error {
	if len(renames) == 0 {
		return nil
	}
	dir := filepath.Dir(designerPath)
	base := filepath.Base(designerPath)
	paired := filepath.Join(dir, strings.TrimSuffix(base, "-designer.go")+".go")

	src, err := os.ReadFile(paired)
	if err != nil {
		return nil // no counterpart file: nothing to rename
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, paired, src, parser.ParseComments)
	if err != nil {
		return fmt.Errorf("parse %s: %w", paired, err)
	}

	var edits []edit
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Recv == nil || len(fd.Recv.List) != 1 {
			continue
		}
		se, ok := fd.Recv.List[0].Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		if id, ok := se.X.(*ast.Ident); !ok || id.Name != receiverType {
			continue
		}
		if newName, ok := renames[fd.Name.Name]; ok {
			edits = append(edits, edit{
				fset.Position(fd.Name.Pos()).Offset,
				fset.Position(fd.Name.End()).Offset,
				newName,
			})
		}
	}
	if len(edits) == 0 {
		return nil
	}

	buf, err := spliceEdits(src, edits)
	if err != nil {
		return err
	}
	return os.WriteFile(paired, buf, 0o644)
}

// validateGoIdent rejects names that wouldn't compile as a struct field, so
// a bad rename is refused up front instead of corrupting the file.
func validateGoIdent(name string) error {
	if name == "" {
		return fmt.Errorf("the new name is empty")
	}
	for i, r := range name {
		if i == 0 && !unicode.IsLetter(r) && r != '_' {
			return fmt.Errorf("%q is not a valid Go identifier: it must start with a letter or underscore", name)
		}
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
			return fmt.Errorf("%q is not a valid Go identifier: %q is not allowed", name, r)
		}
	}
	if goKeywords[name] {
		return fmt.Errorf("%q is a Go keyword", name)
	}
	return nil
}

var goKeywords = map[string]bool{
	"break": true, "case": true, "chan": true, "const": true, "continue": true,
	"default": true, "defer": true, "else": true, "fallthrough": true, "for": true,
	"func": true, "go": true, "goto": true, "if": true, "import": true,
	"interface": true, "map": true, "package": true, "range": true, "return": true,
	"select": true, "struct": true, "switch": true, "type": true, "var": true,
}

// findStructFieldIdent locates the identifier of a control's struct field so
// the declaration can be renamed along with every use.
func findStructFieldIdent(r *parseResult, id string) (*ast.Ident, bool) {
	for _, decl := range r.file.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.TYPE {
			continue
		}
		for _, spec := range gd.Specs {
			ts, ok := spec.(*ast.TypeSpec)
			if !ok || ts.Name.Name != r.model.ReceiverType {
				continue
			}
			st, ok := ts.Type.(*ast.StructType)
			if !ok {
				continue
			}
			for _, field := range st.Fields.List {
				for _, name := range field.Names {
					if name.Name == id {
						return name, true
					}
				}
			}
		}
	}
	return nil, false
}
