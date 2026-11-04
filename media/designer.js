// designer.js - vanilla-JS webview client for the GoForms visual designer.
// No frameworks: the whole UI is DOM built/updated by hand from the
// FormModel + catalog pushed from designerEditorProvider.ts. The extension
// host (Go tool) is the single source of truth - after every user action we
// send an 'apply' message and re-render from whatever fresh model comes
// back, rather than predicting the new state ourselves.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	/** @type {any} FormModel from goTool.ts, plain JSON over the wire. */
	let model = null;
	/** @type {Record<string, any>} ControlDesc catalog, keyed by type. */
	let catalog = null;
	/** @type {string[]} Toolbox group names, in the order to show them. */
	let categories = [];
	/** Which side-panel tab is showing: 'controls' or 'properties'. */
	let activeTab = 'properties';
	/** Current filter text in the Controls tab. */
	let toolboxFilter = '';
	/**
	 * The canvas element for each control, kept alive across refreshes so a
	 * model update can patch what changed instead of rebuilding everything.
	 * @type {Map<string, HTMLElement>}
	 */
	const rendered = new Map();
	/**
	 * The tray element for each non-visual component. Kept apart from
	 * `rendered` because the two are built, placed and diffed by completely
	 * different code, and a component appearing in the canvas's render plan
	 * would be drawn at 0,0 on top of the form.
	 * @type {Map<string, HTMLElement>}
	 */
	const trayEls = new Map();
	/** The digests the canvas currently reflects; see media/renderPlan.js. */
	let prevDigests = [];
	/**
	 * How large the form is drawn. It is a CSS transform on the canvas, so
	 * every mouse delta arrives in screen pixels and has to be divided by it
	 * to become form pixels - see toFormPx. Nothing about the model changes.
	 */
	let zoom = 1;
	/** 'fit' recomputes the zoom whenever the form or the viewport changes. */
	let zoomMode = '1';
	/** Lock Controls: selection still works, dragging and resizing do not. */
	let locked = false;
	/** Tab Order mode: the canvas shows each control's tab index, and
	 * clicking assigns the next one. */
	let tabOrderMode = false;
	let selectedId = null;
	// selectedIds is the whole selection; selectedId is its primary member -
	// the one the properties panel edits and the one alignment aligns to.
	let selectedIds = new Set();
	let parseErrorMsg = null;

	let dragState = null;
	let resizeState = null;
	// slotChoice remembers which half of a slotted container (SplitContainer)
	// the user last clicked, so the toolbox drops into the one they are
	// looking at rather than always the first.
	const slotChoice = {};
	// pageChoice is which page of a TabControl/ViewContainer is currently
	// being designed - the canvas shows one at a time, as WinForms does.
	const pageChoice = {};
	// smartOpen is the control whose Tasks panel (its smart tag) is open.
	let smartOpen = null;
	// selectedColumn is the DataGridView column picked by clicking its header
	// on the canvas: {id, index}, or null. The panel then edits that column.
	let selectedColumn = null;
	// resourceBase is where the webview can load the form's folder from, for
	// drawing its embedded pictures (see designerEditorProvider.ts).
	let resourceBase = '';
	// outlineCollapsed holds the Outline nodes folded shut.
	const outlineCollapsed = new Set();
	// The geometry and the panel layout ports, loaded before this file (see
	// designerEditorProvider.ts). Read at call time, as the render plan is.
	const geo = () => globalThis.GoFormsGeometry;
	const panels = () => globalThis.GoFormsPanelLayout;

	function $(id) {
		return document.getElementById(id);
	}

	function post(msg) {
		vscode.postMessage(msg);
	}

	// Go's encoding/json marshals a nil slice as JSON `null` (e.g. a form
	// with zero controls, or zero radio groups) - normalize on receipt so
	// every `model.controls.filter/map/find(...)` call below can assume an
	// array unconditionally, instead of every call site null-checking.
	function normalizeModel(m) {
		if (!m) return m;
		if (!m.controls) m.controls = [];
		if (!m.radioGroups) m.radioGroups = [];
		return m;
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.type) {
			case 'init':
				model = normalizeModel(msg.model);
				catalog = msg.catalog;
				categories = msg.categories || [];
				parseErrorMsg = null;
				// Keep whatever is selected if it is still there. An init
				// arrives whenever the file changes on disk, and dropping the
				// selection every time meant the properties panel emptied
				// itself out from under the user mid-edit.
				pruneSelection();
				renderAll();
				if (model && model.note) {
					showToast(model.note, 'info');
				}
				break;
			case 'model':
				model = normalizeModel(msg.model);
				pruneSelection();
				renderAll();
				break;
			case 'error':
				showToast(msg.message, 'error');
				break;
			case 'info':
				showToast(msg.message, 'info');
				break;
			case 'parseError':
				parseErrorMsg = msg.message;
				renderAll();
				break;
			case 'pasteData':
				pasteControls(msg.data, !!msg.sameForm, null);
				break;
			case 'resourceBase':
				resourceBase = msg.uri || '';
				break;
			case 'dataType':
				columnsFromType(msg.id, msg.fields || []);
				break;
			case 'handlerWired':
				model = normalizeModel(msg.model);
				if (msg.result.created) {
					showToast(`Created ${msg.result.method} in ${basename(msg.result.file)}`, 'info');
				} else if (msg.result.fileCreated) {
					showToast(`Created ${basename(msg.result.file)} with ${msg.result.method}`, 'info');
				}
				renderAll();
				break;
			default:
				break;
		}
	});

	post({ type: 'ready' });

	// The designer edits the file through the Go tool rather than through a
	// TextDocument, so the editor's own undo never sees these changes - the
	// extension keeps a snapshot history instead and Ctrl+Z/Ctrl+Y drive it.
	// The rest are the Visual Studio designer's keys: the clipboard, the
	// arrows that nudge, Escape up a level.
	window.addEventListener('keydown', (e) => {
		const typing = isTypingTarget(e.target);
		if (e.key === 'Escape' && closePopups()) {
			e.preventDefault();
			return;
		}
		// Delete removes the selection outright. It is undoable (Ctrl+Z), so
		// a confirmation step would only be in the way - which is exactly how
		// the WinForms designer behaves.
		if ((e.key === 'Delete' || e.key === 'Del') && !typing) {
			e.preventDefault();
			deleteSelection();
			return;
		}
		// Escape goes up a level: to the container of the selection, then to
		// the form. It is the way out that does not depend on finding
		// somewhere to click: a form covered edge to edge by a docked control
		// has no background left, and then a control's properties were the
		// only thing the panel would ever show again.
		if (e.key === 'Escape' && !typing) {
			e.preventDefault();
			selectParent();
			return;
		}
		const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
		if (arrows[e.key] && !typing) {
			e.preventDefault();
			const [dx, dy] = arrows[e.key];
			nudgeSelection(dx, dy, e.shiftKey, e.ctrlKey || e.metaKey ? 8 : 1);
			return;
		}
		if (!(e.ctrlKey || e.metaKey)) return;
		const key = e.key.toLowerCase();
		if (key === 'z' && !e.shiftKey) {
			e.preventDefault();
			post({ type: 'undo' });
		} else if (key === 'y' || (key === 'z' && e.shiftKey)) {
			e.preventDefault();
			post({ type: 'redo' });
		} else if (typing) {
			// Copy, paste and select-all in a property field are the field's.
			return;
		} else if (key === 'c') {
			e.preventDefault();
			copySelection();
		} else if (key === 'x') {
			e.preventDefault();
			cutSelection();
		} else if (key === 'v') {
			e.preventDefault();
			post({ type: 'paste' });
		} else if (key === 'd') {
			e.preventDefault();
			duplicateSelection();
		} else if (key === 'a') {
			e.preventDefault();
			selectAllSiblings();
		}
	});

	// isTypingTarget keeps Delete meaning "delete a character" while the
	// caret is in one of the panel's fields, and "delete the control" only
	// when it isn't.
	function isTypingTarget(el) {
		if (!el) return false;
		const tag = el.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
	}

	function deleteSelection() {
		const specs = selectedSpecs().filter((s) => s.supported);
		if (!specs.length) return;
		// Children first: removing a container takes its children's source
		// with it, and a second remove of an already-deleted child would fail
		// the whole batch.
		const doomed = new Set(specs.map((s) => s.id));
		const ops = specs
			.filter((s) => !isInsideAny(s.parent || '', doomed))
			.map((s) => ({ op: 'remove', id: s.id }));
		post({ type: 'apply', ops });
		setSelection(null, false);
	}

	// -- Selection moves ----------------------------------------------------

	// selectParent is Escape: the container of the selection, or the form.
	function selectParent() {
		const spec = selectedId ? findControl(selectedId) : null;
		if (spec && spec.parent && findControl(spec.parent)) {
			setSelection(spec.parent, false);
			updateSelectionClasses();
			renderProperties();
			renderOutline();
			return;
		}
		selectForm();
	}

	// selectAllSiblings is Ctrl+A: everything in the container the selection
	// is in, or on the form.
	function selectAllSiblings() {
		const spec = selectedId ? findControl(selectedId) : null;
		const key = spec ? parentKey(spec.parent, spec.parentSlot) : '';
		const ids = canvasControls().filter((c) => parentKey(c.parent, c.parentSlot) === key).map((c) => c.id);
		if (!ids.length) return;
		selectedIds = new Set(ids);
		selectedId = spec && ids.includes(spec.id) ? spec.id : ids[ids.length - 1];
		updateSelectionClasses();
		renderProperties();
		renderOutline();
	}

	// selectIds replaces the selection, the last id the primary one.
	function selectIds(ids) {
		selectedIds = new Set(ids);
		selectedId = ids.length ? ids[ids.length - 1] : null;
	}

	// nudgeSelection is what an arrow key does, as in the Visual Studio
	// designer: it moves the selection by a pixel (Ctrl: eight), or with
	// Shift grows and shrinks it. A control in a flow has no position of its
	// own - the arrows move it back or forth in the flow - and a control in
	// a table moves from cell to cell.
	function nudgeSelection(dx, dy, resize, step) {
		if (locked || tabOrderMode) return;
		const specs = selectedSpecs().filter((s) => s.supported && !isComponent(s));
		if (!specs.length) return;
		const parentType = (s) => (s.parent && !s.parentSlot ? (findControl(s.parent) || {}).type : '');

		if (!resize && specs.length === 1 && parentType(specs[0]) === 'FlowLayoutPanel') {
			const spec = specs[0];
			const order = siblingsOf(spec).map((c) => c.id);
			const i = order.indexOf(spec.id);
			const j = i + (dx + dy > 0 ? 1 : -1);
			if (j < 0 || j >= order.length) return;
			[order[i], order[j]] = [order[j], order[i]];
			post({ type: 'apply', ops: [{ op: 'reorder', id: spec.parent, order }] });
			return;
		}
		if (!resize && specs.length === 1 && parentType(specs[0]) === 'TableLayoutPanel') {
			const spec = specs[0];
			const table = findControl(spec.parent);
			const cell = effectiveCell(spec);
			if (!cell) return;
			const column = cell.column + dx, row = cell.row + dy;
			if (column < 0 || row < 0 || column >= tracksOf(table, 'columns').length || row >= tracksOf(table, 'rows').length) return;
			post({ type: 'apply', ops: moveToCellOps(spec, table, column, row) });
			return;
		}

		const ops = [];
		for (const s of specs) {
			if (propOr(s, 'dock', 'DockNone') !== 'DockNone' || parentType(s) === 'FlowLayoutPanel' || parentType(s) === 'TableLayoutPanel') continue;
			const b = { x: s.x, y: s.y, w: s.w, h: s.h };
			if (resize) {
				b.w = Math.max(1, b.w + dx * step);
				b.h = Math.max(1, b.h + dy * step);
			} else {
				b.x = Math.max(0, b.x + dx * step);
				b.y = Math.max(0, b.y + dy * step);
			}
			ops.push({ op: 'setBounds', id: s.id, x: b.x, y: b.y, w: b.w, h: b.h });
		}
		if (ops.length) post({ type: 'apply', ops });
	}

	// siblingsOf lists the canvas controls sharing spec's container, in
	// model order - back to front, the order they are added in.
	function siblingsOf(spec) {
		const key = parentKey(spec.parent, spec.parentSlot);
		return canvasControls().filter((c) => parentKey(c.parent, c.parentSlot) === key);
	}

	// zorder is Bring to Front (front) and Send to Back. The framework draws
	// the child added last on top, so the selected controls move to the end
	// (or the start) of their container's list - which also changes the
	// order they dock in, exactly as it does in WinForms.
	function zorder(front) {
		const byKey = new Map();
		for (const s of selectedSpecs()) {
			if (isComponent(s) || !s.supported) continue;
			const key = parentKey(s.parent, s.parentSlot);
			if (!byKey.has(key)) byKey.set(key, s);
		}
		const ops = [];
		for (const [key, first] of byKey) {
			const all = siblingsOf(first).map((c) => c.id);
			const moving = all.filter((id) => selectedIds.has(id));
			const rest = all.filter((id) => !selectedIds.has(id));
			const order = front ? rest.concat(moving) : moving.concat(rest);
			if (order.join() === all.join()) continue;
			const [parent, slot] = splitParentKey(key);
			ops.push({ op: 'reorder', id: parent, parentSlot: slot, order });
		}
		if (ops.length) post({ type: 'apply', ops });
	}

	// -- Clipboard ----------------------------------------------------------
	//
	// The designer has the whole model of every control, so a copy is that
	// model - the selected controls and everything standing on them - and a
	// paste is a batch of "add" ops that rebuild it under new names. The
	// extension keeps the copy, so it pastes into another form too.

	// clipRoots are the selected controls that are not inside another
	// selected one: copying a panel and its button copies the button once.
	function clipRoots() {
		const specs = selectedSpecs().filter((s) => s.supported);
		const ids = new Set(specs.map((s) => s.id));
		return specs.filter((s) => !isInsideAny(s.parent || '', ids));
	}

	function clipboardPayload(roots) {
		const keep = new Set(roots.map((r) => r.id));
		for (const r of roots) {
			for (const c of model.controls) {
				if (isInsideAny(c.id, new Set([r.id]))) keep.add(c.id);
			}
		}
		// Model order: a container's block comes before its children's, so
		// pasting in this order always has the parent there first.
		const controls = model.controls.filter((c) => keep.has(c.id)).map((c) => JSON.parse(JSON.stringify(c)));
		return { roots: roots.map((r) => r.id), controls };
	}

	function copySelection() {
		const roots = clipRoots();
		if (!roots.length) return;
		post({ type: 'copy', data: clipboardPayload(roots) });
		showToast(roots.length === 1 ? `Copied ${roots[0].id}` : `Copied ${roots.length} controls`, 'info');
	}

	function cutSelection() {
		const roots = clipRoots();
		if (!roots.length) return;
		post({ type: 'copy', data: clipboardPayload(roots) });
		deleteSelection();
	}

	// duplicateSelection is Ctrl+D: a copy of each selected control in its
	// own container, a step down and right, without touching the clipboard.
	function duplicateSelection() {
		const roots = clipRoots();
		if (!roots.length) return;
		pasteControls(clipboardPayload(roots), true, 'own');
	}

	// pasteTarget is where a paste goes: into the selected container, or
	// beside the selected control, or onto the form.
	function pasteTarget() {
		const sel = selectedId ? findControl(selectedId) : null;
		if (!sel || isComponent(sel)) return { parent: '', slot: '' };
		const slots = slotsFor(sel);
		if (slots.length) {
			const shown = slotNameFor(sel, Math.min(pageChoice[sel.id] || 0, slots.length - 1));
			return { parent: sel.id, slot: slotChoice[sel.id] || (slots.includes(shown) ? shown : slots[0]) };
		}
		const desc = catalog[sel.type];
		if (desc && desc.IsContainer) return { parent: sel.id, slot: '' };
		return { parent: sel.parent || '', slot: sel.parentSlot || '' };
	}

	// pasteControls turns a copy into ops. sameForm keeps the event handlers,
	// which only exist in the form the controls were copied from. target is
	// null for "where the selection says" and 'own' for each control's own
	// container (a duplicate).
	function pasteControls(data, sameForm, target) {
		if (!data || !data.controls || !data.controls.length) {
			showToast('Nothing to paste', 'info');
			return;
		}
		const taken = new Set(model.controls.map((c) => c.id));
		const rename = new Map();
		for (const c of data.controls) {
			const id = taken.has(c.id) || !catalog[c.type] ? generateId(c.type, taken) : c.id;
			taken.add(id);
			rename.set(c.id, id);
		}
		const roots = new Set(data.roots);
		const common = target === 'own' ? null : pasteTarget();

		// One offset for the whole group, so its arrangement survives; enough
		// of one that the paste does not sit exactly on what is there.
		const firstRoot = data.controls.find((c) => roots.has(c.id) && !isComponent(c));
		let offset = 0;
		if (firstRoot) {
			const key = common ? parentKey(common.parent, common.slot) : parentKey(firstRoot.parent, firstRoot.parentSlot);
			const occupied = canvasControls().filter((c) => parentKey(c.parent, c.parentSlot) === key);
			offset = geo().pasteOffset(firstRoot, occupied, 8);
		}

		const ops = [];
		const pasted = [];
		for (const c of data.controls) {
			const desc = catalog[c.type];
			if (!desc) continue;
			const id = rename.get(c.id);
			const isRoot = roots.has(c.id);
			let parent = isRoot ? (common ? common.parent : c.parent || '') : rename.get(c.parent) || '';
			let slot = isRoot ? (common ? common.slot : c.parentSlot || '') : c.parentSlot || '';
			// A duplicate whose container is not on this form any more (or a
			// copy from another form) lands on the form.
			if (isRoot && parent && !findControl(parent)) {
				parent = '';
				slot = '';
			}
			const op = { op: 'add', id, type: c.type };
			if (desc.Custom) op.custom = desc.Custom;
			if (!desc.NonVisual) {
				Object.assign(op, { parent, parentSlot: slot, x: c.x + (isRoot ? offset : 0), y: c.y + (isRoot ? offset : 0), w: c.w, h: c.h });
				const parentSpec = isRoot ? findControl(parent) : data.controls.find((p) => p.id === c.parent);
				if (c.cell && parentSpec && parentSpec.type === 'TableLayoutPanel' && !slot) {
					const cols = tracksOf(parentSpec, 'columns').length, rows = tracksOf(parentSpec, 'rows').length;
					if (c.cell.column < cols && c.cell.row < rows) op.cell = c.cell;
				}
			}
			if (c.text) op.text = c.text;
			if (c.items) op.items = c.items;
			if (c.columns) op.columns = c.columns;
			if (c.tableColumns) op.tableColumns = c.tableColumns;
			if (c.tableRows) op.tableRows = c.tableRows;
			if (c.collection) {
				op.collection = c.collection.map((item) => (sameForm ? item : Object.assign({}, item, { handler: undefined })));
			}
			// References to the form's components - a ContextMenu, a
			// BindingSource, a ToolTip - follow the copy when the component was
			// copied with it, stay when this form has it, and are dropped
			// otherwise: they would name a field that does not exist.
			const refTo = (refId, refType) => {
				if (rename.has(refId) && data.controls.some((x) => x.id === refId && x.type === refType)) return rename.get(refId);
				const here = findControl(refId);
				return here && here.type === refType && sameForm ? refId : null;
			};
			if (c.props && Object.keys(c.props).length) {
				const props = {};
				for (const [k, v] of Object.entries(c.props)) {
					const kind = propKind(desc, k);
					if (kind.startsWith('ref:')) {
						const to = refTo(v, kind.slice(4));
						if (to) props[k] = to;
					} else if (kind !== 'image') {
						props[k] = v;
					}
				}
				if (Object.keys(props).length) op.props = props;
			}
			if (c.toolTips) {
				const tips = {};
				for (const [tip, text] of Object.entries(c.toolTips)) {
					const to = refTo(tip, 'ToolTip');
					if (to) tips[to] = text;
				}
				if (Object.keys(tips).length) op.toolTips = tips;
			}
			if (c.bindings) {
				const binds = {};
				for (const [prop, b] of Object.entries(c.bindings)) {
					const to = refTo(b.source, 'BindingSource');
					if (to) binds[prop] = { source: to, member: b.member };
				}
				if (Object.keys(binds).length) op.bindings = binds;
			}
			if (sameForm && c.events && Object.keys(c.events).length) op.events = c.events;
			ops.push(op);
			// A picture is the form folder's file; in the same form it can be
			// embedded again.
			for (const p of desc.Special || []) {
				if (sameForm && c.props && c.props[p]) ops.push({ op: 'setProp', id, prop: p, value: c.props[p] });
			}
			// The constructor carries the text of most types; for the rest
			// (a TextBox) it is a SetText call, which "add" does not write.
			if (c.text && desc.Setters && desc.Setters.SetText !== undefined) {
				ops.push({ op: 'setText', id, text: c.text });
			}
			if (isRoot) pasted.push(id);
		}
		if (!ops.length) return;
		selectIds(pasted);
		post({ type: 'apply', ops });
	}

	function basename(p) {
		return String(p).split(/[\\/]/).pop();
	}

	function findControl(id) {
		return model && model.controls.find((c) => c.id === id);
	}

	// isComponent separates the two halves of model.controls: the things
	// drawn on the form, and the things that merely belong to it - a Timer,
	// a file dialog. They are one list in the file and in the Go tool,
	// because they are all struct fields, and every piece of machinery here
	// that is about *drawing* has to ask which kind it is holding.
	function isComponent(spec) {
		const desc = spec && catalog && catalog[spec.type];
		return !!(desc && desc.NonVisual);
	}

	// canvasControls is what the canvas draws: everything except the tray.
	function canvasControls() {
		return model ? model.controls.filter((c) => !isComponent(c)) : [];
	}

	function trayControls() {
		return model ? model.controls.filter(isComponent) : [];
	}

	function setSelection(id, additive) {
		if (!additive) {
			selectedIds = new Set(id ? [id] : []);
			selectedId = id;
			return;
		}
		if (selectedIds.has(id)) {
			selectedIds.delete(id);
			if (selectedId === id) {
				selectedId = selectedIds.values().next().value || null;
			}
		} else {
			selectedIds.add(id);
			selectedId = id;
		}
	}

	function selectedSpecs() {
		return [...selectedIds].map(findControl).filter(Boolean);
	}

	// pruneSelection drops only the controls that are genuinely gone from the
	// new model, keeping the rest selected. Every edit answers with a whole
	// fresh model, so clearing the selection wholesale would empty the
	// properties panel after every property change made in it.
	function pruneSelection() {
		for (const id of [...selectedIds]) {
			if (!findControl(id)) selectedIds.delete(id);
		}
		if (selectedId && !findControl(selectedId)) {
			selectedId = selectedIds.values().next().value || null;
		}
	}

	// ctrlEl answers from the render map rather than the document, so it also
	// finds a control that is currently detached - one on a tab page other
	// than the one being designed.
	function ctrlEl(id) {
		return rendered.get(id) || document.querySelector('.ctrl[data-id="' + id + '"]');
	}

	// ---------------------------------------------------------------------
	// Top-level render
	// ---------------------------------------------------------------------

	function renderAll() {
		if (parseErrorMsg) {
			renderParseError();
			return;
		}
		if (!model || !catalog) {
			return;
		}
		ensureCanvasHost();
		wireCanvasToolbar();
		renderControlsTab();
		renderCanvas();
		applyZoom();
		renderTabBadges();
		renderTray();
		renderProperties();
		renderOutline();
	}

	// ---------------------------------------------------------------------
	// Side panel tabs
	// ---------------------------------------------------------------------

	function showTab(name) {
		activeTab = name;
		document.querySelectorAll('.side-tab').forEach((t) => {
			t.classList.toggle('active', t.dataset.tab === name);
		});
		$('controls-panel').hidden = name !== 'controls';
		$('properties-panel').hidden = name !== 'properties';
		const outline = $('outline-panel');
		if (outline) outline.hidden = name !== 'outline';
		const help = $('prop-help');
		if (help) help.hidden = name !== 'properties';
		if (name === 'outline') renderOutline();
	}

	document.querySelectorAll('.side-tab').forEach((tab) => {
		tab.addEventListener('click', () => showTab(tab.dataset.tab));
	});

	// The side panel's left edge is a splitter, as the Visual Studio
	// property window's is: the column and menu item editors want more room
	// than a property grid, and how much is the user's call. The width is
	// kept in the webview's state, so it survives the editor being hidden
	// and shown again.
	const SIDE_MIN = 220;
	function sideMax() { return Math.max(SIDE_MIN, Math.round(window.innerWidth * 0.6)); }
	function setSideWidth(w) {
		const panel = $('side-panel');
		if (!panel) return;
		const clamped = Math.min(sideMax(), Math.max(SIDE_MIN, Math.round(w)));
		panel.style.flexBasis = clamped + 'px';
		panel.style.maxWidth = clamped + 'px';
		return clamped;
	}
	(function wireSideResizer() {
		const panel = $('side-panel');
		const host = panel && panel.parentElement;
		if (!host || $('side-resizer')) return;
		const grip = document.createElement('div');
		grip.id = 'side-resizer';
		grip.title = 'Drag to resize the panel; double-click to reset it';
		host.insertBefore(grip, panel);
		const saved = (vscode.getState && vscode.getState()) || {};
		if (saved.sideWidth) setSideWidth(saved.sideWidth);
		const remember = (w) => {
			if (!vscode.setState) return;
			const st = (vscode.getState && vscode.getState()) || {};
			vscode.setState(Object.assign({}, st, { sideWidth: w }));
		};
		grip.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			grip.setPointerCapture(e.pointerId);
			grip.classList.add('dragging');
			const startX = e.clientX;
			const startW = panel.getBoundingClientRect().width;
			let last = startW;
			const move = (ev) => { last = setSideWidth(startW + (startX - ev.clientX)) || last; };
			const up = () => {
				grip.classList.remove('dragging');
				grip.removeEventListener('pointermove', move);
				grip.removeEventListener('pointerup', up);
				remember(last);
			};
			grip.addEventListener('pointermove', move);
			grip.addEventListener('pointerup', up);
		});
		grip.addEventListener('dblclick', () => {
			panel.style.flexBasis = '';
			panel.style.maxWidth = '';
			remember(0);
		});
	})();

	function renderParseError() {
		$('controls-panel').innerHTML = '';
		$('properties-panel').innerHTML = '';
		const scroll = $('canvas-scroll');
		scroll.innerHTML = '';
		const box = document.createElement('div');
		box.id = 'parse-error';
		const h2 = document.createElement('h2');
		h2.textContent = "This file isn't in a shape the designer can edit yet";
		const p = document.createElement('p');
		p.textContent =
			'GoForms Designer expects a struct embedding *goforms.Form with an initializeComponent() method (the generated half of the partial-class split). Details:';
		const pre = document.createElement('pre');
		pre.textContent = parseErrorMsg;
		box.appendChild(h2);
		box.appendChild(p);
		box.appendChild(pre);
		scroll.appendChild(box);
	}

	// ensureCanvasHost builds the canvas and its permanent furniture - the
	// title bar, the form's resize handle, the click-to-deselect listener -
	// exactly once, and returns the existing canvas on every later call.
	//
	// Rebuilding them per render would not replace them: the canvas element
	// survives a render, so each pass would bind another mousedown listener
	// to the same node and one click would run every listener bound so far.
	function ensureCanvasHost() {
		let canvas = $('form-canvas');
		if (canvas) return canvas;

		const scrollHost = $('canvas-scroll');
		if (scrollHost && !scrollHost.dataset.deselectBound) {
			// Bound once, and marked so a later canvas rebuild does not stack
			// a second listener on the element that survives it.
			scrollHost.dataset.deselectBound = '1';
			scrollHost.addEventListener('mousedown', (e) => {
				if (e.target === scrollHost) {
					selectForm();
				}
			});
		}

		// A canvas built from scratch invalidates everything we were tracking.
		rendered.clear();
		prevDigests = [];

		const scroll = $('canvas-scroll');
		scroll.innerHTML = '';
		canvas = document.createElement('div');
		canvas.id = 'form-canvas';

		const titleBar = document.createElement('div');
		titleBar.className = 'form-titlebar';
		canvas.appendChild(titleBar);

		// Three grips, as a real window has: the right edge for width, the
		// bottom edge for height, the corner for both. A single corner dot
		// meant every resize was diagonal, and it was a 14px target - on a
		// form larger than the visible canvas it also sat past the scroll.
		// The edges are full-length, so there is always something to grab.
		for (const [cls, axis, hint] of [
			['form-grip-right', 'x', 'Drag to change the form width'],
			['form-grip-bottom', 'y', 'Drag to change the form height'],
			['form-grip-corner', 'xy', 'Drag to resize the form'],
		]) {
			const grip = document.createElement('div');
			grip.className = 'form-grip ' + cls;
			grip.title = hint;
			grip.addEventListener('mousedown', (e) => onFormResizeMouseDown(e, axis));
			canvas.appendChild(grip);
		}

		// Clicking the form - its background, or its title bar - selects the
		// form itself, which is how you get back out of a control's
		// properties. `e.target === canvas` is the test for "not on a child",
		// since a control's own handler stops the event before it gets here.
		canvas.addEventListener('mousedown', (e) => {
			if (e.target === canvas && e.button !== 2) {
				if (!(e.ctrlKey || e.metaKey || e.shiftKey)) selectForm();
				// A drag on the form's background draws a selection rectangle.
				if (!tabOrderMode) startLasso(e, '', '', canvas);
			}
		});
		titleBar.addEventListener('mousedown', selectForm);
		// Double-clicking the form wires its Load, as in Visual Studio.
		canvas.addEventListener('dblclick', (e) => {
			if (e.target === canvas || e.target === titleBar) wireDefaultEvent(null);
		});
		canvas.addEventListener('contextmenu', (e) => {
			if (e.target === canvas || e.target === titleBar) showContextMenu(e, null, null);
		});

		scroll.appendChild(canvas);
		return canvas;
	}

	// ---------------------------------------------------------------------
	// Canvas modes: zoom, lock, tab order
	// ---------------------------------------------------------------------

	// toFormPx converts a distance measured on screen into form pixels. Every
	// drag, resize and hit test has to go through it: at 200% a 10-pixel
	// mouse move is a 5-pixel move on the form, and skipping the conversion
	// makes controls run away from the cursor at any zoom but 100%.
	function toFormPx(screenPx) {
		return screenPx / zoom;
	}

	function applyZoom() {
		const canvas = $('form-canvas');
		if (!canvas || !model) return;
		if (zoomMode === 'fit') {
			zoom = fitZoom();
		}
		canvas.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
		canvas.style.transformOrigin = 'top left';
		// A transform does not change an element's layout box, so the scroll
		// area would offer scrollbars for the unscaled size and clip a form
		// drawn larger than it. The margin makes up the difference.
		canvas.style.marginRight = zoom === 1 ? '' : model.formWidth * (zoom - 1) + 'px';
		canvas.style.marginBottom = zoom === 1 ? '' : model.formHeight * (zoom - 1) + 'px';
	}

	// fitZoom is the largest scale at which the whole form fits the visible
	// area, never above 100% - a small form blown up to fill the window is
	// not what "fit" means to anyone.
	function fitZoom() {
		const scroll = $('canvas-scroll');
		if (!scroll || !model || !model.formWidth || !model.formHeight) return 1;
		const pad = 48; // the scroll host's padding, both sides
		const w = (scroll.clientWidth || 0) - pad;
		const h = (scroll.clientHeight || 0) - pad;
		if (w <= 0 || h <= 0) return 1;
		return Math.min(1, w / model.formWidth, h / model.formHeight);
	}

	function setZoom(value) {
		zoomMode = value;
		zoom = value === 'fit' ? fitZoom() : Number(value) || 1;
		applyZoom();
	}

	function setLocked(on) {
		locked = on;
		const btn = $('lock-toggle');
		if (btn) {
			btn.classList.toggle('active', on);
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
		}
		const canvas = $('form-canvas');
		if (canvas) canvas.classList.toggle('locked', on);
	}

	function setTabOrderMode(on) {
		tabOrderMode = on;
		const btn = $('taborder-toggle');
		if (btn) {
			btn.classList.toggle('active', on);
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
		}
		const canvas = $('form-canvas');
		if (canvas) canvas.classList.toggle('tab-order', on);
		renderTabBadges();
	}

	// renderTabBadges draws the number Tab will visit each control at, over
	// the control itself. Tab order is a property of the whole form rather
	// than of any one control, and setting it one spin box at a time in the
	// property panel means holding the whole sequence in your head - which is
	// the reason Visual Studio has this mode at all.
	function renderTabBadges() {
		for (const el of document.querySelectorAll('.tab-badge')) {
			el.remove();
		}
		if (!tabOrderMode) return;
		for (const spec of canvasControls()) {
			const el = rendered.get(spec.id);
			if (!el) continue;
			const badge = document.createElement('div');
			badge.className = 'tab-badge';
			const idx = spec.props && spec.props.tabIndex;
			badge.textContent = idx === undefined || idx === '' ? '–' : String(idx);
			badge.title = `${spec.id}: tab index ${badge.textContent}`;
			el.appendChild(badge);
		}
	}

	// assignNextTabIndex is what a click does in tab order mode: the control
	// clicked takes the next number in the sequence. Clicking through the
	// form in the order you want is the whole interaction.
	function assignNextTabIndex(spec) {
		const used = canvasControls()
			.map((c) => Number((c.props && c.props.tabIndex) ?? NaN))
			.filter((n) => Number.isFinite(n));
		const next = used.length ? Math.max(...used) + 1 : 0;
		post({ type: 'apply', ops: [{ op: 'setProp', id: spec.id, prop: 'tabIndex', value: String(next) }] });
	}

	function wireCanvasToolbar() {
		const zoomSelect = $('zoom-select');
		if (zoomSelect && !zoomSelect.dataset.bound) {
			zoomSelect.dataset.bound = '1';
			zoomSelect.addEventListener('change', () => setZoom(zoomSelect.value));
		}
		const lock = $('lock-toggle');
		if (lock && !lock.dataset.bound) {
			lock.dataset.bound = '1';
			lock.addEventListener('click', () => setLocked(!locked));
		}
		const tab = $('taborder-toggle');
		if (tab && !tab.dataset.bound) {
			tab.dataset.bound = '1';
			tab.addEventListener('click', () => setTabOrderMode(!tabOrderMode));
		}
	}

	// selectForm clears the control selection and shows the form's own
	// properties. Several things route here, because a form covered edge to
	// edge by a docked control has no background left to click.
	function selectForm() {
		setSelection(null, false);
		updateSelectionClasses();
		renderProperties();
	}

	// ---------------------------------------------------------------------
	// Toolbox
	// ---------------------------------------------------------------------

	// renderControlsTab draws the toolbox: every control type, grouped the way
	// the Visual Studio toolbox groups them. The groups and their order come
	// from the tool's catalog, so adding a control type never means editing a
	// list here as well.
	function renderControlsTab() {
		const host = $('controls-panel');
		host.innerHTML = '';

		const search = document.createElement('input');
		search.type = 'text';
		search.className = 'toolbox-search';
		search.placeholder = 'Search controls';
		search.value = toolboxFilter;
		search.addEventListener('input', () => {
			toolboxFilter = search.value;
			renderControlsTab();
			// Re-rendering replaces the box, so put the caret back or every
			// keystroke after the first would land nowhere.
			const next = $('controls-panel').querySelector('.toolbox-search');
			if (next) {
				next.focus();
				next.setSelectionRange(next.value.length, next.value.length);
			}
		});
		host.appendChild(search);

		// The project's own controls are read from its source when the
		// designer opens; ↻ reads them again after adding one.
		const rescan = document.createElement('button');
		rescan.className = 'toolbox-rescan';
		rescan.textContent = '↻ Project controls';
		rescan.title = 'Look for the project\'s own controls again (types that embed a GoForms control, with a NewX constructor)';
		rescan.addEventListener('click', () => post({ type: 'rescanToolbox' }));
		host.appendChild(rescan);

		const filter = toolboxFilter.trim().toLowerCase();
		const groups = new Map();
		for (const type of Object.keys(catalog).sort()) {
			// "Form" is served with the catalog so the form's own panel can be
			// built from the same data as every control's, but it is not a
			// palette entry: it cannot be added, removed, renamed or parented.
			if (type === 'Form') continue;
			if (filter && !type.toLowerCase().includes(filter)) continue;
			const cat = catalog[type].Category || 'Common Controls';
			if (!groups.has(cat)) groups.set(cat, []);
			groups.get(cat).push(type);
		}

		// Known categories first, in the tool's order; anything unexpected
		// still gets shown rather than silently dropped.
		const order = [...categories, ...[...groups.keys()].filter((c) => !categories.includes(c))];
		let shown = 0;
		for (const cat of order) {
			const types = groups.get(cat);
			if (!types || !types.length) continue;
			shown += types.length;

			const title = document.createElement('div');
			title.className = 'toolbox-group';
			title.textContent = cat;
			host.appendChild(title);

			for (const type of types) {
				const btn = document.createElement('button');
				btn.className = 'toolbox-item';
				const custom = catalog[type].Custom;
				btn.textContent = custom ? custom.name : catalog[type].Type || type;
				btn.title = custom ? `Add a new ${type} (from ${custom.import})` : `Add a new ${type}`;
				btn.addEventListener('click', () => addControl(type));
				host.appendChild(btn);
			}
		}

		if (!shown) {
			const empty = document.createElement('div');
			empty.className = 'prop-empty';
			empty.textContent = `No control matches "${toolboxFilter}".`;
			host.appendChild(empty);
		}
	}

	function addControl(type) {
		const desc = catalog[type];
		if (!desc) {
			return;
		}

		// A tray component goes nowhere in particular: it has no bounds and
		// no container, and dropping it while a Panel happens to be selected
		// must not try to parent it onto that panel.
		if (desc.NonVisual) {
			const trayId = generateId(type);
			post({ type: 'apply', ops: [{ op: 'add', id: trayId, type }] });
			setSelection(trayId, false);
			showTab('properties');
			return;
		}

		let parent = '';
		let slot = '';
		if (selectedId) {
			const sel = findControl(selectedId);
			const selDesc = sel && catalog[sel.type];
			const selSlots = sel ? slotsFor(sel) : [];
			if (selSlots.length) {
				// A slotted container takes children only through one of its
				// parts; default to the half the user last clicked, or the
				// page currently being designed.
				parent = sel.id;
				const shown = slotNameFor(sel, Math.min(pageChoice[sel.id] || 0, selSlots.length - 1));
				slot = slotChoice[sel.id] || (selSlots.includes(shown) ? shown : selSlots[0]);
			} else if (selDesc && selDesc.IsContainer) {
				parent = sel.id;
			}
		}

		const id = generateId(type);
		const custom = desc.Custom;
		const siblingCount = model.controls.filter(
			(c) => parentKey(c.parent, c.parentSlot) === parentKey(parent, slot)
		).length;
		const step = 18;
		const cascade = siblingCount % 10;
		const x = 20 + cascade * step;
		const y = 20 + cascade * step;

		post({
			type: 'apply',
			ops: [
				{
					op: 'add',
					id,
					type,
					parent,
					parentSlot: slot,
					x,
					y,
					w: desc.DefaultW,
					h: desc.DefaultH,
					// A project control has no text of its own to seed.
					text: custom ? undefined : type,
					custom,
				},
			],
		});
		setSelection(id, false);
	}

	function generateId(type, taken) {
		// A project control is named after its type, not its package:
		// widgets.Gauge makes gauge1.
		const name = catalog && catalog[type] && catalog[type].Custom ? catalog[type].Custom.name : type.split('.').pop();
		const base = name.charAt(0).toLowerCase() + name.slice(1);
		const existing = taken || new Set(model.controls.map((c) => c.id));
		let n = 1;
		while (existing.has(base + n)) {
			n++;
		}
		return base + n;
	}

	// ---------------------------------------------------------------------
	// Canvas
	// ---------------------------------------------------------------------

	// renderCanvas brings the canvas in line with the model by changing only
	// what actually differs. The Go tool answers every edit with a complete
	// fresh model, so rendering it wholesale would destroy and rebuild every
	// element to move one button four pixels - discarding the listeners,
	// focus and scroll positions attached to all of them.
	//
	// The diff itself lives in media/renderPlan.js so it can be tested and
	// measured; this function only carries the plan out.
	function renderCanvas() {
		const canvas = ensureCanvasHost();
		canvas.style.width = model.formWidth + 'px';
		canvas.style.height = model.formHeight + 'px';
		const titleBar = canvas.querySelector('.form-titlebar');
		if (titleBar) {
			titleBar.textContent = `${model.formTitle}  (${model.formWidth}×${model.formHeight})  — ${model.receiverType}`;
		}
		renderMenuBar(canvas);
		canvas.style.backgroundColor = cssColor(model.formProps && model.formProps.backColor);

		const RP = globalThis.GoFormsRenderPlan;
		// The tray is rendered separately and must not reach the plan: a
		// component has no bounds, so the plan would create an element for it
		// and place it at 0,0 on top of the form.
		const next = RP.digestAll(canvasControls(), (id) => pageChoice[id] || 0);
		const plan = RP.computeRenderPlan(prevDigests, next);
		prevDigests = next;
		if (RP.isNoop(plan)) return;

		applyRenderPlan(plan);
		updateSelectionClasses();
	}

	// renderMenuBar draws the form's MenuStrip above its client area, where
	// the window puts it: a click on a menu selects the MenuStrip and opens
	// its items in the property panel.
	function renderMenuBar(canvas) {
		const menu = model.controls.find((c) => c.type === 'MenuStrip');
		let bar = canvas.querySelector('.form-menubar');
		canvas.classList.toggle('has-menu', !!menu);
		if (!menu) {
			if (bar) bar.remove();
			return;
		}
		if (!bar) {
			bar = document.createElement('div');
			bar.className = 'form-menubar';
			canvas.appendChild(bar);
		}
		bar.innerHTML = '';
		const tops = collectionOf(menu).filter((it) => !it.depth);
		for (const it of tops.length ? tops : [{ text: '(empty menu)' }]) {
			const m = document.createElement('span');
			m.className = 'form-menu';
			m.textContent = it.text;
			m.title = `${menu.id}: edit the menu's items in the property panel`;
			m.addEventListener('mousedown', (e) => {
				e.stopPropagation();
				const live = model.controls.find((c) => c.type === 'MenuStrip');
				if (!live) return;
				setSelection(live.id, false);
				updateSelectionClasses();
				renderProperties();
				renderOutline();
				revealGroup('Items');
			});
			bar.appendChild(m);
		}
	}

	// ---------------------------------------------------------------------
	// The component tray
	// ---------------------------------------------------------------------

	// renderTray draws the strip below the form holding the components that
	// have no appearance. Visual Studio puts them there for one reason worth
	// repeating: they are part of the form and have properties and events
	// like anything else, and a Timer you cannot see is a Timer you cannot
	// select, rename, configure or delete without leaving the designer.
	//
	// It rebuilds wholesale rather than diffing like the canvas does: there
	// are rarely more than a handful, they carry no listeners worth
	// preserving, and nothing is being dragged around in here.
	function renderTray() {
		const host = $('component-tray');
		const items = $('component-tray-items');
		if (!host || !items) return;

		const specs = trayControls();
		host.hidden = specs.length === 0;
		trayEls.clear();
		items.innerHTML = '';

		for (const spec of specs) {
			const el = document.createElement('button');
			el.type = 'button';
			el.className = 'tray-item';
			el.dataset.id = spec.id;

			const icon = document.createElement('span');
			icon.className = 'tray-icon';
			icon.textContent = trayGlyph(spec.type);
			el.appendChild(icon);

			const name = document.createElement('span');
			name.className = 'tray-name';
			name.textContent = spec.id;
			el.appendChild(name);

			el.title = `${spec.type} — ${trayHint(spec)}`;
			el.addEventListener('click', (e) => {
				setSelection(spec.id, e.ctrlKey || e.metaKey || e.shiftKey);
				updateSelectionClasses();
				renderProperties();
				showTab('properties');
			});
			items.appendChild(el);
			trayEls.set(spec.id, el);
		}
		updateSelectionClasses();
	}

	// trayGlyph is a one-character stand-in for an icon set the extension
	// does not ship. It only has to make the four dialogs distinguishable
	// from each other at a glance; the name beside it does the rest.
	function trayGlyph(type) {
		switch (type) {
			case 'Timer':
				return '⏱';
			case 'OpenFileDialog':
				return '📂';
			case 'SaveFileDialog':
				return '💾';
			case 'FolderBrowserDialog':
				return '🗂';
			case 'ColorDialog':
				return '🎨';
			case 'MenuStrip':
				return '☰';
			case 'ContextMenu':
				return '▤';
			case 'ToolTip':
				return '💬';
			case 'BindingSource':
				return '🔗';
			default:
				return '⚙';
		}
	}

	// trayHint summarizes a component in the one line its tooltip has, so the
	// state that matters most - is the timer running, and how often - is
	// visible without selecting it.
	function trayHint(spec) {
		if (spec.type === 'Timer') {
			const ms = (spec.props && spec.props.interval) || '1000';
			const on = spec.props && spec.props.enabled === 'true';
			return `${ms} ms, ${on ? 'started' : 'not started'}`;
		}
		const title = spec.props && spec.props.title;
		return title ? `"${title}"` : 'not on the form; select it to set its properties';
	}

	function applyRenderPlan(plan) {
		const RP = globalThis.GoFormsRenderPlan;

		// A rebuild is a remove followed by a create: the two kinds of
		// element are built by different code paths, so one can't be patched
		// into the other.
		for (const id of plan.remove.concat(plan.rebuild)) {
			const el = rendered.get(id);
			if (el) el.remove();
			rendered.delete(id);
		}

		const created = plan.create.concat(plan.rebuild);
		for (const id of created) {
			const spec = findControl(id);
			if (spec) rendered.set(id, buildControlEl(spec));
		}
		for (const id of plan.content) {
			const spec = findControl(id);
			const el = rendered.get(id);
			if (spec && el) updateControlContent(el, spec);
		}
		for (const id of plan.bounds) {
			const spec = findControl(id);
			const el = rendered.get(id);
			if (spec && el) applyBounds(el, spec);
		}

		// Work out which containers need their children (re)inserted or laid
		// out again. Bounds and props are in the list because docking is a
		// property of the whole container: resizing one docked control, or
		// docking it at all, moves its siblings too.
		const keys = new Set(plan.reorder);
		for (const id of created.concat(plan.move, plan.bounds, plan.content)) {
			const spec = findControl(id);
			if (spec) keys.add(RP.parentKey(spec.parent, spec.parentSlot));
		}
		for (const id of plan.content) {
			const spec = findControl(id);
			if (!spec) continue;
			// Re-rendering a slotted control's content threw away the panes
			// its children were living in, so they have to be put back.
			for (const slot of slotsFor(spec)) {
				keys.add(RP.parentKey(spec.id, slot));
			}
		}
		// A container whose size, padding or layout settings changed moves
		// its own children: a flow rewraps, a table's cells resize.
		for (const id of plan.content.concat(plan.bounds)) {
			const spec = findControl(id);
			if (spec && catalog[spec.type] && catalog[spec.type].IsContainer) keys.add(RP.parentKey(spec.id, ''));
		}
		for (const key of keys) {
			placeChildren(key);
		}
	}

	// placeChildren inserts a container's children in model order. appendChild
	// moves an element that is already there, so running it in order both
	// places new children and fixes z-order, and leaves the canvas's own title
	// bar and resize handle in front where they were created.
	function placeChildren(key) {
		const [parent, slot] = splitParentKey(key);
		const host = containerElFor(parent, slot);
		// Tray components are nominally children of the Form - that is what
		// having no parent means - but they have no element and no bounds,
		// so the docking pass below must not try to lay them out.
		const kids = canvasControls().filter((c) => parentKey(c.parent, c.parentSlot) === key);
		for (const spec of kids) {
			const el = rendered.get(spec.id);
			if (!el) continue;
			// No host means the page this control is on isn't the one being
			// designed - detach it rather than leaving it somewhere stale.
			if (host) {
				host.appendChild(el);
			} else {
				el.remove();
			}
		}
		if (host) {
			layoutChildren(parent, slot, host, kids);
		}
	}

	// layoutChildren puts each child where the running form will put it. A
	// docked control ignores its own x/y and glues itself to an edge of the
	// parent, taking whatever the other docked siblings left - so drawing its
	// stored bounds showed something the app never looked like. A flow
	// places its children one after another, and a table puts each in its
	// cell, for the same reason.
	//
	// The rules are ported in media/dockLayout.js and media/panelLayout.js
	// and checked against GoForms' own layout by the golden tests.
	function layoutChildren(parent, slot, host, kids) {
		const owner = parent && !slot ? findControl(parent) : null;
		const place = (spec, r, cls) => {
			const el = rendered.get(spec.id);
			if (!el || !r) return;
			el.style.left = r.x + 'px';
			el.style.top = r.y + 'px';
			el.style.width = r.w + 'px';
			el.style.height = r.h + 'px';
			el.classList.toggle('docked', cls === 'docked');
			el.classList.toggle('in-flow', cls === 'in-flow');
			el.classList.toggle('in-cell', cls === 'in-cell');
		};

		if (owner && owner.type === 'FlowLayoutPanel') {
			const rects = panels().arrangeFlow(
				kids.map((s) => ({ w: s.w, h: s.h })),
				{ width: owner.w, height: owner.h },
				flowOptions(owner)
			);
			kids.forEach((spec, i) => place(spec, rects[i], 'in-flow'));
			return;
		}
		if (owner && owner.type === 'TableLayoutPanel') {
			const rects = panels().arrangeTable(
				kids.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, cell: s.cell })),
				tracksOf(owner, 'columns'),
				tracksOf(owner, 'rows'),
				{ width: owner.w, height: owner.h },
				paddingOf(owner.props && owner.props.padding)
			);
			kids.forEach((spec, i) => place(spec, rects[i], rects[i].inGrid ? 'in-cell' : ''));
			return;
		}

		const DL = globalThis.GoFormsDockLayout;
		const boxes = kids.map((s) => ({
			dock: propOr(s, 'dock', 'DockNone'),
			x: s.x,
			y: s.y,
			w: s.w,
			h: s.h,
		}));
		// Nothing docked is the common case, and then a control's own bounds
		// are the answer - no need to walk the arrangement at all.
		if (!DL.anyDocked(boxes)) {
			for (const spec of kids) {
				const el = rendered.get(spec.id);
				if (el) {
					applyBounds(el, spec);
					el.classList.remove('docked', 'in-flow', 'in-cell');
				}
			}
			return;
		}

		const padding = paddingOf(owner ? owner.props && owner.props.padding : !parent ? model.formProps && model.formProps.padding : '');
		const rects = DL.arrange(boxes, hostClientSize(parent, slot, host), padding);
		kids.forEach((spec, i) => {
			// Say so, rather than leaving the user to wonder why the control
			// won't stay where they put it.
			place(spec, rects[i], propOr(spec, 'dock', 'DockNone') !== 'DockNone' ? 'docked' : '');
		});
	}

	// paddingOf reads a padding property's wire value - "8" or
	// "left, top, right, bottom" - into the shape the layout ports take.
	function paddingOf(value) {
		const n = String(value || '')
			.split(',')
			.map((v) => parseFloat(v))
			.filter((v) => Number.isFinite(v));
		if (n.length === 1) return { left: n[0], top: n[0], right: n[0], bottom: n[0] };
		if (n.length === 4) return { left: n[0], top: n[1], right: n[2], bottom: n[3] };
		return { left: 0, top: 0, right: 0, bottom: 0 };
	}

	function flowOptions(flow) {
		return {
			direction: propOr(flow, 'flowDirection', 'FlowLeftToRight'),
			wrap: propOr(flow, 'wrapContents', 'true') !== 'false',
			spacing: Number(propOr(flow, 'spacing', '6')),
			padding: paddingOf(flow.props && flow.props.padding),
		};
	}

	// tracksOf is a table's columns or rows: the tool's list, or - for a
	// model that predates it - as many AutoSize tracks as the constructor
	// asks for.
	function tracksOf(table, which) {
		const list = which === 'columns' ? table.tableColumns : table.tableRows;
		if (list && list.length) return list;
		const n = Math.max(1, parseInt(propOr(table, which, '2'), 10) || 2);
		return Array.from({ length: n }, () => ({ type: 'AutoSize' }));
	}

	// tableGridOf lays out a table's tracks in its own coordinates.
	function tableGridOf(table) {
		return panels().tableGrid(tracksOf(table, 'columns'), tracksOf(table, 'rows'), { width: table.w, height: table.h }, paddingOf(table.props && table.props.padding));
	}

	// effectiveCell is the cell a table's child is really in: the one its
	// add call names, or the one AddControl's cursor gives it.
	function effectiveCell(spec) {
		const table = findControl(spec.parent);
		if (!table || table.type !== 'TableLayoutPanel') return null;
		const kids = canvasControls().filter((c) => c.parent === table.id && !c.parentSlot);
		const cells = panels().tableCells(kids, tracksOf(table, 'columns').length);
		const i = kids.findIndex((c) => c.id === spec.id);
		return i < 0 ? null : cells[i];
	}

	// moveToCellOps moves a table's child to a cell, swapping it with the
	// control already there - as dropping onto a taken cell does in Visual
	// Studio.
	function moveToCellOps(spec, table, column, row) {
		const from = spec.parent === table.id ? effectiveCell(spec) : null;
		const ops = [];
		const occupant = canvasControls().find((c) => {
			if (c.id === spec.id || c.parent !== table.id || c.parentSlot) return false;
			const cell = effectiveCell(c);
			return cell && cell.column === column && cell.row === row;
		});
		// Every child is pinned to its cell first: moving one auto-placed
		// control shifts the cursor every later AddControl follows, which
		// would move controls nobody touched.
		for (const c of canvasControls()) {
			if (c.parent !== table.id || c.parentSlot || c.cell || c.id === spec.id || (occupant && c.id === occupant.id)) continue;
			const cell = effectiveCell(c);
			if (cell && cell.row < tracksOf(table, 'rows').length) ops.push({ op: 'setCell', id: c.id, cell: { column: cell.column, row: cell.row } });
		}
		if (occupant && from) {
			ops.push({ op: 'setCell', id: occupant.id, cell: spanned(occupant, from.column, from.row) });
		}
		const target = spanned(spec, column, row);
		if (spec.parent === table.id) ops.push({ op: 'setCell', id: spec.id, cell: target });
		else ops.push({ op: 'setParent', id: spec.id, parent: table.id, parentSlot: '', cell: target });
		return ops;
	}

	// spanned keeps a control's spans when it moves to another cell.
	function spanned(spec, column, row) {
		const c = { column, row };
		if (spec.cell && spec.cell.columnSpan > 1) c.columnSpan = spec.cell.columnSpan;
		if (spec.cell && spec.cell.rowSpan > 1) c.rowSpan = spec.cell.rowSpan;
		return c;
	}

	// hostClientSize is the area a container lays its children out in. For the
	// form and for plain containers that is the model's own size; a slot pane
	// (a SplitContainer half, a tab page) is sized by the canvas' own CSS, so
	// it has to be measured.
	function hostClientSize(parent, slot, host) {
		if (!parent) {
			return { width: model.formWidth, height: model.formHeight };
		}
		if (!slot) {
			const spec = findControl(parent);
			if (spec) return { width: spec.w, height: spec.h };
		}
		return { width: host.clientWidth || 0, height: host.clientHeight || 0 };
	}

	function applyBounds(el, spec) {
		el.style.left = spec.x + 'px';
		el.style.top = spec.y + 'px';
		el.style.width = spec.w + 'px';
		el.style.height = spec.h + 'px';
	}

	// wireSlotPanes makes each half/page of a slotted control record which one
	// was clicked. It runs before the .ctrl mousedown that selects the
	// container, so a click on a half both selects the SplitContainer and
	// remembers which half was meant.
	function wireSlotPanes(el, spec) {
		for (const slot of slotsFor(spec)) {
			const pane = el.querySelector('[data-slot="' + slot + '"]');
			if (pane) {
				pane.addEventListener('mousedown', () => {
					slotChoice[spec.id] = slot;
				});
			}
		}
	}

	// updateControlContent redraws just the inside of a control, leaving the
	// element - and every listener on it - alone.
	function updateControlContent(el, spec) {
		applyStateClasses(el, spec);
		const previous = el.querySelector(':scope > .ctrl-content');
		let content;
		try {
			content = renderControlContent(spec, catalog[spec.type]);
		} catch (err) {
			content = renderGenericFallback(spec);
		}
		if (previous) {
			el.replaceChild(content, previous);
		} else {
			el.insertBefore(content, el.firstChild);
		}
		wireSlotPanes(el, spec);
		el.title = `${spec.type} · ${spec.id}`;
	}

	// applyStateClasses marks a control hidden or disabled - still drawn, so
	// it can be selected, but visibly not as it will run - and gives the
	// content the colors and font the framework would show. Only the
	// controls that really apply them get them (GoForms/style.go): a
	// Button's ForeColor is remembered and never drawn, and the canvas must
	// not claim otherwise.
	function applyStateClasses(el, spec) {
		el.classList.toggle('is-hidden', propOr(spec, 'visible', 'true') === 'false');
		el.classList.toggle('is-disabled', propOr(spec, 'enabled', 'true') === 'false');
		const fore = ['Label', 'GroupBox'].includes(spec.type) ? cssColor(propOr(spec, 'foreColor', '')) : '';
		const back = ['Panel', 'ScrollBox', 'FlowLayoutPanel', 'TableLayoutPanel'].includes(spec.type) ? cssColor(propOr(spec, 'backColor', '')) : '';
		const font = ['Label', 'GroupBox'].includes(spec.type) ? parseFont(propOr(spec, 'font', '')) : null;
		el.style.color = fore;
		el.style.backgroundColor = back;
		el.style.fontFamily = font && font.family ? font.family : '';
		el.style.fontSize = font && font.size ? font.size + 'px' : '';
		el.style.fontWeight = font && font.bold ? '700' : '';
		el.style.fontStyle = font && font.italic ? 'italic' : '';
	}

	// imageUrl is where the webview loads a picture of the form's folder.
	function imageUrl(rel) {
		if (!rel || !resourceBase) return '';
		return resourceBase.replace(/\/$/, '') + '/' + String(rel).split('/').map(encodeURIComponent).join('/');
	}

	// cssColor turns the tool's "#rrggbb"/"#rrggbbaa" into CSS, or "".
	function cssColor(v) {
		const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(v || '').trim());
		if (!m) return '';
		if (!m[2]) return '#' + m[1];
		const n = parseInt(m[1], 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(parseInt(m[2], 16) / 255).toFixed(3)})`;
	}

	// parseFont reads the tool's "family, size[, Bold][, Italic]".
	function parseFont(v) {
		const f = String(v || '').split(',').map((x) => x.trim());
		if (f.length < 2) return null;
		const styles = f.slice(2).map((x) => x.toLowerCase());
		return { family: f[0], size: parseFloat(f[1]) || 0, bold: styles.includes('bold'), italic: styles.includes('italic') };
	}

	// defaultEventOf is what a double-click wires: the type's own first
	// event (TextChanged, CheckedChanged, Tick...), else Click - and Load for
	// the form. That is the [DefaultEvent] rule WinForms types follow.
	function defaultEventOf(desc, isForm) {
		if (isForm) return 'Load';
		if (desc && desc.OwnEventCount > 0 && desc.Events && desc.Events.length) return desc.Events[0];
		return desc && desc.Events && desc.Events.includes('Click') ? 'Click' : (desc && desc.Events && desc.Events[0]) || '';
	}

	// wireDefaultEvent writes the handler stub for the default event and
	// opens it, or opens the one already wired.
	function wireDefaultEvent(spec) {
		const isForm = !spec;
		const desc = isForm ? catalog.Form : catalog[spec.type];
		const event = defaultEventOf(desc, isForm);
		if (!event) return;
		const events = isForm ? model.formEvents || {} : spec.events || {};
		const id = isForm ? '' : spec.id;
		if (events[event]) {
			post({ type: 'gotoHandler', id, event, handler: events[event] });
			return;
		}
		const handler = `${isForm ? model.receiverType : spec.id}_${event}`;
		const paramType = (desc && desc.EventArgs && desc.EventArgs[event]) || 'EventArgs';
		post({ type: 'wireEvent', id, event, handler, paramType, reveal: true });
	}

	// tableCellAt is the cell of a table under a mouse event, for the
	// context menu's insert and delete - or null when there is no table
	// there.
	function tableCellAt(spec, e) {
		const table = spec.type === 'TableLayoutPanel' ? spec : spec.parent && !spec.parentSlot ? findControl(spec.parent) : null;
		if (!table || table.type !== 'TableLayoutPanel') return null;
		const el = rendered.get(table.id);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return panels().cellAt(tableGridOf(table), toFormPx((e.clientX || 0) - r.left), toFormPx((e.clientY || 0) - r.top));
	}

	// parentKey identifies one coordinate origin children are placed in: the
	// form, a container, or one named half of a container.
	function parentKey(parent, slot) {
		return (parent || '') + (slot ? '/' + slot : '');
	}

	// containerElFor returns the DOM element that is the given key's
	// coordinate origin, which is where a child's absolute x/y is measured
	// from.
	function containerElFor(parent, slot) {
		if (!parent) return $('form-canvas');
		const owner = ctrlEl(parent);
		if (!owner) return null;
		return slot ? owner.querySelector('[data-slot="' + slot + '"]') : owner;
	}

	// isInsideAny reports whether id sits anywhere under one of the given
	// controls, so a drag can refuse to drop a container into its own child.
	function isInsideAny(id, ids) {
		let cur = findControl(id);
		while (cur) {
			if (ids.has(cur.id)) return true;
			cur = cur.parent ? findControl(cur.parent) : null;
		}
		return false;
	}

	// buildControlEl creates a control's element. The element then lives for as
	// long as the control does, so its listeners must never close over `spec`:
	// that object is replaced wholesale by every model refresh, and a captured
	// one goes stale the moment anything is edited. They look the current
	// spec up by id instead.
	function buildControlEl(spec) {
		const id = spec.id;
		const desc = catalog[spec.type];
		const d = document.createElement('div');
		const classes = ['ctrl', 'type-' + spec.type];
		if (spec.id === selectedId) classes.push('selected');
		if (!spec.supported) classes.push('unsupported');
		if (desc && desc.IsContainer) classes.push('is-container');
		d.className = classes.join(' ');
		applyBounds(d, spec);
		applyStateClasses(d, spec);
		d.dataset.id = spec.id;
		d.title = spec.supported
			? `${spec.type} · ${spec.id}`
			: `${spec.type} · ${spec.id} — unrecognized control type, shown read-only. This control's source is left untouched.`;

		if (spec.supported) {
			// Realistic, per-type rendered content (buttons that look like
			// buttons, checkboxes with real glyphs, etc). See
			// renderControlContent() below for the per-type dispatch table.
			let content;
			try {
				content = renderControlContent(spec, desc);
			} catch (err) {
				content = renderGenericFallback(spec);
			}
			d.appendChild(content);
			wireSlotPanes(d, spec);
		} else {
			// Unsupported controls keep the original generic tag+text
			// placeholder look - this path is intentionally unchanged.
			const label = document.createElement('div');
			label.className = 'ctrl-label';
			const tag = document.createElement('span');
			tag.className = 'ctrl-tag';
			tag.textContent = `${spec.type}?`;
			label.appendChild(tag);
			const text = document.createElement('div');
			text.className = 'ctrl-text';
			text.textContent = spec.text || spec.id;
			label.appendChild(text);
			d.appendChild(label);
		}

		if (spec.supported) {
			const handle = document.createElement('div');
			handle.className = 'resize-handle';
			handle.addEventListener('mousedown', (e) => {
				const live = findControl(id);
				if (live) onResizeMouseDown(e, live, d);
			});
			d.appendChild(handle);
			d.addEventListener('mousedown', (e) => {
				const live = findControl(id);
				if (live) onCtrlMouseDown(e, live, d);
			});
			// Double-click wires the control's default event (Click,
			// TextChanged, CheckedChanged...) and goes to the handler.
			d.addEventListener('dblclick', (e) => {
				e.stopPropagation();
				const live = findControl(id);
				if (live && !tabOrderMode) wireDefaultEvent(live);
			});
			d.addEventListener('contextmenu', (e) => {
				const live = findControl(id);
				if (live) showContextMenu(e, live, tableCellAt(live, e));
			});
		} else {
			// Unsupported controls are read-only: selectable (so the user can
			// see its info in the properties panel) but not draggable/resizable.
			d.addEventListener('mousedown', (e) => {
				e.stopPropagation();
				setSelection(id, false);
				updateSelectionClasses();
				renderProperties();
				showTab('properties');
			});
		}

		return d;
	}

	// ---------------------------------------------------------------------
	// Per-type realistic control rendering
	// ---------------------------------------------------------------------
	//
	// Each renderer takes a ControlSpec and returns a single DOM element to
	// place inside the (already positioned/bordered) `.ctrl` box. Content
	// fills the box (`width/height: 100%`, `box-sizing: border-box`) and is
	// non-interactive (`pointer-events: none`) so the existing drag/resize/
	// select mousedown wiring on the outer `.ctrl` element keeps working
	// untouched - see the `.ctrl-content` base rule in designer.css.

	function contentBase(extraClass) {
		const c = document.createElement('div');
		c.className = extraClass ? 'ctrl-content ' + extraClass : 'ctrl-content';
		return c;
	}

	// -- Shared text metrics -----------------------------------------------
	//
	// Several renderers reproduce geometry the Go side computes from Fyne's
	// text metrics. FYNE_TEXT_H is the height one line of text occupies at
	// Fyne's default theme.TextSize(); measureTextPx approximates
	// fyne.MeasureText's width using the same font the canvas draws with, so
	// the preview is at least self-consistent where the browser's metrics
	// differ slightly from Fyne's.
	const FYNE_TEXT_H = 19;

	let measureCtx = null;

	function measureTextPx(text, px, bold) {
		if (!measureCtx) {
			measureCtx = document.createElement('canvas').getContext('2d');
		}
		const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
		measureCtx.font = `${bold ? '600 ' : ''}${px}px ${family}`;
		return measureCtx.measureText(text || '').width;
	}

	function propOr(spec, key, fallback) {
		const v = spec.props && spec.props[key];
		return v !== undefined && v !== '' ? v : fallback;
	}

	function renderGenericFallback(spec) {
		const label = document.createElement('div');
		label.className = 'ctrl-label';
		const tag = document.createElement('span');
		tag.className = 'ctrl-tag';
		tag.textContent = spec.type;
		label.appendChild(tag);
		const text = document.createElement('div');
		text.className = 'ctrl-text';
		text.textContent = spec.text || spec.id;
		label.appendChild(text);
		return label;
	}

	function renderLabel(spec) {
		const c = contentBase('cc-label');
		c.textContent = spec.text || spec.id;
		return c;
	}

	function renderButton(spec) {
		const c = contentBase('cc-button');
		c.textContent = spec.text || spec.id;
		return c;
	}

	function renderTextBox(spec) {
		const variant = propOr(spec, 'variant', 'single');
		const c = contentBase('cc-textbox' + (variant === 'multiline' ? ' cc-textbox-multiline' : ''));
		let display = spec.text || '';
		let isPlaceholder = false;
		if (!display) {
			display = propOr(spec, 'placeholder', '');
			isPlaceholder = true;
		}
		if (variant === 'password' && display && !isPlaceholder) {
			display = '•'.repeat(Math.min(display.length, 30));
		}
		const span = document.createElement('span');
		span.className = 'cc-textbox-text' + (isPlaceholder ? ' placeholder' : '');
		span.textContent = display;
		c.appendChild(span);
		return c;
	}

	function renderCheckLike(spec, shape) {
		const checked = propOr(spec, 'checked', 'false') === 'true';
		const c = contentBase('cc-checklike');
		const glyph = document.createElement('span');
		glyph.className = 'cc-glyph-box' + (shape === 'circle' ? ' cc-radio' : '') + (checked ? ' checked' : '');
		if (shape === 'circle') {
			const dot = document.createElement('span');
			dot.className = 'cc-radio-dot';
			glyph.appendChild(dot);
		} else if (checked) {
			glyph.textContent = '✓';
		}
		const label = document.createElement('span');
		label.className = 'cc-checklike-label';
		label.textContent = spec.text || spec.id;
		c.appendChild(glyph);
		c.appendChild(label);
		return c;
	}

	function renderComboBox(spec) {
		const c = contentBase('cc-combobox');
		const text = document.createElement('span');
		let display = spec.items && spec.items.length ? spec.items[0] : '';
		let isPlaceholder = false;
		if (!display) {
			display = propOr(spec, 'placeholder', '');
			isPlaceholder = true;
		}
		text.className = 'cc-combobox-text' + (isPlaceholder ? ' placeholder' : '');
		text.textContent = display;
		const arrow = document.createElement('span');
		arrow.className = 'cc-combobox-arrow';
		arrow.textContent = '▼';
		c.appendChild(text);
		c.appendChild(arrow);
		return c;
	}

	function renderListBox(spec) {
		const c = contentBase('cc-listbox');
		const items = spec.items || [];
		for (const item of items) {
			const row = document.createElement('div');
			row.className = 'cc-listbox-row';
			row.textContent = item;
			c.appendChild(row);
		}
		return c;
	}

	function renderPanelLike() {
		// Panel/ScrollBox-without-scrollbar-hint: the outer .ctrl border and
		// background already give the "subtle bordered rect" look; children
		// are appended as later siblings by build() so they paint on top.
		return contentBase();
	}

	// -- GroupBox ----------------------------------------------------------
	//
	// A port of GroupBox.layoutFrame from GoForms (groupbox.go): five border
	// segments plus the caption, with the top line interrupted around the
	// caption. The constants below mirror the ones declared there - change
	// both together.
	//
	// The earlier version drew a CSS legend with a background patch, which
	// only lines up when the backdrop happens to be the theme background,
	// and it sat at a different height than the real control. Reproducing
	// the actual geometry is what makes the canvas match the running app.
	const GB_CAPTION_X = 8;
	const GB_CAPTION_GAP = 5;
	const GB_BORDER = 1;
	const GB_FONT_PX = 14;

	function renderGroupBox(spec) {
		const c = contentBase('cc-groupbox');
		const text = spec.text || spec.id;

		const capH = FYNE_TEXT_H;
		const capW = measureTextPx(text, GB_FONT_PX, true);
		const top = capH / 2;

		const gapStart = Math.max(0, GB_CAPTION_X - GB_CAPTION_GAP);
		const gapEnd = Math.min(spec.w, GB_CAPTION_X + capW + GB_CAPTION_GAP);

		const seg = (cls, x, y, w, h) => {
			const el = document.createElement('div');
			el.className = 'cc-gb-seg ' + cls;
			el.style.left = x + 'px';
			el.style.top = y + 'px';
			el.style.width = Math.max(0, w) + 'px';
			el.style.height = Math.max(0, h) + 'px';
			c.appendChild(el);
		};

		seg('cc-gb-top-left', 0, top, gapStart, GB_BORDER);
		seg('cc-gb-top-right', gapEnd, top, spec.w - gapEnd, GB_BORDER);
		seg('cc-gb-left', 0, top, GB_BORDER, spec.h - top);
		seg('cc-gb-right', spec.w - GB_BORDER, top, GB_BORDER, spec.h - top);
		seg('cc-gb-bottom', 0, spec.h - GB_BORDER, spec.w, GB_BORDER);

		const caption = document.createElement('span');
		caption.className = 'cc-gb-caption';
		caption.style.left = GB_CAPTION_X + 'px';
		caption.style.height = capH + 'px';
		caption.style.fontSize = GB_FONT_PX + 'px';
		caption.textContent = text;
		c.appendChild(caption);

		return c;
	}

	function renderPictureBox(spec) {
		const c = contentBase('cc-picturebox');
		const src = spec && imageUrl(propOr(spec, 'image', ''));
		if (src) {
			// The embedded picture itself, scaled into the box as the
			// framework's default fill (contain) draws it.
			const img = document.createElement('img');
			img.className = 'cc-picture';
			img.src = src;
			img.alt = '';
			c.appendChild(img);
			return c;
		}
		c.innerHTML =
			'<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">' +
			'<rect x="2" y="3" width="20" height="18" rx="1.5"/>' +
			'<circle cx="8" cy="9" r="2"/>' +
			'<path d="M2 17l6-6 4 4 4-5 6 7" />' +
			'</svg>';
		return c;
	}

	function renderProgressBar(spec) {
		const min = parseFloat(propOr(spec, 'min', '0')) || 0;
		const maxRaw = parseFloat(propOr(spec, 'max', '100'));
		const max = isNaN(maxRaw) ? 100 : maxRaw;
		const valRaw = parseFloat(propOr(spec, 'value', String(min)));
		const value = isNaN(valRaw) ? min : valRaw;
		let pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
		pct = Math.max(0, Math.min(100, pct));
		const c = contentBase('cc-progressbar');
		const fill = document.createElement('div');
		fill.className = 'cc-progressbar-fill';
		fill.style.width = pct + '%';
		c.appendChild(fill);
		return c;
	}

	function renderTrackBar(spec) {
		const minRaw = parseFloat(propOr(spec, 'min', '0'));
		const min = isNaN(minRaw) ? 0 : minRaw;
		const maxRaw = parseFloat(propOr(spec, 'max', '10'));
		const max = isNaN(maxRaw) ? 10 : maxRaw;
		let pct = 50;
		const hasValue = spec.props && spec.props.value !== undefined && spec.props.value !== '';
		if (hasValue) {
			const v = parseFloat(spec.props.value);
			if (!isNaN(v) && max > min) {
				pct = Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
			}
		}
		const c = contentBase('cc-trackbar');
		const track = document.createElement('div');
		track.className = 'cc-trackbar-track';
		const thumb = document.createElement('div');
		thumb.className = 'cc-trackbar-thumb';
		thumb.style.left = pct + '%';
		c.appendChild(track);
		c.appendChild(thumb);
		return c;
	}

	function renderNumericUpDown(spec) {
		const c = contentBase('cc-numericupdown');
		const text = document.createElement('span');
		text.className = 'cc-nud-text';
		text.textContent = propOr(spec, 'value', '0');
		const arrows = document.createElement('div');
		arrows.className = 'cc-nud-arrows';
		const up = document.createElement('span');
		up.textContent = '▲';
		const down = document.createElement('span');
		down.textContent = '▼';
		arrows.appendChild(up);
		arrows.appendChild(down);
		c.appendChild(text);
		c.appendChild(arrows);
		return c;
	}

	function renderDateTimePicker(spec) {
		const c = contentBase('cc-datetimepicker');
		const value = propOr(spec, 'value', '');
		const text = document.createElement('span');
		text.className = 'cc-dtp-text' + (value ? '' : ' placeholder');
		text.textContent = value || 'date';
		const icon = document.createElement('span');
		icon.className = 'cc-dtp-icon';
		icon.textContent = '📅';
		c.appendChild(text);
		c.appendChild(icon);
		return c;
	}

	function renderLinkLabel(spec) {
		const c = contentBase('cc-linklabel');
		c.textContent = spec.text || spec.id;
		return c;
	}

	function renderListView(spec) {
		const cols = spec.items && spec.items.length ? spec.items : [''];
		const gridCols = `repeat(${cols.length}, 1fr)`;
		const c = contentBase('cc-listview');

		const header = document.createElement('div');
		header.className = 'cc-listview-header';
		header.style.gridTemplateColumns = gridCols;
		for (const col of cols) {
			const cell = document.createElement('div');
			cell.className = 'cc-listview-cell cc-listview-headcell';
			cell.textContent = col;
			header.appendChild(cell);
		}
		c.appendChild(header);

		const body = document.createElement('div');
		body.className = 'cc-listview-body';
		const rows = spec.rows || [];
		for (const row of rows) {
			const rowEl = document.createElement('div');
			rowEl.className = 'cc-listview-row';
			rowEl.style.gridTemplateColumns = gridCols;
			for (const cellVal of row) {
				const cell = document.createElement('div');
				cell.className = 'cc-listview-cell';
				cell.textContent = cellVal;
				rowEl.appendChild(cell);
			}
			body.appendChild(rowEl);
		}
		c.appendChild(body);
		return c;
	}

	// -- DataGridView ------------------------------------------------------
	//
	// This renderer is a deliberate port of DataGridView.computeWidths /
	// layoutRows from GoForms (datagridview.go). The point of the visual
	// designer is that the canvas shows what will actually appear at
	// runtime, so the two sizing policies must stay in step - if you change
	// one, change the other.
	//
	// Fyne metrics the port depends on: theme.Padding() is 4, and one line
	// of cell text measures ~19 units tall. Widths are measured with the
	// same font the cells are drawn with, so the preview is at least
	// self-consistent even where the browser's text metrics differ slightly
	// from Fyne's.
	// The sizing policy itself lives in gridLayout.js so it can be tested
	// against the Go implementation it mirrors (see test/gridLayout.test.js).
	const GL = globalThis.GoFormsGridLayout;
	const GRID_FONT_PX = 13;
	const GRID_HEADER_H = GL.HEADER_H;
	const GRID_MIN_COL_W = GL.MIN_COL_W;

	function measureGridText(text, bold) {
		return measureTextPx(text, GRID_FONT_PX, bold);
	}

	// Placeholder rows shown only when the source has no AddRow calls, so a
	// freshly dropped grid still communicates its column layout. They are
	// dimmed and labelled to make clear they aren't real data.
	function gridSampleRows(colCount) {
		return [0, 1, 2].map((r) =>
			Array.from({ length: colCount }, (_, c) => `Cell ${r + 1}.${c + 1}`)
		);
	}

	function gridComputeWidths(cols, rows, spec, drawn) {
		const scrollBars = propOr(spec, 'scrollBars', 'ScrollBarsBoth');
		return {
			widths: GL.computeWidths({
				cols,
				rows,
				width: spec.w,
				columnsMode: propOr(spec, 'columnsMode', 'SizeFixed'),
				// A column's own width and mode win over the grid's.
				modes: (drawn || []).map((c) => c.sizeMode || ''),
				fixedWidths: (drawn || []).map((c) => c.width || 0),
				scrollBars,
				measure: measureGridText,
			}),
			canScrollH: GL.canScrollH(scrollBars),
			canScrollV: GL.canScrollV(scrollBars),
		};
	}

	function gridRowHeight(row, spec) {
		return GL.rowHeight(row, {
			rowsMode: propOr(spec, 'rowsMode', 'SizeFixed'),
			rowHeight: parseFloat(propOr(spec, 'rowHeight', String(GL.DEFAULT_ROW_H))) || GL.DEFAULT_ROW_H,
		});
	}

	// gridDrawnColumns is the canvas's half of DataGridView.rebuildShown: the
	// columns that are actually on screen, carrying what each one draws as.
	// A hidden column is absent here exactly as it is absent from the running
	// grid, so the preview does not show a column the form will not.
	function gridDrawnColumns(spec) {
		const declared =
			spec.columns && spec.columns.length
				? spec.columns
				: (spec.items || []).map((t) => ({ title: t }));
		const out = [];
		declared.forEach((c, index) => {
			if (c.hidden) return;
			out.push({
				index,
				title: c.title || '',
				kind: c.kind || '',
				buttonText: c.buttonText || '',
				width: c.width || 0,
				sizeMode: c.sizeMode || '',
				align: c.align || '',
				readOnly: !!c.readOnly,
			});
		});
		return out;
	}

	// fillGridCell draws one cell as whatever its column says it is, mirroring
	// DataGridView.updateCell. A button column's caption is its own when it
	// has one and the cell's value otherwise, which is the whole point of
	// leaving ButtonText empty.
	function fillGridCell(cell, column, value) {
		const kind = (column && column.kind) || '';
		if (kind === 'Button') {
			const btn = document.createElement('span');
			btn.className = 'cc-grid-cellbtn';
			btn.textContent = (column.buttonText || value || '').trim() || '…';
			cell.appendChild(btn);
			return;
		}
		if (kind === 'CheckBox') {
			cell.classList.add('cc-grid-cellcheck');
			cell.textContent = String(value).trim() === 'true' ? '☑' : '☐';
			return;
		}
		cell.textContent = value;
	}

	function renderDataGridView(spec) {
		let drawn = gridDrawnColumns(spec);
		// A grid nobody has given columns yet draws as an empty box, which
		// reads as a broken drop rather than a new control - so it gets
		// placeholders. A grid whose columns are all hidden is a different
		// thing: that is what the form will really show.
		if (!drawn.length && !(spec.columns && spec.columns.length) && !(spec.items && spec.items.length)) {
			drawn = ['Column 1', 'Column 2', 'Column 3'].map((title, index) => ({ title, index, kind: '', buttonText: '' }));
		}
		const cols = drawn.map((c) => c.title);
		const realRows = spec.rows || [];
		// Row data is indexed by *column*, not by drawn position, so a hidden
		// column ahead of another must not shift its cells.
		const rows = realRows.length
			? realRows.map((r) => drawn.map((c) => (c.index < r.length ? r[c.index] : '')))
			: gridSampleRows(cols.length);
		const isSample = realRows.length === 0;

		const showHeader = propOr(spec, 'showHeader', 'true') !== 'false';
		const gridLines = propOr(spec, 'gridLines', 'true') !== 'false';
		const readOnly = propOr(spec, 'readOnly', 'false') === 'true';
		const frozen = parseInt(propOr(spec, 'frozenColumns', '0'), 10) || 0;

		const { widths, canScrollH, canScrollV } = gridComputeWidths(cols, rows, spec, drawn);
		const picked = selectedColumn && selectedColumn.id === spec.id ? selectedColumn.index : -1;
		const alignClass = (col) => (col && col.align === 'AlignRight' ? ' cc-align-right' : col && col.align === 'AlignCenter' ? ' cc-align-center' : '');
		const template = widths.map((w) => `${w}px`).join(' ');
		const totalW = widths.reduce((a, b) => a + b, 0);

		const c = contentBase('cc-grid');
		if (!gridLines) c.classList.add('cc-grid-nolines');
		if (readOnly) c.classList.add('cc-grid-readonly');

		const viewport = document.createElement('div');
		viewport.className = 'cc-grid-viewport';

		const table = document.createElement('div');
		table.className = 'cc-grid-table';
		table.style.width = totalW + 'px';

		if (showHeader) {
			const header = document.createElement('div');
			header.className = 'cc-grid-header';
			header.style.gridTemplateColumns = template;
			header.style.height = GRID_HEADER_H + 'px';
			cols.forEach((title, i) => {
				const cell = document.createElement('div');
				cell.className = 'cc-grid-cell cc-grid-headcell' + alignClass(drawn[i]) + (drawn[i].index === picked ? ' cc-col-picked' : '');
				if (i < frozen) cell.classList.add('cc-grid-frozen');
				cell.textContent = title;
				// A click on a header picks the column, as in Visual Studio:
				// the panel then edits that column.
				if (spec.columns || spec.items) {
					cell.style.pointerEvents = 'auto';
					cell.title = `Edit the ${title || 'column'} column`;
					const index = drawn[i].index;
					cell.addEventListener('mousedown', (e) => {
						if (e.button === 2 || tabOrderMode) return;
						e.stopPropagation();
						pickColumn(spec.id, index);
					});
				}
				header.appendChild(cell);
			});
			table.appendChild(header);
		}

		let contentH = showHeader ? GRID_HEADER_H : 0;
		for (const row of rows) {
			const h = gridRowHeight(row, spec);
			const rowEl = document.createElement('div');
			rowEl.className = 'cc-grid-row';
			rowEl.style.gridTemplateColumns = template;
			rowEl.style.height = h + 'px';
			for (let i = 0; i < cols.length; i++) {
				const cell = document.createElement('div');
				cell.className = 'cc-grid-cell' + alignClass(drawn[i]) + (drawn[i].index === picked ? ' cc-col-picked' : '') + (drawn[i].readOnly ? ' cc-col-readonly' : '');
				if (i < frozen) cell.classList.add('cc-grid-frozen');
				fillGridCell(cell, drawn[i], i < row.length ? row[i] : '');
				rowEl.appendChild(cell);
			}
			table.appendChild(rowEl);
			contentH += h;
		}
		// The row for new records, when the user may add them - marked *, as
		// the running grid marks it.
		if (propOr(spec, 'allowUserToAddRows', 'false') === 'true' && !readOnly) {
			const h = gridRowHeight([], spec);
			const rowEl = document.createElement('div');
			rowEl.className = 'cc-grid-row cc-grid-newrow';
			rowEl.style.gridTemplateColumns = template;
			rowEl.style.height = h + 'px';
			for (let i = 0; i < cols.length; i++) {
				const cell = document.createElement('div');
				cell.className = 'cc-grid-cell' + (drawn[i].index === picked ? ' cc-col-picked' : '');
				cell.textContent = i === 0 ? '*' : '';
				rowEl.appendChild(cell);
			}
			table.appendChild(rowEl);
			contentH += h;
		}

		viewport.appendChild(table);
		c.appendChild(viewport);

		// Vertical scrolling off means the runtime grows the control past
		// the height in SetBounds (see ScrollBars in datagridview.go), so
		// draw it grown here too rather than pretending it fits.
		if (!canScrollV && contentH > spec.h) {
			c.classList.add('cc-grid-autoheight');
			c.style.height = contentH + 'px';
			c.title = `Vertical scrolling is off, so this grid grows to ${Math.round(contentH)}px at runtime.`;
		} else if (canScrollV && contentH > spec.h) {
			c.appendChild(fakeScrollBar('v'));
		}
		if (canScrollH && totalW > spec.w) {
			c.appendChild(fakeScrollBar('h'));
		}

		if (isSample) {
			c.classList.add('cc-grid-sample');
			c.title = 'Sample rows - no AddRow(...) calls found in the source.';
		}
		return c;
	}

	// pickColumn selects a grid and one of its columns, and shows the column
	// in the panel.
	function pickColumn(id, index) {
		selectedColumn = { id, index };
		if (!(selectedIds.size === 1 && selectedId === id)) setSelection(id, false);
		updateSelectionClasses();
		propsDigest = null;
		renderProperties();
		renderOutline();
		showTab('properties');
		const spec = findControl(id);
		const el = rendered.get(id);
		if (spec && el) updateControlContent(el, spec);
	}

	// fakeScrollBar draws the scrollbar Fyne will show once content
	// overflows, so the preview accounts for the space it takes.
	function fakeScrollBar(axis) {
		const bar = document.createElement('div');
		bar.className = axis === 'v' ? 'cc-grid-vscroll' : 'cc-grid-hscroll';
		const thumb = document.createElement('div');
		thumb.className = 'cc-grid-thumb';
		bar.appendChild(thumb);
		return bar;
	}

	// -- Controls added alongside the full WinForms catalogue ---------------

	function renderMaskedTextBox(spec) {
		const c = contentBase('cc-textbox');
		const inner = document.createElement('span');
		const mask = (spec.props && spec.props.mask) || '';
		// Show the text if there is one, else the mask, else the placeholder -
		// which is the order the running control shows them in too.
		inner.textContent = spec.text || mask || (spec.props && spec.props.placeholder) || '';
		if (!spec.text) inner.className = 'cc-placeholder';
		c.appendChild(inner);
		return c;
	}

	function renderRichTextBox(spec) {
		const c = contentBase('cc-richtext');
		// The source is Markdown; show the first few lines with headings
		// rendered a little larger, which is roughly what widget.RichText does.
		const lines = String(spec.text || '').split('\n').slice(0, 8);
		for (const line of lines) {
			const row = document.createElement('div');
			const heading = /^(#{1,6})\s+/.exec(line);
			if (heading) {
				row.className = 'cc-richtext-h' + Math.min(3, heading[1].length);
				row.textContent = line.replace(/^#{1,6}\s+/, '');
			} else {
				row.textContent = line;
			}
			c.appendChild(row);
		}
		return c;
	}

	function renderCheckedListBox(spec) {
		const c = contentBase('cc-checkedlist');
		for (const item of spec.items || []) {
			const row = document.createElement('div');
			row.className = 'cc-checkedlist-row';
			const box = document.createElement('span');
			box.className = 'cc-check-box';
			const label = document.createElement('span');
			label.textContent = item;
			row.appendChild(box);
			row.appendChild(label);
			c.appendChild(row);
		}
		return c;
	}

	// A calendar is a fixed 7-column grid, so the preview can be exact
	// without knowing which month is shown.
	function renderMonthCalendar() {
		const c = contentBase('cc-calendar');
		const head = document.createElement('div');
		head.className = 'cc-calendar-head';
		head.textContent = '‹  Month Year  ›';
		c.appendChild(head);

		const grid = document.createElement('div');
		grid.className = 'cc-calendar-grid';
		for (const d of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
			const cell = document.createElement('div');
			cell.className = 'cc-calendar-dow';
			cell.textContent = d;
			grid.appendChild(cell);
		}
		for (let i = 1; i <= 35; i++) {
			const cell = document.createElement('div');
			cell.className = 'cc-calendar-day';
			cell.textContent = i <= 31 ? String(i) : '';
			grid.appendChild(cell);
		}
		c.appendChild(grid);
		return c;
	}

	function renderDomainUpDown(spec) {
		const c = contentBase('cc-domainupdown');
		const label = document.createElement('span');
		label.className = 'cc-domain-value';
		label.textContent = (spec.items && spec.items[0]) || '';
		const spin = document.createElement('span');
		spin.className = 'cc-domain-spin';
		spin.innerHTML = '<span>▲</span><span>▼</span>';
		c.appendChild(label);
		c.appendChild(spin);
		return c;
	}

	function renderScrollBar(spec) {
		const vertical = propOr(spec, 'orientation', 'horizontal') === 'vertical';
		const c = contentBase('cc-scrollbar' + (vertical ? ' vertical' : ''));
		const thumb = document.createElement('div');
		thumb.className = 'cc-scrollbar-thumb';
		c.appendChild(thumb);
		return c;
	}

	// FlowLayoutPanel and TableLayoutPanel are containers: their children are
	// appended as siblings by build(), so the content layer only draws the
	// guide lines that explain how the panel will place them.
	function renderFlowLayoutPanel(spec) {
		const c = contentBase('cc-layoutpanel');
		const hint = document.createElement('div');
		hint.className = 'cc-layout-hint';
		const dir = propOr(spec, 'flowDirection', 'FlowLeftToRight').replace('Flow', '');
		const wrap = propOr(spec, 'wrapContents', 'true') !== 'false' ? 'wrap' : 'no wrap';
		hint.textContent = `Flow · ${dir} · ${wrap}`;
		c.appendChild(hint);
		return c;
	}

	// A table's cells are drawn where the framework puts them - dashed
	// lines between the tracks - with a grip on each boundary: dragged, it
	// resizes the two tracks on either side, as in the Visual Studio
	// designer.
	function renderTableLayoutPanel(spec) {
		const c = contentBase('cc-layoutpanel cc-table');
		const grid = tableGridOf(spec);
		const cols = grid.colSizes.length, rows = grid.rowSizes.length;
		const line = (cls, x, y, w, h) => {
			const el = document.createElement('div');
			el.className = cls;
			el.style.left = x + 'px';
			el.style.top = y + 'px';
			el.style.width = w + 'px';
			el.style.height = h + 'px';
			c.appendChild(el);
			return el;
		};
		const x1 = grid.colOffsets[0], y1 = grid.rowOffsets[0];
		const x2 = grid.colOffsets[cols - 1] + grid.colSizes[cols - 1];
		const y2 = grid.rowOffsets[rows - 1] + grid.rowSizes[rows - 1];
		for (let i = 1; i < cols; i++) line('tl-line v', grid.colOffsets[i], y1, 0, y2 - y1);
		for (let i = 1; i < rows; i++) line('tl-line h', x1, grid.rowOffsets[i], x2 - x1, 0);
		if (!spec.tableReadOnly) {
			for (let i = 0; i + 1 < cols; i++) {
				const g = line('tl-grip v', grid.colOffsets[i + 1] - 3, y1, 7, y2 - y1);
				g.title = 'Drag to resize the columns';
				g.style.pointerEvents = 'auto';
				g.addEventListener('mousedown', (e) => startTrackResize(e, spec.id, 'columns', i));
			}
			for (let i = 0; i + 1 < rows; i++) {
				const g = line('tl-grip h', x1, grid.rowOffsets[i + 1] - 3, x2 - x1, 7);
				g.title = 'Drag to resize the rows';
				g.style.pointerEvents = 'auto';
				g.addEventListener('mousedown', (e) => startTrackResize(e, spec.id, 'rows', i));
			}
		}
		const hint = document.createElement('div');
		hint.className = 'cc-layout-hint';
		hint.textContent = `Table · ${cols}×${rows}`;
		c.appendChild(hint);
		return c;
	}

	// startTrackResize drags the boundary after track `index`; on release the
	// two tracks beside it are restyled (see panelLayout.resizeTracks).
	function startTrackResize(e, id, which, index) {
		e.stopPropagation();
		e.preventDefault();
		if (locked || tabOrderMode) return;
		const table = findControl(id);
		if (!table) return;
		const grid = tableGridOf(table);
		const sizes = which === 'columns' ? grid.colSizes : grid.rowSizes;
		const grip = e.target;
		const startPos = which === 'columns' ? e.clientX : e.clientY;
		const startOffset = parseFloat(which === 'columns' ? grip.style.left : grip.style.top) || 0;
		let delta = 0;
		const move = (ev) => {
			delta = toFormPx((which === 'columns' ? ev.clientX : ev.clientY) - startPos);
			delta = Math.max(-sizes[index], Math.min(sizes[index + 1], delta));
			if (which === 'columns') grip.style.left = startOffset + delta + 'px';
			else grip.style.top = startOffset + delta + 'px';
			grip.classList.add('dragging');
		};
		const up = () => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
			if (Math.round(delta) === 0) return;
			const tracks = panels().resizeTracks(tracksOf(table, which), sizes, index, delta);
			post({
				type: 'apply',
				ops: [{
					op: 'setTable',
					id,
					tableColumns: which === 'columns' ? tracks : tracksOf(table, 'columns'),
					tableRows: which === 'rows' ? tracks : tracksOf(table, 'rows'),
				}],
			});
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}

	function renderSplitContainer(spec) {
		const vertical = propOr(spec, 'orientation', 'vertical') === 'vertical';
		const ratio = parseFloat(propOr(spec, 'splitterDistance', '0.5')) || 0.5;
		const c = contentBase('cc-splitcontainer' + (vertical ? '' : ' horizontal'));

		// data-slot is what makes each half a real drop target and coordinate
		// origin - build() places a child whose parentSlot names it here.
		const first = document.createElement('div');
		first.className = 'cc-split-pane';
		first.dataset.slot = 'Panel1';
		const bar = document.createElement('div');
		bar.className = 'cc-split-bar';
		bar.title = 'Drag to set SplitterDistance';
		// The bar opts back into mouse events: dragging it moves the
		// splitter, not the whole container.
		bar.style.pointerEvents = 'auto';
		bar.addEventListener('mousedown', (e) => startSplitterDrag(e, spec.id, vertical, first, second));
		const second = document.createElement('div');
		second.className = 'cc-split-pane';
		second.dataset.slot = 'Panel2';

		const pct = Math.max(0, Math.min(1, ratio)) * 100;
		if (vertical) {
			first.style.width = pct + '%';
			second.style.width = 100 - pct + '%';
		} else {
			first.style.height = pct + '%';
			second.style.height = 100 - pct + '%';
		}
		c.appendChild(first);
		c.appendChild(bar);
		c.appendChild(second);
		return c;
	}

	// startSplitterDrag follows the mouse with a SplitContainer's splitter
	// and, on release, writes SplitterDistance - which GoForms takes as a
	// fraction from 0 to 1, the way Fyne's Split does.
	function startSplitterDrag(e, id, vertical, first, second) {
		e.stopPropagation();
		e.preventDefault();
		const spec = findControl(id);
		if (!spec) return;
		if (!(selectedIds.size === 1 && selectedId === id)) {
			setSelection(id, false);
			updateSelectionClasses();
			renderProperties();
			renderOutline();
		}
		if (locked || tabOrderMode) return;
		const total = vertical ? spec.w : spec.h;
		const start = parseFloat(propOr(spec, 'splitterDistance', '0.5')) || 0.5;
		const origin = vertical ? e.clientX : e.clientY;
		let ratio = start;
		const move = (ev) => {
			const d = toFormPx((vertical ? ev.clientX : ev.clientY) - origin);
			ratio = Math.max(0.05, Math.min(0.95, start + (total ? d / total : 0)));
			const pct = ratio * 100;
			if (vertical) {
				first.style.width = pct + '%';
				second.style.width = 100 - pct + '%';
			} else {
				first.style.height = pct + '%';
				second.style.height = 100 - pct + '%';
			}
		};
		const up = () => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
			const value = Math.round(ratio * 1000) / 1000;
			if (value === Math.round(start * 1000) / 1000) return;
			post({ type: 'apply', ops: [{ op: 'setProp', id, prop: 'splitterDistance', value: String(value) }] });
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}

	// These four draw the real item list the tool parsed out of the file
	// (spec.collection), so the canvas shows the buttons, tabs and nodes that
	// will actually be there rather than a representative shape.

	function collectionOf(spec) {
		return (spec && spec.collection) || [];
	}

	// normalizedDepths mirrors the tool's own clamping (codegen.go): the
	// first node is always a root and nothing is deeper than one level below
	// the node before it, so the canvas draws the tree the generated code
	// will actually build.
	function normalizedDepths(items) {
		const out = [];
		let prev = -1;
		for (const item of items) {
			let d = Math.max(0, item.depth || 0);
			if (d > prev + 1) d = prev + 1;
			out.push(d);
			prev = d;
		}
		return out;
	}

	function renderTreeView(spec) {
		const c = contentBase('cc-treeview');
		const items = collectionOf(spec);
		const depths = normalizedDepths(items);
		items.forEach((item, i) => {
			const rowEl = document.createElement('div');
			rowEl.className = 'cc-treeview-row';
			rowEl.style.paddingLeft = 4 + depths[i] * 12 + 'px';
			const glyph = document.createElement('span');
			glyph.className = 'cc-treeview-glyph';
			// A node is expandable exactly when the next one nests under it.
			glyph.textContent = i + 1 < items.length && depths[i + 1] > depths[i] ? '▾' : '';
			const label = document.createElement('span');
			label.textContent = item.text;
			rowEl.appendChild(glyph);
			rowEl.appendChild(label);
			c.appendChild(rowEl);
		});
		return c;
	}

	function renderTabControl(spec) {
		return renderPagedControl(spec, 'cc-tabcontrol');
	}

	// renderPagedControl draws a tab strip plus the content area of the page
	// currently being designed. Only that page's content area carries a
	// data-slot, so it alone is a drop target and coordinate origin - which is
	// what makes designing one tab at a time work the way it does in WinForms.
	function renderPagedControl(spec, cls) {
		const c = contentBase(cls);
		const items = collectionOf(spec);
		const shown = Math.min(pageChoice[spec.id] || 0, Math.max(0, items.length - 1));

		const strip = document.createElement('div');
		strip.className = 'cc-tabstrip';
		items.forEach((item, i) => {
			const tab = document.createElement('span');
			tab.className = 'cc-tab' + (i === shown ? ' active' : '');
			tab.textContent = item.text;
			tab.title = `Design this page (${slotNameFor(spec, i)})`;
			// Tabs opt back into mouse events (.ctrl-content turns them off)
			// so switching pages is a plain click, as in the running form.
			tab.style.pointerEvents = 'auto';
			tab.addEventListener('mousedown', (e) => {
				e.stopPropagation();
				pageChoice[spec.id] = i;
				renderCanvas();
				renderTabBadges();
				updateSelectionClasses();
			});
			strip.appendChild(tab);
		});

		const area = document.createElement('div');
		area.className = 'cc-tabcontent';
		if (items.length) {
			area.dataset.slot = slotNameFor(spec, shown);
		}
		c.appendChild(strip);
		c.appendChild(area);
		return c;
	}

	// slotNameFor is the ParentSlot of a paged control's i'th page, matching
	// the tool's pageSlotName(): the catalog's stem plus a 1-based index.
	function slotNameFor(spec, i) {
		const cd = catalog[spec.type] && catalog[spec.type].Collection;
		return (cd && cd.ItemSlot ? cd.ItemSlot : 'Page') + (i + 1);
	}

	// slotsFor lists where a control can hold children: its type's fixed
	// slots, or one per page. Mirrors the tool's slotsOf().
	function slotsFor(spec) {
		const desc = catalog[spec.type];
		if (!desc) return [];
		if (desc.Slots && desc.Slots.length) return desc.Slots;
		const cd = desc.Collection;
		if (cd && cd.ItemSlot) {
			return collectionOf(spec).map((_, i) => slotNameFor(spec, i));
		}
		return [];
	}

	function renderViewContainer(spec) {
		return renderPagedControl(spec, 'cc-tabcontrol cc-viewcontainer');
	}

	function renderToolStrip(spec) {
		const c = contentBase('cc-toolstrip');
		for (const item of collectionOf(spec)) {
			if (item.kind === 'separator') {
				const sep = document.createElement('span');
				sep.className = 'cc-tool-sep';
				c.appendChild(sep);
				continue;
			}
			const btn = document.createElement('span');
			btn.className = 'cc-tool-btn' + (item.handler ? ' wired' : '');
			btn.textContent = item.text;
			c.appendChild(btn);
		}
		return c;
	}

	function renderStatusStrip(spec) {
		const c = contentBase('cc-statusstrip');
		for (const item of collectionOf(spec)) {
			const panel = document.createElement('span');
			panel.className = 'cc-statusstrip-panel';
			panel.textContent = item.text;
			c.appendChild(panel);
		}
		return c;
	}

	function renderSplitter(spec) {
		const orientation = propOr(spec, 'orientation', 'horizontal');
		const vertical = orientation === 'vertical';
		const c = contentBase('cc-splitter ' + (vertical ? 'cc-splitter-vert' : 'cc-splitter-horiz'));
		const paneA = document.createElement('div');
		paneA.className = 'cc-splitter-pane';
		const divider = document.createElement('div');
		divider.className = 'cc-splitter-divider';
		const paneB = document.createElement('div');
		paneB.className = 'cc-splitter-pane';
		c.appendChild(paneA);
		c.appendChild(divider);
		c.appendChild(paneB);
		return c;
	}

	function renderScrollBox() {
		const c = contentBase('cc-scrollbox');
		const bar = document.createElement('div');
		bar.className = 'cc-scrollbox-bar';
		const thumb = document.createElement('div');
		thumb.className = 'cc-scrollbox-thumb';
		bar.appendChild(thumb);
		c.appendChild(bar);
		return c;
	}

	function renderColorPickerButton(spec) {
		const c = contentBase('cc-colorpicker');
		const swatch = document.createElement('span');
		swatch.className = 'cc-colorpicker-swatch';
		const text = document.createElement('span');
		text.className = 'cc-colorpicker-text';
		text.textContent = spec.text || spec.id;
		c.appendChild(swatch);
		c.appendChild(text);
		return c;
	}

	const CONTROL_RENDERERS = {
		Label: renderLabel,
		Button: renderButton,
		TextBox: renderTextBox,
		CheckBox: (spec) => renderCheckLike(spec, 'square'),
		RadioButton: (spec) => renderCheckLike(spec, 'circle'),
		ComboBox: renderComboBox,
		ListBox: renderListBox,
		Panel: renderPanelLike,
		GroupBox: renderGroupBox,
		PictureBox: renderPictureBox,
		ProgressBar: renderProgressBar,
		TrackBar: renderTrackBar,
		NumericUpDown: renderNumericUpDown,
		DateTimePicker: renderDateTimePicker,
		LinkLabel: renderLinkLabel,
		ListView: renderListView,
		TreeView: renderTreeView,
		TabControl: renderTabControl,
		ToolStrip: renderToolStrip,
		StatusStrip: renderStatusStrip,
		Splitter: renderSplitter,
		ScrollBox: renderScrollBox,
		ColorPickerButton: renderColorPickerButton,
		DataGridView: renderDataGridView,
		MaskedTextBox: renderMaskedTextBox,
		RichTextBox: renderRichTextBox,
		CheckedListBox: renderCheckedListBox,
		MonthCalendar: renderMonthCalendar,
		DomainUpDown: renderDomainUpDown,
		ScrollBar: renderScrollBar,
		FlowLayoutPanel: renderFlowLayoutPanel,
		TableLayoutPanel: renderTableLayoutPanel,
		SplitContainer: renderSplitContainer,
		ViewContainer: renderViewContainer,
	};

	function renderControlContent(spec, desc) {
		const fn = CONTROL_RENDERERS[spec.type];
		if (!fn) {
			return renderGenericFallback(spec);
		}
		return fn(spec, desc);
	}

	// Driven from the render map rather than the document so a control that is
	// currently detached - one on a tab page other than the one being designed
	// - is still up to date when it comes back.
	function updateSelectionClasses() {
		const mark = (elx, id) => {
			elx.classList.toggle('selected', id === selectedId);
			// Secondary members get a lighter outline, so it stays obvious
			// which one the properties panel is editing.
			elx.classList.toggle('co-selected', id !== selectedId && selectedIds.has(id));
		};
		rendered.forEach(mark);
		trayEls.forEach(mark);

		// A selected container moves by its ✥ glyph: a drag inside it draws
		// a selection rectangle among its controls instead.
		for (const g of document.querySelectorAll('.move-glyph')) g.remove();
		const sel = selectedIds.size === 1 && selectedId ? findControl(selectedId) : null;
		if (sel && sel.supported && !isComponent(sel) && acceptsChildrenSpec(sel) && !locked && !tabOrderMode) {
			const el = rendered.get(sel.id);
			if (el) {
				const glyph = document.createElement('div');
				glyph.className = 'move-glyph';
				glyph.textContent = '✥';
				glyph.title = `Drag to move ${sel.id}`;
				glyph.addEventListener('mousedown', (e) => {
					const live = findControl(sel.id);
					if (live) onCtrlMouseDown(e, live, el, true);
				});
				el.appendChild(glyph);
			}
		}
		drawSmartTag();
	}

	// ---------------------------------------------------------------------
	// Drag (move)
	// ---------------------------------------------------------------------

	function onCtrlMouseDown(e, spec, d, forceDrag) {
		e.stopPropagation();
		e.preventDefault();

		// In tab order mode a click means "this one is next", not "select
		// this one" - the whole point is to walk the form in sequence without
		// the panel changing under you on every click.
		if (tabOrderMode) {
			assignNextTabIndex(spec);
			return;
		}

		const additive = e.ctrlKey || e.metaKey || e.shiftKey;
		// A press inside a container that is already the selection draws a
		// selection rectangle among its controls, as in Visual Studio; the
		// container itself moves by its ✥ glyph.
		const pane = e.target && e.target.dataset && e.target.dataset.slot ? e.target : null;
		if (!forceDrag && !additive && e.button !== 2 && selectedIds.size === 1 && selectedId === spec.id && acceptsChildrenSpec(spec) && (e.target === d || pane)) {
			if (pane) slotChoice[spec.id] = pane.dataset.slot;
			if (!pane && slotsFor(spec).length) {
				// A split or paged container's own box (its splitter, its
				// tab strip) is not somewhere controls go.
			} else {
				startLasso(e, spec.id, pane ? pane.dataset.slot : '', pane || d);
				return;
			}
		}

		// Dragging a control that is already part of a multi-selection moves
		// the whole thing, so a plain click inside one must not collapse it.
		if (additive) {
			setSelection(spec.id, true);
		} else if (!selectedIds.has(spec.id)) {
			setSelection(spec.id, false);
		} else {
			selectedId = spec.id;
		}
		updateSelectionClasses();
		renderProperties();
		renderOutline();
		// Picking something on the canvas is a request to look at it, so the
		// panel shows its properties without a second click on the tab.
		showTab('properties');

		// Locked: the click above still selected the control, which is what
		// Lock Controls is for - inspecting a finished layout without nudging
		// it. Only the drag is refused. A right-click only selects.
		if (locked || e.button === 2) {
			return;
		}

		// Only siblings move together: children of different parents use
		// different coordinate origins, so one shared delta would be wrong
		// for all but one of them.
		const parentId = parentKey(spec.parent, spec.parentSlot);
		const members = selectedSpecs()
			.filter((s2) => parentKey(s2.parent, s2.parentSlot) === parentId)
			.map((s2) => {
				const el = ctrlEl(s2.id);
				const r = drawnRect(el, s2);
				// w/h are the control's own size, which is what a move writes
				// back - not the size docking or a table cell gives it.
				return { id: s2.id, el, origX: r.x, origY: r.y, w: s2.w, h: s2.h, drawnW: r.w, drawnH: r.h };
			})
			.filter((m) => m.el);
		const self = members.find((m) => m.id === spec.id) || { origX: spec.x, origY: spec.y, w: spec.w, h: spec.h };

		dragState = {
			id: spec.id,
			el: d,
			members,
			parentId,
			parent: spec.parent || '',
			slot: spec.parentSlot || '',
			dropHost: null,
			startClientX: e.clientX,
			startClientY: e.clientY,
			origX: self.origX,
			origY: self.origY,
			w: self.drawnW || self.w,
			h: self.drawnH || self.h,
			moved: false,
			newX: self.origX,
			newY: self.origY,
			cell: null,
			flowIndex: null,
		};
		document.addEventListener('mousemove', onDragMove);
		document.addEventListener('mouseup', onDragUp);
	}

	// drawnRect is where a control is really drawn - after docking, flowing
	// or a table cell - which is what a drag starts from and snaps against.
	function drawnRect(el, spec) {
		if (!el) return { x: spec.x, y: spec.y, w: spec.w, h: spec.h };
		const n = (v, f) => {
			const x = parseFloat(v);
			return Number.isFinite(x) ? x : f;
		};
		return { x: n(el.style.left, spec.x), y: n(el.style.top, spec.y), w: n(el.style.width, spec.w), h: n(el.style.height, spec.h) };
	}

	function acceptsChildrenSpec(spec) {
		const desc = catalog[spec.type];
		return !!(desc && (desc.IsContainer || slotsFor(spec).length));
	}

	// hostBox is a container's client area as the snap geometry wants it.
	function hostBox(parent, slot) {
		const host = containerElFor(parent, slot);
		const size = host ? hostClientSize(parent, slot, host) : { width: model.formWidth, height: model.formHeight };
		const owner = parent ? findControl(parent) : null;
		const padding = paddingOf(owner ? owner.props && owner.props.padding : !parent ? model.formProps && model.formProps.padding : '');
		return { w: size.width, h: size.height, padding };
	}

	// snapNeighbours are the drawn rects of a drag's siblings, the ones it
	// can line up with.
	function snapNeighbours(state) {
		const moving = new Set(state.members.map((m) => m.id));
		return canvasControls()
			.filter((o) => !moving.has(o.id) && parentKey(o.parent, o.parentSlot) === state.parentId)
			.map((o) => drawnRect(rendered.get(o.id), o));
	}

	function onDragMove(e) {
		if (!dragState) return;
		const dx = toFormPx(e.clientX - dragState.startClientX);
		const dy = toFormPx(e.clientY - dragState.startClientY);
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
			dragState.moved = true;
		}
		if (!dragState.moved) return;

		// The primary control decides the delta (and gets the snapping);
		// every other member follows by exactly the same amount, so their
		// relative arrangement survives the drag. Alt drags freely.
		const raw = { x: dragState.origX + dx, y: dragState.origY + dy, w: dragState.w, h: dragState.h };
		const snapped = geo().snapMove(raw, snapNeighbours(dragState), hostBox(dragState.parent, dragState.slot), e.altKey ? 0 : undefined);
		const appliedDX = snapped.rect.x - dragState.origX;
		const appliedDY = snapped.rect.y - dragState.origY;

		for (const m of dragState.members) {
			m.newX = Math.max(0, Math.round(m.origX + appliedDX));
			m.newY = Math.max(0, Math.round(m.origY + appliedDY));
			m.el.style.left = m.newX + 'px';
			m.el.style.top = m.newY + 'px';
		}
		dragState.newX = Math.max(0, Math.round(snapped.rect.x));
		dragState.newY = Math.max(0, Math.round(snapped.rect.y));
		showGuides(snapped.guides, dragState.parent, dragState.slot);
		trackDropHost(e.clientX, e.clientY);
	}

	// ---------------------------------------------------------------------
	// Reparenting by drag
	// ---------------------------------------------------------------------
	//
	// Dropping a control on a container moves it into that container - or
	// into one named half of one (a SplitContainer's Panel1/Panel2), which is
	// the only way to put anything in those at all, since a SplitContainer
	// has no AddControl of its own.

	// dropHostAt reports what a control released at this point would land in.
	// It walks the hit stack from the topmost element outwards, so the
	// innermost container under the cursor wins, and skips the controls being
	// dragged (and anything inside them - a container can't become a child of
	// its own child).
	function dropHostAt(clientX, clientY, movingIds) {
		const stack = document.elementsFromPoint(clientX, clientY);
		for (const el of stack) {
			if (el.dataset && el.dataset.slot) {
				const owner = el.closest('.ctrl');
				const ownerId = owner && owner.dataset.id;
				if (ownerId && !isInsideAny(ownerId, movingIds)) {
					return { el, parent: ownerId, slot: el.dataset.slot };
				}
				continue;
			}
			if (el.classList && el.classList.contains('ctrl')) {
				const id = el.dataset.id;
				if (!id || isInsideAny(id, movingIds)) continue;
				const spec = findControl(id);
				const desc = spec && catalog[spec.type];
				// A non-container under the cursor isn't a target, but it also
				// shouldn't block whatever it is sitting on.
				if (desc && desc.IsContainer) {
					return { el, parent: id, slot: '' };
				}
				continue;
			}
			if (el.id === 'form-canvas') {
				return { el, parent: '', slot: '' };
			}
		}
		return null;
	}

	function trackDropHost(clientX, clientY) {
		const movingIds = new Set(dragState.members.map((m) => m.id));
		const host = dropHostAt(clientX, clientY, movingIds);
		const changed = !!host && (host.parent !== dragState.parent || host.slot !== dragState.slot);
		if (dragState.dropHost && dragState.dropHost.el !== (host && host.el)) {
			dragState.dropHost.el.classList.remove('drop-host');
		}
		// Highlight only a host that would actually move the control:
		// outlining the container it is already in reads as a pending change
		// that isn't one.
		dragState.dropHost = changed ? host : null;
		if (dragState.dropHost) {
			dragState.dropHost.el.classList.add('drop-host');
		}

		// A table takes the drop into the cell under the mouse, a flow at a
		// place in its order - whether the control comes from outside or is
		// being moved inside it.
		const target = host || { el: containerElFor(dragState.parent, dragState.slot), parent: dragState.parent, slot: dragState.slot };
		const owner = target.parent && !target.slot ? findControl(target.parent) : null;
		clearCellMarks();
		dragState.cell = null;
		dragState.flowIndex = null;
		dragState.layoutTarget = null;
		if (!owner || !target.el) return;
		const r = target.el.getBoundingClientRect();
		const p = { x: toFormPx(clientX - r.left), y: toFormPx(clientY - r.top) };
		if (owner.type === 'TableLayoutPanel') {
			const grid = tableGridOf(owner);
			const cell = panels().cellAt(grid, p.x, p.y);
			dragState.cell = cell;
			dragState.layoutTarget = owner;
			const mark = document.createElement('div');
			mark.className = 'cell-target';
			mark.style.left = grid.colOffsets[cell.column] + 'px';
			mark.style.top = grid.rowOffsets[cell.row] + 'px';
			mark.style.width = grid.colSizes[cell.column] + 'px';
			mark.style.height = grid.rowSizes[cell.row] + 'px';
			target.el.appendChild(mark);
		} else if (owner.type === 'FlowLayoutPanel') {
			const kids = canvasControls().filter((c) => c.parent === owner.id && !c.parentSlot && !movingIds.has(c.id));
			const rects = kids.map((c) => drawnRect(rendered.get(c.id), c));
			const ins = panels().flowInsert(rects, p.x, p.y, flowOptions(owner).direction);
			dragState.flowIndex = ins.index;
			dragState.flowOrder = kids.map((c) => c.id);
			dragState.layoutTarget = owner;
			const pad = paddingOf(owner.props && owner.props.padding);
			const bar = ins.bar || { x: pad.left + 2, y: pad.top + 2, w: 2, h: 24 };
			const mark = document.createElement('div');
			mark.className = 'flow-bar';
			mark.style.left = bar.x + 'px';
			mark.style.top = bar.y + 'px';
			mark.style.width = bar.w + 'px';
			mark.style.height = bar.h + 'px';
			target.el.appendChild(mark);
		}
	}

	function clearCellMarks() {
		document.querySelectorAll('.cell-target').forEach((el) => el.remove());
		document.querySelectorAll('.flow-bar').forEach((el) => el.remove());
	}

	function clearDropHost() {
		document.querySelectorAll('.drop-host').forEach((el) => el.classList.remove('drop-host'));
	}

	// boundsWithin converts a dragged element's on-screen position into
	// coordinates relative to the container it is being dropped into, which
	// is what the control's x/y mean once it lives there.
	function boundsWithin(el, hostEl) {
		const r = el.getBoundingClientRect();
		const host = hostEl.getBoundingClientRect();
		// Both rects are measured on screen, so the difference between them is
		// in screen pixels too and has to come back down to form pixels.
		return {
			x: Math.max(0, Math.round(toFormPx(r.left - host.left))),
			y: Math.max(0, Math.round(toFormPx(r.top - host.top))),
		};
	}

	// showGuides draws the snap lines geometry.js reports, so a snap is
	// visible rather than magic.
	function showGuides(guides, parent, slot) {
		clearGuides();
		const host = containerElFor(parent, slot);
		if (!host) return;
		for (const g of guides) {
			const el = document.createElement('div');
			el.className = 'align-guide ' + (g.axis === 'x' ? 'vertical' : 'horizontal') + (g.kind === 'center' ? ' center' : '');
			if (g.axis === 'x') {
				el.style.left = g.pos + 'px';
				el.style.top = g.from + 'px';
				el.style.height = Math.max(0, g.to - g.from) + 'px';
			} else {
				el.style.top = g.pos + 'px';
				el.style.left = g.from + 'px';
				el.style.width = Math.max(0, g.to - g.from) + 'px';
			}
			host.appendChild(el);
		}
	}

	function clearGuides() {
		document.querySelectorAll('.align-guide').forEach((g) => g.remove());
	}

	function onDragUp() {
		document.removeEventListener('mousemove', onDragMove);
		document.removeEventListener('mouseup', onDragUp);
		clearGuides();
		clearCellMarks();
		const state = dragState;
		dragState = null;
		const host = state && state.dropHost;
		clearDropHost();
		if (!state || !state.moved) return;

		const ops = [];
		const layout = state.layoutTarget;
		if (layout && layout.type === 'TableLayoutPanel' && state.cell) {
			// The control dragged lands in the cell under the mouse (swapping
			// with the one there); any others it was dragged with go into the
			// table's next free cells.
			const primary = findControl(state.id);
			if (primary) ops.push(...moveToCellOps(primary, layout, state.cell.column, state.cell.row));
			for (const m of state.members) {
				if (m.id === state.id) continue;
				const spec = findControl(m.id);
				if (spec && spec.parent !== layout.id) ops.push({ op: 'setParent', id: m.id, parent: layout.id, parentSlot: '' });
			}
		} else if (layout && layout.type === 'FlowLayoutPanel' && state.flowIndex !== null) {
			// A flow has no positions, only an order: the dragged controls go
			// in at the mark, in the order they had.
			const moving = canvasControls().filter((c) => state.members.some((m) => m.id === c.id)).map((c) => c.id);
			for (const id of moving) {
				const spec = findControl(id);
				if (spec && (spec.parent !== layout.id || spec.parentSlot)) ops.push({ op: 'setParent', id, parent: layout.id, parentSlot: '' });
			}
			const order = state.flowOrder.slice();
			order.splice(state.flowIndex, 0, ...moving);
			ops.push({ op: 'reorder', id: layout.id, order });
		} else {
			for (const m of state.members) {
				if (m.newX === undefined) continue;
				if (host) {
					// The move and the reparent are one action: the control's
					// x/y only mean anything relative to its new container, so
					// they are re-measured there rather than carried over.
					const at = boundsWithin(m.el, host.el);
					ops.push({ op: 'setParent', id: m.id, parent: host.parent, parentSlot: host.slot });
					ops.push({ op: 'setBounds', id: m.id, x: at.x, y: at.y, w: m.w, h: m.h });
				} else {
					ops.push({ op: 'setBounds', id: m.id, x: m.newX, y: m.newY, w: m.w, h: m.h });
				}
			}
		}
		if (ops.length) {
			post({ type: 'apply', ops });
		} else {
			// Nothing to write (a docked control dragged): put it back.
			prevDigests = [];
			renderCanvas();
		}
	}

	// ---------------------------------------------------------------------
	// Selection rectangle
	// ---------------------------------------------------------------------
	//
	// A drag on the form's background - or inside a selected container -
	// draws a rectangle, and every control of that container it touches is
	// selected on release, as in Visual Studio. Ctrl or Shift adds to the
	// selection instead of replacing it.

	function startLasso(e, parent, slot, hostEl) {
		if (e.button === 2) return;
		const additive = e.ctrlKey || e.metaKey || e.shiftKey;
		const base = additive ? [...selectedIds] : [];
		const hostRect = hostEl.getBoundingClientRect();
		const at = (ev) => ({ x: toFormPx((ev.clientX || 0) - hostRect.left), y: toFormPx((ev.clientY || 0) - hostRect.top) });
		const origin = at(e);
		const key = parentKey(parent, slot);
		const box = document.createElement('div');
		box.className = 'lasso';
		let rect = null;
		const hits = () => {
			const rects = canvasControls()
				.filter((c) => parentKey(c.parent, c.parentSlot) === key)
				.map((c) => Object.assign({ id: c.id }, drawnRect(rendered.get(c.id), c)));
			return geo().lassoSelect(rects, rect);
		};
		const move = (ev) => {
			const q = at(ev);
			if (!rect && Math.abs(q.x - origin.x) + Math.abs(q.y - origin.y) < 4) return;
			if (!rect) hostEl.appendChild(box);
			rect = geo().normalize(origin, q);
			box.style.left = rect.x + 'px';
			box.style.top = rect.y + 'px';
			box.style.width = rect.w + 'px';
			box.style.height = rect.h + 'px';
			const ids = new Set(hits());
			rendered.forEach((el, id) => el.classList.toggle('lasso-hit', ids.has(id)));
		};
		const up = () => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
			box.remove();
			rendered.forEach((el) => el.classList.remove('lasso-hit'));
			if (!rect) return;
			const ids = hits();
			if (!ids.length && !additive) return;
			selectIds(base.filter((id) => !ids.includes(id)).concat(ids));
			updateSelectionClasses();
			renderProperties();
			renderOutline();
			showTab('properties');
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}

	// ---------------------------------------------------------------------
	// Resize
	// ---------------------------------------------------------------------

	function onResizeMouseDown(e, spec, d) {
		e.stopPropagation();
		e.preventDefault();
		if (locked || tabOrderMode) {
			// The handles are hidden in both modes, so this is only reachable
			// if one is toggled on mid-drag - but a resize that still went
			// through would be exactly the accident Lock exists to prevent.
			return;
		}
		selectedId = spec.id;
		updateSelectionClasses();
		renderProperties();

		const drawn = drawnRect(d, spec);
		resizeState = {
			id: spec.id,
			el: d,
			parent: spec.parent || '',
			slot: spec.parentSlot || '',
			drawnX: drawn.x,
			drawnY: drawn.y,
			startClientX: e.clientX,
			startClientY: e.clientY,
			x: spec.x,
			y: spec.y,
			origW: spec.w,
			origH: spec.h,
			moved: false,
			newW: spec.w,
			newH: spec.h,
		};
		document.addEventListener('mousemove', onResizeMove);
		document.addEventListener('mouseup', onResizeUp);
	}

	function onResizeMove(e) {
		if (!resizeState) return;
		const dx = toFormPx(e.clientX - resizeState.startClientX);
		const dy = toFormPx(e.clientY - resizeState.startClientY);
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
			resizeState.moved = true;
		}
		if (!resizeState.moved) return;
		let nw = Math.max(10, Math.round(resizeState.origW + dx));
		let nh = Math.max(10, Math.round(resizeState.origH + dy));
		// The edges being pulled snap to the neighbours' and the container's,
		// as a move does; Alt resizes freely.
		const state = { parentId: parentKey(resizeState.parent, resizeState.slot), members: [{ id: resizeState.id }] };
		const snapped = geo().snapResize(
			{ x: resizeState.drawnX, y: resizeState.drawnY, w: nw, h: nh },
			['e', 's'],
			snapNeighbours(state),
			hostBox(resizeState.parent, resizeState.slot),
			e.altKey ? 0 : undefined
		);
		nw = Math.max(10, Math.round(snapped.rect.w));
		nh = Math.max(10, Math.round(snapped.rect.h));
		showGuides(snapped.guides, resizeState.parent, resizeState.slot);
		resizeState.el.style.width = nw + 'px';
		resizeState.el.style.height = nh + 'px';
		resizeState.newW = nw;
		resizeState.newH = nh;
	}

	function onResizeUp() {
		document.removeEventListener('mousemove', onResizeMove);
		document.removeEventListener('mouseup', onResizeUp);
		clearGuides();
		if (resizeState && resizeState.moved) {
			post({
				type: 'apply',
				ops: [
					{
						op: 'setBounds',
						id: resizeState.id,
						x: resizeState.x,
						y: resizeState.y,
						w: resizeState.newW,
						h: resizeState.newH,
					},
				],
			});
		}
		resizeState = null;
	}

	// ---------------------------------------------------------------------
	// Form (window) resize - same drag-a-corner-handle UX as a control's
	// resize handle, but targets the Form itself (goforms.NewForm's w/h,
	// plus SetClientSize if present - see the Go tool's "setForm" op) rather
	// than a control's SetBounds.
	// ---------------------------------------------------------------------

	let formResizeState = null;

	// axis is 'x', 'y' or 'xy' - which of the two dimensions this grip moves.
	function onFormResizeMouseDown(e, axis) {
		e.stopPropagation();
		e.preventDefault();
		if (locked) {
			return;
		}
		selectForm();

		formResizeState = {
			axis: axis || 'xy',
			startClientX: e.clientX,
			startClientY: e.clientY,
			origW: model.formWidth,
			origH: model.formHeight,
			moved: false,
			newW: model.formWidth,
			newH: model.formHeight,
		};
		document.addEventListener('mousemove', onFormResizeMove);
		document.addEventListener('mouseup', onFormResizeUp);
	}

	function onFormResizeMove(e) {
		if (!formResizeState) return;
		// An edge grip ignores movement on the axis it does not own, so a
		// hand that drifts while dragging the right edge cannot also change
		// the height.
		const dx = formResizeState.axis === 'y' ? 0 : toFormPx(e.clientX - formResizeState.startClientX);
		const dy = formResizeState.axis === 'x' ? 0 : toFormPx(e.clientY - formResizeState.startClientY);
		if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
			formResizeState.moved = true;
		}
		if (!formResizeState.moved) return;
		const nw = Math.max(100, Math.round(formResizeState.origW + dx));
		const nh = Math.max(80, Math.round(formResizeState.origH + dy));
		const canvas = $('form-canvas');
		if (canvas) {
			canvas.style.width = nw + 'px';
			canvas.style.height = nh + 'px';
			const titleBar = canvas.querySelector('.form-titlebar');
			if (titleBar) {
				titleBar.textContent = `${model.formTitle}  (${nw}×${nh})  — ${model.receiverType}`;
			}
		}
		formResizeState.newW = nw;
		formResizeState.newH = nh;
	}

	function onFormResizeUp() {
		document.removeEventListener('mousemove', onFormResizeMove);
		document.removeEventListener('mouseup', onFormResizeUp);
		if (formResizeState && formResizeState.moved) {
			post({
				type: 'apply',
				ops: [{ op: 'setForm', id: '', w: formResizeState.newW, h: formResizeState.newH }],
			});
		}
		formResizeState = null;
	}

	// ---------------------------------------------------------------------
	// Properties panel
	// ---------------------------------------------------------------------

	// propsDigest is what the panel currently shows. Rebuilding it costs the
	// user their scroll position and the focus in whatever field they were
	// using, so it is only worth doing when something it displays has
	// actually changed - not on every model refresh.
	let propsDigest = null;

	function renderProperties() {
		const panel = $('properties-panel');
		const spec = selectedId ? findControl(selectedId) : null;

		if (selectedColumn && selectedColumn.id !== selectedId) {
			// The grid it was picked on loses the mark.
			const was = findControl(selectedColumn.id);
			selectedColumn = null;
			const el = was && rendered.get(was.id);
			if (el) updateControlContent(el, was);
		}
		const digest = JSON.stringify([
			selectedId,
			selectedColumn && selectedColumn.index,
			selectedIds.size,
			// The form's own panel is what shows when nothing is selected, so
			// its values belong in the digest too.
			model && [model.formTitle, model.formWidth, model.formHeight, model.formProps, model.formEvents],
			// The parent picker lists every container on the form, so it goes
			// stale when controls are added or removed elsewhere.
			model ? model.controls.map((c) => c.id) : null,
			spec && [
				spec.type, spec.id, spec.parent, spec.parentSlot, spec.supported,
				spec.x, spec.y, spec.w, spec.h,
				spec.text, spec.items, spec.props, spec.events,
				spec.collection, spec.collectionReadOnly,
			],
		]);
		if (digest === propsDigest) return;
		propsDigest = digest;

		// Rebuilding would otherwise jump back to the top, so the property
		// just changed scrolls out of sight the moment it is changed - and
		// the field the user was in, with whatever they had typed and not yet
		// committed, would be gone.
		const snap = inspectorSnapshot(panel, selectedId || '');
		panel.innerHTML = '';
		if (!spec) {
			appendFormGroup(panel);
			restoreInspector(panel, snap, '');
			return;
		}

		const desc = catalog[spec.type];

		const h3 = document.createElement('h3');
		h3.textContent = `${spec.type} · ${spec.id}`;
		panel.appendChild(h3);

		if (!spec.supported) {
			const note = document.createElement('div');
			note.className = 'hint';
			note.style.marginBottom = '10px';
			note.textContent =
				"This control type isn't recognized by the designer's catalog, so it is shown read-only here to avoid corrupting its source. Edit it directly in the .go file if needed.";
			panel.appendChild(note);
			appendBoundsGroup(panel, spec, true);
			return;
		}

		// A tray component has no position, no size and no container, so the
		// three groups that edit those would all be lies. Everything below
		// them - properties, events, delete - applies unchanged.
		if (isComponent(spec)) {
			const note = document.createElement('div');
			note.className = 'hint';
			note.style.marginBottom = '10px';
			note.textContent =
				'A component belongs to the form but is not on it, so it has no position or size. It is a field like any other control: rename it, set its properties, wire its events.';
			panel.appendChild(note);
			appendNameGroup(panel, spec);
		} else {
			if (selectedIds.size > 1) {
				appendAlignGroup(panel);
			}
			appendNameGroup(panel, spec);
			appendParentGroup(panel, spec);
			appendBoundsGroup(panel, spec, false);
			const parent = spec.parent && !spec.parentSlot ? findControl(spec.parent) : null;
			if (parent && parent.type === 'TableLayoutPanel') appendCellGroup(panel, spec);
		}
		if (spec.type === 'TableLayoutPanel') appendTableGroup(panel, spec);

		if (desc && desc.Setters && desc.Setters.SetText !== undefined) {
			appendTextGroup(panel, spec);
		}

		// ListView and DataGridView reuse Items for their column titles, so
		// the same editor serves both - only the label differs.
		if (spec.type === 'ComboBox' || spec.type === 'ListBox') {
			appendItemsGroup(panel, spec, 'Items');
		} else if (spec.type === 'DataGridView') {
			if (selectedColumn && selectedColumn.id === spec.id) appendColumnGroup(panel, spec, selectedColumn.index);
			appendColumnsGroup(panel, spec);
		} else if (spec.type === 'ListView') {
			appendItemsGroup(panel, spec, 'Columns');
		}

		if (desc && desc.Collection) {
			appendCollectionGroup(panel, spec, desc.Collection);
		}

		const editableProps = propsOf(desc);
		if (editableProps.length) {
			appendPropsGroup(panel, spec, editableProps, desc);
		}
		if (!isComponent(spec)) appendExtenderGroups(panel, spec, desc);

		if (desc && desc.Events && desc.Events.length) {
			appendEventsGroup(panel, spec, desc.Events, desc);
		}

		appendDeleteButton(panel, spec);
		restoreInspector(panel, snap, selectedId || '');
	}

	// inspectorSnapshot records what a rebuild of the panel must not lose:
	// the scroll position, the field with the focus, and what is typed in it
	// but not committed yet - as long as the panel still shows the same
	// control.
	function inspectorSnapshot(panel, key) {
		const snap = { key: panel.dataset.key, scroll: panel.scrollTop, focus: null };
		panel.dataset.key = key;
		const a = document.activeElement;
		if (!a || !panel.contains || !panel.contains(a)) return snap;
		const row = a.closest && a.closest('[data-prop]');
		if (!row) return snap;
		snap.focus = {
			prop: row.dataset.prop,
			tag: a.tagName,
			check: a.type === 'checkbox' ? a.dataset.style || a.value : null,
			value: a.tagName === 'INPUT' && a.dataset.initial !== undefined && a.value !== a.dataset.initial ? a.value : null,
			start: a.selectionStart,
			end: a.selectionEnd,
		};
		return snap;
	}

	function restoreInspector(panel, snap, key) {
		if (snap.key !== key) return;
		panel.scrollTop = snap.scroll;
		const f = snap.focus;
		if (!f) return;
		const row = [...panel.querySelectorAll('.prop-row')].concat([...panel.querySelectorAll('.coll-row')]).find((r) => r.dataset.prop === f.prop);
		if (!row) return;
		const fields = row.descendants ? row.descendants : [...row.querySelectorAll('*')];
		const target = fields.find((el) => el.tagName === f.tag && (f.check === null || el.dataset.style === f.check || el.value === f.check));
		if (!target || target.disabled) return;
		if (f.value !== null) target.value = f.value;
		target.focus({ preventScroll: true });
		if (f.value !== null && target.setSelectionRange && f.start !== null && f.start !== undefined) {
			try {
				target.setSelectionRange(f.start, f.end);
			} catch {
				// Number inputs have no selection to restore.
			}
		}
	}

	// appendAlignGroup offers the WinForms Format menu's alignment and
	// spacing commands for a multi-selection. Everything aligns to the
	// primary control - the last one clicked - which is the same rule the
	// WinForms designer uses.
	function appendAlignGroup(panel) {
		const g = groupEl(`Align ${selectedIds.size} controls`);

		const commands = [
			['Left', 'left'],
			['Centre', 'center'],
			['Right', 'right'],
			['Top', 'top'],
			['Middle', 'middle'],
			['Bottom', 'bottom'],
			['Same width', 'sameWidth'],
			['Same height', 'sameHeight'],
			['Same size', 'sameSize'],
			['Space across', 'spaceX'],
			['Space down', 'spaceY'],
		];

		const row = document.createElement('div');
		row.className = 'align-buttons';
		for (const [label, how] of commands) {
			const btn = document.createElement('button');
			btn.className = 'align-btn';
			btn.textContent = label;
			btn.dataset.align = how;
			if ((how === 'spaceX' || how === 'spaceY') && selectedIds.size < 3) btn.disabled = true;
			btn.addEventListener('click', () => applyAlign(how));
			row.appendChild(btn);
		}
		g.appendChild(row);

		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent = 'Aligns to the last-clicked control; spacing evens the gaps between the first and the last. Ctrl or Shift click to extend the selection.';
		g.appendChild(hint);
		panel.appendChild(g);
	}

	// applyAlign runs one Format command (see geometry.js) over the selected
	// controls of the primary one's container.
	function applyAlign(how) {
		const anchor = findControl(selectedId);
		if (!anchor) return;
		const key = parentKey(anchor.parent, anchor.parentSlot);
		const specs = selectedSpecs().filter((s) => !isComponent(s) && parentKey(s.parent, s.parentSlot) === key);
		const rects = {};
		for (const s of specs) rects[s.id] = { x: s.x, y: s.y, w: s.w, h: s.h };
		const out = how === 'spaceX' ? geo().spaceEvenly(rects, 'x') : how === 'spaceY' ? geo().spaceEvenly(rects, 'y') : geo().align(rects, anchor.id, how);

		const ops = [];
		for (const spec of specs) {
			const next = out[spec.id];
			if (next.x === spec.x && next.y === spec.y && next.w === spec.w && next.h === spec.h) {
				continue;
			}
			ops.push({
				op: 'setBounds',
				id: spec.id,
				x: Math.round(next.x),
				y: Math.round(next.y),
				w: Math.round(next.w),
				h: Math.round(next.h),
			});
		}
		if (ops.length) {
			post({ type: 'apply', ops });
		}
	}

	// appendNameGroup renames the control: the struct field, every reference
	// to it, and any handler still named after it. The tool refuses invalid
	// or already-taken names, so this only has to reset the box on failure.
	function appendNameGroup(panel, spec) {
		const g = groupEl('Name');
		const row = document.createElement('div');
		row.className = 'prop-row';
		const label = document.createElement('label');
		label.textContent = 'Name';
		const input = document.createElement('input');
		input.type = 'text';
		input.value = spec.id;

		const commit = () => {
			const next = input.value.trim();
			if (!next || next === spec.id) {
				input.value = spec.id;
				return;
			}
			// Select the new id once the model comes back, so the panel does
			// not jump to "nothing selected" after a successful rename.
			setSelection(next, false);
			post({ type: 'apply', ops: [{ op: 'rename', id: spec.id, value: next }] });
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') input.blur();
		});

		row.appendChild(label);
		row.appendChild(input);
		g.appendChild(row);
		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent = 'Renames the field and any handler named after it.';
		g.appendChild(hint);
		panel.appendChild(g);
	}

	// appendParentGroup moves a control between containers from the panel,
	// which is the only way to reach a container too small or too crowded to
	// drop onto - and the only way to see, in words, which half of a
	// SplitContainer a control is actually in.
	function appendParentGroup(panel, spec) {
		const g = groupEl('Parent');
		const row = document.createElement('div');
		row.className = 'prop-row';
		const label = document.createElement('label');
		label.textContent = 'In';
		const select = document.createElement('select');

		const current = parentKey(spec.parent, spec.parentSlot);
		const options = [{ key: '', text: '(Form)' }];
		for (const other of model.controls) {
			// A container can't go inside itself or anything it contains.
			if (other.id === spec.id || isInsideAny(other.id, new Set([spec.id]))) continue;
			const desc = catalog[other.type];
			if (!desc) continue;
			const slots = slotsFor(other);
			if (slots.length) {
				for (const slot of slots) {
					options.push({ key: parentKey(other.id, slot), text: `${other.id} · ${slot}` });
				}
			} else if (desc.IsContainer) {
				options.push({ key: other.id, text: other.id });
			}
		}

		for (const opt of options) {
			const o = document.createElement('option');
			o.value = opt.key;
			o.textContent = opt.text;
			if (opt.key === current) o.selected = true;
			select.appendChild(o);
		}

		select.addEventListener('change', () => {
			const [parent, slot] = splitParentKey(select.value);
			// Bounds are relative to the new container, so a control moved
			// this way lands at a sane spot rather than wherever its old
			// coordinates happen to point.
			post({
				type: 'apply',
				ops: [
					{ op: 'setParent', id: spec.id, parent, parentSlot: slot },
					{ op: 'setBounds', id: spec.id, x: 8, y: 8, w: spec.w, h: spec.h },
				],
			});
		});

		row.appendChild(label);
		row.appendChild(select);
		g.appendChild(row);
		panel.appendChild(g);
	}

	function splitParentKey(key) {
		const i = key.indexOf('/');
		return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
	}

	function groupEl(title) {
		const g = document.createElement('div');
		g.className = 'prop-group';
		g.dataset.group = title;
		const t = document.createElement('div');
		t.className = 'prop-group-title';
		t.textContent = title;
		g.appendChild(t);
		return g;
	}

	function numberInput(value) {
		const input = document.createElement('input');
		input.type = 'number';
		input.value = String(Math.round(value));
		return input;
	}

	function appendBoundsGroup(panel, spec, readOnly) {
		const g = groupEl('Bounds');
		const xIn = numberInput(spec.x);
		const yIn = numberInput(spec.y);
		const wIn = numberInput(spec.w);
		const hIn = numberInput(spec.h);
		[
			['X', xIn],
			['Y', yIn],
			['W', wIn],
			['H', hIn],
		].forEach(([labelText, input]) => {
			const row = document.createElement('div');
			row.className = 'prop-row';
			const label = document.createElement('label');
			label.textContent = labelText;
			input.readOnly = readOnly;
			if (readOnly) input.disabled = true;
			row.appendChild(label);
			row.appendChild(input);
			g.appendChild(row);
		});

		if (!readOnly) {
			const commit = () => {
				const x = parseFloat(xIn.value) || 0;
				const y = parseFloat(yIn.value) || 0;
				const w = Math.max(1, parseFloat(wIn.value) || 1);
				const h = Math.max(1, parseFloat(hIn.value) || 1);
				post({ type: 'apply', ops: [{ op: 'setBounds', id: spec.id, x, y, w, h }] });
			};
			[xIn, yIn, wIn, hIn].forEach((input) => {
				input.addEventListener('change', commit);
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') input.blur();
				});
			});
		}

		panel.appendChild(g);
	}

	function appendTextGroup(panel, spec) {
		const g = groupEl('Text');
		const row = document.createElement('div');
		row.className = 'prop-row';
		const label = document.createElement('label');
		label.textContent = 'Text';
		const input = document.createElement('input');
		input.type = 'text';
		input.value = spec.text || '';
		const commit = () => {
			post({ type: 'apply', ops: [{ op: 'setText', id: spec.id, text: input.value }] });
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') input.blur();
		});
		row.appendChild(label);
		row.appendChild(input);
		g.appendChild(row);
		panel.appendChild(g);
	}

	function appendItemsGroup(panel, spec, title) {
		const g = groupEl(title);
		const row = document.createElement('div');
		row.className = 'prop-row';
		const label = document.createElement('label');
		label.textContent = title;
		const ta = document.createElement('textarea');
		ta.value = (spec.items || []).join('\n');
		ta.placeholder = 'One item per line';
		const commit = () => {
			let items = ta.value.split('\n');
			if (items.length && items[items.length - 1] === '') {
				items = items.slice(0, -1);
			}
			post({ type: 'apply', ops: [{ op: 'setItems', id: spec.id, items }] });
		};
		ta.addEventListener('change', commit);
		row.appendChild(label);
		row.appendChild(ta);
		g.appendChild(row);
		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent = 'One item per line.';
		g.appendChild(hint);
		panel.appendChild(g);
	}

	// ---------------------------------------------------------------------
	// Column editor (DataGridView)
	// ---------------------------------------------------------------------
	//
	// A grid's columns are the one list whose entries carry more than a
	// caption: each one is also a *kind* (text, button, checkbox) and may be
	// hidden - a column that holds the id a row was loaded by without being
	// drawn. That does not fit the plain one-per-line Items editor, and it is
	// not a CollectionDesc either, because the titles live in the constructor
	// and the rest in indexed setters after it. So it has its own editor and
	// its own op, which rewrites both places at once.

	const COLUMN_KINDS = [
		{ value: '', label: 'Text' },
		{ value: 'Button', label: 'Button' },
		{ value: 'CheckBox', label: 'Checkbox' },
	];

	// The grid's columns, as the table the setColumns op takes.
	function gridColumnsOf(spec) {
		return (spec.columns && spec.columns.length ? spec.columns : (spec.items || []).map((t) => ({ title: t }))).map((c) => Object.assign({}, c));
	}

	const SIZE_MODES = [
		{ value: '', label: '(the grid\'s)' },
		{ value: 'SizeFixed', label: 'Fixed' },
		{ value: 'SizeToContent', label: 'To content' },
		{ value: 'SizeFill', label: 'Fill' },
	];
	const ALIGNS = [
		{ value: '', label: 'Left' },
		{ value: 'AlignCenter', label: 'Centre' },
		{ value: 'AlignRight', label: 'Right' },
	];

	// appendColumnGroup edits the one column picked on the canvas (or with
	// ⚙ in the Columns list): everything about it, in rows like any other
	// properties.
	function appendColumnGroup(panel, spec, index) {
		const columns = gridColumnsOf(spec);
		const col = columns[index];
		if (!col) return;
		const g = groupEl(`Column ${index + 1}: ${col.title || ''}`);
		const commit = () => post({ type: 'apply', ops: [{ op: 'setColumns', id: spec.id, columns }] });
		const row = (label, key, el, help) => {
			const r = document.createElement('div');
			r.className = 'prop-row';
			r.dataset.prop = 'column.' + key;
			const l = document.createElement('label');
			l.textContent = label;
			r.appendChild(l);
			r.appendChild(el);
			r.addEventListener('mouseenter', () => showHelp(label, help));
			g.appendChild(r);
		};
		const text = (value, commitValue) => {
			const input = document.createElement('input');
			input.type = 'text';
			input.value = value || '';
			input.dataset.initial = input.value;
			input.addEventListener('change', () => commitValue(input.value));
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') input.blur();
			});
			return input;
		};
		const select = (options, value, commitValue) => {
			const sel = document.createElement('select');
			for (const o of options) {
				const opt = document.createElement('option');
				opt.value = o.value;
				opt.textContent = o.label;
				sel.appendChild(opt);
			}
			sel.value = value || '';
			sel.addEventListener('change', () => commitValue(sel.value));
			return sel;
		};
		const check = (value, commitValue) => {
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = !!value;
			cb.addEventListener('change', () => commitValue(cb.checked));
			return cb;
		};
		const set = (key, v) => {
			if (v === '' || v === false || v === 0 || v === undefined) delete col[key];
			else col[key] = v;
			commit();
		};

		row('HeaderText', 'title', text(col.title, (v) => { col.title = v; commit(); }), 'The caption in the column\'s header.');
		row('ColumnType', 'kind', select(COLUMN_KINDS, col.kind, (v) => {
			set('kind', v);
		}), 'What the cells are: text, a button per row, or a check box.');
		if (col.kind === 'Button') {
			row('Text', 'buttonText', text(col.buttonText, (v) => set('buttonText', v.trim())), 'The caption on every button; empty uses each cell\'s own value.');
		}
		row('DataPropertyName', 'dataPropertyName', text(col.dataPropertyName, (v) => set('dataPropertyName', v.trim())), 'The field of a bound record this column shows.');
		const width = document.createElement('input');
		width.type = 'number';
		width.min = '0';
		width.value = col.width ? String(col.width) : '';
		width.placeholder = '100';
		width.addEventListener('change', () => set('width', Math.max(0, Number(width.value) || 0)));
		row('Width', 'width', width, 'A fixed width in pixels. Setting one makes the column Fixed.');
		row('AutoSizeMode', 'sizeMode', select(SIZE_MODES, col.sizeMode, (v) => set('sizeMode', v)), 'How this column is sized: a fixed width, the width of its content, or a share of what the others leave. Empty follows the grid\'s mode.');
		row('Alignment', 'align', select(ALIGNS, col.align, (v) => set('align', v)), 'Where the column\'s text sits, header included.');
		row('ReadOnly', 'readOnly', check(col.readOnly, (v) => set('readOnly', v)), 'Whether the cells of this column can be edited.');
		row('Visible', 'hidden', check(!col.hidden, (v) => set('hidden', !v)), 'A hidden column keeps its data - Cell() still reads it - but is not drawn.');
		panel.appendChild(g);
	}

	function appendColumnsGroup(panel, spec) {
		const g = groupEl('Columns');
		// Edits are staged against a local copy and sent as one setColumns -
		// the tool rewrites the whole table every time, so there is no partial
		// state to keep in sync. Same shape as the collection editor.
		const columns = (spec.columns || []).map((c) => Object.assign({}, c));
		if (!columns.length) {
			(spec.items || []).forEach((t) => columns.push({ title: t }));
		}

		const commit = () => {
			post({ type: 'apply', ops: [{ op: 'setColumns', id: spec.id, columns }] });
		};

		const list = document.createElement('div');
		list.className = 'coll-list';
		columns.forEach((_, i) => list.appendChild(buildColumnRow(spec, columns, i, commit)));
		g.appendChild(list);

		const add = document.createElement('button');
		add.className = 'coll-add';
		add.textContent = '+ Column';
		add.addEventListener('click', () => {
			columns.push({ title: 'Column ' + (columns.length + 1) });
			commit();
		});
		g.appendChild(add);

		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent =
			'A button column reports presses through CellButtonClick; an empty caption uses each cell’s own value. ' +
			'A hidden column keeps its data — read it with Cell(row, col).';
		g.appendChild(hint);

		panel.appendChild(g);
	}

	function buildColumnRow(spec, columns, i, commit) {
		const col = columns[i];
		const row = document.createElement('div');
		row.className = 'coll-row';
		row.draggable = true;

		const grip = document.createElement('span');
		grip.className = 'coll-grip';
		grip.textContent = '⠿';
		row.appendChild(grip);

		const title = document.createElement('input');
		title.type = 'text';
		title.className = 'coll-text';
		title.value = col.title || '';
		title.title = 'Header caption';
		title.addEventListener('change', () => {
			col.title = title.value;
			commit();
		});
		title.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') title.blur();
		});
		row.appendChild(title);

		const kind = document.createElement('select');
		kind.className = 'coll-kind';
		kind.title = 'What the cells in this column are';
		COLUMN_KINDS.forEach((k) => {
			const o = document.createElement('option');
			o.value = k.value;
			o.textContent = k.label;
			kind.appendChild(o);
		});
		kind.value = col.kind || '';
		kind.addEventListener('change', () => {
			col.kind = kind.value;
			if (col.kind !== 'Button') {
				// A caption means nothing on a column that draws no button,
				// and keeping it would write a line the grid ignores.
				delete col.buttonText;
			}
			commit();
		});
		row.appendChild(kind);

		if (col.kind === 'Button') {
			const caption = document.createElement('input');
			caption.type = 'text';
			caption.className = 'coll-handler';
			caption.value = col.buttonText || '';
			caption.placeholder = 'cell value';
			caption.title = 'Caption on every button in this column; empty uses each cell’s own value.';
			caption.addEventListener('change', () => {
				col.buttonText = caption.value.trim();
				commit();
			});
			caption.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') caption.blur();
			});
			row.appendChild(caption);
		}

		const dataProp = document.createElement('input');
		dataProp.type = 'text';
		dataProp.className = 'coll-field';
		dataProp.value = col.dataPropertyName || '';
		dataProp.placeholder = 'field';
		dataProp.title = 'DataPropertyName: the field of a bound record this column shows';
		dataProp.addEventListener('change', () => {
			col.dataPropertyName = dataProp.value.trim();
			if (!col.dataPropertyName) delete col.dataPropertyName;
			commit();
		});
		dataProp.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') dataProp.blur();
		});
		row.appendChild(dataProp);

		row.appendChild(iconButton('⚙', 'Edit everything about this column: width, sizing, alignment, read-only', () => pickColumn(spec.id, i)));
		row.appendChild(
			iconButton(col.hidden ? '🚫' : '👁', col.hidden ? 'Hidden: shown in code only' : 'Visible', () => {
				col.hidden = !col.hidden;
				commit();
			})
		);
		row.appendChild(
			iconButton('⌫', 'Delete this column', () => {
				if (columns.length <= 1) return; // a grid with no columns is an empty box
				columns.splice(i, 1);
				commit();
			})
		);

		// Reordering by drag, exactly as the collection editor does it.
		row.addEventListener('dragstart', (e) => {
			e.dataTransfer.setData('text/plain', String(i));
			e.dataTransfer.effectAllowed = 'move';
			row.classList.add('dragging');
		});
		row.addEventListener('dragend', () => row.classList.remove('dragging'));
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			row.classList.add('drop-target');
		});
		row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			row.classList.remove('drop-target');
			const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
			if (isNaN(from) || from === i) return;
			const [moved] = columns.splice(from, 1);
			columns.splice(i, 0, moved);
			commit();
		});

		return row;
	}

	// ---------------------------------------------------------------------
	// Collection editor (ToolStrip buttons, tabs, pages, tree nodes)
	// ---------------------------------------------------------------------
	//
	// Everything about the shape of a collection - what its items are called,
	// whether they carry a click handler, whether they nest - comes from the
	// type's CollectionDesc in the tool's catalog, so this editor never needs
	// a per-type branch of its own.

	// handlerNameFor suggests the WinForms-style default name for an item's
	// click handler: `<controlId>_<Text>`, with anything that isn't valid in a
	// Go identifier dropped.
	function handlerNameFor(spec, item, index) {
		const slug = String(item.text || '')
			.replace(/[^A-Za-z0-9_]/g, '')
			.replace(/^[0-9]+/, '');
		return `${spec.id}_${slug || 'Item' + (index + 1)}`;
	}

	function appendCollectionGroup(panel, spec, cd) {
		const g = groupEl(cd.Label);
		// Edits are staged against a local copy and sent as one setCollection
		// op - the tool rewrites the whole list every time, so there is no
		// partial state to keep in sync.
		const items = collectionOf(spec).map((it) => Object.assign({}, it));

		if (spec.collectionReadOnly) {
			const note = document.createElement('div');
			note.className = 'hint';
			note.textContent = `These ${cd.Label.toLowerCase()} are built by code the designer can't regenerate (a computed title, or a node hanging off an unknown variable), so they are shown read-only. Edit them in the .go file.`;
			g.appendChild(note);
			for (const item of items) {
				const row = document.createElement('div');
				row.className = 'coll-row readonly';
				row.textContent = item.kind === 'separator' ? '——————' : item.text;
				g.appendChild(row);
			}
			panel.appendChild(g);
			return;
		}

		const commit = () => {
			// A button whose handler box was filled in needs the method to
			// exist before the add call referencing it lands in the file.
			const handlers = items
				.filter((it) => it.kind !== 'separator' && it.handler)
				.map((it) => ({ method: it.handler, paramType: cd.HandlerArgs || 'none' }));
			post({
				type: 'apply',
				ops: [{ op: 'setCollection', id: spec.id, collection: items }],
				handlers,
			});
		};

		const list = document.createElement('div');
		list.className = 'coll-list';
		const depths = cd.Tree ? normalizedDepths(items) : null;

		items.forEach((item, i) => {
			list.appendChild(buildCollectionRow(spec, cd, items, i, depths, commit));
		});
		g.appendChild(list);

		const actions = document.createElement('div');
		actions.className = 'coll-actions';

		const addBtn = document.createElement('button');
		addBtn.className = 'coll-add';
		addBtn.textContent = `+ ${singular(cd.Label)}`;
		addBtn.addEventListener('click', () => {
			// New items land at the depth of the one above, so adding to a
			// nested branch keeps you in that branch.
			const depth = cd.Tree && items.length ? normalizedDepths(items).pop() : 0;
			items.push({ text: `${singular(cd.Label)} ${items.length + 1}`, depth });
			commit();
		});
		actions.appendChild(addBtn);

		if (cd.Separator) {
			const sepBtn = document.createElement('button');
			sepBtn.className = 'coll-add';
			sepBtn.textContent = '+ Separator';
			sepBtn.addEventListener('click', () => {
				items.push({ text: '', kind: 'separator' });
				commit();
			});
			actions.appendChild(sepBtn);
		}
		g.appendChild(actions);

		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent = cd.Tree
			? 'Drag a row to reorder. ⇥ and ⇤ nest a node under the one above it.'
			: 'Drag a row to reorder.';
		g.appendChild(hint);

		panel.appendChild(g);
	}

	// singular turns the catalog's plural label into what one item is called,
	// for the "+ Tab" / "+ Node" buttons.
	function singular(label) {
		return label.endsWith('s') ? label.slice(0, -1) : label;
	}

	function buildCollectionRow(spec, cd, items, i, depths, commit) {
		const item = items[i];
		const row = document.createElement('div');
		row.className = 'coll-row';
		row.draggable = true;
		row.dataset.index = String(i);
		if (depths) {
			row.style.marginLeft = depths[i] * 14 + 'px';
		}

		const grip = document.createElement('span');
		grip.className = 'coll-grip';
		grip.textContent = '⠿';
		row.appendChild(grip);

		if (item.kind === 'separator') {
			const sep = document.createElement('span');
			sep.className = 'coll-sep-label';
			sep.textContent = 'separator';
			row.appendChild(sep);
		} else {
			const text = document.createElement('input');
			text.type = 'text';
			text.className = 'coll-text';
			text.value = item.text || '';
			text.addEventListener('change', () => {
				item.text = text.value;
				commit();
			});
			text.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') text.blur();
			});
			row.appendChild(text);

			// A menu bar's own entries are menus: no handler, always enabled.
			const onBar = cd.TopLevel && depths && depths[i] === 0;
			if (cd.Handler && !onBar) {
				const handler = document.createElement('input');
				handler.type = 'text';
				handler.className = 'coll-handler';
				handler.value = item.handler || '';
				handler.placeholder = handlerNameFor(spec, item, i);
				handler.title = 'Method called when this button is clicked; leave empty for none.';
				handler.addEventListener('change', () => {
					item.handler = handler.value.trim();
					commit();
				});
				handler.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') handler.blur();
				});
				row.appendChild(handler);

				const wire = document.createElement('button');
				wire.className = 'coll-btn';
				wire.textContent = item.handler ? '→' : '⚡';
				wire.title = item.handler
					? `Jump to ${item.handler}()`
					: 'Create and wire a click handler for this button';
				wire.addEventListener('click', () => {
					if (item.handler) {
						post({ type: 'gotoHandler', id: spec.id, event: 'Click', handler: item.handler });
						return;
					}
					item.handler = handler.value.trim() || handler.placeholder;
					commit();
				});
				row.appendChild(wire);
			}
		}

		if (cd.InCtor && item.kind !== 'separator' && !(cd.TopLevel && depths && depths[i] === 0)) {
			row.appendChild(
				iconButton(item.disabled ? '⊘' : '✓', item.disabled ? 'Disabled - click to enable' : 'Enabled - click to disable', () => {
					item.disabled = !item.disabled;
					if (!item.disabled) delete item.disabled;
					commit();
				})
			);
		}

		if (cd.Tree) {
			row.appendChild(
				iconButton('⇤', 'Move out one level', () => {
					item.depth = Math.max(0, (depths[i] || 0) - 1);
					commit();
				})
			);
			row.appendChild(
				iconButton('⇥', 'Nest under the row above', () => {
					item.depth = (depths[i] || 0) + 1;
					commit();
				})
			);
		}

		row.appendChild(
			iconButton('⌫', `Delete this ${singular(cd.Label).toLowerCase()}`, () => {
				items.splice(i, 1);
				commit();
			})
		);

		// Reordering by drag: the row records where it came from, the row it
		// is dropped on splices it into place, and the whole list is sent as
		// one setCollection.
		row.addEventListener('dragstart', (e) => {
			e.dataTransfer.setData('text/plain', String(i));
			e.dataTransfer.effectAllowed = 'move';
			row.classList.add('dragging');
		});
		row.addEventListener('dragend', () => row.classList.remove('dragging'));
		row.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			row.classList.add('drop-target');
		});
		row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
		row.addEventListener('drop', (e) => {
			e.preventDefault();
			row.classList.remove('drop-target');
			const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
			if (isNaN(from) || from === i) return;
			const [moved] = items.splice(from, 1);
			items.splice(i, 0, moved);
			commit();
		});

		return row;
	}

	function iconButton(glyph, title, onClick) {
		const b = document.createElement('button');
		b.className = 'coll-btn';
		b.textContent = glyph;
		b.title = title;
		b.addEventListener('click', onClick);
		return b;
	}

	// propKind mirrors the tool's kindOf(): a prop with no declared kind is
	// a string. Keep the fallbacks in sync with catalog.go.
	function propKind(desc, prop) {
		if (desc && desc.Kinds && desc.Kinds[prop]) return desc.Kinds[prop];
		// "checked" predates the Kinds map and is a bool everywhere it appears.
		if (prop === 'checked') return 'bool';
		return 'string';
	}

	// propsOf lists the editable properties of a type, whichever of the four
	// ways the Go tool writes them it uses: a setter call, an exported field
	// (the dialogs), a bare method standing for a bool (a Timer's Start), or
	// a constructor argument (its interval). The panel does not care which -
	// it sends `setProp` and the tool picks the shape - so they are one
	// sorted list here.
	//
	// `text` is excluded: it has its own editor above.
	function propsOf(desc) {
		if (!desc) return [];
		const props = new Set();
		for (const prop of Object.values(desc.Setters || {})) props.add(prop);
		for (const prop of Object.values(desc.Fields || {})) props.add(prop);
		for (const prop of Object.keys(desc.Calls || {})) props.add(prop);
		for (const prop of desc.CtorProps || []) props.add(prop);
		for (const prop of desc.Special || []) props.add(prop);
		props.delete('text');
		return [...props].sort((a, b) => a.localeCompare(b));
	}

	// BASE_PROPS are the properties every control inherits from ControlBase.
	// They go in a group of their own below the type's own, the way the
	// Visual Studio grid keeps Layout and Appearance apart from what makes a
	// control that control.
	const BASE_PROPS = ['anchor', 'dock', 'padding', 'tabIndex', 'tabStop', 'visible', 'enabled', 'foreColor', 'backColor', 'font'];

	function appendPropsGroup(panel, spec, props, desc) {
		const own = props.filter((p) => !BASE_PROPS.includes(p) || spec.type === 'Form');
		const base = BASE_PROPS.filter((p) => props.includes(p) && spec.type !== 'Form');
		const build = (title, list) => {
			if (!list.length) return;
			const g = groupEl(title);
			for (const prop of list) g.appendChild(propertyRow(spec, desc, prop));
			panel.appendChild(g);
		};
		build('Properties', own);
		build('Layout and appearance', base);
	}

	// propertyRow is one property: its name (bold when the file sets it),
	// its editor, and ↺ to put it back to its default by deleting the line
	// that sets it.
	function propertyRow(spec, desc, prop) {
		const row = document.createElement('div');
		row.className = 'prop-row';
		row.dataset.prop = prop;
		const label = document.createElement('label');
		label.textContent = prop;
		const set = spec.props && spec.props[prop] !== undefined && spec.props[prop] !== '';
		const resettable = set && !(desc && desc.CtorProps && desc.CtorProps.includes(prop));
		if (resettable) label.classList.add('modified');
		row.appendChild(label);
		row.appendChild(propEditor(spec, desc, prop));
		if (resettable) {
			const reset = document.createElement('button');
			reset.className = 'reset-btn';
			reset.textContent = '↺';
			reset.title = 'Reset to the default (deletes the line that sets it)';
			reset.addEventListener('click', () => post({ type: 'apply', ops: [{ op: 'resetProp', id: spec.id, prop }] }));
			row.appendChild(reset);
		}
		const help = desc && desc.Descriptions && desc.Descriptions[prop];
		if (help) row.title = help;
		row.addEventListener('mouseenter', () => showHelp(prop, help));
		row.addEventListener('focusin', () => showHelp(prop, help));
		return row;
	}

	// showHelp fills the box under the property panel with what the property
	// or event under the mouse does.
	function showHelp(name, text) {
		const box = $('prop-help');
		if (!box) return;
		box.innerHTML = '';
		const b = document.createElement('b');
		b.textContent = name;
		const t = document.createElement('div');
		t.textContent = text || '';
		box.appendChild(b);
		box.appendChild(t);
	}

	// propEditor is the editor for one property, by its kind: a checkbox, a
	// spinner, a dropdown, a row of flags - and for Anchor, Dock, a color, a
	// font and a padding, the visual editors the Visual Studio grid has.
	function propEditor(spec, desc, prop) {
		const current = (spec.props && spec.props[prop]) || '';
		const kind = propKind(desc, prop);
		const send = (value) => {
			post({ type: 'apply', ops: [{ op: 'setProp', id: spec.id, prop, value }] });
		};
		const textInput = (type, value, commit) => {
			const input = document.createElement('input');
			input.type = type;
			input.value = value;
			input.dataset.initial = value;
			input.addEventListener('change', () => commit(input.value));
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') input.blur();
			});
			return input;
		};

		if (kind.startsWith('ref:')) return refEditor(spec, prop, kind.slice(4), current, send);
		if (kind === 'image') return imageEditor(spec, prop, current);
		if (prop === 'anchor' && kind === 'flags') return anchorEditor(desc, prop, current, send);
		if (prop === 'dock' && kind === 'enum') return dockEditor(desc, prop, current, send);

		if (kind === 'bool') {
			const input = document.createElement('input');
			input.type = 'checkbox';
			// visible and enabled are true until something says otherwise.
			const dflt = prop === 'visible' || prop === 'enabled' ? 'true' : 'false';
			input.checked = (current || dflt) === 'true';
			input.addEventListener('change', () => send(input.checked ? 'true' : 'false'));
			return input;
		}
		if (kind === 'enum') {
			const select = document.createElement('select');
			const values = (desc && desc.Enums && desc.Enums[prop]) || [];
			// An unset enum shows a blank entry rather than silently
			// claiming the first value is already in the source.
			if (!current) {
				const blank = document.createElement('option');
				blank.value = '';
				blank.textContent = '(default)';
				select.appendChild(blank);
			}
			for (const v of values) {
				const opt = document.createElement('option');
				opt.value = v;
				opt.textContent = v;
				if (v === current) opt.selected = true;
				select.appendChild(opt);
			}
			select.addEventListener('change', () => {
				if (select.value) send(select.value);
			});
			return select;
		}
		if (kind === 'flags') {
			// A flag set is a row of checkboxes; the wire value is the
			// comma-joined list of the ticked names.
			const values = (desc && desc.Enums && desc.Enums[prop]) || [];
			const on = new Set(current ? current.split(',').map((v) => v.trim()) : []);
			const box = document.createElement('div');
			box.className = 'flag-set';
			for (const v of values) {
				const item = document.createElement('label');
				item.className = 'flag-item';
				const cb = document.createElement('input');
				cb.type = 'checkbox';
				cb.checked = on.has(v);
				cb.addEventListener('change', () => {
					if (cb.checked) on.add(v);
					else on.delete(v);
					send(values.filter((n) => on.has(n)).join(','));
				});
				const text = document.createElement('span');
				// "AnchorTop" reads better as just "Top" in a row of four.
				text.textContent = v.replace(/^[A-Z][a-z]+(?=[A-Z])/, '');
				item.appendChild(cb);
				item.appendChild(text);
				box.appendChild(item);
			}
			return box;
		}
		if (kind === 'number') {
			return textInput('number', current, (v) => {
				if (v.trim() !== '') send(v.trim());
			});
		}
		if (kind === 'color') return colorEditor(current, send, textInput);
		if (kind === 'font') return fontEditor(current, send);
		if (kind === 'padding') {
			const input = textInput('text', current, (v) => {
				if (v.trim() !== '') send(v.trim());
			});
			input.placeholder = 'all, or left, top, right, bottom';
			return input;
		}
		return textInput('text', current, send);
	}

	// refEditor picks one of the form's components of a type - the
	// ContextMenu a control opens, the BindingSource a grid shows - or none.
	function refEditor(spec, prop, type, current, send) {
		const select = document.createElement('select');
		const none = document.createElement('option');
		none.value = '';
		none.textContent = '(none)';
		select.appendChild(none);
		const ids = model.controls.filter((c) => c.type === type).map((c) => c.id);
		for (const id of ids) {
			const o = document.createElement('option');
			o.value = id;
			o.textContent = id;
			if (id === current) o.selected = true;
			select.appendChild(o);
		}
		select.value = current || '';
		if (!ids.length) select.title = `Add a ${type} from the toolbox first`;
		select.addEventListener('change', () => {
			if (select.value) send(select.value);
			else post({ type: 'apply', ops: [{ op: 'resetProp', id: spec.id, prop }] });
		});
		return select;
	}

	// imageEditor shows the picture and "…" to pick another. The extension
	// copies the file into the form's folder and embeds it.
	function imageEditor(spec, prop, current) {
		const wrap = document.createElement('div');
		wrap.className = 'image-editor';
		const src = imageUrl(current);
		if (src) {
			const thumb = document.createElement('img');
			thumb.className = 'image-thumb';
			thumb.src = src;
			thumb.alt = '';
			wrap.appendChild(thumb);
		}
		const name = document.createElement('span');
		name.className = 'image-name';
		name.textContent = current || '(none)';
		wrap.appendChild(name);
		const pick = document.createElement('button');
		pick.className = 'coll-btn';
		pick.textContent = '…';
		pick.title = 'Choose a picture - it is copied into the form\'s folder and embedded in the binary';
		pick.addEventListener('click', () => post({ type: 'pickImage', id: spec.id, prop }));
		wrap.appendChild(pick);
		return wrap;
	}

	// appendExtenderGroups is what the form's components say about this
	// control: "ToolTip on toolTip1", and the (DataBindings) of a control
	// that can show a field of a record.
	function appendExtenderGroups(panel, spec, desc) {
		const tips = model.controls.filter((c) => c.type === 'ToolTip');
		if (tips.length) {
			const g = groupEl('Tool tips');
			for (const tip of tips) {
				const row = document.createElement('div');
				row.className = 'prop-row';
				row.dataset.prop = 'toolTip.' + tip.id;
				const label = document.createElement('label');
				label.textContent = `ToolTip on ${tip.id}`;
				const current = (spec.toolTips && spec.toolTips[tip.id]) || '';
				if (current) label.classList.add('modified');
				const input = document.createElement('input');
				input.type = 'text';
				input.value = current;
				input.dataset.initial = current;
				input.addEventListener('change', () => post({ type: 'apply', ops: [{ op: 'setToolTip', id: spec.id, prop: tip.id, value: input.value }] }));
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') input.blur();
				});
				row.appendChild(label);
				row.appendChild(input);
				row.addEventListener('mouseenter', () => showHelp(`ToolTip on ${tip.id}`, 'The text shown when the mouse rests on the control. Empty shows none.'));
				g.appendChild(row);
			}
			panel.appendChild(g);
		}

		const bindable = (desc && desc.Bindable) || [];
		if (!bindable.length) return;
		const sources = model.controls.filter((c) => c.type === 'BindingSource');
		const g = groupEl('(DataBindings)');
		if (!sources.length) {
			const hint = document.createElement('div');
			hint.className = 'hint';
			hint.textContent = 'Add a BindingSource from the toolbox (Data) to bind this control to a field of a record.';
			g.appendChild(hint);
			panel.appendChild(g);
			return;
		}
		for (const prop of bindable) {
			const b = (spec.bindings && spec.bindings[prop]) || null;
			const row = document.createElement('div');
			row.className = 'prop-row';
			row.dataset.prop = 'binding.' + prop;
			const label = document.createElement('label');
			label.textContent = prop;
			if (b) label.classList.add('modified');
			const source = document.createElement('select');
			const none = document.createElement('option');
			none.value = '';
			none.textContent = '(none)';
			source.appendChild(none);
			for (const src of sources) {
				const o = document.createElement('option');
				o.value = src.id;
				o.textContent = src.id;
				source.appendChild(o);
			}
			source.value = b ? b.source : '';
			const member = document.createElement('input');
			member.type = 'text';
			member.className = 'binding-member';
			member.placeholder = 'Field';
			member.value = b ? b.member : '';
			member.dataset.initial = member.value;
			const commit = () => {
				const value = source.value && member.value.trim() ? `${source.value}.${member.value.trim()}` : '';
				if (!value && !b) return;
				post({ type: 'apply', ops: [{ op: 'setBinding', id: spec.id, prop, value }] });
			};
			source.addEventListener('change', commit);
			member.addEventListener('change', commit);
			member.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') member.blur();
			});
			row.appendChild(label);
			row.appendChild(source);
			row.appendChild(member);
			row.addEventListener('mouseenter', () => showHelp(`${prop} binding`, `Shows the field of the BindingSource's current record, and writes it back when the user changes it.`));
			g.appendChild(row);
		}
		panel.appendChild(g);
	}

	// columnsFromType makes a grid's columns from a struct's fields: a
	// column per field, titled and bound by its name - what Visual Studio
	// does when a grid's DataSource is set to a type.
	function columnsFromType(id, fields) {
		const spec = findControl(id);
		if (!spec || !fields.length) return;
		const columns = fields.map((f) => ({ title: f.name, dataPropertyName: f.name, kind: f.type === 'bool' ? 'CheckBox' : '' }));
		post({ type: 'apply', ops: [{ op: 'setColumns', id, columns }] });
	}

	// anchorEditor is Anchor as Visual Studio edits it: a box with a bar to
	// each side, each bar on or off.
	function anchorEditor(desc, prop, current, send) {
		const values = (desc && desc.Enums && desc.Enums[prop]) || [];
		const on = new Set(current ? current.split(',').map((v) => v.trim()) : []);
		const box = document.createElement('div');
		box.className = 'anchor-box';
		const middle = document.createElement('div');
		middle.className = 'anchor-control';
		box.appendChild(middle);
		for (const v of values) {
			const side = v.replace(/^Anchor/, '');
			const bar = document.createElement('button');
			bar.className = 'anchor-bar ' + side.toLowerCase() + (on.has(v) ? ' on' : '');
			bar.title = side;
			bar.dataset.side = side;
			bar.addEventListener('click', () => {
				if (on.has(v)) on.delete(v);
				else on.add(v);
				send(values.filter((n) => on.has(n)).join(','));
			});
			box.appendChild(bar);
		}
		return box;
	}

	// dockEditor is Dock as Visual Studio edits it: Top, Left, Fill, Right
	// and Bottom around the middle, None below.
	function dockEditor(desc, prop, current, send) {
		const values = (desc && desc.Enums && desc.Enums[prop]) || [];
		const grid = document.createElement('div');
		grid.className = 'dock-grid';
		const value = current || 'DockNone';
		for (const v of ['DockTop', 'DockLeft', 'DockFill', 'DockRight', 'DockBottom', 'DockNone']) {
			if (!values.includes(v)) continue;
			const place = v.replace(/^Dock/, '');
			const b = document.createElement('button');
			b.className = 'dock-cell ' + place.toLowerCase() + (value === v ? ' on' : '');
			b.title = place;
			b.dataset.dock = v;
			b.textContent = place === 'None' ? 'None' : '';
			b.addEventListener('click', () => send(v));
			grid.appendChild(b);
		}
		return grid;
	}

	// The palette the color editor offers, Visual Studio's Custom tab.
	const PALETTE = [
		'#ffffff', '#ffc0c0', '#ffe0c0', '#ffffc0', '#c0ffc0', '#c0ffff', '#c0c0ff', '#ffc0ff',
		'#e0e0e0', '#ff8080', '#ffc080', '#ffff80', '#80ff80', '#80ffff', '#8080ff', '#ff80ff',
		'#c0c0c0', '#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff',
		'#808080', '#c00000', '#c04000', '#c0c000', '#00c000', '#00c0c0', '#0000c0', '#c000c0',
		'#404040', '#800000', '#804000', '#808000', '#008000', '#008080', '#000080', '#800080',
		'#000000', '#400000', '#804040', '#404000', '#004000', '#004040', '#000040', '#400040',
	];

	// colorEditor is a swatch that opens a palette, a native picker and the
	// hex value, which also takes an alpha ("#rrggbbaa").
	function colorEditor(current, send, textInput) {
		const wrap = document.createElement('div');
		wrap.className = 'color-editor';
		const swatch = document.createElement('button');
		swatch.className = 'color-swatch' + (current ? '' : ' unset');
		swatch.style.background = cssColor(current) || '';
		swatch.title = current ? current : 'Not set: the theme\'s color';
		const hex = textInput('text', current, (v) => {
			const t = v.trim();
			if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t)) send(t.startsWith('#') ? t.toLowerCase() : '#' + t.toLowerCase());
		});
		hex.placeholder = '#rrggbb';
		hex.className = 'color-hex';
		const native = document.createElement('input');
		native.type = 'color';
		native.value = current ? current.slice(0, 7) : '#000000';
		native.title = 'Pick a color';
		native.addEventListener('change', () => send(native.value.toLowerCase()));
		swatch.addEventListener('click', () => {
			const open = wrap.querySelector('.color-palette');
			if (open) {
				open.remove();
				return;
			}
			const pal = document.createElement('div');
			pal.className = 'color-palette';
			for (const c of PALETTE) {
				const cell = document.createElement('button');
				cell.className = 'color-cell';
				cell.style.background = c;
				cell.title = c;
				cell.dataset.color = c;
				cell.addEventListener('click', () => send(c));
				pal.appendChild(cell);
			}
			wrap.appendChild(pal);
		});
		wrap.appendChild(swatch);
		wrap.appendChild(native);
		wrap.appendChild(hex);
		return wrap;
	}

	// FONT_FAMILIES are offered in the font editor's list; any other name can
	// be typed. An empty family is the theme's.
	const FONT_FAMILIES = ['', 'Sans', 'Serif', 'Monospace', 'Arial', 'Helvetica', 'Segoe UI', 'Roboto', 'Noto Sans', 'DejaVu Sans', 'Courier New', 'Times New Roman'];

	// fontEditor edits a font's family, size and style together, writing
	// them as one value - a Font is one SetFont call.
	function fontEditor(current, send) {
		const f = parseFont(current) || { family: '', size: 14, bold: false, italic: false };
		const wrap = document.createElement('div');
		wrap.className = 'font-editor';
		const family = document.createElement('select');
		for (const name of FONT_FAMILIES.includes(f.family) ? FONT_FAMILIES : FONT_FAMILIES.concat([f.family])) {
			const o = document.createElement('option');
			o.value = name;
			o.textContent = name || '(theme)';
			if (name === f.family) o.selected = true;
			family.appendChild(o);
		}
		family.value = f.family;
		const size = document.createElement('input');
		size.type = 'number';
		size.className = 'font-size';
		size.min = '1';
		size.value = String(f.size || 14);
		const flag = (name, on) => {
			const l = document.createElement('label');
			l.className = 'flag-item';
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = on;
			cb.dataset.style = name;
			const t = document.createElement('span');
			t.textContent = name;
			l.appendChild(cb);
			l.appendChild(t);
			wrap.appendChild(l);
			return cb;
		};
		wrap.appendChild(family);
		wrap.appendChild(size);
		const bold = flag('Bold', f.bold);
		const italic = flag('Italic', f.italic);
		const commit = () => {
			const n = parseFloat(size.value);
			if (!Number.isFinite(n) || n <= 0) return;
			send([family.value, String(n)].concat(bold.checked ? ['Bold'] : [], italic.checked ? ['Italic'] : []).join(', '));
		};
		family.addEventListener('change', commit);
		size.addEventListener('change', commit);
		bold.addEventListener('change', commit);
		italic.addEventListener('change', commit);
		return wrap;
	}

	// appendCellGroup is where a control in a table sits: its column and
	// row, and how far it spans. "Next free cell" is a plain AddControl, the
	// cell AddControl's cursor gives it.
	function appendCellGroup(panel, spec) {
		const table = findControl(spec.parent);
		const g = groupEl('Cell');
		const cell = effectiveCell(spec) || { column: 0, row: 0, columnSpan: 1, rowSpan: 1 };
		const auto = !spec.cell;
		const autoRow = document.createElement('div');
		autoRow.className = 'prop-row';
		const autoLabel = document.createElement('label');
		autoLabel.textContent = 'Next free cell';
		const autoBox = document.createElement('input');
		autoBox.type = 'checkbox';
		autoBox.checked = auto;
		autoBox.addEventListener('change', () => {
			post({ type: 'apply', ops: [{ op: 'setCell', id: spec.id, cell: autoBox.checked ? undefined : { column: cell.column, row: cell.row } }] });
		});
		autoRow.appendChild(autoLabel);
		autoRow.appendChild(autoBox);
		g.appendChild(autoRow);
		const cols = tracksOf(table, 'columns').length, rows = tracksOf(table, 'rows').length;
		const fields = [
			['Column', 'column', cell.column, 0, cols - 1],
			['Row', 'row', cell.row, 0, rows - 1],
			['ColumnSpan', 'columnSpan', cell.columnSpan || 1, 1, cols],
			['RowSpan', 'rowSpan', cell.rowSpan || 1, 1, rows],
		];
		const inputs = {};
		for (const [label, key, value, min, max] of fields) {
			const row = document.createElement('div');
			row.className = 'prop-row';
			row.dataset.prop = 'cell.' + key;
			const l = document.createElement('label');
			l.textContent = label;
			const input = numberInput(value);
			input.min = String(min);
			input.max = String(max);
			input.disabled = auto && (key === 'column' || key === 'row');
			inputs[key] = input;
			input.addEventListener('change', () => {
				const next = {
					column: parseInt(inputs.column.value, 10) || 0,
					row: parseInt(inputs.row.value, 10) || 0,
					columnSpan: Math.max(1, parseInt(inputs.columnSpan.value, 10) || 1),
					rowSpan: Math.max(1, parseInt(inputs.rowSpan.value, 10) || 1),
				};
				post({ type: 'apply', ops: [{ op: 'setCell', id: spec.id, cell: compactCell(next) }] });
			});
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') input.blur();
			});
			row.appendChild(l);
			row.appendChild(input);
			g.appendChild(row);
		}
		panel.appendChild(g);
	}

	// appendTableGroup edits a table's columns and rows: each one's size type
	// and size, added, removed and reordered - the Column and Row Styles
	// dialog. Edits are sent as one setTable, which rewrites the counts in the
	// constructor and every style call at once.
	function appendTableGroup(panel, spec) {
		const g = groupEl('Columns and rows');
		if (spec.tableReadOnly) {
			const note = document.createElement('div');
			note.className = 'hint';
			note.textContent = 'The column and row styles are built by code this designer cannot regenerate; edit them in the .go file.';
			g.appendChild(note);
			panel.appendChild(g);
			return;
		}
		const lists = { columns: tracksOf(spec, 'columns').map((t) => Object.assign({}, t)), rows: tracksOf(spec, 'rows').map((t) => Object.assign({}, t)) };
		const commit = () => {
			post({ type: 'apply', ops: [{ op: 'setTable', id: spec.id, tableColumns: lists.columns, tableRows: lists.rows }] });
		};
		for (const which of ['columns', 'rows']) {
			const head = document.createElement('div');
			head.className = 'hint';
			head.textContent = which === 'columns' ? 'Columns' : 'Rows';
			g.appendChild(head);
			lists[which].forEach((t, i) => {
				const row = document.createElement('div');
				row.className = 'coll-row track-row';
				row.dataset.prop = `${which}.${i}`;
				const n = document.createElement('span');
				n.className = 'track-index';
				n.textContent = String(i + 1);
				const type = document.createElement('select');
				for (const v of ['AutoSize', 'Absolute', 'Percent']) {
					const o = document.createElement('option');
					o.value = v;
					o.textContent = v;
					if (v === t.type) o.selected = true;
					type.appendChild(o);
				}
				type.value = t.type;
				const value = numberInput(t.value || 0);
				value.disabled = t.type === 'AutoSize';
				type.addEventListener('change', () => {
					t.type = type.value;
					if (t.type === 'AutoSize') delete t.value;
					else t.value = Number(value.value) || (t.type === 'Percent' ? 50 : 100);
					commit();
				});
				value.addEventListener('change', () => {
					t.value = Math.max(0, Number(value.value) || 0);
					commit();
				});
				row.appendChild(n);
				row.appendChild(type);
				row.appendChild(value);
				row.appendChild(iconButton('↑', 'Move up', () => {
					if (i === 0) return;
					editTableMove(spec, which, i, i - 1);
				}));
				row.appendChild(iconButton('✕', 'Delete', () => editTableTrack(spec, which, i, 'delete')));
				g.appendChild(row);
			});
			const add = document.createElement('button');
			add.className = 'coll-add';
			add.textContent = which === 'columns' ? '+ Column' : '+ Row';
			add.addEventListener('click', () => editTableTrack(spec, which, lists[which].length, 'insert'));
			g.appendChild(add);
		}
		panel.appendChild(g);
	}

	// editTableMove swaps two tracks of a table, the controls in them going
	// along.
	function editTableMove(table, which, from, to) {
		const isCol = which === 'columns';
		const tracks = tracksOf(table, which).map((t) => Object.assign({}, t));
		[tracks[from], tracks[to]] = [tracks[to], tracks[from]];
		const ops = [];
		for (const c of canvasControls()) {
			if (c.parent !== table.id || c.parentSlot) continue;
			const cell = effectiveCell(c);
			if (!cell) continue;
			const at = isCol ? cell.column : cell.row;
			const next = at === from ? to : at === to ? from : at;
			if (next === at && c.cell) continue;
			ops.push({ op: 'setCell', id: c.id, cell: compactCell(isCol ? Object.assign({}, cell, { column: next }) : Object.assign({}, cell, { row: next })) });
		}
		ops.push({ op: 'setTable', id: table.id, tableColumns: isCol ? tracks : tracksOf(table, 'columns'), tableRows: isCol ? tracksOf(table, 'rows') : tracks });
		post({ type: 'apply', ops });
	}

	// appendFormGroup is what the properties panel shows when nothing is
	// selected: the Form's own title and size, as WinForms shows the form's
	// properties when you click its background.
	//
	// Dragging the canvas's corner handle is the other way to resize, but it
	// is only reachable when the whole form fits on screen - on a form larger
	// than the canvas viewport the handle sits past the scroll, which left no
	// way at all to make a big form smaller.
	function appendFormGroup(panel) {
		const h3 = document.createElement('h3');
		h3.textContent = `Form · ${model.receiverType}`;
		panel.appendChild(h3);

		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.style.marginBottom = '10px';
		hint.textContent = 'Select a control on the canvas to edit it instead.';
		panel.appendChild(hint);

		const g = groupEl('Form');

		const send = (title, w, h) => {
			post({
				type: 'apply',
				ops: [{ op: 'setForm', id: '', w, h, text: title }],
			});
		};

		const titleRow = document.createElement('div');
		titleRow.className = 'prop-row';
		const titleLabel = document.createElement('span');
		titleLabel.className = 'prop-name';
		titleLabel.textContent = 'Title';
		titleRow.appendChild(titleLabel);
		const titleInput = document.createElement('input');
		titleInput.type = 'text';
		titleInput.value = model.formTitle || '';
		const commitTitle = () => {
			const v = titleInput.value;
			if (v && v !== model.formTitle) {
				send(v, model.formWidth, model.formHeight);
			}
		};
		titleInput.addEventListener('change', commitTitle);
		titleInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') titleInput.blur();
		});
		titleRow.appendChild(titleInput);
		g.appendChild(titleRow);

		// Width and height go together in one op: the tool rewrites both
		// arguments of NewForm at once, so sending one without the other
		// would overwrite it with the value already on screen.
		const sizeInput = (name, current, apply) => {
			const row = document.createElement('div');
			row.className = 'prop-row';
			const label = document.createElement('span');
			label.className = 'prop-name';
			label.textContent = name;
			row.appendChild(label);
			const input = document.createElement('input');
			input.type = 'number';
			input.min = name === 'Width' ? '100' : '80';
			input.value = String(current);
			const commit = () => {
				const v = Math.round(Number(input.value));
				if (Number.isFinite(v) && v >= Number(input.min) && v !== current) {
					apply(v);
				} else {
					input.value = String(current);
				}
			};
			input.addEventListener('change', commit);
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') input.blur();
			});
			row.appendChild(input);
			g.appendChild(row);
		};

		sizeInput('Width', model.formWidth, (v) => send('', v, model.formHeight));
		sizeInput('Height', model.formHeight, (v) => send('', model.formWidth, v));

		panel.appendChild(g);

		// The form's own properties and events, through the same two builders
		// every control uses. The Form is addressed by an empty id - it has no
		// name to give - which is what the tool's setProp/setEvent expect and
		// what setForm has always done. idLabel is only for the placeholder a
		// handler name is suggested from.
		const formDesc = catalog && catalog.Form;
		if (formDesc) {
			const formSpec = {
				id: '',
				idLabel: model.receiverType,
				type: 'Form',
				props: model.formProps || {},
				events: model.formEvents || {},
			};
			const props = propsOf(formDesc);
			if (props.length) {
				appendPropsGroup(panel, formSpec, props, formDesc);
			}
			if (formDesc.Events && formDesc.Events.length) {
				appendEventsGroup(panel, formSpec, formDesc.Events, formDesc);
			}
		}
	}

	function appendEventsGroup(panel, spec, events, desc) {
		const g = groupEl('Events');
		// The tool lists a control's own events first, then the ones every
		// control inherits from ControlBase, and reports where the boundary
		// is - so this panel never has to know how many base events exist.
		const ownCount = (desc && desc.OwnEventCount) || 0;

		for (let i = 0; i < events.length; i++) {
			const eventName = events[i];
			if (i === ownCount && ownCount > 0) {
				const sep = document.createElement('div');
				sep.className = 'hint';
				sep.style.margin = '8px 0 4px';
				sep.textContent = 'Inherited from Control';
				g.appendChild(sep);
			}
			const current = (spec.events && spec.events[eventName]) || '';
			const row = document.createElement('div');
			row.className = 'event-row' + (current ? ' wired' : '');
			row.dataset.prop = 'event.' + eventName;
			const help = desc && desc.Descriptions && desc.Descriptions[eventName];
			if (help) row.title = help;
			row.addEventListener('mouseenter', () => showHelp(eventName, help));

			const label = document.createElement('span');
			label.className = 'event-name';
			label.textContent = eventName + (current ? ' ✓' : '');
			row.appendChild(label);

			const input = document.createElement('input');
			input.type = 'text';
			input.value = current;
			input.placeholder = `${spec.idLabel || spec.id}_${eventName}`;
			row.appendChild(input);

			const btn = document.createElement('button');
			btn.className = 'wire-btn';
			btn.textContent = 'Wire';
			btn.addEventListener('click', () => {
				const handler = input.value.trim() || input.placeholder;
				// paramType decides the generated stub's signature, so it
				// comes from the tool's catalog rather than a guess here.
				// The catalog names types bare ("MouseEventArgs"); the tool
				// adds the goforms qualifier when it writes the stub.
				const paramType = (desc && desc.EventArgs && desc.EventArgs[eventName]) || 'EventArgs';
				post({ type: 'wireEvent', id: spec.id, event: eventName, handler, paramType });
			});
			row.appendChild(btn);

			if (current) {
				const gotoBtn = document.createElement('button');
				gotoBtn.className = 'goto-btn';
				gotoBtn.textContent = 'Go to';
				gotoBtn.title = `Jump to ${current}(...) in its source file`;
				gotoBtn.addEventListener('click', () => {
					post({ type: 'gotoHandler', id: spec.id, event: eventName, handler: current });
				});
				row.appendChild(gotoBtn);

				// Unwiring keeps the method, as Visual Studio does when an
				// event is cleared: the code someone wrote in it is theirs.
				const unwire = document.createElement('button');
				unwire.className = 'unwire-btn';
				unwire.textContent = '✕';
				unwire.title = `Unwire ${current} (the method stays in the code)`;
				unwire.addEventListener('click', () => {
					post({ type: 'apply', ops: [{ op: 'removeEvent', id: spec.id, event: eventName }] });
				});
				row.appendChild(unwire);
			}

			g.appendChild(row);
		}
		panel.appendChild(g);
	}

	// The button deletes on one click, matching the Delete key. A
	// confirmation step would buy nothing: the delete goes on the designer's
	// undo stack like any other edit.
	function appendDeleteButton(panel, spec) {
		const btn = document.createElement('button');
		btn.className = 'delete-btn';
		btn.textContent = selectedIds.size > 1 ? `Delete ${selectedIds.size} controls` : `Delete ${spec.id}`;
		btn.title = 'Del — undo with Ctrl+Z';
		btn.addEventListener('click', deleteSelection);
		panel.appendChild(btn);
	}

	// ---------------------------------------------------------------------
	// Context menu
	// ---------------------------------------------------------------------
	//
	// The right-click menu of the canvas, the tray and the outline, as the
	// Visual Studio designer's: the clipboard, the z-order, the way up to the
	// container, and - on a table - inserting and deleting its columns and
	// rows where the mouse is.

	// closePopups closes the context menu and the smart tag panel, and says
	// whether there was one, so Escape closes a popup before it changes the
	// selection.
	function closePopups() {
		let closed = false;
		for (const el of document.querySelectorAll('.ctx-menu')) {
			el.remove();
			closed = true;
		}
		if (smartOpen) {
			smartOpen = null;
			for (const el of document.querySelectorAll('.smart-panel')) el.remove();
			closed = true;
		}
		return closed;
	}

	// The menu is closed by any press outside it. Bound once: the window
	// outlives every render.
	window.addEventListener('mousedown', (e) => {
		const t = e.target;
		if (t && t.closest && (t.closest('.ctx-menu') || t.closest('.smart-panel') || t.closest('.smart-glyph'))) return;
		closePopups();
	});

	// showContextMenu opens the menu for a control (spec), or the form when
	// spec is null. cell is the table cell under the mouse, when there is a
	// table there.
	function showContextMenu(e, spec, cell) {
		e.preventDefault();
		e.stopPropagation();
		closePopups();
		if (spec && !selectedIds.has(spec.id)) {
			setSelection(spec.id, false);
			updateSelectionClasses();
			renderProperties();
			renderOutline();
		} else if (!spec && selectedIds.size) {
			selectForm();
		}
		const menu = document.createElement('div');
		menu.className = 'ctx-menu';
		const item = (label, keys, fn, enabled) => {
			const row = document.createElement('div');
			row.className = 'ctx-item' + (enabled === false ? ' disabled' : '');
			const l = document.createElement('span');
			l.className = 'ctx-label';
			l.textContent = label;
			const k = document.createElement('span');
			k.className = 'ctx-keys';
			k.textContent = keys || '';
			row.appendChild(l);
			row.appendChild(k);
			if (enabled !== false) {
				row.addEventListener('mousedown', (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					closePopups();
					fn();
				});
			}
			menu.appendChild(row);
			return row;
		};
		const sep = () => {
			const d = document.createElement('div');
			d.className = 'ctx-sep';
			menu.appendChild(d);
		};
		const has = selectedSpecs().some((c) => c.supported);
		const canvasSel = selectedSpecs().some((c) => c.supported && !isComponent(c));

		item('View Code', 'F7', () => post({ type: 'viewCode' }));
		if (!spec) item('Set as Startup Form', '', () => post({ type: 'setStartup' }));
		sep();
		item('Cut', 'Ctrl+X', cutSelection, has);
		item('Copy', 'Ctrl+C', copySelection, has);
		item('Paste', 'Ctrl+V', () => post({ type: 'paste' }));
		item('Duplicate', 'Ctrl+D', duplicateSelection, has);
		item('Delete', 'Del', deleteSelection, has);
		if (spec && !isComponent(spec)) {
			sep();
			item('Bring to Front', '', () => zorder(true), canvasSel);
			item('Send to Back', '', () => zorder(false), canvasSel);
		}
		if (spec && spec.parent && findControl(spec.parent)) {
			item(`Select ${spec.parent}`, 'Esc', selectParent);
		}
		const table = spec && spec.type === 'TableLayoutPanel' ? spec : spec && spec.parent && !spec.parentSlot && (findControl(spec.parent) || {}).type === 'TableLayoutPanel' ? findControl(spec.parent) : null;
		if (table && !table.tableReadOnly) {
			const at = cell || (spec !== table ? effectiveCell(spec) : null) || { column: 0, row: 0 };
			sep();
			item(`Insert Column Before ${at.column + 1}`, '', () => editTableTrack(table, 'columns', at.column, 'insert'));
			item(`Insert Column After ${at.column + 1}`, '', () => editTableTrack(table, 'columns', at.column + 1, 'insert'));
			item(`Delete Column ${at.column + 1}`, '', () => editTableTrack(table, 'columns', at.column, 'delete'), tracksOf(table, 'columns').length > 1);
			item(`Insert Row Above ${at.row + 1}`, '', () => editTableTrack(table, 'rows', at.row, 'insert'));
			item(`Insert Row Below ${at.row + 1}`, '', () => editTableTrack(table, 'rows', at.row + 1, 'insert'));
			item(`Delete Row ${at.row + 1}`, '', () => editTableTrack(table, 'rows', at.row, 'delete'), tracksOf(table, 'rows').length > 1);
		}
		sep();
		item((locked ? '✓ ' : '') + 'Lock Controls', '', () => setLocked(!locked));
		item((tabOrderMode ? '✓ ' : '') + 'Tab Order', '', () => setTabOrderMode(!tabOrderMode));
		sep();
		item('Properties', '', () => showTab('properties'));

		menu.style.left = (e.clientX || 0) + 'px';
		menu.style.top = (e.clientY || 0) + 'px';
		document.body.appendChild(menu);
		// Keep it on screen: a right-click near the bottom of the canvas
		// would otherwise open a menu half out of sight.
		const r = menu.getBoundingClientRect();
		const vw = (globalThis.innerWidth || 0), vh = (globalThis.innerHeight || 0);
		if (vw && r.right > vw) menu.style.left = Math.max(0, vw - r.width - 4) + 'px';
		if (vh && r.bottom > vh) menu.style.top = Math.max(0, vh - r.height - 4) + 'px';
	}

	// editTableTrack inserts or deletes one column or row of a table, the
	// controls going along: those past the change move with it, and a span
	// across it grows or shrinks. A column or row with a control in it is
	// not deleted - the controls there would have nowhere to be.
	function editTableTrack(table, which, index, action) {
		const isCol = which === 'columns';
		const tracks = tracksOf(table, which).map((t) => Object.assign({}, t));
		const kids = canvasControls().filter((c) => c.parent === table.id && !c.parentSlot);
		const cells = kids.map((c) => ({ spec: c, cell: effectiveCell(c) }));
		const at = (c) => (isCol ? c.column : c.row);
		const span = (c) => (isCol ? c.columnSpan : c.rowSpan) || 1;

		if (action === 'delete') {
			const inIt = cells.find(({ cell }) => cell && at(cell) === index && span(cell) === 1);
			if (inIt) {
				showToast(`${inIt.spec.id} is in ${isCol ? 'column' : 'row'} ${index + 1}; move or delete it first`, 'error');
				return;
			}
		}
		const moved = [];
		for (const { spec, cell } of cells) {
			if (!cell) continue;
			const c = { column: cell.column, row: cell.row, columnSpan: cell.columnSpan, rowSpan: cell.rowSpan };
			let changed = false;
			const key = isCol ? 'column' : 'row', spanKey = isCol ? 'columnSpan' : 'rowSpan';
			if (action === 'insert') {
				if (c[key] >= index) {
					c[key]++;
					changed = true;
				} else if (c[key] + (c[spanKey] || 1) > index) {
					c[spanKey] = (c[spanKey] || 1) + 1;
					changed = true;
				}
			} else if (c[key] > index) {
				c[key]--;
				changed = true;
			} else if (c[key] + (c[spanKey] || 1) > index) {
				c[spanKey] = Math.max(1, (c[spanKey] || 1) - 1);
				changed = true;
			}
			// Every child is written with its cell, so auto-placed ones do not
			// drift when the count of columns changes under them.
			if (changed || !spec.cell) moved.push({ id: spec.id, cell: compactCell(c) });
		}
		if (action === 'insert') tracks.splice(index, 0, { type: 'AutoSize' });
		else tracks.splice(index, 1);
		const table2 = {
			op: 'setTable',
			id: table.id,
			tableColumns: isCol ? tracks : tracksOf(table, 'columns'),
			tableRows: isCol ? tracksOf(table, 'rows') : tracks,
		};
		const cellOps = moved.map((m) => ({ op: 'setCell', id: m.id, cell: m.cell }));
		// Growing: the table first, so the cells moved into the new track
		// exist. Shrinking: the cells first, so nothing is left outside it.
		const ops = action === 'insert' ? [table2].concat(cellOps) : cellOps.concat([table2]);
		post({ type: 'apply', ops });
	}

	function compactCell(c) {
		const out = { column: c.column, row: c.row };
		if (c.columnSpan > 1) out.columnSpan = c.columnSpan;
		if (c.rowSpan > 1) out.rowSpan = c.rowSpan;
		return out;
	}

	// ---------------------------------------------------------------------
	// Smart tags
	// ---------------------------------------------------------------------
	//
	// The ◂ at a selected control's top right corner, and its Tasks panel:
	// the handful of things one does to that kind of control most, without
	// looking for them in the property list.

	function drawSmartTag() {
		for (const g of document.querySelectorAll('.smart-glyph')) g.remove();
		if (selectedIds.size !== 1 || locked || tabOrderMode) return;
		const spec = findControl(selectedId);
		if (!spec || !spec.supported || isComponent(spec)) return;
		const el = rendered.get(spec.id);
		if (!el || !smartActions(spec).length) return;
		const glyph = document.createElement('div');
		glyph.className = 'smart-glyph' + (smartOpen === spec.id ? ' on' : '');
		glyph.textContent = '◂';
		glyph.title = `${spec.type} Tasks`;
		glyph.addEventListener('mousedown', (e) => {
			e.stopPropagation();
			e.preventDefault();
			if (smartOpen === spec.id) {
				closePopups();
				return;
			}
			closePopups();
			smartOpen = spec.id;
			openSmartPanel(spec.id, glyph);
		});
		el.appendChild(glyph);
	}

	// smartActions lists a control's tasks: {label, run} for a command,
	// {label, prop} for a property edited in place.
	function smartActions(spec) {
		const out = [];
		const docked = propOr(spec, 'dock', 'DockNone') === 'DockFill';
		const desc = catalog[spec.type] || {};
		if (desc.Setters && Object.values(desc.Setters).includes('dock')) {
			out.push({
				label: docked ? 'Undock in Parent Container' : 'Dock in Parent Container',
				run: () => post({ type: 'apply', ops: [{ op: 'setProp', id: spec.id, prop: 'dock', value: docked ? 'DockNone' : 'DockFill' }] }),
			});
		}
		const cd = desc.Collection;
		if (cd && cd.ItemSlot && !spec.collectionReadOnly) {
			const one = cd.Label.replace(/s$/, '');
			out.push({
				label: `Add ${one}`,
				run: () => {
					const items = collectionOf(spec).concat([{ text: `${one} ${collectionOf(spec).length + 1}` }]);
					pageChoice[spec.id] = items.length - 1;
					post({ type: 'apply', ops: [{ op: 'setCollection', id: spec.id, collection: items }] });
				},
			});
			if (collectionOf(spec).length > 1) {
				out.push({
					label: `Remove ${one}`,
					run: () => {
						const shown = Math.min(pageChoice[spec.id] || 0, collectionOf(spec).length - 1);
						const items = collectionOf(spec).filter((_, i) => i !== shown);
						pageChoice[spec.id] = Math.max(0, shown - 1);
						// The tool refuses to drop a page that still has controls
						// on it, and says which.
						post({ type: 'apply', ops: [{ op: 'setCollection', id: spec.id, collection: items }] });
					},
				});
			}
		}
		if (spec.type === 'DataGridView') {
			out.push({
				label: 'Add Column',
				run: () => {
					const cols = (spec.columns && spec.columns.length ? spec.columns : (spec.items || []).map((t) => ({ title: t }))).slice();
					cols.push({ title: `Column ${cols.length + 1}` });
					post({ type: 'apply', ops: [{ op: 'setColumns', id: spec.id, columns: cols }] });
				},
			});
			out.push({ label: 'Edit Columns…', run: () => revealGroup('Columns') });
			out.push({ label: 'Columns from a Type…', run: () => post({ type: 'pickDataType', id: spec.id }) });
		}
		if (['ComboBox', 'ListBox', 'CheckedListBox', 'DomainUpDown'].includes(spec.type)) {
			out.push({ label: 'Edit Items…', run: () => revealGroup('Items') });
		}
		if (spec.type === 'ListView') out.push({ label: 'Edit Columns…', run: () => revealGroup('Columns') });
		if (cd && !cd.ItemSlot) out.push({ label: `Edit ${cd.Label}…`, run: () => revealGroup(cd.Label) });
		if (spec.type === 'TableLayoutPanel' && !spec.tableReadOnly) {
			out.push({ label: 'Add Column', run: () => editTableTrack(spec, 'columns', tracksOf(spec, 'columns').length, 'insert') });
			out.push({ label: 'Add Row', run: () => editTableTrack(spec, 'rows', tracksOf(spec, 'rows').length, 'insert') });
			out.push({ label: 'Edit Rows and Columns…', run: () => revealGroup('Columns and rows') });
		}
		if (spec.type === 'FlowLayoutPanel') {
			out.push({ label: 'Flow direction', prop: 'flowDirection' });
			out.push({ label: 'Wrap contents', prop: 'wrapContents' });
		}
		return out;
	}

	function openSmartPanel(id, glyph) {
		for (const el of document.querySelectorAll('.smart-panel')) el.remove();
		const spec = findControl(id);
		if (!spec) return;
		const desc = catalog[spec.type];
		const panel = document.createElement('div');
		panel.className = 'smart-panel';
		const title = document.createElement('div');
		title.className = 'smart-title';
		title.textContent = `${spec.type} Tasks`;
		panel.appendChild(title);
		for (const a of smartActions(spec)) {
			const line = document.createElement('div');
			line.className = 'smart-line';
			if (a.run) {
				const link = document.createElement('button');
				link.className = 'smart-link';
				link.textContent = a.label;
				link.addEventListener('click', () => {
					closePopups();
					a.run();
				});
				line.appendChild(link);
			} else {
				const label = document.createElement('span');
				label.textContent = a.label;
				line.appendChild(label);
				line.appendChild(propEditor(spec, desc, a.prop));
			}
			panel.appendChild(line);
		}
		const r = glyph.getBoundingClientRect();
		panel.style.left = r.right + 4 + 'px';
		panel.style.top = r.top + 'px';
		document.body.appendChild(panel);
	}

	// revealGroup brings one group of the properties panel into view - what
	// "Edit Columns…" and the like do.
	function revealGroup(title) {
		showTab('properties');
		const panel = $('properties-panel');
		const g = panel ? [...panel.querySelectorAll('.prop-group')].find((x) => x.dataset.group === title) : null;
		if (g) {
			g.classList.add('flash');
			if (g.scrollIntoView) g.scrollIntoView({ block: 'start' });
			setTimeout(() => g.classList.remove('flash'), 900);
		}
	}

	// ---------------------------------------------------------------------
	// Document Outline
	// ---------------------------------------------------------------------
	//
	// The form's controls as a tree, as Visual Studio's Document Outline
	// shows them: each container's controls front-most first, a split or
	// paged container's halves and pages as nodes of their own, the tray at
	// the end. A click selects; a drag onto a container puts the control in
	// it, and a drag above or below a sibling puts it there in the z-order.

	let outlineDrag = null;

	function renderOutline() {
		const host = $('outline-panel');
		if (!host || !model || !catalog) return;
		host.innerHTML = '';
		const kidsOf = (key) => canvasControls().filter((c) => parentKey(c.parent, c.parentSlot) === key).reverse();

		const node = (label, opts, depth) => {
			const row = document.createElement('div');
			row.className = 'ol-node' + (opts.id !== undefined && selectedIds.has(opts.id) ? ' selected' : '') + (opts.slot ? ' ol-slot' : '');
			row.style.paddingLeft = 4 + depth * 14 + 'px';
			if (opts.id !== undefined) row.dataset.id = opts.id;
			if (opts.key !== undefined) row.dataset.key = opts.key;
			const fold = document.createElement('span');
			fold.className = 'ol-fold';
			const foldKey = opts.key !== undefined ? opts.key : opts.id;
			fold.textContent = opts.hasKids ? (outlineCollapsed.has(foldKey) ? '▸' : '▾') : '';
			fold.addEventListener('mousedown', (e) => {
				e.stopPropagation();
				if (outlineCollapsed.has(foldKey)) outlineCollapsed.delete(foldKey);
				else outlineCollapsed.add(foldKey);
				renderOutline();
			});
			const text = document.createElement('span');
			text.className = 'ol-text';
			text.textContent = label;
			row.appendChild(fold);
			row.appendChild(text);
			if (opts.type) {
				const t = document.createElement('span');
				t.className = 'ol-type';
				t.textContent = opts.type;
				row.appendChild(t);
			}
			if (opts.id !== undefined) {
				row.addEventListener('mousedown', (e) => {
					if (e.button === 2) return;
					if (opts.id === '') {
						selectForm();
						renderOutline();
						return;
					}
					setSelection(opts.id, e.ctrlKey || e.metaKey || e.shiftKey);
					updateSelectionClasses();
					renderProperties();
					renderOutline();
				});
				if (opts.id) {
					const spec = findControl(opts.id);
					row.addEventListener('contextmenu', (e) => showContextMenu(e, spec, null));
					row.draggable = !isComponent(spec);
					row.addEventListener('dragstart', (e) => {
						outlineDrag = opts.id;
						if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
					});
				}
			}
			row.addEventListener('dragover', (e) => {
				if (!outlineDrag) return;
				const zone = outlineZone(row, e);
				if (!zone) return;
				e.preventDefault();
				clearOutlineMarks();
				row.classList.add('ol-' + zone);
			});
			row.addEventListener('dragleave', () => row.classList.remove('ol-before', 'ol-after', 'ol-into'));
			row.addEventListener('drop', (e) => {
				e.preventDefault();
				const zone = outlineZone(row, e);
				clearOutlineMarks();
				const moving = outlineDrag;
				outlineDrag = null;
				if (moving && zone) outlineDrop(moving, row, zone);
			});
			host.appendChild(row);
			return row;
		};

		const walk = (key, depth) => {
			if (outlineCollapsed.has(key)) return;
			for (const c of kidsOf(key)) {
				const slots = slotsFor(c);
				const hasKids = slots.length > 0 || kidsOf(c.id).length > 0;
				node(c.id, { id: c.id, key: slots.length ? undefined : c.id, type: c.type, hasKids }, depth);
				if (outlineCollapsed.has(c.id)) continue;
				if (slots.length) {
					slots.forEach((slot, i) => {
						const k = parentKey(c.id, slot);
						const page = collectionOf(c)[i];
						const label = (catalog[c.type].Slots || []).length ? slot : `${slot} · ${page ? page.text : ''}`;
						node(label, { key: k, slot: true, hasKids: kidsOf(k).length > 0 }, depth + 1);
						walk(k, depth + 2);
					});
				} else {
					walk(c.id, depth + 1);
				}
			}
		};
		node(model.receiverType, { id: '', key: '', type: 'Form', hasKids: canvasControls().length > 0 }, 0);
		walk('', 1);
		const tray = trayControls();
		if (tray.length) {
			const t = document.createElement('div');
			t.className = 'ol-heading';
			t.textContent = 'Components';
			host.appendChild(t);
			for (const c of tray) node(c.id, { id: c.id, type: c.type, hasKids: false }, 1);
		}
	}

	function clearOutlineMarks() {
		for (const el of document.querySelectorAll('.ol-node')) el.classList.remove('ol-before', 'ol-after', 'ol-into');
	}

	// outlineZone is where a drop on a row goes: into it (a container, or a
	// half or page of one), or before or after it among its siblings.
	function outlineZone(row, e) {
		const id = row.dataset.id;
		const key = row.dataset.key;
		const moving = outlineDrag;
		if (!moving) return null;
		const into = key !== undefined && (key === '' || acceptsKey(key)) && !keyInside(key, moving);
		if (id === undefined || id === '') return into ? 'into' : null;
		if (id === moving || isInsideAny(id, new Set([moving]))) return null;
		const target = findControl(id);
		if (!target || isComponent(target)) return null;
		const r = row.getBoundingClientRect();
		const y = (e.clientY || 0) - r.top;
		if (into && y > r.height / 4 && y < (r.height * 3) / 4) return 'into';
		return y <= r.height / 2 ? 'before' : 'after';
	}

	// acceptsKey reports whether a parent key is somewhere controls can go.
	function acceptsKey(key) {
		const [parent, slot] = splitParentKey(key);
		if (!parent) return true;
		const spec = findControl(parent);
		if (!spec) return false;
		if (slot) return slotsFor(spec).includes(slot);
		return !!(catalog[spec.type] && catalog[spec.type].IsContainer);
	}

	function keyInside(key, id) {
		const [parent] = splitParentKey(key);
		return parent === id || (parent && isInsideAny(parent, new Set([id])));
	}

	function outlineDrop(id, row, zone) {
		const spec = findControl(id);
		if (!spec) return;
		const ops = [];
		let key, order;
		if (zone === 'into') {
			key = row.dataset.key;
			const [parent, slot] = splitParentKey(key);
			if (parentKey(spec.parent, spec.parentSlot) === key) return;
			ops.push({ op: 'setParent', id, parent, parentSlot: slot });
			ops.push({ op: 'setBounds', id, x: 8, y: 8, w: spec.w, h: spec.h });
		} else {
			const target = findControl(row.dataset.id);
			key = parentKey(target.parent, target.parentSlot);
			if (parentKey(spec.parent, spec.parentSlot) !== key) {
				ops.push({ op: 'setParent', id, parent: target.parent || '', parentSlot: target.parentSlot || '' });
				ops.push({ op: 'setBounds', id, x: 8, y: 8, w: spec.w, h: spec.h });
			}
			// The outline lists front first, so "before" in it is later in
			// the add order.
			order = siblingsOf(target).map((c) => c.id).filter((x) => x !== id);
			const i = order.indexOf(target.id);
			order.splice(zone === 'before' ? i + 1 : i, 0, id);
			const [parent, slot] = splitParentKey(key);
			ops.push({ op: 'reorder', id: parent, parentSlot: slot, order });
		}
		post({ type: 'apply', ops });
	}

	// ---------------------------------------------------------------------
	// Toasts
	// ---------------------------------------------------------------------

	function showToast(message, kind) {
		const stack = $('toast-stack');
		const toast = document.createElement('div');
		toast.className = 'toast' + (kind === 'info' ? ' info' : '');
		const msg = document.createElement('div');
		msg.className = 'toast-msg';
		msg.textContent = message;
		const close = document.createElement('button');
		close.className = 'toast-close';
		close.textContent = '×';
		close.addEventListener('click', () => toast.remove());
		toast.appendChild(msg);
		toast.appendChild(close);
		stack.appendChild(toast);
		setTimeout(() => toast.remove(), 7000);
	}
})();
