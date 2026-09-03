package mainform

import "goforms"

// MainForm-designer.go is the generated-looking half of the WinForms-style
// partial-class split: field declarations and initializeComponent() live
// here. Hand-written logic and event handler bodies belong in MainForm.go.
// The GoForms Designer regenerates only this file.
type MainForm struct {
	*goforms.Form

	lblWelcome *goforms.Label
}

// NewMainForm mirrors `new MainForm()` - allocate, then initializeComponent.
func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("{{MODULE}}", 500, 350)}
	mf.initializeComponent()
	return mf
}

// initializeComponent mirrors the WinForms designer's InitializeComponent():
// pure layout, no business logic.
func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(500, 350)
	mf.CenterOnScreen()

	mf.lblWelcome = goforms.NewLabel("New GoForms App")
	mf.lblWelcome.SetBounds(20, 20, 300, 24)
	mf.AddControl(mf.lblWelcome)
}
