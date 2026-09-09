# {{MODULE}}

A GoForms example application, scaffolded by GoForms Designer. This is the
proven GoFormsDemo sample, retargeted to your module name - it demonstrates
most of the GoForms control catalog wired together with real event handlers.

## Run it

```
go mod tidy
go run .
```

(`go mod tidy` fetches Fyne's dependency graph the first time; after that,
`go run .` / `go build .` work directly.)

## Layout

```
{{MODULE}}/
  Forms/
    MainForm/
      MainForm.go            <- event handlers (btnGreet_Click, clock_Tick, ...)
      MainForm-designer.go   <- control declarations + initializeComponent()
    AboutForm/
      AboutForm.go
      AboutForm-designer.go
  main.go                     <- goforms.NewApplication + goforms.Run(mainForm)
  go.mod                      <- require github.com/Go-Forms/GoForms
```

## What it demonstrates

- **Basic input round-trip**: type a name in the `TextBox`, click "Greet" -
  the `Button.Click` handler reads `TextBox.Text()` and updates a `Label`,
  and nudges a `ProgressBar`.
- **GroupBox with relative coordinates**: the "Options" box's `CheckBox`,
  three `RadioButton`s (grouped via `RadioButtonGroup`) and `ComboBox` are all
  positioned relative to the GroupBox itself, not the form.
- **A second form + `ShowDialog`**: "About..." opens `AboutForm` modally from
  a background goroutine and reacts to its `DialogResult` once closed.
- **`ListBox` + `ContextMenu`**: right-click the fruit list for "Remove
  selected"/"Clear all".
- **`Timer`**: a clock label ticks every second, started in `Form.Load` and
  stopped in `Form.Closing`.
- **`PictureBox`**: an in-memory generated placeholder image (no external
  asset files needed).
- **`MenuStrip`**: File -> Exit, Help -> About.

## Extending it

Right-click the `Forms` folder (or any folder) in VS Code's Explorer and
choose **GoForms: New Form...** to add another form the same way `AboutForm`
was added, then construct and `Show()`/`ShowDialog()` it from wherever makes
sense. Open any `*-designer.go` file to edit it visually with the GoForms
Designer.
