// The designer features ported from the NetForms designer, exercised
// against the real webview client and a stub DOM: the clipboard, z-order,
// the keys, double-click, the context menu, smart tags, the outline, the
// selection rectangle, the visual property editors, and tables and flows
// laid out by cell and by order.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('node:path');

const { install } = require('../testlib/domShim');

const base = {
	Setters: { SetAnchor: 'anchor', SetDock: 'dock', SetVisible: 'visible', SetForeColor: 'foreColor', SetFont: 'font', SetPadding: 'padding' },
	Kinds: { anchor: 'flags', dock: 'enum', visible: 'bool', foreColor: 'color', font: 'font', padding: 'padding' },
	Enums: {
		anchor: ['AnchorTop', 'AnchorBottom', 'AnchorLeft', 'AnchorRight'],
		dock: ['DockNone', 'DockTop', 'DockBottom', 'DockLeft', 'DockRight', 'DockFill'],
	},
};
const desc = (over) =>
	Object.assign(
		{ Category: 'Common Controls', DefaultW: 90, DefaultH: 30, IsContainer: false, Events: ['Click'], EventArgs: { Click: 'MouseEventArgs' }, OwnEventCount: 0 },
		JSON.parse(JSON.stringify(base)),
		over
	);
const catalog = {
	Button: desc({ Type: 'Button', Setters: Object.assign({ SetText: 'text' }, base.Setters), Descriptions: { anchor: 'The edges it keeps.' } }),
	TextBox: desc({ Type: 'TextBox', Setters: Object.assign({ SetText: 'text' }, base.Setters), Events: ['TextChanged', 'Click'], OwnEventCount: 1, EventArgs: { TextChanged: 'EventArgs', Click: 'MouseEventArgs' } }),
	Panel: desc({ Type: 'Panel', IsContainer: true }),
	FlowLayoutPanel: desc({ Type: 'FlowLayoutPanel', IsContainer: true }),
	TableLayoutPanel: desc({ Type: 'TableLayoutPanel', IsContainer: true }),
	SplitContainer: desc({ Type: 'SplitContainer', Slots: ['Panel1', 'Panel2'], Setters: Object.assign({ SetSplitterDistance: 'splitterDistance' }, base.Setters) }),
	TabControl: desc({ Type: 'TabControl', Collection: { Label: 'Tabs', Method: 'AddTab', ItemSlot: 'Tab', ItemsAccessor: 'TabPages' } }),
	Form: { Type: 'Form', Setters: {}, Events: ['Load', 'Click'], OwnEventCount: 1, EventArgs: { Load: 'EventArgs' } },
};

function model(controls, extra) {
	return Object.assign(
		{ package: 'mainform', receiverType: 'MainForm', recvVar: 'mf', formTitle: 'Test', formWidth: 800, formHeight: 600, controls, radioGroups: [], structRange: { start: 0, end: 0 }, initRange: { start: 0, end: 0 } },
		extra
	);
}

const ctl = (id, type, over) => Object.assign({ id, type, parent: '', x: 10, y: 10, w: 90, h: 30, text: id, supported: true, props: {}, events: {} }, over);

function boot(controls, extra) {
	const dom = install();
	const file = path.join(__dirname, '..', 'media', 'designer.js');
	for (const dep of ['../media/gridLayout.js', '../media/renderPlan.js', '../media/dockLayout.js', '../media/panelLayout.js', '../media/geometry.js']) {
		delete require.cache[require.resolve(dep)];
		require(dep);
	}
	delete require.cache[require.resolve(file)];
	require(file);
	dom.send({ type: 'init', model: model(controls, extra), catalog, categories: ['Common Controls'] });
	return dom;
}

const el = (dom, id) => dom.el('form-canvas').querySelectorAll('.ctrl').find((e) => e.dataset.id === id);
const click = (dom, id, ev) => el(dom, id).dispatch('mousedown', Object.assign({ clientX: 0, clientY: 0 }, ev));
const applied = (dom) => dom.posted.filter((m) => m.type === 'apply');
const lastOps = (dom) => {
	const a = applied(dom);
	return a.length ? a[a.length - 1].ops : [];
};

// --- the clipboard -------------------------------------------------------

test('Ctrl+C sends the selected control and what stands on it', () => {
	const dom = boot([ctl('pnl', 'Panel', { w: 200, h: 100 }), ctl('btn', 'Button', { parent: 'pnl' }), ctl('other', 'Button')]);
	click(dom, 'pnl');
	dom.keydown({ key: 'c', ctrlKey: true, target: dom.document.body });
	const copy = dom.posted.find((m) => m.type === 'copy');
	assert.ok(copy, 'nothing was copied');
	assert.deepEqual(copy.data.roots, ['pnl']);
	assert.deepEqual(copy.data.controls.map((c) => c.id), ['pnl', 'btn']);
});

test('a paste in the same form renames, offsets and keeps the handlers', () => {
	const btn = ctl('btn', 'Button', { events: { Click: 'btn_Click' }, props: { anchor: 'AnchorTop' } });
	const dom = boot([btn]);
	dom.send({ type: 'pasteData', sameForm: true, data: { roots: ['btn'], controls: [btn] } });
	const add = lastOps(dom).find((o) => o.op === 'add');
	assert.equal(add.id, 'button1');
	assert.equal(add.x, 18);
	assert.equal(add.y, 18);
	assert.deepEqual(add.events, { Click: 'btn_Click' });
	assert.deepEqual(add.props, { anchor: 'AnchorTop' });
	assert.ok(lastOps(dom).some((o) => o.op === 'setText' && o.id === 'button1' && o.text === 'btn'));
});

test('a paste into another form drops the event wirings', () => {
	const btn = ctl('btn', 'Button', { events: { Click: 'btn_Click' } });
	const dom = boot([]);
	dom.send({ type: 'pasteData', sameForm: false, data: { roots: ['btn'], controls: [btn] } });
	const add = lastOps(dom).find((o) => o.op === 'add');
	assert.equal(add.id, 'btn', 'a free name is kept');
	assert.equal(add.events, undefined);
	assert.equal(add.x, 10, 'nothing there, so no offset');
});

test('a pasted container brings its children under their new parent', () => {
	const pnl = ctl('pnl', 'Panel', { w: 200, h: 100 });
	const child = ctl('btn', 'Button', { parent: 'pnl' });
	const dom = boot([pnl, child]);
	dom.send({ type: 'pasteData', sameForm: true, data: { roots: ['pnl'], controls: [pnl, child] } });
	const adds = lastOps(dom).filter((o) => o.op === 'add');
	assert.deepEqual(adds.map((a) => [a.id, a.parent]), [['panel1', ''], ['button1', 'panel1']]);
});

test('Ctrl+D duplicates without the clipboard', () => {
	const dom = boot([ctl('btn', 'Button')]);
	click(dom, 'btn');
	dom.keydown({ key: 'd', ctrlKey: true, target: dom.document.body });
	assert.ok(!dom.posted.some((m) => m.type === 'copy'));
	assert.equal(lastOps(dom)[0].op, 'add');
});

test('Ctrl+V asks the extension for the clipboard', () => {
	const dom = boot([]);
	dom.keydown({ key: 'v', ctrlKey: true, target: dom.document.body });
	assert.ok(dom.posted.some((m) => m.type === 'paste'));
});

test('clipboard keys in a property field are the field\'s', () => {
	const dom = boot([ctl('btn', 'Button')]);
	click(dom, 'btn');
	const input = dom.el('properties-panel').descendants.find((e) => e.tagName === 'INPUT');
	dom.keydown({ key: 'c', ctrlKey: true, target: input });
	assert.ok(!dom.posted.some((m) => m.type === 'copy'));
});

// --- z-order, keys --------------------------------------------------------

test('Bring to Front moves a control to the end of its container', () => {
	const dom = boot([ctl('a', 'Button'), ctl('b', 'Button'), ctl('c', 'Button')]);
	click(dom, 'a');
	el(dom, 'a').dispatch('contextmenu', { clientX: 5, clientY: 5 });
	const item = dom.document.body.descendants.find((e) => e.className === 'ctx-item' && e.textContent.startsWith('Bring to Front'));
	assert.ok(item, 'no Bring to Front in the menu');
	item.dispatch('mousedown', {});
	assert.deepEqual(lastOps(dom), [{ op: 'reorder', id: '', parentSlot: '', order: ['b', 'c', 'a'] }]);
	assert.equal(dom.document.querySelectorAll('.ctx-menu').length, 0, 'the menu stays open');
});

test('the arrows nudge, Ctrl by eight, Shift resizes', () => {
	const dom = boot([ctl('a', 'Button')]);
	click(dom, 'a');
	dom.keydown({ key: 'ArrowRight', target: dom.document.body });
	assert.deepEqual(lastOps(dom), [{ op: 'setBounds', id: 'a', x: 11, y: 10, w: 90, h: 30 }]);
	dom.keydown({ key: 'ArrowDown', ctrlKey: true, target: dom.document.body });
	assert.deepEqual(lastOps(dom), [{ op: 'setBounds', id: 'a', x: 10, y: 18, w: 90, h: 30 }]);
	dom.keydown({ key: 'ArrowLeft', shiftKey: true, target: dom.document.body });
	assert.deepEqual(lastOps(dom), [{ op: 'setBounds', id: 'a', x: 10, y: 10, w: 89, h: 30 }]);
});

test('in a flow the arrows change the order', () => {
	const dom = boot([ctl('flow', 'FlowLayoutPanel', { w: 300, h: 100 }), ctl('a', 'Button', { parent: 'flow' }), ctl('b', 'Button', { parent: 'flow' })]);
	click(dom, 'a');
	dom.keydown({ key: 'ArrowRight', target: dom.document.body });
	assert.deepEqual(lastOps(dom), [{ op: 'reorder', id: 'flow', order: ['b', 'a'] }]);
});

test('Escape goes to the container, then the form', () => {
	const dom = boot([ctl('pnl', 'Panel', { w: 200, h: 100 }), ctl('btn', 'Button', { parent: 'pnl' })]);
	click(dom, 'btn');
	dom.keydown({ key: 'Escape', target: dom.document.body });
	const text = () => dom.el('properties-panel').descendants.map((e) => e.textContent).join('|');
	assert.match(text(), /Panel · pnl/);
	dom.keydown({ key: 'Escape', target: dom.document.body });
	assert.match(text(), /Form · MainForm/);
});

test('double-clicking a control wires its default event and opens it', () => {
	const dom = boot([ctl('txt', 'TextBox')]);
	el(dom, 'txt').dispatch('dblclick', {});
	const wire = dom.posted.find((m) => m.type === 'wireEvent');
	assert.deepEqual(wire, { type: 'wireEvent', id: 'txt', event: 'TextChanged', handler: 'txt_TextChanged', paramType: 'EventArgs', reveal: true });
});

test('double-clicking a control already wired goes to the handler', () => {
	const dom = boot([ctl('b', 'Button', { events: { Click: 'onB' } })]);
	el(dom, 'b').dispatch('dblclick', {});
	assert.ok(dom.posted.some((m) => m.type === 'gotoHandler' && m.handler === 'onB'));
});

test('double-clicking the form wires Load', () => {
	const dom = boot([]);
	const canvas = dom.el('form-canvas');
	canvas.dispatch('dblclick', { target: canvas });
	assert.ok(dom.posted.some((m) => m.type === 'wireEvent' && m.event === 'Load' && m.handler === 'MainForm_Load'));
});

// --- the property panel ---------------------------------------------------

test('a property the file sets is bold and can be reset', () => {
	const dom = boot([ctl('b', 'Button', { props: { anchor: 'AnchorTop,AnchorLeft' } })]);
	click(dom, 'b');
	const reset = dom.el('properties-panel').descendants.find((e) => e.className === 'reset-btn');
	assert.ok(reset, 'no reset button');
	reset.dispatch('click', {});
	assert.deepEqual(lastOps(dom), [{ op: 'resetProp', id: 'b', prop: 'anchor' }]);
});

test('the anchor editor toggles one side', () => {
	const dom = boot([ctl('b', 'Button', { props: { anchor: 'AnchorTop,AnchorLeft' } })]);
	click(dom, 'b');
	const right = dom.el('properties-panel').descendants.find((e) => e.dataset.side === 'Right');
	right.dispatch('click', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setProp', id: 'b', prop: 'anchor', value: 'AnchorTop,AnchorLeft,AnchorRight' }]);
});

test('the dock editor sets the place clicked', () => {
	const dom = boot([ctl('b', 'Button')]);
	click(dom, 'b');
	dom.el('properties-panel').descendants.find((e) => e.dataset.dock === 'DockFill').dispatch('click', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setProp', id: 'b', prop: 'dock', value: 'DockFill' }]);
});

test('the color palette sends the color picked', () => {
	const dom = boot([ctl('b', 'Button')]);
	click(dom, 'b');
	const row = dom.el('properties-panel').descendants.find((e) => e.dataset.prop === 'foreColor');
	row.descendants.find((e) => e.className.includes('color-swatch')).dispatch('click', {});
	row.descendants.find((e) => e.dataset.color === '#ff0000').dispatch('click', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setProp', id: 'b', prop: 'foreColor', value: '#ff0000' }]);
});

test('the font editor writes family, size and style as one value', () => {
	const dom = boot([ctl('b', 'Button', { props: { font: 'Sans, 12' } })]);
	click(dom, 'b');
	const row = dom.el('properties-panel').descendants.find((e) => e.dataset.prop === 'font');
	const bold = row.descendants.find((e) => e.dataset.style === 'Bold');
	bold.checked = true;
	bold.dispatch('change', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setProp', id: 'b', prop: 'font', value: 'Sans, 12, Bold' }]);
});

test('hovering a property shows what it does', () => {
	const dom = boot([ctl('b', 'Button')]);
	click(dom, 'b');
	dom.el('properties-panel').descendants.find((e) => e.dataset.prop === 'anchor').dispatch('mouseenter', {});
	assert.match(dom.el('prop-help').textContent, /The edges it keeps/);
});

test('spacing evens the gaps between three controls', () => {
	const dom = boot([ctl('a', 'Button', { x: 0 }), ctl('b', 'Button', { x: 100 }), ctl('c', 'Button', { x: 400 })]);
	click(dom, 'a');
	click(dom, 'b', { ctrlKey: true });
	click(dom, 'c', { ctrlKey: true });
	dom.el('properties-panel').descendants.find((e) => e.dataset.align === 'spaceX').dispatch('click', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setBounds', id: 'b', x: 200, y: 10, w: 90, h: 30 }]);
});

test('a hidden control is still drawn, marked as hidden', () => {
	const dom = boot([ctl('b', 'Button', { props: { visible: 'false' } })]);
	assert.ok(el(dom, 'b').classList.contains('is-hidden'));
});

// --- tables and flows -----------------------------------------------------

const table = (over) =>
	ctl('tbl', 'TableLayoutPanel', Object.assign({ w: 200, h: 100, tableColumns: [{ type: 'Absolute', value: 50 }, { type: 'AutoSize' }], tableRows: [{ type: 'AutoSize' }, { type: 'AutoSize' }] }, over));

test('a table\'s children are drawn in their cells', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl' }), ctl('b', 'Button', { parent: 'tbl', cell: { column: 1, row: 1 } })]);
	const a = el(dom, 'a').style, b = el(dom, 'b').style;
	assert.deepEqual([a.left, a.top, a.width, a.height], ['0px', '0px', '50px', '50px']);
	assert.deepEqual([b.left, b.top, b.width, b.height], ['50px', '50px', '150px', '50px']);
});

test('a flow\'s children are drawn one after another', () => {
	const dom = boot([
		ctl('flow', 'FlowLayoutPanel', { w: 300, h: 100, props: { spacing: '10' } }),
		ctl('a', 'Button', { parent: 'flow', x: 99, y: 99 }),
		ctl('b', 'Button', { parent: 'flow', x: 5, y: 5 }),
	]);
	assert.deepEqual([el(dom, 'a').style.left, el(dom, 'b').style.left], ['0px', '100px']);
});

test('in a table the arrows move a control to the next cell', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl', cell: { column: 0, row: 0 } })]);
	click(dom, 'a');
	dom.keydown({ key: 'ArrowDown', target: dom.document.body });
	assert.deepEqual(lastOps(dom), [{ op: 'setCell', id: 'a', cell: { column: 0, row: 1 } }]);
});

test('moving onto a taken cell swaps the two controls', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl', cell: { column: 0, row: 0 } }), ctl('b', 'Button', { parent: 'tbl', cell: { column: 1, row: 0 } })]);
	click(dom, 'a');
	dom.keydown({ key: 'ArrowRight', target: dom.document.body });
	assert.deepEqual(lastOps(dom), [
		{ op: 'setCell', id: 'b', cell: { column: 0, row: 0 } },
		{ op: 'setCell', id: 'a', cell: { column: 1, row: 0 } },
	]);
});

test('a control in a table has a Cell group', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl', cell: { column: 1, row: 0 } })]);
	click(dom, 'a');
	const row = dom.el('properties-panel').descendants.find((e) => e.dataset.prop === 'cell.row');
	const input = row.children.find((c) => c.tagName === 'INPUT');
	input.value = '1';
	input.dispatch('change', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setCell', id: 'a', cell: { column: 1, row: 1 } }]);
});

test('adding a column from the table group grows the table first', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl', cell: { column: 1, row: 0 } })]);
	click(dom, 'tbl');
	dom.el('properties-panel').descendants.find((e) => e.textContent === '+ Column').dispatch('click', {});
	const ops = lastOps(dom);
	assert.equal(ops[0].op, 'setTable');
	assert.equal(ops[0].tableColumns.length, 3);
});

test('inserting a column before a control moves the control along', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl', cell: { column: 1, row: 0 } })]);
	el(dom, 'tbl').dispatch('contextmenu', { clientX: 10, clientY: 10 });
	const item = dom.document.body.descendants.find((e) => e.className === 'ctx-item' && e.textContent.startsWith('Insert Column Before 1'));
	assert.ok(item, 'no insert column in the table menu');
	item.dispatch('mousedown', {});
	const ops = lastOps(dom);
	assert.equal(ops[0].op, 'setTable');
	assert.deepEqual(ops[1], { op: 'setCell', id: 'a', cell: { column: 2, row: 0 } });
});

test('a column with a control in it is not deleted', () => {
	const dom = boot([table(), ctl('a', 'Button', { parent: 'tbl', cell: { column: 0, row: 0 } })]);
	const before = applied(dom).length;
	el(dom, 'tbl').dispatch('contextmenu', { clientX: 10, clientY: 10 });
	dom.document.body.descendants.find((e) => e.className === 'ctx-item' && e.textContent.startsWith('Delete Column 1')).dispatch('mousedown', {});
	assert.equal(applied(dom).length, before);
});

// --- smart tags, the outline, the splitter, the selection rectangle -------

test('a selected TabControl\'s smart tag adds a tab', () => {
	const dom = boot([ctl('tabs', 'TabControl', { w: 300, h: 200, collection: [{ text: 'One' }] })]);
	click(dom, 'tabs');
	const glyph = el(dom, 'tabs').children.find((c) => c.className.startsWith('smart-glyph'));
	assert.ok(glyph, 'no smart tag on the selected control');
	glyph.dispatch('mousedown', {});
	const link = dom.document.body.descendants.find((e) => e.className === 'smart-link' && e.textContent === 'Add Tab');
	assert.ok(link, 'no Add Tab task');
	link.dispatch('click', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setCollection', id: 'tabs', collection: [{ text: 'One' }, { text: 'Tab 2' }] }]);
});

test('the outline lists the controls front first, with a container\'s inside it', () => {
	const dom = boot([ctl('a', 'Button'), ctl('pnl', 'Panel', { w: 200, h: 100 }), ctl('inner', 'Button', { parent: 'pnl' })]);
	dom.tabs.outline.dispatch('click', {});
	const rows = dom.el('outline-panel').children.filter((c) => c.className.startsWith('ol-node')).map((c) => c.dataset.id);
	assert.deepEqual(rows, ['', 'pnl', 'inner', 'a']);
});

test('a drop above a sibling in the outline brings the control in front of it', () => {
	const dom = boot([ctl('a', 'Button'), ctl('b', 'Button'), ctl('c', 'Button')]);
	dom.tabs.outline.dispatch('click', {});
	const row = (id) => dom.el('outline-panel').children.find((c) => c.dataset.id === id);
	row('a').dispatch('dragstart', {});
	row('c').dispatch('drop', { clientY: 0 });
	assert.deepEqual(lastOps(dom), [{ op: 'reorder', id: '', parentSlot: '', order: ['b', 'c', 'a'] }]);
});

test('dragging a SplitContainer\'s splitter sets SplitterDistance', () => {
	const dom = boot([ctl('split', 'SplitContainer', { w: 400, h: 200, props: { splitterDistance: '0.5' } })]);
	const bar = el(dom, 'split').descendants.find((e) => e.className === 'cc-split-bar');
	bar.dispatch('mousedown', { clientX: 200, clientY: 50 });
	dom.docDispatch('mousemove', { clientX: 300, clientY: 50 });
	dom.docDispatch('mouseup', {});
	assert.deepEqual(lastOps(dom), [{ op: 'setProp', id: 'split', prop: 'splitterDistance', value: '0.75' }]);
});

test('a drag on the form background selects what the rectangle touches', () => {
	const dom = boot([ctl('a', 'Button', { x: 10, y: 10 }), ctl('b', 'Button', { x: 300, y: 300 }), ctl('c', 'Button', { x: 50, y: 50 })]);
	const canvas = dom.el('form-canvas');
	canvas.dispatch('mousedown', { target: canvas, clientX: 0, clientY: 0 });
	dom.docDispatch('mousemove', { clientX: 150, clientY: 150 });
	dom.docDispatch('mouseup', {});
	assert.ok(el(dom, 'a').classList.contains('selected') || el(dom, 'a').classList.contains('co-selected'));
	assert.ok(el(dom, 'c').classList.contains('selected') || el(dom, 'c').classList.contains('co-selected'));
	assert.ok(!el(dom, 'b').classList.contains('selected') && !el(dom, 'b').classList.contains('co-selected'));
});
