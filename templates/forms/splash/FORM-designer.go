package {{PACKAGE}}

import "github.com/Go-Forms/GoForms"

// {{FORM}}-designer.go is the layout half of the form: field declarations and
// initializeComponent(). Handlers and logic belong in {{FORM}}.go. The
// GoForms Designer rewrites only this file.
type {{FORM}} struct {
	*goforms.Form

	lblTitle    *goforms.Label
	lblVersion  *goforms.Label
	progressBar *goforms.ProgressBar
	tmrClose    *goforms.Timer
}

// New{{FORM}} mirrors "new {{FORM}}()" - a splash screen that closes itself
// after two seconds, as Visual Studio's Splash Screen template does.
func New{{FORM}}() *{{FORM}} {
	f := &{{FORM}}{Form: goforms.NewForm("{{FORM}}", 480, 260)}
	f.initializeComponent()
	return f
}

func (f *{{FORM}}) initializeComponent() {
	f.SetClientSize(480, 260)
	f.SetFixedSize(true)
	f.CenterOnScreen()
	f.SetBackColor(goforms.RGB(32, 56, 100))

	f.lblTitle = goforms.NewLabel("Application Title")
	f.lblTitle.SetBounds(30, 70, 420, 50)
	f.lblTitle.SetForeColor(goforms.RGB(255, 255, 255))
	f.lblTitle.SetFont(goforms.NewFont("", 26, true, false))
	f.AddControl(f.lblTitle)

	f.lblVersion = goforms.NewLabel("Version 1.0.0")
	f.lblVersion.SetBounds(30, 125, 420, 24)
	f.lblVersion.SetForeColor(goforms.RGB(220, 230, 245))
	f.AddControl(f.lblVersion)

	f.progressBar = goforms.NewProgressBar()
	f.progressBar.SetBounds(30, 210, 420, 16)
	f.AddControl(f.progressBar)

	f.tmrClose = goforms.NewTimer(2000)
	f.tmrClose.Tick.Handle(f.tmrClose_Tick)
	f.tmrClose.Start()
}
