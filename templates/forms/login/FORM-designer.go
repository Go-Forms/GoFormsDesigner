package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}-designer.go is the layout half of the form: field declarations and
// initializeComponent(). Handlers and logic belong in {{FORM}}.go. The
// GoForms Designer rewrites only this file.
type {{FORM}} struct {
	*goforms.Form

	lblUserName *goforms.Label
	txtUserName *goforms.TextBox
	lblPassword *goforms.Label
	txtPassword *goforms.TextBox
	btnOK       *goforms.Button
	btnCancel   *goforms.Button
}

// New{{FORM}} mirrors "new {{FORM}}()" - a login form, as Visual Studio's
// Login Form template makes one.
func New{{FORM}}() *{{FORM}} {
	f := &{{FORM}}{Form: goforms.NewForm("Sign in", 360, 200)}
	f.initializeComponent()
	return f
}

func (f *{{FORM}}) initializeComponent() {
	f.SetClientSize(360, 200)
	f.SetFixedSize(true)
	f.CenterOnScreen()

	f.lblUserName = goforms.NewLabel("User name")
	f.lblUserName.SetBounds(20, 20, 320, 22)
	f.AddControl(f.lblUserName)

	f.txtUserName = goforms.NewTextBox()
	f.txtUserName.SetBounds(20, 44, 320, 30)
	f.AddControl(f.txtUserName)

	f.lblPassword = goforms.NewLabel("Password")
	f.lblPassword.SetBounds(20, 82, 320, 22)
	f.AddControl(f.lblPassword)

	f.txtPassword = goforms.NewPasswordTextBox()
	f.txtPassword.SetBounds(20, 106, 320, 30)
	f.AddControl(f.txtPassword)

	f.btnOK = goforms.NewButton("OK")
	f.btnOK.SetBounds(160, 155, 85, 30)
	f.btnOK.Click.Handle(f.btnOK_Click)
	f.AddControl(f.btnOK)

	f.btnCancel = goforms.NewButton("Cancel")
	f.btnCancel.SetBounds(255, 155, 85, 30)
	f.btnCancel.Click.Handle(f.btnCancel_Click)
	f.AddControl(f.btnCancel)
}
