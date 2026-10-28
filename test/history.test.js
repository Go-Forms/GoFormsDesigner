// The designer's undo restores the whole form, not just its designer file.
//
// A rename rewrites the hand-written half too, and wiring an event writes a
// stub into it; undoing only -designer.go after either left the code naming
// something the designer file no longer had. These check the snapshot and
// the restore the designer's history is built on.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

function load(entry) {
	const built = esbuild.buildSync({
		entryPoints: [path.join(root, 'src', entry)],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		alias: { vscode: path.join(root, 'testlib', 'vscodeShim.js') },
	});
	const filename = path.join(root, 'src', entry.replace(/\.ts$/, '.bundle.js'));
	const mod = new Module(filename);
	mod.filename = filename;
	mod.paths = Module._nodeModulePaths(path.dirname(filename));
	mod._compile(built.outputFiles[0].text, filename);
	return mod.exports;
}

const P = load('designerEditorProvider.ts');

function form() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-history-'));
	const designer = path.join(dir, 'MainForm-designer.go');
	fs.writeFileSync(designer, 'designer v1');
	fs.writeFileSync(path.join(dir, 'MainForm.go'), 'code v1');
	fs.writeFileSync(path.join(dir, 'helpers.go'), 'helpers v1');
	fs.writeFileSync(path.join(dir, 'MainForm_test.go'), 'test v1');
	return { dir, designer };
}

test('a snapshot holds the designer file and the code beside it', () => {
	const { dir, designer } = form();
	const snap = P.snapshotForm(designer);
	assert.equal(snap.get(designer), 'designer v1');
	assert.equal(snap.get(path.join(dir, 'MainForm.go')), 'code v1');
	assert.equal(snap.get(path.join(dir, 'helpers.go')), 'helpers v1');
	assert.ok(!snap.has(path.join(dir, 'MainForm_test.go')), 'tests are not the tool\'s to write');
});

test('restoring puts back both halves of a rename', () => {
	const { dir, designer } = form();
	const snap = P.snapshotForm(designer);
	fs.writeFileSync(designer, 'designer v2');
	fs.writeFileSync(path.join(dir, 'MainForm.go'), 'code v2');
	P.restoreForm(snap);
	assert.equal(fs.readFileSync(designer, 'utf8'), 'designer v1');
	assert.equal(fs.readFileSync(path.join(dir, 'MainForm.go'), 'utf8'), 'code v1');
});

test('a code file the edit created is removed again', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-history-'));
	const designer = path.join(dir, 'MainForm-designer.go');
	fs.writeFileSync(designer, 'designer v1');
	const snap = P.snapshotForm(designer);
	assert.equal(snap.get(path.join(dir, 'MainForm.go')), null, 'the paired file is recorded as absent');
	fs.writeFileSync(path.join(dir, 'MainForm.go'), 'a stub');
	P.restoreForm(snap);
	assert.ok(!fs.existsSync(path.join(dir, 'MainForm.go')));
});

test('a redo snapshot also covers a file the undone edit created', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-history-'));
	const designer = path.join(dir, 'MainForm-designer.go');
	fs.writeFileSync(designer, 'designer v1');
	const before = P.snapshotForm(designer);
	fs.writeFileSync(path.join(dir, 'Extra.go'), 'created');
	const after = P.snapshotForm(designer, before);
	assert.equal(after.get(path.join(dir, 'Extra.go')), 'created');
});
