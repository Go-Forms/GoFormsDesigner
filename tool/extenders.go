package main

// extenders.go is what one component says about another control: a
// ToolTip's tip for it, and a BindingSource's binding of one of its
// properties. WinForms calls the first an extender property - "ToolTip on
// toolTip1" in the property grid of every control - and the second a
// DataBinding. Both are a call on the component naming the control:
//
//	mf.toolTip1.SetToolTip(mf.btnSave, "Saves the file")
//	mf.bsCustomers.Bind(mf.txtName, "Text", "Name")
//
// The line belongs to the control's block (see aboutControl in reorder.go),
// just above its AddControl, so it runs once both exist and goes when the
// control is deleted; deleting the component takes these lines out of every
// block (see planRemove).

import (
	"fmt"
	"go/ast"
	"go/token"
	"sort"
	"strings"
)

// visitExtender reads a SetToolTip or Bind call, reporting whether the
// statement was one.
func (r *parseResult) visitExtender(s *ast.ExprStmt, call *ast.CallExpr, parts []string, recvVar string) bool {
	if len(parts) != 3 {
		return false
	}
	comp, ok := r.controls[parts[1]]
	if !ok {
		return false
	}
	switch {
	case comp.spec.Type == "ToolTip" && parts[2] == "SetToolTip" && len(call.Args) == 2:
		target := r.controlExpr(call.Args[0], recvVar)
		text, isLit := litString(call.Args[1])
		if target == nil || !isLit {
			return false
		}
		if target.spec.ToolTips == nil {
			target.spec.ToolTips = map[string]string{}
		}
		target.spec.ToolTips[parts[1]] = text
		target.tipStmts[parts[1]] = ByteRangeTok{Start: s.Pos(), End: s.End()}
		target.lastEnd = maxPos(target.lastEnd, s.End())
		return true
	case comp.spec.Type == "BindingSource" && parts[2] == "Bind" && len(call.Args) == 3:
		target := r.controlExpr(call.Args[0], recvVar)
		prop, ok1 := litString(call.Args[1])
		member, ok2 := litString(call.Args[2])
		if target == nil || !ok1 || !ok2 {
			return false
		}
		if target.spec.Bindings == nil {
			target.spec.Bindings = map[string]BindingSpec{}
		}
		target.spec.Bindings[prop] = BindingSpec{Source: parts[1], Member: member}
		target.bindStmts[prop] = ByteRangeTok{Start: s.Pos(), End: s.End()}
		target.lastEnd = maxPos(target.lastEnd, s.End())
		return true
	}
	return false
}

func toolTipLine(recvVar, tip, id, text, indent string) string {
	return fmt.Sprintf("%s%s.%s.SetToolTip(%s.%s, %s)\n", indent, recvVar, tip, recvVar, id, quote(text))
}

func bindLine(recvVar, id, prop string, b BindingSpec, indent string) string {
	return fmt.Sprintf("%s%s.%s.Bind(%s.%s, %s, %s)\n", indent, recvVar, b.Source, recvVar, id, quote(prop), quote(b.Member))
}

// extenderLines renders a control's tips and bindings for its block, in a
// fixed order.
func extenderLines(recvVar string, spec *ControlSpec, indent string) string {
	var b strings.Builder
	tips := make([]string, 0, len(spec.ToolTips))
	for t := range spec.ToolTips {
		tips = append(tips, t)
	}
	sort.Strings(tips)
	for _, t := range tips {
		if spec.ToolTips[t] != "" {
			b.WriteString(toolTipLine(recvVar, t, spec.ID, spec.ToolTips[t], indent))
		}
	}
	props := make([]string, 0, len(spec.Bindings))
	for p := range spec.Bindings {
		props = append(props, p)
	}
	sort.Strings(props)
	for _, p := range props {
		b.WriteString(bindLine(recvVar, spec.ID, p, spec.Bindings[p], indent))
	}
	return b.String()
}

// checkExtenders validates a control's tips and bindings before they are
// written: each must name a component of the right kind, and a binding a
// property the control's type can bind.
func checkExtenders(r *parseResult, spec *ControlSpec) error {
	for tip := range spec.ToolTips {
		if err := checkRef(r, "toolTip", "ToolTip", tip); err != nil {
			return err
		}
	}
	for prop, b := range spec.Bindings {
		if err := checkBinding(r, spec.Type, prop, b); err != nil {
			return err
		}
	}
	return nil
}

func checkBinding(r *parseResult, typ, prop string, b BindingSpec) error {
	if err := checkRef(r, "binding", "BindingSource", b.Source); err != nil {
		return err
	}
	if err := validateGoIdent(b.Member); err != nil {
		return fmt.Errorf("binding %s: the field %w", prop, err)
	}
	desc := catalog[typ]
	if desc != nil {
		for _, p := range desc.Bindable {
			if p == prop {
				return nil
			}
		}
	}
	return fmt.Errorf("a %s has no %s to bind", typ, prop)
}

// planExtenderLine writes, rewrites or deletes one extender line of a
// control: line is the new statement ("" deletes it), rng the one there.
func planExtenderLine(r *parseResult, pc *pcontrol, rng ByteRangeTok, exists bool, line func(indent string) string, remove bool) (*edit, error) {
	if exists {
		start, end := wholeLines(r.src, offset(r.fset, rng.Start), offset(r.fset, rng.End))
		if remove {
			return &edit{start, end, ""}, nil
		}
		return &edit{start, end, line(lineIndent(r.src, start))}, nil
	}
	if remove {
		return nil, nil
	}
	if pc.addCtlRange.Start == token.NoPos {
		return nil, fmt.Errorf("%q is not on the form, so it cannot be given one", pc.spec.ID)
	}
	insertAt, indent := beforeAddControlLine(r, pc)
	return &edit{insertAt, insertAt, line(indent)}, nil
}

// planSetToolTip sets the tip a ToolTip (op.Prop) gives a control; an
// empty value takes it away.
func planSetToolTip(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	if isNonVisual(pc.spec.Type) {
		return nil, fmt.Errorf("%s is not on the form, so it has nowhere to show a tip", op.ID)
	}
	if err := checkRef(r, "toolTip", "ToolTip", op.Prop); err != nil {
		return nil, err
	}
	rng, exists := pc.tipStmts[op.Prop]
	return planExtenderLine(r, pc, rng, exists, func(indent string) string {
		return toolTipLine(r.model.RecvVar, op.Prop, op.ID, op.Value, indent)
	}, op.Value == "")
}

// planSetBinding binds a control's property (op.Prop) to "source.member"
// (op.Value); an empty value unbinds it.
func planSetBinding(r *parseResult, op Op) (*edit, error) {
	pc, err := mustControl(r, op.ID)
	if err != nil {
		return nil, err
	}
	var b BindingSpec
	if op.Value != "" {
		src, member, ok := strings.Cut(op.Value, ".")
		if !ok {
			return nil, fmt.Errorf("a binding is source.field, got %q", op.Value)
		}
		b = BindingSpec{Source: src, Member: member}
		if err := checkBinding(r, pc.spec.Type, op.Prop, b); err != nil {
			return nil, err
		}
	}
	rng, exists := pc.bindStmts[op.Prop]
	return planExtenderLine(r, pc, rng, exists, func(indent string) string {
		return bindLine(r.model.RecvVar, op.ID, op.Prop, b, indent)
	}, op.Value == "")
}
