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
	if err := validateControlName(newID); err != nil {
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

// renameInPairedFile carries a rename into the hand-written counterpart of a
// designer file: the handler *methods* whose names the designer generated,
// and every `<recv>.<oldID>` reference to the control itself.
//
// The references matter as much as the methods. A handler almost always uses
// the control it belongs to - `mf.btnGreet.SetEnabled(false)` - and renaming
// the field on one side of the pair while leaving the other pointing at the
// old name is not a half-finished rename, it is a project that no longer
// compiles.
//
// It is a no-op when the file doesn't exist or mentions none of this - a
// control can perfectly well be renamed before any handler is wired.
func renameInPairedFile(designerPath, receiverType, oldID, newID string, handlers map[string]string) error {
	if len(handlers) == 0 && oldID == newID {
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

		if newName, ok := handlers[fd.Name.Name]; ok {
			edits = append(edits, edit{
				fset.Position(fd.Name.Pos()).Offset,
				fset.Position(fd.Name.End()).Offset,
				newName,
			})
		}

		// The receiver is named per method here, not once per file, so each
		// body is searched for its own receiver rather than a global one.
		// A method that discards its receiver (`func (*MainForm) f()`) cannot
		// be referring to the field at all.
		if oldID == newID || len(fd.Recv.List[0].Names) != 1 {
			continue
		}
		recv := fd.Recv.List[0].Names[0].Name
		if recv == "_" {
			continue
		}
		ast.Inspect(fd.Body, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != oldID {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); !ok || id.Name != recv {
				return true
			}
			edits = append(edits, edit{
				fset.Position(sel.Sel.Pos()).Offset,
				fset.Position(sel.Sel.End()).Offset,
				newID,
			})
			return true
		})
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

// validateControlName is validateGoIdent plus the names a control may not
// take because the form already has them.
//
// A designer file's receiver embeds *goforms.Form, so every exported member
// of Form and ControlBase is promoted onto it. A struct field of the same
// name wins over the promoted member at depth 0 - quietly, with no error at
// the declaration - and the call sites break instead: name a button
// `AddControl` and `mf.AddControl(mf.other)` stops compiling, taking the
// whole file with it.
func validateControlName(name string) error {
	if err := validateGoIdent(name); err != nil {
		return err
	}
	if formMembers[name] {
		return fmt.Errorf("%q is already a member of the form (it comes from goforms.Form), "+
			"and a control by that name would hide it", name)
	}
	return nil
}

// formMembers are the exported methods and event fields a designer file's
// receiver inherits from the embedded *goforms.Form - i.e. every name a
// control field would shadow.
//
// It is a list rather than something derived, because the tool never loads
// the framework: it edits source text and has no idea what goforms.Form
// looks like. If Form grows a member, this grows with it; missing one costs
// a confusing compile error in a file the designer wrote, not corruption.
var formMembers = map[string]bool{
	// ControlBase and ContainerControl, promoted through Form.
	"AddControl": true, "RemoveControl": true, "Controls": true,
	"Anchor": true, "SetAnchor": true, "Dock": true, "SetDock": true,
	"Padding": true, "SetPadding": true, "Bounds": true, "SetBounds": true,
	"SetLocation": true, "SetSize": true, "Object": true, "Events": true,
	"Name": true, "SetName": true, "Tag": true, "SetTag": true,
	"Visible": true, "SetVisible": true, "Enabled": true, "SetEnabled": true,
	"Font": true, "SetFont": true, "FontSupported": true,
	"ForeColor": true, "SetForeColor": true, "BackColor": true, "SetBackColor": true,
	"TabIndex": true, "SetTabIndex": true, "TabStop": true, "SetTabStop": true,
	"SetContextMenu": true, "ContextMenuSupported": true, "ResetLayoutBaseline": true,
	"AutoScroll": true, "SetAutoScroll": true,

	// Form's own.
	"Show": true, "ShowDialog": true, "Hide": true, "Close": true,
	"CloseWithResult": true, "DialogResult": true, "CenterOnScreen": true,
	"ClientSize": true, "SetClientSize": true, "SetFixedSize": true,
	"SetIcon": true, "SetMainMenu": true, "Text": true, "SetText": true,
	"Window": true,
}

// The form's events are fields, not methods, and shadow just the same - so
// they come from the one table that already lists them rather than being
// written out again here.
func init() {
	for name := range baseEvents {
		formMembers[name] = true
	}
	for _, name := range []string{"Load", "Closing", "Closed"} {
		formMembers[name] = true
	}
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
