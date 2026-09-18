package main

// tidy.go is the designer file's garbage collector.
//
// A *-designer.go file is machine-managed, and a long editing session leaves
// litter behind: a setter written once per drag, an event re-wired five times
// into five stacked Handle calls, a control added twice, a statement someone
// commented out instead of deleting. None of it is visible in the designer -
// the model only ever reflects the last value - so it accumulates silently
// until the file is unreadable by hand.
//
// Every rule here rewrites the file to what it already *means* at runtime, so
// tidying can run unattended after each apply. Two properties make that safe:
//
//   - Only statements the catalog recognizes are touched. Anything the tool
//     does not model (a Timer, a MenuStrip, a loop, a helper call) is left
//     exactly where it is, the same guarantee apply gives.
//   - The result must still parse, or the file is left untouched.

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strings"
)

// TidyResult is tidy's JSON output. Removed lists the discarded source lines,
// trimmed, so the extension can tell the user what went rather than just how
// much.
type TidyResult struct {
	File       string   `json:"file"`
	Changed    bool     `json:"changed"`
	Statements int      `json:"statements"` // redundant calls dropped
	Fields     int      `json:"fields"`     // duplicate struct fields dropped
	Comments   int      `json:"comments"`   // commented-out generated lines dropped
	Moved      int      `json:"moved"`      // blocks put back after their parent's
	Removed    []string `json:"removed"`
}

// Total is how many lines tidy removed in all.
func (t *TidyResult) Total() int { return t.Statements + t.Fields + t.Comments }

// tidyFile rewrites path in place, and reports what it dropped. A file with
// nothing to clean is not rewritten at all, so tidying on every save does not
// churn mtimes or wake file watchers for no reason.
func tidyFile(path string) (*TidyResult, error) {
	r, err := parseFile(path)
	if err != nil {
		return nil, err
	}
	res := &TidyResult{File: path}

	var edits []edit
	edits = appendStmtEdits(r, res, edits)
	edits = appendFieldEdits(r, res, edits)
	edits = appendCommentEdits(r, res, edits)

	if len(edits) > 0 {
		buf, err := spliceEdits(r.src, edits)
		if err != nil {
			return nil, err
		}
		// gofmt last: deleting lines out of the middle of a block leaves runs of
		// blank lines behind, which is its own kind of litter.
		formatted, err := format.Source(buf)
		if err != nil {
			return nil, fmt.Errorf("tidy would leave %s unparseable, so nothing was changed: %w", path, err)
		}
		if !bytes.Equal(formatted, r.src) {
			if err := os.WriteFile(path, formatted, 0o644); err != nil {
				return nil, fmt.Errorf("write %s: %w", path, err)
			}
			res.Changed = true
		}
	}

	// A control parented to a container declared below it is a nil dereference
	// at form load, not litter - but it is the same kind of damage tidy exists
	// to undo, and this is the only command that reaches a file the designer
	// never wrote (see reorder.go). It runs after the deletions above, so the
	// blocks it moves are the ones that survived them.
	moved, err := reorderFile(path)
	if err != nil {
		return nil, fmt.Errorf("tidy could not reorder %s, so nothing was changed there: %w", path, err)
	}
	if moved > 0 {
		res.Moved = moved
		res.Changed = true
	}
	return res, nil
}

// appendStmtEdits drops every statement in initializeComponent that a later
// statement already overrides.
//
// The unit of redundancy is a key: two statements sharing one state the same
// single fact about the form, so only the last of them is observable.
func appendStmtEdits(r *parseResult, res *TidyResult, edits []edit) []edit {
	if r.initBody == nil {
		return edits
	}

	seen := map[string]ast.Stmt{}
	var doomed []ast.Stmt

	for _, stmt := range r.initBody.List {
		key, ok := stmtKey(r, stmt)
		if !ok {
			continue
		}
		// The last statement to state a fact is the one that decides it, at
		// runtime and in the model parse.go builds - so it is the one kept,
		// and the earlier ones are dead code by the time they are reached.
		if prev, dup := seen[key]; dup {
			doomed = append(doomed, prev)
		}
		seen[key] = stmt
	}

	for _, stmt := range doomed {
		var removed bool
		if edits, removed = deleteLine(edits, r, stmt.Pos(), stmt.End(), res); removed {
			res.Statements++
		}
	}
	return edits
}

// deleteLine plans the removal of the whole line(s) a node sits on and
// records the text for the report, unless an edit already covers them.
//
// The node's own positions go to addLineDelete unexpanded: it aligns them to
// line boundaries itself, and an already-aligned end offset - the first byte
// of the *next* line - would be read as mid-line and swallow that line too.
func deleteLine(edits []edit, r *parseResult, pos, end token.Pos, res *TidyResult) ([]edit, bool) {
	before := len(edits)
	edits = addLineDelete(edits, r.src, offset(r.fset, pos), offset(r.fset, end))
	if len(edits) == before {
		return edits, false
	}
	e := edits[len(edits)-1]
	res.Removed = append(res.Removed, trimLines(r.src, e.start, e.end))
	return edits, true
}

// stmtKey names the single fact a statement states, when it states one at
// all. Two statements sharing a key are two answers to one question, and the
// file can only be acting on the last of them.
func stmtKey(r *parseResult, stmt ast.Stmt) (key string, ok bool) {
	// mf.dlgOpen.Title = "x" - the tray components' properties are exported
	// fields, so their "last one wins" duplicates are assignments rather
	// than calls, and the call-shaped check below would never see them.
	if assign, isAssign := stmt.(*ast.AssignStmt); isAssign {
		return fieldAssignKey(r, assign)
	}

	expr, isExpr := stmt.(*ast.ExprStmt)
	if !isExpr {
		return "", false
	}
	call, isCall := expr.X.(*ast.CallExpr)
	if !isCall {
		return "", false
	}
	recv := r.model.RecvVar

	// Adding one control to a container, in any of the shapes that do it:
	// mf.AddControl(mf.btn), mf.panel.AddControl(mf.btn),
	// mf.split.Panel1().AddControl(mf.btn), mf.tabs.TabPages()[0].AddControl(mf.btn).
	// The control ends up under whichever container claimed it last, so an
	// earlier add is not a second parent - it is a stale one.
	if sel, isSel := call.Fun.(*ast.SelectorExpr); isSel && sel.Sel.Name == "AddControl" && len(call.Args) == 1 {
		if argParts, isChain := selChain(call.Args[0]); isChain && len(argParts) == 2 && argParts[0] == recv {
			if _, known := r.controls[argParts[1]]; known {
				return "add:" + argParts[1], true
			}
		}
	}

	parts, isChain := selChain(call.Fun)
	if !isChain || len(parts) < 2 || parts[0] != recv {
		return "", false
	}

	switch {
	// mf.field.Event.Handle(mf.method) and the Form's own mf.Event.Handle.
	// Event.Handle is multicast, so stacked calls do not replace each other -
	// they make one click run three handlers. The designer models a single
	// handler per event, and parse.go already reports only the last one, so
	// the file is brought in line with what the designer shows.
	case len(parts) == 4 && parts[3] == "Handle":
		if _, known := r.controls[parts[1]]; known {
			return "event:" + parts[1] + "." + parts[2], true
		}
	case len(parts) == 3 && parts[2] == "Handle":
		return "event:" + recv + "." + parts[1], true

	// mf.field.SetXxx(v) for a setter the catalog models: one value, last
	// call wins. Deliberately not "any method starting with Set" - an indexed
	// setter like SetColumnStyle(0, ...) says something different on every
	// call, and collapsing those would destroy a table's layout.
	case len(parts) == 3:
		if pc, known := r.controls[parts[1]]; known && modelledSetter(pc.spec.Type, parts[2]) {
			return "set:" + parts[1] + "." + parts[2], true
		}
	}

	// Anything else states nothing the model owns, and tidy has no way to
	// know whether repeating it means something. `RemoveAt(0)` twice removes
	// two items; `AddTab("Page")` twice makes two pages. Left alone.
	return "", false
}

// fieldAssignKey names the property a `<recv>.<field>.<Name> = ...`
// statement writes, for the components configured that way. Only the fields
// the catalog models are collapsed: an assignment to something this tool
// does not understand may not be a property at all.
func fieldAssignKey(r *parseResult, s *ast.AssignStmt) (string, bool) {
	if s.Tok != token.ASSIGN || len(s.Lhs) != 1 {
		return "", false
	}
	parts, isChain := selChain(s.Lhs[0])
	if !isChain || len(parts) != 3 || parts[0] != r.model.RecvVar {
		return "", false
	}
	pc, known := r.controls[parts[1]]
	if !known {
		return "", false
	}
	if _, modelled := fieldProp(catalog[pc.spec.Type], parts[2]); !modelled {
		return "", false
	}
	return "field:" + parts[1] + "." + parts[2], true
}

// alwaysModelled are the setters every control understands regardless of
// type, alongside the per-type ones the catalog lists.
var alwaysModelled = map[string]bool{
	"SetBounds":     true,
	"SetText":       true,
	"SetItems":      true,
	"SetClientSize": true,
}

// modelledSetter reports whether a method is one of the single-value setters
// the designer itself writes, and can therefore safely collapse.
func modelledSetter(controlType, method string) bool {
	if alwaysModelled[method] || baseProps[method] != "" {
		return true
	}
	desc, ok := catalog[controlType]
	if !ok {
		return false
	}
	_, ok = desc.Setters[method]
	return ok
}

// appendFieldEdits drops repeated declarations of one struct field, keeping
// the first. Go rejects a duplicate field outright, so a file needing this is
// already broken - tidy is what gets it compiling again.
func appendFieldEdits(r *parseResult, res *TidyResult, edits []edit) []edit {
	if r.structType == nil {
		return edits
	}
	seen := map[string]bool{}
	for _, field := range r.structType.Fields.List {
		if len(field.Names) != 1 {
			continue
		}
		name := field.Names[0].Name
		if !seen[name] {
			seen[name] = true
			continue
		}
		var removed bool
		if edits, removed = deleteLine(edits, r, field.Pos(), field.End(), res); removed {
			res.Fields++
		}
	}
	return edits
}

// appendCommentEdits drops lines that are nothing but a commented-out
// generated statement - the trail left by disabling a control by hand instead
// of deleting it. The designer cannot see them, so they only ever grow.
//
// The match is deliberately narrow: the comment must be alone on its line and
// its body must read as a call on the form's own receiver. A comment that
// explains something, even one that mentions the receiver, is left alone.
func appendCommentEdits(r *parseResult, res *TidyResult, edits []edit) []edit {
	if r.initBody == nil {
		return edits
	}
	bodyStart, bodyEnd := offset(r.fset, r.initBody.Lbrace), offset(r.fset, r.initBody.Rbrace)

	var groups []*ast.CommentGroup
	for _, g := range r.file.Comments {
		if offset(r.fset, g.Pos()) > bodyStart && offset(r.fset, g.End()) < bodyEnd {
			groups = append(groups, g)
		}
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Pos() < groups[j].Pos() })

	for _, g := range groups {
		for _, c := range g.List {
			if !isCommentedOutStmt(c.Text, r.model.RecvVar) {
				continue
			}
			// Only when the comment owns the whole line: a trailing comment
			// shares its line with live code, which has to stay.
			at := offset(r.fset, c.Pos())
			lineStart, _ := wholeLines(r.src, at, at)
			if strings.TrimSpace(string(r.src[lineStart:at])) != "" {
				continue
			}
			var removed bool
			if edits, removed = deleteLine(edits, r, c.Pos(), c.End(), res); removed {
				res.Comments++
			}
		}
	}
	return edits
}

// isCommentedOutStmt reports whether a `//` comment body is a disabled call
// on the form receiver, e.g. `// lf.button1.Click.Handle(lf.onClick)`.
func isCommentedOutStmt(text, recvVar string) bool {
	body := strings.TrimSpace(strings.TrimPrefix(text, "//"))
	if recvVar == "" || !strings.HasPrefix(body, recvVar+".") || !strings.HasSuffix(body, ")") {
		return false
	}
	stmt, err := parser.ParseExpr(body)
	if err != nil {
		return false
	}
	_, isCall := stmt.(*ast.CallExpr)
	return isCall
}

// trimLines renders a removed span as a single readable line for the report.
func trimLines(src []byte, start, end int) string {
	return strings.Join(strings.Fields(string(src[start:end])), " ")
}

// tidyIfNeeded is the hook every file-writing command runs through. Tidying
// is best-effort by design: a file that cannot be tidied is still a file the
// user asked to edit, so a failure here must never fail their edit.
func tidyIfNeeded(path string) *TidyResult {
	res, err := tidyFile(path)
	if err != nil {
		return &TidyResult{File: path}
	}
	return res
}
