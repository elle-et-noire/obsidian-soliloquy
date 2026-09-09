import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
	entryPoints: ['src/ui/timeline-panel.ts'],
	bundle: true,
	format: 'esm',
	write: false,
	plugins: [{
		name: 'component-harness',
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'harness' }));
			builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
				contents: `
					export class App {}
					export class Component {
						callbacks = [];
						register(callback) { this.callbacks.push(callback); }
						unload() { for (const callback of this.callbacks) callback(); }
						removeChild() {}
					}
					export class MarkdownView {}
					export class MarkdownRenderer {}
					export class Notice {}
					export const moment = () => {};
					export const setIcon = () => {};
				`,
				loader: 'js',
			}));
		},
	}],
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Timeline panel bundle was not generated.');
const { TimelinePanel } = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

function harness() {
	let reads = 0;
	let renders = 0;
	const service = { getPosts: async () => { reads++; return []; } };
	const root = { ownerDocument: { activeElement: null } };
	const panel = new TimelinePanel({}, root, service);
	panel.postRenderer.restoreCard = async () => {};
	const attributes = new Map();
	panel.timelineEl = {
		...root,
		setAttribute: (key, value) => attributes.set(key, value),
	};
	panel.composer = { updateStats() {} };
	panel.renderTimeline = () => { renders++; return Promise.resolve(); };
	return { panel, service, attributes, reads: () => reads, renders: () => renders };
}

test('another display updating daily notes cannot discard an edit draft', async () => {
	const { panel, reads, renders } = harness();
	const draft = { value: 'Unsaved edit' };
	panel.editing = { input: draft, post: {} };
	await panel.refreshTimeline(true);
	assert.equal(panel.editing.input, draft);
	assert.equal(reads(), 0);
	assert.equal(renders(), 0);
	await panel.cancelEdit();
	assert.equal(panel.editing, undefined);
	assert.equal(reads(), 1);
	assert.equal(renders(), 1);
});

test('reply drafts survive background updates and cancellation loads fresh posts', async () => {
	const { panel, renders } = harness();
	const reply = { remove() {} };
	panel.inlineReplyComposerEl = reply;
	await panel.refreshTimeline(true);
	assert.equal(panel.inlineReplyComposerEl, reply);
	assert.equal(renders(), 0);
	await panel.cancelReply();
	assert.equal(panel.inlineReplyComposerEl, undefined);
	assert.equal(renders(), 1);
});

test('an editor opened during an asynchronous refresh is preserved', async () => {
	const { panel, service, attributes, renders } = harness();
	let finishRead;
	service.getPosts = () => new Promise(resolve => { finishRead = resolve; });
	const refreshing = panel.refreshTimeline(true);
	const draft = { value: 'Typed during read' };
	panel.editing = { input: draft, post: {} };
	finishRead([]);
	await refreshing;
	assert.equal(panel.editing.input, draft);
	assert.equal(renders(), 0);
	assert.equal(attributes.get('aria-busy'), 'false');
});

test('closing a panel invalidates a pending read and ignores future refreshes', async () => {
	const { panel, service, renders } = harness();
	let finishRead;
	service.getPosts = () => new Promise(resolve => { finishRead = resolve; });
	const refreshing = panel.refreshTimeline(true);
	panel.unload();
	finishRead([]);
	await refreshing;
	await panel.refreshTimeline(true);
	assert.equal(renders(), 0);
	assert.equal(panel.submitFromShortcut({}), false);
});

test('a save finishing after the modal closes cannot refocus its input', async () => {
	const { panel, service, renders } = harness();
	let finishSave;
	let focused = false;
	let cleared = false;
	let savedText;
	service.addPost = text => {
		savedText = text;
		return new Promise(resolve => { finishSave = resolve; });
	};
	panel.composer = {
		setPosting() {},
		input: {
			value: 'A submitted post', focus: () => { focused = true; },
			containsTarget(target) { return target === this; },
		},
		clearPost: () => { cleared = true; },
		isSearching: () => false,
	};
	assert.equal(panel.submitFromShortcut(panel.composer.input), true);
	panel.unload();
	finishSave();
	await Promise.resolve();
	assert.equal(savedText, 'A submitted post');
	assert.equal(focused, false);
	assert.equal(cleared, false);
	assert.equal(renders(), 0);
});
