package mainform

import (
	"strings"

	"github.com/Go-Forms/GoForms"
)

// MainForm.go is the hand-written half of the partial-class split: event
// handlers and business logic go here. Layout lives in MainForm-designer.go.

const doneMark = "✓ "

func (mf *MainForm) btnAdd_Click(sender any, e goforms.MouseEventArgs) {
	text := strings.TrimSpace(mf.txtItem.Text())
	if text == "" {
		return
	}
	mf.lstItems.SetItems(append(mf.lstItems.Items(), text))
	mf.txtItem.SetText("")
}

// lstItems_SelectedIndexChanged toggles the tick on the tapped item. On a
// phone a tap is the only gesture a list gets, so selection is the action.
func (mf *MainForm) lstItems_SelectedIndexChanged(sender any, e goforms.EventArgs) {
	i := mf.lstItems.SelectedIndex()
	if i < 0 {
		return
	}
	items := append([]string(nil), mf.lstItems.Items()...)
	if strings.HasPrefix(items[i], doneMark) {
		items[i] = strings.TrimPrefix(items[i], doneMark)
	} else {
		items[i] = doneMark + items[i]
	}
	mf.lstItems.SetItems(items)
}

func (mf *MainForm) btnClear_Click(sender any, e goforms.MouseEventArgs) {
	var keep []string
	for _, item := range mf.lstItems.Items() {
		if !strings.HasPrefix(item, doneMark) {
			keep = append(keep, item)
		}
	}
	mf.lstItems.SetItems(keep)
}
