package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}.go is the hand-written half of the form: event handlers and
// logic. Layout lives in {{FORM}}-designer.go.

func (f *{{FORM}}) btnOK_Click(sender any, e goforms.MouseEventArgs) {
	f.CloseWithResult(goforms.DialogOK)
}

func (f *{{FORM}}) btnCancel_Click(sender any, e goforms.MouseEventArgs) {
	f.CloseWithResult(goforms.DialogCancel)
}
