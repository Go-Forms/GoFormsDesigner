package mainform

import (
	"fmt"
	"time"

	"fyne.io/fyne/v2"

	"github.com/Go-Forms/GoForms"
	aboutform "{{MODULE}}/Forms/AboutForm"
)

// MainForm.go is the hand-written half of the partial-class split: event
// handlers and business logic. Layout lives in MainForm-designer.go.

func (mf *MainForm) MainForm_Load(sender any, e goforms.EventArgs) {
	mf.clock.Start()
}

func (mf *MainForm) MainForm_Closing(sender any, e *goforms.CancelEventArgs) {
	mf.clock.Stop()
}

func (mf *MainForm) btnGreet_Click(sender any, e goforms.MouseEventArgs) {
	name := mf.txtName.Text()
	if name == "" {
		name = "stranger"
	}
	mf.lblGreeting.SetText(fmt.Sprintf("Hello, %s!", name))

	// Nudge the progress bar each click, wrapping at 100 - just to prove
	// ProgressBar.SetValue works.
	mf.progressValue = (mf.progressValue + 10) % 110
	mf.progressBar.SetValue(mf.progressValue)
}

// showAbout is the actual work, kept separate because two different events
// trigger it - the About button (MouseEventArgs) and the Help > About menu
// item (EventArgs) - and their handler signatures differ.
func (mf *MainForm) showAbout() {
	// ShowDialog blocks, so it must run off the UI goroutine (see the
	// warning on Form.ShowDialog). We hop back onto the UI thread via
	// fyne.Do once it returns.
	go func() {
		about := aboutform.NewAboutForm()
		result := about.ShowDialog()
		fyne.Do(func() {
			if result == goforms.DialogOK {
				mf.lblGreeting.SetText("Thanks for checking GoForms out!")
			}
		})
	}()
}

func (mf *MainForm) btnAbout_Click(sender any, e goforms.MouseEventArgs) {
	mf.showAbout()
}

func (mf *MainForm) menuAbout_Click(sender any, e goforms.EventArgs) {
	mf.showAbout()
}

func (mf *MainForm) chkSubscribe_CheckedChanged(sender any, e goforms.EventArgs) {
	if mf.chkSubscribe.Checked() {
		mf.lblGreeting.SetText("Subscribed!")
	}
}

func (mf *MainForm) radioTheme_CheckedChanged(sender any, e goforms.EventArgs) {
	switch {
	case mf.radioLight.Checked():
		mf.lblGreeting.SetText("Theme: Light")
	case mf.radioDark.Checked():
		mf.lblGreeting.SetText("Theme: Dark")
	case mf.radioSystem.Checked():
		mf.lblGreeting.SetText("Theme: System")
	}
}

func (mf *MainForm) ctxRemoveFruit_Click(sender any, e goforms.EventArgs) {
	idx := mf.lstFruits.SelectedIndex()
	if idx < 0 {
		return
	}
	items := mf.lstFruits.Items()
	next := append(append([]string{}, items[:idx]...), items[idx+1:]...)
	mf.lstFruits.SetItems(next)
}

func (mf *MainForm) ctxClearFruit_Click(sender any, e goforms.EventArgs) {
	mf.lstFruits.SetItems(nil)
}

func (mf *MainForm) clock_Tick(sender any, e goforms.EventArgs) {
	mf.lblClock.SetText(time.Now().Format("15:04:05"))
}

func (mf *MainForm) menuExit_Click(sender any, e goforms.EventArgs) {
	mf.Close()
}
