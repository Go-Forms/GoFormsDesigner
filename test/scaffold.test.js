// The scaffold's substitution, exercised against the real template files.
//
// A generated project is the first Go anyone sees from this extension, and a
// broken token or a stray blank line in it is not something the extension
// host would ever report - it just ships.
//
// Run with: node --test
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const templates = path.join(root, 'templates');

/** The token set the extension builds, mirrored here so the templates can be
 * checked without loading the extension host. Kept in step by
 * "every token in the templates is substituted", below. */
function tokensFor(project, theme) {
	return {
		MODULE: project,
		APP_ID: `com.example.${project}`,
		APP_NAME: project,
		REPLACE_BLOCK: '',
		THEME_CALL: theme ? '\tgoforms.SetTheme(Theme())\n' : '',
		THEME_BODY: theme ? '\t\tName:            "Dark",\n\t\tDark:            true,\n' : '',
	};
}

const substitute = (text, tokens) =>
	Object.entries(tokens).reduce((acc, [k, v]) => acc.split(`{{${k}}}`).join(v), text);

/** Files copied byte for byte by copyTemplateDir; they hold no tokens. */
const isBinary = (name) => /\.(png|ico|jpe?g|gif|woff2?|ttf)$/i.test(name);

/** Tokens filled in by a build, not by the scaffold: the WebAssembly page
 * keeps {{WASM_FILE}} until "Build for WebAssembly" knows the file name. */
const buildTimeTokens = new Set(['WASM_FILE']);

/** render copies a template directory the way copyTemplateDir does, into a
 * plain object of path -> contents. */
function render(dir, tokens, into = {}, prefix = '') {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const name = substitute(entry.name, tokens);
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			render(full, tokens, into, path.posix.join(prefix, name));
		} else if (isBinary(entry.name)) {
			into[path.posix.join(prefix, name)] = '<binary>';
		} else {
			into[path.posix.join(prefix, name)] = substitute(fs.readFileSync(full, 'utf8'), tokens);
		}
	}
	return into;
}

const noTokensLeft = (files) => {
	for (const [name, body] of Object.entries(files)) {
		for (const m of body.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
			assert.ok(buildTimeTokens.has(m[1]), `${name} still has an unsubstituted token {{${m[1]}}}`);
		}
		assert.ok(!/\{\{[A-Z_]+\}\}/.test(name), `the file name ${name} still has a token`);
	}
};

// Every project is templates/common plus one of these.
const projectTemplates = ['empty', 'example', 'android', 'web'];

test('the common template substitutes every token', () => {
	noTokensLeft(render(path.join(templates, 'common'), tokensFor('myapp', true)));
});

for (const template of projectTemplates) {
	test(`the ${template} template substitutes every token`, () => {
		noTokensLeft(render(path.join(templates, template), tokensFor('myapp', true)));
	});

	test(`the ${template} template names the published module`, () => {
		const files = render(path.join(templates, template), tokensFor('myapp', false));
		assert.match(files['go.mod'], /require\b[\s\S]*github\.com\/Go-Forms\/GoForms/);
		// A project with no local checkout is not pinned to this machine:
		// nothing redirects the framework itself to a path on disk.
		assert.ok(
			!/replace\s+github\.com\/Go-Forms\/GoForms\b/.test(files['go.mod']),
			'a project with no local checkout needs no replace for the framework'
		);
		assert.ok(!/=>\s*\.{0,2}[\\/]/.test(files['go.mod']), 'no replace should point at a local path');
	});

	// The browser shim decides whether a key is a character by its length,
	// and upstream counts bytes - so Cyrillic, Greek and every accented
	// character never reach a WebAssembly build. Until that is upstream, the
	// redirect is what makes those projects usable, and losing it would be
	// invisible until someone typed.
	test(`the ${template} template redirects the browser shim`, () => {
		const files = render(path.join(templates, template), tokensFor('myapp', false));
		assert.match(
			files['go.mod'],
			/replace\s+github\.com\/fyne-io\/glfw-js\s+=>\s+github\.com\/Go-Forms\/glfw-js\s+v\d+\.\d+\.\d+/
		);
	});
}

test('a project without a theme has no styles file and no SetTheme call', () => {
	const files = render(path.join(templates, 'empty'), tokensFor('plain', false));
	assert.ok(!('plain-styles.go' in files), 'there should be no styles file');
	assert.ok(!/SetTheme/.test(files['main.go']), 'main() should not apply a theme');
	assert.match(files['main.go'], /goforms\.Run\(/);
});

test('a project with a theme calls SetTheme before Run', () => {
	const tokens = tokensFor('myapp', true);
	const files = render(path.join(templates, 'empty'), tokens);
	Object.assign(files, render(path.join(templates, 'styles'), tokens));

	assert.ok('myapp-styles.go' in files, 'the styles file should be named after the project');
	const main = files['main.go'];
	assert.ok(main.indexOf('SetTheme') < main.indexOf('goforms.Run('),
		'the theme has to be applied before any form is created');
});

test('the styles file declares the function main.go calls', () => {
	const files = render(path.join(templates, 'styles'), tokensFor('myapp', true));
	const styles = files['myapp-styles.go'];

	assert.match(styles, /func Theme\(\) goforms\.Theme \{/);
	assert.match(styles, /return goforms\.Theme\{/);
	assert.match(styles, /Name:\s+"Dark",/);
});

test('an empty theme body still leaves a valid literal', () => {
	const files = render(path.join(templates, 'styles'), {
		MODULE: 'myapp', REPLACE_BLOCK: '', THEME_CALL: '', THEME_BODY: '',
	});
	assert.match(files['myapp-styles.go'], /return goforms\.Theme\{\s*\}/);
});

test('every token used by a template is one the extension supplies', () => {
	// Catches a template that starts using a marker nothing fills in, which
	// would ship as literal {{BRACES}} in someone's new project.
	const known = new Set(['MODULE', 'APP_ID', 'APP_NAME', 'REPLACE_BLOCK', 'THEME_CALL', 'THEME_BODY', ...buildTimeTokens]);
	const seen = new Set();
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			for (const m of entry.name.matchAll(/\{\{([A-Z_]+)\}\}/g)) seen.add(m[1]);
			if (entry.isDirectory()) walk(full);
			else if (!isBinary(entry.name)) for (const m of fs.readFileSync(full, 'utf8').matchAll(/\{\{([A-Z_]+)\}\}/g)) seen.add(m[1]);
		}
	};
	walk(templates);

	for (const token of seen) {
		assert.ok(known.has(token), `templates use {{${token}}}, which nothing substitutes`);
	}
});

test('every project gets the files a web or Android build needs', () => {
	const common = render(path.join(templates, 'common'), tokensFor('myapp', false));
	assert.ok('FyneApp.toml' in common, 'FyneApp.toml names the app for fyne package');
	assert.match(common['FyneApp.toml'], /ID = "com\.example\.myapp"/);
	assert.match(common['FyneApp.toml'], /Icon = "Icon\.png"/);
	assert.ok('Icon.png' in common, 'an Android app must have a launcher icon');
	assert.ok('wasm/index.html' in common, 'the WebAssembly page');
	assert.match(common['wasm/index.html'], /\{\{WASM_FILE\}\}/, 'the page waits for the build to name the .wasm');
	assert.match(common['wasm/index.html'], /wasm_exec\.js/);
	assert.match(common['wasm/index.html'], /dummyEntry/, 'Fyne raises the phone keyboard through this input');
	assert.ok('.vscode/tasks.json' in common, 'the builds as editor tasks');
	assert.match(common['.vscode/tasks.json'], /myapp\.wasm/);
});

test('the android and web templates share one main form at two sizes', () => {
	const android = render(path.join(templates, 'android'), tokensFor('myapp', false));
	const web = render(path.join(templates, 'web'), tokensFor('myapp', false));
	assert.match(android['Forms/MainForm/MainForm-designer.go'], /NewForm\("myapp", 360, 640\)/, 'a phone in portrait');
	assert.match(web['Forms/MainForm/MainForm-designer.go'], /NewForm\("myapp", 960, 600\)/, 'a browser tab');
	for (const files of [android, web]) {
		const designer = files['Forms/MainForm/MainForm-designer.go'];
		assert.match(designer, /SetDock\(goforms\.DockFill\)/, 'the list takes whatever is left');
		assert.match(designer, /AnchorRight/, 'the input row stretches');
		assert.match(files['main.go'], /NewApplication\("com\.example\.myapp"\)/, 'the app id matches FyneApp.toml');
	}
});
