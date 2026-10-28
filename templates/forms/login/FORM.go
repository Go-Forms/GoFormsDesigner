package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}.go is the hand-written half of the form: event handlers and
// logic. Layout lives in {{FORM}}-designer.go.

// UserName and Password are what was typed, for the caller to read once
// ShowDialog has returned goforms.DialogOK.
func (f *{{FORM}}) UserName() string { return f.txtUserName.Text() }
func (f *{{FORM}}) Password() string { return f.txtPassword.Text() }

func (f *{{FORM}}) btnOK_Click(sender any, e goforms.MouseEventArgs) {
	f.CloseWithResult(goforms.DialogOK)
}

func (f *{{FORM}}) btnCancel_Click(sender any, e goforms.MouseEventArgs) {
	f.CloseWithResult(goforms.DialogCancel)
}
