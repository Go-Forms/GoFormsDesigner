// renderPlan.js - works out the smallest set of DOM changes that turns the
// canvas as it is now into the canvas the new model describes.
//
// The designer rebuilt the entire canvas after every action: `innerHTML = ''`
// and every control recreated from scratch, because the Go tool answers each
// edit with a whole fresh model. Nudging one button on a form with thirty
// controls therefore destroyed and rebuilt thirty elements - and with them
// every listener, every bit of scroll and focus state - to move one of them
// four pixels.
//
// Comparing the two models first turns that into one style write. The
// comparison is pure and lives here, apart from the DOM, so it can be tested
// (test/renderPlan.test.js) and so the cost of an action can be *measured*
// rather than guessed at: the plan says exactly how many elements an action
// touches.
//
// It attaches to `globalThis` rather than using ES modules so the webview can
// load it with a plain <script> under its strict CSP, and Node can require it
// unchanged - the same arrangement gridLayout.js uses.
(function (root) {
	'use strict';

	// parentKey identifies one coordinate origin: the form, a container, or
	// one named part of a container (a SplitContainer half, a tab page).
	// Controls are grouped by it, and a change to it is a reparent.
	function parentKey(parent, slot) {
		return (parent || '') + (slot ? '/' + slot : '');
	}

	// digest reduces a ControlSpec to just what the canvas draws from, split
	// into the three things that can change independently:
	//
	//   key      which container it belongs to  -> move it
	//   bounds   where it sits                  -> restyle it
	//   content  what it looks like inside      -> re-render its content
	//
	// page is the index of the tab currently being designed for this control
	// (see pageChoice in designer.js); it is part of the content because
	// switching tabs changes what the control draws.
	function digest(spec, page) {
		return {
			id: spec.id,
			key: parentKey(spec.parent, spec.parentSlot),
			supported: spec.supported !== false,
			bounds: [spec.x, spec.y, spec.w, spec.h].join(','),
			// A string rather than a structural compare: these are small, and
			// one cheap equality test per control beats walking every field.
			content: JSON.stringify([
				spec.type,
				spec.text || '',
				spec.items || null,
				spec.props || null,
				spec.collection || null,
				spec.collectionReadOnly || false,
				// Width and height matter to the renderers that lay out their
				// own insides (DataGridView columns, TableLayoutPanel cells,
				// a SplitContainer's ratio), so a resize must redraw them.
				spec.w,
				spec.h,
				page || 0,
			]),
		};
	}

	function digestAll(specs, pageOf) {
		var out = [];
		for (var i = 0; i < specs.length; i++) {
			out.push(digest(specs[i], pageOf ? pageOf(specs[i].id) : 0));
		}
		return out;
	}

	function byId(digests) {
		var m = new Map();
		for (var i = 0; i < digests.length; i++) {
			m.set(digests[i].id, digests[i]);
		}
		return m;
	}

	// childKeys lists each container's children, in model order, as a single
	// string - so "did anything about this container's contents or their
	// order change?" is one string comparison.
	function childKeys(digests) {
		var m = new Map();
		for (var i = 0; i < digests.length; i++) {
			var d = digests[i];
			m.set(d.key, (m.has(d.key) ? m.get(d.key) + ',' : '') + d.id);
		}
		return m;
	}

	/**
	 * computeRenderPlan diffs two digest lists (see digest()).
	 *
	 * The returned plan lists control ids by what has to happen to them:
	 *
	 *   create   not on the canvas yet
	 *   remove   gone from the model
	 *   move     now belongs to a different container
	 *   bounds   same box, new position or size
	 *   content  same box, different innards
	 *   rebuild  supported flag flipped - the whole element differs
	 *   reorder  containers whose child list or order changed, so their
	 *            children have to be re-inserted in model order
	 *
	 * A control can appear in more than one list (moved *and* restyled);
	 * `touched` counts the distinct controls the plan changes at all, which is
	 * the number worth measuring.
	 */
	function computeRenderPlan(prev, next) {
		var prevById = byId(prev);
		var nextById = byId(next);

		var plan = {
			create: [],
			remove: [],
			move: [],
			bounds: [],
			content: [],
			rebuild: [],
			reorder: [],
			touched: 0,
		};

		for (var i = 0; i < prev.length; i++) {
			if (!nextById.has(prev[i].id)) {
				plan.remove.push(prev[i].id);
			}
		}

		var touched = new Set();
		for (var j = 0; j < next.length; j++) {
			var d = next[j];
			var was = prevById.get(d.id);
			if (!was) {
				plan.create.push(d.id);
				touched.add(d.id);
				continue;
			}
			// A control whose supported flag flipped is drawn by a different
			// code path entirely (placeholder vs real rendering), so patching
			// it in place would leave the wrong kind of element behind.
			if (was.supported !== d.supported) {
				plan.rebuild.push(d.id);
				touched.add(d.id);
				continue;
			}
			if (was.key !== d.key) {
				plan.move.push(d.id);
				touched.add(d.id);
			}
			if (was.bounds !== d.bounds) {
				plan.bounds.push(d.id);
				touched.add(d.id);
			}
			if (was.content !== d.content) {
				plan.content.push(d.id);
				touched.add(d.id);
			}
		}

		var prevKids = childKeys(prev);
		var nextKids = childKeys(next);
		nextKids.forEach(function (ids, key) {
			if (prevKids.get(key) !== ids) {
				plan.reorder.push(key);
			}
		});
		// A container emptied by this change still has to have its leftovers
		// cleared out, and it has no entry in nextKids to notice that from.
		prevKids.forEach(function (ids, key) {
			if (!nextKids.has(key)) {
				plan.reorder.push(key);
			}
		});

		plan.touched = touched.size;
		return plan;
	}

	// isNoop reports a plan that changes nothing, so the caller can skip the
	// work entirely - which is the common case for a redundant refresh.
	function isNoop(plan) {
		return (
			plan.touched === 0 &&
			plan.remove.length === 0 &&
			plan.reorder.length === 0
		);
	}

	root.GoFormsRenderPlan = {
		parentKey: parentKey,
		digest: digest,
		digestAll: digestAll,
		computeRenderPlan: computeRenderPlan,
		isNoop: isNoop,
	};
})(typeof globalThis !== 'undefined' ? globalThis : this);
