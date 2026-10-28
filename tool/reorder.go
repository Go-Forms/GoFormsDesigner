package main

// reorder.go keeps initializeComponent in an order that actually runs.
//
// A control is parented by a call *on its container* - `mf.grpBox.AddControl(
// mf.btnOne)` - so the container has to have been constructed by the time that
// line is reached. Nothing in the editing model enforces that: "add" always
// appends the new control's block at the end of the method, and "setParent"
// only rewrites one AddControl line. Drop two buttons, then drop a GroupBox
// around them, then drag them in, and the file says
//
//	mf.btnOne = goforms.NewButton("One")
//	mf.grpBox.AddControl(mf.btnOne)   // grpBox is still nil here
//	...
//	mf.grpBox = goforms.NewGroupBox("Group", 300, 200)
//
// which panics the first time the form loads. The designer cannot avoid it by
// writing blocks in a smarter order either, because the parent may not exist
// yet at the moment the child is written.
//
// So every write ends with this pass: each control's block is put back after
// its parent's, by permuting the blocks among the positions they already
// occupy. Only whole blocks move, and only among themselves - any statement
// this tool does not model stays exactly where it is, the same guarantee apply
// and tidy give. Anything that makes the permutation unsafe to do blindly -
// interleaved blocks, a hand-written line that would end up on the wrong side
// of a block it mentions, a parent cycle - leaves the file untouched.

import (
	"fmt"
	"go/ast"
	"go/format"
	"os"
)

// reorderFile rewrites path so every control's block follows its parent's,
// and reports how many blocks it had to move.
func reorderFile(path string) (int, error) {
	r, err := parseFile(path)
	if err != nil {
		return 0, err
	}
	edits, err := planReorder(r)
	if err != nil || len(edits) == 0 {
		return 0, err
	}
	buf, err := spliceEdits(r.src, edits)
	if err != nil {
		return 0, err
	}
	// format.Source doubles as the safety net: moving whole lines around
	// cannot break the syntax, and if it somehow did, this is where it shows
	// up - before anything is written.
	formatted, err := format.Source(buf)
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(path, formatted, 0o644); err != nil {
		return 0, err
	}
	return len(edits), nil
}

// planReorder returns the edits that put every block after its parent's, or
// no edits at all when the file is already in order - or when it is not shaped
// in a way this pass can safely permute (see the file comment).
func planReorder(r *parseResult) ([]edit, error) {
	edits, _ := planBlockOrder(r, func(order []string) []string { return parentsFirst(r, order) })
	return edits, nil
}

// planBlockOrder is the machinery under planReorder and the "reorder" op:
// it asks want for the block order it should produce, given the order in
// the file, and returns the edits that permute the blocks into it. ok is
// false when the file is not shaped in a way blocks can be safely moved in
// (see the file comment); no edits with ok true means nothing had to move.
func planBlockOrder(r *parseResult, want func(order []string) []string) (edits []edit, ok bool) {
	if r.initBody == nil {
		return nil, false
	}
	stmts := r.initBody.List

	// Which control each statement belongs to, "" for the ones this tool does
	// not model.
	owners := make([]string, len(stmts))
	for i, s := range stmts {
		owners[i] = stmtOwner(r, s)
	}

	// A block is the run of statements owned by one control. first/last bound
	// it; order lists the blocks as they appear in the file.
	first, last := map[string]int{}, map[string]int{}
	var order []string
	for i, id := range owners {
		if id == "" {
			continue
		}
		if _, seen := first[id]; !seen {
			first[id] = i
			order = append(order, id)
		}
		last[id] = i
	}
	if len(order) < 2 {
		return nil, true
	}
	// The run has to be unbroken, or "the block" is not a thing that can be
	// picked up and put down somewhere else.
	for _, id := range order {
		for i := first[id]; i <= last[id]; i++ {
			if owners[i] != id {
				return nil, false
			}
		}
	}

	slotOf := make(map[string]int, len(order))
	for k, id := range order {
		slotOf[id] = k
	}

	desired := want(order)
	if desired == nil {
		return nil, false // a parent cycle; not this pass's problem to solve
	}
	moves := false
	for k, id := range desired {
		if order[k] != id {
			moves = true
			break
		}
	}
	if !moves {
		return nil, true
	}
	newSlotOf := make(map[string]int, len(desired))
	for k, id := range desired {
		newSlotOf[id] = k
	}

	// A statement this tool does not model can still depend on a block - the
	// `mf.optGroup.Add(mf.rbSmall)` of a hand-written radio group sits after
	// the button it names. It stays where it is, so a block that would hop
	// over it has to call the whole thing off.
	for i, id := range owners {
		if id != "" {
			continue
		}
		for _, ref := range stmtRefs(r, stmts[i]) {
			k, ok := slotOf[ref]
			if !ok {
				continue
			}
			if (last[order[k]] < i) != (last[order[newSlotOf[ref]]] < i) {
				return nil, false
			}
		}
	}

	// The blocks swap contents among the spans they already occupy, which
	// leaves every unmodelled statement - and every blank line between blocks
	// - exactly where the user last saw it.
	spans := make([][2]int, len(order))
	for k, id := range order {
		s, e := wholeLines(r.src, offset(r.fset, stmts[first[id]].Pos()), offset(r.fset, stmts[last[id]].End()))
		spans[k] = [2]int{s, e}
		if k > 0 && spans[k-1][1] > s {
			return nil, false // two blocks sharing a line: not separable
		}
	}

	texts := make([]string, len(order))
	for k := range spans {
		texts[k] = string(r.src[spans[k][0]:spans[k][1]])
	}

	for k, id := range desired {
		if order[k] == id {
			continue
		}
		edits = append(edits, edit{spans[k][0], spans[k][1], texts[slotOf[id]]})
	}
	return edits, true
}

// parentsFirst returns the block order in which no control comes before its
// container, keeping the file's existing order wherever it already satisfies
// that - so a well-ordered file is left alone and a badly ordered one moves
// only the blocks that have to move. It returns nil if the parent links form
// a cycle, which only a hand-written file could manage.
func parentsFirst(r *parseResult, order []string) []string {
	placed := make(map[string]bool, len(order))
	has := make(map[string]bool, len(order))
	for _, id := range order {
		has[id] = true
	}

	out := make([]string, 0, len(order))
	rest := order
	for len(rest) > 0 {
		var deferred []string
		for _, id := range rest {
			// A parent with no block of its own here - the Form, or a container
			// written in a way this tool does not model - constrains nothing.
			parent := r.controls[id].spec.Parent
			if parent != "" && has[parent] && !placed[parent] {
				deferred = append(deferred, id)
				continue
			}
			out = append(out, id)
			placed[id] = true
		}
		if len(deferred) == len(rest) {
			return nil
		}
		rest = deferred
	}
	return out
}

// stmtOwner names the control whose block a statement belongs to, or "" for
// anything this tool does not model. It is the parse-order counterpart of the
// statement shapes parse.go recognizes, told apart by the receiver chain alone
// rather than by position.
func stmtOwner(r *parseResult, stmt ast.Stmt) string {
	switch s := stmt.(type) {
	case *ast.AssignStmt:
		// mf.<id> = goforms.NewX(...) and mf.<id>.<Field> = v.
		if len(s.Lhs) == 1 {
			if parts, ok := selChain(s.Lhs[0]); ok && len(parts) >= 2 && parts[0] == r.model.RecvVar {
				if _, known := r.controls[parts[1]]; known {
					return parts[1]
				}
			}
		}
		// node1 := mf.<id>.AddNode(...) - the owner is on the right.
		if len(s.Rhs) == 1 {
			return callOwner(r, s.Rhs[0])
		}
	case *ast.ExprStmt:
		return callOwner(r, s.X)
	}
	return ""
}

// callOwner names the control a call statement belongs to: the one it is
// called on - except for AddControl, which closes the block of the control
// being *added*, whichever of the container shapes it is written in.
func callOwner(r *parseResult, e ast.Expr) string {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return ""
	}
	if child, _, isAdd := addedChild(call); isAdd {
		if parts, isChain := selChain(child); isChain && len(parts) == 2 && parts[0] == r.model.RecvVar {
			if _, known := r.controls[parts[1]]; known {
				return parts[1]
			}
		}
		return ""
	}
	if parts, isChain := selChain(call.Fun); isChain && len(parts) >= 2 && parts[0] == r.model.RecvVar {
		if _, known := r.controls[parts[1]]; known {
			return parts[1]
		}
	}
	return ""
}

// stmtRefs lists the controls a statement mentions, in the `<recv>.<id>` shape
// that is the only way generated code names one.
func stmtRefs(r *parseResult, stmt ast.Stmt) []string {
	var out []string
	seen := map[string]bool{}
	ast.Inspect(stmt, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		parts, isChain := selChain(sel)
		if !isChain || len(parts) < 2 || parts[0] != r.model.RecvVar {
			return true
		}
		id := parts[1]
		if _, known := r.controls[id]; known && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
		return true
	})
	return out
}

// planReorderOp is the "reorder" op: it puts the children of one container
// in the order given, back to front. That order is the order their blocks -
// and so their AddControl calls - run in, which is everything z-order means
// here: the framework draws the last child added on top, docks the children
// in the order they were added, and flows a FlowLayoutPanel's children in
// that order too. Bring to Front and Send to Back are this op with one ID
// moved to an end.
//
// Only the named blocks trade places, among the positions they already
// hold; their own children follow them because every block is then put back
// after its parent's.
func planReorderOp(r *parseResult, op Op) ([]edit, error) {
	if op.ID != "" {
		if _, err := mustControl(r, op.ID); err != nil {
			return nil, err
		}
	}
	var siblings []string
	for _, c := range r.model.Controls {
		if c.Parent == op.ID && c.ParentSlot == op.ParentSlot && !isNonVisual(c.Type) {
			siblings = append(siblings, c.ID)
		}
	}
	if len(op.Order) != len(siblings) {
		return nil, fmt.Errorf("reorder names %d controls, but %s holds %d", len(op.Order), containerName(op), len(siblings))
	}
	want := map[string]bool{}
	for _, id := range op.Order {
		want[id] = true
	}
	for _, id := range siblings {
		if !want[id] {
			return nil, fmt.Errorf("reorder leaves out %q, which is in %s", id, containerName(op))
		}
	}

	edits, ok := planBlockOrder(r, func(order []string) []string {
		out := append([]string(nil), order...)
		next := 0
		for i, id := range out {
			if want[id] {
				out[i] = op.Order[next]
				next++
			}
		}
		return parentsFirst(r, out)
	})
	if !ok {
		return nil, fmt.Errorf("initializeComponent mixes the controls' statements with hand-written code, so their order cannot be changed safely - reorder the AddControl calls by hand")
	}
	return edits, nil
}

// containerName describes the container a reorder addresses, for errors.
func containerName(op Op) string {
	switch {
	case op.ID == "":
		return "the form"
	case op.ParentSlot != "":
		return op.ID + "." + op.ParentSlot
	}
	return op.ID
}
