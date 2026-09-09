package main

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// handlerDir lays out a designer file plus whatever paired files a test needs
// and returns the designer file's path.
func handlerDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	designer := filepath.Join(dir, "MainForm-designer.go")
	if err := os.WriteFile(designer, []byte(designerFixture), 0o644); err != nil {
		t.Fatalf("write designer: %v", err)
	}
	for name, src := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return designer
}

func ensure(t *testing.T, designer, method, paramType string) string {
	t.Helper()
	res, err := ensureHandler(designer, "MainForm", "mf", method, paramType)
	if err != nil {
		t.Fatalf("ensureHandler(%s): %v", method, err)
	}
	b, err := os.ReadFile(res.File)
	if err != nil {
		t.Fatalf("read %s: %v", res.File, err)
	}
	return string(b)
}

// The catalog names argument types bare, so the stub is where the package
// qualifier has to be put back. Without it the generated method reads
// `e MouseEventArgs`, which names nothing and stops the package compiling.
func TestEnsureHandlerQualifiesEventArgs(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nimport \"goforms\"\n\nfunc (mf *MainForm) existing(sender any, e goforms.EventArgs) {\n}\n",
	})

	src := ensure(t, designer, "btn_Click", "MouseEventArgs")
	if !strings.Contains(src, "func (mf *MainForm) btn_Click(sender any, e goforms.MouseEventArgs) {") {
		t.Fatalf("stub is not qualified:\n%s", src)
	}
}

func TestEnsureHandlerLeavesAQualifiedTypeAlone(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nimport \"goforms\"\n\nfunc (mf *MainForm) existing(sender any, e goforms.EventArgs) {\n}\n",
	})

	src := ensure(t, designer, "btn_Click", "goforms.KeyEventArgs")
	if strings.Contains(src, "goforms.goforms.") {
		t.Fatalf("qualifier applied twice:\n%s", src)
	}
	if !strings.Contains(src, "e goforms.KeyEventArgs") {
		t.Fatalf("stub lost its type:\n%s", src)
	}
}

// A paired file that does not import goforms yet - the common case for a
// hand-written file holding nothing but plain helpers - has to gain the
// import in the same write, or the stub lands in a file that no longer builds.
func TestEnsureHandlerAddsTheMissingImport(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nfunc (mf *MainForm) helper() string {\n\treturn \"x\"\n}\n",
	})

	src := ensure(t, designer, "btn_Click", "MouseEventArgs")
	if strings.Count(src, `"`+goformsImportPath+`"`) != 1 {
		t.Fatalf("want exactly one goforms import:\n%s", src)
	}
	if !strings.Contains(src, "e goforms.MouseEventArgs") {
		t.Fatalf("stub is not qualified:\n%s", src)
	}
	assertParses(t, src)
}

func TestEnsureHandlerJoinsAnExistingImportBlock(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nimport (\n\t\"fmt\"\n)\n\nfunc (mf *MainForm) helper() { fmt.Println(\"x\") }\n",
	})

	src := ensure(t, designer, "btn_Click", "MouseEventArgs")
	if strings.Count(src, "import") != 1 {
		t.Fatalf("want one import block:\n%s", src)
	}
	assertParses(t, src)
}

// A file importing goforms under an alias gets stubs spelled with that alias,
// rather than a second import of the same path under its own name.
func TestEnsureHandlerHonoursAnImportAlias(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nimport gf \"goforms\"\n\nfunc (mf *MainForm) existing(sender any, e gf.EventArgs) {\n}\n",
	})

	src := ensure(t, designer, "btn_Click", "MouseEventArgs")
	if !strings.Contains(src, "e gf.MouseEventArgs") {
		t.Fatalf("stub ignored the alias:\n%s", src)
	}
	if strings.Count(src, `"goforms"`) != 1 {
		t.Fatalf("the import was duplicated:\n%s", src)
	}
}

// A ToolStrip button's callback is a bare func(), so noParams must survive
// qualification untouched.
func TestEnsureHandlerKeepsParameterlessStubs(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nimport \"goforms\"\n\nfunc (mf *MainForm) existing(sender any, e goforms.EventArgs) {\n}\n",
	})

	src := ensure(t, designer, "tsNew_Click", noParams)
	if !strings.Contains(src, "func (mf *MainForm) tsNew_Click() {") {
		t.Fatalf("want a parameterless stub:\n%s", src)
	}
	if strings.Contains(src, "goforms.none") {
		t.Fatalf("the sentinel was qualified:\n%s", src)
	}
}

// With no paired file at all the counterpart is created from scratch, and it
// must arrive complete: package clause, import, qualified stub.
func TestEnsureHandlerCreatesACompilableCounterpart(t *testing.T) {
	designer := handlerDir(t, nil)

	res, err := ensureHandler(designer, "MainForm", "mf", "btn_Click", "MouseEventArgs")
	if err != nil {
		t.Fatalf("ensureHandler: %v", err)
	}
	if !res.FileCreated {
		t.Fatalf("want a new counterpart file, got %+v", res)
	}
	b, err := os.ReadFile(res.File)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(string(b), "e goforms.MouseEventArgs") {
		t.Fatalf("stub is not qualified:\n%s", b)
	}
	assertParses(t, string(b))
}

// assertParses fails the test if src is not valid Go.
func assertParses(t *testing.T, src string) {
	t.Helper()
	if _, err := parser.ParseFile(token.NewFileSet(), "", src, parser.ParseComments); err != nil {
		t.Fatalf("generated file does not parse: %v\n%s", err, src)
	}
}

// A project created before the framework was published imports it by its old
// module path. That is still a working project, and a stub added to one must
// use the import already there rather than adding a second one for the same
// package under a different path.
func TestEnsureHandlerRecognisesTheLegacyImportPath(t *testing.T) {
	designer := handlerDir(t, map[string]string{
		"MainForm.go": "package mainform\n\nimport \"goforms\"\n\nfunc (mf *MainForm) existing(sender any, e goforms.EventArgs) {\n}\n",
	})

	src := ensure(t, designer, "btn_Click", "MouseEventArgs")
	if strings.Contains(src, goformsImportPath) {
		t.Fatalf("a second import was added for the same package:\n%s", src)
	}
	if !strings.Contains(src, "e goforms.MouseEventArgs") {
		t.Fatalf("stub is not qualified:\n%s", src)
	}
	assertParses(t, src)
}
