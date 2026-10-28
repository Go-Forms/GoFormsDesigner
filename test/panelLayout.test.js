// Checks the designer's FlowLayoutPanel and TableLayoutPanel port against
// the real thing.
//
// media/panelLayout.js re-implements the two panels' arrangeCustom from
// GoForms so the canvas draws their children where the running form puts
// them. GoForms' own TestGoldenPanelLayout writes panels-golden.json from the
// real panels; this compares every case against it. Regenerate it after
// touching either side:
//
//     cd ../GoForms && go test -run TestGoldenPanelLayout .
//
// Run with: node --test test/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const PL = require('../media/panelLayout.js');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'panels-golden.json'), 'utf8'));

test('the golden fixture covers both panels', () => {
	assert.ok(golden.some((c) => c.kind === 'flow'), 'no flow cases');
	assert.ok(golden.some((c) => c.kind === 'table'), 'no table cases');
});

const padOf = (p) => ({ left: p[0], top: p[1], right: p[2], bottom: p[3] });

for (const c of golden) {
	test(`${c.kind} layout: ${c.name}`, () => {
		const client = { width: c.clientW, height: c.clientH };
		let got;
		if (c.kind === 'flow') {
			got = PL.arrangeFlow(c.children.map((k) => ({ w: k.w, h: k.h })), client, {
				direction: c.direction,
				wrap: !!c.wrap,
				spacing: c.spacing || 0,
				padding: padOf(c.padding),
			});
		} else {
			const kids = c.children.map((k) => ({
				x: 0,
				y: 0,
				w: k.w,
				h: k.h,
				cell: k.cell ? { column: k.cell[0], row: k.cell[1], columnSpan: k.cell[2], rowSpan: k.cell[3] } : null,
			}));
			got = PL.arrangeTable(kids, c.columns, c.rows, client, padOf(c.padding));
		}
		c.children.forEach((k, i) => {
			const want = { x: k.out[0], y: k.out[1], w: k.out[2], h: k.out[3] };
			const r = got[i];
			assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, want, `${k.name}: got ${JSON.stringify(r)}, GoForms puts it at ${JSON.stringify(want)}`);
		});
	});
}

test('a drop lands in the cell under the point, clamped to the grid', () => {
	const grid = PL.tableGrid([{ type: 'Absolute', value: 50 }, { type: 'AutoSize' }], [{ type: 'AutoSize' }], { width: 150, height: 40 });
	assert.deepEqual(PL.cellAt(grid, 10, 10), { column: 0, row: 0 });
	assert.deepEqual(PL.cellAt(grid, 60, 10), { column: 1, row: 0 });
	assert.deepEqual(PL.cellAt(grid, 500, 500), { column: 1, row: 0 });
});

test('dragging a boundary resizes the two tracks beside it', () => {
	const tracks = [{ type: 'AutoSize' }, { type: 'AutoSize' }, { type: 'Percent', value: 100 }];
	const out = PL.resizeTracks(tracks, [100, 100, 100], 0, 30);
	assert.deepEqual(out[0], { type: 'Absolute', value: 130 });
	assert.deepEqual(out[1], { type: 'Absolute', value: 70 });
	assert.deepEqual(out[2], { type: 'Percent', value: 100 });
	// Two percent tracks keep their total, shared by their new pixels.
	const pct = PL.resizeTracks([{ type: 'Percent', value: 50 }, { type: 'Percent', value: 50 }], [100, 100], 0, 50);
	assert.deepEqual(pct, [{ type: 'Percent', value: 75 }, { type: 'Percent', value: 25 }]);
});

test('a flow drop goes before the control whose middle is past the point', () => {
	const rects = [{ x: 0, y: 0, w: 50, h: 20 }, { x: 56, y: 0, w: 50, h: 20 }];
	assert.equal(PL.flowInsert(rects, 10, 5, 'FlowLeftToRight').index, 0);
	assert.equal(PL.flowInsert(rects, 40, 5, 'FlowLeftToRight').index, 1);
	assert.equal(PL.flowInsert(rects, 200, 5, 'FlowLeftToRight').index, 2);
});
