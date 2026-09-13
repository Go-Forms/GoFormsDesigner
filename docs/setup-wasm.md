# Building for the browser (WebAssembly)

Nothing beyond Go is needed. **`GoForms: Build for WebAssembly`** does
three things, all local:

1. `GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o build/wasm/<name>.wasm .`
2. copies `wasm_exec.js` - the JavaScript side of Go's wasm runtime - from
   the Go installation (`$(go env GOROOT)/lib/wasm/`, or `misc/wasm/` before
   Go 1.24) into `build/wasm/`
3. copies the loader page from the project's `wasm/` folder (or, for a
   project without one, the extension's own) into `build/wasm/`, filling in
   the app name and the `.wasm` file name

## Seeing it

A browser refuses to run a `.wasm` from a `file://` page, so double-clicking
`index.html` shows a blank loader. **`GoForms: Serve WebAssembly Build in
Browser`** starts a small static server for `build/wasm/` - Node's own,
listening on this machine only, no network needed - and opens it.

Any static server does the same: `python3 -m http.server` in `build/wasm`,
for instance. The one requirement is the `application/wasm` content type;
the bundled page falls back to a slower load if a server lacks it.

## Deploying

Upload `build/wasm/` as it is to any static host. There is no server-side
part.

## What is different in the browser

- The main form is the page. A form designed larger than the tab scrolls
  (`Form.AutoScroll` is on by default there).
- Further forms open as movable windows inside the page; `ShowDialog` blocks
  the page behind them and returns the `DialogResult` when they close.
- File dialogs have no file system to show. Keep data in memory, or in
  `fyne.CurrentApp().Preferences()`, which the browser stores locally.
- The first load downloads the whole app (a few MB compressed); a reload is
  cached.

## If it fails

- *`cannot find module` / `dial tcp`* - Go tried to download a module. Run
  `go mod download` once while online.
- *`wasm_exec.js was not found`* - the Go installation is missing its
  `lib/wasm` (or `misc/wasm`) folder; a distribution package may strip it.
  Install Go from <https://go.dev/dl/> instead.
- *A blank page with "This browser has no WebGL support"* - Fyne draws with
  WebGL; enable hardware acceleration in the browser.
