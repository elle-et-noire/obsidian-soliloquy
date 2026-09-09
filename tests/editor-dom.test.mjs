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
const { SoliloquyTextEditor, SoliloquyComposer, TimelinePanel, PostCardRenderer, MarkdownRenderer, registerTimelineKeyboard, getCM } = await import(
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
	panel.saveEdit = async (post, value) => { calls.push(['edit', value]); };
	panel.saveReply = async (post, value, stay) => { calls.push(['reply', value, stay]); };
	h.actions.submit = target => panel.submitFromShortcut(target);
	for (const field of ['post', 'edit', 'reply']) {
		const input = h.create();
		if (field === 'post') panel.composer = { input, isSearching: () => false };
		if (field === 'edit') panel.editing = { input, post };
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
	const first = h.panel.editing.input;
	first.value = 'Discard me';
	h.edit('second');
	const second = h.panel.editing.input;
	second.value = 'Second draft';
	await settle();
	assert.equal(first.view.destroyed, true);
	assert.equal(h.card('first').querySelector('.soliloquy-post-content').textContent, 'Saved first');
	assert.equal(h.root.querySelectorAll('.soliloquy-edit-input').length, 1);
	assert.equal(second.value, 'Second draft');
	assert.equal(document.activeElement, second.view.contentDOM);
	h.reply('first');
	const reply = h.panel.replying.input;
	await settle();
	assert.equal(second.view.destroyed, true);
	assert.equal(h.panel.editing, undefined);
	assert.equal(document.activeElement, reply.view.contentDOM);
	h.edit('second');
	await settle();
	assert.equal(reply.view.destroyed, true);
	assert.equal(h.panel.replying, undefined);
	assert.equal(h.root.querySelectorAll('.soliloquy-edit-input').length, 1);
});

test('another text field cancels an edit or reply while buttons, timeline and the same Vim prompt keep it', async t => {
	const h = await panelHarness(t);
	for (const kind of ['edit', 'reply']) {
		for (const destination of ['composer', 'search', 'note']) {
			h[kind]('first');
			const draft = kind === 'edit' ? h.panel.editing : h.panel.replying;
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
			assert.equal(h.panel.editing, undefined);
			assert.equal(h.panel.replying, undefined);
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
		const input = kind === 'post' ? h.panel.composer.input : kind === 'edit' ? h.panel.editing.input : h.panel.replying.input;
		const button = kind === 'post' ? h.root.querySelector('.soliloquy-post-button') : kind === 'edit' ? h.panel.editing.button : h.panel.replying.button;
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
		const original = kind === 'edit' ? h.panel.editing : h.panel.replying;
		original.input.value = 'Sent';
		original.button.click();
		h.edit('second');
		const current = h.panel.editing;
		current.input.value = 'New draft';
		finish();
		await settle();
		assert.equal(original.input.view.destroyed, true);
		assert.equal(h.panel.editing, current);
		assert.equal(current.input.value, 'New draft');
		assert.equal(document.activeElement, current.input.view.contentDOM);
		h.panel.focus('post');
		await settle();
	}
});

test('rendered task checkboxes use source offsets and ignore embedded or unmappable checkboxes', async t => {
	const h = harness(t);
	const originalRender = MarkdownRenderer.render;
	t.after(() => { MarkdownRenderer.render = originalRender; });
	MarkdownRenderer.render = async (_app, _markdown, content) => {
		content.createEl('pre', { text: '- [ ] example' });
		content.createDiv({ cls: 'internal-embed' }).createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } });
		content.createEl('input', { cls: 'task-list-item-checkbox', attr: { type: 'checkbox' } });
	};
	const changes = [];
	const renderer = new PostCardRenderer(h.app, h.owner, {
		getReplies: () => [], getPostKey: () => 'test', isFocused: () => false,
		onTaskChange: (...args) => changes.push(args),
	});
	const content = '```md\n- [ ] Example\n```\n- [ ] Actual';
	const post = { content, date: '2026-09-07', time: '12:00', file: { path: 'daily.md' } };
	await renderer.render(post, h.root);
	const [embedded, actual] = h.root.querySelectorAll('input');
	embedded.dispatchEvent(new window.Event('change', { bubbles: true }));
	assert.equal(changes.length, 0);
	actual.checked = true;
	actual.dispatchEvent(new window.Event('change', { bubbles: true }));
	assert.deepEqual(changes, [[post, { markerOffset: content.indexOf('[ ] Actual') + 1 }, true]]);
	await renderer.render({ ...post, content: '```md\n- [ ] Example\n```' }, h.root);
	assert.equal(h.root.querySelectorAll('input')[3].disabled, true);
});

test('text entered while a save is pending stays in the current field', async t => {
	const h = await panelHarness(t);
	for (const kind of ['post', 'edit', 'reply']) {
		let finish;
		h.service[kind === 'post' ? 'addPost' : kind === 'edit' ? 'updatePost' : 'addReply'] = () => new Promise(resolve => { finish = resolve; });
		if (kind === 'post') h.panel.focus('post');
		else h[kind]('first');
		const input = kind === 'post' ? h.panel.composer.input : kind === 'edit' ? h.panel.editing.input : h.panel.replying.input;
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
	const oldInput = first.panel.replying.input;
	second.edit('second');
	const newInput = second.panel.editing.input;
	await settle();
	assert.equal(oldInput.view.destroyed, true);
	assert.equal(newInput.view.destroyed, false);
	assert.equal(document.activeElement, newInput.view.contentDOM);
});

test.after(() => dom.window.close());
