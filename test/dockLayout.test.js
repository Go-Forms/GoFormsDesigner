// Checks the designer's docking port against the real thing.
//
// media/dockLayout.js re-implements arrangeControls' docking from GoForms so
// the canvas can show where a docked control will actually be. That promise
// is only worth something if the two agree, so GoForms' own
// TestGoldenDockLayout writes dock-golden.json from the real layout and this
// compares every case against it.
//
// Run with: node --test test/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

require('../media/dockLayout.js');
const DL = globalThis.GoFormsDockLayout;

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'dock-golden.json'), 'utf8'));

test('the golden fixture is present and not empty', () => {
	assert.ok(Array.isArray(golden) && golden.length > 0, 'run `go test -run TestGoldenDockLayout` in GoForms');
});

for (const c of golden) {
	test(`dock layout: ${c.name}`, () => {
		const children = c.children.map((ch) => ({ dock: ch.dock, x: ch.x, y: ch.y, w: ch.w, h: ch.h }));
		const got = DL.arrange(children, { width: c.clientW, height: c.clientH });

		c.children.forEach((ch, i) => {
			const want = { x: ch.out[0], y: ch.out[1], w: ch.out[2], h: ch.out[3] };
			assert.deepEqual(
				got[i],
				want,
				`${ch.name} (${ch.dock}): got ${JSON.stringify(got[i])}, GoForms puts it at ${JSON.stringify(want)}`
			);
		});
	});
}

test('anyDocked skips the common case', () => {
	assert.equal(DL.anyDocked([{ dock: 'DockNone' }, { dock: undefined }]), false);
	assert.equal(DL.anyDocked([{ dock: 'DockNone' }, { dock: 'DockFill' }]), true);
});

test('padding insets the whole arrangement', () => {
	const got = DL.arrange(
		[{ dock: 'DockFill', x: 0, y: 0, w: 10, h: 10 }],
		{ width: 200, height: 100 },
		{ left: 5, top: 6, right: 7, bottom: 8 }
	);
	assert.deepEqual(got[0], { x: 5, y: 6, w: 200 - 5 - 7, h: 100 - 6 - 8 });
});
