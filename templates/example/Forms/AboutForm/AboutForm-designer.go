package aboutform

import "goforms"

// AboutForm-designer.go: layout only, mirrors the WinForms designer file.
type AboutForm struct {
	*goforms.Form

	lblTitle *goforms.Label
	lblBody  *goforms.Label
	btnOK    *goforms.Button
}

// NewAboutForm mirrors `new AboutForm()`.
func NewAboutForm() *AboutForm {
	af := &AboutForm{Form: goforms.NewForm("About {{MODULE}}", 320, 160)}
	af.initializeComponent()
	return af
}

func (af *AboutForm) initializeComponent() {
	af.SetClientSize(320, 160)
	af.SetFixedSize(true)

	af.lblTitle = goforms.NewLabel("{{MODULE}}")
	af.lblTitle.SetBounds(20, 20, 280, 24)
	af.AddControl(af.lblTitle)

	af.lblBody = goforms.NewLabel("A WinForms-style GUI framework for Go,\nbuilt on top of Fyne.")
	af.lblBody.SetBounds(20, 50, 280, 50)
	af.AddControl(af.lblBody)

	af.btnOK = goforms.NewButton("OK")
	af.btnOK.SetBounds(220, 110, 80, 30)
	af.btnOK.Click.Handle(af.btnOK_Click)
	af.AddControl(af.btnOK)
}
