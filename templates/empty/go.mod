module {{MODULE}}

go 1.23.0

require (
	fyne.io/fyne/v2 v2.8.0
	github.com/Go-Forms/GoForms v0.3.0
)
{{REPLACE_BLOCK}}

// Cyrillic, Greek and every accented character were dropped before they
// reached a WebAssembly build: the browser shim decided whether a key was a
// character by its length in *bytes*, which only agrees with "one character"
// for ASCII. This is that shim with the one-line fix, until it is upstream.
replace github.com/fyne-io/glfw-js => github.com/Go-Forms/glfw-js v0.4.1
