# Changelog

## 0.9.0

### A theme editor

The framework has had themes since the start, but nothing in the designer knew
about them, so choosing a look meant knowing `goforms.SetTheme` exists,
finding the `Theme` struct, writing the literal by hand, and running the app
to see it.

**`GoForms: Edit Theme`** opens a project's `<name>-styles.go` as a visual
editor: every colour with a picker and a hex box, the metrics as numbers, and
a live preview beside them. The preview is the point - a theme is eleven
colours whose names say what they are called rather than what they do, and the
only way to know whether `Border` reads against `Background` is to see them
together.

Set and unset are different states, and both are reachable. A field left out
keeps Fyne's default, so every row has a clear button, and an unset field is
still drawn in the preview as the default it falls through to - the preview
shows what the theme will look like, not only what it sets.

It follows the form designer's rules. The Go file is the source of truth,
fields are spliced rather than the literal regenerated, and a field holding an
expression - a named constant, a call - is shown read-only rather than
flattened into a hex literal.

### A theme when a project is created

`Create New Project` now asks how the project should look: the default, a
light or dark scheme to start from, or an empty theme. Anything but the
default writes `<project>-styles.go` beside `main.go` and adds the `SetTheme`
call before any form is created. A project that chose the default gets no call
rather than a commented-out one.

## 0.8.1

### The form resizes from its edges

One 14px corner dot meant every resize was diagonal, and it was a small target
to find. The form now has the grips a window has: the right edge for width, the
bottom edge for height, the corner for both. The edges run the full length of
the form, so there is always something to grab, and an edge grip ignores
movement on the axis it does not own - a hand that drifts while dragging the
right edge cannot also change the height.

### Getting back out of a control's properties

Selecting a control and then wanting the form back required clicking a piece
of canvas background - and a form covered edge to edge by a docked control has
none, which left a control's properties as the only thing the panel would ever
show again.

Four ways back now, so one of them always applies:

- click the form's background,
- click its title bar,
- click the area beside the form,
- press <kbd>Escape</kbd> - which needs nowhere to click at all. Pressing it
  while typing in a property field is left to the field.

Starting a resize also selects the form, since that is what you are resizing.

## 0.8.0

### New projects use the published framework

GoForms is now a real module: `github.com/Go-Forms/GoForms`. Scaffolding used
to write `replace goforms => <a path on this machine>` into every new project,
because there was no path `go build` could resolve. That made every generated
project unclonable - it built only on the machine that created it.

`Create New Project` now asks where the framework should come from and
defaults to the published module, so the generated `go.mod` is a plain
`require` and the project is self-contained. Building against a local checkout
is still offered, for working on the framework itself, and is the option that
adds a `replace`.

Generated designer files and handler stubs import the new path. A project
still on the old `goforms` path is recognized as importing the package, so a
stub added to one uses the import already there instead of adding a second,
conflicting one.

### The form's own properties

Selecting nothing on the canvas showed "Select a control" and nothing else, so
the form's title and size were editable only by dragging a 14px handle in the
canvas's bottom-right corner - which, on a form larger than the visible canvas,
sits past the scroll. There was no way at all to make a too-big form smaller.

The properties panel now shows the Form when nothing is selected, with Title,
Width and Height, the way WinForms shows the form's properties when you click
its background. The handle still works.

## 0.7.2

Marketplace metadata. The manifest carried none of what a gallery page is
built from, so the listing would have been an unnamed tile with no icon, no
source link and nothing to find it by:

- an icon (`media/icon.png`),
- `repository`, `homepage`, `bugs` and `qna` links,
- `license`, `keywords` and a gallery banner.

The release workflow now checks the token against the publisher before it
tries to publish. A missing publisher and an expired token failed at
different points with errors that named neither; both now produce one message
saying which it is. The GitHub release is created last, so a failed publish
cannot leave a release advertising a version that never shipped.

## 0.7.1

### Finding Go on Linux and macOS

A GUI editor does not run a login shell, so it inherits the desktop session's
`PATH` rather than the one `.bashrc` or `.zshrc` builds. The official Go
tarball tells you to add `/usr/local/go/bin` in exactly those files, and asdf,
mise and gvm all work the same way - so `go` working in a terminal said
nothing about whether the extension could see it, and when it could not the
only symptom was "Go was not found on PATH".

The search now covers `goforms.goPath`, `go.goroot`, `GOROOT`, `PATH` and the
usual install locations on each platform, verifying each candidate by running
`go version` rather than trusting the file to be there. When it still fails,
the message lists every place it looked and names the setting to fix it.

- New setting `goforms.goPath` for a toolchain in an unusual place.
- New command **`GoForms: Check Setup`**: which `go` was found, where it
  looked, whether the helper CLI builds and answers, and the framework path.
- The build runs with `GO111MODULE=on`, an empty `GOFLAGS` and a writable
  `GOCACHE`, so an environment configured for vendored or GOPATH-mode builds
  cannot break it, and the helper is chmod +x'd after it is written.

### Line endings

`.gitattributes` pins the working tree to LF. The helper writes LF and gofmt
normalises whole files to it, so a CRLF checkout turned every designer edit
into a mixed-ending file and a whole-file diff.

## 0.7.0

### Generated handler stubs name their package

Wiring an event produced `func (mf *MainForm) btn_Click(sender any, e MouseEventArgs)`.
`MouseEventArgs` names nothing on its own, so the package stopped compiling
until the qualifier was typed in by hand. Stubs are now written as
`e goforms.MouseEventArgs`, and:

- a paired file that does not import `goforms` yet gains the import in the
  same write, joining an existing import block if there is one;
- a file importing it under an alias gets stubs written with that alias,
  rather than a second import of the same path;
- a ToolStrip button's parameterless `func()` callback is unaffected.

### Designer files are tidied after every edit

A long session left the file full of statements that no longer said anything:
a setter written once per drag, an event re-wired into a stack of `Handle`
calls, a control added to two containers. None of it showed in the designer,
which reports only the last value of each, so it accumulated unnoticed.

Every `apply` now finishes with a cleanup pass that removes:

- setter calls a later call already overrides,
- all but the last wiring of an event,
- repeated adds of one control,
- duplicate struct field declarations,
- lines that are nothing but a commented-out generated statement.

Item-adding calls (`AddTab`, `AddButton`, `AddNode`), indexed setters
(`SetColumnStyle(0, ...)`) and anything the catalogue does not model are left
untouched, and a cleanup that would not leave the file parseable is abandoned
rather than written.

Re-wiring an event now rewrites the `Handle` line in place. `Event.Handle` is
multicast, so appending a second call left both handlers running instead of
replacing the first.

New command **`GoForms: Tidy Designer File`** (and `goformsdesigner tidy`)
runs the same pass on demand, for files edited outside the designer.

## 0.6.0

First public release.
