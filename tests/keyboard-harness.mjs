// Model Scope's wildcard/parent behavior, checked against Obsidian 1.13.7.
export class Scope {
	keys = [];
	constructor(parent) { this.parent = parent; }
	register(modifiers, key, callback) {
		const handler = { modifiers, key, callback };
		this.keys.push(handler);
		return handler;
	}
	unregister(handler) { this.keys = this.keys.filter(key => key !== handler); }
	handleKey(event) {
		const modifiers = ['ctrl', 'meta', 'alt', 'shift'].filter(key => event[`${key}Key`]);
		for (const binding of this.keys) {
			if (binding.key !== null && binding.key !== event.key) continue;
			if (binding.modifiers !== null
				&& binding.modifiers.map(key => key.toLowerCase()).sort().join() !== modifiers.sort().join()) continue;
			const result = binding.callback(event);
			if (result !== undefined || binding.key !== null || binding.modifiers !== null) return result;
		}
		return this.parent?.handleKey(event);
	}
}

export class KeyboardOwner {
	callbacks = [];
	register(callback) { this.callbacks.push(callback); }
	registerDomEvent(root, type, listener) {
		const listeners = root.listeners.get(type) ?? new Set();
		root.listeners.set(type, listeners);
		listeners.add(listener);
		this.register(() => listeners.delete(listener));
	}
	load() { this.loaded = true; }
	unload() {
		this.loaded = false;
		for (const callback of this.callbacks.splice(0)) callback();
	}
}

export function createRoot(ownerDocument = { activeElement: null }) {
	return {
		ownerDocument,
		listeners: new Map(),
		contains(element) { return element === this || element?.root === this; },
		matches: () => false,
		focus() { ownerDocument.activeElement = this; },
		addClass() {},
		empty() { this.emptied = true; },
	};
}

export function createInput(root, kind = 'post') {
	return {
		root, kind,
		value: 'Unsaved text', selectionStart: 2, selectionEnd: 7,
		shown: true,
		matches(selector) { return selector === '.soliloquy-search' ? kind === 'search' : selector.includes('textarea'); },
		isShown() { return this.shown; },
		focus() {
			root.ownerDocument.activeElement = this;
			for (const listener of root.listeners.get('focusin') ?? []) listener();
		},
	};
}

export function press(scope, root, overrides = {}) {
	const event = {
		key: 'Escape', target: root.ownerDocument.activeElement,
		defaultPrevented: false, stopped: false,
		preventDefault() { this.defaultPrevented = true; },
		stopImmediatePropagation() { this.stopped = true; },
		...overrides,
	};
	const result = scope.handleKey(event);
	if (result === false) {
		event.preventDefault();
		event.stopped = true;
	}
	if (!event.stopped) {
		for (const listener of root.listeners.get('keydown') ?? []) {
			listener(event);
			if (event.stopped) break;
		}
	}
	return event;
}
