import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
	stdin: {
		contents: `
			export { SoliloquyModal } from './src/ui/soliloquy-modal';
			export { TimelinePanel } from './src/ui/timeline-panel';
			export { MarkdownView } from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	format: 'esm',
	write: false,
	plugins: [{
		name: 'modal-harness',
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'harness' }));
			builder.onResolve({ filter: /\/timeline-panel$/ }, () => ({ path: 'panel', namespace: 'harness' }));
			builder.onLoad({ filter: /.*/, namespace: 'harness' }, ({ path }) => ({
				contents: path === 'panel' ? `
					export class TimelinePanel {
						static instances = [];
						constructor(app, root, service, onNavigate) {
							Object.assign(this, { app, root, service, onNavigate });
							TimelinePanel.instances.push(this);
						}
						load() { this.loaded = true; }
						unload() { this.loaded = false; }
						registerDomEvent(root, type, listener) { root[type] = listener; }
						async mount() { await this.service.getPosts(); }
						focus(target) { this.focused = target; }
						async refreshTimeline(preserve) { this.preserve = preserve; }
						submitFromShortcut(target) { this.submitted = target; return true; }
						goBack() { this.wentBack = true; return true; }
					}
				` : `
					export class App {}
					export class View {}
					export class MarkdownView extends View {}
					export class Notice {}
					export class Scope {
						constructor(parent) { this.parent = parent; this.handlers = new Map(); }
						register(modifiers, key, callback) { this.handlers.set(key, callback); }
					}
					export class Modal {
						constructor(app) {
							this.app = app;
							this.scope = new Scope();
							this.modalEl = { addClass() {} };
							this.titleEl = { hide() {} };
							this.contentEl = {
								ownerDocument: globalThis.activeDocument,
								contains: element => element?.insideModal,
								matches: () => false,
								focus() { this.ownerDocument.activeElement = this; },
								empty() { this.emptied = true; },
							};
						}
						setTitle(title) { this.title = title; }
						open() { this.onOpen(); }
						close() { this.closed = true; this.onClose(); }
					}
				`,
				loader: 'js',
			}));
		},
	}],
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Modal lifecycle bundle was not generated.');
const { SoliloquyModal, TimelinePanel, MarkdownView } = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

function harness() {
	const selections = [{ anchor: { line: 8, ch: 2 }, head: { line: 8, ch: 7 } }];
	const scroll = { left: 0, top: 320 };
	const restored = {};
	const view = new MarkdownView();
	Object.assign(view, {
		leaf: {},
		file: {},
		getMode: () => 'source',
		containerEl: { win: { requestAnimationFrame: callback => callback() } },
		editor: {
			listSelections: () => selections,
			getScrollInfo: () => scroll,
			setSelections: value => { restored.selections = value; },
			focus: () => { restored.focused = true; },
			hasFocus: () => true,
			scrollTo: (left, top) => { restored.scroll = { left, top }; },
		},
	});
	const workspace = {
		getActiveViewOfType: () => view,
		iterateAllLeaves: callback => callback(view.leaf),
		setActiveLeaf: leaf => { restored.leaf = leaf; },
	};
	globalThis.activeDocument = { activeElement: null };
	const service = { getPosts: async () => [] };
	let closed = 0;
	const modal = new SoliloquyModal({ workspace }, service, () => { closed++; });
	modal.open();
	const panel = TimelinePanel.instances.at(-1);
	return { modal, panel, workspace, view, restored, selections, scroll, closed: () => closed };
}

test('modal uses a separate panel and unloads it before restoring the note selection', async () => {
	const first = harness();
	const second = harness();
	assert.notEqual(first.panel, second.panel);
	assert.equal(first.panel.focused, 'post');
	first.modal.close();
	assert.equal(first.panel.loaded, false);
	assert.equal(first.modal.contentEl.emptied, true);
	assert.equal(first.closed(), 1);
	assert.deepEqual(first.restored, {});
	await Promise.resolve();
	assert.deepEqual(first.restored, {
		leaf: first.view.leaf, scroll: first.scroll, focused: true,
	});
	assert.equal(first.view.editor.listSelections(), first.selections);
});

test('following a note link closes without restoring focus to the original note', async () => {
	const { modal, panel, restored } = harness();
	panel.onNavigate();
	assert.equal(modal.closed, true);
	assert.equal(panel.loaded, false);
	await Promise.resolve();
	assert.deepEqual(restored, {});
});

test('scroll restoration follows the editor layout without stealing a later focus change', async () => {
	const { modal, view, restored } = harness();
	let layout;
	view.containerEl.win.requestAnimationFrame = callback => { layout = callback; };
	modal.close();
	await Promise.resolve();
	restored.scroll = { left: 0, top: 999 };
	layout();
	assert.deepEqual(restored.scroll, { left: 0, top: 320 });
	view.editor.hasFocus = () => false;
	restored.scroll = { left: 0, top: 777 };
	layout();
	assert.deepEqual(restored.scroll, { left: 0, top: 777 });
});

test('closing does not steal focus if the active view changed or its leaf was removed', async () => {
	for (const detached of [true, false]) {
		const { modal, workspace, restored } = harness();
		if (detached) workspace.iterateAllLeaves = () => {};
		else workspace.getActiveViewOfType = () => null;
		modal.close();
		await Promise.resolve();
		assert.deepEqual(restored, {});
	}
});

test('two Escape presses leave a search input and then close the modal', () => {
	const { modal } = harness();
	const escape = modal.scope.handlers.get('Escape');
	const event = { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} };
	const input = { insideModal: true, matches: () => true, value: 'Search text' };
	globalThis.activeDocument.activeElement = input;
	assert.equal(escape(event), false);
	assert.equal(modal.closed, undefined);
	assert.equal(globalThis.activeDocument.activeElement, modal.contentEl);
	assert.equal(input.value, 'Search text');
	assert.equal(escape({ ...event, repeat: true }), false);
	assert.equal(modal.closed, undefined);
	assert.equal(escape(event), false);
	assert.equal(modal.closed, true);
});

test('Escape then slash returns to the same input with its text intact', () => {
	const { modal } = harness();
	const input = {
		insideModal: true,
		matches: () => true,
		isShown: () => true,
		value: 'Unsaved input',
		focus() { globalThis.activeDocument.activeElement = this; },
	};
	globalThis.activeDocument.activeElement = input;
	modal.contentEl.focusin();
	const event = { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} };
	modal.scope.handlers.get('Escape')(event);
	assert.equal(globalThis.activeDocument.activeElement, modal.contentEl);
	assert.equal(modal.scope.handlers.get('/')({ ...event, key: '/' }), false);
	assert.equal(globalThis.activeDocument.activeElement, input);
	assert.equal(input.value, 'Unsaved input');
	assert.equal(modal.closed, undefined);
	assert.equal(modal.scope.handlers.get('/')({ ...event, key: '/' }), undefined);
});

test('slash falls back to the main composer if the previous editor was removed', () => {
	const { modal, panel } = harness();
	const input = { insideModal: true, matches: selector => selector !== '.soliloquy-search' };
	globalThis.activeDocument.activeElement = input;
	modal.contentEl.focusin();
	input.insideModal = false;
	globalThis.activeDocument.activeElement = modal.contentEl;
	panel.focused = undefined;
	modal.scope.handlers.get('/')({ key: '/', preventDefault() {}, stopImmediatePropagation() {} });
	assert.equal(panel.focused, 'post');
});

test('modal forwards submission, back navigation, focus commands, and draft-safe updates', async () => {
	const { modal, panel } = harness();
	const target = {};
	modal.scope.handlers.get('Enter')({ target });
	modal.scope.handlers.get('ArrowLeft')({});
	modal.focus('search');
	await modal.refreshTimeline();
	assert.equal(panel.submitted, target);
	assert.equal(panel.wentBack, true);
	assert.equal(panel.focused, 'search');
	assert.equal(panel.preserve, true);
	panel.submitted = undefined;
	modal.scope.handlers.get('Enter')({ target, isComposing: true });
	assert.equal(panel.submitted, undefined);
});
