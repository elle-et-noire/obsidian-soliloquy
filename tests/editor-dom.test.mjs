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

const result = await build({
	stdin: { contents: `
		export { SoliloquyTextEditor } from './src/ui/text-editor';
		export { SoliloquyComposer } from './src/ui/composer';
		export { TimelinePanel } from './src/ui/timeline-panel';
		export { registerTimelineKeyboard } from './src/ui/timeline-keyboard';
		export { getCM } from '@replit/codemirror-vim';
	`, resolveDir: process.cwd() },
	bundle: true, format: 'esm', write: false,
	alias: { obsidian: './tests/editor-dom-harness.mjs' },
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Editor test bundle was not generated.');
const { SoliloquyTextEditor, SoliloquyComposer, TimelinePanel, registerTimelineKeyboard, getCM } = await import(
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
		key, keyCode: key === 'Escape' ? 27 : key === 'Enter' ? 13 : 0,
		bubbles: true, cancelable: true, ...options,
	});
	document.activeElement.dispatchEvent(event);
	return event;
}

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
	panel.saveEdit = async (post, value) => { calls.push(['edit', value]); };
	panel.saveReply = async (post, value, stay) => { calls.push(['reply', value, stay]); };
	h.actions.submit = target => panel.submitFromShortcut(target);
	for (const field of ['post', 'edit', 'reply']) {
		const input = h.create();
		if (field === 'post') panel.composer = { input, isSearching: () => false };
		if (field === 'edit') panel.editInputs.set(input, post);
		if (field === 'reply') panel.replying = { post, input, stayOnTimeline: true };
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

test('inline editors stay usable across cards and are destroyed when their UI is removed', t => {
	const h = harness(t);
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, {}));
	const post = { blockId: 'test', content: 'Saved post', date: '2026-09-07', time: '12:00' };
	const firstCard = h.root.createDiv();
	const secondCard = h.root.createDiv();
	panel.openEditor(firstCard, post);
	const first = [...panel.editInputs.keys()][0];
	first.value = 'First draft';
	panel.openEditor(secondCard, { ...post, blockId: 'second' });
	const second = [...panel.editInputs.keys()][1];
	assert.equal(panel.editInputs.size, 2);
	first.focus(); press('Escape'); press('d'); press('d');
	assert.equal(first.value, '');
	assert.equal(second.value, 'Saved post');
	panel.clearEditor();
	assert.equal(panel.editInputs.size, 0);
	assert.equal(first.view.destroyed, true);
	assert.equal(second.view.destroyed, true);
	const button = firstCard.createEl('button');
	panel.openInlineReply(firstCard, button, post, true);
	const reply = panel.replying.input;
	panel.closeInlineReply(false);
	assert.equal(reply.view.destroyed, true);
	assert.equal(panel.children.size, 0);
});

test.after(() => dom.window.close());
