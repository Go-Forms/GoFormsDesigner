# {{MODULE}}

A GoForms Android app, scaffolded by GoForms Designer. The same code also
runs on the desktop and in the browser - Android is just the target it was
made for: the main form is designed at a phone's size and built from docked
and anchored controls, so it fills whatever screen it gets.

## Run it on the desktop first

```
go mod tidy
go run .
```

(`go mod tidy` fetches Fyne's dependency graph the first time - the one step
that needs a network. After it, every build below works offline.)

The desktop window opens at the phone size, which is the fastest way to work
on the form. Open `Forms/MainForm/MainForm-designer.go` in VS Code to edit it
visually.

## Build the APK

In VS Code: **`GoForms: Build for Android (APK)`**. It needs two things Go
does not come with, and checks for both before it starts:

- the **fyne CLI** - `go install fyne.io/tools/cmd/fyne@latest`
- the **Android NDK** - a folder unpacked from a download, pointed at with
  `ANDROID_NDK_HOME` or the `goforms.androidNdkPath` setting

If either is missing the command offers **`GoForms: Open Setup Guide`**, a
bundled page saying where to get each, where to put it, and how to add it to
`PATH` on Windows and on Linux. The APK lands in `build/android/`;
**`GoForms: Install APK on Connected Device`** puts it on a phone with USB
debugging enabled.

From a terminal, the same build is:

```
ANDROID_NDK_HOME=/path/to/android-ndk fyne package --os android/arm64
```

(`$env:ANDROID_NDK_HOME = "C:\path\to\android-ndk"` in PowerShell.) The app's
id, name and icon come from `FyneApp.toml`; change them there.

`android/arm64` covers every phone made since about 2015. `--os android`
builds all four architectures into one APK, at four times the size.

## Layout

```
{{MODULE}}/
  Forms/
    MainForm/
      MainForm.go            <- hand-written: event handlers, business logic
      MainForm-designer.go   <- layout: field decls + initializeComponent()
  main.go
  go.mod                     <- require github.com/Go-Forms/GoForms
  FyneApp.toml               <- app id, name, version, icon (fyne package reads it)
  Icon.png                   <- the launcher icon; replace it
  wasm/index.html            <- the page for a WebAssembly build, if you want one
  .vscode/tasks.json         <- the same builds as terminal tasks
```

## On a phone

- The main form fills the screen. A form larger than the screen scrolls,
  because `Form.AutoScroll` defaults to on there; call `SetAutoScroll(false)`
  to clip instead.
- Every further form (`Show` or `ShowDialog`) opens full-screen with a back
  button in its title bar, as Android dialogs do. `ShowDialog` returns its
  `DialogResult` when that closes, the same as on the desktop.
- `MenuStrip` becomes the menu button in the top bar.
