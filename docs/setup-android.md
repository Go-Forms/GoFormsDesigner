# Building for Android

An Android build needs two things Go itself does not bring, plus one to
put the result on a phone. This page ships inside the extension, so it is
here whether or not you are online - only the two downloads are not.

| What | Why | Needs a network |
|---|---|---|
| **fyne CLI** | packages the Go code into an `.apk` | once, to install |
| **Android NDK** | the C compiler the Android build calls | once, to download (~1 GB) |
| adb (platform-tools) | copies the `.apk` onto a phone; optional | once, to download |

Once both are in place, **`GoForms: Build for Android (APK)`** works with no
connection at all. The app id, name, version and icon come from
`FyneApp.toml` in the project.

---

## 1. The fyne CLI

It is a Go program, installed with Go's own tool:

```
go install fyne.io/tools/cmd/fyne@latest
```

That writes `fyne` (`fyne.exe` on Windows) into Go's bin directory:

- Linux / macOS: `~/go/bin/fyne`
- Windows: `C:\Users\<you>\go\bin\fyne.exe`

(`go env GOPATH` prints the directory; the binary is in its `bin`.)

The extension looks there on its own, so nothing more is required. To use
it from a terminal too, put that directory on `PATH` - see
[Adding to PATH](#adding-to-path) below - or point the extension at the
file with the `goforms.fynePath` setting (`GoForms: Set fyne CLI Path...`).

Check: `fyne version` prints `fyne cli version: v1.x`.

**Offline machine?** Run the `go install` line on any machine with Go and
a connection, then copy the one file `fyne` / `fyne.exe` over. It has no
dependencies.

---

## 2. The Android NDK

Download **Android NDK (Side by side)** from
<https://developer.android.com/ndk/downloads> - the plain `.zip` for your
operating system, *not* Android Studio. Any r25 or newer works; r27 is what
this was tested with.

### Where to put it

Unpack the zip. It contains a single folder named like `android-ndk-r27d`.
Move that folder to one of the places the extension looks:

**Linux / macOS**

```
~/Android/android-ndk-r27d        <- recommended
~/android-ndk-r27d
/opt/android-ndk-r27d
```

**Windows**

```
C:\Users\<you>\Android\android-ndk-r27d    <- recommended
C:\android-ndk-r27d
C:\Android\android-ndk-r27d
```

If you have Android Studio, its SDK Manager can install the NDK instead
(*SDK Tools* > *NDK (Side by side)*); it lands in
`<SDK>/ndk/<version>/`, which is also searched. `<SDK>` is wherever you
told Android Studio to put it - the defaults are `~/Android/Sdk` on Linux,
`~/Library/Android/sdk` on macOS and `%LOCALAPPDATA%\Android\Sdk` on
Windows, and `C:\Android\Sdk`, `/opt/android-sdk` and `/usr/lib/android-sdk`
are searched too. Anywhere else, set `ANDROID_HOME` to it.

The extension picks the newest version it finds. Anywhere else, set
`goforms.androidNdkPath` (`GoForms: Set Android NDK Path...`) or the
environment variable below.

### Telling the terminal about it

The extension does not need this, but `fyne package` run by hand does, and
so does the `GoForms: package (android/arm64)` task in `.vscode/tasks.json`.
The variable is `ANDROID_NDK_HOME`, pointing at the unpacked folder.

**Linux / macOS** - add to `~/.bashrc`, `~/.zshrc` or `~/.profile`:

```sh
export ANDROID_NDK_HOME="$HOME/Android/android-ndk-r27d"
```

then open a new terminal (or `source ~/.bashrc`).

**Windows** - PowerShell, once, as your own user (no admin needed):

```powershell
[Environment]::SetEnvironmentVariable("ANDROID_NDK_HOME", "$env:USERPROFILE\Android\android-ndk-r27d", "User")
```

or *Settings > System > About > Advanced system settings > Environment
Variables > User variables > New*. Open a new terminal afterwards; VS Code
also has to be restarted to see a new variable.

### Check

The folder is right if it contains `source.properties` and
`toolchains\llvm\prebuilt\`. **`GoForms: Check Setup`** reports what the
extension found and everywhere it looked.

---

## 3. adb, to install on a phone

`adb` comes with Android's *platform-tools*:
<https://developer.android.com/tools/releases/platform-tools>. Unpack the
zip anywhere and add that folder to `PATH` (below), or put it at
`<SDK>/platform-tools`, which the extension also checks. On Debian/Ubuntu
`sudo apt install adb` is enough.

On the phone: *Settings > About phone*, tap *Build number* seven times, then
*Developer options > USB debugging*. Connect by USB and accept the prompt
on the phone; `adb devices` should list it.

**`GoForms: Install APK on Connected Device`** then runs `adb install -r`
on the newest APK in `build/android/`. Without adb, copy the `.apk` to the
phone by any means and open it there - the phone asks to allow installing
from that source the first time.

---

## Adding to PATH

`PATH` is the list of folders a terminal searches for a command. Adding a
folder makes everything in it a command.

**Linux / macOS** - in `~/.bashrc` or `~/.zshrc`:

```sh
export PATH="$PATH:$HOME/go/bin:$HOME/Android/platform-tools"
```

**Windows** - PowerShell, as your own user:

```powershell
$p = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$p;$env:USERPROFILE\go\bin;$env:USERPROFILE\Android\platform-tools", "User")
```

or through *Environment Variables > User variables > Path > Edit > New*.
Every open terminal and VS Code window keeps its old `PATH`; start new ones.

---

## Building

- **`GoForms: Build for Android (APK)`** - packages
  `goforms.android.target` (default `android/arm64`, which covers every
  phone since about 2015) into `build/android/<name>.apk`.
- The equivalent terminal command, from the project folder:

  ```
  fyne package --os android/arm64
  ```

  With `--os android` it builds all four architectures into one APK, at
  four times the size and time.

- The first Android build compiles Fyne's C parts with the NDK, which takes
  a few minutes; later builds are cached and fast.
- A **release** build for the Play Store additionally needs a signing key:
  `fyne release --os android --keyStore ... --keyName ...`. The package
  built here is a debug build, installable directly on any phone.

## If it fails

- *`fyne` not found* - install it (step 1), or set `goforms.fynePath`.
- *NDK not found* - step 2; `GoForms: Check Setup` lists where it looked.
- *`clang: not found`, `ndk-bundle`, `toolchains`* - the folder pointed at
  is not an NDK root; it should contain `toolchains/llvm/prebuilt`.
- *`cannot find module` / `dial tcp`* - Go tried to download a module. Run
  `go mod download` once while online; every build after that is local.
- *`INSTALL_FAILED_UPDATE_INCOMPATIBLE`* on install - an app with the same
  id but a different signature is installed. Uninstall it on the phone.
