package main

// embeds.go puts pictures in a form the way the binary can carry them:
// embedded with go:embed, as a WinForms form keeps its images in a .resx.
//
//	//go:embed resources/logo.png
//	var picLogoImage []byte
//	...
//	mf.picLogo.LoadBytes("logo.png", picLogoImage)
//	mf.SetIcon(goforms.NewResource("app.png", mainFormIcon))
//
// The file lives in the form's folder (go:embed cannot reach outside the
// package); the designer copies a picked picture there. The wire value of an
// image property is that path, relative to the folder.

import (
	"fmt"
	"go/ast"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// embedVar is one `//go:embed <path>` variable of the designer file.
type embedVar struct {
	path string
	decl *ast.GenDecl
	// directive spans the `//go:embed` comment line itself.
	directive *ast.Comment
}

// readEmbeds collects the file's go:embed []byte variables.
func (r *parseResult) readEmbeds() {
	r.embeds = map[string]*embedVar{}
	for _, decl := range r.file.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.VAR || len(gd.Specs) != 1 || gd.Doc == nil {
			continue
		}
		vs, ok := gd.Specs[0].(*ast.ValueSpec)
		if !ok || len(vs.Names) != 1 || len(vs.Values) != 0 {
			continue
		}
		if at, ok := vs.Type.(*ast.ArrayType); !ok || at.Len != nil || fmt.Sprint(at.Elt) != "byte" {
			continue
		}
		for _, c := range gd.Doc.List {
			if p, ok := strings.CutPrefix(c.Text, "//go:embed "); ok {
				r.embeds[vs.Names[0].Name] = &embedVar{path: strings.TrimSpace(p), decl: gd, directive: c}
			}
		}
	}
}

// imageFromLoad reads `LoadBytes("name", var)` into an image path.
func (r *parseResult) imageFromArgs(args []ast.Expr) (path, varName string, ok bool) {
	if len(args) != 2 {
		return "", "", false
	}
	if _, isLit := litString(args[0]); !isLit {
		return "", "", false
	}
	id, isIdent := args[1].(*ast.Ident)
	if !isIdent {
		return "", "", false
	}
	ev, known := r.embeds[id.Name]
	if !known {
		return "", "", false
	}
	return ev.path, id.Name, true
}

// imageExts are the picture formats Fyne decodes.
var imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".svg": true, ".gif": true}

// checkImagePath refuses a path go:embed could not embed, or a file that is
// not there.
func checkImagePath(r *parseResult, p string) error {
	if p == "" || strings.Contains(p, `\`) || !filepath.IsLocal(p) || strings.HasPrefix(p, ".") {
		return fmt.Errorf("the picture must be a file in the form's folder (a path like resources/logo.png), got %q", p)
	}
	if !imageExts[strings.ToLower(path.Ext(p))] {
		return fmt.Errorf("%q is not a picture (PNG, JPEG, GIF or SVG)", p)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(r.path), filepath.FromSlash(p))); err != nil {
		return fmt.Errorf("%s is not in the form's folder: %w", p, err)
	}
	return nil
}

// freeVarName picks a package-level name for a new embed variable that the
// file does not already declare.
func freeVarName(r *parseResult, base string) string {
	taken := map[string]bool{}
	for _, decl := range r.file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Recv == nil {
				taken[d.Name.Name] = true
			}
		case *ast.GenDecl:
			for _, sp := range d.Specs {
				switch v := sp.(type) {
				case *ast.ValueSpec:
					for _, n := range v.Names {
						taken[n.Name] = true
					}
				case *ast.TypeSpec:
					taken[v.Name.Name] = true
				}
			}
		}
	}
	name := base
	for i := 2; taken[name]; i++ {
		name = fmt.Sprintf("%s%d", base, i)
	}
	return name
}

// afterImports is where a new package-level declaration goes.
func afterImports(r *parseResult) int {
	at := offset(r.fset, r.file.Name.End())
	for _, decl := range r.file.Decls {
		if gd, ok := decl.(*ast.GenDecl); ok && gd.Tok == token.IMPORT {
			at = offset(r.fset, gd.End())
		}
	}
	return at
}

// planImageProp sets or clears (an empty value) a picture: the embed
// variable, the call that loads it, and the embed import. pc is nil for the
// form's icon.
func planImageProp(r *parseResult, pc *pcontrol, prop, value string) ([]edit, error) {
	var varName string
	var stmt ByteRangeTok
	var have bool
	if pc != nil {
		varName, stmt, have = pc.imageVar, pc.setterStmts[prop], pc.setterStmts[prop].Start != token.NoPos
	} else {
		varName, stmt, have = r.form.iconVar, r.form.setterStmts[prop], r.form.setterStmts[prop].Start != token.NoPos
	}

	if value == "" {
		if !have {
			return nil, nil
		}
		var edits []edit
		edits = addLineDelete(edits, r.src, offset(r.fset, stmt.Start), offset(r.fset, stmt.End))
		return appendEmbedDelete(edits, r, varName), nil
	}
	if err := checkImagePath(r, value); err != nil {
		return nil, err
	}

	var edits []edit
	ev := r.embeds[varName]
	if varName == "" || ev == nil {
		base := "formIcon"
		if pc != nil {
			base = pc.spec.ID + "Image"
		}
		varName = freeVarName(r, base)
		at := afterImports(r)
		edits = append(edits, edit{at, at, fmt.Sprintf("\n\n//go:embed %s\nvar %s []byte", value, varName)})
	} else if ev.path != value {
		edits = append(edits, edit{offset(r.fset, ev.directive.Pos()), offset(r.fset, ev.directive.End()), "//go:embed " + value})
	}

	name := quote(path.Base(value))
	var call string
	if pc != nil {
		call = fmt.Sprintf("%s.%s.LoadBytes(%s, %s)", r.model.RecvVar, pc.spec.ID, name, varName)
	} else {
		call = fmt.Sprintf("%s.SetIcon(goforms.NewResource(%s, %s))", r.model.RecvVar, name, varName)
	}
	switch {
	case have:
		start, end := wholeLines(r.src, offset(r.fset, stmt.Start), offset(r.fset, stmt.End))
		edits = append(edits, edit{start, end, lineIndent(r.src, start) + call + "\n"})
	case pc != nil:
		insertAt, indent := afterConstructionLine(r, pc)
		edits = append(edits, edit{insertAt, insertAt, indent + call + "\n"})
	default:
		insertAt, indent := afterFormAnchor(r)
		edits = append(edits, edit{insertAt, insertAt, indent + call + "\n"})
	}
	return append(edits, planImportEdits(r, []string{`_ "embed"`})...), nil
}

// appendEmbedDelete deletes an embed variable the designer file declared,
// unless another file of the package uses it too.
func appendEmbedDelete(edits []edit, r *parseResult, varName string) []edit {
	ev := r.embeds[varName]
	if ev == nil || usedElsewhere(r, varName) {
		return edits
	}
	// The directive is the declaration's doc comment, which its Pos does not
	// cover; it goes with it.
	from := ev.decl.Pos()
	if ev.decl.Doc != nil {
		from = ev.decl.Doc.Pos()
	}
	start, end := wholeLines(r.src, offset(r.fset, from), offset(r.fset, ev.decl.End()))
	// And the blank line that was left before it.
	for start >= 2 && r.src[start-1] == '\n' && r.src[start-2] == '\n' {
		start--
	}
	return append(edits, edit{start, end, ""})
}

// usedElsewhere reports whether a Go file of the package other than the
// designer file names the identifier.
func usedElsewhere(r *parseResult, name string) bool {
	word := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`)
	dir := filepath.Dir(r.path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true // cannot tell: keep it
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || sameFile(p, r.path) {
			continue
		}
		b, err := os.ReadFile(p)
		if err == nil && word.Match(b) {
			return true
		}
	}
	return false
}

func sameFile(a, b string) bool {
	sa, err1 := os.Stat(a)
	sb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(sa, sb)
}
