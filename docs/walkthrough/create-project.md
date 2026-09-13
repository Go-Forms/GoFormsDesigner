### What a project looks like

```
myapp/
  go.mod              module myapp, requiring github.com/Go-Forms/GoForms
  main.go             func main() - creates the form and runs the app
  FyneApp.toml        name, id and icon, used by the Android build
  Icon.png
  MainForm/
    MainForm-designer.go    layout, written by the designer
    MainForm.go             your event handlers
  wasm/index.html     the loader page for a browser build
```

The wizard asks three things: a template, whether to use the published module
or a local checkout of the framework, and how it should look. Everything it
writes is plain Go you can read and edit by hand.
