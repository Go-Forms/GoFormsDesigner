package main

// project.go is the project's own controls in the toolbox, as Visual Studio
// lists a project's controls and user controls in a "<Project> Components"
// group.
//
// A GoForms control of your own is a struct that embeds a framework control
// - most often a Panel, the way a WinForms UserControl derives from
// ContainerControl - with a constructor beside it:
//
//	package widgets
//
//	type Gauge struct {
//		*goforms.Panel
//		...
//	}
//
//	func NewGauge() *Gauge                  // or NewGauge(w, h float32)
//
// The tool finds these by reading the module's source (no build, so none of
// the project's code runs), offers them to the toolbox, and writes and reads
// them in a designer file like any other control:
//
//	gauge1 *widgets.Gauge
//	...
//	mf.gauge1 = widgets.NewGauge()
//	mf.gauge1.SetBounds(20, 20, 200, 100)
//	mf.AddControl(mf.gauge1)
//
// Such a control has the properties and events every control inherits; the
// canvas draws it as a placeholder with its type name, since its painting is
// its own code.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// CustomType says where a project control comes from and how it is made.
type CustomType struct {
	// Import is the package's import path; Package the name it declares.
	Import  string `json:"import"`
	Package string `json:"package"`
	// Name is the type, Ctor its constructor.
	Name string `json:"name"`
	Ctor string `json:"ctor"`
	// SizeArgs marks a constructor taking (w, h float32), as NewPanel does.
	SizeArgs bool `json:"sizeArgs,omitempty"`
	// Embeds names the framework control it is built on, e.g. "Panel".
	Embeds string `json:"embeds,omitempty"`
}

// customKey is a project control's catalog key and model type: the package
// name and the type, "widgets.Gauge" - what the Go source calls it.
func customKey(c *CustomType) string { return c.Package + "." + c.Name }

// CategoryProject is the toolbox group the project's controls go in.
const CategoryProject = "Project Controls"

// registerCustom puts a project control into the catalog for the rest of
// this run of the tool, so parse, apply and codegen treat it like a framework
// type. The tool is one process per command, so this never outlives the
// file it is about.
func registerCustom(c *CustomType, container bool) *ControlDesc {
	key := customKey(c)
	if d, ok := catalog[key]; ok && d.Custom != nil {
		// The latest description wins: it is the one just read from source.
		d.Custom = c
		d.Ctors = []string{c.Ctor}
		d.IsContainer = d.IsContainer || container
		return d
	}
	d := &ControlDesc{
		Type: key, Category: CategoryProject, Ctors: []string{c.Ctor},
		DefaultW: 200, DefaultH: 100,
		IsContainer: container,
		Setters:     map[string]string{},
		Custom:      c,
	}
	catalog[key] = d
	return d
}

// containerEmbeds are the framework types a control built on is a container.
var containerEmbeds = map[string]bool{"Panel": true, "GroupBox": true, "ScrollBox": true, "FlowLayoutPanel": true, "TableLayoutPanel": true, "ContainerControl": true}

// projectControls scans the module containing dir for project controls.
func projectControls(dir string) ([]*ControlDesc, error) {
	root, module, err := findModule(dir)
	if err != nil {
		return nil, err
	}
	var out []*ControlDesc
	err = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if p != root && (strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") || name == "vendor" || name == "testdata" || name == "node_modules" || name == "build") {
				return filepath.SkipDir
			}
			// A nested module is its own project.
			if p != root {
				if _, err := os.Stat(filepath.Join(p, "go.mod")); err == nil {
					return filepath.SkipDir
				}
			}
			rel, _ := filepath.Rel(root, p)
			imp := module
			if rel != "." {
				imp = path.Join(module, filepath.ToSlash(rel))
			}
			for _, c := range scanPackage(p, imp) {
				desc := registerCustom(c, containerEmbeds[c.Embeds])
				out = append(out, desc)
			}
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out, err
}

// scanPackage finds the project controls one directory declares.
func scanPackage(dir, importPath string) []*CustomType {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	fset := token.NewFileSet()
	var files []*ast.File
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, n), nil, parser.SkipObjectResolution)
		if err != nil {
			continue
		}
		files = append(files, f)
	}
	if len(files) == 0 || files[0].Name.Name == "main" {
		// A control in package main cannot be imported by a form.
		return nil
	}
	pkg := files[0].Name.Name

	// The structs that embed a framework control, by the goforms import's
	// name in their file.
	embeds := map[string]string{}
	for _, f := range files {
		gf := goformsName(f)
		if gf == "" {
			continue
		}
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.TYPE {
				continue
			}
			for _, spec := range gd.Specs {
				ts, ok := spec.(*ast.TypeSpec)
				if !ok || !ts.Name.IsExported() {
					continue
				}
				st, ok := ts.Type.(*ast.StructType)
				if !ok {
					continue
				}
				for _, field := range st.Fields.List {
					if len(field.Names) != 0 {
						continue
					}
					t := field.Type
					if star, ok := t.(*ast.StarExpr); ok {
						t = star.X
					}
					parts, ok := selChain(t)
					if !ok || len(parts) != 2 || parts[0] != gf {
						continue
					}
					base := parts[1]
					if base == "Form" {
						break // a form, not a control
					}
					if d, ok := catalog[base]; (ok && !d.NonVisual && d.Custom == nil) || base == "ControlBase" || base == "ContainerControl" {
						embeds[ts.Name.Name] = base
						break
					}
				}
			}
		}
	}

	// Their constructors: NewT() *T, or NewT(w, h float32) *T.
	var out []*CustomType
	for _, f := range files {
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Recv != nil || !strings.HasPrefix(fd.Name.Name, "New") {
				continue
			}
			name := strings.TrimPrefix(fd.Name.Name, "New")
			base, ok := embeds[name]
			if !ok || fd.Type.Results == nil || len(fd.Type.Results.List) != 1 {
				continue
			}
			star, ok := fd.Type.Results.List[0].Type.(*ast.StarExpr)
			if !ok {
				continue
			}
			if id, ok := star.X.(*ast.Ident); !ok || id.Name != name {
				continue
			}
			sizeArgs := false
			switch n := paramCount(fd.Type.Params); n {
			case 0:
			case 2:
				sizeArgs = true
			default:
				continue
			}
			out = append(out, &CustomType{Import: importPath, Package: pkg, Name: name, Ctor: fd.Name.Name, SizeArgs: sizeArgs, Embeds: base})
		}
	}
	return out
}

func paramCount(fl *ast.FieldList) int {
	if fl == nil {
		return 0
	}
	n := 0
	for _, f := range fl.List {
		if len(f.Names) == 0 {
			n++
		} else {
			n += len(f.Names)
		}
	}
	return n
}

// goformsName is the name a file imports the framework by, or "".
func goformsName(f *ast.File) string {
	for _, imp := range f.Imports {
		p, _ := strconv.Unquote(imp.Path.Value)
		if p != goformsImportPath {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name
		}
		return goformsPkg
	}
	return ""
}

// customFromFile resolves `mf.x = alias.NewT(...)` in a designer file to a
// project control: the field must be declared `*alias.T` and alias must
// import a package of this module. It registers the type and returns its
// description, or nil.
func (r *parseResult) customFromFile(field, alias, ctor string, nargs int) *ControlDesc {
	if r.structType == nil || !strings.HasPrefix(ctor, "New") {
		return nil
	}
	name := strings.TrimPrefix(ctor, "New")
	declared := false
	for _, f := range r.structType.Fields.List {
		if len(f.Names) != 1 || f.Names[0].Name != field {
			continue
		}
		star, ok := f.Type.(*ast.StarExpr)
		if !ok {
			return nil
		}
		parts, ok := selChain(star.X)
		declared = ok && len(parts) == 2 && parts[0] == alias && parts[1] == name
	}
	if !declared || (nargs != 0 && nargs != 2) {
		return nil
	}
	imp := ""
	for _, s := range r.file.Imports {
		p, _ := strconv.Unquote(s.Path.Value)
		n := path.Base(p)
		if s.Name != nil {
			n = s.Name.Name
		}
		if n == alias {
			imp = p
		}
	}
	if imp == "" || imp == goformsImportPath {
		return nil
	}
	pkg := alias
	if root, module, err := findModule(filepath.Dir(r.path)); err == nil && (imp == module || strings.HasPrefix(imp, module+"/")) {
		dir := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(strings.TrimPrefix(imp, module), "/")))
		if name := packageNameIn(dir); name != "" {
			pkg = name
		}
	} else {
		return nil // not this module's: an outside package is not a project control
	}
	return registerCustom(&CustomType{Import: imp, Package: pkg, Name: name, Ctor: ctor, SizeArgs: nargs == 2}, false)
}

// packageNameIn reads the package clause of the first Go file in dir.
func packageNameIn(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, e.Name()), nil, parser.PackageClauseOnly)
		if err == nil {
			return f.Name.Name
		}
	}
	return ""
}

// importAlias is the name the designer file reaches a project control's
// package by: the one it is already imported as, or its package name (with
// a number added if that name is taken). add says whether the import still
// has to be written, and as what.
func importAlias(r *parseResult, c *CustomType) (alias string, add string) {
	taken := map[string]bool{}
	for _, s := range r.file.Imports {
		p, _ := strconv.Unquote(s.Path.Value)
		n := path.Base(p)
		if p == goformsImportPath {
			n = goformsPkg
		}
		if s.Name != nil {
			n = s.Name.Name
		}
		if p == c.Import {
			return n, ""
		}
		taken[n] = true
	}
	alias = c.Package
	for i := 2; taken[alias]; i++ {
		alias = c.Package + strconv.Itoa(i)
	}
	if alias == path.Base(c.Import) {
		return alias, strconv.Quote(c.Import)
	}
	return alias, alias + " " + strconv.Quote(c.Import)
}
