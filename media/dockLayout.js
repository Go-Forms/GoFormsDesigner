// dockLayout.js - where a parent actually puts its children, ported from
// GoForms' arrangeControls (layout.go).
//
// A control's own x/y/w/h describe where it goes only while Dock is
// DockNone. A docked control ignores its designed position at runtime and
// glues itself to an edge of its parent, taking the full width or height of
// whatever its docked siblings have left over. Drawing the stored geometry
// instead would show a docked form one way in the designer and another way
// when it runs, which is the one thing a designer may not do.
//
// Anchoring needs no port: it is measured against the design-time geometry,
// so at the design size it reproduces exactly the bounds already stored.
// Docking is the part that differs even at rest.
//
// GoForms' own test writes test/dock-golden.json from the real layout, and
// test/dockLayout.test.js checks this against it - the same arrangement that
// keeps gridLayout.js honest.
//
// It attaches to `globalThis` rather than using ES modules so the webview can
// load it with a plain <script> under its strict CSP, and Node can require it
// unchanged.
(function (root) {
	'use strict';

	function max(a, b) {
		return a > b ? a : b;
	}

	/**
	 * arrange returns where each child ends up, in the same order it was
	 * given. A child is `{dock, x, y, w, h}`; the result is `{x, y, w, h}`.
	 *
	 * Order matters: docked controls carve up the client area one after
	 * another, so the first DockLeft gets the far left and the next one sits
	 * beside it - exactly as in WinForms, where docking follows z-order.
	 *
	 * pad is the parent's client padding; the designer has no way to read it
	 * from the model yet, so it defaults to none, which is what every
	 * container starts with.
	 */
	function arrange(children, client, pad) {
		pad = pad || { left: 0, top: 0, right: 0, bottom: 0 };

		var left = pad.left;
		var top = pad.top;
		var right = client.width - pad.right;
		var bottom = client.height - pad.bottom;

		var out = new Array(children.length);
		var fillIndex = -1;

		for (var i = 0; i < children.length; i++) {
			var c = children[i];
			switch (c.dock) {
				case 'DockTop':
					out[i] = { x: left, y: top, w: right - left, h: c.h };
					top += c.h;
					break;
				case 'DockBottom':
					out[i] = { x: left, y: bottom - c.h, w: right - left, h: c.h };
					bottom -= c.h;
					break;
				case 'DockLeft':
					out[i] = { x: left, y: top, w: c.w, h: bottom - top };
					left += c.w;
					break;
				case 'DockRight':
					out[i] = { x: right - c.w, y: top, w: c.w, h: bottom - top };
					right -= c.w;
					break;
				case 'DockFill':
					// Applied once the others have taken their slabs, and only
					// the first one: the rest are left where they were, which
					// is what the runtime does.
					if (fillIndex < 0) {
						fillIndex = i;
						out[i] = null;
						break;
					}
					out[i] = { x: c.x, y: c.y, w: c.w, h: c.h };
					break;
				default:
					// Not docked: its own bounds stand. Anchoring would adjust
					// these on a resize, but at the design size it is identity.
					out[i] = { x: c.x, y: c.y, w: c.w, h: c.h };
			}
		}

		if (fillIndex >= 0) {
			out[fillIndex] = {
				x: left,
				y: top,
				w: max(0, right - left),
				h: max(0, bottom - top),
			};
		}
		return out;
	}

	// anyDocked reports whether a layout pass would change anything, so the
	// common case - a container of plain, undocked controls - can skip it.
	function anyDocked(children) {
		for (var i = 0; i < children.length; i++) {
			var d = children[i].dock;
			if (d && d !== 'DockNone') return true;
		}
		return false;
	}

	root.GoFormsDockLayout = {
		arrange: arrange,
		anyDocked: anyDocked,
	};
})(typeof globalThis !== 'undefined' ? globalThis : this);
