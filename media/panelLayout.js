// panelLayout.js - where a FlowLayoutPanel and a TableLayoutPanel put their
// children, so the canvas draws them there.
//
// A control in a flow ignores its own x/y: the panel places its children one
// after another and wraps them. A control in a table fills its cell. Drawing
// either at its stored bounds showed a form the app never looked like - the
// same mistake media/dockLayout.js corrects for docking.
//
// This is a port of the two arrangeCustom methods in GoForms/layoutpanels.go,
// checked against the framework by test/panelLayout.test.js through the
// fixture GoForms' TestGoldenPanelLayout writes (test/panels-golden.json).
// Pure functions, no DOM: loaded by the webview as a script and by node as a
// module.
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	root.GoFormsPanelLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const NO_PADDING = { left: 0, top: 0, right: 0, bottom: 0 };

	/**
	 * arrangeFlow places a flow's children. `kids` are {w, h} in flow order
	 * (the order they were added); `opts` is {direction, wrap, spacing,
	 * padding}. Returns one {x, y, w, h} per child - each keeps its size.
	 */
	function arrangeFlow(kids, client, opts) {
		const pad = (opts && opts.padding) || NO_PADDING;
		const direction = (opts && opts.direction) || 'FlowLeftToRight';
		const wrap = !opts || opts.wrap !== false;
		const spacing = opts && opts.spacing !== undefined ? opts.spacing : 6;
		const startX = pad.left, startY = pad.top;
		const limitX = client.width - pad.right, limitY = client.height - pad.bottom;
		const horizontal = direction === 'FlowLeftToRight' || direction === 'FlowRightToLeft';

		let x = startX, y = startY, lineExtent = 0;
		return kids.map((k) => {
			if (horizontal) {
				if (wrap && x > startX && x + k.w > limitX) {
					x = startX;
					y += lineExtent + spacing;
					lineExtent = 0;
				}
				const px = direction === 'FlowRightToLeft' ? limitX - (x - startX) - k.w : x;
				const r = { x: px, y, w: k.w, h: k.h };
				x += k.w + spacing;
				lineExtent = Math.max(lineExtent, k.h);
				return r;
			}
			if (wrap && y > startY && y + k.h > limitY) {
				y = startY;
				x += lineExtent + spacing;
				lineExtent = 0;
			}
			const py = direction === 'FlowBottomUp' ? limitY - (y - startY) - k.h : y;
			const r = { x, y: py, w: k.w, h: k.h };
			y += k.h + spacing;
			lineExtent = Math.max(lineExtent, k.w);
			return r;
		});
	}

	/**
	 * resolveTracks turns track styles into pixel sizes: absolute tracks take
	 * their pixels first, percent tracks share what is left by their stated
	 * share, and auto tracks split whatever remains evenly. `tracks` are
	 * {type, value} as the tool's TrackSpec.
	 */
	function resolveTracks(tracks, total) {
		const sizes = tracks.map(() => 0);
		let remaining = total;
		tracks.forEach((t, i) => {
			if (t.type === 'Absolute') {
				sizes[i] = t.value || 0;
				remaining -= sizes[i];
			}
		});
		if (remaining < 0) remaining = 0;
		const percentPool = remaining;
		let autoCount = 0;
		tracks.forEach((t, i) => {
			if (t.type === 'Percent') {
				sizes[i] = (percentPool * (t.value || 0)) / 100;
				remaining -= sizes[i];
			} else if (t.type !== 'Absolute') {
				autoCount++;
			}
		});
		if (remaining < 0) remaining = 0;
		if (autoCount > 0) {
			const each = remaining / autoCount;
			tracks.forEach((t, i) => {
				if (t.type !== 'Absolute' && t.type !== 'Percent') sizes[i] = each;
			});
		}
		return sizes;
	}

	function runningOffsets(sizes, start) {
		const out = [];
		let pos = start;
		for (const s of sizes) {
			out.push(pos);
			pos += s;
		}
		return out;
	}

	/**
	 * tableGrid lays out a table's tracks: each column's and row's start and
	 * size inside the client area, padding applied.
	 */
	function tableGrid(columns, rows, client, padding) {
		const pad = padding || NO_PADDING;
		const colSizes = resolveTracks(columns, client.width - pad.left - pad.right);
		const rowSizes = resolveTracks(rows, client.height - pad.top - pad.bottom);
		return {
			colSizes,
			rowSizes,
			colOffsets: runningOffsets(colSizes, pad.left),
			rowOffsets: runningOffsets(rowSizes, pad.top),
		};
	}

	/**
	 * tableCells works out the cell of every child the way AddControl does at
	 * runtime: a child with a cell of its own is there, and a plain
	 * AddControl takes the cell after the last child added - after it, not
	 * the first free one, which is what the framework's cursor does. `kids`
	 * are in add order, each with an optional {column, row, columnSpan,
	 * rowSpan}. Returns {column, row, columnSpan, rowSpan, auto}.
	 */
	function tableCells(kids, columnCount) {
		let nextCol = 0, nextRow = 0;
		return kids.map((k) => {
			const c = k.cell;
			const cell = c
				? { column: c.column, row: c.row, columnSpan: Math.max(1, c.columnSpan || 1), rowSpan: Math.max(1, c.rowSpan || 1), auto: false }
				: { column: nextCol, row: nextRow, columnSpan: 1, rowSpan: 1, auto: true };
			nextCol = cell.column + cell.columnSpan;
			nextRow = cell.row;
			if (nextCol >= columnCount) {
				nextCol = 0;
				nextRow++;
			}
			return cell;
		});
	}

	/**
	 * arrangeTable places a table's children in their cells. A child whose
	 * cell is outside the grid is left at its own bounds, as the framework
	 * leaves it. Returns one {x, y, w, h, column, row, inGrid} per child.
	 */
	function arrangeTable(kids, columns, rows, client, padding) {
		const g = tableGrid(columns, rows, client, padding);
		const cells = tableCells(kids, columns.length);
		return kids.map((k, i) => {
			const c = cells[i];
			if (c.column < 0 || c.column >= columns.length || c.row < 0 || c.row >= rows.length) {
				return { x: k.x || 0, y: k.y || 0, w: k.w, h: k.h, column: c.column, row: c.row, inGrid: false };
			}
			let w = 0, h = 0;
			for (let j = c.column; j < c.column + c.columnSpan && j < columns.length; j++) w += g.colSizes[j];
			for (let j = c.row; j < c.row + c.rowSpan && j < rows.length; j++) h += g.rowSizes[j];
			return {
				x: g.colOffsets[c.column],
				y: g.rowOffsets[c.row],
				w: Math.max(1, w),
				h: Math.max(1, h),
				column: c.column,
				row: c.row,
				inGrid: true,
			};
		});
	}

	/** The cell under a point in the table's client coordinates, clamped to
	 * the grid - past the last column is the last column. */
	function cellAt(grid, x, y) {
		const index = (offsets, sizes, v) => {
			let i = 0;
			while (i < offsets.length - 1 && v >= offsets[i] + sizes[i]) i++;
			return i;
		};
		return { column: index(grid.colOffsets, grid.colSizes, x), row: index(grid.rowOffsets, grid.rowSizes, y) };
	}

	/**
	 * resizeTracks is a boundary between track `index` and the next dragged
	 * by `delta` pixels, as the Visual Studio designer resizes a table: both
	 * tracks change by the pixels moved (never below 0); an Absolute track
	 * takes its new pixels, an AutoSize one becomes Absolute at them, and the
	 * Percent tracks share their total percentage again in proportion to
	 * their new pixels. `sizes` are the tracks as laid out. Ported from the
	 * NetForms designer (designer/media/geometry.js).
	 */
	function resizeTracks(tracks, sizes, index, delta) {
		const out = tracks.map((t) => ({ type: t.type || 'AutoSize', value: t.value || 0 }));
		if (index < 0 || index + 1 >= sizes.length) return out;
		const d = Math.max(-sizes[index], Math.min(sizes[index + 1], Math.round(delta)));
		if (d === 0) return out;
		const px = sizes.slice();
		px[index] += d;
		px[index + 1] -= d;
		let percent = false;
		for (const k of [index, index + 1]) {
			if (out[k].type === 'Percent') percent = true;
			else out[k] = { type: 'Absolute', value: Math.round(px[k]) };
		}
		if (percent) {
			const ks = out.map((t, k) => (t.type === 'Percent' ? k : -1)).filter((k) => k >= 0);
			const total = ks.reduce((sum, k) => sum + (tracks[k].value || 0), 0) || 100;
			const pixels = ks.reduce((sum, k) => sum + px[k], 0);
			if (pixels > 0) for (const k of ks) out[k].value = Math.round(((total * px[k]) / pixels) * 100) / 100;
		}
		return out;
	}

	/**
	 * flowInsert is where a drop goes in a flow: `rects` are the panel's
	 * children in flow order, the point is the mouse. The line under the
	 * point (or the nearest one) is found; the drop goes before the first
	 * control on it whose middle is past the point, else after its last.
	 * Returns the insertion index and the 2px bar to draw. Ported from the
	 * NetForms designer.
	 */
	function flowInsert(rects, x, y, direction) {
		if (!rects.length) return { index: 0, bar: null };
		const horizontal = direction !== 'FlowTopDown' && direction !== 'FlowBottomUp';
		const reverse = direction === 'FlowRightToLeft' || direction === 'FlowBottomUp';
		const main = (r) => (horizontal ? [r.x, r.w] : [r.y, r.h]);
		const cross = (r) => (horizontal ? [r.y, r.h] : [r.x, r.w]);
		const pm = horizontal ? x : y, pc = horizontal ? y : x;
		const distance = (r) => {
			const [s, l] = cross(r);
			return pc < s ? s - pc : pc >= s + l ? pc - (s + l) + 1 : 0;
		};
		const nearest = Math.min(...rects.map(distance));
		const line = rects.map((c, i) => ({ c, i })).filter(({ c }) => distance(c) === nearest);
		const bar = (c, before) => {
			const [s, l] = main(c);
			const pos = before !== reverse ? s - 2 : s + l;
			return horizontal ? { x: pos, y: c.y, w: 2, h: c.h } : { x: c.x, y: pos, w: c.w, h: 2 };
		};
		for (const { c, i } of line) {
			const [s, l] = main(c);
			const mid = s + l / 2;
			if (reverse ? pm > mid : pm < mid) return { index: i, bar: bar(c, true) };
		}
		const last = line[line.length - 1];
		return { index: last.i + 1, bar: bar(last.c, false) };
	}

	return { arrangeFlow, resolveTracks, tableGrid, tableCells, arrangeTable, cellAt, resizeTracks, flowInsert };
});
