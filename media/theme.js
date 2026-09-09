// theme.js - the webview client for the GoForms theme editor.
//
// Same contract as designer.js: the Go file is the source of truth, this
// sends an op and re-renders from whatever model comes back, rather than
// predicting the new state itself.
//
// The preview is the point of the whole editor. A theme is eleven colours
// whose names say what they are called, not what they do, and the only way to
// know whether Border reads against Background is to see them together.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	/** @type {any} ThemeModel from tool/theme.go, plain JSON over the wire. */
	let model = null;

	const $ = (id) => document.getElementById(id);
	const post = (m) => vscode.postMessage(m);

	window.addEventListener('message', (e) => {
		const msg = e.data;
		switch (msg.type) {
			case 'model':
				model = msg.model;
				render();
				break;
			case 'error':
				toast(msg.message, true);
				break;
			case 'parseError':
				renderParseError(msg.message);
				break;
		}
	});

	post({ type: 'ready' });

	// ---------------------------------------------------------------------
	// The defaults a field falls back to
	// ---------------------------------------------------------------------

	// What Fyne paints when the theme leaves a colour out. These are what the
	// preview draws for an unset field, so "unset" looks like what it will
	// actually be rather than like a hole.
	const FYNE_DEFAULTS = {
		light: {
			Background: '#ffffff', Foreground: '#181818', Primary: '#1a73e8',
			InputBackground: '#f3f3f3', ButtonColor: '#e5e5e5', Hover: '#e8e8e8',
			Border: '#c8c8c8', Disabled: '#a0a0a0', Placeholder: '#8c8c8c',
			Selection: '#b3d4fc', ScrollBar: '#9e9e9e',
		},
		dark: {
			Background: '#171717', Foreground: '#ffffff', Primary: '#1a73e8',
			InputBackground: '#1f1f1f', ButtonColor: '#282828', Hover: '#313131',
			Border: '#4c4c4c', Disabled: '#606060', Placeholder: '#8c8c8c',
			Selection: '#1a4a7a', ScrollBar: '#6d6d6d',
		},
	};

	const METRIC_DEFAULTS = { TextSize: 14, Padding: 4, InputBorderWidth: 1, InputRadius: 5 };

	const fieldsByName = () => {
		const out = {};
		for (const f of (model ? model.fields : [])) out[f.name] = f;
		return out;
	};

	/** effective is what a field is worth at runtime: its own value when set,
	 *  otherwise the default it falls through to. */
	function effective(name) {
		const f = fieldsByName()[name];
		if (f && f.set && f.editable) {
			if (f.kind === 'color') return f.color;
			if (f.kind === 'number') return f.number;
			if (f.kind === 'bool') return f.bool;
			if (f.kind === 'text') return f.text;
		}
		if (name in METRIC_DEFAULTS) return METRIC_DEFAULTS[name];
		const dark = !!(fieldsByName().Dark && fieldsByName().Dark.set && fieldsByName().Dark.bool);
		return FYNE_DEFAULTS[dark ? 'dark' : 'light'][name] || '#808080';
	}

	// ---------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------

	function render() {
		if (!model) return;
		renderFields();
		renderPreview();
	}

	function renderParseError(message) {
		$('fields').innerHTML = '';
		$('preview').innerHTML = '';
		const box = document.createElement('div');
		box.className = 'parse-error';
		const h = document.createElement('h2');
		h.textContent = "This file isn't in a shape the theme editor can edit";
		const p = document.createElement('p');
		p.textContent =
			'The theme editor expects one goforms.Theme{...} literal, usually returned from a Theme() function in <project>-styles.go. Details:';
		const pre = document.createElement('pre');
		pre.textContent = message;
		box.appendChild(h);
		box.appendChild(p);
		box.appendChild(pre);
		$('fields').appendChild(box);
	}

	function groupEl(title) {
		const g = document.createElement('div');
		g.className = 'group';
		const h = document.createElement('h3');
		h.textContent = title;
		g.appendChild(h);
		return g;
	}

	function renderFields() {
		const panel = $('fields');
		const scrolled = panel.scrollTop;
		panel.innerHTML = '';

		const identity = groupEl('Theme');
		const colours = groupEl('Colours');
		const metrics = groupEl('Metrics');

		for (const f of model.fields) {
			const target = f.kind === 'number' ? metrics : f.kind === 'color' ? colours : identity;
			target.appendChild(rowFor(f));
		}

		panel.appendChild(identity);
		panel.appendChild(colours);
		panel.appendChild(metrics);
		panel.scrollTop = scrolled;
	}

	function rowFor(f) {
		const row = document.createElement('div');
		row.className = 'row' + (f.set ? ' set' : '');

		const label = document.createElement('label');
		label.className = 'name';
		label.textContent = f.name;
		label.title = f.role;
		row.appendChild(label);

		if (!f.editable) {
			// Something written deliberately - a constant, a call. Shown, not
			// touched: overwriting it with a literal would throw away a
			// decision the tool cannot see the reason for.
			const raw = document.createElement('code');
			raw.className = 'raw';
			raw.textContent = f.raw;
			raw.title = 'Not a literal, so the editor leaves it alone. Edit it in the file.';
			row.appendChild(raw);
			return row;
		}

		row.appendChild(editorFor(f));

		// Every field can go back to its default, and that is a different
		// state from any value it could hold.
		if (f.set) {
			const clear = document.createElement('button');
			clear.className = 'clear';
			clear.textContent = '×';
			clear.title = `Unset ${f.name} - fall back to the default`;
			clear.addEventListener('click', () => apply({ op: 'unset', field: f.name }));
			row.appendChild(clear);
		} else {
			const hint = document.createElement('span');
			hint.className = 'default-hint';
			hint.textContent = 'default';
			hint.title = `${f.name} is not set, so Fyne's default is used.`;
			row.appendChild(hint);
		}
		return row;
	}

	function editorFor(f) {
		switch (f.kind) {
			case 'color':
				return colorEditor(f);
			case 'bool':
				return boolEditor(f);
			case 'number':
				return numberEditor(f);
			default:
				return textEditor(f);
		}
	}

	function colorEditor(f) {
		const wrap = document.createElement('div');
		wrap.className = 'value color-value';

		const current = f.set ? f.color : effective(f.name);
		// <input type=color> has no alpha, so the hex box beside it is not a
		// convenience - it is the only way to type one.
		const swatch = document.createElement('input');
		swatch.type = 'color';
		swatch.value = current.slice(0, 7);
		swatch.addEventListener('change', () => {
			apply({ op: 'set', field: f.name, color: swatch.value });
		});
		wrap.appendChild(swatch);

		const hex = document.createElement('input');
		hex.type = 'text';
		hex.className = 'hex';
		hex.value = current;
		hex.spellcheck = false;
		hex.placeholder = '#rrggbb';
		const commit = () => {
			const v = hex.value.trim();
			if (/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
				apply({ op: 'set', field: f.name, color: v.startsWith('#') ? v : '#' + v });
			} else {
				hex.value = current;
			}
		};
		hex.addEventListener('change', commit);
		hex.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') hex.blur();
		});
		wrap.appendChild(hex);
		return wrap;
	}

	function boolEditor(f) {
		const wrap = document.createElement('div');
		wrap.className = 'value';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = !!(f.set && f.bool);
		box.addEventListener('change', () => {
			apply({ op: 'set', field: f.name, bool: box.checked });
		});
		wrap.appendChild(box);
		return wrap;
	}

	function numberEditor(f) {
		const wrap = document.createElement('div');
		wrap.className = 'value';
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '0';
		input.step = '1';
		input.value = String(f.set ? f.number : effective(f.name));
		const commit = () => {
			const v = Number(input.value);
			if (Number.isFinite(v) && v >= 0) {
				apply({ op: 'set', field: f.name, number: v });
			} else {
				input.value = String(f.set ? f.number : effective(f.name));
			}
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') input.blur();
		});
		wrap.appendChild(input);
		return wrap;
	}

	function textEditor(f) {
		const wrap = document.createElement('div');
		wrap.className = 'value';
		const input = document.createElement('input');
		input.type = 'text';
		input.value = f.set ? f.text : '';
		input.placeholder = 'unnamed';
		const commit = () => {
			if (input.value.trim()) {
				apply({ op: 'set', field: f.name, text: input.value.trim() });
			}
		};
		input.addEventListener('change', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') input.blur();
		});
		wrap.appendChild(input);
		return wrap;
	}

	function apply(op) {
		post({ type: 'apply', ops: [op] });
	}

	// ---------------------------------------------------------------------
	// Preview
	// ---------------------------------------------------------------------

	// A mock form drawn with the theme's own values. It is not a screenshot of
	// the running app and does not pretend to be - it is the smallest
	// arrangement in which each colour appears against the ones it has to work
	// with: text on background, an input inside a border, a primary button
	// beside a plain one.
	function renderPreview() {
		const host = $('preview');
		host.innerHTML = '';

		const c = (name) => effective(name);
		const px = (name) => effective(name) + 'px';

		const win = document.createElement('div');
		win.className = 'pv-window';
		win.style.background = c('Background');
		win.style.color = c('Foreground');
		win.style.borderColor = c('Border');
		win.style.fontSize = px('TextSize');

		const title = document.createElement('div');
		title.className = 'pv-title';
		title.style.background = c('Primary');
		title.style.padding = px('Padding');
		title.textContent = (fieldsByName().Name && fieldsByName().Name.text) || 'Preview';
		win.appendChild(title);

		const body = document.createElement('div');
		body.className = 'pv-body';
		body.style.padding = String(Number(effective('Padding')) * 3) + 'px';
		body.style.gap = String(Number(effective('Padding')) * 2) + 'px';

		const heading = document.createElement('div');
		heading.className = 'pv-heading';
		heading.textContent = 'Body text on the background';
		body.appendChild(heading);

		const muted = document.createElement('div');
		muted.style.color = c('Disabled');
		muted.textContent = 'Disabled text, for comparison';
		body.appendChild(muted);

		const input = document.createElement('div');
		input.className = 'pv-input';
		input.style.background = c('InputBackground');
		input.style.borderColor = c('Border');
		input.style.borderWidth = px('InputBorderWidth');
		input.style.borderRadius = px('InputRadius');
		input.style.padding = px('Padding');
		const ph = document.createElement('span');
		ph.style.color = c('Placeholder');
		ph.textContent = 'Placeholder text';
		input.appendChild(ph);
		body.appendChild(input);

		const selected = document.createElement('div');
		selected.className = 'pv-input';
		selected.style.background = c('InputBackground');
		selected.style.borderColor = c('Border');
		selected.style.borderWidth = px('InputBorderWidth');
		selected.style.borderRadius = px('InputRadius');
		selected.style.padding = px('Padding');
		const sel = document.createElement('span');
		sel.style.background = c('Selection');
		sel.textContent = 'selected text';
		selected.appendChild(sel);
		body.appendChild(selected);

		const buttons = document.createElement('div');
		buttons.className = 'pv-buttons';
		buttons.style.gap = px('Padding');

		const primary = document.createElement('div');
		primary.className = 'pv-btn';
		primary.style.background = c('Primary');
		primary.style.borderRadius = px('InputRadius');
		primary.style.padding = `${effective('Padding')}px ${Number(effective('Padding')) * 3}px`;
		primary.textContent = 'Primary';
		buttons.appendChild(primary);

		const plain = document.createElement('div');
		plain.className = 'pv-btn';
		plain.style.background = c('ButtonColor');
		plain.style.color = c('Foreground');
		plain.style.borderRadius = px('InputRadius');
		plain.style.padding = `${effective('Padding')}px ${Number(effective('Padding')) * 3}px`;
		plain.textContent = 'Button';
		buttons.appendChild(plain);

		const hovered = document.createElement('div');
		hovered.className = 'pv-btn';
		hovered.style.background = c('Hover');
		hovered.style.color = c('Foreground');
		hovered.style.borderRadius = px('InputRadius');
		hovered.style.padding = `${effective('Padding')}px ${Number(effective('Padding')) * 3}px`;
		hovered.textContent = 'Hovered';
		buttons.appendChild(hovered);

		body.appendChild(buttons);

		const scrollRow = document.createElement('div');
		scrollRow.className = 'pv-scroll-row';
		const track = document.createElement('div');
		track.className = 'pv-scroll';
		track.style.background = c('Border');
		const thumb = document.createElement('div');
		thumb.className = 'pv-thumb';
		thumb.style.background = c('ScrollBar');
		track.appendChild(thumb);
		scrollRow.appendChild(track);
		body.appendChild(scrollRow);

		win.appendChild(body);
		host.appendChild(win);

		const note = document.createElement('p');
		note.className = 'pv-note';
		note.textContent =
			'Colours left unset are drawn as the default they fall back to, so this shows what the theme will look like, not only what it sets.';
		host.appendChild(note);
	}

	// ---------------------------------------------------------------------
	// Toasts
	// ---------------------------------------------------------------------

	function toast(text, isError) {
		const stack = $('toast-stack');
		const el = document.createElement('div');
		el.className = 'toast' + (isError ? ' error' : '');
		el.textContent = text;
		stack.appendChild(el);
		setTimeout(() => el.remove(), 6000);
	}
})();
