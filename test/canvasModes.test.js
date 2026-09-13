// Zoom, Lock Controls and Tab Order.
//
// Zoom is the one with a real trap in it: the canvas is scaled with a CSS
// transform, so every mouse delta arrives in screen pixels while the model is
// in form pixels. Miss the conversion in any one of the four places that do
// it and controls run away from the cursor at every zoom but 100% - which
// looks like a physics bug and is arithmetic. So the drag is checked at a
// scale, not just at 1.
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
		Setters: { SetText: 'text', SetTabIndex: 'tabIndex' },
		Kinds: { tabIndex: 'number' },
		Events: ['Click'],
		EventArgs: { Click: 'MouseEventArgs' },
		OwnEventCount: 0,
	},
};

function model(controls, size) {
	return {
		package: 'mainform',
		receiverType: 'MainForm',
		recvVar: 'mf',
		formTitle: 'Test',
		formWidth: (size && size.w) || 800,
		formHeight: (size && size.h) || 600,
		controls,
		radioGroups: [],
		structRange: { start: 0, end: 0 },
		initRange: { start: 0, end: 0 },
	};
}

const button = (id, over) =>
	Object.assign({ id, type: 'Button', parent: '', x: 100, y: 100, w: 90, h: 30, text: id, supported: true }, over);

function boot(controls, size) {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'designer.js');
	for (const dep of ['../media/gridLayout.js', '../media/renderPlan.js', '../media/dockLayout.js']) {
		delete require.cache[require.resolve(dep)];
		require(dep);
	}
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'init', model: model(controls, size), catalog, categories: ['Common Controls'] });
	return dom;
}

const ctrl = (dom, id) => dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === id);

/** drag presses on a control, moves by the given screen pixels and releases. */
function drag(dom, id, screenDX, screenDY) {
	const el = ctrl(dom, id);
	assert.ok(el, `no element for ${id}`);
	el.dispatch('mousedown', { clientX: 0, clientY: 0 });
	dom.docDispatch('mousemove', { clientX: screenDX, clientY: screenDY });
	dom.docDispatch('mouseup', { clientX: screenDX, clientY: screenDY });
	return el;
}

function setZoom(dom, value) {
	const sel = dom.el('zoom-select');
	sel.value = value;
	sel.dispatch('change', {});
}

// --- zoom ---------------------------------------------------------------

test('zoom scales the canvas without touching the model', () => {
	const dom = boot([button('btn1')]);
	setZoom(dom, '2');

	const canvas = dom.el('form-canvas');
	assert.strictEqual(canvas.style.transform, 'scale(2)');
	assert.strictEqual(canvas.style.transformOrigin, 'top left');
	// The canvas keeps its unscaled layout size, so the scroll area needs
	// the difference as margin or a zoomed-in form is clipped.
	assert.strictEqual(canvas.style.marginRight, '800px');
	assert.strictEqual(canvas.style.marginBottom, '600px');

	// Nothing was sent: zoom is a view setting.
	assert.deepStrictEqual(dom.posted.filter((m) => m.type === 'apply'), []);
});

test('a drag at 200% moves the control half as far as the mouse', () => {
	const dom = boot([button('btn1')]);
	setZoom(dom, '2');
	drag(dom, 'btn1', 100, 60);

	const op = dom.posted.at(-1).ops[0];
	assert.strictEqual(op.op, 'setBounds');
	// 100 screen pixels at 2x is 50 form pixels, from x=100.
	assert.deepStrictEqual({ x: op.x, y: op.y }, { x: 150, y: 130 });
});

test('a drag at 50% moves the control twice as far as the mouse', () => {
	const dom = boot([button('btn1')]);
	setZoom(dom, '0.5');
	drag(dom, 'btn1', 25, 10);

	const op = dom.posted.at(-1).ops[0];
	assert.deepStrictEqual({ x: op.x, y: op.y }, { x: 150, y: 120 });
});

test('a drag at 100% is unchanged', () => {
	// The conversion must be a no-op at 1, or every existing layout shifts.
	const dom = boot([button('btn1')]);
	drag(dom, 'btn1', 40, 25);

	const op = dom.posted.at(-1).ops[0];
	assert.deepStrictEqual({ x: op.x, y: op.y }, { x: 140, y: 125 });
});

test('returning to 100% clears the transform rather than scaling by one', () => {
	const dom = boot([button('btn1')]);
	setZoom(dom, '1.5');
	setZoom(dom, '1');
	const canvas = dom.el('form-canvas');
	assert.strictEqual(canvas.style.transform, '');
	assert.strictEqual(canvas.style.marginRight, '');
});

// --- lock ---------------------------------------------------------------

test('Lock Controls still selects but does not move', () => {
	const dom = boot([button('btn1')]);
	dom.el('lock-toggle').dispatch('click', {});
	assert.strictEqual(dom.el('lock-toggle').getAttribute('aria-pressed'), 'true');
	assert.ok(dom.el('form-canvas').className.includes('locked'));

	dom.posted.length = 0;
	drag(dom, 'btn1', 60, 60);
	assert.deepStrictEqual(
		dom.posted.filter((m) => m.type === 'apply'),
		[],
		'a locked control was moved'
	);
	// The click still picked it: inspecting a finished layout is the point.
	assert.ok(ctrl(dom, 'btn1').className.includes('selected'), 'a locked control could not be selected');
});

test('unlocking restores dragging', () => {
	const dom = boot([button('btn1')]);
	dom.el('lock-toggle').dispatch('click', {});
	dom.el('lock-toggle').dispatch('click', {});
	assert.ok(!dom.el('form-canvas').className.includes('locked'));

	dom.posted.length = 0;
	drag(dom, 'btn1', 30, 0);
	assert.strictEqual(dom.posted.at(-1).ops[0].x, 130);
});

// --- tab order ----------------------------------------------------------

test('tab order mode shows each control its index', () => {
	const dom = boot([button('btn1', { props: { tabIndex: '2' } }), button('btn2', { y: 200 })]);
	dom.el('taborder-toggle').dispatch('click', {});

	const badges = dom.el('form-canvas').querySelectorAll('.tab-badge').map((b) => b.textContent);
	assert.deepStrictEqual(badges, ['2', '–'], 'a control with no tab index should say so, not show 0');
});

test('clicking in tab order mode assigns the next index instead of selecting', () => {
	const dom = boot([button('btn1', { props: { tabIndex: '4' } }), button('btn2', { y: 200 })]);
	dom.el('taborder-toggle').dispatch('click', {});
	dom.posted.length = 0;

	ctrl(dom, 'btn2').dispatch('mousedown', { clientX: 0, clientY: 0 });
	const op = dom.posted.at(-1).ops[0];
	assert.deepStrictEqual(op, { op: 'setProp', id: 'btn2', prop: 'tabIndex', value: '5' });
	assert.ok(!ctrl(dom, 'btn2').className.includes('selected'), 'the click selected instead of numbering');
});

test('the first control numbered in an empty form starts at zero', () => {
	const dom = boot([button('btn1')]);
	dom.el('taborder-toggle').dispatch('click', {});
	dom.posted.length = 0;

	ctrl(dom, 'btn1').dispatch('mousedown', { clientX: 0, clientY: 0 });
	assert.strictEqual(dom.posted.at(-1).ops[0].value, '0');
});

test('leaving tab order mode takes the badges away', () => {
	const dom = boot([button('btn1')]);
	dom.el('taborder-toggle').dispatch('click', {});
	assert.strictEqual(dom.el('form-canvas').querySelectorAll('.tab-badge').length, 1);
	dom.el('taborder-toggle').dispatch('click', {});
	assert.strictEqual(dom.el('form-canvas').querySelectorAll('.tab-badge').length, 0);
});

test('tab order mode does not drag', () => {
	const dom = boot([button('btn1')]);
	dom.el('taborder-toggle').dispatch('click', {});
	dom.posted.length = 0;
	drag(dom, 'btn1', 50, 50);

	const ops = dom.posted.flatMap((m) => m.ops || []);
	assert.ok(!ops.some((o) => o.op === 'setBounds'), 'a control moved while numbering the tab order');
});
