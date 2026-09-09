package main

import "github.com/Go-Forms/GoForms"

// Theme is this application's look, applied in main.go before any form is
// created. It is the file behind "GoForms: Edit Theme", which reads and
// writes this literal - but it is ordinary Go, so editing it by hand works
// just as well.
//
// Every field left out keeps Fyne's default for that property. That is what
// lets a theme change one colour without restating the other ten, and it is
// why removing a line is a real choice rather than a blank.
//
// Fields, in order: Name, Dark, then the colours - Background, Foreground,
// Primary, InputBackground, ButtonColor, Hover, Border, Disabled,
// Placeholder, Selection, ScrollBar - then the metrics: TextSize, Padding,
// InputBorderWidth, InputRadius.
func Theme() goforms.Theme {
	return goforms.Theme{
{{THEME_BODY}}	}
}
