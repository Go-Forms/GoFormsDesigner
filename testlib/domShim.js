// domShim.js - just enough DOM to run media/designer.js in Node.
//
// The webview client is plain DOM code with no framework and no build step,
// which makes it fast and CSP-friendly but also means a typo or a bad
// assumption only shows up as a silent exception inside a webview, where
// nobody sees it. This shim exists so the panel-building code can be
// exercised in a test instead.
//
// It implements the handful of DOM features designer.js actually uses, and
// nothing else: element creation, the tree, classList/dataset/style, simple
// id and attribute selectors, and event listeners. Anything designer.js
// starts relying on that is missing here will throw loudly, which is the
// point.
'use strict';

class ClassList {
	constructor(el) {
		this.el = el;
		this.set = new Set();
	}
	add(...names) {
		names.forEach((n) => n && this.set.add(n));
	}
	remove(...names) {
		names.forEach((n) => this.set.delete(n));
	}
	contains(n) {
		return this.set.has(n);
	}
	toggle(n, force) {
		const on = force === undefined ? !this.set.has(n) : !!force;
		if (on) this.set.add(n);
		else this.set.delete(n);
		return on;
	}
	get value() {
		return [...this.set].join(' ');
	}
}

class Element {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.children = [];
		this.parentElement = null;
		this.classList = new ClassList(this);
		this.dataset = {};
		this.style = {};
		this.attributes = {};
		this.listeners = {};
		this._text = '';
		this.value = '';
		this.hidden = false;
		this.disabled = false;
		this.readOnly = false;
		this.draggable = false;
		this.scrollTop = 0;
		this.title = '';
		this.type = '';
		this.placeholder = '';
		this.selected = false;
		this.checked = false;
	}

	get className() {
		return this.classList.value;
	}
	set className(v) {
		this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
	}

	get textContent() {
		if (this.children.length) {
			return this.children.map((c) => c.textContent).join('');
		}
		return this._text;
	}
	set textContent(v) {
		this.children.forEach((c) => (c.parentElement = null));
		this.children = [];
		this._text = v === undefined || v === null ? '' : String(v);
	}

	get innerHTML() {
		return this.children.length ? '<...>' : '';
	}
	set innerHTML(v) {
		if (v !== '') throw new Error('domShim: only innerHTML = "" is supported, got ' + JSON.stringify(v));
		this.children.forEach((c) => (c.parentElement = null));
		this.children = [];
	}

	get firstChild() {
		return this.children[0] || null;
	}
	get firstElementChild() {
		return this.children[0] || null;
	}
	get nextElementSibling() {
		if (!this.parentElement) return null;
		const i = this.parentElement.children.indexOf(this);
		return this.parentElement.children[i + 1] || null;
	}

	appendChild(child) {
		if (child.parentElement) child.parentElement.removeChild(child);
		child.parentElement = this;
		this.children.push(child);
		this._text = '';
		return child;
	}
	insertBefore(child, ref) {
		if (child.parentElement) child.parentElement.removeChild(child);
		child.parentElement = this;
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(child);
		else this.children.splice(i, 0, child);
		return child;
	}
	replaceChild(next, prev) {
		const i = this.children.indexOf(prev);
		if (i < 0) throw new Error('domShim: replaceChild with a node that is not a child');
		if (next.parentElement) next.parentElement.removeChild(next);
		prev.parentElement = null;
		next.parentElement = this;
		this.children[i] = next;
		return prev;
	}
	removeChild(child) {
		const i = this.children.indexOf(child);
		if (i >= 0) this.children.splice(i, 1);
		child.parentElement = null;
		return child;
	}
	remove() {
		if (this.parentElement) this.parentElement.removeChild(this);
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}
	getAttribute(name) {
		return name in this.attributes ? this.attributes[name] : null;
	}
	setSelectionRange() {}
	focus() {}
	blur() {}

	addEventListener(type, fn) {
		(this.listeners[type] = this.listeners[type] || []).push(fn);
	}
	removeEventListener(type, fn) {
		const list = this.listeners[type] || [];
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	}
	/** dispatch runs the listeners registered for a type, as a click would. */
	dispatch(type, event) {
		const e = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, event);
		for (const fn of (this.listeners[type] || []).slice()) fn(e);
	}
	/** listenerCount is how the tests catch handlers piling up. */
	listenerCount(type) {
		return (this.listeners[type] || []).length;
	}

	get descendants() {
		const out = [];
		const walk = (el) => {
			for (const c of el.children) {
				out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	matches(sel) {
		const tag = sel.match(/^([a-zA-Z]+)$/);
		if (tag) return this.tagName === tag[1].toUpperCase();
		const cls = sel.match(/^\.([A-Za-z0-9_-]+)$/);
		if (cls) return this.classList.contains(cls[1]);
		const attr = sel.match(/^\[data-([A-Za-z0-9-]+)="([^"]*)"\]$/);
		if (attr) return this.dataset[camel(attr[1])] === attr[2];
		const tagCls = sel.match(/^([a-zA-Z]+)\.([A-Za-z0-9_-]+)$/);
		if (tagCls) return this.tagName === tagCls[1].toUpperCase() && this.classList.contains(tagCls[2]);
		const clsAttr = sel.match(/^\.([A-Za-z0-9_-]+)\[data-([A-Za-z0-9-]+)="([^"]*)"\]$/);
		if (clsAttr) {
			return this.classList.contains(clsAttr[1]) && this.dataset[camel(clsAttr[2])] === clsAttr[3];
		}
		throw new Error('domShim: unsupported selector ' + sel);
	}

	querySelector(sel) {
		const scoped = sel.replace(/^:scope > /, '');
		const direct = scoped !== sel;
		const pool = direct ? this.children : this.descendants;
		for (const el of pool) if (el.matches(scoped)) return el;
		return null;
	}
	querySelectorAll(sel) {
		return this.descendants.filter((el) => el.matches(sel));
	}
	closest(sel) {
		let cur = this;
		while (cur) {
			if (cur.matches && cur.matches(sel)) return cur;
			cur = cur.parentElement;
		}
		return null;
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
	}
}

function camel(s) {
	return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * install puts a fresh document/window on globalThis and returns handles the
 * tests use. html is a list of ids to create as the page skeleton.
 */
function install() {
	const root = new Element('body');
	const byId = new Map();

	// Walks the tree rather than consulting a registry: designer.js creates
	// elements with ids of its own (#form-canvas), and those have to be
	// findable too.
	const findById = (id) => {
		if (root.id === id) return root;
		return root.descendants.find((el) => el.id === id) || null;
	};

	// Drags are driven from document-level mousemove/mouseup listeners that
	// the mousedown handler installs and the mouseup handler removes, so
	// these have to be recorded, not swallowed: without them a test can press
	// the mouse down but never move or release it.
	const docListeners = {};
	const document = {
		body: root,
		createElement: (tag) => new Element(tag),
		getElementById: findById,
		querySelector: (sel) => root.querySelector(sel),
		querySelectorAll: (sel) => root.querySelectorAll(sel),
		addEventListener: (type, fn) => {
			(docListeners[type] = docListeners[type] || []).push(fn);
		},
		removeEventListener: (type, fn) => {
			const list = docListeners[type] || [];
			const i = list.indexOf(fn);
			if (i >= 0) list.splice(i, 1);
		},
		elementsFromPoint: () => [],
	};

	const add = (parent, id, cls, data) => {
		const el = new Element('div');
		el.id = id;
		if (cls) el.className = cls;
		if (data) Object.assign(el.dataset, data);
		parent.appendChild(el);
		byId.set(id, el);
		return el;
	};

	// The same skeleton designerEditorProvider.ts writes into the webview.
	const app = add(root, 'app');
	const main = add(app, 'main');
	const canvasWrap = add(main, 'canvas-wrap');
	add(canvasWrap, 'canvas-scroll');
	const side = add(main, 'side-panel');
	const tabs = add(side, 'side-tabs');

	const controlsTab = new Element('button');
	controlsTab.className = 'side-tab';
	controlsTab.dataset.tab = 'controls';
	tabs.appendChild(controlsTab);

	const propsTab = new Element('button');
	propsTab.className = 'side-tab active';
	propsTab.dataset.tab = 'properties';
	tabs.appendChild(propsTab);

	const controlsPanel = add(side, 'controls-panel', 'side-body');
	controlsPanel.hidden = true;
	add(side, 'properties-panel', 'side-body');
	add(app, 'toast-stack');

	const posted = [];
	const windowListeners = {};

	globalThis.document = document;
	globalThis.window = {
		addEventListener: (type, fn) => {
			(windowListeners[type] = windowListeners[type] || []).push(fn);
		},
	};
	globalThis.getComputedStyle = () => ({ fontFamily: 'sans-serif' });
	globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
	globalThis.setTimeout = globalThis.setTimeout || (() => 0);

	return {
		document,
		byId,
		posted,
		tabs: { controls: controlsTab, properties: propsTab },
		/** send delivers a message as the extension host would. */
		send(msg) {
			for (const fn of windowListeners.message || []) fn({ data: msg });
		},
		/** keydown fires a window-level key event, as the editor does. */
		keydown(event) {
			const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, event);
			for (const fn of (windowListeners.keydown || []).slice()) fn(e);
		},
		/** docDispatch fires a document-level event, as a drag needs. */
		docDispatch(type, event) {
			const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, event);
			for (const fn of (docListeners[type] || []).slice()) fn(e);
		},
		/** docListenerCount is how a test catches drag listeners left behind. */
		docListenerCount: (type) => (docListeners[type] || []).length,
		el: findById,
	};
}

module.exports = { install, Element };
