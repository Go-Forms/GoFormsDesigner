### Three targets, one command

The **GoForms** entry in the status bar builds and runs the project. It asks
where:

| Target      | What happens                                                    | Needs           |
|-------------|-----------------------------------------------------------------|-----------------|
| Desktop     | `go run .`                                                       | Go              |
| Browser     | a `js/wasm` build, served on `127.0.0.1` and opened              | Go              |
| Android     | `fyne package -os android`, then `adb install -r`                | fyne CLI, NDK   |

Each one is a sequence of ordinary commands shown in a terminal panel, so a
failure is the compiler's own message with a clickable `file:line`, and
nothing happens that you could not do by hand.

Only the Android target needs anything downloaded. `GoForms: Check Setup`
reports what was found and where it looked; `GoForms: Open Setup Guide` walks
through installing the rest, and the guides are bundled, so they work with no
connection.
