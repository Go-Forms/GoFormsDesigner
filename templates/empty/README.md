# {{MODULE}}

A GoForms application, scaffolded by GoForms Designer.

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
      MainForm.go            <- hand-written: event handlers, business logic
      MainForm-designer.go   <- layout: field decls + initializeComponent()
  main.go
  go.mod                     <- require github.com/Go-Forms/GoForms
```

Right-click the `Forms` folder (or any folder) in VS Code's Explorer and
choose **GoForms: New Form...** to add another form the same way `MainForm`
was created. Open any `*-designer.go` file to edit it visually with the
GoForms Designer.
