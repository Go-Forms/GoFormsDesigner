// The theme editor's webview, driven against a stub DOM.
//
// The client is plain DOM code inside a webview, so a mistake in it shows up
// as nothing happening - no error anyone sees. These load the real file, feed
// it the model the extension host sends, and check both halves of the panel:
// the fields it builds and the ops it sends back.
//
// Run with: node --test
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

const { install } = require('../testlib/domShim');

/** themeModel mirrors tool/theme.go's ThemeModel. Only the fields a test
 * needs are set; the rest arrive unset, which is their real default state. */
function themeModel(overrides = {}) {
	const spec = [
		['Name', 'text'], ['Dark', 'bool'],
		['Background', 'color'], ['Foreground', 'color'], ['Primary', 'color'],
		['InputBackground', 'color'], ['ButtonColor', 'color'], ['Hover', 'color'],
		['Border', 'color'], ['Disabled', 'color'], ['Placeholder', 'color'],
		['Selection', 'color'], ['ScrollBar', 'color'],
		['TextSize', 'number'], ['Padding', 'number'],
		['InputBorderWidth', 'number'], ['InputRadius', 'number'],
	];
	return {
		file: '/tmp/myapp-styles.go',
		package: 'main',
		funcName: 'Theme',
		note: '',
		fields: spec.map(([name, kind]) =>
			Object.assign({ name, kind, role: '', set: false, editable: true }, overrides[name] || {})),
	};
}

function boot(model) {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'theme.js');
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'model', model: model || themeModel() });
	return dom;
}

/** row returns the field row for a name. */
function row(dom, name) {
	const r = dom.el('fields').descendants.find(
		(e) => e.className && String(e.className).includes('row') &&
			e.children.some((c) => c.textContent === name));
	assert.ok(r, `no row for ${name}`);
	return r;
}

const inputsIn = (el) => el.descendants.filter((e) => e.tagName === 'INPUT');
const ops = (dom) => dom.posted.filter((m) => m.type === 'apply').flatMap((m) => m.ops);

test('the editor asks for a model as soon as it loads', () => {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'theme.js');
	delete require.cache[require.resolve(file)];
	require(file);
	assert.ok(dom.posted.some((m) => m.type === 'ready'), 'no ready message was sent');
});

test('every theme field gets a row', () => {
	const dom = boot();
	const rows = dom.el('fields').descendants.filter(
		(e) => e.className && String(e.className).split(' ').includes('row'));
	assert.equal(rows.length, 17, `expected a row per field, got ${rows.length}`);
});

// A set field is a decision and an unset one is a default, and an unset field
// still shows a value - so the two have to be distinguishable.
test('set and unset fields are marked differently', () => {
	const dom = boot(themeModel({ Primary: { set: true, color: '#4c97ff' } }));

	assert.ok(String(row(dom, 'Primary').className).includes('set'), 'a set field should be marked');
	assert.ok(!String(row(dom, 'Hover').className).includes('set'), 'an unset field should not be');
});

test('an unset field offers no clear button, a set one does', () => {
	const dom = boot(themeModel({ Primary: { set: true, color: '#4c97ff' } }));

	const clears = (name) =>
		row(dom, name).descendants.filter((e) => String(e.className).includes('clear')).length;
	assert.equal(clears('Primary'), 1, 'a set field should be clearable');
	assert.equal(clears('Hover'), 0, 'an unset field has nothing to clear');
});

test('picking a colour sends a set op', () => {
	const dom = boot();
	const swatch = inputsIn(row(dom, 'Primary')).find((e) => e.type === 'color');
	swatch.value = '#ff8800';
	swatch.dispatch('change', {});

	assert.deepEqual(ops(dom), [{ op: 'set', field: 'Primary', color: '#ff8800' }]);
});

// <input type=color> has no alpha, so the hex box is the only way to type one.
test('the hex box accepts an eight-digit colour', () => {
	const dom = boot();
	const hex = inputsIn(row(dom, 'Background')).find((e) => String(e.className).includes('hex'));
	hex.value = '#11223344';
	hex.dispatch('change', {});

	assert.deepEqual(ops(dom), [{ op: 'set', field: 'Background', color: '#11223344' }]);
});

test('the hex box refuses nonsense and puts back what was there', () => {
	const dom = boot(themeModel({ Background: { set: true, color: '#1e1f22' } }));
	const hex = inputsIn(row(dom, 'Background')).find((e) => String(e.className).includes('hex'));
	hex.value = 'not a colour';
	hex.dispatch('change', {});

	assert.equal(ops(dom).length, 0, 'nothing should have been sent');
	assert.equal(hex.value, '#1e1f22', 'the field should have reverted');
});

test('clearing a field sends an unset op', () => {
	const dom = boot(themeModel({ Padding: { set: true, number: 6 } }));
	const clear = row(dom, 'Padding').descendants.find((e) => String(e.className).includes('clear'));
	clear.dispatch('click', {});

	assert.deepEqual(ops(dom), [{ op: 'unset', field: 'Padding' }]);
});

test('a metric refuses a negative value', () => {
	const dom = boot(themeModel({ Padding: { set: true, number: 6 } }));
	const input = inputsIn(row(dom, 'Padding'))[0];
	input.value = '-3';
	input.dispatch('change', {});

	assert.equal(ops(dom).length, 0);
	assert.equal(input.value, '6');
});

test('the Dark checkbox sends a bool', () => {
	const dom = boot();
	const box = inputsIn(row(dom, 'Dark'))[0];
	box.checked = true;
	box.dispatch('change', {});

	assert.deepEqual(ops(dom), [{ op: 'set', field: 'Dark', bool: true }]);
});

// A colour built from a constant is someone's deliberate choice; the editor
// shows it and stays out of the way.
test('a field holding an expression is shown read-only', () => {
	const dom = boot(themeModel({
		Background: { set: true, editable: false, raw: 'brandBackground' },
	}));
	const r = row(dom, 'Background');

	assert.equal(inputsIn(r).length, 0, 'a read-only field should have no editor');
	assert.ok(r.descendants.some((e) => e.textContent === 'brandBackground'),
		'it should show what is actually there');
});

test('the preview is drawn', () => {
	const dom = boot(themeModel({
		Name: { set: true, text: 'Midnight' },
		Background: { set: true, color: '#1e1f22' },
		Primary: { set: true, color: '#4c97ff' },
	}));
	const preview = dom.el('preview');

	const win = preview.descendants.find((e) => String(e.className).includes('pv-window'));
	assert.ok(win, 'no preview window');
	assert.equal(win.style.background, '#1e1f22', 'the preview should use the theme background');

	const title = preview.descendants.find((e) => String(e.className).includes('pv-title'));
	assert.equal(title.style.background, '#4c97ff');
	assert.equal(title.textContent, 'Midnight', 'the title should name the theme');
});

// Unset colours are drawn as the default they fall back to, so the preview
// shows what the theme will look like rather than only what it sets.
test('the preview fills unset colours with the default they fall back to', () => {
	const light = boot(themeModel());
	const lightWin = light.el('preview').descendants.find((e) => String(e.className).includes('pv-window'));
	assert.ok(lightWin.style.background, 'an unset background should still be painted');

	const dark = boot(themeModel({ Dark: { set: true, bool: true } }));
	const darkWin = dark.el('preview').descendants.find((e) => String(e.className).includes('pv-window'));
	assert.notEqual(darkWin.style.background, lightWin.style.background,
		'the dark flag should change which defaults the preview uses');
});

test('a parse error is explained rather than left blank', () => {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'theme.js');
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'parseError', message: 'no goforms.Theme{...} literal found' });

	const text = dom.el('fields').descendants.map((e) => e.textContent).join(' ');
	assert.match(text, /goforms\.Theme/);
});
