# GoForms Designer

[![CI](https://github.com/Go-Forms/GoFormsDesigner/actions/workflows/ci.yml/badge.svg)](https://github.com/Go-Forms/GoFormsDesigner/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue)

The visual designer for [GoForms](https://github.com/Go-Forms/GoForms) —
a drag-and-drop form editor for VS Code that reads and writes plain Go.

VS Code companion extension for
[GoForms](https://github.com/Go-Forms/GoForms), a WinForms-style GUI framework
for Go. Provides:

- **`GoForms: Create New Project...`** - scaffolds a new GoForms app (empty
  or a full example) with a correct `go.mod` (including the local
  `replace goforms => ...` directive), `main.go`, and a `MainForm`.
- **`GoForms: New Form...`** - available from the command palette and from
  the Explorer's folder right-click menu - adds a new `<Name>/<Name>.go` +
  `<Name>-designer.go` pair to any folder.
- **`GoForms: Set Framework Path...`** - points the extension at your local
  GoForms checkout (used for the `replace` directive above).
- **`GoForms: Open Visual Designer`** - drag-and-drop editing of
  `*-designer.go` files (custom editor, `designerEditorProvider.ts`), with a
  toolbox covering the full GoForms control catalog (23 types as of this
  writing - Label/Button/TextBox/CheckBox/RadioButton/ComboBox/ListBox/
  Panel/GroupBox/PictureBox/ProgressBar/TrackBar/NumericUpDown/
  DateTimePicker/LinkLabel/ListView (grid)/TreeView/TabControl/ToolStrip/
  StatusStrip/Splitter/ScrollBox/ColorPickerButton), each rendered to
  approximate its real on-screen look rather than a generic labeled box.

The scaffolding commands (`src/extension.ts`, `src/scaffold.ts`) are plain
Node file-copying with `{{TOKEN}}` substitution against the static template
sources in `templates/empty/` and `templates/example/`. The visual designer
(`src/designerEditorProvider.ts`, `media/*`) shells out to a small bundled,
dependency-free Go CLI (`tool/*.go`, driven via `src/goTool.ts`) that parses
and rewrites `-designer.go` files; that CLI is built once on first activation
into the extension's global storage (requires `go` on `PATH`).

## Editing

**Canvas.** Drag to move, drag the corner handle to resize, drag the form's
own handle to resize the form. Ctrl or Shift click extends the selection;
dragging any member then moves the whole group, and edges snap to siblings'
left/right/centre with a guide line drawn where they line up.

**Properties.** Name (renames the field, every reference to it, and any
handler still named after it), bounds, text, items, and every setter the
catalogue knows — with the right editor per type: checkbox for booleans,
spinner for numbers, dropdown for enums, and a row of checkboxes for flag
sets like `Anchor`. Anchor, Dock, TabIndex and TabStop appear on every
control, since they come from `ControlBase`.

**Events.** Every control lists its own events first, then the ones it
inherits from `Control` (`Click`, `MouseDown`, `KeyPress`, `GotFocus`, ...).
Wiring one generates a handler stub in the paired hand-written file, fully
qualified — `e goforms.MouseEventArgs` for `Click`, `e goforms.KeyEventArgs`
for `KeyDown` — and adds the `goforms` import if that file did not have one
yet. A file that imports the package under an alias gets stubs written with
that alias.

Re-wiring an event rewrites the `Handle` line already in the file rather than
adding a second one. `Event.Handle` is multicast, so an appended call would
leave *both* handlers running.

**Tidy.** Every edit finishes with a cleanup pass over the designer file that
removes what the edit made redundant:

- setter calls a later call already overrides (`SetDock` written five times),
- stacked wirings of one event,
- a control added to a container more than once,
- duplicate struct field declarations,
- whole lines that are nothing but a commented-out generated statement.

Only calls the catalogue models are touched, so item-adding calls (`AddTab`,
`AddButton`, `AddNode`) and indexed setters (`SetColumnStyle(0, ...)`) are
left alone, as is anything the tool does not recognize at all. Run it by hand
on a file edited outside the designer with **`GoForms: Tidy Designer File`**,
or `goformsdesigner tidy <file>`.

**Undo/redo.** Ctrl+Z / Ctrl+Y inside the designer. The designer edits the
file through the Go tool, which writes it directly rather than through a
`TextDocument`, so the editor's own undo never sees these changes and the
extension keeps its own snapshot history instead.

**Alignment.** With more than one control selected the panel offers the
WinForms Format commands — align left/right/top/bottom, centre, same
width/height — all measured against the last-clicked control.

## Keeping the preview honest

The canvas is meant to show what will really appear at runtime, so
`media/gridLayout.js` is a deliberate port of `DataGridView`'s column-fitting
policy from GoForms rather than an approximation.

`npm test` checks that port against `test/grid-golden.json`, a fixture
GoForms' own `TestGoldenGridWidths` generates. Regenerate it after touching
either side:

    cd ../GoForms && go test -run TestGoldenGridWidths .   # a GoForms checkout
    cd ../GoFormsDesigner && npm test

The two sides drift silently when they drift at all - a column ends up a few
pixels off in the canvas and nowhere else - so the fixture is the only thing
that reports it.

## Installing

### Option A: build a `.vsix` and install it (closest to "real" install)

```
npm install
npm run build
npm run package        # or: npx vsce package
code --install-extension goforms-designer-0.1.0.vsix
```

`npm run package` runs `vsce package`, which produces
`goforms-designer-0.1.0.vsix` in the repo root. `code --install-extension`
installs it into your local VS Code the same way installing from the
Marketplace would. Reload the window afterwards if VS Code was already open.

To update after making changes, bump the `version` in `package.json`,
re-run the three commands above, and reinstall (or use
`code --install-extension <file> --force`).

**If you use VS Code Profiles** (Profile icon in the bottom-left, or a
custom profile shown in the window title): `code --install-extension` only
installs into the *default* profile. If your window uses a named profile,
the install silently doesn't apply there and the custom editor/commands
never activate with no visible error. Install into that profile explicitly:

```
code --profile "Your Profile Name" --install-extension goforms-designer-0.1.0.vsix
```

(find the exact name in the profile switcher, or in the window title bar).

### Option B: run from source in an Extension Development Host (fastest for development)

```
npm install
npm run build
```

Then open this folder in VS Code and press **F5** (or Run > Start
Debugging). That launches a second "Extension Development Host" VS Code
window with the extension loaded from source - no packaging step needed.
`npm run watch` rebuilds on save if you want the F5 window to pick up
changes after a reload (`Ctrl+R` / `Cmd+R` in the dev host window).

## Requirements

- VS Code 1.85+.
- Go on `PATH` (only needed the first time the visual designer runs -
  builds `tool/*.go` into a small helper binary, cached in the extension's
  global storage).
- A local GoForms checkout somewhere on disk (for the `replace goforms => ...`
  directive new projects need). `Create New Project` will try to find one
  automatically near where you're creating the project, or ask you to
  point at it once via `GoForms: Set Framework Path...`.

## Repo layout

```
src/
  extension.ts               <- activation entry point, command registration
  scaffold.ts                <- template copying / token substitution / validation
  goTool.ts                  <- typed wrapper around the bundled Go CLI
  designerEditorProvider.ts  <- visual designer webview (owned separately)
media/                       <- designer webview assets (owned separately)
templates/
  empty/                     <- minimal project template (go.mod, main.go, MainForm)
  example/                   <- full demo project template (adapted from GoFormsDemo)
tool/                        <- bundled Go CLI source (parse/apply/ensure-handler/catalog)
```
