// The canvas geometry: snapping, the Format commands, the selection
// rectangle and where a paste lands. media/geometry.js is pure, so the math
// the user feels under the mouse is checked here directly.
//
// Run with: node --test test/
const assert = require('node:assert');
const { test } = require('node:test');

const G = require('../media/geometry.js');

const box = { w: 400, h: 300, padding: { left: 0, top: 0, right: 0, bottom: 0 } };

test('a dragged control snaps to a neighbour\'s left edge and says so', () => {
	const r = G.snapMove({ x: 103, y: 50, w: 80, h: 30 }, [{ x: 100, y: 0, w: 80, h: 30 }], box);
	assert.equal(r.rect.x, 100);
	assert.equal(r.rect.y, 50);
	assert.equal(r.guides.length, 1);
	assert.equal(r.guides[0].axis, 'x');
	assert.equal(r.guides[0].pos, 100);
});

test('a control snaps flush against a neighbour\'s far edge', () => {
	const r = G.snapMove({ x: 183, y: 0, w: 50, h: 30 }, [{ x: 100, y: 0, w: 80, h: 30 }], box);
	assert.equal(r.rect.x, 180);
});

test('a control snaps to the container\'s padded edge', () => {
	const padded = { w: 400, h: 300, padding: { left: 8, top: 8, right: 8, bottom: 8 } };
	const r = G.snapMove({ x: 396 - 80, y: 10, w: 80, h: 30 }, [], padded);
	assert.equal(r.rect.x + r.rect.w, 392);
	assert.equal(r.rect.y, 8);
});

test('Alt (a zero threshold) turns snapping off', () => {
	const r = G.snapMove({ x: 103, y: 50, w: 80, h: 30 }, [{ x: 100, y: 0, w: 80, h: 30 }], box, 0);
	assert.equal(r.rect.x, 103);
	assert.equal(r.guides.length, 0);
});

test('a resized edge snaps, the other edges stay', () => {
	const r = G.snapResize({ x: 10, y: 10, w: 87, h: 30 }, ['e'], [{ x: 100, y: 100, w: 50, h: 50 }], box);
	assert.deepEqual(r.rect, { x: 10, y: 10, w: 90, h: 30 });
});

test('alignment lines everything up with the primary', () => {
	const rects = { a: { x: 10, y: 10, w: 50, h: 20 }, b: { x: 40, y: 60, w: 100, h: 40 } };
	assert.deepEqual(G.align(rects, 'a', 'left').b, { x: 10, y: 60, w: 100, h: 40 });
	assert.deepEqual(G.align(rects, 'a', 'right').b, { x: -40, y: 60, w: 100, h: 40 });
	assert.deepEqual(G.align(rects, 'a', 'middle').b, { x: 40, y: 0, w: 100, h: 40 });
	assert.deepEqual(G.align(rects, 'a', 'sameSize').b, { x: 40, y: 60, w: 50, h: 20 });
	assert.deepEqual(G.align(rects, 'a', 'left').a, rects.a, 'the primary does not move');
});

test('equal spacing keeps the ends and evens the gaps', () => {
	const out = G.spaceEvenly({ a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 15, y: 0, w: 10, h: 10 }, c: { x: 100, y: 0, w: 10, h: 10 } }, 'x');
	assert.equal(out.a.x, 0);
	assert.equal(out.c.x, 100);
	assert.equal(out.b.x, 50);
});

test('the selection rectangle takes what it touches, drawn either way', () => {
	const rects = [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 50, y: 50, w: 10, h: 10 }];
	assert.deepEqual(G.lassoSelect(rects, G.normalize({ x: 55, y: 55 }, { x: 5, y: 5 })), ['a', 'b']);
	assert.deepEqual(G.lassoSelect(rects, G.normalize({ x: 20, y: 20 }, { x: 45, y: 45 })), []);
});

test('a paste cascades instead of stacking', () => {
	const at = { x: 10, y: 10 };
	assert.equal(G.pasteOffset(at, []), 0);
	assert.equal(G.pasteOffset(at, [{ x: 10, y: 10 }]), 8);
	assert.equal(G.pasteOffset(at, [{ x: 10, y: 10 }, { x: 18, y: 18 }]), 16);
});
