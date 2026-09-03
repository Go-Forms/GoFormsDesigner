# Changelog

## 0.7.0

### Generated handler stubs name their package

Wiring an event produced `func (mf *MainForm) btn_Click(sender any, e MouseEventArgs)`.
`MouseEventArgs` names nothing on its own, so the package stopped compiling
until the qualifier was typed in by hand. Stubs are now written as
`e goforms.MouseEventArgs`, and:

- a paired file that does not import `goforms` yet gains the import in the
  same write, joining an existing import block if there is one;
- a file importing it under an alias gets stubs written with that alias,
  rather than a second import of the same path;
- a ToolStrip button's parameterless `func()` callback is unaffected.

### Designer files are tidied after every edit

A long session left the file full of statements that no longer said anything:
a setter written once per drag, an event re-wired into a stack of `Handle`
calls, a control added to two containers. None of it showed in the designer,
which reports only the last value of each, so it accumulated unnoticed.

Every `apply` now finishes with a cleanup pass that removes:

- setter calls a later call already overrides,
- all but the last wiring of an event,
- repeated adds of one control,
- duplicate struct field declarations,
- lines that are nothing but a commented-out generated statement.

Item-adding calls (`AddTab`, `AddButton`, `AddNode`), indexed setters
(`SetColumnStyle(0, ...)`) and anything the catalogue does not model are left
untouched, and a cleanup that would not leave the file parseable is abandoned
rather than written.

Re-wiring an event now rewrites the `Handle` line in place. `Event.Handle` is
multicast, so appending a second call left both handlers running instead of
replacing the first.

New command **`GoForms: Tidy Designer File`** (and `goformsdesigner tidy`)
runs the same pass on demand, for files edited outside the designer.

## 0.6.0

First public release.
