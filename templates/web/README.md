# {{MODULE}}

A GoForms web app, scaffolded by GoForms Designer. The same code also runs
on the desktop and on Android - the browser is just the target it was made
for: the main form fills the tab, and the controls are docked and anchored
so it keeps doing that when the tab is resized.

## Run it on the desktop first

```
go mod tidy
go run .
```

(`go mod tidy` fetches Fyne's dependency graph the first time - the one step
that needs a network. After it, every build below works offline.)

## Build for the browser

In VS Code: **`GoForms: Build for WebAssembly`**. Nothing beyond Go is
needed. It compiles with `GOOS=js GOARCH=wasm`, copies `wasm_exec.js` from
the Go installation and `wasm/index.html` from this project into
`build/wasm/`, and offers to open the result. That last step matters: a
browser will not run a `.wasm` from a `file://` page, so
**`GoForms: Serve WebAssembly Build in Browser`** starts a small local server
for the folder (it is Node's own, needs no network, and listens on this
machine only).

From a terminal, the compile is:

```
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o build/wasm/{{MODULE}}.wasm .
```

then copy `wasm_exec.js` from `$(go env GOROOT)/lib/wasm/` (Go 1.24+; older
Go keeps it in `misc/wasm/`) and `wasm/index.html` next to it, and serve the
folder with any static server.

To deploy, upload `build/wasm/` as it is. The page is yours to edit - it is
plain HTML with no dependencies.

## Layout

```
{{MODULE}}/
  Forms/
    MainForm/
      MainForm.go            <- hand-written: event handlers, business logic
      MainForm-designer.go   <- layout: field decls + initializeComponent()
  main.go
  go.mod                     <- require github.com/Go-Forms/GoForms
  wasm/index.html            <- the loader page; edit freely
  FyneApp.toml, Icon.png     <- app id, name and icon (also the page's icon)
  .vscode/tasks.json         <- the same builds as terminal tasks
```

## In the browser

- The main form is the page. A form designed larger than the tab scrolls,
  because `Form.AutoScroll` defaults to on there.
- Every further form opens as a movable window inside the page. `ShowDialog`
  makes it modal - the page behind it is blocked until it closes - and
  returns its `DialogResult`, the same as on the desktop.
- File dialogs have no file system to show; keep data in memory or in
  Fyne's preferences (`fyne.CurrentApp().Preferences()`), which the browser
  stores locally.
