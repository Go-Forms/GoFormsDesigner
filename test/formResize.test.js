// The form's own resize handle, driven the way a mouse drives it.
//
// This is a drag: mousedown on the handle, mousemove on the document, mouseup
// on the document. Only the last of those decides whether anything is saved,
// so a break anywhere in the chain looks identical from outside - the canvas
// simply does not resize, with no error to see.
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
};

function boot() {
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
		catalog,
		categories: ['Common Controls'],
		model: {
			package: 'mainform',
			receiverType: 'MainForm',
			recvVar: 'mf',
			formTitle: 'Test',
			formWidth: 800,
			formHeight: 600,
			controls: [{ id: 'btn1', type: 'Button', parent: '', x: 10, y: 10, w: 90, h: 30, supported: true }],
			radioGroups: [],
			structRange: { start: 0, end: 0 },
			initRange: { start: 0, end: 0 },
		},
	});
	return dom;
}

function handle(dom) {
	const el = dom.el('form-canvas').querySelectorAll('.form-resize-handle')[0];
	assert.ok(el, 'the canvas has no form resize handle');
	return el;
}

/** drag runs a complete press-move-release over the form's handle. */
function drag(dom, dx, dy) {
	handle(dom).dispatch('mousedown', { clientX: 100, clientY: 100 });
	dom.docDispatch('mousemove', { clientX: 100 + dx, clientY: 100 + dy });
	dom.docDispatch('mouseup', {});
}

test('the form resize handle exists on the canvas', () => {
	const dom = boot();
	assert.ok(handle(dom));
});

test('dragging the handle saves the new form size', () => {
	const dom = boot();
	drag(dom, 100, 50);

	const applies = dom.posted.filter((m) => m.type === 'apply');
	assert.equal(applies.length, 1, `expected one apply, got ${JSON.stringify(dom.posted)}`);
	assert.deepEqual(applies[0].ops, [{ op: 'setForm', id: '', w: 900, h: 650 }]);
});

test('the canvas follows the pointer during the drag', () => {
	const dom = boot();
	handle(dom).dispatch('mousedown', { clientX: 100, clientY: 100 });
	dom.docDispatch('mousemove', { clientX: 240, clientY: 190 });

	const canvas = dom.el('form-canvas');
	assert.equal(canvas.style.width, '940px');
	assert.equal(canvas.style.height, '690px');
	dom.docDispatch('mouseup', {});
});

test('a click that never moves changes nothing', () => {
	const dom = boot();
	handle(dom).dispatch('mousedown', { clientX: 100, clientY: 100 });
	dom.docDispatch('mousemove', { clientX: 101, clientY: 100 });
	dom.docDispatch('mouseup', {});

	assert.equal(dom.posted.filter((m) => m.type === 'apply').length, 0);
});

test('the form cannot be dragged smaller than its minimum', () => {
	const dom = boot();
	drag(dom, -5000, -5000);

	const applies = dom.posted.filter((m) => m.type === 'apply');
	assert.deepEqual(applies[0].ops, [{ op: 'setForm', id: '', w: 100, h: 80 }]);
});

test('the drag listeners are removed when the mouse is released', () => {
	const dom = boot();
	drag(dom, 40, 40);

	assert.equal(dom.docListenerCount('mousemove'), 0, 'mousemove listener left behind');
	assert.equal(dom.docListenerCount('mouseup'), 0, 'mouseup listener left behind');
});

test('resizing the form again after a model refresh still works', () => {
	// Every edit answers with a fresh model and a re-render. If that rebuilt
	// the canvas, the handle a later drag grabs would be a detached element
	// whose listener no longer reaches the live one.
	const dom = boot();
	drag(dom, 100, 50);
	dom.send({
		type: 'model',
		model: {
			package: 'mainform',
			receiverType: 'MainForm',
			recvVar: 'mf',
			formTitle: 'Test',
			formWidth: 900,
			formHeight: 650,
			controls: [{ id: 'btn1', type: 'Button', parent: '', x: 10, y: 10, w: 90, h: 30, supported: true }],
			radioGroups: [],
			structRange: { start: 0, end: 0 },
			initRange: { start: 0, end: 0 },
		},
	});
	drag(dom, 100, 50);

	const applies = dom.posted.filter((m) => m.type === 'apply');
	assert.equal(applies.length, 2, 'the second drag did not reach the extension host');
	assert.deepEqual(applies[1].ops, [{ op: 'setForm', id: '', w: 1000, h: 700 }]);
});

// ---------------------------------------------------------------------------
// The form's properties panel
// ---------------------------------------------------------------------------

/** formPanel returns the rows of the properties panel with nothing selected. */
function formPanel(dom) {
	return dom.el('properties-panel').descendants;
}

function rowInput(dom, label) {
	const rows = formPanel(dom).filter((e) => e.className === 'prop-row');
	const row = rows.find((r) => r.children.some((c) => c.textContent === label));
	assert.ok(row, `no "${label}" row in the form panel`);
	const input = row.children.find((c) => c.tagName === 'INPUT');
	assert.ok(input, `the "${label}" row has no input`);
	return input;
}

test('with nothing selected the panel shows the form, not a prompt', () => {
	const dom = boot();
	const text = formPanel(dom).map((e) => e.textContent).join(' | ');
	assert.match(text, /Form · MainForm/);
	assert.match(text, /Width/);
	assert.match(text, /Height/);
	assert.match(text, /Title/);
});

test('typing a width resizes the form', () => {
	const dom = boot();
	const input = rowInput(dom, 'Width');
	input.value = '1024';
	input.dispatch('change', {});

	const applies = dom.posted.filter((m) => m.type === 'apply');
	assert.equal(applies.length, 1);
	assert.deepEqual(applies[0].ops, [{ op: 'setForm', id: '', w: 1024, h: 600, text: '' }]);
});

test('typing a height keeps the width it did not touch', () => {
	const dom = boot();
	const input = rowInput(dom, 'Height');
	input.value = '480';
	input.dispatch('change', {});

	const applies = dom.posted.filter((m) => m.type === 'apply');
	assert.deepEqual(applies[0].ops, [{ op: 'setForm', id: '', w: 800, h: 480, text: '' }]);
});

test('a width below the minimum is refused and the field reverts', () => {
	const dom = boot();
	const input = rowInput(dom, 'Width');
	input.value = '10';
	input.dispatch('change', {});

	assert.equal(dom.posted.filter((m) => m.type === 'apply').length, 0);
	assert.equal(input.value, '800');
});

test('editing the title sends it with the size unchanged', () => {
	const dom = boot();
	const input = rowInput(dom, 'Title');
	input.value = 'Invoices';
	input.dispatch('change', {});

	const applies = dom.posted.filter((m) => m.type === 'apply');
	assert.deepEqual(applies[0].ops, [{ op: 'setForm', id: '', w: 800, h: 600, text: 'Invoices' }]);
});

test('an unchanged title sends nothing', () => {
	const dom = boot();
	const input = rowInput(dom, 'Title');
	input.dispatch('change', {});

	assert.equal(dom.posted.filter((m) => m.type === 'apply').length, 0);
});
