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
		REPLACE_BLOCK: '',
		THEME_CALL: theme ? '\tgoforms.SetTheme(Theme())\n' : '',
		THEME_BODY: theme ? '\t\tName:            "Dark",\n\t\tDark:            true,\n' : '',
	};
}

const substitute = (text, tokens) =>
	Object.entries(tokens).reduce((acc, [k, v]) => acc.split(`{{${k}}}`).join(v), text);

/** render copies a template directory the way copyTemplateDir does, into a
 * plain object of path -> contents. */
function render(dir, tokens, into = {}, prefix = '') {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const name = substitute(entry.name, tokens);
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			render(full, tokens, into, path.posix.join(prefix, name));
		} else {
			into[path.posix.join(prefix, name)] = substitute(fs.readFileSync(full, 'utf8'), tokens);
		}
	}
	return into;
}

const noTokensLeft = (files) => {
	for (const [name, body] of Object.entries(files)) {
		assert.ok(!/\{\{[A-Z_]+\}\}/.test(body), `${name} still has an unsubstituted token`);
		assert.ok(!/\{\{[A-Z_]+\}\}/.test(name), `the file name ${name} still has a token`);
	}
};

for (const template of ['empty', 'example']) {
	test(`the ${template} template substitutes every token`, () => {
		noTokensLeft(render(path.join(templates, template), tokensFor('myapp', true)));
	});

	test(`the ${template} template names the published module`, () => {
		const files = render(path.join(templates, template), tokensFor('myapp', false));
		assert.match(files['go.mod'], /require\b[\s\S]*github\.com\/Go-Forms\/GoForms/);
		assert.ok(!/replace/.test(files['go.mod']), 'a project with no local checkout needs no replace');
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
	const known = new Set(['MODULE', 'REPLACE_BLOCK', 'THEME_CALL', 'THEME_BODY']);
	const seen = new Set();
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			for (const m of entry.name.matchAll(/\{\{([A-Z_]+)\}\}/g)) seen.add(m[1]);
			if (entry.isDirectory()) walk(full);
			else for (const m of fs.readFileSync(full, 'utf8').matchAll(/\{\{([A-Z_]+)\}\}/g)) seen.add(m[1]);
		}
	};
	walk(templates);

	for (const token of seen) {
		assert.ok(known.has(token), `templates use {{${token}}}, which nothing substitutes`);
	}
});
