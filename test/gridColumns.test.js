// The column editor and the canvas's view of a grid's columns.
//
// Columns are the one list whose entries carry more than a caption: a kind
// (text, button, checkbox) and whether the column is drawn at all. Both have
// to reach the file through one setColumns op, and the canvas has to show
// what the running form will show - a hidden column is absent from both.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

const { install } = require('../testlib/domShim');

const catalog = {
	DataGridView: {
		Type: 'DataGridView',
		Category: 'Data',
		DefaultW: 400,
		DefaultH: 200,
		IsContainer: false,
		Setters: {},
		Kinds: {},
		Events: ['CellClick', 'CellButtonClick'],
		EventArgs: { CellClick: 'GridCellEventArgs', CellButtonClick: 'GridCellEventArgs' },
		OwnEventCount: 2,
	},
};

function model(controls) {
	return {
		path: '/tmp/MainForm-designer.go',
		receiverType: 'MainForm',
		recvVar: 'mf',
		formTitle: 'test',
		formWidth: 800,
		formHeight: 600,
		controls,
		radioGroups: [],
		structRange: { start: 0, end: 0 },
		initRange: { start: 0, end: 0 },
	};
}

const gridSpec = (over) =>
	Object.assign(
		{
			id: 'grd1',
			type: 'DataGridView',
			parent: '',
			x: 10,
			y: 10,
			w: 400,
			h: 200,
			items: ['ID', 'Customer', 'Action'],
			supported: true,
		},
		over
	);

function boot(controls) {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'designer.js');
	for (const dep of ['../media/gridLayout.js', '../media/renderPlan.js', '../media/dockLayout.js']) {
		delete require.cache[require.resolve(dep)];
		require(dep);
	}
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'init', model: model(controls), catalog, categories: ['Data'] });
	return dom;
}

function clickControl(dom, id) {
	const el = dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === id);
	assert.ok(el, `no canvas element for ${id}`);
	el.dispatch('mousedown', { clientX: 0, clientY: 0 });
	return el;
}

/** lastApply returns the ops of the most recent apply message. */
function lastApply(dom) {
	const msgs = dom.posted.filter((m) => m.type === 'apply');
	assert.ok(msgs.length, 'no apply was posted');
	return msgs[msgs.length - 1].ops;
}

function panelRows(dom) {
	return dom.el('properties-panel').descendants.filter((e) => e.className === 'coll-row');
}

// --- the editor ---------------------------------------------------------

test('a grid with no explicit columns still lists its titles', () => {
	const dom = boot([gridSpec()]);
	clickControl(dom, 'grd1');

	const rows = panelRows(dom);
	assert.equal(rows.length, 3, 'one row per column title');
	const kinds = dom.el('properties-panel').descendants.filter((e) => e.className === 'coll-kind');
	assert.equal(kinds.length, 3, 'every column gets a kind picker');
});

test('changing a column kind sends the whole table as one setColumns', () => {
	const dom = boot([gridSpec()]);
	clickControl(dom, 'grd1');

	const kinds = dom.el('properties-panel').descendants.filter((e) => e.className === 'coll-kind');
	kinds[2].value = 'Button';
	kinds[2].dispatch('change');

	const ops = lastApply(dom);
	assert.equal(ops.length, 1);
	assert.equal(ops[0].op, 'setColumns');
	assert.equal(ops[0].id, 'grd1');
	assert.equal(ops[0].columns.length, 3, 'the whole table is sent, not just the edit');
	assert.equal(ops[0].columns[2].kind, 'Button');
	assert.equal(ops[0].columns[0].kind, undefined, 'untouched columns stay text');
});

test('hiding a column is a toggle that reaches the op', () => {
	const dom = boot([gridSpec()]);
	clickControl(dom, 'grd1');

	const rows = panelRows(dom);
	const eye = rows[0].descendants.find((e) => e.className === 'coll-btn' && e.textContent === '👁');
	assert.ok(eye, 'no visibility toggle on the first column');
	eye.dispatch('click');

	const cols = lastApply(dom)[0].columns;
	assert.equal(cols[0].hidden, true);
	assert.equal(cols[1].hidden, undefined);
});

test('a caption field appears only for a button column', () => {
	const plain = boot([gridSpec()]);
	clickControl(plain, 'grd1');
	assert.equal(
		plain.el('properties-panel').descendants.filter((e) => e.className === 'coll-handler').length,
		0,
		'a text column should not offer a button caption'
	);

	const withButton = boot([gridSpec({ columns: [{ title: 'Action', kind: 'Button', buttonText: 'Assign' }] })]);
	clickControl(withButton, 'grd1');
	const captions = withButton.el('properties-panel').descendants.filter((e) => e.className === 'coll-handler');
	assert.equal(captions.length, 1);
	assert.equal(captions[0].value, 'Assign');
});

test('switching away from Button drops the caption it cannot show', () => {
	const dom = boot([gridSpec({ columns: [{ title: 'Action', kind: 'Button', buttonText: 'Assign' }] })]);
	clickControl(dom, 'grd1');

	const kind = dom.el('properties-panel').descendants.find((e) => e.className === 'coll-kind');
	kind.value = 'CheckBox';
	kind.dispatch('change');

	const cols = lastApply(dom)[0].columns;
	assert.equal(cols[0].kind, 'CheckBox');
	assert.equal(cols[0].buttonText, undefined, 'a stale caption would write a line the grid ignores');
});

test('adding a column appends to the table', () => {
	const dom = boot([gridSpec()]);
	clickControl(dom, 'grd1');

	const add = dom.el('properties-panel').descendants.find((e) => e.className === 'coll-add');
	assert.ok(add, 'no add button');
	add.dispatch('click');

	const cols = lastApply(dom)[0].columns;
	assert.equal(cols.length, 4);
	assert.equal(cols[3].title, 'Column 4');
});

test('the last column cannot be deleted', () => {
	const dom = boot([gridSpec({ items: ['Only'], columns: [{ title: 'Only' }] })]);
	clickControl(dom, 'grd1');

	const del = dom.el('properties-panel').descendants.find((e) => e.className === 'coll-btn' && e.textContent === '⌫');
	del.dispatch('click');
	assert.equal(
		dom.posted.filter((m) => m.type === 'apply').length,
		0,
		'a grid with no columns draws as an empty box, so the last one stays'
	);
});

// --- the canvas ---------------------------------------------------------

function gridCells(dom) {
	return dom
		.el('form-canvas')
		.descendants.filter((e) => String(e.className).includes('cc-grid-cell'));
}

test('a hidden column is not drawn on the canvas', () => {
	const shown = boot([gridSpec({ columns: [{ title: 'ID' }, { title: 'Customer' }, { title: 'Action' }] })]);
	const headersOf = (dom) =>
		dom.el('form-canvas').descendants.filter((e) => String(e.className).includes('cc-grid-headcell'));
	assert.deepEqual(headersOf(shown).map((e) => e.textContent), ['ID', 'Customer', 'Action']);

	const hidden = boot([
		gridSpec({ columns: [{ title: 'ID', hidden: true }, { title: 'Customer' }, { title: 'Action' }] }),
	]);
	assert.deepEqual(
		headersOf(hidden).map((e) => e.textContent),
		['Customer', 'Action'],
		'the preview must show what the running form shows'
	);
});

test('a hidden column does not shift the cells of the ones after it', () => {
	const dom = boot([
		gridSpec({
			columns: [{ title: 'ID', hidden: true }, { title: 'Customer' }, { title: 'Action' }],
			rows: [['17', 'Ada', 'Run']],
		}),
	]);
	const texts = gridCells(dom)
		.filter((e) => !String(e.className).includes('headcell'))
		.map((e) => e.textContent);
	assert.deepEqual(texts, ['Ada', 'Run'], 'row data is indexed by column, not by drawn position');
});

test('a button column draws buttons, a checkbox column draws ticks', () => {
	const dom = boot([
		gridSpec({
			columns: [
				{ title: 'Customer' },
				{ title: 'Active', kind: 'CheckBox' },
				{ title: 'Action', kind: 'Button', buttonText: 'Assign' },
			],
			rows: [['Ada', 'true', 'ignored']],
		}),
	]);
	const btns = dom.el('form-canvas').descendants.filter((e) => e.className === 'cc-grid-cellbtn');
	assert.equal(btns.length, 1);
	assert.equal(btns[0].textContent, 'Assign', 'a fixed caption wins over the cell value');

	const checks = gridCells(dom).filter((e) => String(e.className).includes('cc-grid-cellcheck'));
	assert.equal(checks.length, 1);
	assert.equal(checks[0].textContent, '☑', '"true" should draw as ticked');
});

test('a button column with no caption falls back to the cell value', () => {
	const dom = boot([
		gridSpec({
			columns: [{ title: 'Customer' }, { title: 'Action', kind: 'Button' }],
			rows: [['Ada', 'Approve']],
		}),
	]);
	const btns = dom.el('form-canvas').descendants.filter((e) => e.className === 'cc-grid-cellbtn');
	assert.equal(btns.length, 1);
	assert.equal(btns[0].textContent, 'Approve');
});
