import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Scope, KeyboardOwner, createRoot, createInput, press } from './keyboard-harness.mjs';

const result = await build({
	entryPoints: ['src/ui/timeline-keyboard.ts'], bundle: true, format: 'esm', write: false,
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Timeline keyboard bundle was not generated.');
const { registerTimelineKeyboard } = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

function harness() {
	const owner = new KeyboardOwner();
	const parent = new Scope();
	const scope = new Scope(parent);
	const root = createRoot();
	const post = createInput(root);
	const search = createInput(root, 'search');
	const actions = {
		focus(target) { (target === 'search' ? search : post).focus(); },
		leaveDisplay() { root.blur(); },
		submit: () => false,
		goBack: () => false,
	};
	registerTimelineKeyboard(owner, scope, root, actions);
	return { owner, parent, scope, root, post, search, actions };
}

test('Shift+Escape preserves post/edit/reply drafts and slash returns to the same selection', () => {
	for (const kind of ['post', 'edit', 'reply']) {
		const { scope, root } = harness();
		const input = createInput(root, kind);
		input.focus();
		const escape = press(scope, root, { shiftKey: true });
		assert.equal(escape.defaultPrevented, true);
		assert.equal(root.ownerDocument.activeElement, root);
		const slash = press(scope, root, { key: '/' });
		assert.equal(slash.defaultPrevented, true);
		assert.equal(root.ownerDocument.activeElement, input);
		assert.equal(input.value, 'Unsaved text');
		assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7]);
	}
});

test('Escape reaches the input DOM handler without letting the parent scope close the display', () => {
	const { parent, scope, root, search } = harness();
	parent.register([], 'Escape', () => assert.fail('The host must not handle search Escape'));
	search.focus();
	const event = press(scope, root);
	assert.equal(event.defaultPrevented, false);
	assert.equal(event.stopped, false);
	assert.equal(root.ownerDocument.activeElement, search);
});

test('both outside-input Escape variants call the host action exactly once', () => {
	for (const shiftKey of [false, true]) {
		const { parent, scope, root, actions } = harness();
		let exits = 0;
		actions.leaveDisplay = () => { exits++; };
		parent.register(null, 'Escape', () => assert.fail('Must not also invoke the parent'));
		root.focus();
		assert.equal(press(scope, root, { shiftKey }).defaultPrevented, true);
		assert.equal(exits, 1);
	}
});

test('IME and held Escape cannot change search, blur inputs, or close the host', () => {
	for (const overrides of [{ isComposing: true }, { repeat: true },
		{ isComposing: true, shiftKey: true }, { repeat: true, shiftKey: true }]) {
		const { parent, scope, root, search } = harness();
		parent.register([], 'Escape', () => assert.fail('Must protect from accidental closure'));
		search.focus();
		press(scope, root, overrides);
		assert.equal(root.ownerDocument.activeElement, search);
		root.focus();
		press(scope, root, overrides);
		assert.equal(root.ownerDocument.activeElement, root);
	}
});

test('modified Escape and events already handled elsewhere leave inputs alone', () => {
	for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { altKey: true },
		{ defaultPrevented: true }]) {
		const { scope, root, search } = harness();
		search.focus();
		press(scope, root, overrides);
		assert.equal(root.ownerDocument.activeElement, search);
	}
});

test('slash is typed normally in inputs and does not interfere with modifiers or IME', () => {
	const { scope, root, post } = harness();
	post.focus();
	assert.equal(press(scope, root, { key: '/' }).defaultPrevented, false);
	root.focus();
	for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { altKey: true },
		{ isComposing: true }, { key: '?' }]) {
		assert.equal(press(scope, root, { key: '/', ...overrides }).defaultPrevented, false);
		assert.equal(root.ownerDocument.activeElement, root);
	}
});

test('slash falls back to the composer after an editor disappears and retains search mode', () => {
	for (const kind of ['edit', 'search']) {
		const { scope, root, post, search } = harness();
		const input = createInput(root, kind);
		input.focus();
		input.root = null;
		root.focus();
		press(scope, root, { key: '/' });
		assert.equal(root.ownerDocument.activeElement, kind === 'search' ? search : post);
	}
});

test('submit and back shortcuts consume keys only when an action is available', () => {
	for (const [action, event] of [
		['submit', { key: 'Enter', ctrlKey: true }],
		['submit', { key: 'Enter', code: 'NumpadEnter', ctrlKey: true }],
		['goBack', { key: 'ArrowLeft', altKey: true }],
	]) {
		const { parent, scope, root, actions } = harness();
		let passedThrough = 0;
		let acted = 0;
		parent.register(null, event.key, () => { passedThrough++; });
		press(scope, root, event);
		assert.equal(passedThrough, 1);
		actions[action] = () => { acted++; return true; };
		assert.equal(press(scope, root, event).defaultPrevented, true);
		assert.equal(acted, 1);
		assert.equal(passedThrough, 1);
		press(scope, root, { ...event, isComposing: true });
		assert.equal(acted, 1);
	}
});

test('unloading removes DOM and scope handlers and each display remembers its own input', () => {
	const first = harness();
	const second = harness();
	first.search.focus();
	second.post.focus();
	first.root.focus();
	press(first.scope, first.root, { key: '/' });
	assert.equal(first.root.ownerDocument.activeElement, first.search);
	assert.equal(second.root.ownerDocument.activeElement, second.post);
	first.owner.unload();
	first.root.focus();
	assert.equal(press(first.scope, first.root, { key: '/' }).defaultPrevented, false);
	assert.equal(first.scope.keys.length, 0);
	assert.equal(first.root.listeners.get('focusin').size, 0);
	assert.equal(first.root.listeners.get('keydown').size, 0);
});
