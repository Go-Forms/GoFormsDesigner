package main

// styleprops.go reads and writes the property kinds whose values are not a
// literal but a goforms call: a color, a font, a padding.
//
//	mf.lbl.SetForeColor(goforms.RGB(200, 30, 30))       color  "#c81e1e"
//	mf.lbl.SetBackColor(goforms.RGBA(0, 0, 0, 128))     color  "#00000080"
//	mf.lbl.SetFont(goforms.NewFont("Sans", 14, true, false))  font  "Sans, 14, Bold"
//	mf.pnl.SetPadding(goforms.NewPadding(8))            padding "8"
//	mf.pnl.SetPadding(goforms.Padding{Left: 4, Top: 2, Right: 4, Bottom: 2})  "4, 2, 4, 2"
//
// The wire values are what the property panel shows and edits; each one
// round-trips to exactly the code it came from, so reading a file and
// writing it back changes nothing.

import (
	"fmt"
	"go/ast"
	"strconv"
	"strings"
)

// readColor reads goforms.RGB(r, g, b) / goforms.RGBA(r, g, b, a) back as
// "#rrggbb" / "#rrggbbaa".
func readColor(e ast.Expr) (string, bool) {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return "", false
	}
	parts, ok := selChain(call.Fun)
	if !ok || len(parts) != 2 || parts[0] != "goforms" {
		return "", false
	}
	want := map[string]int{"RGB": 3, "RGBA": 4}[parts[1]]
	if want == 0 || len(call.Args) != want {
		return "", false
	}
	var b strings.Builder
	b.WriteByte('#')
	for _, a := range call.Args {
		n, ok := litInt(a)
		if !ok || n < 0 || n > 255 {
			return "", false
		}
		fmt.Fprintf(&b, "%02x", n)
	}
	return b.String(), true
}

// formatColor turns "#rrggbb" or "#rrggbbaa" into the goforms call.
func formatColor(prop, value string) (string, error) {
	v := strings.TrimPrefix(strings.TrimSpace(value), "#")
	if len(v) != 6 && len(v) != 8 {
		return "", fmt.Errorf("property %q is a color (#rrggbb or #rrggbbaa), got %q", prop, value)
	}
	var comps []string
	for i := 0; i < len(v); i += 2 {
		n, err := strconv.ParseUint(v[i:i+2], 16, 8)
		if err != nil {
			return "", fmt.Errorf("property %q is a color (#rrggbb or #rrggbbaa), got %q", prop, value)
		}
		comps = append(comps, strconv.FormatUint(n, 10))
	}
	if len(comps) == 4 {
		return "goforms.RGBA(" + strings.Join(comps, ", ") + ")", nil
	}
	return "goforms.RGB(" + strings.Join(comps, ", ") + ")", nil
}

// readFont reads goforms.NewFont(family, size, bold, italic) as
// "family, size[, Bold][, Italic]". An empty family is the theme's.
func readFont(e ast.Expr) (string, bool) {
	call, ok := e.(*ast.CallExpr)
	if !ok || len(call.Args) != 4 {
		return "", false
	}
	parts, ok := selChain(call.Fun)
	if !ok || len(parts) != 2 || parts[0] != "goforms" || parts[1] != "NewFont" {
		return "", false
	}
	family, ok := litString(call.Args[0])
	if !ok || strings.Contains(family, ",") {
		return "", false
	}
	size, ok := litFloat(call.Args[1])
	if !ok {
		return "", false
	}
	bold, ok1 := litBool(call.Args[2])
	italic, ok2 := litBool(call.Args[3])
	if !ok1 || !ok2 {
		return "", false
	}
	out := family + ", " + fnum(size)
	if bold {
		out += ", Bold"
	}
	if italic {
		out += ", Italic"
	}
	return out, true
}

// formatFont turns "family, size[, Bold][, Italic]" into goforms.NewFont.
func formatFont(prop, value string) (string, error) {
	fields := strings.Split(value, ",")
	if len(fields) < 2 {
		return "", fmt.Errorf("property %q is a font (\"family, size[, Bold][, Italic]\"), got %q", prop, value)
	}
	family := strings.TrimSpace(fields[0])
	size, err := strconv.ParseFloat(strings.TrimSpace(fields[1]), 64)
	if err != nil || size < 0 {
		return "", fmt.Errorf("property %q: %q is not a font size", prop, strings.TrimSpace(fields[1]))
	}
	bold, italic := false, false
	for _, f := range fields[2:] {
		switch strings.ToLower(strings.TrimSpace(f)) {
		case "bold":
			bold = true
		case "italic":
			italic = true
		case "":
		default:
			return "", fmt.Errorf("property %q: unknown font style %q (want Bold or Italic)", prop, strings.TrimSpace(f))
		}
	}
	return fmt.Sprintf("goforms.NewFont(%s, %s, %t, %t)", quote(family), fnum(size), bold, italic), nil
}

// readPadding reads goforms.NewPadding(n) as "n", and a
// goforms.Padding{Left: l, Top: t, Right: r, Bottom: b} literal as
// "l, t, r, b". A literal with a field left out has that side at zero, as
// in Go.
func readPadding(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.CallExpr:
		parts, ok := selChain(v.Fun)
		if !ok || len(parts) != 2 || parts[0] != "goforms" || parts[1] != "NewPadding" || len(v.Args) != 1 {
			return "", false
		}
		n, ok := litFloat(v.Args[0])
		if !ok {
			return "", false
		}
		return fnum(n), true
	case *ast.CompositeLit:
		parts, ok := selChain(v.Type)
		if !ok || len(parts) != 2 || parts[0] != "goforms" || parts[1] != "Padding" {
			return "", false
		}
		sides := map[string]float64{}
		for i, elt := range v.Elts {
			var key string
			var val ast.Expr
			if kv, isKV := elt.(*ast.KeyValueExpr); isKV {
				id, isIdent := kv.Key.(*ast.Ident)
				if !isIdent {
					return "", false
				}
				key, val = id.Name, kv.Value
			} else {
				if i > 3 {
					return "", false
				}
				key, val = []string{"Left", "Top", "Right", "Bottom"}[i], elt
			}
			n, ok := litFloat(val)
			if !ok {
				return "", false
			}
			sides[key] = n
		}
		l, t, r, b := sides["Left"], sides["Top"], sides["Right"], sides["Bottom"]
		if l == t && t == r && r == b {
			return fnum(l), true
		}
		return fmt.Sprintf("%s, %s, %s, %s", fnum(l), fnum(t), fnum(r), fnum(b)), true
	}
	return "", false
}

// formatPadding turns "n" or "l, t, r, b" into the shortest code that says
// it: NewPadding for the same inset all round, a Padding literal otherwise.
func formatPadding(prop, value string) (string, error) {
	fields := strings.Split(value, ",")
	if len(fields) != 1 && len(fields) != 4 {
		return "", fmt.Errorf("property %q is a padding (\"all\" or \"left, top, right, bottom\"), got %q", prop, value)
	}
	nums := make([]float64, len(fields))
	for i, f := range fields {
		n, err := strconv.ParseFloat(strings.TrimSpace(f), 64)
		if err != nil || n < 0 {
			return "", fmt.Errorf("property %q: %q is not a padding", prop, strings.TrimSpace(f))
		}
		nums[i] = n
	}
	if len(nums) == 1 || (nums[0] == nums[1] && nums[1] == nums[2] && nums[2] == nums[3]) {
		return fmt.Sprintf("goforms.NewPadding(%s)", fnum(nums[0])), nil
	}
	return fmt.Sprintf("goforms.Padding{Left: %s, Top: %s, Right: %s, Bottom: %s}",
		fnum(nums[0]), fnum(nums[1]), fnum(nums[2]), fnum(nums[3])), nil
}
