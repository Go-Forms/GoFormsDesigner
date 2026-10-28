package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}-designer.go is the layout half of the form: field declarations and
// initializeComponent(). Handlers and logic belong in {{FORM}}.go. The
// GoForms Designer rewrites only this file.
type {{FORM}} struct {
	*goforms.Form

	lblMessage *goforms.Label
	btnOK      *goforms.Button
	btnCancel  *goforms.Button
}

// New{{FORM}} mirrors "new {{FORM}}()". Show it with ShowDialog and read
// what it closed with: goforms.DialogOK or goforms.DialogCancel.
func New{{FORM}}() *{{FORM}} {
	f := &{{FORM}}{Form: goforms.NewForm("{{FORM}}", 400, 180)}
	f.initializeComponent()
	return f
}

func (f *{{FORM}}) initializeComponent() {
	f.SetClientSize(400, 180)
	f.SetFixedSize(true)
	f.CenterOnScreen()

	f.lblMessage = goforms.NewLabel("Your message here.")
	f.lblMessage.SetBounds(20, 20, 360, 80)
	f.lblMessage.SetAnchor(goforms.AnchorTop | goforms.AnchorLeft | goforms.AnchorRight)
	f.AddControl(f.lblMessage)

	f.btnOK = goforms.NewButton("OK")
	f.btnOK.SetBounds(200, 130, 85, 30)
	f.btnOK.SetAnchor(goforms.AnchorBottom | goforms.AnchorRight)
	f.btnOK.Click.Handle(f.btnOK_Click)
	f.AddControl(f.btnOK)

	f.btnCancel = goforms.NewButton("Cancel")
	f.btnCancel.SetBounds(295, 130, 85, 30)
	f.btnCancel.SetAnchor(goforms.AnchorBottom | goforms.AnchorRight)
	f.btnCancel.Click.Handle(f.btnCancel_Click)
	f.AddControl(f.btnCancel)
}
