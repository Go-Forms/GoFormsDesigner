// The form's own properties and events in the properties panel.
//
// The Form is not a control: it has no id, so every op about it carries an
// empty one, the way setForm always has. These check that the panel builds
// the form's groups and addresses them that way - and that the Form does not
// leak into the toolbox, where it would offer to add a second form to a form.
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
		Setters: { SetText: 'text' },
		Events: ['Click'],
		EventArgs: { Click: 'MouseEventArgs' },
		OwnEventCount: 0,
	},
	Form: {
		Type: 'Form',
		Setters: { SetFixedSize: 'fixedSize', SetAutoScroll: 'autoScroll' },
		Kinds: { fixedSize: 'bool', autoScroll: 'bool' },
		Calls: { centerOnScreen: 'CenterOnScreen' },
		Events: ['Load', 'Closing', 'Closed', 'Click'],
		EventArgs: { Closing: '*CancelEventArgs', Click: 'MouseEventArgs' },
		OwnEventCount: 3,
	},
};

function model(over) {
	return Object.assign(
		{
			path: '/tmp/MainForm-designer.go',
			receiverType: 'MainForm',
			recvVar: 'mf',
			formTitle: 'test',
			formWidth: 800,
			formHeight: 600,
			controls: [],
			radioGroups: [],
			structRange: { start: 0, end: 0 },
			initRange: { start: 0, end: 0 },
		},
		over
	);
}

function boot(over) {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'designer.js');
	for (const dep of ['../media/gridLayout.js', '../media/renderPlan.js', '../media/dockLayout.js']) {
		delete require.cache[require.resolve(dep)];
		require(dep);
	}
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'init', model: model(over), catalog, categories: ['Common Controls'] });
	return dom;
}

const panel = (dom) => dom.el('properties-panel');
const panelText = (dom) => panel(dom).descendants.map((e) => e.textContent).join(' | ');

function lastApply(dom) {
	const msgs = dom.posted.filter((m) => m.type === 'apply');
	assert.ok(msgs.length, 'no apply was posted');
	return msgs[msgs.length - 1].ops;
}

test('the form panel shows its own properties and events', () => {
	const dom = boot();
	const text = panelText(dom);
	assert.match(text, /Form · MainForm/, 'header missing');
	assert.match(text, /Title/, 'title missing');
	assert.match(text, /fixedSize/, 'the form properties group is missing');
	assert.match(text, /Load/, 'the form events group is missing');
	assert.match(text, /Closing/);
});

test('a form property is sent with an empty id', () => {
	const dom = boot();
	const boxes = panel(dom).descendants.filter((e) => e.type === 'checkbox');
	assert.ok(boxes.length >= 2, 'expected a checkbox per bool property');

	boxes[0].checked = true;
	boxes[0].dispatch('change');

	const ops = lastApply(dom);
	assert.equal(ops[0].op, 'setProp');
	assert.equal(ops[0].id, '', 'the form has no id to name');
	assert.equal(ops[0].value, 'true');
});

test('a form property shows the value already in the file', () => {
	const dom = boot({ formProps: { fixedSize: 'true' } });
	const boxes = panel(dom).descendants.filter((e) => e.type === 'checkbox');
	const checked = boxes.filter((b) => b.checked);
	assert.equal(checked.length, 1, 'the property set in the file should come up ticked');
});

test('wiring a form event suggests a name built from the receiver type', () => {
	const dom = boot();
	const rows = panel(dom).descendants.filter((e) => String(e.className).includes('event-row'));
	assert.ok(rows.length, 'no event rows');

	const input = rows[0].descendants.find((e) => e.tagName === 'INPUT');
	assert.equal(input.placeholder, 'MainForm_Load', 'an empty id would suggest "_Load"');

	const wire = rows[0].descendants.find((e) => String(e.className).includes('wire-btn'));
	wire.dispatch('click');

	const msg = dom.posted.filter((m) => m.type === 'wireEvent').pop();
	assert.ok(msg, 'no wireEvent was posted');
	assert.equal(msg.id, '');
	assert.equal(msg.event, 'Load');
	assert.equal(msg.handler, 'MainForm_Load');
});

test("Closing's handler stub gets the type that can cancel", () => {
	const dom = boot();
	const rows = panel(dom).descendants.filter((e) => String(e.className).includes('event-row'));
	const closing = rows.find((r) => r.descendants.some((e) => String(e.textContent).startsWith('Closing')));
	assert.ok(closing, 'no Closing row');

	closing.descendants.find((e) => String(e.className).includes('wire-btn')).dispatch('click');
	const msg = dom.posted.filter((m) => m.type === 'wireEvent').pop();
	assert.equal(msg.paramType, '*CancelEventArgs', 'a handler has to be able to say no');
});

test('an event already wired shows its handler', () => {
	const dom = boot({ formEvents: { Load: 'MainForm_Load' } });
	assert.match(panelText(dom), /Load ✓/, 'a wired event should be marked');
});

test('the Form is not offered in the toolbox', () => {
	const dom = boot();
	dom.tabs.controls.dispatch('click');
	const items = dom
		.el('controls-panel')
		.descendants.filter((e) => String(e.className).includes('toolbox-item'));
	assert.ok(items.length, 'the toolbox is empty');
	assert.deepEqual(
		items.map((e) => e.textContent),
		['Button'],
		'the toolbox offered to add a Form to a form'
	);
});
