### The designer

Open any `*-designer.go` file and the visual designer opens instead of the
text editor. Drag a control from the toolbox onto the form, drag it around,
drag its handles to resize, and edit its properties on the right.

Every change is written straight back into `initializeComponent()` as ordinary
Go:

```go
func (f *MainForm) initializeComponent() {
	f.SetClientSize(500, 350)

	f.okButton = goforms.NewButton("OK")
	f.okButton.SetBounds(390, 300, 90, 28)
	f.AddControl(f.okButton)
}
```

There is no `.designer` file format, no XML and no project file: the Go source
*is* the document. `GoForms: Open as Text` shows it at any moment, and edits
made there are picked up by the designer.
