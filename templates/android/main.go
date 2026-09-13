package main

import (
	"github.com/Go-Forms/GoForms"

	mainform "{{MODULE}}/Forms/MainForm"
)

// main.go: the developer wires up forms and starts the application by hand,
// same as a WinForms Program.cs Main() calling Application.Run(new MainForm()).
//
// The same main() runs on the desktop, in the browser and on Android - the
// framework picks the driver from GOOS. On a phone the main form takes the
// whole screen; a form larger than the screen scrolls (Form.AutoScroll is
// on by default there), and every further form opens full-screen with a
// back button, as Android apps do.
func main() {
	goforms.NewApplication("{{APP_ID}}")
{{THEME_CALL}}
	goforms.Run(mainform.NewMainForm().Form)
}
