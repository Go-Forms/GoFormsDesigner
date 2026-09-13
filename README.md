# GoForms Designer

A drag-and-drop form designer for [GoForms](https://github.com/Go-Forms/GoForms),
a Windows Forms-style GUI framework for Go.

Drag a button onto a form, and the designer writes the Go that puts it there.
Drag it somewhere else, and it rewrites those lines. The file it edits is
ordinary Go you can read, diff and review — not a resource blob you are never
meant to open.

## What it does

**Edits forms visually.** Open any `*-designer.go` file and it becomes a
canvas with a toolbox of 34 controls, each drawn to approximate its real
on-screen look rather than as a labelled box. Drag to move, drag the edges to
resize, Ctrl or Shift click to select several and move them together. Edges
snap to their neighbours' left, right and centre with a guide line drawn
where they line up.

**Keeps your code separate from the generated code.** A form is split the way
a WinForms form is split into Form1.cs and Form1.Designer.cs: layout in
MainForm-designer.go, your handlers in MainForm.go. The designer only ever
writes the first, so it cannot eat what you wrote.

**Writes event handlers for you.** Every control lists its own events first,
then the ones inherited from Control — Click, MouseDown, KeyPress, GotFocus
and the rest. Wiring one generates a fully typed handler stub in your file
and adds the import it needs, respecting the alias if you import the package
under one. Re-wiring an event rewrites the line that is already there instead
of leaving two handlers running.

**Edits properties with the right editor per type.** A checkbox for booleans,
a spinner for numbers, a dropdown for enums, a row of checkboxes for flag
sets like Anchor. Renaming a control renames its field, every reference to
it, and any handler still named after it.

**Tidies up after itself.** Every edit ends with a cleanup pass that removes
what the edit made redundant: setters a later call already overrides, stacked
wirings of one event, a control added to a container twice, duplicate field
declarations. Only the statements it models are touched; anything it does not
recognise is left exactly as you wrote it.

**Has undo of its own.** Ctrl+Z and Ctrl+Y inside the designer, with a
snapshot history the extension keeps itself — the file is written directly
rather than through the editor's document, so the editor's undo never sees
these changes.

**Themes.** A project's `<name>-styles.go` opens as a visual theme editor: a
picker and a hex box per colour, numbers for the metrics, and a live preview
showing them together. A field left out keeps the framework default, and that
*unset* state is reachable again from every row.

**Scaffolds projects and forms.** Create a new project — empty, a worked
example, one aimed at the browser, or one aimed at Android — and get a
correct go.mod, a main.go, a first form, build tasks and a .gitignore. Add a
form to any folder from the Explorer's right-click menu.

**Builds and runs the project.** One command each for the desktop, the
browser and Android, plus a local server that opens a WebAssembly build in
your browser and a one-click install of an Android APK onto a connected
phone. Every step runs as a plain process in a terminal panel, so a failure
is the compiler's own message with a clickable file and line.

Nothing needs the network beyond what Go itself downloads once.

## Requirements

- VS Code 1.85 or newer, on Windows, Linux or macOS.
- A Go toolchain. It is needed the first time the designer runs, to build the
  small helper that parses and rewrites designer files.
- Nothing else for editing, scaffolding, or a desktop or WebAssembly build.

An Android build additionally needs the fyne command-line tool and the
Android NDK. Neither is downloaded for you, both are looked for everywhere
they are normally installed, and the guide explaining where to put them ships
inside the extension — run **GoForms: Open Setup Guide**. **GoForms: Check
Setup** reports what this machine has.

## Getting started

Run **GoForms: Create New Project…** from the command palette and answer
three questions: where the project goes, which template, and how it should
look. Open the MainForm-designer.go it created — the designer opens with it —
and drag a control onto the canvas. Wire its Click event from the Events
panel, and the handler stub appears in MainForm.go for you to fill in. Press
the run button on the designer's toolbar to see it.

An existing GoForms project needs none of that: open any designer file.

## If it cannot find Go

A GUI editor does not run a login shell, so it inherits the desktop session's
PATH rather than the one your shell profile builds. That is why Go can work
in your terminal and still be invisible to the editor.

The extension looks in its own setting first, then the Go extension's
setting, then GOROOT, then PATH, then the usual install locations on each
platform, verifying each candidate by running it. If yours is somewhere else,
point the `goforms.goPath` setting at it once. **GoForms: Check Setup** lists
everywhere it looked.

## Links

- [GoForms framework](https://github.com/Go-Forms/GoForms) — the library this
  designs for.
- [Documentation and guide](https://go-forms.github.io/GoForms/)
- [Showcase application](https://github.com/Go-Forms/GoFormsShowcase) — every
  control and layout, running.
- [Report a problem](https://github.com/Go-Forms/GoFormsDesigner/issues)

MIT licensed.
