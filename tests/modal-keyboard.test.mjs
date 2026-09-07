import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
	entryPoints: ['src/ui/modal-keyboard.ts'],
	bundle: true,
	format: 'esm',
	write: false,
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Modal keyboard bundle was not generated.');
const { handleModalEscape, handleModalSlash } = await import(
	`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

function pressEscape({ field = false, inside = true, ...overrides } = {}) {
	let closed = false;
	let prevented = false;
	let stopped = false;
	let unfocused = false;
	const root = {
		ownerDocument: { activeElement: { matches: () => field } },
		contains: () => inside,
		focus: () => { unfocused = true; },
	};
	handleModalEscape({
		key: 'Escape',
		isComposing: false,
		repeat: false,
		preventDefault: () => { prevented = true; },
		stopImmediatePropagation: () => { stopped = true; },
		...overrides,
	}, root, () => { closed = true; });
	return { closed, prevented, stopped, unfocused };
}

test('Escape moves focus out of a text field without closing or cancelling the draft', () => {
	assert.deepEqual(pressEscape({ field: true }), {
		closed: false, prevented: true, stopped: true, unfocused: true,
	});
});

test('Escape closes when focus is on a post or button', () => {
	assert.equal(pressEscape().closed, true);
});

test('a background editor does not protect the modal from Escape', () => {
	assert.equal(pressEscape({ field: true, inside: false }).closed, true);
});

test('IME composition and key repeats cannot close the modal', () => {
	assert.equal(pressEscape({ isComposing: true }).closed, false);
	assert.equal(pressEscape({ repeat: true }).closed, false);
	assert.equal(pressEscape({ field: true, isComposing: true }).unfocused, false);
	assert.equal(pressEscape({ field: true, repeat: true }).unfocused, false);
});

test('other keys continue to the input normally', () => {
	assert.deepEqual(pressEscape({ key: 'Enter' }), {
		closed: false, prevented: false, stopped: false, unfocused: false,
	});
});

test('slash outside a text field focuses it and consumes the shortcut character', () => {
	const root = { ownerDocument: { activeElement: null } };
	let focused = false;
	let prevented = false;
	let stopped = false;
	const handled = handleModalSlash({
		key: '/',
		preventDefault: () => { prevented = true; },
		stopImmediatePropagation: () => { stopped = true; },
	}, root, () => { focused = true; });
	assert.deepEqual({ handled, focused, prevented, stopped }, {
		handled: true, focused: true, prevented: true, stopped: true,
	});
});

test('slash is typed normally in inputs and leaves modified shortcuts and IME alone', () => {
	for (const overrides of [{ field: true }, { ctrlKey: true }, { metaKey: true },
		{ altKey: true }, { isComposing: true }, { key: '?' }]) {
		const root = {
			ownerDocument: { activeElement: { matches: () => overrides.field } },
			contains: () => true,
		};
		const handled = handleModalSlash({
			key: '/',
			preventDefault: () => assert.fail('Must allow normal text and shortcuts'),
			...overrides,
		}, root, () => assert.fail('Must not move focus'));
		assert.equal(handled, false);
	}
});
