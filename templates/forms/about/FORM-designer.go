package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}-designer.go is the layout half of the form: field declarations and
// initializeComponent(). Handlers and logic belong in {{FORM}}.go. The
// GoForms Designer rewrites only this file.
type {{FORM}} struct {
	*goforms.Form

	picLogo      *goforms.PictureBox
	lblProduct   *goforms.Label
	lblVersion   *goforms.Label
	lblCopyright *goforms.Label
	txtAbout     *goforms.TextBox
	btnOK        *goforms.Button
}

// New{{FORM}} mirrors "new {{FORM}}()" - an About box, as Visual Studio's
// About Box template makes one.
func New{{FORM}}() *{{FORM}} {
	f := &{{FORM}}{Form: goforms.NewForm("About", 440, 260)}
	f.initializeComponent()
	return f
}

func (f *{{FORM}}) initializeComponent() {
	f.SetClientSize(440, 260)
	f.SetFixedSize(true)
	f.CenterOnScreen()

	f.picLogo = goforms.NewPictureBox(110, 110)
	f.picLogo.SetBounds(20, 20, 110, 110)
	f.AddControl(f.picLogo)

	f.lblProduct = goforms.NewLabel("Product Name")
	f.lblProduct.SetBounds(150, 20, 270, 24)
	f.lblProduct.SetFont(goforms.NewFont("", 16, true, false))
	f.AddControl(f.lblProduct)

	f.lblVersion = goforms.NewLabel("Version 1.0.0")
	f.lblVersion.SetBounds(150, 50, 270, 22)
	f.AddControl(f.lblVersion)

	f.lblCopyright = goforms.NewLabel("Copyright ©")
	f.lblCopyright.SetBounds(150, 76, 270, 22)
	f.AddControl(f.lblCopyright)

	f.txtAbout = goforms.NewMultilineTextBox()
	f.txtAbout.SetBounds(150, 106, 270, 100)
	f.txtAbout.SetText("Description")
	f.AddControl(f.txtAbout)

	f.btnOK = goforms.NewButton("OK")
	f.btnOK.SetBounds(335, 218, 85, 30)
	f.btnOK.Click.Handle(f.btnOK_Click)
	f.AddControl(f.btnOK)
}
