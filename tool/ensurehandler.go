package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// EnsureHandlerResult is ensure-handler's JSON output.
type EnsureHandlerResult struct {
	File           string `json:"file"`
	Method         string `json:"method"`
	Created        bool   `json:"created"`        // a new stub method was appended
	FileCreated    bool   `json:"fileCreated"`    // the target .go file itself was created
	AlreadyExisted bool   `json:"alreadyExisted"` // the method was already there - nothing changed
	Line           int    `json:"line"`           // 1-based line of the method (existing or newly created), for the editor to jump to
}

// noParams is the paramType that asks for a parameterless stub,
// `func (recv *T) name() { }`, which is what a ToolStrip button's `func()`
// callback needs. It is a sentinel word rather than the empty string so it
// survives being passed as a CLI argument on every platform.
const noParams = "none"

// ensureHandler makes sure a `func (recvVar *receiverType) method(sender any, e paramType) { }`
// stub exists somewhere sensible, per the fallback rule described in
// GoForms' README: prefer the designer file's hand-written counterpart
// (Foo-designer.go -> Foo.go); if that doesn't exist, reuse another .go file
// in the same directory that already declares the receiver type, or failing
// that the alphabetically first non-designer .go file; if the directory has
// no other .go file at all, create the counterpart file from scratch.
func ensureHandler(designerPath, receiverType, recvVar, method, paramType string) (*EnsureHandlerResult, error) {
	dir := filepath.Dir(designerPath)
	base := filepath.Base(designerPath)
	pairedName := strings.TrimSuffix(base, "-designer.go") + ".go"
	pairedPath := filepath.Join(dir, pairedName)

	target, fileCreated, err := pickTargetFile(dir, pairedPath, designerPath, receiverType)
	if err != nil {
		return nil, err
	}

	if !fileCreated {
		if line, ok, err := findMethod(target, receiverType, method); err != nil {
			return nil, err
		} else if ok {
			return &EnsureHandlerResult{File: target, Method: method, AlreadyExisted: true, Line: line}, nil
		}
	}

	line, err := appendStub(target, fileCreated, designerPath, receiverType, recvVar, method, paramType)
	if err != nil {
		return nil, err
	}
	return &EnsureHandlerResult{File: target, Method: method, Created: true, FileCreated: fileCreated, Line: line}, nil
}

// pickTargetFile returns the file to write the stub into, and whether it
// still needs to be created from scratch.
func pickTargetFile(dir, pairedPath, designerPath, receiverType string) (string, bool, error) {
	if _, err := os.Stat(pairedPath); err == nil {
		return pairedPath, false, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false, fmt.Errorf("read dir %s: %w", dir, err)
	}
	var candidates []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "-designer.go") {
			continue
		}
		full := filepath.Join(dir, name)
		if full == designerPath {
			continue
		}
		candidates = append(candidates, full)
	}
	if len(candidates) == 0 {
		return pairedPath, true, nil // nothing else around: create the natural counterpart
	}

	for _, c := range candidates {
		if declaresReceiver(c, receiverType) {
			return c, false, nil
		}
	}
	sort.Strings(candidates)
	return candidates[0], false, nil
}

func declaresReceiver(path, receiverType string) bool {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return false
	}
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Recv == nil || len(fd.Recv.List) != 1 {
			continue
		}
		if se, ok := fd.Recv.List[0].Type.(*ast.StarExpr); ok {
			if id, ok := se.X.(*ast.Ident); ok && id.Name == receiverType {
				return true
			}
		}
	}
	return false
}

func findMethod(path, receiverType, method string) (line int, found bool, err error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		return 0, false, fmt.Errorf("parse %s: %w", path, err)
	}
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok || fd.Name.Name != method || fd.Recv == nil || len(fd.Recv.List) != 1 {
			continue
		}
		se, ok := fd.Recv.List[0].Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		if id, ok := se.X.(*ast.Ident); ok && id.Name == receiverType {
			return fset.Position(fd.Pos()).Line, true, nil
		}
	}
	return 0, false, nil
}

func appendStub(path string, fileCreated bool, designerPath, receiverType, recvVar, method, paramType string) (int, error) {
	if fileCreated {
		pkg, err := packageNameOf(designerPath)
		if err != nil {
			return 0, err
		}
		stub := stubText(recvVar, receiverType, method, qualify(paramType, goformsPkg))
		content := fmt.Sprintf("package %s\n\nimport %q\n%s", pkg, goformsImportPath, stub)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return 0, fmt.Errorf("write %s: %w", path, err)
		}
		line := strings.Count(content, "\n") - strings.Count(stub, "\n") + 2
		return line, nil
	}

	existing, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", path, err)
	}

	// The catalog names argument types bare ("MouseEventArgs"), because that
	// is also how the property panel labels them. A stub has to spell the
	// package out, under whatever name this particular file imports goforms
	// as - and if it does not import it yet, the import has to be added in
	// the same write, or the stub arrives in a file that no longer compiles.
	alias, imported := goformsAlias(path)
	if !imported {
		alias = goformsPkg
	}
	stub := stubText(recvVar, receiverType, method, qualify(paramType, alias))

	newContent := string(existing)
	if !strings.HasSuffix(newContent, "\n") {
		newContent += "\n"
	}
	if !imported && strings.Contains(stub, alias+".") {
		added, err := withGoformsImport(newContent)
		if err != nil {
			return 0, fmt.Errorf("add the goforms import to %s: %w", path, err)
		}
		newContent = added
	}
	line := strings.Count(newContent, "\n") + 2
	newContent += stub
	if err := os.WriteFile(path, []byte(newContent), 0o644); err != nil {
		return 0, fmt.Errorf("write %s: %w", path, err)
	}
	return line, nil
}

const (
	// goformsImportPath is what a new stub's import line is written as.
	goformsImportPath = "github.com/Go-Forms/GoForms"
	// goformsPkg is the package name that path binds, and the one generated
	// code spells - `goforms.NewButton(...)` - regardless of the path.
	goformsPkg = "goforms"
	// legacyImportPath is the module path from before the framework was
	// published. Projects still on it are recognized, so a stub added to one
	// uses the import it already has instead of adding a second, conflicting
	// one for the same package.
	legacyImportPath = "goforms"
)

// stubText renders the empty handler method.
//
// A ToolStrip button's callback is a bare `func()`, not the (sender, e) shape
// every semantic event uses, so noParams drops the parameter list entirely -
// generating the wrong signature would produce a stub that does not compile
// against the call wiring it up.
func stubText(recvVar, receiverType, method, paramType string) string {
	params := fmt.Sprintf("sender any, e %s", paramType)
	if paramType == noParams {
		params = ""
	}
	return fmt.Sprintf("\nfunc (%s *%s) %s(%s) {\n}\n", recvVar, receiverType, method, params)
}

// qualify puts pkg in front of an unqualified event-argument type. A type
// that already names its package, and the noParams sentinel, pass through.
func qualify(paramType, pkg string) string {
	if paramType == noParams || paramType == "" || strings.Contains(paramType, ".") {
		return paramType
	}
	return pkg + "." + paramType
}

// goformsAlias reports the name path refers to the goforms package by, and
// whether it imports it at all. A file importing it under an alias gets stubs
// spelled with that alias rather than a second, conflicting import, and the
// pre-publication module path counts as an import too - a project still on it
// is a working project, not one to add a duplicate import to.
func goformsAlias(path string) (string, bool) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
	if err != nil {
		return "", false
	}
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil || (p != goformsImportPath && p != legacyImportPath) {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name, true
		}
		return goformsPkg, true
	}
	return "", false
}

// withGoformsImport returns src with the goforms import added, joining an
// existing import block or opening one after the package clause.
func withGoformsImport(src string) (string, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "", src, parser.ParseComments)
	if err != nil {
		return "", err
	}
	for _, decl := range f.Decls {
		gd, ok := decl.(*ast.GenDecl)
		if !ok || gd.Tok != token.IMPORT {
			continue
		}
		if gd.Lparen.IsValid() {
			at := fset.Position(gd.Lparen).Offset + 1
			return src[:at] + "\n\t" + strconv.Quote(goformsImportPath) + src[at:], nil
		}
		// A single unparenthesized import: widen it into a block so the new
		// path can join it.
		start := fset.Position(gd.Pos()).Offset
		end := fset.Position(gd.End()).Offset
		block := fmt.Sprintf("import (\n\t%s\n\t%s\n)", src[start+len("import "):end], strconv.Quote(goformsImportPath))
		return src[:start] + block + src[end:], nil
	}
	at := fset.Position(f.Name.End()).Offset
	return src[:at] + "\n\nimport " + strconv.Quote(goformsImportPath) + src[at:], nil
}

func packageNameOf(path string) (string, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.PackageClauseOnly)
	if err != nil {
		return "", fmt.Errorf("parse package clause of %s: %w", path, err)
	}
	return f.Name.Name, nil
}
