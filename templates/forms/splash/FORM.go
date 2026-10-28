package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}.go is the hand-written half of the form: event handlers and
// logic. Layout lives in {{FORM}}-designer.go.

func (f *{{FORM}}) tmrClose_Tick(sender any, e goforms.EventArgs) {
	f.tmrClose.Stop()
	f.Close()
}
