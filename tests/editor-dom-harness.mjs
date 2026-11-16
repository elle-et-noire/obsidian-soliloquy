// Only Obsidian's host/DOM conveniences are mocked. CodeMirror and Vim are real.
export class Component {
	callbacks = [];
	children = new Set();
	load() {}
	register(callback) { this.callbacks.push(callback); }
	registerDomEvent(element, type, callback, options) {
		element.addEventListener(type, callback, options);
		this.register(() => element.removeEventListener(type, callback, options));
	}
	addChild(child) { this.children.add(child); child.load(); return child; }
	removeChild(child) { this.children.delete(child); child.unload(); }
	unload() {
		for (const child of this.children) child.unload();
		this.children.clear();
		for (const callback of this.callbacks.splice(0)) callback();
	}
}

export const moment = () => ({ format: () => '2026-09-07' });
/** Messages of the notices shown so far, oldest first. */
export const notices = [];
export class Notice {
	constructor(message) { notices.push(message); }
}
export class MarkdownView {}
export class TFile {}
export const normalizePath = path => path;
export class MarkdownRenderer {
	static async render(_app, markdown, element) { element.textContent = markdown; }
}
export function setIcon() {}
/** Tests switch this to cover macOS shortcuts. */
export const Platform = { isMacOS: false };

export function installDomHelpers(window) {
	// Obsidian's popout-aware accessors for a node's document and window.
	Object.defineProperties(window.Node.prototype, {
		doc: { configurable: true, get() { return this.ownerDocument ?? this; } },
		win: { configurable: true, get() { return (this.ownerDocument ?? this).defaultView; } },
	});
	const prototype = window.HTMLElement.prototype;
	/** Tests call `migrateWindow()` where Obsidian reports a move to another window. */
	prototype.onWindowMigrated = function(listener) {
		this.windowMigratedListeners ??= new Set();
		this.windowMigratedListeners.add(listener);
		return () => this.windowMigratedListeners.delete(listener);
	};
	prototype.migrateWindow = function() {
		for (const listener of this.windowMigratedListeners ?? []) listener(this.win);
	};
	prototype.createEl = function(tag, options = {}) {
		const element = this.ownerDocument.createElement(tag);
		if (options.cls) element.className = options.cls;
		if (options.text) element.textContent = options.text;
		for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
		this.appendChild(element);
		return element;
	};
	prototype.createDiv = function(options) { return this.createEl('div', options); };
	prototype.createSpan = function(options) { return this.createEl('span', options); };
	prototype.hide = function() { this.hidden = true; };
	prototype.show = function() { this.hidden = false; };
	prototype.toggle = function(shown) { this.hidden = !shown; };
	prototype.isShown = function() { return !this.closest('[hidden]'); };
	prototype.addClass = function(...names) { this.classList.add(...names); };
	prototype.removeClass = function(...names) { this.classList.remove(...names); };
	prototype.toggleClass = function(name, enabled) { this.classList.toggle(name, enabled); };
	prototype.empty = function() { this.replaceChildren(); };
}
