package main

import (
	"github.com/Go-Forms/GoForms"

	mainform "{{MODULE}}/Forms/MainForm"
)

// main.go: the developer wires up forms and starts the application by hand,
// same as a WinForms Program.cs Main() calling Application.Run(new MainForm()).
//
// The same main() runs on the desktop, in the browser and on Android - the
// framework picks the driver from GOOS. In the browser the main form is the
// page; further forms open as movable windows inside it, and ShowDialog
// blocks the page behind the dialog the way it blocks the owner on Windows.
func main() {
	goforms.NewApplication("{{APP_ID}}")
{{THEME_CALL}}
	goforms.Run(mainform.NewMainForm().Form)
}
