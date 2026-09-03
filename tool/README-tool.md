# goformsdesigner

The helper CLI behind the GoForms Designer extension. It parses
`*-designer.go` into a JSON model, applies edits back to the source, keeps
the paired handler stubs in step, and reports the control catalogue. All of
the Go-parsing and Go-writing the extension does happens here — `src/` never
touches Go source itself.

**This directory is the only copy.** The extension builds this source on
first activation and caches the binary in its global storage, rebuilding it
whenever a file here is newer (see `src/goTool.ts`).

## Commands

    go run . parse   MainForm-designer.go       # the form model, as JSON
    go run . apply   MainForm-designer.go       # ops JSON array on stdin
    go run . tidy    MainForm-designer.go       # drop redundant statements
    go run . ensure-handler MainForm-designer.go MainForm mf btn_Click MouseEventArgs
    go run . catalog                            # every control type
    go run . categories                         # toolbox groups, in order

`apply` runs `tidy` itself once the batch has landed, so the litter an edit
creates never outlives it. Both are atomic: a failure leaves the file exactly
as it was.

    echo '[{"op":"setBounds","id":"btn1","x":10,"y":10,"w":80,"h":30}]' \
      | go run . apply MainForm-designer.go
