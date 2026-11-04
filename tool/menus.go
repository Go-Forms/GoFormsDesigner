package main

// menus.go reads and writes a MenuStrip's and a ContextMenu's items.
//
// Unlike a ToolStrip, whose buttons are add calls after the constructor, a
// GoForms menu is built in one expression - the constructor holds the whole
// tree:
//
//	mf.menuStrip1 = goforms.NewMenuStrip(
//		goforms.NewTopMenu("File",
//			goforms.NewMenuItem("Open...").OnClick(mf.mnuOpen_Click),
//			goforms.NewMenuItem("Recent").Add(
//				goforms.NewMenuItem("report.txt"),
//			),
//			goforms.NewMenuSeparator(),
//			goforms.NewMenuItem("Exit").OnClick(mf.mnuExit_Click).SetEnabled(false),
//		),
//	)
//	mf.SetMainMenu(mf.menuStrip1)
//
// The model is the same flat list with depths a TreeView's nodes are, so the
// designer edits both with one editor; a MenuStrip's depth-0 items are its
// top menus.

import (
	"fmt"
	"go/ast"
	"strings"
)

// readMenu reads a menu constructor's arguments into the control's item
// list. Anything it cannot read back makes the list read-only, so a rewrite
// never drops code the designer did not understand.
func (r *parseResult) readMenu(pc *pcontrol, cd *CollectionDesc, call *ast.CallExpr) {
	pc.ctorCall = call
	ok := true
	for _, a := range call.Args {
		if cd.TopLevel != "" {
			ok = r.readTopMenu(a, cd.TopLevel, &pc.spec.Collection) && ok
		} else {
			ok = r.readMenuItem(a, 0, &pc.spec.Collection) && ok
		}
	}
	if !ok {
		pc.spec.CollectionReadOnly = true
	}
}

// readTopMenu reads `goforms.NewTopMenu("File", items...)`.
func (r *parseResult) readTopMenu(e ast.Expr, ctor string, out *[]CollectionItem) bool {
	call, ok := e.(*ast.CallExpr)
	if !ok || len(call.Args) == 0 {
		return false
	}
	parts, ok := selChain(call.Fun)
	if !ok || len(parts) != 2 || parts[0] != goformsPkg || parts[1] != ctor {
		return false
	}
	text, ok := litString(call.Args[0])
	if !ok {
		return false
	}
	*out = append(*out, CollectionItem{Text: text})
	good := true
	for _, a := range call.Args[1:] {
		good = r.readMenuItem(a, 1, out) && good
	}
	return good
}

// readMenuItem reads one item and the items under it:
// `goforms.NewMenuItem("t")`, then any of `.OnClick(mf.h)`,
// `.SetEnabled(false)` and `.Add(children...)` - or a
// `goforms.NewMenuSeparator()`.
func (r *parseResult) readMenuItem(e ast.Expr, depth int, out *[]CollectionItem) bool {
	type modifier struct {
		name string
		args []ast.Expr
	}
	var mods []modifier
	for {
		call, ok := e.(*ast.CallExpr)
		if !ok {
			return false
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		if inner, isCall := sel.X.(*ast.CallExpr); isCall {
			switch sel.Sel.Name {
			case "OnClick", "SetEnabled", "Add":
				mods = append([]modifier{{sel.Sel.Name, call.Args}}, mods...)
				e = inner
				continue
			}
			return false
		}
		parts, ok := selChain(call.Fun)
		if !ok || len(parts) != 2 || parts[0] != goformsPkg {
			return false
		}
		switch {
		case parts[1] == "NewMenuSeparator" && len(call.Args) == 0 && len(mods) == 0:
			*out = append(*out, CollectionItem{Kind: "separator", Depth: depth})
			return true
		case parts[1] == "NewMenuItem" && len(call.Args) == 1:
			text, ok := litString(call.Args[0])
			if !ok {
				return false
			}
			item := CollectionItem{Text: text, Depth: depth}
			var children []ast.Expr
			for _, m := range mods {
				switch m.name {
				case "OnClick":
					if len(m.args) != 1 {
						return false
					}
					hp, ok := selChain(m.args[0])
					if !ok || len(hp) != 2 || hp[0] != r.model.RecvVar || item.Handler != "" {
						return false
					}
					item.Handler = hp[1]
				case "SetEnabled":
					if len(m.args) != 1 {
						return false
					}
					on, ok := litBool(m.args[0])
					if !ok {
						return false
					}
					item.Disabled = !on
				case "Add":
					children = append(children, m.args...)
				}
			}
			*out = append(*out, item)
			good := true
			for _, c := range children {
				good = r.readMenuItem(c, depth+1, out) && good
			}
			return good
		}
		return false
	}
}

// menuCtor renders a menu's constructor from its item list - the inverse of
// readMenu.
func menuCtor(recvVar string, spec *ControlSpec, cd *CollectionDesc, ctor string) (string, error) {
	items := spec.Collection
	depths := normalizedDepths(items)
	var render func(i int) (string, int, error)
	// children renders the items under the one at i, returning them and the
	// index of the first item that is not one of them.
	children := func(i int) ([]string, int, error) {
		var out []string
		j := i + 1
		for j < len(items) && depths[j] > depths[i] {
			text, next, err := render(j)
			if err != nil {
				return nil, 0, err
			}
			out = append(out, text)
			j = next
		}
		return out, j, nil
	}
	render = func(i int) (string, int, error) {
		it := items[i]
		kids, next, err := children(i)
		if err != nil {
			return "", 0, err
		}
		if it.Kind == "separator" {
			if len(kids) > 0 {
				return "", 0, fmt.Errorf("a separator cannot have items under it")
			}
			return "goforms.NewMenuSeparator()", next, nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "goforms.NewMenuItem(%s)", quote(it.Text))
		if it.Handler != "" {
			if err := validateGoIdent(it.Handler); err != nil {
				return "", 0, fmt.Errorf("handler of %q: %w", it.Text, err)
			}
			fmt.Fprintf(&b, ".OnClick(%s.%s)", recvVar, it.Handler)
		}
		if it.Disabled {
			b.WriteString(".SetEnabled(false)")
		}
		if len(kids) > 0 {
			b.WriteString(".Add(\n" + strings.Join(kids, ",\n") + ",\n)")
		}
		return b.String(), next, nil
	}

	var tops []string
	for i := 0; i < len(items); {
		if cd.TopLevel == "" {
			text, next, err := render(i)
			if err != nil {
				return "", err
			}
			tops = append(tops, text)
			i = next
			continue
		}
		it := items[i]
		if it.Kind == "separator" || it.Handler != "" || it.Disabled {
			return "", fmt.Errorf("%q is on the menu bar itself, which holds menus - not separators, handlers or disabled items; nest it under one", it.Text)
		}
		kids, next, err := children(i)
		if err != nil {
			return "", err
		}
		if len(kids) == 0 {
			tops = append(tops, fmt.Sprintf("goforms.%s(%s)", cd.TopLevel, quote(it.Text)))
		} else {
			tops = append(tops, fmt.Sprintf("goforms.%s(%s,\n%s,\n)", cd.TopLevel, quote(it.Text), strings.Join(kids, ",\n")))
		}
		i = next
	}
	if len(tops) == 0 {
		return fmt.Sprintf("goforms.%s()", ctor), nil
	}
	return fmt.Sprintf("goforms.%s(\n%s,\n)", ctor, strings.Join(tops, ",\n")), nil
}

// planSetMenu rewrites a menu's constructor with a new item list.
func planSetMenu(r *parseResult, pc *pcontrol, cd *CollectionDesc, items []CollectionItem) ([]edit, error) {
	if pc.ctorCall == nil {
		return nil, fmt.Errorf("could not locate %q's constructor", pc.spec.ID)
	}
	next := *pc.spec
	next.Collection = items
	text, err := menuCtor(r.model.RecvVar, &next, cd, pc.ctorCall.Fun.(*ast.SelectorExpr).Sel.Name)
	if err != nil {
		return nil, err
	}
	return []edit{{offset(r.fset, pc.ctorCall.Pos()), offset(r.fset, pc.ctorCall.End()), text}}, nil
}
