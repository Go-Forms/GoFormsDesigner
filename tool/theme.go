package main

// theme.go reads and writes a project's `<name>-styles.go` file: the single
// `goforms.Theme` literal that decides how the whole application looks.
//
// It is the form designer's approach applied to something much smaller. The
// Go file stays the source of truth, the editor is a view over it, and the
// same guarantee holds: a field written as something this tool does not
// recognize - a named constant, a call into the project's own code - is
// reported as read-only rather than replaced by a literal.
//
// A theme's zero values are meaningful (see GoForms/theme.go): an unset
// colour keeps Fyne's default for that role, and an unset size keeps its
// default size. So "set" and "unset" are genuinely different states, and the
// editor has to be able to reach both.

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
)

// ThemeFieldKind names how a field's value is edited.
const (
	ThemeColor  = "color"
	ThemeBool   = "bool"
	ThemeNumber = "number"
	ThemeText   = "text"
)

// themeField describes one field of goforms.Theme.
type themeField struct {
	Name string
	Kind string
	// Role is what the colour actually paints, for the editor to label it
	// with. Taken from fyneTheme.override in GoForms/theme.go.
	Role string
}

// themeFields is every field of goforms.Theme, in declaration order - which
// is also the order a generated literal writes them in, so a file this tool
// creates reads like the struct it mirrors.
var themeFields = []themeField{
	{"Name", ThemeText, "A label for this theme. Not used at runtime."},
	{"Dark", ThemeBool, "Selects the light or dark variant of everything left unset."},

	{"Background", ThemeColor, "The window and panel background."},
	{"Foreground", ThemeColor, "Body text and icons."},
	{"Primary", ThemeColor, "The accent: focus rings, selection, the default button."},
	{"InputBackground", ThemeColor, "Inside text boxes and lists."},
	{"ButtonColor", ThemeColor, "Button faces."},
	{"Hover", ThemeColor, "The wash under the pointer."},
	{"Border", ThemeColor, "Input outlines and separators."},
	{"Disabled", ThemeColor, "Text and faces of disabled controls."},
	{"Placeholder", ThemeColor, "Prompt text in an empty input."},
	{"Selection", ThemeColor, "Selected rows and highlighted text."},
	{"ScrollBar", ThemeColor, "The scrollbar thumb."},

	{"TextSize", ThemeNumber, "Base font size. Unset keeps the default."},
	{"Padding", ThemeNumber, "The gap around widget content - the biggest single lever on how dense a form looks."},
	{"InputBorderWidth", ThemeNumber, "Outline thickness on inputs and buttons."},
	{"InputRadius", ThemeNumber, "Corner rounding on inputs and buttons."},
}

func themeFieldByName(name string) (themeField, bool) {
	for _, f := range themeFields {
		if f.Name == name {
			return f, true
		}
	}
	return themeField{}, false
}

// ThemeValue is one field's current state.
type ThemeValue struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Role string `json:"role"`
	// Set is false when the field is absent from the literal, which is what
	// makes it fall back to Fyne's default.
	Set bool `json:"set"`
	// Color is "#rrggbb" or "#rrggbbaa"; empty unless Kind is color.
	Color  string  `json:"color,omitempty"`
	Bool   bool    `json:"bool,omitempty"`
	Number float64 `json:"number,omitempty"`
	Text   string  `json:"text,omitempty"`
	// Editable is false when the field holds an expression this tool cannot
	// rewrite. Raw then shows what is actually there.
	Editable bool   `json:"editable"`
	Raw      string `json:"raw,omitempty"`
}

// ThemeModel is theme-parse's JSON output.
type ThemeModel struct {
	File     string       `json:"file"`
	Package  string       `json:"package"`
	FuncName string       `json:"funcName"`
	Fields   []ThemeValue `json:"fields"`
	Note     string       `json:"note"`
}

// ThemeOp is one edit, as theme-apply takes them on stdin.
type ThemeOp struct {
	Op     string  `json:"op"` // "set" or "unset"
	Field  string  `json:"field"`
	Color  string  `json:"color,omitempty"`
	Bool   bool    `json:"bool,omitempty"`
	Number float64 `json:"number,omitempty"`
	Text   string  `json:"text,omitempty"`
}

// themeParse locates the goforms.Theme literal in path and reads it.
type themeParseResult struct {
	fset    *token.FileSet
	src     []byte
	lit     *ast.CompositeLit
	byField map[string]*ast.KeyValueExpr
	model   *ThemeModel
}

func parseThemeFile(path string) (*themeParseResult, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	res := &themeParseResult{
		fset:    fset,
		src:     src,
		byField: map[string]*ast.KeyValueExpr{},
		model: &ThemeModel{
			File:    path,
			Package: f.Name.Name,
			Note: "Every field left unset keeps Fyne's default for that property, " +
				"so unsetting a colour is a real choice rather than a blank.",
		},
	}

	// The literal is found by type, not by the name of whatever holds it: a
	// project may return it from a function, assign it to a var, or build it
	// inline, and all three are the same thing to edit.
	ast.Inspect(f, func(n ast.Node) bool {
		if res.lit != nil {
			return false
		}
		cl, ok := n.(*ast.CompositeLit)
		if !ok {
			return true
		}
		if parts, ok := selChain(cl.Type); ok && len(parts) == 2 && parts[1] == "Theme" {
			res.lit = cl
			return false
		}
		return true
	})
	if res.lit == nil {
		return nil, fmt.Errorf("no goforms.Theme{...} literal found in %s", path)
	}

	// The enclosing function's name, so the scaffold can wire main.go to it.
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Body == nil {
			continue
		}
		if fd.Pos() < res.lit.Pos() && res.lit.End() < fd.End() {
			res.model.FuncName = fd.Name.Name
			break
		}
	}

	for _, elt := range res.lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok {
			continue
		}
		res.byField[key.Name] = kv
	}

	for _, fd := range themeFields {
		res.model.Fields = append(res.model.Fields, res.readField(fd))
	}
	return res, nil
}

func (r *themeParseResult) readField(fd themeField) ThemeValue {
	v := ThemeValue{Name: fd.Name, Kind: fd.Kind, Role: fd.Role, Editable: true}
	kv, ok := r.byField[fd.Name]
	if !ok {
		return v // absent: unset, and editable because it can be added
	}
	v.Set = true
	v.Raw = strings.TrimSpace(string(r.src[offset(r.fset, kv.Value.Pos()):offset(r.fset, kv.Value.End())]))

	switch fd.Kind {
	case ThemeColor:
		if hex, ok := colorLiteral(kv.Value); ok {
			v.Color = hex
			return v
		}
	case ThemeBool:
		if id, ok := kv.Value.(*ast.Ident); ok && (id.Name == "true" || id.Name == "false") {
			v.Bool = id.Name == "true"
			return v
		}
	case ThemeNumber:
		if n, ok := litFloat(kv.Value); ok {
			v.Number = n
			return v
		}
	case ThemeText:
		if s, ok := litString(kv.Value); ok {
			v.Text = s
			return v
		}
	}
	// Something deliberate that this tool has no business rewriting - a
	// named constant, a helper call, an expression.
	v.Editable = false
	return v
}

// colorLiteral reads goforms.RGB(r, g, b) or goforms.RGBA(r, g, b, a) as a
// hex string. Anything else - including a colour built any other way - is
// left to the caller to treat as read-only.
func colorLiteral(e ast.Expr) (string, bool) {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return "", false
	}
	parts, ok := selChain(call.Fun)
	if !ok || len(parts) != 2 {
		return "", false
	}
	want := 0
	switch parts[1] {
	case "RGB":
		want = 3
	case "RGBA":
		want = 4
	default:
		return "", false
	}
	if len(call.Args) != want {
		return "", false
	}
	var b strings.Builder
	b.WriteByte('#')
	for _, arg := range call.Args {
		n, ok := litByte(arg)
		if !ok {
			return "", false
		}
		fmt.Fprintf(&b, "%02x", n)
	}
	return b.String(), true
}

// litByte reads a colour component. It is not litFloat: components are
// conventionally written 0x1E, and strconv.ParseFloat rejects a hexadecimal
// integer unless it carries a binary exponent. ParseUint with base 0 takes
// 0x1E, 30 and 0o36 alike, which is every way one could reasonably be
// written.
func litByte(e ast.Expr) (int, bool) {
	bl, ok := e.(*ast.BasicLit)
	if !ok || bl.Kind != token.INT {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.ReplaceAll(bl.Value, "_", ""), 0, 16)
	if err != nil || n > 255 {
		return 0, false
	}
	return int(n), true
}

// colorExpr is colorLiteral's inverse: a hex string as the Go call that
// builds it. A fully opaque colour is written as RGB, since the alpha would
// only be noise.
func colorExpr(pkg, hex string) (string, error) {
	h := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(h) != 6 && len(h) != 8 {
		return "", fmt.Errorf("colour %q must be #rrggbb or #rrggbbaa", hex)
	}
	var vals []int
	for i := 0; i < len(h); i += 2 {
		n, err := strconv.ParseUint(h[i:i+2], 16, 8)
		if err != nil {
			return "", fmt.Errorf("colour %q is not hexadecimal", hex)
		}
		vals = append(vals, int(n))
	}
	if len(vals) == 4 && vals[3] == 0xFF {
		vals = vals[:3]
	}
	name := "RGB"
	if len(vals) == 4 {
		name = "RGBA"
	}
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = fmt.Sprintf("0x%02X", v)
	}
	return fmt.Sprintf("%s.%s(%s)", pkg, name, strings.Join(parts, ", ")), nil
}

// applyThemeOps edits path in place and returns the freshly re-parsed model.
//
// Fields are spliced individually rather than the literal being regenerated,
// so anything the tool does not model - a comment inside the literal, a field
// holding an expression, a field of some future version of Theme - survives
// an edit made through the editor.
//
// The batch is atomic: if any op fails, the file is left exactly as it was.
func applyThemeOps(path string, ops []ThemeOp) (*ThemeModel, error) {
	original, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	restore := func(cause error) (*ThemeModel, error) {
		if wErr := os.WriteFile(path, original, 0o644); wErr != nil {
			return nil, fmt.Errorf("%w (and restoring %s failed: %v)", cause, path, wErr)
		}
		return nil, cause
	}

	for i, op := range ops {
		// Re-parsed per op, like applyOps: the second op has to see what the
		// first inserted, and needs offsets that account for its text.
		r, err := parseThemeFile(path)
		if err != nil {
			return restore(err)
		}
		edits, err := planThemeOp(r, op)
		if err != nil {
			return restore(fmt.Errorf("op %d (%q on %q): %w", i, op.Op, op.Field, err))
		}
		if len(edits) == 0 {
			continue
		}
		buf, err := spliceEdits(r.src, edits)
		if err != nil {
			return restore(fmt.Errorf("op %d (%q on %q): %w", i, op.Op, op.Field, err))
		}
		formatted, err := format.Source(buf)
		if err != nil {
			return restore(fmt.Errorf("op %d (%q on %q) would leave %s unparseable: %w", i, op.Op, op.Field, path, err))
		}
		if err := os.WriteFile(path, formatted, 0o644); err != nil {
			return restore(fmt.Errorf("write %s: %w", path, err))
		}
	}

	fresh, err := parseThemeFile(path)
	if err != nil {
		return restore(fmt.Errorf("re-parse after apply: %w", err))
	}
	return fresh.model, nil
}

func planThemeOp(r *themeParseResult, op ThemeOp) ([]edit, error) {
	fd, ok := themeFieldByName(op.Field)
	if !ok {
		return nil, fmt.Errorf("goforms.Theme has no field %q", op.Field)
	}
	kv, present := r.byField[op.Field]

	if op.Op == "unset" {
		if !present {
			return nil, nil
		}
		// The whole line goes, so the literal does not keep a blank where the
		// field was.
		return addLineDelete(nil, r.src, offset(r.fset, kv.Pos()), offset(r.fset, kv.End())), nil
	}
	if op.Op != "set" {
		return nil, fmt.Errorf("unknown op %q", op.Op)
	}

	value, err := themeValueExpr(r, fd, op)
	if err != nil {
		return nil, err
	}

	if present {
		// Refusing here is the same rule the form designer applies to a title
		// that is not a string literal: an expression someone wrote on
		// purpose is not something to overwrite with a constant.
		if !r.readField(fd).Editable {
			return nil, fmt.Errorf("%s holds %s, which this editor cannot rewrite - edit it in the file", fd.Name, r.readField(fd).Raw)
		}
		return []edit{{
			offset(r.fset, kv.Value.Pos()),
			offset(r.fset, kv.Value.End()),
			value,
		}}, nil
	}
	return insertThemeField(r, fd, value)
}

// themeValueExpr renders an op's value as the Go expression for its kind.
func themeValueExpr(r *themeParseResult, fd themeField, op ThemeOp) (string, error) {
	switch fd.Kind {
	case ThemeColor:
		return colorExpr(themePkgName(r), op.Color)
	case ThemeBool:
		return strconv.FormatBool(op.Bool), nil
	case ThemeNumber:
		if op.Number < 0 {
			return "", fmt.Errorf("%s cannot be negative", fd.Name)
		}
		return fnum(op.Number), nil
	case ThemeText:
		return strconv.Quote(op.Text), nil
	}
	return "", fmt.Errorf("field %q has no editable kind", fd.Name)
}

// themePkgName is the name the file refers to goforms by, so a generated
// colour call uses the same qualifier as everything around it.
func themePkgName(r *themeParseResult) string {
	if parts, ok := selChain(r.lit.Type); ok && len(parts) == 2 {
		return parts[0]
	}
	return goformsPkg
}

// insertThemeField adds a field the literal does not have yet, in the
// position declaration order puts it - so a theme filled in through the
// editor reads in the same order as the struct it mirrors, however the fields
// were actually clicked.
func insertThemeField(r *themeParseResult, fd themeField, value string) ([]edit, error) {
	line := fmt.Sprintf("%s: %s,", fd.Name, value)

	// After the last field that precedes this one in declaration order.
	var after *ast.KeyValueExpr
	for _, candidate := range themeFields {
		if candidate.Name == fd.Name {
			break
		}
		if kv, ok := r.byField[candidate.Name]; ok {
			after = kv
		}
	}
	at := offset(r.fset, r.lit.Lbrace) + 1 // nothing precedes it: it goes first
	sep := "\n"
	if after != nil {
		at = offset(r.fset, after.End())
		// The element it follows may or may not carry a trailing comma:
		// gofmt keeps one while the literal spans several lines and drops it
		// once the literal fits on one. Step over the comma if it is there,
		// and supply it if it is not - otherwise the inserted line lands
		// against a value with nothing separating them.
		if at < len(r.src) && r.src[at] == ',' {
			at++
		} else {
			sep = ",\n"
		}
	}

	// Put the closing brace on its own line when it is not already, so a
	// literal that gofmt had collapsed onto one line does not come back as
	// `Padding: 8}`. gofmt aligns the field names; it will not do this.
	tail := ""
	if !bytes.ContainsRune(r.src[at:offset(r.fset, r.lit.Rbrace)], '\n') {
		tail = "\n"
	}
	return []edit{{at, at, sep + line + tail}}, nil
}
