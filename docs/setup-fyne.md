# The fyne CLI

`fyne` is the command-line tool from the Fyne project
(`fyne.io/tools/cmd/fyne`). GoForms Designer uses it for one thing:
packaging an Android APK (`fyne package --os android`). Desktop and
WebAssembly builds do not need it.

## Install

It is a Go program, so Go installs it:

```
go install fyne.io/tools/cmd/fyne@latest
```

The binary lands in Go's bin directory - `~/go/bin/fyne` on Linux and
macOS, `C:\Users\<you>\go\bin\fyne.exe` on Windows (`go env GOPATH` shows
the directory). The extension looks there by itself.

Check it: `fyne version`.

## Use it from a terminal too

Add Go's bin directory to `PATH`:

- **Linux / macOS** - in `~/.bashrc` or `~/.zshrc`:
  `export PATH="$PATH:$HOME/go/bin"`, then open a new terminal.
- **Windows** - PowerShell:
  `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$env:USERPROFILE\go\bin", "User")`,
  then open a new terminal (and restart VS Code).

## Somewhere else?

Point the extension at the file: `GoForms: Set fyne CLI Path...`, or the
`goforms.fynePath` setting.

## Without a network

Run the `go install` line on any machine with Go and a connection and
copy the single file `fyne` / `fyne.exe` over. It has no dependencies.

The Android build itself also needs the Android NDK - see the Android
guide (`GoForms: Open Setup Guide` > Android).
