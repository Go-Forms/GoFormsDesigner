// The extension must work with no connection.
//
// That is not a nice-to-have here: the designer is a webview, and a webview
// that pulls a font or a script off a CDN looks perfect on the machine it was
// written on and renders as unstyled boxes on a plane, behind a corporate
// proxy, or in any of the places people actually write code. The same goes
// for the setup guides, which are needed precisely when something is not
// working.
//
// So the rule is: everything the extension needs at runtime ships inside it.
// The only things that legitimately touch the network are the user's own
// `go build` (modules, which Go caches) and downloading the Android NDK, and
// both are the user's action, not the extension's.
//
// Run with: node --test
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/** Every file under dir, skipping the directories that are not shipped. */
function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
			continue;
		}
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(p, out);
		} else {
			out.push(p);
		}
	}
	return out;
}

const RUNTIME_DIRS = ['src', 'media', 'templates', 'snippets', 'docs'];

test('nothing loaded at runtime comes off the network', () => {
	// Loopback is the WebAssembly preview server, which is the point of it.
	const allowed = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/;
	const offenders = [];
	for (const dir of RUNTIME_DIRS) {
		for (const file of walk(path.join(root, dir))) {
			// Markdown is prose: a link in a guide is a link for the reader to
			// click, not something the extension fetches.
			if (file.endsWith('.md')) {
				continue;
			}
			const text = fs.readFileSync(file, 'utf8');
			for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'`)<>]+/g)) {
				if (!allowed.test(m[0])) {
					offenders.push(`${path.relative(root, file)}: ${m[0]}`);
				}
			}
		}
	}
	assert.deepStrictEqual(offenders, [], 'a runtime file names a remote URL');
});

test('the webviews forbid remote content outright', () => {
	// A CSP of default-src 'none' means an accidental <img src="https://...">
	// is blocked rather than silently working on the developer machine.
	for (const name of ['designerEditorProvider.ts', 'themeEditorProvider.ts']) {
		const text = fs.readFileSync(path.join(root, 'src', name), 'utf8');
		assert.ok(text.includes(`default-src 'none'`), `${name}: no default-src 'none' in the CSP`);
		assert.ok(
			/localResourceRoots:\s*\[[^\]]*'media'/.test(text),
			`${name}: the webview should only be allowed to read media/`
		);
	}
});

test('the helper CLI is stdlib-only, so building it needs no proxy', () => {
	// The tool is compiled on first activation. A single third-party import
	// would turn that into a module download the first time the extension is
	// used - which is often the one moment there is no connection.
	const goMod = fs.readFileSync(path.join(root, 'tool', 'go.mod'), 'utf8');
	assert.ok(!/^require/m.test(goMod), 'tool/go.mod has grown a dependency');

	const imports = new Set();
	for (const file of fs.readdirSync(path.join(root, 'tool'))) {
		if (!file.endsWith('.go') || file.endsWith('_test.go')) {
			continue;
		}
		const text = fs.readFileSync(path.join(root, 'tool', file), 'utf8');
		const block = /import\s*\(([\s\S]*?)\)/.exec(text);
		const single = [...text.matchAll(/^import\s+"([^"]+)"/gm)].map((m) => m[1]);
		for (const line of (block?.[1] ?? '').split('\n')) {
			const m = /"([^"]+)"/.exec(line);
			if (m) {
				imports.add(m[1]);
			}
		}
		for (const s of single) {
			imports.add(s);
		}
	}
	const external = [...imports].filter((i) => i.includes('.'));
	assert.deepStrictEqual(external, [], 'tool/ imports something outside the standard library');
});

test('the setup guides ship with the extension', () => {
	// They exist to explain the one step that does need a download. Fetching
	// them would be a guide you cannot read when you need it.
	const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
	assert.ok(!/^docs\/\*\*/m.test(ignore), 'docs/ must be packaged');
	for (const guide of ['setup-android', 'setup-fyne', 'setup-wasm']) {
		assert.ok(fs.existsSync(path.join(root, 'docs', `${guide}.md`)), `docs/${guide}.md is missing`);
	}
});

test('the WebAssembly loader page is self-contained', () => {
	const html = fs.readFileSync(path.join(root, 'templates', 'common', 'wasm', 'index.html'), 'utf8');
	for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
		assert.ok(
			!/^[a-z]+:|^\/\//i.test(m[1]),
			`the loader page pulls in ${m[1]}; a browser build has to run with no server but its own`
		);
	}
	assert.ok(html.includes('wasm_exec.js'), 'the page should load the Go runtime shim it is given');
});
