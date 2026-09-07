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
	const input = createInput(root);
	root.firstInput = input;
	this.composer = {
		input, searching: false, element: { show() {} },
		isSearching() { return this.searching; },
		setSearchMode(enabled) {
			this.searching = enabled;
			input.kind = enabled ? 'search' : 'post';
			input.focus();
		},
	};
	await this.service.getPosts();
};

async function harness(kind) {
	const document = { activeElement: null };
	const original = { focus(options) { this.options = options; document.activeElement = this; } };
	original.focus();
	const app = { document, scope: new Scope(), workspace: {
		getMostRecentLeaf: () => ({ view: { getViewType: () => 'markdown' } }),
		setActiveLeaf: () => original.focus(),
	} };
	const service = { getPosts: async () => [] };
	const display = kind === 'modal' ? new SoliloquyModal(app, service, () => {})
		: new SoliloquyView({ app }, service);
	if (kind === 'modal') display.open();
	else await display.onOpen();
	return { display, panel: display.panel, root: display.contentEl, original, document };
}

test('both hosts exit search on Shift+Escape and preserve edit/reply drafts when leaving inputs', async () => {
	for (const kind of ['modal', 'sidebar']) {
		const { display, panel, root } = await harness(kind);
		display.focus('search');
		press(display.scope, root);
		assert.equal(panel.composer.searching, true);
		assert.equal(root.ownerDocument.activeElement, panel.composer.input);
		press(display.scope, root, { shiftKey: true });
		assert.equal(panel.composer.searching, false);
		assert.equal(root.ownerDocument.activeElement, panel.composer.input);
		assert.equal(display.closed, undefined);
		for (const field of ['edit', 'reply']) {
			const input = createInput(root, field);
			input.focus();
			press(display.scope, root, { shiftKey: true });
			assert.equal(root.ownerDocument.activeElement, root);
			press(display.scope, root, { key: '/' });
			assert.equal(root.ownerDocument.activeElement, input);
			assert.equal(input.value, 'Unsaved text');
		}
	}
});

test('modal retains base initial focus and focus restoration when shared Escape handling closes it', async () => {
	const { display, panel, root, original, document } = await harness('modal');
	assert.equal(document.activeElement, panel.composer.input);
	assert.equal(display.shouldRestoreSelection, true);
	press(display.scope, root);
	assert.equal(display.closed, undefined);
	assert.equal(document.activeElement, panel.composer.input);
	press(display.scope, root, { shiftKey: true });
	assert.equal(document.activeElement, root);
	press(display.scope, root);
	assert.equal(display.closed, true);
	assert.equal(panel.loaded, false);
	assert.equal(root.emptied, true);
	assert.equal(document.activeElement, original);
	assert.deepEqual(original.options, { preventScroll: true });
	assert.equal(display.scope.keys.length, 0);
});

test('sidebar Escape outside inputs focuses a workspace pane without closing the panel', async () => {
	const { display, panel, root, original, document } = await harness('sidebar');
	root.focus();
	assert.equal(press(display.scope, root).defaultPrevented, true);
	assert.equal(document.activeElement, original);
	assert.equal(panel.loaded, true);
	await display.onClose();
	assert.equal(panel.loaded, false);
	assert.equal(display.scope.keys.length, 0);
});

test('Shift+Escape outside inputs has the same host behavior as Escape', async () => {
	for (const kind of ['modal', 'sidebar']) {
		const { display, panel, root, original, document } = await harness(kind);
		root.focus();
		press(display.scope, root, { shiftKey: true });
		assert.equal(document.activeElement, original);
		assert.equal(panel.loaded, kind === 'sidebar');
		if (kind === 'sidebar') await display.onClose();
	}
});

test('tab focus skips other Soliloquy panes and blurs if there is no destination', async () => {
	for (const hasDestination of [false, true]) {
		const { display, root, original, document } = await harness('sidebar');
		const workspace = display.app.workspace;
		workspace.rootSplit = {};
		const soliloquy = { view: { getViewType: () => 'soliloquy-timeline' }, getRoot: () => workspace.rootSplit };
		const note = { view: { getViewType: () => 'markdown' }, getRoot: () => workspace.rootSplit };
		workspace.getMostRecentLeaf = () => soliloquy;
		workspace.iterateAllLeaves = callback => {
			callback(soliloquy);
			if (hasDestination) callback(note);
		};
		workspace.setActiveLeaf = (leaf, options) => {
			assert.equal(leaf, note);
			assert.deepEqual(options, { focus: true });
			original.focus();
		};
		root.focus();
		press(display.scope, root);
		assert.equal(document.activeElement, hasDestination ? original : null);
		await display.onClose();
	}
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
