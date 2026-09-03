package aboutform

import "goforms"

// AboutForm.go: hand-written event handlers, mirrors the WinForms partial
// class's non-designer half.

func (af *AboutForm) btnOK_Click(sender any, e goforms.MouseEventArgs) {
	af.CloseWithResult(goforms.DialogOK)
}
