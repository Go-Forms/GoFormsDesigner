package mainform

import "github.com/Go-Forms/GoForms"

// MainForm-designer.go is the generated-looking half of the WinForms-style
// partial-class split: field declarations and initializeComponent() live
// here. Hand-written logic and event handler bodies belong in MainForm.go.
// The GoForms Designer regenerates only this file.
//
// The form is designed at a browser tab's size, and built from docked
// and anchored controls rather than fixed positions, so it fills whatever
// screen it gets: the header and the input row stick to the top, the list
// takes the rest. Open it in the designer and use Preview to see it
// at other sizes.
type MainForm struct {
	*goforms.Form

	lblTitle *goforms.Label
	pnlInput *goforms.Panel
	txtItem  *goforms.TextBox
	btnAdd   *goforms.Button
	lstItems *goforms.ListBox
	btnClear *goforms.Button
}

// NewMainForm mirrors `new MainForm()` - allocate, then initializeComponent.
func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("{{APP_NAME}}", 960, 600)}
	mf.initializeComponent()
	return mf
}

// initializeComponent mirrors the WinForms designer's InitializeComponent():
// pure layout, no business logic.
func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(960, 600)
	mf.SetPadding(goforms.NewPadding(12))

	mf.lblTitle = goforms.NewLabel("{{APP_NAME}}")
	mf.lblTitle.SetBounds(12, 12, 936, 40)
	mf.lblTitle.SetFont(goforms.NewFont("", 20, true, false))
	mf.lblTitle.SetDock(goforms.DockTop)
	mf.AddControl(mf.lblTitle)

	mf.pnlInput = goforms.NewPanel(936, 44)
	mf.pnlInput.SetBounds(12, 52, 936, 44)
	mf.pnlInput.SetDock(goforms.DockTop)
	mf.AddControl(mf.pnlInput)

	mf.txtItem = goforms.NewTextBox()
	mf.txtItem.SetBounds(0, 4, 844, 36)
	mf.txtItem.SetPlaceholder("What needs doing?")
	mf.txtItem.SetAnchor(goforms.AnchorTop | goforms.AnchorLeft | goforms.AnchorRight)
	mf.pnlInput.AddControl(mf.txtItem)

	mf.btnAdd = goforms.NewButton("Add")
	mf.btnAdd.SetBounds(852, 4, 84, 36)
	mf.btnAdd.SetAnchor(goforms.AnchorTop | goforms.AnchorRight)
	mf.btnAdd.Click.Handle(mf.btnAdd_Click)
	mf.pnlInput.AddControl(mf.btnAdd)

	mf.btnClear = goforms.NewButton("Clear done")
	mf.btnClear.SetBounds(12, 548, 936, 40)
	mf.btnClear.SetDock(goforms.DockBottom)
	mf.btnClear.Click.Handle(mf.btnClear_Click)
	mf.AddControl(mf.btnClear)

	mf.lstItems = goforms.NewListBox("Tap an item to mark it done", "Add your own above")
	mf.lstItems.SetBounds(12, 104, 936, 436)
	mf.lstItems.SetDock(goforms.DockFill)
	mf.lstItems.SelectedIndexChanged.Handle(mf.lstItems_SelectedIndexChanged)
	mf.AddControl(mf.lstItems)
}
