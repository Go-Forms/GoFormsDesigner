// The component tray, from the webview's side.
//
// A Timer has no bounds and no container. Every piece of the canvas code
// assumes both - the render plan, the docking pass, the properties panel's
// position fields - so the interesting question is not whether the tray draws
// but whether a component stays *out* of all of that. A component that leaked
// into the render plan would be drawn at 0,0 on top of the form, which is the
// bug these are here to catch.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

const { install } = require('../testlib/domShim');

const catalog = {
	Button: {
		Type: 'Button',
		Category: 'Common Controls',
		DefaultW: 90,
		DefaultH: 30,
		IsContainer: false,
		Setters: { SetText: 'text' },
		Events: ['Click'],
		EventArgs: { Click: 'MouseEventArgs' },
		OwnEventCount: 0,
	},
	Panel: {
		Type: 'Panel',
		Category: 'Containers',
		DefaultW: 200,
		DefaultH: 150,
		IsContainer: true,
		Setters: {},
		Events: [],
	},
	Timer: {
		Type: 'Timer',
		Category: 'Components',
		NonVisual: true,
		CtorProps: ['interval'],
		Kinds: { interval: 'number', enabled: 'bool' },
		Calls: { enabled: 'Start' },
		Events: ['Tick'],
		EventArgs: { Tick: 'EventArgs' },
		OwnEventCount: 1,
	},
	OpenFileDialog: {
		Type: 'OpenFileDialog',
		Category: 'Components',
		NonVisual: true,
		Fields: { Title: 'title', InitialDirectory: 'initialDirectory' },
		Events: [],
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

const button = (id) => ({ id, type: 'Button', parent: '', x: 10, y: 10, w: 90, h: 30, text: id, supported: true });
const timer = (id, props) => ({ id, type: 'Timer', parent: '', x: 0, y: 0, w: 0, h: 0, supported: true, props: props || {} });
const dialog = (id, props) => ({
	id, type: 'OpenFileDialog', parent: '', x: 0, y: 0, w: 0, h: 0, supported: true, props: props || {},
});

function boot(controls) {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'designer.js');
	for (const dep of ['../media/gridLayout.js', '../media/renderPlan.js', '../media/dockLayout.js']) {
		delete require.cache[require.resolve(dep)];
		require(dep);
	}
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({
		type: 'init',
		model: model(controls),
		catalog,
		categories: ['Common Controls', 'Containers', 'Components'],
	});
	return dom;
}

const trayItems = (dom) => dom.el('component-tray-items').querySelectorAll('.tray-item');
const canvasCtrls = (dom) => dom.el('form-canvas').querySelectorAll('.ctrl');
const panelText = (dom) => dom.el('properties-panel').descendants.map((e) => e.textContent).join(' | ');

test('a component lands on the tray and never on the canvas', () => {
	const dom = boot([button('btn1'), timer('tmr1', { interval: '500' })]);

	const onCanvas = canvasCtrls(dom).map((e) => e.dataset.id);
	assert.deepStrictEqual(onCanvas, ['btn1'], 'the timer was drawn on the form');

	const inTray = trayItems(dom).map((e) => e.dataset.id);
	assert.deepStrictEqual(inTray, ['tmr1']);
});

test('the tray is hidden until there is something in it', () => {
	const empty = boot([button('btn1')]);
	assert.strictEqual(empty.el('component-tray').hidden, true);

	const full = boot([button('btn1'), timer('tmr1')]);
	assert.strictEqual(full.el('component-tray').hidden, false);
});

test('the tray shows the timer state without selecting it', () => {
	const dom = boot([timer('tmr1', { interval: '250', enabled: 'true' })]);
	const item = trayItems(dom)[0];
	assert.match(item.title, /250 ms/);
	assert.match(item.title, /started/);

	const off = boot([timer('tmr1', { interval: '250' })]);
	assert.match(trayItems(off)[0].title, /not started/);
});

test('clicking a tray item selects it and shows its properties', () => {
	const dom = boot([button('btn1'), timer('tmr1', { interval: '500' })]);
	trayItems(dom)[0].dispatch('click', {});

	assert.ok(trayItems(dom)[0].className.includes('selected'), 'the tray item is not marked selected');
	const text = panelText(dom);
	assert.match(text, /Timer · tmr1/);
	assert.match(text, /interval/);
	assert.match(text, /enabled/);
	assert.match(text, /Tick/, 'the Tick event should be offered');
});

test('a component is not offered a position, a size or a parent', () => {
	// All three would be lies, and the panel writing any of them would
	// generate a call the type does not have.
	const dom = boot([button('btn1'), timer('tmr1')]);
	trayItems(dom)[0].dispatch('click', {});

	const text = panelText(dom);
	for (const forbidden of ['Bounds', 'Parent']) {
		assert.ok(!text.includes(forbidden), `the panel offered "${forbidden}" for a Timer:\n${text}`);
	}
	assert.match(text, /no position or size/, 'the panel should say why those are missing');
});

test('a dialog offers its exported fields as properties', () => {
	// They are fields, not setters; the panel must not care which.
	const dom = boot([dialog('dlg1', { title: 'Open' })]);
	trayItems(dom)[0].dispatch('click', {});

	const text = panelText(dom);
	assert.match(text, /OpenFileDialog · dlg1/);
	assert.match(text, /initialDirectory/);
	assert.match(text, /title/);
});

test('adding a component from the toolbox sends no bounds and no parent', () => {
	// A Panel is selected when the Timer is added. A visual control would be
	// parented onto it; a component must not be, because it cannot be on it.
	const dom = boot([{ id: 'pnl1', type: 'Panel', parent: '', x: 0, y: 0, w: 200, h: 150, supported: true }]);
	dom.tabs.controls.dispatch('click', {});
	const panelEl = canvasCtrls(dom).find((e) => e.dataset.id === 'pnl1');
	panelEl.dispatch('mousedown', { clientX: 0, clientY: 0 });

	dom.posted.length = 0;
	const addTimer = dom
		.el('controls-panel')
		.querySelectorAll('.toolbox-item')
		.find((b) => b.textContent === 'Timer');
	assert.ok(addTimer, 'the toolbox does not offer a Timer');
	addTimer.dispatch('click', {});

	const op = dom.posted.at(-1).ops[0];
	assert.strictEqual(op.op, 'add');
	assert.strictEqual(op.type, 'Timer');
	assert.strictEqual(op.parent, undefined, 'a component was parented onto the selected Panel');
	assert.strictEqual(op.w, undefined, 'a component was given a width');
	assert.strictEqual(op.x, undefined, 'a component was given a position');
});

test('the toolbox groups components separately', () => {
	const dom = boot([button('btn1')]);
	dom.tabs.controls.dispatch('click', {});
	const groups = dom.el('controls-panel').querySelectorAll('.toolbox-group').map((e) => e.textContent);
	assert.ok(groups.includes('Components'), `no Components group: ${groups.join(', ')}`);
});

test('deleting a component removes it from the tray', () => {
	const dom = boot([button('btn1'), timer('tmr1')]);
	trayItems(dom)[0].dispatch('click', {});
	dom.posted.length = 0;

	const del = dom.el('properties-panel').querySelectorAll('.delete-btn')[0];
	assert.ok(del, 'no delete button for a component');
	del.dispatch('click', {});

	const op = dom.posted.at(-1).ops[0];
	assert.deepStrictEqual({ op: op.op, id: op.id }, { op: 'remove', id: 'tmr1' });
});
