package mainform

import (
	"image"
	"image/color"
	"image/draw"

	"github.com/Go-Forms/GoForms"
)

// MainForm-designer.go is the generated-looking half of the WinForms-style
// partial-class split: field declarations and InitializeComponent() live
// here. Hand-written logic and event handler bodies live in MainForm.go.
// A future GoForms VS Code designer would regenerate only this file.
type MainForm struct {
	*goforms.Form

	lblGreeting *goforms.Label
	txtName     *goforms.TextBox
	btnGreet    *goforms.Button
	btnAbout    *goforms.Button

	grpOptions   *goforms.GroupBox
	chkSubscribe *goforms.CheckBox
	radioLight   *goforms.RadioButton
	radioDark    *goforms.RadioButton
	radioSystem  *goforms.RadioButton
	themeGroup   *goforms.RadioButtonGroup

	cmbCountry *goforms.ComboBox
	lstFruits  *goforms.ListBox

	pnlInfo     *goforms.Panel
	picLogo     *goforms.PictureBox
	progressBar *goforms.ProgressBar

	lblClock *goforms.Label
	clock    *goforms.Timer

	progressValue int
}

// NewMainForm mirrors `new MainForm()` — allocate, then InitializeComponent.
func NewMainForm() *MainForm {
	mf := &MainForm{Form: goforms.NewForm("{{MODULE}} - Main Form", 640, 480)}
	mf.initializeComponent()
	return mf
}

// initializeComponent mirrors the WinForms designer's InitializeComponent():
// pure layout, no business logic.
func (mf *MainForm) initializeComponent() {
	mf.SetClientSize(640, 480)
	mf.CenterOnScreen()

	mf.lblGreeting = goforms.NewLabel("Hello!")
	mf.lblGreeting.SetBounds(20, 20, 300, 24)
	mf.AddControl(mf.lblGreeting)

	nameLabel := goforms.NewLabel("Name:")
	nameLabel.SetBounds(20, 56, 50, 24)
	mf.AddControl(nameLabel)

	mf.txtName = goforms.NewTextBox()
	mf.txtName.SetBounds(75, 52, 160, 30)
	mf.txtName.SetPlaceholder("your name")
	mf.AddControl(mf.txtName)

	mf.btnGreet = goforms.NewButton("Greet")
	mf.btnGreet.SetBounds(245, 52, 80, 30)
	mf.btnGreet.Click.Handle(mf.btnGreet_Click)
	mf.AddControl(mf.btnGreet)

	mf.btnAbout = goforms.NewButton("About...")
	mf.btnAbout.SetBounds(335, 52, 80, 30)
	mf.btnAbout.Click.Handle(mf.btnAbout_Click)
	mf.AddControl(mf.btnAbout)

	// GroupBox with children positioned RELATIVE to the group box, not the form.
	mf.grpOptions = goforms.NewGroupBox("Options", 300, 150)
	mf.grpOptions.SetBounds(20, 100, 300, 150)
	mf.AddControl(mf.grpOptions)

	mf.chkSubscribe = goforms.NewCheckBox("Subscribe to newsletter")
	mf.chkSubscribe.SetBounds(10, 10, 220, 24)
	mf.chkSubscribe.CheckedChanged.Handle(mf.chkSubscribe_CheckedChanged)
	mf.grpOptions.AddControl(mf.chkSubscribe)

	mf.themeGroup = goforms.NewRadioButtonGroup()

	mf.radioLight = goforms.NewRadioButton("Light")
	mf.radioLight.SetBounds(10, 44, 90, 24)
	mf.radioLight.CheckedChanged.Handle(mf.radioTheme_CheckedChanged)
	mf.themeGroup.Add(mf.radioLight)
	mf.grpOptions.AddControl(mf.radioLight)

	mf.radioDark = goforms.NewRadioButton("Dark")
	mf.radioDark.SetBounds(100, 44, 90, 24)
	mf.radioDark.CheckedChanged.Handle(mf.radioTheme_CheckedChanged)
	mf.themeGroup.Add(mf.radioDark)
	mf.grpOptions.AddControl(mf.radioDark)

	mf.radioSystem = goforms.NewRadioButton("System")
	mf.radioSystem.SetBounds(190, 44, 90, 24)
	mf.radioSystem.CheckedChanged.Handle(mf.radioTheme_CheckedChanged)
	mf.themeGroup.Add(mf.radioSystem)
	mf.grpOptions.AddControl(mf.radioSystem)
	mf.radioLight.SetChecked(true)

	mf.cmbCountry = goforms.NewComboBox("USA", "Russia", "Germany", "Japan", "Brazil")
	mf.cmbCountry.SetBounds(10, 84, 150, 30)
	mf.cmbCountry.SetPlaceholder("Country")
	mf.grpOptions.AddControl(mf.cmbCountry)

	// Right-click context menu, demonstrating Control.SetContextMenu.
	removeItem := goforms.NewMenuItem("Remove selected")
	removeItem.Click.Handle(mf.ctxRemoveFruit_Click)
	clearItem := goforms.NewMenuItem("Clear all")
	clearItem.Click.Handle(mf.ctxClearFruit_Click)
	fruitMenu := goforms.NewContextMenu(removeItem, clearItem)

	mf.lstFruits = goforms.NewListBox("Apple", "Banana", "Cherry", "Dragonfruit", "Elderberry")
	mf.lstFruits.SetBounds(340, 100, 150, 150)
	mf.lstFruits.SetContextMenu(fruitMenu)
	mf.AddControl(mf.lstFruits)

	mf.pnlInfo = goforms.NewPanel(300, 90)
	mf.pnlInfo.SetBounds(20, 270, 300, 90)
	mf.pnlInfo.SetBackColor(color.NRGBA{R: 0xf0, G: 0xf0, B: 0xf0, A: 0xff})
	mf.AddControl(mf.pnlInfo)

	mf.picLogo = goforms.NewPictureBox(64, 64)
	mf.picLogo.SetBounds(10, 13, 64, 64)
	mf.picLogo.LoadImage(makePlaceholderLogo())
	mf.pnlInfo.AddControl(mf.picLogo)

	mf.progressBar = goforms.NewProgressBar()
	mf.progressBar.SetBounds(90, 40, 190, 20)
	mf.progressBar.SetRange(0, 100)
	mf.pnlInfo.AddControl(mf.progressBar)

	mf.lblClock = goforms.NewLabel("00:00:00")
	mf.lblClock.SetBounds(490, 20, 130, 24)
	mf.AddControl(mf.lblClock)

	mf.clock = goforms.NewTimer(1000)
	mf.clock.Tick.Handle(mf.clock_Tick)

	fileMenu := goforms.NewTopMenu("File", goforms.NewMenuItem("Exit"))
	fileMenu.Items[0].Click.Handle(mf.menuExit_Click)
	helpMenu := goforms.NewTopMenu("Help", goforms.NewMenuItem("About"))
	helpMenu.Items[0].Click.Handle(mf.menuAbout_Click)
	mf.SetMainMenu(goforms.NewMenuStrip(fileMenu, helpMenu))

	mf.Load.Handle(mf.MainForm_Load)
	mf.Closing.Handle(mf.MainForm_Closing)
}

func makePlaceholderLogo() image.Image {
	img := image.NewNRGBA(image.Rect(0, 0, 64, 64))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: color.NRGBA{R: 0x2d, G: 0x6c, B: 0xdf, A: 0xff}}, image.Point{}, draw.Src)
	return img
}
