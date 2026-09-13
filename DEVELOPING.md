# Developing GoForms Designer

Everything here is for working on the extension itself. What it does for the
people who install it is in README.md.

## How it is put together

The scaffolding commands are plain Node file-copying with `{{TOKEN}}`
substitution against the static template sources in `templates/`. The visual
designer (`src/designerEditorProvider.ts`, `media/*`) shells out to a small
bundled, dependency-free Go CLI (`tool/*.go`, driven via `src/goTool.ts`) that
parses and rewrites `-designer.go` files; that CLI is built once on first
activation into the extension's global storage, which is why a Go toolchain is
a requirement.

The designer never edits the file as text from the webview. Every change is an
operation sent to the Go tool, which applies it to the AST and writes the file
back gofmt-formatted, so a designer edit and a hand edit produce the same file.

## Keeping the preview honest

The canvas is meant to show what will really appear at runtime, so
`media/gridLayout.js` is a deliberate port of `DataGridView`'s column-fitting
policy from GoForms rather than an approximation.

`npm test` checks that port against `test/grid-golden.json`, a fixture
GoForms' own `TestGoldenGridWidths` generates. Regenerate it after touching
either side:

    cd ../GoForms && go test -run TestGoldenGridWidths .   # a GoForms checkout
    cd ../GoFormsDesigner && npm test

The two sides drift silently when they drift at all - a column ends up a few
pixels off in the canvas and nowhere else - so the fixture is the only thing
that reports it.

## Installing

### Option A: build a `.vsix` and install it (closest to "real" install)

```
npm ci
npm run package        # runs the bundle, then vsce package
code --install-extension goforms-designer-<version>.vsix
```

`npm ci` rather than `npm install`: esbuild ships a native binary per
platform, so a `node_modules` copied between Windows and Linux (or checked
out on one and used on the other) fails the bundle step with a platform
mismatch. `npm ci` installs from the lockfile for the machine it runs on.

`npm run package` produces the `.vsix` in the repo root, and
`code --install-extension` installs it exactly as installing from the
Marketplace would. Reload the window afterwards if the editor was already
open. Every green CI build also attaches a ready-made `.vsix`, and every
release publishes one - see [Releasing](#releasing).

To update after making changes, bump the `version` in `package.json`,
re-run the three commands above, and reinstall (or use
`code --install-extension <file> --force`).

**If you use VS Code Profiles** (Profile icon in the bottom-left, or a
custom profile shown in the window title): `code --install-extension` only
installs into the *default* profile. If your window uses a named profile,
the install silently doesn't apply there and the custom editor/commands
never activate with no visible error. Install into that profile explicitly:

```
code --profile "Your Profile Name" --install-extension goforms-designer-<version>.vsix
```

(find the exact name in the profile switcher, or in the window title bar).

### Option B: run from source in an Extension Development Host (fastest for development)

```
npm ci
npm run build
```

Then open this folder in VS Code and press **F5** (or Run > Start
Debugging). That launches a second "Extension Development Host" VS Code
window with the extension loaded from source - no packaging step needed.
`npm run watch` rebuilds on save if you want the F5 window to pick up
changes after a reload (`Ctrl+R` / `Cmd+R` in the dev host window).

## Releasing

Publishing is driven by the version in `package.json`; the tag only has to
agree with it, and `.github/workflows/release.yml` fails the run if it does
not — a mismatch is the one mistake a marketplace accepts and then serves
forever.

    # bump "version" in package.json, update CHANGELOG.md, commit, then:
    git tag v0.7.0
    git push origin v0.7.0

That runs the full check suite, builds the `.vsix`, publishes it to the VS
Code Marketplace and to Open VSX, and cuts a GitHub release with the `.vsix`
attached. Editors that pull from either marketplace then offer the update on
their own.

Two optional repository secrets decide how far it goes. `VSCE_PAT` is an
Azure DevOps token with *Marketplace: Manage* for the `goforms` publisher;
`OVSX_PAT` is an Open VSX access token, which is what reaches VSCodium,
Cursor, Gitpod and code-server. A publishing step whose token is missing is
skipped rather than failed, so a fork with neither still gets a release with
an installable `.vsix` on it.

`workflow_dispatch` runs the same job with `dry_run` on: everything is built
and verified, nothing is published.

## Repo layout

```
src/
  extension.ts               <- activation, and the commands that act on files
  scaffold.ts                <- template copying, token substitution, validation
  goTool.ts                  <- the only caller of the bundled Go CLI
  designerEditorProvider.ts  <- the designer's custom editor and its webview host
media/                       <- webview assets: the canvas and its layout
                                ports, plus the theme editor
templates/
  empty/                     <- minimal project (go.mod, main.go, MainForm)
  example/                   <- a fuller project, adapted from GoFormsDemo
test/                        <- the extension's tests
testlib/                     <- the DOM shim they run media/*.js against
tool/                        <- the Go CLI: every read and write of Go source
```

The split that matters is `src/` against `tool/`: nothing in `src/` parses or
writes Go. It builds `tool/` on first activation, caches the binary, and
exchanges JSON with it (see `tool/README-tool.md`).
