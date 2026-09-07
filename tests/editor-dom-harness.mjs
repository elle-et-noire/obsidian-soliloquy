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
export class Notice {}
export class MarkdownView {}
export class MarkdownRenderer {}
export function setIcon() {}

export function installDomHelpers(window) {
	const prototype = window.HTMLElement.prototype;
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
