import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { Component, installDomHelpers } from './editor-dom-harness.mjs';
import { Scope } from './keyboard-harness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const { window } = dom;
for (const name of ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'Element', 'Node', 'Window']) {
	Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
}
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
installDomHelpers(window);
// jsdom has no layout engine. These are only used by CodeMirror's measurements.
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const result = await build({
	stdin: { contents: `
		export { SoliloquyTextEditor } from './src/ui/text-editor';
		export { SoliloquyComposer } from './src/ui/composer';
		export { TimelinePanel } from './src/ui/timeline-panel';
		export { TimelineService } from './src/services/timeline-service';
		export { TimelineIndex } from './src/services/timeline-index';
		export { PostChangedError } from './src/services/errors';
		export { PostCardRenderer } from './src/ui/post-card';
		export { MarkdownRenderer, notices } from './tests/editor-dom-harness.mjs';
		export { registerTimelineKeyboard } from './src/ui/timeline-keyboard';
		export { TimelineSurface, nextAnimationFrame } from './src/ui/timeline-surface';
		export { Platform } from './tests/editor-dom-harness.mjs';
		export { getCM } from '@replit/codemirror-vim';
	`, resolveDir: process.cwd() },
	bundle: true, format: 'esm', write: false,
	alias: { obsidian: './tests/editor-dom-harness.mjs' },
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Editor test bundle was not generated.');
const { SoliloquyTextEditor, SoliloquyComposer, TimelinePanel, TimelineService, TimelineIndex, PostChangedError, PostCardRenderer, MarkdownRenderer, notices, registerTimelineKeyboard, TimelineSurface, nextAnimationFrame, Platform, getCM } = await import(
	`data:text/javascript;base64,${Buffer.from(source + '\n//# sourceURL=soliloquy-editor-tests.js').toString('base64')}`
);

function harness(t, enabled = true) {
	const root = document.body.createDiv();
	root.tabIndex = -1;
	const owner = new Component();
	const config = { enabled };
	const app = { vault: { getConfig: () => config.enabled } };
	const parent = new Scope();
	let exits = 0;
	parent.register([], 'Escape', () => assert.fail('Parent Scope intercepted editor Escape'));
	const scope = new Scope(parent);
	const actions = {
		focus: () => {}, submit: () => false, goBack: () => false,
		leaveDisplay: () => { exits++; },
	};
	registerTimelineKeyboard(owner, scope, root, actions);
	owner.registerDomEvent(document, 'keydown', event => {
		if (!root.contains(document.activeElement)) return;
		if (scope.handleKey(event) === false) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}, { capture: true });
	const create = (cls = 'soliloquy-input', value = 'alpha beta\nsecond line') => owner.addChild(
		new SoliloquyTextEditor(app, root, { cls, label: cls, placeholder: 'Write', value }),
	);
	t.after(() => { owner.unload(); root.remove(); });
	return { root, owner, app, config, actions, create, exits: () => exits };
}

function press(key, options = {}) {
	const event = new window.KeyboardEvent('keydown', {
		key, keyCode: key === 'Escape' ? 27 : key === 'Enter' ? 13 : key === 'Tab' ? 9 : 0,
		bubbles: true, cancelable: true, ...options,
	});
	document.activeElement.dispatchEvent(event);
	return event;
}

test('Insert-mode Tab and Shift+Tab indent the current line in every input without moving focus', t => {
	const h = harness(t);
	for (const cls of ['soliloquy-input', 'soliloquy-search', 'soliloquy-edit-input', 'soliloquy-reply-input']) {
		const input = h.create(cls);
		input.focus();
		input.view.dispatch({ selection: { anchor: 8 } });
		assert.equal(press('Tab').defaultPrevented, true, cls);
		assert.equal(input.value, '  alpha beta\nsecond line');
		assert.equal(input.view.state.selection.main.head, 10);
		assert.equal(document.activeElement, input.view.contentDOM);
		assert.equal(getCM(input.view).state.vim.insertMode, true);
		assert.equal(press('Tab', { shiftKey: true }).defaultPrevented, true);
		assert.equal(input.value, 'alpha beta\nsecond line');
		assert.equal(input.view.state.selection.main.head, 8);
		// An already unindented line must still keep focus in Insert mode.
		assert.equal(press('Tab', { shiftKey: true }).defaultPrevented, true);
		assert.equal(input.value, 'alpha beta\nsecond line');
		assert.equal(document.activeElement, input.view.contentDOM);
	}
});

test('Insert-mode indentation handles selected lines and remains undoable through Vim', t => {
	const h = harness(t);
	const input = h.create();
	input.focus();
	input.view.dispatch({ selection: { anchor: 2, head: input.value.length } });
	const selection = input.view.state.selection.toJSON();
	press('Tab');
	assert.equal(input.value, '  alpha beta\n  second line');
	press('Tab', { shiftKey: true });
	assert.equal(input.value, 'alpha beta\nsecond line');
	assert.deepEqual(input.view.state.selection.toJSON(), selection);
	press('Tab'); press('Escape'); press('u');
	assert.equal(input.value, 'alpha beta\nsecond line');
});

test('Normal-mode Tab and Shift+Tab remain available to native focus navigation', t => {
	const h = harness(t);
	let nativeTabs = 0;
	h.owner.registerDomEvent(document, 'keydown', event => {
		if (event.key === 'Tab' && !event.defaultPrevented) nativeTabs++;
	});
	for (const cls of ['soliloquy-input', 'soliloquy-search', 'soliloquy-edit-input', 'soliloquy-reply-input']) {
		const input = h.create(cls);
		input.focus(); press('Escape');
		const selection = input.view.state.selection.toJSON();
		assert.equal(press('Tab').defaultPrevented, false, cls);
		assert.equal(press('Tab', { shiftKey: true }).defaultPrevented, false, cls);
		assert.equal(input.value, 'alpha beta\nsecond line');
		assert.deepEqual(input.view.state.selection.toJSON(), selection);
		assert.equal(getCM(input.view).state.vim.insertMode, false);
		press('i');
		assert.equal(press('Tab').defaultPrevented, true);
		assert.equal(input.value, '  alpha beta\nsecond line');
	}
	// jsdom does not perform native Tab navigation; verify both keys reach the host uncancelled.
	assert.equal(nativeTabs, 8);
});

test('Tab navigation without Vim is unchanged, including after toggling the setting', t => {
	const h = harness(t, false);
	const input = h.create();
	input.focus();
	for (const enabled of [false, true, false]) {
		h.root.focus(); h.config.enabled = enabled; input.focus();
		assert.equal(press('Tab').defaultPrevented, enabled);
		assert.equal(press('Tab', { shiftKey: true }).defaultPrevented, enabled);
		assert.equal(input.value, 'alpha beta\nsecond line');
	}
});

test('real Vim edits, selects, cancels pending commands, and undoes inside every input', t => {
	const h = harness(t);
	for (const cls of ['soliloquy-input', 'soliloquy-search', 'soliloquy-edit-input', 'soliloquy-reply-input']) {
		const input = h.create(cls);
		input.focus();
		assert.equal(getCM(input.view).state.vim.insertMode, true);
		assert.equal(input.element.querySelector('.cm-vim-panel'), null);
		press('Escape');
		assert.equal(getCM(input.view).state.vim.insertMode, false);
		assert.equal(input.element.querySelector('.cm-vim-panel'), null);
		press('w');
		assert.equal(input.view.state.selection.main.head, 6);
		press('v');
		assert.equal(getCM(input.view).state.vim.visualMode, true);
		press('Escape');
		assert.equal(getCM(input.view).state.vim.visualMode, false);
		press('d'); press('Escape'); press('w');
		assert.equal(input.value, 'alpha beta\nsecond line');
		press('d'); press('d');
		assert.equal(input.value, 'alpha beta');
		press('u');
		assert.equal(input.value, 'alpha beta\nsecond line');
		press('Escape'); press('Escape');
		assert.equal(document.activeElement, input.view.contentDOM);
		assert.equal(h.exits(), 0);
	}
});

test('Shift+Escape preserves text, selection, Vim mode, and slash restores the editor', t => {
	const h = harness(t);
	const input = h.create();
	input.focus(); press('Escape'); press('w'); press('v');
	const selection = input.view.state.selection.toJSON();
	press('Escape', { shiftKey: true });
	assert.equal(document.activeElement, h.root);
	assert.equal(input.value, 'alpha beta\nsecond line');
	assert.deepEqual(input.view.state.selection.toJSON(), selection);
	press('/');
	assert.equal(document.activeElement, input.view.contentDOM);
	assert.equal(getCM(input.view).state.vim.visualMode, true);
	assert.deepEqual(input.view.state.selection.toJSON(), selection);
	press('Escape', { shiftKey: true });
	press('Escape', { shiftKey: true });
	assert.equal(h.exits(), 1);
});

test('Vim search and Ex prompts receive Escape before modal handling', t => {
	const h = harness(t);
	const input = h.create();
	input.focus(); press('Escape');
	for (const key of ['/', ':']) {
		press(key);
		assert.equal(document.activeElement.tagName, 'INPUT');
		press('Escape');
		assert.equal(document.activeElement, input.view.contentDOM);
		assert.equal(h.exits(), 0);
	}
});

test('repeated Escape cannot bubble to host focus handling after Vim returns to Normal mode', t => {
	for (const enabled of [true, false]) {
		const h = harness(t, enabled);
		let hostEscapes = 0;
		h.owner.registerDomEvent(document, 'keydown', event => {
			if (event.key !== 'Escape' || event.defaultPrevented || !h.root.contains(document.activeElement)) return;
			hostEscapes++;
			document.activeElement.blur();
		});
		for (const cls of ['soliloquy-input', 'soliloquy-search', 'soliloquy-edit-input', 'soliloquy-reply-input']) {
			const input = h.create(cls);
			input.focus();
			for (let count = 0; count < 6; count++) {
				const event = press('Escape');
				assert.equal(document.activeElement === input.view.contentDOM, true, `${cls}: Escape ${count + 1}`);
				assert.equal(event.defaultPrevented, true);
			}
			assert.equal(input.value, 'alpha beta\nsecond line');
			if (enabled) assert.equal(getCM(input.view).state.vim.insertMode, false);
		}
		assert.equal(hostEscapes, 0);
		assert.equal(h.exits(), 0);
	}
});

test('Vim setting changes preserve the document and undo history', t => {
	const h = harness(t, false);
	const input = h.create();
	input.focus();
	assert.equal(getCM(input.view), null);
	input.view.dispatch({ changes: { from: 0, to: 5, insert: 'changed' }, userEvent: 'input' });
	press('Escape');
	assert.equal(document.activeElement, input.view.contentDOM);
	h.root.focus(); h.config.enabled = true; input.focus();
	assert.equal(getCM(input.view).state.vim.insertMode, true);
	assert.equal(input.value, 'changed beta\nsecond line');
	press('Escape'); press('u');
	assert.equal(input.value, 'alpha beta\nsecond line');
	h.root.focus(); h.config.enabled = false; input.focus();
	assert.equal(getCM(input.view), null);
	press('Escape', { shiftKey: true });
	assert.equal(document.activeElement, h.root);
});

test('Shift+Escape returns search to posting with the same text and selection', t => {
	const h = harness(t);
	const composer = new SoliloquyComposer(h.app, h.root, h.owner, { onPost() {}, onSearchChange() {} });
	h.actions.focus = target => composer.setSearchMode(target === 'search');
	composer.input.value = '日本語の下書き';
	composer.input.view.dispatch({ selection: { anchor: 2, head: 5 } });
	composer.setSearchMode(true);
	assert.equal(composer.input.value, '日本語の下書き');
	assert.equal(composer.input.view.state.selection.main.anchor, 2);
	assert.equal(composer.input.view.state.selection.main.head, 5);
	press('Escape', { shiftKey: true });
	assert.equal(composer.isSearching(), false);
	assert.equal(composer.getSearchQuery(), '');
	assert.equal(document.activeElement, composer.input.view.contentDOM);
	assert.equal(composer.input.value, '日本語の下書き');
	assert.equal(composer.input.view.state.selection.main.anchor, 2);
	assert.equal(composer.input.view.state.selection.main.head, 5);
	assert.equal(h.exits(), 0);
});

test('search/post transitions preserve Insert, Normal, Visual submodes, and Replace mode', t => {
	for (const initialSearch of [false, true]) {
		for (const mode of ['insert', 'normal', 'visual', 'visual-line', 'visual-block', 'replace']) {
			const h = harness(t);
			const composer = new SoliloquyComposer(h.app, h.root, h.owner, { onPost() {}, onSearchChange() {} });
			h.actions.focus = target => composer.setSearchMode(target === 'search');
			composer.input.value = 'alpha beta\nsecond line';
			composer.setSearchMode(initialSearch);
			if (mode !== 'insert') press('Escape');
			if (mode === 'visual') { press('v'); press('l'); }
			if (mode === 'visual-line') press('V', { shiftKey: true });
			if (mode === 'visual-block') { press('v', { ctrlKey: true }); press('j'); }
			if (mode === 'replace') press('R', { shiftKey: true });
			const cm = getCM(composer.input.view);
			const vimMode = () => ({
				insert: !!cm.state.vim.insertMode, visual: !!cm.state.vim.visualMode,
				line: !!cm.state.vim.visualLine, block: !!cm.state.vim.visualBlock,
				overwrite: !!cm.state.overwrite,
			});
			const before = vimMode();
			assert.equal(before.insert, mode === 'insert' || mode === 'replace');
			assert.equal(before.visual, mode.startsWith('visual'));
			assert.equal(before.line, mode === 'visual-line');
			assert.equal(before.block, mode === 'visual-block');
			assert.equal(before.overwrite, mode === 'replace');
			const selection = composer.input.view.state.selection.toJSON();
			const assertPreserved = () => {
				assert.deepEqual(vimMode(), before, mode);
				assert.deepEqual(composer.input.view.state.selection.toJSON(), selection, mode);
				assert.equal(composer.input.value, 'alpha beta\nsecond line');
			};
			composer.setSearchMode(!initialSearch);
			assertPreserved();
			composer.searchButton.focus();
			composer.searchButton.click();
			assert.equal(composer.isSearching(), initialSearch);
			assertPreserved();
			composer.setSearchMode(true);
			press('Escape', { shiftKey: true });
			assert.equal(composer.isSearching(), false);
			assertPreserved();
		}
	}
});

test('search/post transitions retain undo history and prevent search text from being posted', t => {
	const h = harness(t);
	const composer = new SoliloquyComposer(h.app, h.root, h.owner, { onPost() {}, onSearchChange() {} });
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, {}));
	panel.composer = composer;
	let posts = 0;
	panel.submit = async () => { posts++; };
	composer.input.value = 'alpha beta';
	composer.setSearchMode(false);
	press('Escape'); press('d'); press('w');
	assert.equal(composer.input.value, 'beta');
	composer.setSearchMode(true);
	assert.equal(panel.submitFromShortcut(composer.input.view.contentDOM), false);
	assert.equal(posts, 0);
	composer.setSearchMode(false);
	press('u');
	assert.equal(composer.input.value, 'alpha beta');
	assert.equal(panel.submitFromShortcut(composer.input.view.contentDOM), true);
	assert.equal(posts, 1);
});

test('a post save finishing after switching to search keeps the current query and focus', async t => {
	const h = harness(t);
	const composer = new SoliloquyComposer(h.app, h.root, h.owner, { onPost() {}, onSearchChange() {} });
	let finishSave;
	const service = { addPost: () => new Promise(resolve => { finishSave = resolve; }) };
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, service));
	panel.composer = composer;
	panel.refreshTimeline = async () => {};
	composer.input.value = 'A submitted post';
	composer.setSearchMode(false);
	const save = panel.submit();
	composer.setSearchMode(true);
	composer.input.value = 'New query';
	h.root.focus();
	finishSave();
	await save;
	assert.equal(composer.isSearching(), true);
	assert.equal(composer.getSearchQuery(), 'new query');
	assert.equal(document.activeElement, h.root);
});

test('Ctrl+Enter routes real editor descendants to post, edit, and reply actions', t => {
	const h = harness(t);
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, {}));
	const post = { blockId: 'test' };
	const calls = [];
	panel.submit = async () => { calls.push(['post']); };
	panel.inlineEditor.save = async () => {
		const draft = panel.inlineEditor.active;
		calls.push(draft.kind === 'edit'
			? ['edit', draft.input.value]
			: ['reply', draft.input.value, draft.stayOnTimeline]);
	};
	h.actions.submit = target => panel.submitFromShortcut(target);
	for (const field of ['post', 'edit', 'reply']) {
		const input = h.create();
		if (field === 'post') panel.composer = { input, isSearching: () => false };
		if (field === 'edit') panel.inlineEditor.active = { kind: 'edit', input, post };
		if (field === 'reply') panel.inlineEditor.active = { kind: 'reply', post, input, stayOnTimeline: true };
		input.focus();
		press('Enter', { ctrlKey: true });
		press('Escape');
		press('Enter', { ctrlKey: true });
		assert.equal(input.value, 'alpha beta\nsecond line');
		input.view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
		press('Enter', { ctrlKey: true, isComposing: true });
		assert.equal(calls.filter(call => call[0] === field).length, 2);
		input.view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
	}
	assert.deepEqual(calls.at(-1), ['reply', 'alpha beta\nsecond line', true]);
});

test('IME and held escape keys never leave the input or trigger the host action', t => {
	const h = harness(t);
	const input = h.create();
	input.focus();
	for (const shiftKey of [false, true]) {
		press('Escape', { shiftKey, isComposing: true });
		press('Escape', { shiftKey, repeat: true });
		assert.equal(document.activeElement, input.view.contentDOM);
	}
	assert.equal(h.exits(), 0);
});

async function panelHarness(t) {
	const h = harness(t, false);
	const posts = ['first', 'second'].map(blockId => ({
		blockId, content: `Saved ${blockId}`, date: '2026-09-07', time: '12:00',
		file: { path: 'daily.md' }, lineStart: 0, lineEnd: 2,
	}));
	const listeners = new Set();
	const service = {
		getTimeline: async () => timelineOf(posts.map(post => ({ ...post }))),
		onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
		updatePost: async (post, content) => ({ ...post, content }), addPost: async () => {}, addReply: async post => post,
	};
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, service));
	h.actions.submit = target => panel.submitFromShortcut(target);
	h.actions.focus = target => panel.focus(target);
	await panel.mount();
	const card = id => h.root.querySelector(`[data-post-key="${id}"]`);
	const edit = id => card(id).querySelector('.soliloquy-edit-button').click();
	const reply = id => card(id).querySelector('.soliloquy-reply-button').click();
	const notifyChange = () => { for (const listener of listeners) listener(); };
	return { ...h, panel, service, posts, card, edit, reply, listeners, notifyChange };
}

function timelineOf(posts) {
	return { posts, index: new TimelineIndex(posts) };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('switching between edits and replies cancels the old field without removing or refocusing the new field', async t => {
	const h = await panelHarness(t);
	h.edit('first');
	const first = h.panel.inlineEditor.active.input;
	first.value = 'Discard me';
	h.edit('second');
	const second = h.panel.inlineEditor.active.input;
	second.value = 'Second draft';
	await settle();
	assert.equal(first.view.destroyed, true);
	assert.equal(h.card('first').querySelector('.soliloquy-post-content').textContent, 'Saved first');
	assert.equal(h.root.querySelectorAll('.soliloquy-edit-input').length, 1);
	assert.equal(second.value, 'Second draft');
	assert.equal(document.activeElement, second.view.contentDOM);
	h.reply('first');
	const reply = h.panel.inlineEditor.active.input;
	await settle();
	assert.equal(second.view.destroyed, true);
	assert.equal(h.panel.inlineEditor.active.kind, 'reply');
	assert.equal(document.activeElement, reply.view.contentDOM);
	h.edit('second');
	await settle();
	assert.equal(reply.view.destroyed, true);
	assert.equal(h.panel.inlineEditor.active.kind, 'edit');
	assert.equal(h.root.querySelectorAll('.soliloquy-edit-input').length, 1);
});

test('another text field cancels an edit or reply while buttons, timeline and the same Vim prompt keep it', async t => {
	const h = await panelHarness(t);
	for (const kind of ['edit', 'reply']) {
		for (const destination of ['composer', 'search', 'note']) {
			h[kind]('first');
			const draft = h.panel.inlineEditor.active;
			draft.input.value = 'Draft';
			draft.button.focus();
			assert.equal(draft.input.view.destroyed, false);
			h.root.focus();
			assert.equal(draft.input.view.destroyed, false);
			const prompt = draft.input.element.createEl('input');
			prompt.focus();
			assert.equal(draft.input.view.destroyed, false);
			let target;
			if (destination === 'note') {
				target = document.body.createDiv({ attr: { contenteditable: 'true' } });
				target.focus();
			} else {
				h.panel.focus(destination === 'search' ? 'search' : 'post');
				target = h.panel.composer.input.view.contentDOM;
			}
			assert.equal(draft.input.view.destroyed, true);
			await settle();
			assert.equal(h.panel.inlineEditor.active, undefined);
			assert.equal(document.activeElement, target);
			if (destination === 'note') target.remove();
		}
	}
});

test('slow post/edit/reply saves reject repeated clicks and shortcuts; failures allow retry', async t => {
	const h = await panelHarness(t);
	const loggedErrors = [];
	const originalError = console.error;
	console.error = (...args) => loggedErrors.push(args);
	t.after(() => { console.error = originalError; });
	for (const kind of ['post', 'edit', 'reply']) {
		let finish;
		let fail;
		let calls = 0;
		const method = kind === 'post' ? 'addPost' : kind === 'edit' ? 'updatePost' : 'addReply';
		h.service[method] = post => { calls++; return new Promise((resolve, reject) => { finish = () => resolve(post); fail = reject; }); };
		if (kind === 'post') h.panel.focus('post');
		else h[kind]('first');
		const input = kind === 'post' ? h.panel.composer.input : h.panel.inlineEditor.active.input;
		const button = kind === 'post' ? h.root.querySelector('.soliloquy-post-button') : h.panel.inlineEditor.active.button;
		input.value = 'Submit once';
		button.click();
		button.click();
		input.focus();
		press('Enter', { ctrlKey: true });
		press('Enter', { ctrlKey: true, repeat: true });
		assert.equal(calls, 1, kind);
		assert.equal(button.disabled, true, kind);
		fail(new Error('Expected write failure'));
		await settle();
		assert.equal(input.value, 'Submit once', kind);
		assert.equal(button.disabled, false, kind);
		button.click();
		assert.equal(calls, 2, kind);
		finish();
		await settle();
	}
	assert.equal(loggedErrors.length, 3);
});

test('a completed save cannot close a newer edit or reply after focus cancelled its original field', async t => {
	const h = await panelHarness(t);
	for (const kind of ['edit', 'reply']) {
		let finish;
		h.service[kind === 'edit' ? 'updatePost' : 'addReply'] = post => new Promise(resolve => { finish = () => resolve(post); });
		h[kind]('first');
		const original = h.panel.inlineEditor.active;
		original.input.value = 'Sent';
		original.button.click();
		h.edit('second');
		const current = h.panel.inlineEditor.active;
		current.input.value = 'New draft';
		finish();
		await settle();
		assert.equal(original.input.view.destroyed, true);
		assert.equal(h.panel.inlineEditor.active, current);
		assert.equal(current.input.value, 'New draft');
		assert.equal(document.activeElement, current.input.view.contentDOM);
		h.panel.focus('post');
		await settle();
	}
});

test('rendered task checkboxes use source offsets and reject embedded or unmappable changes', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	MarkdownRenderer.render = async (_app, markdown, content) => {
		content.createEl('pre', { text: '- [ ] example' });
		content.createDiv({ cls: 'internal-embed' }).createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } });
		content.createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } }).checked = markdown.includes('[x] Actual');
	};
	const changes = [];
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async (...args) => { changes.push(args); },
	});
	const content = '```md\n- [ ] Example\n```\n- [ ] Actual';
	const post = { content, date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } };
	await renderer.render(post, h.root);
	const [embedded, actual] = h.root.querySelectorAll('input');
	embedded.dispatchEvent(new window.Event('change', { bubbles: true }));
	assert.equal(changes.length, 0);
	actual.checked = true;
	actual.dispatchEvent(new window.Event('change', { bubbles: true }));
	await settle();
	assert.deepEqual(changes.map(args => args.slice(0, 3)), [[post, { markerOffset: content.indexOf('[ ] Actual') + 1 }, true]]);
	await renderer.render({ ...post, content: '```md\n- [ ] Example\n```' }, h.root);
	const unmappable = h.root.querySelectorAll('input')[3];
	unmappable.click();
	await settle();
	assert.equal(unmappable.checked, false);
	assert.equal(changes.length, 1);
});

test('text entered while a save is pending stays in the current field', async t => {
	const h = await panelHarness(t);
	for (const kind of ['post', 'edit', 'reply']) {
		let finish;
		h.service[kind === 'post' ? 'addPost' : kind === 'edit' ? 'updatePost' : 'addReply'] = post => new Promise(resolve => { finish = () => resolve(post); });
		if (kind === 'post') h.panel.focus('post');
		else h[kind]('first');
		const input = kind === 'post' ? h.panel.composer.input : h.panel.inlineEditor.active.input;
		input.value = 'Submitted text';
		input.focus();
		press('Enter', { ctrlKey: true });
		input.value = 'Text entered during save';
		finish();
		await settle();
		assert.equal(input.view.destroyed, false, kind);
		assert.equal(input.value, 'Text entered during save', kind);
		assert.equal(document.activeElement, input.view.contentDOM, kind);
		h.panel.focus('post');
		await settle();
	}
});

test('an edit or reply kept open by newer text saves again against the post its save returned', async t => {
	const h = await panelHarness(t);
	for (const kind of ['edit', 'reply']) {
		const received = [];
		const returned = [];
		let finish;
		h.service[kind === 'edit' ? 'updatePost' : 'addReply'] = async (post, content) => {
			received.push(post);
			await new Promise(resolve => { finish = resolve; });
			// The service returns a new post, e.g. with an assigned ID and new lines.
			const saved = { ...post, content: kind === 'edit' ? content : post.content, blockId: `${kind}-id`, lineStart: 9 };
			returned.push(saved);
			return saved;
		};
		h[kind]('first');
		const draft = h.panel.inlineEditor.active;
		const sourcePost = draft.post;
		draft.input.value = 'First save';
		draft.input.focus();
		press('Enter', { ctrlKey: true });
		draft.input.value = 'Second save';
		finish();
		await settle();
		assert.equal(h.panel.inlineEditor.active, draft, kind);
		assert.equal(draft.post, returned[0], kind);
		press('Enter', { ctrlKey: true });
		finish();
		await settle();
		assert.equal(received[0], sourcePost, kind);
		assert.equal(received[1], returned[0], kind);
		assert.equal(sourcePost.blockId, 'first', kind);
		assert.equal(sourcePost.content, 'Saved first', kind);
		assert.equal(h.panel.inlineEditor.active, undefined, kind);
	}
});

test('a slow post save does not steal focus from the note editor', async t => {
	const h = await panelHarness(t);
	let finish;
	h.service.addPost = () => new Promise(resolve => { finish = resolve; });
	h.panel.focus('post');
	h.panel.composer.input.value = 'Sent';
	press('Enter', { ctrlKey: true });
	const note = document.body.createDiv({ attr: { contenteditable: 'true' } });
	t.after(() => note.remove());
	note.focus();
	finish();
	await settle();
	assert.equal(document.activeElement, note);
});

test('focusing an input in another display cancels the first display draft', async t => {
	const first = await panelHarness(t);
	const second = await panelHarness(t);
	first.reply('first');
	const oldInput = first.panel.inlineEditor.active.input;
	second.edit('second');
	const newInput = second.panel.inlineEditor.active.input;
	await settle();
	assert.equal(oldInput.view.destroyed, true);
	assert.equal(newInput.view.destroyed, false);
	assert.equal(document.activeElement, newInput.view.contentDOM);
});

test('refreshing the timeline updates the displayed statistics once', async t => {
	const h = await panelHarness(t);
	const updates = [];
	const composer = h.panel.composer;
	const updateStats = composer.updateStats.bind(composer);
	composer.updateStats = (posts, hits) => {
		updates.push({ total: posts.length, hits });
		updateStats(posts, hits);
	};
	await h.panel.refreshTimeline();
	assert.deepEqual(updates, [{ total: 2, hits: 2 }]);
	assert.equal(h.root.querySelector('[aria-label="Total: 2"]').textContent, '2');
});

test('an edit or reply save finishing after unload cannot refresh, navigate, or refocus', async t => {
	for (const kind of ['edit', 'reply']) {
		const h = await panelHarness(t);
		let finish;
		h.service[kind === 'edit' ? 'updatePost' : 'addReply'] = post => new Promise(resolve => { finish = () => resolve(post); });
		h[kind]('first');
		const draft = h.panel.inlineEditor.active;
		draft.input.value = 'Sent before closing';
		draft.button.click();
		const callbacks = [];
		h.panel.inlineEditor.callbacks = {
			refresh: async () => { callbacks.push('refresh'); },
			focusTimeline: () => { callbacks.push('focus'); },
			onReplySaved: () => { callbacks.push('navigate'); },
		};
		h.panel.unload();
		finish();
		await settle();
		assert.equal(draft.input.view.destroyed, true, kind);
		assert.deepEqual(callbacks, [], kind);
	}
});

test('Ctrl+Enter saves an edit and restores keyboard focus to that post', async t => {
	const h = await panelHarness(t);
	h.edit('second');
	h.panel.inlineEditor.active.input.value = 'Updated';
	press('Enter', { ctrlKey: true });
	await settle();
	assert.equal(h.panel.inlineEditor.isOpen(), false);
	assert.equal(document.activeElement, h.card('second'));
	press('ArrowUp');
	assert.equal(document.activeElement, h.card('first'));
});

test('edit save focus restoration leaves a new text field focused during refresh', async t => {
	const h = await panelHarness(t);
	let finishRead;
	h.service.getTimeline = () => new Promise(resolve => { finishRead = posts => resolve(timelineOf(posts)); });
	h.edit('first');
	press('Enter', { ctrlKey: true });
	await settle();
	const note = document.body.createDiv({ attr: { contenteditable: 'true' } });
	t.after(() => note.remove());
	note.focus();
	finishRead(h.posts);
	await settle();
	assert.equal(document.activeElement, note);
});

test('a stale task card cannot update another task after a pending edit completes', async t => {
	const h = await panelHarness(t);
	const originalRender = MarkdownRenderer.render;
	const originalError = console.error;
	const errors = [];
	console.error = (...args) => errors.push(args);
	t.after(() => { MarkdownRenderer.render = originalRender; console.error = originalError; });
	MarkdownRenderer.render = async (_app, markdown, element) => {
		for (const line of markdown.split('\n')) {
			const label = element.createEl('label', { text: line.replace(/^- \[[ x]\] /, '') });
			if (/^- \[[ x]\]/.test(line)) label.createEl('input', {
				cls: 'task-list-item-checkbox', attr: { type: 'checkbox' },
			}).checked = line.includes('[x]');
		}
	};
	let persisted = '## soliloquy\n- 12:00 ^first\n\t- [ ] AAA\n\t- [ ] BBB';
	const service = new TimelineService({ vault: { process: async (_file, update) => {
		persisted = update(persisted);
	} } }, () => ({ sectionHeading: 'soliloquy' }));
	h.posts[0].content = '- [ ] AAA\n- [ ] BBB';
	await h.panel.refreshTimeline();
	let finishSave;
	h.service.updatePost = async (post, content) => {
		await new Promise(resolve => { finishSave = resolve; });
		const saved = await service.updatePost(post, content);
		h.posts[0].content = saved.content;
		return saved;
	};
	h.service.updateTask = (...args) => service.updateTask(...args);
	h.edit('first');
	h.panel.inlineEditor.active.input.value = '- [ ] BBB\n- [ ] AAA';
	press('Enter', { ctrlKey: true });
	h.edit('second');
	const otherDraft = h.panel.inlineEditor.active;
	otherDraft.input.value = 'Keep this draft';
	await settle();
	finishSave();
	await settle();
	const checkbox = h.card('first').querySelector('input');
	assert.equal(checkbox.parentElement.textContent, 'AAA');
	checkbox.checked = true;
	checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
	await settle();
	assert.equal(persisted, '## soliloquy\n- 12:00 ^first\n\t- [ ] BBB\n\t- [ ] AAA');
	assert.equal(checkbox.checked, false);
	assert.equal(checkbox.disabled, false);
	assert.equal(errors.length, 1);
	assert.equal(h.panel.inlineEditor.active, otherDraft);
	assert.equal(otherDraft.input.value, 'Keep this draft');
});

test('task changes save the rendered post, then the post each save returned', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	MarkdownRenderer.render = async (_app, markdown, element) => {
		element.createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } }).checked = markdown.includes('[x]');
	};
	const changes = [];
	const savedPosts = [];
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async (post, task, checked, saved) => {
			changes.push(post);
			const updated = { ...post, content: `- [${checked ? 'x' : ' '}] Original` };
			savedPosts.push(updated);
			saved(updated);
		},
	});
	const post = { content: '- [ ] Original', date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } };
	await renderer.render(post, h.root);
	const checkbox = h.root.querySelector('input');
	checkbox.click();
	await settle();
	checkbox.click();
	await settle();
	assert.equal(changes[0], post);
	assert.equal(changes[1], savedPosts[0]);
	assert.equal(post.content, '- [ ] Original');
});

test('Obsidian custom states and hidden comment tasks keep visible checkboxes usable', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	// The two visible inputs emitted by Obsidian for this Markdown.
	MarkdownRenderer.render = async (_app, markdown, element) => {
		for (const line of markdown.split('\n').slice(-2)) {
			const label = element.createEl('li', { text: line.slice(6) });
			label.createEl('input', {
				cls: 'task-list-item-checkbox', attr: { type: 'checkbox' },
			}).checked = line[3] !== ' ';
		}
	};
	const changes = [];
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async (post, task, checked, saved) => {
			changes.push([post, task, checked]);
			saved({ ...post, content: post.content.slice(0, task.markerOffset) + (checked ? 'x' : ' ') + post.content.slice(task.markerOffset + 1) });
		},
	});
	const content = '%%\n- [ ] Hidden\n%%\n\n- [ ] Todo\n- [-] Cancelled';
	const post = { content, date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } };
	await renderer.render(post, h.root);
	const inputs = [...h.root.querySelectorAll('input')];
	assert.deepEqual(inputs.map(input => input.disabled), [false, false]);
	for (const input of inputs) {
		input.checked = !input.checked;
		input.dispatchEvent(new window.Event('change', { bubbles: true }));
		assert.deepEqual(inputs.map(input => input.disabled), [true, true]);
		const count = changes.length;
		inputs[1].click();
		assert.equal(changes.length, count, 'Other task changes wait for the current save');
		await settle();
		assert.deepEqual(inputs.map(input => input.disabled), [false, false]);
	}
	assert.deepEqual(changes.map(([, task]) => task.markerOffset), [content.indexOf('[ ] Todo') + 1, content.indexOf('[-] Cancelled') + 1]);
});

function renderTask(element, text, status = ' ') {
	const item = element.createEl('li');
	const checkbox = item.createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } });
	checkbox.checked = status !== ' ';
	item.createSpan({ text });
	return checkbox;
}

async function taskPanelHarness(t, content = '- [ ] Task', renderMarkdown) {
	const h = await panelHarness(t);
	const originalRender = MarkdownRenderer.render;
	const originalError = console.error;
	const errors = [];
	t.after(() => { MarkdownRenderer.render = originalRender; console.error = originalError; });
	console.error = (...args) => errors.push(args);
	MarkdownRenderer.render = renderMarkdown ?? (async (_app, markdown, element) => {
		for (const line of markdown.split('\n')) {
			if (/^- \[.\] /.test(line)) renderTask(element, line.slice(6), line[3]);
			else element.createSpan({ text: line });
		}
	});
	let persisted = '## soliloquy\n- 12:00 ^first\n' + content.split('\n').map(line => '\t' + line).join('\n');
	const actualService = new TimelineService({ vault: { process: async (_file, update) => {
		persisted = update(persisted);
	} } }, () => ({ sectionHeading: 'soliloquy' }));
	h.posts[0].content = content;
	h.service.updateTask = (...args) => actualService.updateTask(...args);
	h.service.updatePost = (...args) => actualService.updatePost(...args);
	await h.panel.refreshTimeline();
	return { ...h, actualService, errors, persisted: () => persisted };
}

test('a saved checkbox updates the next edit while another draft defers refresh', async t => {
	const h = await taskPanelHarness(t);
	h.edit('second');
	h.card('first').querySelector('input').click();
	await settle();
	assert.match(h.persisted(), /\[x\] Task/);
	h.edit('first');
	const draft = h.panel.inlineEditor.active;
	assert.equal(draft.input.value, '- [x] Task');
	draft.input.value += ' updated';
	press('Enter', { ctrlKey: true });
	await settle();
	assert.match(h.persisted(), /\[x\] Task updated/);
	assert.deepEqual(h.errors, []);
});

test('an edit opened during a task save keeps its snapshot and cannot undo that save', async t => {
	const h = await taskPanelHarness(t);
	let finishSave;
	h.service.updateTask = async (...args) => {
		await new Promise(resolve => { finishSave = resolve; });
		return h.actualService.updateTask(...args);
	};
	h.card('first').querySelector('input').click();
	await settle();
	h.edit('first');
	const draft = h.panel.inlineEditor.active;
	draft.input.value += ' edited';
	finishSave();
	await settle();
	assert.match(h.persisted(), /\[x\] Task/);
	assert.equal(draft.post.content, '- [ ] Task');
	assert.equal(draft.input.value, '- [ ] Task edited');
	press('Enter', { ctrlKey: true });
	await settle();
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0][1].message, /post changed/);
	assert.match(h.persisted(), /\[x\] Task$/);
});

test('a completed task save replaces the card post and leaves the shared snapshot unchanged', async t => {
	const h = await taskPanelHarness(t);
	h.edit('second');
	const timeline = h.panel.loadedTimeline;
	const sourcePost = h.panel.loadedTimeline.posts[0];
	let publish;
	h.service.updateTask = async (...args) => {
		const saved = await h.actualService.updateTask(...args);
		await new Promise(resolve => { publish = resolve; });
		return saved;
	};
	h.card('first').querySelector('input').click();
	await settle();
	publish();
	await settle();
	assert.equal(h.panel.loadedTimeline, timeline);
	assert.equal(h.panel.loadedTimeline.posts[0], sourcePost);
	assert.equal(sourcePost.content, '- [ ] Task');
	assert.equal(timeline.index.getSearchText(sourcePost).includes('[ ] task'), true);
	h.edit('first');
	assert.equal(h.panel.inlineEditor.active.input.value, '- [x] Task');
});

test('task verification rejects a same-count mismatch even when both tasks have the same label', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	// Simulate a renderer extension hiding the source task and adding an unrelated one.
	MarkdownRenderer.render = async (_app, _markdown, element) => { renderTask(element, 'Same label'); };
	let writes = 0;
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async () => { writes++; },
	});
	await renderer.render({ content: '- [ ] Same label', date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } }, h.root);
	const checkbox = h.root.querySelector('input');
	checkbox.click();
	await settle();
	assert.equal(writes, 0);
	assert.equal(checkbox.checked, false);
	assert.equal(checkbox.disabled, false);
});

test('the tabbed quote fixture only updates the task Obsidian actually displays', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	// Matches the installed Obsidian renderer: first %% is code, second %% hides B.
	MarkdownRenderer.render = async (_app, markdown, element) => {
		element.createEl('pre', { text: '%%' });
		renderTask(element, 'A', markdown[markdown.indexOf('[') + 1]);
	};
	const content = '> \t%%\n> - [ ] A\n> %%\n> - [ ] B';
	let persisted = '## soliloquy\n- 12:00 ^first\n' + content.split('\n').map(line => '\t' + line).join('\n');
	const service = new TimelineService({ vault: { process: async (_file, update) => { persisted = update(persisted); } } }, () => ({ sectionHeading: 'soliloquy' }));
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async (post, task, checked, saved) => { saved(await service.updateTask(post, task, checked)); },
	});
	await renderer.render({ blockId: 'first', content, date: '2026-09-07', time: '12:00', file: { path: 'daily.md' }, lineStart: 1, lineEnd: 6 }, h.root);
	h.root.querySelector('input').click();
	await settle();
	assert.match(persisted, /\[x\] A/);
	assert.match(persisted, /\[ \] B/);
});

for (const prefix of ['-    \t%%\n    ', '1. \t%%\n       ']) {
	test(`renderer verification recovers tasks with Obsidian list indentation ${JSON.stringify(prefix)}`, async t => {
		const content = `~~~\n- [ ] example\n~~~\n\n${prefix}- [ ] T0\n\n- [ ] T1`;
		const h = await taskPanelHarness(t, content, async (_app, markdown, element) => {
			// Obsidian displays both tasks after a tab-padded list comment marker.
			element.createEl('pre', { text: '- [ ] example' });
			for (const label of ['T0', 'T1']) {
				const status = /\[([^\r\n])\] T[01]/g;
				const match = [...markdown.matchAll(status)].find(match => match[0].endsWith(label));
				if (match) renderTask(element, label, match[1]);
			}
		});
		h.edit('second'); // Keep this card visible so both saves use its updated snapshot.
		let expected = h.persisted();
		const checkboxes = [...h.card('first').querySelectorAll('input')];
		assert.deepEqual(checkboxes.map(checkbox => checkbox.disabled), [false, false]);
		for (const [index, checkbox] of checkboxes.entries()) {
			checkbox.click();
			await settle();
			expected = expected.replace(`[ ] T${index}`, `[x] T${index}`);
			assert.equal(h.persisted(), expected);
			assert.equal(checkbox.checked, true);
		}
		assert.deepEqual(h.errors, []);
	});
}

test('a misaligned source candidate is rejected and the renderer-verified task is written', async t => {
	// The line scan finds A, B, Q, H; Obsidian displays A, N, B, Q. The counts
	// match, so the i-th candidate is offered first and must fail verification.
	const content = '- [ ] A\n %%\n -\n   - [ ] N\n- [ ] B\n\n> - [ ] Q\n  %%\n- [ ] H';
	const h = await taskPanelHarness(t, content, async (_app, markdown, element) => {
		for (const label of ['A', 'N', 'B', 'Q']) {
			renderTask(element, label, markdown[markdown.indexOf(`] ${label}`) - 1]);
		}
	});
	h.edit('second'); // Keep this card visible so each save uses its updated snapshot.
	let expected = h.persisted();
	const checkboxes = [...h.card('first').querySelectorAll('input')];
	for (const [index, label] of ['N', 'B', 'Q', 'A'].entries()) {
		const checkbox = checkboxes[['A', 'N', 'B', 'Q'].indexOf(label)];
		checkbox.click();
		await settle();
		expected = expected.replace(`[ ] ${label}`, `[x] ${label}`);
		assert.equal(h.persisted(), expected, `${index}: ${label}`);
		assert.equal(checkbox.checked, true);
	}
	assert.match(h.persisted(), /\[ \] H/);
	assert.deepEqual(h.errors, []);
});

test('closing a card during task verification prevents writing and releases the probe component', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	let finishProbe;
	let renderCount = 0;
	let unloadCount = 0;
	MarkdownRenderer.render = async (_app, markdown, element, _path, component) => {
		if (renderCount++) {
			component.register(() => { unloadCount++; });
			await new Promise(resolve => { finishProbe = resolve; });
		}
		renderTask(element, 'Task', markdown[3]);
	};
	let writes = 0;
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async () => { writes++; },
	});
	await renderer.render({ content: '- [ ] Task', date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } }, h.root);
	h.root.querySelector('input').click();
	renderer.clear();
	finishProbe();
	await settle();
	assert.equal(writes, 0);
	assert.equal(unloadCount, 1);
});

test('a refresh error after task persistence keeps the saved checkbox state', async t => {
	const h = await taskPanelHarness(t);
	h.service.getTimeline = async () => { throw new Error('Read failed'); };
	const checkbox = h.card('first').querySelector('input');
	checkbox.click();
	await settle();
	assert.match(h.persisted(), /\[x\] Task/);
	assert.equal(checkbox.checked, true);
	assert.equal(checkbox.disabled, false);
	assert.equal(h.errors.length, 1);
	assert.match(h.errors[0][0], /refresh after updating/);
});

test('ID assignment during a task save still publishes the matching saved post', async t => {
	const h = await taskPanelHarness(t);
	delete h.posts[0].blockId;
	await h.panel.refreshTimeline();
	const sourcePost = h.panel.loadedTimeline.posts[0];
	let publish;
	h.service.updateTask = async (...args) => {
		await new Promise(resolve => { publish = resolve; });
		return h.actualService.updateTask(...args);
	};
	h.edit('second');
	h.root.querySelector('input.task-list-item-checkbox').click();
	await settle();
	// The reply path's ensureBlockId adopts the current ID without changing the body.
	const identified = await h.actualService.ensureBlockId(sourcePost);
	assert.equal(identified.blockId, 'first');
	assert.equal(sourcePost.blockId, undefined);
	publish();
	await settle();
	assert.equal(sourcePost.content, '- [ ] Task');
	const first = h.root.querySelector('.soliloquy-post');
	first.querySelector('.soliloquy-edit-button').click();
	assert.equal(h.panel.inlineEditor.active.input.value, '- [x] Task');
});

test('drafts closed by another field are kept for their post until explicitly cancelled', async t => {
	const h = await panelHarness(t);
	for (const kind of ['edit', 'reply']) {
		h[kind]('first');
		h.panel.inlineEditor.active.input.value = `Kept ${kind}`;
		h.panel.focus('post');
		await settle();
		assert.equal(h.panel.inlineEditor.active, undefined, kind);
		h[kind]('second');
		assert.equal(h.panel.inlineEditor.active.input.value, kind === 'edit' ? 'Saved second' : '', kind);
		h.panel.focus('post');
		await settle();
		h[kind]('first');
		await settle();
		assert.equal(h.panel.inlineEditor.active.input.value, `Kept ${kind}`, kind);
		h.root.querySelector(`[aria-label="Cancel ${kind}"]`).click();
		await settle();
		h[kind]('first');
		await settle();
		assert.equal(h.panel.inlineEditor.active.input.value, kind === 'edit' ? 'Saved first' : '', kind);
		h.root.querySelector(`[aria-label="Cancel ${kind}"]`).click();
		await settle();
	}
});

test('an edit rejected because the post changed shows the current post and keeps the text', async t => {
	const h = await panelHarness(t);
	const originalError = console.error;
	console.error = () => {};
	t.after(() => { console.error = originalError; });
	h.service.updatePost = async () => { throw new PostChangedError('The post changed before it could be edited.'); };
	h.edit('first');
	const draft = h.panel.inlineEditor.active;
	draft.input.value = 'My edit';
	h.posts[0].content = 'Changed elsewhere';
	draft.button.click();
	await settle();
	await settle();
	assert.equal(h.panel.inlineEditor.active, undefined);
	assert.equal(h.card('first').querySelector('.soliloquy-post-content').textContent, 'Changed elsewhere');
	h.edit('first');
	await settle();
	assert.equal(h.panel.inlineEditor.active.input.value, 'My edit');
});

test.after(() => dom.window.close());

test('service change notifications refresh the panel without discarding drafts', async t => {
	const h = await panelHarness(t);
	assert.equal(h.listeners.size, 1);
	h.posts[0].content = 'Changed by sync';
	h.notifyChange();
	await settle();
	assert.equal(h.card('first').querySelector('.soliloquy-post-content').textContent, 'Changed by sync');

	h.edit('second');
	const draft = h.panel.inlineEditor.active;
	draft.input.value = 'Unsaved edit';
	h.posts[0].content = 'Changed again';
	h.notifyChange();
	await settle();
	assert.equal(h.panel.inlineEditor.active, draft);
	assert.equal(draft.input.value, 'Unsaved edit');
	assert.equal(h.card('first').querySelector('.soliloquy-post-content').textContent, 'Changed by sync');

	h.panel.unload();
	assert.equal(h.listeners.size, 0);
});

test('a save renders its display once although the service also announces it', async t => {
	const h = await panelHarness(t);
	let renders = 0;
	const render = h.panel.list.render.bind(h.panel.list);
	h.panel.list.render = (...args) => { renders++; return render(...args); };
	h.service.updatePost = async (post, content) => {
		h.posts.find(item => item.blockId === post.blockId).content = content;
		h.notifyChange(); // The real service notifies every display after writing.
		return { ...post, content };
	};
	h.edit('second');
	h.panel.inlineEditor.active.input.value = 'Saved once';
	press('Enter', { ctrlKey: true });
	await settle();
	assert.equal(h.card('second').querySelector('.soliloquy-post-content').textContent, 'Saved once');
	assert.equal(renders, 1);
});

test('a superseded render pass stops without appending stale cards', async t => {
	const h = await panelHarness(t);
	const posts = Array.from({ length: 20 }, (_, index) => ({
		blockId: `post-${index}`, content: `Post ${index}`, date: '2026-09-07', time: '12:00',
		file: { path: 'daily.md' }, lineStart: index * 2, lineEnd: index * 2 + 2,
	}));
	h.service.getTimeline = async () => timelineOf(posts.map(post => ({ ...post })));
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	const held = [];
	MarkdownRenderer.render = (_app, markdown, element) => new Promise(resolve => {
		held.push(() => { element.textContent = markdown; resolve(); });
	});
	const stale = h.panel.refreshTimeline();
	await settle();
	assert.equal(held.length, 8); // The first batch waits for Markdown.
	MarkdownRenderer.render = originalRender;
	await h.panel.refreshTimeline();
	for (const finish of held) finish();
	await stale;
	await settle();
	const keys = [...h.root.querySelectorAll('.soliloquy-post[data-post-key]')].map(card => card.dataset.postKey);
	assert.deepEqual(keys, posts.map(post => post.blockId));
	assert.equal(h.root.querySelector('.soliloquy-timeline').getAttribute('aria-busy'), 'false');
});

test('a thread page survives refreshes and Back returns to the timeline', async t => {
	const h = await panelHarness(t);
	h.posts[1].replyToBlockId = 'first';
	await h.panel.refreshTimeline();
	const timelineEl = h.root.querySelector('.soliloquy-timeline');
	const keys = () => [...timelineEl.querySelectorAll('.soliloquy-post[data-post-key]')].map(card => card.dataset.postKey);
	h.card('first').click();
	await settle();
	assert.equal(timelineEl.getAttribute('role'), 'region');
	assert.equal(timelineEl.classList.contains('is-thread-page'), true);
	assert.deepEqual(keys(), ['first', 'second']);
	assert.equal(document.activeElement, h.card('first'));
	h.posts[1].content = 'Changed reply';
	h.notifyChange();
	await settle();
	assert.equal(timelineEl.getAttribute('role'), 'region');
	assert.equal(h.card('second').querySelector('.soliloquy-post-content').textContent, 'Changed reply');
	timelineEl.querySelector('.soliloquy-back-button').click();
	await settle();
	assert.equal(timelineEl.getAttribute('role'), 'feed');
	assert.equal(timelineEl.classList.contains('is-thread-page'), false);
	assert.deepEqual(keys(), ['first', 'second']);
	assert.equal(h.panel.thread.isOpen(), false);
});

/** Records failures that would otherwise be lost: console errors, notices, and unhandled rejections. */
function captureFailures(t) {
	const errors = [];
	const rejections = [];
	const originalError = console.error;
	const onRejection = reason => { rejections.push(reason); };
	console.error = (...args) => { errors.push(args); };
	process.on('unhandledRejection', onRejection);
	notices.length = 0;
	t.after(() => {
		console.error = originalError;
		process.off('unhandledRejection', onRejection);
	});
	return { errors, rejections };
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), 'Timed out waiting for the timeline');
}

test('a post that fails to render shows an error card while the other cards and Load older still render', async t => {
	const h = await panelHarness(t);
	const failures = captureFailures(t);
	const posts = Array.from({ length: 60 }, (_, index) => ({
		blockId: `post-${index}`, content: `Post ${index}`, date: '2026-09-07', time: '12:00',
		file: { path: 'daily.md' }, lineStart: index * 2, lineEnd: index * 2 + 2,
	}));
	h.service.getTimeline = async () => timelineOf(posts.map(post => ({ ...post })));
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	MarkdownRenderer.render = async (app, markdown, element, ...rest) => {
		if (markdown === 'Post 3' || markdown === 'Post 55') throw new Error('Render failed');
		return originalRender(app, markdown, element, ...rest);
	};
	const opened = [];
	h.app.workspace = {
		getLeaf: () => ({ openFile: async file => { opened.push(file.path); } }),
		getActiveViewOfType: () => null,
	};
	await h.panel.refreshTimeline();
	const timelineEl = h.root.querySelector('.soliloquy-timeline');
	const keys = () => [...timelineEl.querySelectorAll('.soliloquy-post[data-post-key]')].map(card => card.dataset.postKey);
	assert.deepEqual(keys(), posts.slice(0, 50).map(post => post.blockId));
	const errorCards = () => [...timelineEl.querySelectorAll('.soliloquy-post.is-render-error')];
	assert.deepEqual(errorCards().map(card => card.dataset.postKey), ['post-3']);
	assert.equal(errorCards()[0].querySelector('.soliloquy-post-error-message').textContent, 'Could not render this post.');
	assert.equal(h.card('post-4').querySelector('.soliloquy-post-content').textContent, 'Post 4');
	assert.equal(timelineEl.getAttribute('aria-busy'), 'false');
	assert.equal(failures.errors.length, 1);
	assert.match(failures.errors[0][0], /render the post/);

	errorCards()[0].querySelector('.soliloquy-post-error-open').click();
	await settle();
	assert.deepEqual(opened, ['daily.md']);

	const loadOlder = timelineEl.querySelector('.soliloquy-load-more button');
	assert.equal(loadOlder.textContent, 'Load 10 older posts');
	loadOlder.click();
	await waitFor(() => keys().length === 60);
	assert.deepEqual(keys(), posts.map(post => post.blockId));
	assert.deepEqual(errorCards().map(card => card.dataset.postKey), ['post-3', 'post-55']);
	assert.equal(h.card('post-59').querySelector('.soliloquy-post-content').textContent, 'Post 59');
	await settle();
	assert.deepEqual(failures.rejections, []);
	assert.deepEqual(notices, []);
});

test('a reply that fails to render keeps the rest of its thread and Back usable', async t => {
	const h = await panelHarness(t);
	const failures = captureFailures(t);
	h.posts[1].replyToBlockId = 'first';
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	MarkdownRenderer.render = async (app, markdown, element, ...rest) => {
		if (markdown === 'Saved second') throw new Error('Render failed');
		return originalRender(app, markdown, element, ...rest);
	};
	await h.panel.refreshTimeline();
	h.card('first').click();
	await settle();
	const timelineEl = h.root.querySelector('.soliloquy-timeline');
	assert.equal(timelineEl.classList.contains('is-thread-page'), true);
	assert.equal(h.card('first').querySelector('.soliloquy-post-content').textContent, 'Saved first');
	assert.equal(h.card('second').classList.contains('is-render-error'), true);
	timelineEl.querySelector('.soliloquy-back-button').click();
	await settle();
	assert.equal(timelineEl.classList.contains('is-thread-page'), false);
	assert.equal(h.panel.thread.isOpen(), false);
	assert.deepEqual(failures.rejections, []);
});

test('refresh and navigation failures are reported without unhandled rejections', async t => {
	const h = await panelHarness(t);
	const failures = captureFailures(t);
	h.app.workspace = {
		getLeaf: () => ({ openFile: async () => { throw new Error('Open failed'); } }),
		getActiveViewOfType: () => null,
	};
	// Opening a note is a user action: it is logged and explained.
	h.card('first').querySelector('.soliloquy-date-button').click();
	await settle();
	assert.deepEqual(notices, ['Could not open the daily note.']);

	// A background refresh is only logged.
	h.service.getTimeline = async () => { throw new Error('Read failed'); };
	h.notifyChange();
	await settle();
	assert.deepEqual(notices, ['Could not open the daily note.']);
	assert.equal(h.root.querySelector('.soliloquy-timeline').getAttribute('aria-busy'), 'false');

	// A refresh after closing a draft explains that it failed.
	h.edit('first');
	h.root.querySelector('[aria-label="Cancel edit"]').click();
	await settle();
	assert.deepEqual(notices, ['Could not open the daily note.', 'Could not refresh the timeline.']);
	await settle();
	assert.deepEqual(failures.rejections, []);
	assert.equal(failures.errors.length, 3);
});

test('on macOS, Cmd+Enter submits from real editors and the inputs name it', t => {
	Platform.isMacOS = true;
	t.after(() => { Platform.isMacOS = false; });
	const h = harness(t);
	const calls = [];
	const composer = new SoliloquyComposer(h.app, h.root, h.owner, { onPost() {}, onSearchChange() {} });
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, {}));
	panel.composer = composer;
	panel.submit = async () => { calls.push(composer.input.value); };
	h.actions.submit = target => panel.submitFromShortcut(target);
	const content = composer.input.view.contentDOM;
	assert.equal(h.root.querySelector('.cm-placeholder').textContent, '⌘ + Enter to post');
	assert.equal(content.getAttribute('aria-keyshortcuts'), 'Meta+Enter Shift+Escape');
	composer.input.value = 'alpha';
	composer.input.focus();
	assert.equal(press('Enter', { metaKey: true }).defaultPrevented, true);
	assert.deepEqual(calls, ['alpha']);
	assert.equal(composer.input.value, 'alpha');
	// Ctrl+Enter is not the macOS submit shortcut. (jsdom's CodeMirror is not
	// on macOS, so its own Mod-Enter binding may still handle the key.)
	press('Enter', { ctrlKey: true });
	assert.deepEqual(calls, ['alpha']);
});

function popoutWindow(t) {
	const popout = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true }).window;
	installDomHelpers(popout);
	popout.HTMLElement.prototype.scrollIntoView = () => {};
	t.after(() => popout.close());
	return popout;
}

test('an inline draft follows its display into a popout window', async t => {
	const h = await panelHarness(t);
	const popout = popoutWindow(t);
	h.reply('first');
	const draft = h.panel.inlineEditor.active.input;
	popout.document.body.appendChild(h.root);
	h.root.migrateWindow();
	const left = document.body.createEl('input', { attr: { type: 'text' } });
	t.after(() => left.remove());
	left.focus();
	await settle();
	assert.equal(draft.view.destroyed, false);
	const field = popout.document.body.createEl('input', { attr: { type: 'text' } });
	field.focus();
	await settle();
	assert.equal(draft.view.destroyed, true);
	assert.equal(h.panel.inlineEditor.active, undefined);
	// Closing the display removes the listener from the popout document.
	const removed = [];
	const removeEventListener = popout.document.removeEventListener;
	popout.document.removeEventListener = function(type, ...rest) {
		removed.push(type);
		return removeEventListener.call(this, type, ...rest);
	};
	h.owner.unload();
	assert.ok(removed.includes('focusin'));
});

test('frames, motion preferences, and search timers use the window that shows the display', async t => {
	const popout = popoutWindow(t);
	const frames = [];
	const timers = new Map();
	const cleared = [];
	popout.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
	popout.matchMedia = () => ({ matches: true });
	popout.setTimeout = (callback, delay) => { timers.set(timers.size + 1, { callback, delay }); return timers.size; };
	popout.clearTimeout = id => { cleared.push(id); };
	const root = popout.document.body.createDiv();
	t.after(() => root.remove());

	const frame = nextAnimationFrame(root);
	assert.equal(frames.length, 1);
	frames.shift()();
	await frame;

	const card = root.createDiv();
	card.tabIndex = -1;
	let scrolled;
	card.scrollIntoView = options => { scrolled = options; };
	new TimelineSurface(root, {}, {}).focusCard(card, true, 'nearest');
	assert.equal(frames.length, 1);
	frames.shift()();
	assert.deepEqual(scrolled, { behavior: 'auto', block: 'nearest' });

	const owner = new Component();
	const searches = [];
	const composer = new SoliloquyComposer({ vault: {} }, root, owner, {
		onPost() {}, onSearchChange: () => { searches.push(composer.getSearchQuery()); },
	});
	composer.setSearchMode(true, false);
	composer.input.value = 'tag';
	const searchTimers = () => [...timers].filter(([, timer]) => timer.delay === 200);
	assert.equal(searchTimers().length, 1);
	searchTimers()[0][1].callback();
	assert.deepEqual(searches, ['tag']);
	composer.input.value = 'tags';
	const [pending] = searchTimers().at(-1);
	assert.equal(searchTimers().length, 2);
	owner.unload();
	assert.ok(cleared.includes(pending));
	assert.deepEqual(searches, ['tag']);
});
