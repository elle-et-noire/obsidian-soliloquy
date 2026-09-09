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
		export { PostCardRenderer } from './src/ui/post-card';
		export { MarkdownRenderer } from './tests/editor-dom-harness.mjs';
		export { registerTimelineKeyboard } from './src/ui/timeline-keyboard';
		export { getCM } from '@replit/codemirror-vim';
	`, resolveDir: process.cwd() },
	bundle: true, format: 'esm', write: false,
	alias: { obsidian: './tests/editor-dom-harness.mjs' },
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Editor test bundle was not generated.');
const { SoliloquyTextEditor, SoliloquyComposer, TimelinePanel, TimelineService, PostCardRenderer, MarkdownRenderer, registerTimelineKeyboard, getCM } = await import(
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
	const service = {
		getPosts: async () => posts.map(post => ({ ...post })),
		updatePost: async () => {}, addPost: async () => {}, addReply: async () => {},
	};
	const panel = h.owner.addChild(new TimelinePanel(h.app, h.root, service));
	h.actions.submit = target => panel.submitFromShortcut(target);
	h.actions.focus = target => panel.focus(target);
	await panel.mount();
	const card = id => h.root.querySelector(`[data-post-key="${id}"]`);
	const edit = id => card(id).querySelector('.soliloquy-edit-button').click();
	const reply = id => card(id).querySelector('.soliloquy-reply-button').click();
	return { ...h, panel, service, posts, card, edit, reply };
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
		h.service[method] = () => { calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); };
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
		h.service[kind === 'edit' ? 'updatePost' : 'addReply'] = () => new Promise(resolve => { finish = resolve; });
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
		h.service[kind === 'post' ? 'addPost' : kind === 'edit' ? 'updatePost' : 'addReply'] = () => new Promise(resolve => { finish = resolve; });
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
		h.service[kind === 'edit' ? 'updatePost' : 'addReply'] = () => new Promise(resolve => { finish = resolve; });
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
	h.service.getPosts = () => new Promise(resolve => { finishRead = resolve; });
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
		await service.updatePost(post, content);
		h.posts[0].content = post.content;
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

test('task mapping captures the source before asynchronous Markdown rendering', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	let finishRender;
	MarkdownRenderer.render = async (_app, markdown, element) => {
		if (!finishRender) await new Promise(resolve => { finishRender = resolve; });
		element.createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } }).checked = markdown.includes('[x]');
	};
	const changes = [];
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: async (...args) => { changes.push(args); },
	});
	const post = { content: '- [ ] Original', date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } };
	const render = renderer.render(post, h.root);
	post.content = '- [ ] Different';
	finishRender();
	await render;
	const checkbox = h.root.querySelector('input');
	checkbox.checked = true;
	checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
	await settle();
	assert.equal(changes[0][0].content, '- [ ] Original');
	assert.notEqual(changes[0][0], post);
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
			post.content = post.content.slice(0, task.markerOffset) + (checked ? 'x' : ' ') + post.content.slice(task.markerOffset + 1);
			saved();
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
		await h.actualService.updateTask(...args);
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

test('publishing a completed task save cannot replace a newer shared post', async t => {
	const h = await taskPanelHarness(t);
	h.edit('second');
	const sourcePost = h.panel.posts[0];
	let publish;
	h.service.updateTask = async (...args) => {
		await h.actualService.updateTask(...args);
		await new Promise(resolve => { publish = resolve; });
	};
	h.card('first').querySelector('input').click();
	await settle();
	sourcePost.content = '- [x] Newer content';
	publish();
	await settle();
	assert.equal(sourcePost.content, '- [x] Newer content');
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
		onTaskChange: async (post, task, checked, saved) => { await service.updateTask(post, task, checked); saved(); },
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
			// Obsidian displays both tasks; Lezer omits T0 for this list indentation.
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
	h.service.getPosts = async () => { throw new Error('Read failed'); };
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
	const sourcePost = h.panel.posts[0];
	let publish;
	h.service.updateTask = async (...args) => {
		await new Promise(resolve => { publish = resolve; });
		await h.actualService.updateTask(...args);
	};
	h.edit('second');
	h.root.querySelector('input.task-list-item-checkbox').click();
	await settle();
	// The reply path's ensureBlockId adopts the current ID without changing the body.
	await h.actualService.ensureBlockId(sourcePost);
	assert.equal(sourcePost.blockId, 'first');
	publish();
	await settle();
	assert.equal(sourcePost.content, '- [x] Task');
	const first = h.root.querySelector('.soliloquy-post');
	first.querySelector('.soliloquy-edit-button').click();
	assert.equal(h.panel.inlineEditor.active.input.value, '- [x] Task');
});

test.after(() => dom.window.close());
