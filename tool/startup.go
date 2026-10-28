package main

// startup.go is "Set as Startup Form": it points the goforms.Run call in a
// project's main.go at another form, the way Visual Studio rewrites
// Application.Run(new MainForm()) in Program.cs.
//
// A form lives in a package of its own (Forms/MainForm/), so this is three
// edits, not one: the argument of Run, an import of the new form's package,
// and - when nothing else in main.go uses it any more - the import of the
// old form's package, which Go would otherwise refuse to compile.

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

// StartupResult is set-startup's JSON output.
type StartupResult struct {
	File    string `json:"file"`
	Changed bool   `json:"changed"`
	// Form is the expression Run is now given, e.g. "settingsform.NewSettingsForm().Form".
	Form string `json:"form"`
}

// findModule walks up from dir to the go.mod that owns it, and returns the
// module's root directory and path.
func findModule(dir string) (root, module string, err error) {
	for d := dir; ; {
		b, readErr := os.ReadFile(filepath.Join(d, "go.mod"))
		if readErr == nil {
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if rest, ok := strings.CutPrefix(line, "module"); ok && rest != "" && (rest[0] == ' ' || rest[0] == '\t') {
					mod := strings.Trim(strings.TrimSpace(rest), `"`)
					return d, mod, nil
				}
			}
			return "", "", fmt.Errorf("%s has no module line", filepath.Join(d, "go.mod"))
		}
		parent := filepath.Dir(d)
		if parent == d {
			return "", "", fmt.Errorf("no go.mod above %s", dir)
		}
		d = parent
	}
}

// setStartup rewrites mainPath so goforms.Run starts the form designerPath
// declares.
func setStartup(mainPath, designerPath string) (*StartupResult, error) {
	form, err := parseFile(designerPath)
	if err != nil {
		return nil, err
	}
	absDesigner, err := filepath.Abs(designerPath)
	if err != nil {
		return nil, err
	}
	absMain, err := filepath.Abs(mainPath)
	if err != nil {
		return nil, err
	}
	root, module, err := findModule(filepath.Dir(absDesigner))
	if err != nil {
		return nil, err
	}
	if mainRoot, _, err := findModule(filepath.Dir(absMain)); err != nil || mainRoot != root {
		return nil, fmt.Errorf("%s and %s are not in the same module", mainPath, designerPath)
	}
	rel, err := filepath.Rel(root, filepath.Dir(absDesigner))
	if err != nil {
		return nil, err
	}
	formImport := module
	if rel != "." {
		formImport = path.Join(module, filepath.ToSlash(rel))
	}

	src, err := os.ReadFile(mainPath)
	if err != nil {
		return nil, err
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, mainPath, src, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", mainPath, err)
	}

	// The names the file imports by, and the framework's among them.
	importName := func(spec *ast.ImportSpec) string {
		p, _ := strconv.Unquote(spec.Path.Value)
		if spec.Name != nil {
			return spec.Name.Name
		}
		return path.Base(p)
	}
	gfName := ""
	used := map[string]bool{}
	alias := ""
	samePackage := filepath.Dir(absDesigner) == filepath.Dir(absMain)
	for _, imp := range f.Imports {
		p, _ := strconv.Unquote(imp.Path.Value)
		n := importName(imp)
		used[n] = true
		if p == goformsImportPath {
			gfName = n
			if imp.Name == nil {
				gfName = "goforms" // the package clause's name, not the path's last element
			}
		}
		if p == formImport {
			alias = n
		}
	}
	if gfName == "" {
		return nil, fmt.Errorf("%s does not import %s", mainPath, goformsImportPath)
	}

	// Run's argument.
	var runArg ast.Expr
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || runArg != nil {
			return runArg == nil
		}
		if parts, ok := selChain(call.Fun); ok && len(parts) == 2 && parts[0] == gfName && parts[1] == "Run" && len(call.Args) == 1 {
			runArg = call.Args[0]
			return false
		}
		return true
	})
	if runArg == nil {
		return nil, fmt.Errorf("%s has no %s.Run(...) call to point at the form", mainPath, gfName)
	}

	var edits []edit
	addImport := false
	if !samePackage && alias == "" {
		alias = form.model.Package
		for n := 2; used[alias]; n++ {
			alias = form.model.Package + strconv.Itoa(n)
		}
		addImport = true
	}
	expr := fmt.Sprintf("New%s().Form", form.model.ReceiverType)
	if !samePackage {
		expr = alias + "." + expr
	}
	oldExpr := string(src[offset(fset, runArg.Pos()):offset(fset, runArg.End())])
	if oldExpr == expr {
		return &StartupResult{File: mainPath, Form: expr}, nil
	}
	edits = append(edits, edit{offset(fset, runArg.Pos()), offset(fset, runArg.End()), expr})

	// The old form's package goes when Run was its only use.
	if oldPkg := leadingIdent(runArg); oldPkg != "" && oldPkg != alias {
		refs := 0
		ast.Inspect(f, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == oldPkg {
					refs++
				}
			}
			return true
		})
		if refs == 1 {
			for _, imp := range f.Imports {
				if importName(imp) == oldPkg {
					start, end := wholeLines(src, offset(fset, imp.Pos()), offset(fset, imp.End()))
					edits = append(edits, edit{start, end, ""})
				}
			}
		}
	}

	if addImport {
		spec := fmt.Sprintf("%s %s", alias, strconv.Quote(formImport))
		at, text := importInsertion(fset, f, src, spec)
		edits = append(edits, edit{at, at, text})
	}

	buf, err := spliceEdits(src, edits)
	if err != nil {
		return nil, err
	}
	formatted, err := format.Source(buf)
	if err != nil {
		return nil, fmt.Errorf("rewriting %s produced invalid Go: %w", mainPath, err)
	}
	if !bytes.Equal(formatted, src) {
		if err := os.WriteFile(mainPath, formatted, 0o644); err != nil {
			return nil, err
		}
	}
	return &StartupResult{File: mainPath, Changed: true, Form: expr}, nil
}

// leadingIdent names the package a `pkg.NewForm().Form` expression starts
// with, or "" for a form in main's own package.
func leadingIdent(e ast.Expr) string {
	for {
		switch v := e.(type) {
		case *ast.SelectorExpr:
			if id, ok := v.X.(*ast.Ident); ok {
				return id.Name
			}
			e = v.X
		case *ast.CallExpr:
			e = v.Fun
		default:
			return ""
		}
	}
}

// importInsertion is where a new import spec goes: into the last import
// block, or a new one after the package clause.
func importInsertion(fset *token.FileSet, f *ast.File, src []byte, spec string) (int, string) {
	var last *ast.GenDecl
	for _, decl := range f.Decls {
		if gd, ok := decl.(*ast.GenDecl); ok && gd.Tok == token.IMPORT {
			last = gd
		}
	}
	if last == nil {
		return offset(fset, f.Name.End()), "\n\nimport " + spec
	}
	if last.Rparen.IsValid() {
		return offset(fset, last.Rparen), "\t" + spec + "\n"
	}
	return offset(fset, last.End()), "\nimport " + spec
}
