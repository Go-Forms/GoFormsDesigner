// geometry.js - the pure geometry of the designer canvas: snap lines, the
// Format commands, the selection rectangle. No DOM and no state, so the math
// the user feels under the mouse is the math test/geometry.test.js checks.
//
// Ported from the NetForms designer (designer/media/geometry.js, MIT, the
// same organisation). GoForms has no Margin, so the snap candidates are a
// neighbour's edges and centre and the container's padded inner edges - not
// the margin-spaced positions NetForms adds.
//
// A rect is {x, y, w, h} in form pixels, relative to the container both
// rects are in.
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	root.GoFormsGeometry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	/** Pixels within which an edge is pulled onto a snap line. */
	const SNAP = 5;

	const right = (r) => r.x + r.w;
	const bottom = (r) => r.y + r.h;
	const centerX = (r) => r.x + r.w / 2;
	const centerY = (r) => r.y + r.h / 2;

	/** Where the moving rect's edges could go along one axis, from one
	 * neighbour: its edges (aligned) and its centre (centred). */
	function candidates(axis, other) {
		if (axis === 'x') {
			return [
				{ edge: 'start', pos: other.x, kind: 'align' },
				{ edge: 'end', pos: right(other), kind: 'align' },
				{ edge: 'start', pos: right(other), kind: 'align' },
				{ edge: 'end', pos: other.x, kind: 'align' },
				{ edge: 'center', pos: centerX(other), kind: 'center' },
			];
		}
		return [
			{ edge: 'start', pos: other.y, kind: 'align' },
			{ edge: 'end', pos: bottom(other), kind: 'align' },
			{ edge: 'start', pos: bottom(other), kind: 'align' },
			{ edge: 'end', pos: other.y, kind: 'align' },
			{ edge: 'center', pos: centerY(other), kind: 'center' },
		];
	}

	function edgeValue(axis, rect, edge) {
		if (axis === 'x') return edge === 'start' ? rect.x : edge === 'end' ? right(rect) : centerX(rect);
		return edge === 'start' ? rect.y : edge === 'end' ? bottom(rect) : centerY(rect);
	}

	/** The container's inner edges, inset by its padding - where a control
	 * lands when pushed against the side of a panel or the form. */
	function containerCandidates(axis, container) {
		if (!container) return [];
		const p = container.padding || { left: 0, top: 0, right: 0, bottom: 0 };
		return axis === 'x'
			? [
					{ edge: 'start', pos: p.left, kind: 'edge' },
					{ edge: 'end', pos: container.w - p.right, kind: 'edge' },
					{ edge: 'center', pos: container.w / 2, kind: 'center' },
				]
			: [
					{ edge: 'start', pos: p.top, kind: 'edge' },
					{ edge: 'end', pos: container.h - p.bottom, kind: 'edge' },
					{ edge: 'center', pos: container.h / 2, kind: 'center' },
				];
	}

	function bestSnap(axis, moving, others, container, threshold, edges) {
		let best = null;
		const all = [];
		for (const o of others) for (const c of candidates(axis, o)) all.push({ c, o });
		for (const c of containerCandidates(axis, container)) all.push({ c, o: null });
		for (const { c, o } of all) {
			if (edges && !edges.includes(c.edge)) continue;
			const d = c.pos - edgeValue(axis, moving, c.edge);
			if (Math.abs(d) > threshold) continue;
			if (!best || Math.abs(d) < Math.abs(best.delta)) best = { delta: d, pos: c.pos, kind: c.kind, other: o };
		}
		return best;
	}

	/** A guide line for a snap: across the moving rect and the neighbour it
	 * snapped to, or the whole container for one of its edges. */
	function guide(axis, snap, moved, container) {
		const o = snap.other;
		if (axis === 'x') {
			const from = o ? Math.min(moved.y, o.y) : 0;
			const to = o ? Math.max(bottom(moved), bottom(o)) : container ? container.h : bottom(moved);
			return { axis: 'x', pos: snap.pos, from, to, kind: snap.kind };
		}
		const from = o ? Math.min(moved.x, o.x) : 0;
		const to = o ? Math.max(right(moved), right(o)) : container ? container.w : right(moved);
		return { axis: 'y', pos: snap.pos, from, to, kind: snap.kind };
	}

	/**
	 * snapMove snaps a rect being dragged: the adjusted rect and the guide
	 * lines to draw. `others` are its siblings (same container, not moving);
	 * `container` is {w, h, padding} of the container's client area. Holding
	 * Alt passes a threshold of 0, which turns snapping off.
	 */
	function snapMove(moving, others, container, threshold) {
		const t = threshold === undefined ? SNAP : threshold;
		const sx = t > 0 ? bestSnap('x', moving, others, container, t) : null;
		const sy = t > 0 ? bestSnap('y', moving, others, container, t) : null;
		const rect = { x: moving.x + (sx ? sx.delta : 0), y: moving.y + (sy ? sy.delta : 0), w: moving.w, h: moving.h };
		const guides = [];
		if (sx) guides.push(guide('x', sx, rect, container));
		if (sy) guides.push(guide('y', sy, rect, container));
		return { rect, guides };
	}

	/**
	 * snapResize snaps the edges being dragged ('e' and/or 's', the handles
	 * a control has) to the neighbours' and the container's.
	 */
	function snapResize(rect, edges, others, container, threshold) {
		const t = threshold === undefined ? SNAP : threshold;
		const r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
		const guides = [];
		if (t <= 0) return { rect: r, guides };
		if (edges.includes('e')) {
			const s = bestSnap('x', r, others, container, t, ['end']);
			if (s) {
				r.w = Math.max(1, r.w + s.delta);
				guides.push(guide('x', s, r, container));
			}
		}
		if (edges.includes('s')) {
			const s = bestSnap('y', r, others, container, t, ['end']);
			if (s) {
				r.h = Math.max(1, r.h + s.delta);
				guides.push(guide('y', s, r, container));
			}
		}
		return { rect: r, guides };
	}

	/**
	 * align is the Format menu: every rect lined up with the primary one -
	 * the last clicked, as Visual Studio does. `how` is left, center, right,
	 * top, middle, bottom, sameWidth, sameHeight or sameSize. Returns new
	 * rects by id; the primary is unchanged.
	 */
	function align(rects, primaryId, how) {
		const p = rects[primaryId];
		const out = {};
		for (const id of Object.keys(rects)) {
			const r = rects[id];
			const n = { x: r.x, y: r.y, w: r.w, h: r.h };
			if (id !== primaryId) {
				switch (how) {
					case 'left': n.x = p.x; break;
					case 'right': n.x = right(p) - r.w; break;
					case 'center': n.x = Math.round(centerX(p) - r.w / 2); break;
					case 'top': n.y = p.y; break;
					case 'bottom': n.y = bottom(p) - r.h; break;
					case 'middle': n.y = Math.round(centerY(p) - r.h / 2); break;
					case 'sameWidth': n.w = p.w; break;
					case 'sameHeight': n.h = p.h; break;
					case 'sameSize': n.w = p.w; n.h = p.h; break;
					default: throw new Error('unknown alignment ' + how);
				}
			}
			out[id] = n;
		}
		return out;
	}

	/**
	 * spaceEvenly makes the gaps between the rects equal along one axis,
	 * keeping the first and the last where they are - Format ▸ Horizontal
	 * (or Vertical) Spacing ▸ Make Equal.
	 */
	function spaceEvenly(rects, axis) {
		const ids = Object.keys(rects);
		const out = {};
		for (const id of ids) out[id] = { ...rects[id] };
		if (ids.length < 3) return out;
		const key = axis === 'x' ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h';
		ids.sort((a, b) => rects[a][key] - rects[b][key]);
		const first = rects[ids[0]], last = rects[ids[ids.length - 1]];
		const total = ids.reduce((s, id) => s + rects[id][size], 0);
		const gap = (last[key] + last[size] - first[key] - total) / (ids.length - 1);
		let pos = first[key];
		for (const id of ids) {
			out[id][key] = Math.round(pos);
			pos += rects[id][size] + gap;
		}
		return out;
	}

	/** The rectangle spanned by two points, whichever way it was drawn. */
	function normalize(a, b) {
		return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
	}

	/**
	 * lassoSelect is what a selection rectangle takes, as in Visual Studio:
	 * every rect it touches. `rects` are {id, x, y, w, h} in the same
	 * coordinates as `box`; the caller passes only the container's own
	 * children, so a rectangle drawn on the form does not reach into a panel.
	 */
	function lassoSelect(rects, box) {
		return rects
			.filter((r) => r.x < box.x + box.w && box.x < r.x + r.w && r.y < box.y + box.h && box.y < r.y + r.h)
			.map((r) => r.id);
	}

	/** The bounding box of several rects. */
	function union(rects) {
		let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
		for (const r of rects) {
			x1 = Math.min(x1, r.x);
			y1 = Math.min(y1, r.y);
			x2 = Math.max(x2, r.x + r.w);
			y2 = Math.max(y2, r.y + r.h);
		}
		return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
	}

	/**
	 * pasteOffset is where a pasted group goes: where it was copied from,
	 * moved down and right by a step for as long as that would put its first
	 * control exactly on top of one already there - so pasting three times
	 * makes a visible cascade, not three controls stacked into one.
	 */
	function pasteOffset(first, occupied, step) {
		const s = step || 8;
		let dx = 0;
		while (occupied.some((o) => o.x === first.x + dx && o.y === first.y + dx) && dx < 100 * s) dx += s;
		return dx;
	}

	return { SNAP, snapMove, snapResize, align, spaceEvenly, normalize, lassoSelect, union, pasteOffset };
});
