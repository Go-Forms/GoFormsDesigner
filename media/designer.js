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
	// extension keeps a snapshot history instead and these drive it.
	window.addEventListener('keydown', (e) => {
		// Delete removes the selection outright. It is undoable (Ctrl+Z), so
		// a confirmation step would only be in the way - which is exactly how
		// the WinForms designer behaves.
		if ((e.key === 'Delete' || e.key === 'Del') && !isTypingTarget(e.target)) {
			e.preventDefault();
			deleteSelection();
			return;
		}
		// Escape goes back to the form. It is the way out that does not
		// depend on finding somewhere to click: a form covered edge to edge
		// by a docked control has no background left, and then a control's
		// properties were the only thing the panel would ever show again.
		if (e.key === 'Escape' && !isTypingTarget(e.target)) {
			e.preventDefault();
			selectForm();
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
	}

	document.querySelectorAll('.side-tab').forEach((tab) => {
		tab.addEventListener('click', () => showTab(tab.dataset.tab));
	});

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
			if (e.target === canvas) {
				selectForm();
			}
		});
		titleBar.addEventListener('mousedown', selectForm);

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

		const filter = toolboxFilter.trim().toLowerCase();
		const groups = new Map();
		for (const type of Object.keys(catalog).sort()) {
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
				btn.textContent = catalog[type].Type || type;
				btn.title = `Add a new ${type}`;
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
					text: type,
				},
			],
		});
		setSelection(id, false);
	}

	function generateId(type) {
		const base = type.charAt(0).toLowerCase() + type.slice(1);
		const existing = new Set(model.controls.map((c) => c.id));
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
	// stored bounds showed something the app never looked like.
	//
	// The rule itself is ported in media/dockLayout.js and checked against
	// GoForms' own layout by test/dockLayout.test.js.
	function layoutChildren(parent, slot, host, kids) {
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
				if (el) applyBounds(el, spec);
			}
			return;
		}

		const rects = DL.arrange(boxes, hostClientSize(parent, slot, host));
		kids.forEach((spec, i) => {
			const el = rendered.get(spec.id);
			const r = rects[i];
			if (!el || !r) return;
			el.style.left = r.x + 'px';
			el.style.top = r.y + 'px';
			el.style.width = r.w + 'px';
			el.style.height = r.h + 'px';
			// Say so, rather than leaving the user to wonder why the control
			// won't stay where they put it.
			el.classList.toggle('docked', propOr(spec, 'dock', 'DockNone') !== 'DockNone');
		});
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

	function renderPictureBox() {
		const c = contentBase('cc-picturebox');
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

	function gridComputeWidths(cols, rows, spec) {
		const scrollBars = propOr(spec, 'scrollBars', 'ScrollBarsBoth');
		return {
			widths: GL.computeWidths({
				cols,
				rows,
				width: spec.w,
				columnsMode: propOr(spec, 'columnsMode', 'SizeFixed'),
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
			out.push({ index, title: c.title || '', kind: c.kind || '', buttonText: c.buttonText || '' });
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

		const { widths, canScrollH, canScrollV } = gridComputeWidths(cols, rows, spec);
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
				cell.className = 'cc-grid-cell cc-grid-headcell';
				if (i < frozen) cell.classList.add('cc-grid-frozen');
				cell.textContent = title;
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
				cell.className = 'cc-grid-cell';
				if (i < frozen) cell.classList.add('cc-grid-frozen');
				fillGridCell(cell, drawn[i], i < row.length ? row[i] : '');
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

	function renderTableLayoutPanel(spec) {
		const c = contentBase('cc-layoutpanel');
		const cols = parseInt(propOr(spec, 'columns', '2'), 10) || 2;
		const rows = parseInt(propOr(spec, 'rows', '2'), 10) || 2;

		const grid = document.createElement('div');
		grid.className = 'cc-table-grid';
		grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
		grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
		for (let i = 0; i < cols * rows; i++) {
			grid.appendChild(document.createElement('div'));
		}
		c.appendChild(grid);

		const hint = document.createElement('div');
		hint.className = 'cc-layout-hint';
		hint.textContent = `Table · ${cols}×${rows}`;
		c.appendChild(hint);
		return c;
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
	}

	// ---------------------------------------------------------------------
	// Drag (move)
	// ---------------------------------------------------------------------

	function onCtrlMouseDown(e, spec, d) {
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
		// Picking something on the canvas is a request to look at it, so the
		// panel shows its properties without a second click on the tab.
		showTab('properties');

		// Locked: the click above still selected the control, which is what
		// Lock Controls is for - inspecting a finished layout without nudging
		// it. Only the drag is refused.
		if (locked) {
			return;
		}

		// Only siblings move together: children of different parents use
		// different coordinate origins, so one shared delta would be wrong
		// for all but one of them.
		const parentId = parentKey(spec.parent, spec.parentSlot);
		const members = selectedSpecs()
			.filter((s2) => parentKey(s2.parent, s2.parentSlot) === parentId)
			.map((s2) => ({
				id: s2.id,
				el: ctrlEl(s2.id),
				origX: s2.x,
				origY: s2.y,
				w: s2.w,
				h: s2.h,
			}))
			.filter((m) => m.el);

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
			origX: spec.x,
			origY: spec.y,
			w: spec.w,
			h: spec.h,
			moved: false,
			newX: spec.x,
			newY: spec.y,
		};
		document.addEventListener('mousemove', onDragMove);
		document.addEventListener('mouseup', onDragUp);
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
		// relative arrangement survives the drag.
		const snapped = snapPosition(dragState.origX + dx, dragState.origY + dy, dragState);
		const appliedDX = snapped.x - dragState.origX;
		const appliedDY = snapped.y - dragState.origY;

		for (const m of dragState.members) {
			m.newX = Math.max(0, Math.round(m.origX + appliedDX));
			m.newY = Math.max(0, Math.round(m.origY + appliedDY));
			m.el.style.left = m.newX + 'px';
			m.el.style.top = m.newY + 'px';
		}
		dragState.newX = Math.max(0, Math.round(snapped.x));
		dragState.newY = Math.max(0, Math.round(snapped.y));
		showGuides(dragState);
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
		const changed = !host || host.parent !== dragState.parent || host.slot !== dragState.slot;
		if (dragState.dropHost && dragState.dropHost.el !== (host && host.el)) {
			dragState.dropHost.el.classList.remove('drop-host');
		}
		// Highlight only a host that would actually move the control:
		// outlining the container it is already in reads as a pending change
		// that isn't one.
		dragState.dropHost = host && changed ? host : null;
		if (dragState.dropHost) {
			dragState.dropHost.el.classList.add('drop-host');
		}
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

	// Snapping lines a dragged control up with its siblings' edges and
	// centres, which is what makes a hand-placed layout look deliberate.
	// GUIDE_SNAP is the grab distance in canvas pixels.
	const GUIDE_SNAP = 5;

	// snapCandidates lists the positions a moving edge could land on to be
	// flush with a stationary one: left-to-left, right-to-right, and
	// centre-to-centre.
	function snapCandidates(otherStart, otherSize, movingSize) {
		return [
			otherStart,
			otherStart + otherSize - movingSize,
			otherStart + otherSize / 2 - movingSize / 2,
		];
	}

	function snapPosition(rawX, rawY, state) {
		const moving = new Set(state.members.map((m) => m.id));
		let best = { x: rawX, y: rawY };
		let bestDX = GUIDE_SNAP + 1;
		let bestDY = GUIDE_SNAP + 1;

		for (const other of model.controls) {
			if (moving.has(other.id) || parentKey(other.parent, other.parentSlot) !== state.parentId) continue;

			for (const cand of snapCandidates(other.x, other.w, state.w)) {
				const d = Math.abs(rawX - cand);
				if (d < GUIDE_SNAP && d < bestDX) {
					bestDX = d;
					best.x = cand;
				}
			}
			for (const cand of snapCandidates(other.y, other.h, state.h)) {
				const d = Math.abs(rawY - cand);
				if (d < GUIDE_SNAP && d < bestDY) {
					bestDY = d;
					best.y = cand;
				}
			}
		}
		return best;
	}

	// showGuides draws a line wherever the dragged control's edge currently
	// coincides with a sibling's, so the snap is visible rather than magic.
	function showGuides(state) {
		clearGuides();
		const host = containerElFor(state.parent, state.slot);
		if (!host) return;
		const moving = new Set(state.members.map((m) => m.id));

		const add = (cls, prop, value) => {
			const g = document.createElement('div');
			g.className = 'align-guide ' + cls;
			g.style[prop] = value + 'px';
			host.appendChild(g);
		};

		for (const other of model.controls) {
			if (moving.has(other.id) || parentKey(other.parent, other.parentSlot) !== state.parentId) continue;
			if (other.x === state.newX) add('vertical', 'left', other.x);
			else if (other.x + other.w === state.newX + state.w) add('vertical', 'left', other.x + other.w);
			if (other.y === state.newY) add('horizontal', 'top', other.y);
			else if (other.y + other.h === state.newY + state.h) add('horizontal', 'top', other.y + other.h);
		}
	}

	function clearGuides() {
		document.querySelectorAll('.align-guide').forEach((g) => g.remove());
	}

	function onDragUp() {
		document.removeEventListener('mousemove', onDragMove);
		document.removeEventListener('mouseup', onDragUp);
		clearGuides();
		const host = dragState && dragState.dropHost;
		clearDropHost();

		if (dragState && dragState.moved) {
			const ops = [];
			for (const m of dragState.members) {
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
			if (ops.length) {
				post({ type: 'apply', ops });
			}
		}
		dragState = null;
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

		resizeState = {
			id: spec.id,
			el: d,
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
		const nw = Math.max(10, Math.round(resizeState.origW + dx));
		const nh = Math.max(10, Math.round(resizeState.origH + dy));
		resizeState.el.style.width = nw + 'px';
		resizeState.el.style.height = nh + 'px';
		resizeState.newW = nw;
		resizeState.newH = nh;
	}

	function onResizeUp() {
		document.removeEventListener('mousemove', onResizeMove);
		document.removeEventListener('mouseup', onResizeUp);
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

		const digest = JSON.stringify([
			selectedId,
			selectedIds.size,
			// The form's own panel is what shows when nothing is selected, so
			// its values belong in the digest too.
			model && [model.formTitle, model.formWidth, model.formHeight],
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
		// just changed scrolls out of sight the moment it is changed.
		const scroll = panel.scrollTop;
		panel.innerHTML = '';
		if (!spec) {
			appendFormGroup(panel);
			panel.scrollTop = scroll;
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
		}

		if (desc && desc.Setters && desc.Setters.SetText !== undefined) {
			appendTextGroup(panel, spec);
		}

		// ListView and DataGridView reuse Items for their column titles, so
		// the same editor serves both - only the label differs.
		if (spec.type === 'ComboBox' || spec.type === 'ListBox') {
			appendItemsGroup(panel, spec, 'Items');
		} else if (spec.type === 'DataGridView') {
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

		if (desc && desc.Events && desc.Events.length) {
			appendEventsGroup(panel, spec, desc.Events, desc);
		}

		appendDeleteButton(panel, spec);
		panel.scrollTop = scroll;
	}

	// appendNameGroup renames the control: the struct field, every reference
	// to it, and any handler still named after it. The tool refuses invalid
	// or already-taken names, so this only has to reset the box on failure.
	// appendAlignGroup offers the WinForms Format menu's alignment commands
	// for a multi-selection. Everything aligns to the primary control - the
	// last one clicked - which is the same rule the WinForms designer uses.
	function appendAlignGroup(panel) {
		const g = groupEl(`Align ${selectedIds.size} controls`);

		const commands = [
			['Left', (s, a) => ({ x: a.x })],
			['Right', (s, a) => ({ x: a.x + a.w - s.w })],
			['Top', (s, a) => ({ y: a.y })],
			['Bottom', (s, a) => ({ y: a.y + a.h - s.h })],
			['Centre H', (s, a) => ({ x: a.x + a.w / 2 - s.w / 2 })],
			['Centre V', (s, a) => ({ y: a.y + a.h / 2 - s.h / 2 })],
			['Same width', (s, a) => ({ w: a.w })],
			['Same height', (s, a) => ({ h: a.h })],
		];

		const row = document.createElement('div');
		row.className = 'align-buttons';
		for (const [label, compute] of commands) {
			const btn = document.createElement('button');
			btn.className = 'align-btn';
			btn.textContent = label;
			btn.addEventListener('click', () => applyAlign(compute));
			row.appendChild(btn);
		}
		g.appendChild(row);

		const hint = document.createElement('div');
		hint.className = 'hint';
		hint.textContent = 'Aligns to the last-clicked control. Ctrl or Shift click to extend the selection.';
		g.appendChild(hint);
		panel.appendChild(g);
	}

	function applyAlign(compute) {
		const anchor = findControl(selectedId);
		if (!anchor) return;

		const ops = [];
		for (const spec of selectedSpecs()) {
			if (spec.id === anchor.id) continue;
			const next = Object.assign({ x: spec.x, y: spec.y, w: spec.w, h: spec.h }, compute(spec, anchor));
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
				.map((it) => ({ method: it.handler, paramType: 'none' }));
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

			if (cd.Handler) {
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
		props.delete('text');
		return [...props].sort((a, b) => a.localeCompare(b));
	}

	function appendPropsGroup(panel, spec, props, desc) {
		const g = groupEl('Properties');
		for (const prop of props) {
			const row = document.createElement('div');
			row.className = 'prop-row';
			const label = document.createElement('label');
			label.textContent = prop;
			row.appendChild(label);

			const current = (spec.props && spec.props[prop]) || '';
			const kind = propKind(desc, prop);
			const send = (value) => {
				post({ type: 'apply', ops: [{ op: 'setProp', id: spec.id, prop, value }] });
			};

			if (kind === 'bool') {
				const input = document.createElement('input');
				input.type = 'checkbox';
				input.checked = current === 'true';
				input.addEventListener('change', () => send(input.checked ? 'true' : 'false'));
				row.appendChild(input);
			} else if (kind === 'enum') {
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
				row.appendChild(select);
			} else if (kind === 'flags') {
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
				row.appendChild(box);
			} else if (kind === 'number') {
				const input = document.createElement('input');
				input.type = 'number';
				input.value = current;
				const commit = () => {
					if (input.value.trim() !== '') send(input.value.trim());
				};
				input.addEventListener('change', commit);
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') input.blur();
				});
				row.appendChild(input);
			} else {
				const input = document.createElement('input');
				input.type = 'text';
				input.value = current;
				const commit = () => send(input.value);
				input.addEventListener('change', commit);
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') input.blur();
				});
				row.appendChild(input);
			}
			g.appendChild(row);
		}
		panel.appendChild(g);
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

			const label = document.createElement('span');
			label.className = 'event-name';
			label.textContent = eventName + (current ? ' ✓' : '');
			row.appendChild(label);

			const input = document.createElement('input');
			input.type = 'text';
			input.value = current;
			input.placeholder = `${spec.id}_${eventName}`;
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
