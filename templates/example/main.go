package main

import (
	"github.com/Go-Forms/GoForms"

	mainform "{{MODULE}}/Forms/MainForm"
)

// main.go: the developer wires up forms and starts the application by hand,
// same as a WinForms Program.cs Main() calling Application.Run(new MainForm()).
func main() {
	goforms.NewApplication("com.example.{{MODULE}}")
{{THEME_CALL}}
	goforms.Run(mainform.NewMainForm().Form)
}
