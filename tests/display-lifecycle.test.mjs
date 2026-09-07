import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Scope, createInput, press } from './keyboard-harness.mjs';

const result = await build({
	stdin: {
		contents: `
			export { SoliloquyModal } from './src/ui/soliloquy-modal';
			export { SoliloquyView } from './src/ui/soliloquy-view';
			export { TimelinePanel } from './src/ui/timeline-panel';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true, format: 'esm', write: false,
	plugins: [{
		name: 'display-harness',
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'harness' }));
			builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
				contents: `
					import { Scope, KeyboardOwner, createRoot } from './tests/keyboard-harness.mjs';
					export { Scope };
					export class App {}
					export class WorkspaceLeaf {}
					export class MarkdownView {}
					export class MarkdownRenderer {}
					export class Notice {}
					export const moment = () => {};
					export const setIcon = () => {};
					export class Component extends KeyboardOwner {
						addChild(child) { child.load(); return child; }
						removeChild(child) { child.unload(); }
					}
					export class ItemView extends Component {
						constructor(leaf) {
							super();
							this.app = leaf.app;
							this.contentEl = createRoot(this.app.document);
						}
					}
					// Model only Modal's standard Escape and focus lifecycle, not plugin behavior.
					export class Modal {
						shouldRestoreSelection = true;
						constructor(app) {
							this.app = app;
							this.scope = new Scope();
							this.scope.register([], 'Escape', event => {
								if (!event.defaultPrevented) { event.preventDefault(); this.close(); }
							});
							this.modalEl = { addClass() {} };
							this.titleEl = { hide() {} };
							this.contentEl = createRoot(app.document);
						}
						setTitle(title) { this.title = title; }
						open() {
							this.selection = this.app.document.activeElement;
							this.onOpen();
							this.contentEl.firstInput.focus();
						}
						close() {
							this.closed = true;
							this.onClose();
							if (this.shouldRestoreSelection) this.selection?.focus({ preventScroll: true });
						}
					}
				`,
				loader: 'js', resolveDir: process.cwd(),
			}));
		},
	}],
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Display lifecycle bundle was not generated.');
const { SoliloquyModal, SoliloquyView, TimelinePanel } = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

// Keep real panel keyboard/lifecycle behavior; replace only timeline rendering.
TimelinePanel.prototype.mount = async function() {
	const root = this.contentEl;
	const postInput = createInput(root);
	const searchInput = createInput(root, 'search');
	root.firstInput = postInput;
	this.composer = {
		postInput, searchInput, searching: false, element: { show() {} },
		isSearching() { return this.searching; },
		setSearchMode(enabled) {
			this.searching = enabled;
			(enabled ? searchInput : postInput).focus();
		},
	};
	await this.service.getPosts();
};

async function harness(kind) {
	const document = { activeElement: null };
	const original = { focus(options) { this.options = options; document.activeElement = this; } };
	original.focus();
	const app = { document, scope: new Scope() };
	const service = { getPosts: async () => [] };
	const display = kind === 'modal' ? new SoliloquyModal(app, service, () => {})
		: new SoliloquyView({ app }, service);
	if (kind === 'modal') display.open();
	else await display.onOpen();
	return { display, panel: display.panel, root: display.contentEl, original, document };
}

test('both hosts exit search and preserve edit/reply drafts on Escape', async () => {
	for (const kind of ['modal', 'sidebar']) {
		const { display, panel, root } = await harness(kind);
		display.focus('search');
		press(display.scope, root);
		assert.equal(panel.composer.searching, false);
		assert.equal(root.ownerDocument.activeElement, panel.composer.postInput);
		assert.equal(display.closed, undefined);
		for (const field of ['edit', 'reply']) {
			const input = createInput(root, field);
			input.focus();
			press(display.scope, root);
			assert.equal(root.ownerDocument.activeElement, root);
			press(display.scope, root, { key: '/' });
			assert.equal(root.ownerDocument.activeElement, input);
			assert.equal(input.value, 'Unsaved text');
		}
	}
});

test('modal delegates initial focus, outside-input Escape, and focus restoration to its base class', async () => {
	const { display, panel, root, original, document } = await harness('modal');
	assert.equal(document.activeElement, panel.composer.postInput);
	assert.equal(display.shouldRestoreSelection, true);
	press(display.scope, root);
	assert.equal(display.closed, undefined);
	assert.equal(document.activeElement, root);
	press(display.scope, root);
	assert.equal(display.closed, true);
	assert.equal(panel.loaded, false);
	assert.equal(root.emptied, true);
	assert.equal(document.activeElement, original);
	assert.deepEqual(original.options, { preventScroll: true });
	assert.equal(display.scope.keys.length, 0);
});

test('sidebar Escape outside inputs does not close the panel or intercept workspace focus handling', async () => {
	const { display, panel, root } = await harness('sidebar');
	root.focus();
	assert.equal(press(display.scope, root).defaultPrevented, false);
	assert.equal(panel.loaded, true);
	await display.onClose();
	assert.equal(panel.loaded, false);
	assert.equal(display.scope.keys.length, 0);
});

test('following a note link closes the modal without restoring the old focus', async () => {
	const { display, panel, document, original } = await harness('modal');
	panel.onNavigate();
	assert.equal(display.closed, true);
	assert.equal(display.shouldRestoreSelection, false);
	assert.equal(panel.loaded, false);
	assert.notEqual(document.activeElement, original);
});

test('each display owns its panel and requests draft-preserving background updates', async () => {
	const modal = await harness('modal');
	const sidebar = await harness('sidebar');
	assert.notEqual(modal.panel, sidebar.panel);
	for (const { display, panel } of [modal, sidebar]) {
		let preserveDrafts;
		panel.refreshTimeline = preserve => { preserveDrafts = preserve; return Promise.resolve(); };
		await display.refreshTimeline();
		assert.equal(preserveDrafts, true);
	}
});
