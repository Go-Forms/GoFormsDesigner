// Checks the canvas diff, and measures what it saves.
//
// media/renderPlan.js decides how much of the canvas an edit has to touch.
// The designer used to rebuild all of it for every action, so the number that
// matters is plan.touched: how many controls a typical edit actually changes.
// The last test in this file pins that down on a form the size of a real one,
// which is the "before and after" measurement the work was for.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');

require('../media/renderPlan.js');
const RP = globalThis.GoFormsRenderPlan;

/** control builds a ControlSpec-shaped object with sane defaults. */
function control(id, over) {
	return Object.assign(
		{ id, type: 'Button', parent: '', x: 0, y: 0, w: 90, h: 30, supported: true },
		over
	);
}

/** form builds n plain buttons laid out down the form. */
function form(n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push(control('btn' + i, { x: 20, y: 20 + i * 40 }));
	}
	return out;
}

const digest = (specs) => RP.digestAll(specs);
const plan = (before, after) => RP.computeRenderPlan(digest(before), digest(after));

test('an unchanged model is a no-op', () => {
	const specs = form(10);
	const p = plan(specs, specs.map((s) => Object.assign({}, s)));
	assert.equal(p.touched, 0);
	assert.deepEqual(p.reorder, []);
	assert.ok(RP.isNoop(p));
});

test('moving one control touches only that control', () => {
	const before = form(10);
	const after = before.map((s) => Object.assign({}, s));
	after[4].x = 120;

	const p = plan(before, after);
	assert.deepEqual(p.bounds, ['btn4']);
	assert.deepEqual(p.content, []);
	assert.deepEqual(p.create, []);
	assert.deepEqual(p.remove, []);
	// Position is not part of the child list, so nothing has to be re-inserted.
	assert.deepEqual(p.reorder, []);
	assert.equal(p.touched, 1);
});

test('a resize redraws content as well as bounds', () => {
	// Several renderers lay out their own insides from w/h, so a resize that
	// only restyled the box would leave stale contents behind.
	const before = [control('grid1', { type: 'DataGridView', w: 300, h: 200 })];
	const after = [control('grid1', { type: 'DataGridView', w: 500, h: 200 })];

	const p = plan(before, after);
	assert.deepEqual(p.bounds, ['grid1']);
	assert.deepEqual(p.content, ['grid1']);
	assert.equal(p.touched, 1);
});

test('editing a property redraws only that control', () => {
	const before = form(10);
	const after = before.map((s) => Object.assign({}, s));
	after[2].text = 'Save';

	const p = plan(before, after);
	assert.deepEqual(p.content, ['btn2']);
	assert.deepEqual(p.bounds, []);
	assert.equal(p.touched, 1);
});

test('adding a control creates one element and reorders its container', () => {
	const before = form(5);
	const after = before.concat([control('btnNew', { x: 200, y: 20 })]);

	const p = plan(before, after);
	assert.deepEqual(p.create, ['btnNew']);
	assert.deepEqual(p.remove, []);
	assert.deepEqual(p.reorder, ['']); // the form's own child list changed
	assert.equal(p.touched, 1);
});

test('removing a control is reported even though it is in neither list', () => {
	const before = form(5);
	const after = before.slice(0, 4);

	const p = plan(before, after);
	assert.deepEqual(p.remove, ['btn4']);
	assert.deepEqual(p.create, []);
	assert.deepEqual(p.reorder, ['']);
	assert.equal(p.touched, 0); // nothing surviving had to change
	assert.ok(!RP.isNoop(p));
});

test('reparenting is a move, and reorders both containers', () => {
	const before = [
		control('pnl1', { type: 'Panel', w: 200, h: 150 }),
		control('btn1', { x: 10, y: 10 }),
	];
	const after = [
		control('pnl1', { type: 'Panel', w: 200, h: 150 }),
		control('btn1', { x: 10, y: 10, parent: 'pnl1' }),
	];

	const p = plan(before, after);
	assert.deepEqual(p.move, ['btn1']);
	assert.deepEqual(p.bounds, []);
	assert.deepEqual(p.content, []);
	assert.deepEqual(p.reorder.sort(), ['', 'pnl1']);
});

test('a slot counts as its own container', () => {
	const before = [
		control('split1', { type: 'SplitContainer', w: 400, h: 250 }),
		control('btn1', { parent: 'split1', parentSlot: 'Panel1' }),
	];
	const after = [
		control('split1', { type: 'SplitContainer', w: 400, h: 250 }),
		control('btn1', { parent: 'split1', parentSlot: 'Panel2' }),
	];

	const p = plan(before, after);
	assert.deepEqual(p.move, ['btn1']);
	assert.deepEqual(p.reorder.sort(), ['split1/Panel1', 'split1/Panel2']);
});

test('swapping two controls reorders without touching either', () => {
	const before = form(4);
	const after = [before[0], before[2], before[1], before[3]].map((s) => Object.assign({}, s));

	const p = plan(before, after);
	assert.equal(p.touched, 0); // nothing about either control changed
	assert.deepEqual(p.reorder, ['']); // but z-order did
});

test('a control that becomes unsupported is rebuilt, not patched', () => {
	// Supported and unsupported controls are drawn by different code paths,
	// so patching one into the other would leave the wrong element behind.
	const before = [control('mystery1', { supported: true })];
	const after = [control('mystery1', { supported: false })];

	const p = plan(before, after);
	assert.deepEqual(p.rebuild, ['mystery1']);
	assert.deepEqual(p.content, []);
});

test('switching the designed tab redraws only that container', () => {
	const specs = [
		control('tabs1', { type: 'TabControl', w: 400, h: 300, collection: [{ text: 'A' }, { text: 'B' }] }),
		control('btn1', { parent: 'tabs1', parentSlot: 'Tab1' }),
	];
	const before = RP.digestAll(specs, () => 0);
	const after = RP.digestAll(specs, (id) => (id === 'tabs1' ? 1 : 0));

	const p = RP.computeRenderPlan(before, after);
	assert.deepEqual(p.content, ['tabs1']);
	assert.equal(p.touched, 1);
});

// The measurement the whole exercise was for. Before this diff every one of
// these actions rebuilt all 30 controls; the plan is what the canvas now does
// instead.
test('measured: a realistic form costs one control per edit, not thirty', () => {
	const SIZE = 30;
	const before = form(SIZE);

	const dragged = before.map((s) => Object.assign({}, s));
	dragged[7].x += 4; // one mouse drag
	const drag = plan(before, dragged);

	const retitled = before.map((s) => Object.assign({}, s));
	retitled[7].text = 'Apply'; // one property edit
	const edit = plan(before, retitled);

	assert.equal(drag.touched, 1, 'a drag should restyle one control');
	assert.equal(edit.touched, 1, 'a property edit should redraw one control');
	assert.equal(drag.touched / SIZE <= 1 / 30, true);

	// And the refresh that arrives after every apply, when the user's own
	// change has already been drawn, costs nothing at all.
	const echo = plan(before, before.map((s) => Object.assign({}, s)));
	assert.ok(RP.isNoop(echo), 'a redundant refresh should do no DOM work');
});
