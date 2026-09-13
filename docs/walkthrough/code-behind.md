### The other half of the form

A form is two files. `MainForm-designer.go` holds the layout and is rewritten
by the designer; `MainForm.go` holds what you write and is never touched.

`F7` goes from the designer to the code, `Shift+F7` goes back — the same keys
Visual Studio uses.

Double-clicking a control in the designer creates its handler in the code file
and wires it up:

```go
func (f *MainForm) okButton_Click(sender any, e goforms.MouseEventArgs) {
	goforms.ShowMessageBox(f.Form, "Saved.", "MainForm",
		goforms.MessageBoxOK, goforms.MessageBoxInformation, nil)
}
```

Snippets cover the rest. Type `gf` in a Go file to see them all: `gfbutton`,
`gfgrid`, `gfmsgbox`, `gfopenfile`, `gftimer`, `gfmenu` and about thirty more.
