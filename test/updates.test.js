// What Check for Updates reads out of go.mod and out of Go's answers.
//
// updates.ts imports `vscode`, so it is bundled with the stub the other
// extension-host tests use (testlib/vscodeShim.js) and loaded from memory.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');
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

const U = load('updates.ts');

test('a project on the published framework is one to update', () => {
	assert.ok(U.requiresFramework('module app\n\ngo 1.23\n\nrequire github.com/Go-Forms/GoForms v0.3.0\n'));
	assert.ok(U.requiresFramework('module app\n\nrequire (\n\tfyne.io/fyne/v2 v2.8.0\n\tgithub.com/Go-Forms/GoForms v0.3.0\n)\n'));
});

test('a project on a local checkout is left alone', () => {
	assert.ok(!U.requiresFramework('module app\n\nrequire github.com/Go-Forms/GoForms v0.3.0\n\nreplace github.com/Go-Forms/GoForms => ../GoForms\n'));
	assert.ok(!U.requiresFramework('module other\n\nrequire fyne.io/fyne/v2 v2.8.0\n'));
});

test('go list -m -u says what is newer', () => {
	assert.deepEqual(U.frameworkUpdate('{"Path":"github.com/Go-Forms/GoForms","Version":"v0.2.0","Update":{"Version":"v0.3.0"}}'), {
		current: 'v0.2.0',
		latest: 'v0.3.0',
	});
	assert.equal(U.frameworkUpdate('{"Path":"github.com/Go-Forms/GoForms","Version":"v0.3.0"}'), undefined);
	assert.equal(U.frameworkUpdate('not json'), undefined);
});

test('the newest Go release is picked out of the toolchain versions', () => {
	const versions = [
		'v0.0.1-go1.9rc2.windows-amd64',
		'v0.0.1-go1.25.3.linux-amd64',
		'v0.0.1-go1.27.0.linux-amd64',
		'v0.0.1-go1.27.3.darwin-arm64',
		'v0.0.1-go1.28rc1.linux-amd64',
		'v0.0.1-go1.27.10.linux-amd64',
	].join(' ');
	assert.equal(U.latestToolchain(versions), 'go1.27.10');
});

test('Go versions compare as numbers', () => {
	assert.ok(U.compareGo('go1.25.10', 'go1.25.9') > 0);
	assert.ok(U.compareGo('go1.25', 'go1.25.0') === 0);
	assert.ok(U.compareGo('go1.24.7', 'go1.25') < 0);
});
