// What package.json promises, and whether the code keeps it.
//
// Every contribution point is a string that has to match something else: a
// menu names a command, a walkthrough names a markdown file, a welcome view
// names a command in a `command:` link. None of them are type-checked, and
// none of them fail loudly at runtime - a menu entry for a command that does
// not exist simply does nothing when clicked, and a walkthrough step with a
// missing media file renders blank. That class of mistake is invisible until
// someone tries the feature, so it is checked here instead.
//
// Run with: node --test
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = manifest.contributes;

/** Manifest strings are `%key%` references into package.nls.json, which is
 * where the English text lives now that the UI is translated. Anything
 * reading a title has to go through here or it reads the key. */
const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));

function resolveNls(text) {
	const m = /^%(.+)%$/.exec(String(text));
	return m ? nls[m[1]] ?? text : text;
}

/** The whole of src/, concatenated - enough to ask "is this string in the
 * source", which is what "is this command registered" comes down to. */
function sources() {
	let text = '';
	for (const name of fs.readdirSync(path.join(root, 'src'))) {
		if (name.endsWith('.ts')) {
			text += fs.readFileSync(path.join(root, 'src', name), 'utf8');
		}
	}
	return text;
}

test('every contributed command is registered in the source', () => {
	const src = sources();
	const missing = contributes.commands
		.map((c) => c.command)
		.filter((id) => !src.includes(`'${id}'`) && !src.includes(`"${id}"`));
	assert.deepStrictEqual(missing, [], 'declared in package.json but never registerCommand()ed');
});

test('every menu, keybinding and walkthrough names a declared command', () => {
	const declared = new Set(contributes.commands.map((c) => c.command));
	// The editor's own commands are fair game from a walkthrough link.
	const builtin = new Set(['workbench.action.files.openFolder']);
	const referenced = [];

	for (const [where, entries] of Object.entries(contributes.menus)) {
		for (const e of entries) {
			referenced.push([`menus.${where}`, e.command]);
		}
	}
	for (const k of contributes.keybindings ?? []) {
		referenced.push(['keybindings', k.command]);
	}
	for (const w of contributes.viewsWelcome ?? []) {
		for (const m of w.contents.matchAll(/command:([\w.]+)/g)) {
			referenced.push([`viewsWelcome.${w.view}`, m[1]]);
		}
	}
	for (const w of contributes.walkthroughs ?? []) {
		for (const step of w.steps) {
			for (const m of step.description.matchAll(/command:([\w.]+)/g)) {
				referenced.push([`walkthrough.${step.id}`, m[1]]);
			}
			for (const e of step.completionEvents ?? []) {
				if (e.startsWith('onCommand:')) {
					referenced.push([`walkthrough.${step.id}.completion`, e.slice('onCommand:'.length)]);
				}
			}
		}
	}

	const bad = referenced.filter(([, id]) => !declared.has(id) && !builtin.has(id));
	assert.deepStrictEqual(bad, [], 'referenced but not in contributes.commands');
	assert.ok(referenced.length > 20, 'the manifest should reference commands from menus and the walkthrough');
});

test('every walkthrough step points at a file that ships', () => {
	const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
	for (const w of contributes.walkthroughs ?? []) {
		for (const step of w.steps) {
			const rel = step.media.markdown ?? step.media.image ?? step.media.svg;
			assert.ok(rel, `${step.id} has no media`);
			assert.ok(fs.existsSync(path.join(root, rel)), `${step.id}: ${rel} does not exist`);
			// A media file excluded from the package renders blank in the
			// installed extension while looking fine in the repository.
			const top = rel.split('/')[0];
			assert.ok(!ignore.includes(`\n${top}/**`), `${step.id}: ${top}/ is excluded from the package`);
		}
	}
});

test('the snippets file is what VS Code expects', () => {
	const declared = contributes.snippets ?? [];
	assert.strictEqual(declared.length, 1);
	const file = path.join(root, declared[0].path);
	assert.ok(fs.existsSync(file), `${declared[0].path} does not exist`);

	const snippets = JSON.parse(fs.readFileSync(file, 'utf8'));
	const prefixes = new Set();
	let count = 0;
	for (const [name, value] of Object.entries(snippets)) {
		if (name === '//') {
			continue; // the file's own header comment
		}
		count++;
		assert.ok(value.prefix, `${name} has no prefix`);
		assert.ok(value.description, `${name} has no description - it is what the completion list shows`);
		assert.ok(value.body, `${name} has no body`);
		assert.ok(!prefixes.has(value.prefix), `two snippets both answer to "${value.prefix}"`);
		prefixes.add(value.prefix);
		assert.ok(value.prefix.startsWith('gf'), `${value.prefix} does not start with gf - the prefix is the namespace`);
	}
	assert.ok(count >= 30, `only ${count} snippets`);
});

test('snippet placeholders are balanced', () => {
	const snippets = JSON.parse(fs.readFileSync(path.join(root, contributes.snippets[0].path), 'utf8'));
	for (const [name, value] of Object.entries(snippets)) {
		if (name === '//') {
			continue;
		}
		const body = Array.isArray(value.body) ? value.body.join('\n') : value.body;
		// A choice written ${1|a,b} instead of ${1|a,b|} is inserted as
		// literal text, which is the kind of thing nobody notices in review.
		for (const m of body.matchAll(/\$\{(\d+)\|([^}]*)\}/g)) {
			assert.ok(m[2].endsWith('|'), `${name}: choice \${${m[1]}|...} is missing its closing |`);
		}
		const opens = (body.match(/\$\{/g) ?? []).length;
		const closes = (body.match(/\}/g) ?? []).length;
		assert.ok(closes >= opens, `${name}: ${opens} \${ but only ${closes} }`);
	}
});

test('the README lists exactly the snippets that exist', () => {
	// The listing is the only place most people will see them - a snippet
	// nobody knows about is a snippet nobody types.
	const snippets = JSON.parse(fs.readFileSync(path.join(root, contributes.snippets[0].path), 'utf8'));
	const real = new Set(Object.entries(snippets).filter(([k]) => k !== '//').map(([, v]) => v.prefix));
	const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
	const listed = new Set([...readme.matchAll(/`(gf\w+)`/g)].map((m) => m[1]));

	assert.deepStrictEqual([...real].filter((p) => !listed.has(p)), [], 'snippets missing from the README');
	assert.deepStrictEqual([...listed].filter((p) => !real.has(p)), [], 'the README promises snippets that do not exist');
});

test('the README lists every command the extension contributes', () => {
	const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
	const missing = contributes.commands
		.map((c) => resolveNls(c.title))
		// The listing writes an ellipsis where the title has three dots, and
		// drops the parenthetical a palette entry needs to disambiguate itself.
		.map((t) => t.replace(/\.\.\.$/, '').replace(/\s*\([^)]*\)$/, ''))
		.filter((t) => !readme.includes(t));
	assert.deepStrictEqual(missing, [], 'commands with no entry in the README table');
});

test('every %key% in the manifest has an English string', () => {
	// A key with no entry renders as the literal "%cmd.build.title%" in the
	// command palette - which is exactly as broken as it looks, and shows up
	// only when someone opens the palette.
	const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
	const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	const used = new Set([...raw.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));

	assert.deepStrictEqual([...used].filter((k) => !(k in nls)), [], 'keys used by package.json but not defined');
	assert.deepStrictEqual(Object.keys(nls).filter((k) => !used.has(k)), [], 'strings defined but never used');
});

test('the translations cover the same keys as the source', () => {
	// A missing key silently falls back to English, so a half-finished
	// translation looks like a finished one until you hit the gap.
	const nls = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
	for (const file of fs.readdirSync(root).filter((f) => /^package\.nls\..+\.json$/.test(f))) {
		const translated = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
		assert.deepStrictEqual(
			Object.keys(nls).filter((k) => !(k in translated)),
			[],
			`${file} is missing keys`
		);
		assert.deepStrictEqual(
			Object.keys(translated).filter((k) => !(k in nls)),
			[],
			`${file} has keys the source does not`
		);
		// A command link inside a welcome view or a walkthrough step is not
		// prose: translating the command id breaks the button.
		for (const [key, text] of Object.entries(translated)) {
			const links = (s) => [...String(s).matchAll(/command:([\w.]+)/g)].map((m) => m[1]).sort();
			assert.deepStrictEqual(links(text), links(nls[key]), `${file}: ${key} changed a command link`);
		}
	}
});

test('activation covers the windows the welcome view asks about', () => {
	// The Explorer's "no Go module here" button is hidden by the
	// goforms.hasProject context key, which only exists once the extension has
	// activated. Without a workspaceContains rule, a project opened without a
	// .go file in the editor never activates it, and the button invites you to
	// create a project on top of the one already there.
	assert.ok(
		manifest.activationEvents.includes('workspaceContains:go.mod'),
		'a folder holding a go.mod must activate the extension'
	);
});
