# Changelog

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
