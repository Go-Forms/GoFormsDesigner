// Exercises the webview client end to end against a stub DOM.
//
// designer.js is plain DOM code running inside a webview, so a mistake in it
// surfaces as nothing happening - no error the user can see, no test that
// notices. These load the real file, feed it the messages the extension host
// sends, and check the panel it builds.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

const { install } = require('../testlib/domShim');

/** catalog is a trimmed stand-in for the Go tool's `catalog` output. */
const catalog = {
	Button: {
		Type: 'Button',
		Category: 'Common Controls',
		DefaultW: 90,
		DefaultH: 30,
		IsContainer: false,
		Setters: { SetText: 'text', SetAnchor: 'anchor', SetTabIndex: 'tabIndex' },
		Kinds: { anchor: 'flags', tabIndex: 'number' },
		Enums: { anchor: ['AnchorTop', 'AnchorLeft'] },
		Events: ['Click', 'MouseDown'],
		EventArgs: { Click: 'MouseEventArgs', MouseDown: 'MouseEventArgs' },
		OwnEventCount: 0,
	},
	Panel: {
		Type: 'Panel',
		Category: 'Containers',
		DefaultW: 200,
		DefaultH: 150,
		IsContainer: true,
		Setters: {},
		Events: ['Click'],
		EventArgs: { Click: 'MouseEventArgs' },
		OwnEventCount: 0,
	},
	ToolStrip: {
		Type: 'ToolStrip',
		Category: 'Menus & Toolbars',
		DefaultW: 400,
		DefaultH: 34,
		IsContainer: false,
		Setters: {},
		Events: [],
		Collection: { Label: 'Buttons', Method: 'AddButton', Handler: true, Separator: true },
	},
};

function model(controls) {
	return {
		package: 'mainform',
		receiverType: 'MainForm',
		recvVar: 'mf',
		formTitle: 'Test',
		formWidth: 800,
		formHeight: 600,
		controls,
		radioGroups: [],
		structRange: { start: 0, end: 0 },
		initRange: { start: 0, end: 0 },
	};
}

const button = (id, over) =>
	Object.assign({ id, type: 'Button', parent: '', x: 10, y: 10, w: 90, h: 30, text: id, supported: true }, over);

/** boot loads designer.js against a fresh stub DOM and sends it an init. */
function boot(controls) {
	const dom = install();
	// designer.js is an IIFE with no exports; requiring it runs it, and the
	// cache has to be cleared so each test gets its own instance.
	const file = path.join(__dirname, '..', 'media', 'designer.js');
	// Same load order as the webview: the two helper globals, then the client.
	for (const dep of ['../media/gridLayout.js', '../media/renderPlan.js', '../media/dockLayout.js']) {
		delete require.cache[require.resolve(dep)];
		require(dep);
	}
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'init', model: model(controls), catalog, categories: ['Common Controls', 'Containers', 'Menus & Toolbars'] });
	return dom;
}

/** panelText flattens the properties panel to one string for assertions. */
function panelText(dom) {
	return dom.el('properties-panel').descendants.map((e) => e.textContent).join(' | ');
}

/** clickControl simulates a mousedown on a control's canvas element. */
function clickControl(dom, id) {
	const el = dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === id);
	assert.ok(el, `no canvas element for ${id}`);
	el.dispatch('mousedown', { clientX: 0, clientY: 0 });
	return el;
}

test('the properties panel starts with a prompt, not empty', () => {
	const dom = boot([button('btn1')]);
	assert.match(panelText(dom), /Select a control/);
});

test('selecting a control fills the properties panel', () => {
	const dom = boot([button('btn1')]);
	clickControl(dom, 'btn1');

	const text = panelText(dom);
	assert.match(text, /Button · btn1/, 'header missing');
	assert.match(text, /Name/, 'name group missing');
	assert.match(text, /Parent/, 'parent group missing');
	assert.match(text, /Bounds/, 'bounds group missing');
	assert.match(text, /Text/, 'text group missing');
	assert.match(text, /Events/, 'events group missing');
	assert.match(text, /Delete btn1/, 'delete button missing');
});

test('selecting a control switches to the Properties tab', () => {
	const dom = boot([button('btn1')]);
	dom.tabs.controls.dispatch('click');
	assert.equal(dom.el('properties-panel').hidden, true, 'properties should be hidden on the Controls tab');

	clickControl(dom, 'btn1');
	assert.equal(dom.el('properties-panel').hidden, false, 'clicking a control should reveal Properties');
	assert.equal(dom.el('controls-panel').hidden, true);
});

test('the tabs switch both ways', () => {
	const dom = boot([button('btn1')]);
	dom.tabs.controls.dispatch('click');
	assert.equal(dom.el('controls-panel').hidden, false);
	assert.equal(dom.el('properties-panel').hidden, true);

	dom.tabs.properties.dispatch('click');
	assert.equal(dom.el('controls-panel').hidden, true);
	assert.equal(dom.el('properties-panel').hidden, false);
});

test('the panel survives a model refresh, keeping the selection', () => {
	// The file changing on disk sends a fresh init, which used to clear the
	// selection - the panel emptied itself out from under the user after
	// every edit.
	const dom = boot([button('btn1')]);
	clickControl(dom, 'btn1');
	assert.match(panelText(dom), /Button · btn1/);

	dom.send({ type: 'model', model: model([button('btn1', { text: 'Changed' })]) });
	assert.match(panelText(dom), /Button · btn1/, 'selection lost on refresh');

	dom.send({ type: 'init', model: model([button('btn1', { text: 'Changed' })]), catalog, categories: [] });
	assert.match(panelText(dom), /Button · btn1/, 'selection lost on re-init');
});

test('a control that disappears clears the panel', () => {
	const dom = boot([button('btn1'), button('btn2', { y: 60 })]);
	clickControl(dom, 'btn2');
	assert.match(panelText(dom), /Button · btn2/);

	dom.send({ type: 'model', model: model([button('btn1')]) });
	assert.match(panelText(dom), /Select a control/);
});

test('editing a property re-renders the panel rather than freezing it', () => {
	const dom = boot([button('btn1')]);
	clickControl(dom, 'btn1');
	assert.match(panelText(dom), /btn1/);

	dom.send({ type: 'model', model: model([button('btn1', { text: 'Saved' })]) });
	const inputs = dom.el('properties-panel').querySelectorAll('input');
	assert.ok(
		inputs.some((i) => i.value === 'Saved'),
		'the panel still shows the old text after the model changed'
	);
});

test('the collection editor appears for a control that has one', () => {
	const dom = boot([
		Object.assign(button('ts1', { type: 'ToolStrip', w: 400, h: 34 }), {
			collection: [{ text: 'New' }, { kind: 'separator' }],
		}),
	]);
	clickControl(dom, 'ts1');
	const text = panelText(dom);
	assert.match(text, /Buttons/, 'collection group missing');
	assert.match(text, /separator/, 'separator row missing');
});

test('the Controls tab lists every type, grouped', () => {
	const dom = boot([button('btn1')]);
	const text = dom.el('controls-panel').descendants.map((e) => e.textContent).join(' | ');
	assert.match(text, /Common Controls/);
	assert.match(text, /Containers/);
	assert.match(text, /Button/);
	assert.match(text, /Panel/);
});

test('the canvas keeps one deselect listener however often the model refreshes', () => {
	// renderCanvas used to re-add this listener on every refresh, so a single
	// click eventually ran dozens of handlers.
	const dom = boot([button('btn1')]);
	const canvas = dom.el('form-canvas');
	const before = canvas.listenerCount('mousedown');
	for (let i = 0; i < 10; i++) {
		dom.send({ type: 'model', model: model([button('btn1', { x: 10 + i })]) });
	}
	assert.equal(canvas.listenerCount('mousedown'), before, 'canvas mousedown listeners piled up');
});

test('a docked control is drawn where the running form will put it', () => {
	// The bug this covers: the canvas drew a docked control at its stored
	// x/y/w/h, but at runtime DockLeft glues it to the parent's left edge and
	// stretches it to the full height. Designer and application disagreed.
	const dom = boot([button('btn1', { x: 11, y: 7, w: 200, h: 50, props: { dock: 'DockLeft' } })]);
	const el = dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === 'btn1');

	assert.equal(el.style.left, '0px', 'a DockLeft control sits at the left edge');
	assert.equal(el.style.top, '0px');
	assert.equal(el.style.width, '200px', 'its own width is kept');
	assert.equal(el.style.height, '600px', 'it takes the full client height');
	assert.ok(el.classList.contains('docked'), 'a docked control should be marked as such');
});

test('an undocked control still uses its own bounds', () => {
	const dom = boot([button('btn1', { x: 11, y: 7, w: 200, h: 50 })]);
	const el = dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === 'btn1');
	assert.equal(el.style.left, '11px');
	assert.equal(el.style.top, '7px');
	assert.ok(!el.classList.contains('docked'));
});

test('docked siblings carve the client area up in order', () => {
	const dom = boot([
		button('top1', { x: 0, y: 0, w: 100, h: 40, props: { dock: 'DockTop' } }),
		button('fill1', { x: 5, y: 5, w: 10, h: 10, props: { dock: 'DockFill' } }),
	]);
	const find = (id) => dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === id);

	assert.equal(find('top1').style.width, '800px', 'DockTop spans the full width');
	assert.equal(find('top1').style.height, '40px');
	assert.equal(find('fill1').style.top, '40px', 'the fill starts below what the top took');
	assert.equal(find('fill1').style.height, '560px');
});
