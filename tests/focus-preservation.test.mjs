import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const buildResult = await build({
	entryPoints: ['src/ui/focus-preservation.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
});
const bundledSource = buildResult.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Focus preservation test bundle was not generated.');
const bundleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`;
const { captureFocusWithin, shouldRestoreFocusWithin } = await import(bundleUrl);

function createHarness() {
	const body = { id: 'body' };
	const timelineCard = { id: 'timeline-card' };
	const replacementCard = { id: 'replacement-card' };
	const composer = { id: 'composer' };
	const editor = { id: 'markdown-editor' };
	const timelineElements = new Set([timelineCard, replacementCard]);
	const viewElements = new Set([timelineCard, replacementCard, composer]);
	const ownerDocument = { activeElement: editor, body };
	const timeline = {
		ownerDocument,
		contains: (element) => timelineElements.has(element),
	};
	const view = {
		ownerDocument,
		contains: (element) => viewElements.has(element),
	};
	return { body, composer, editor, ownerDocument, replacementCard, timeline, timelineCard, view };
}

test('does not request focus restoration when the Markdown editor owns focus', () => {
	const harness = createHarness();
	assert.equal(captureFocusWithin(harness.timeline), null);
	assert.equal(shouldRestoreFocusWithin(harness.view, null), false);
});

test('restores focus after the previously focused timeline card is replaced', () => {
	const harness = createHarness();
	harness.ownerDocument.activeElement = harness.timelineCard;
	const previousActiveElement = captureFocusWithin(harness.timeline);
	harness.ownerDocument.activeElement = harness.body;
	assert.equal(shouldRestoreFocusWithin(harness.view, previousActiveElement), true);
});

test('does not steal focus when the user moves to the Markdown editor during rendering', () => {
	const harness = createHarness();
	harness.ownerDocument.activeElement = harness.timelineCard;
	const previousActiveElement = captureFocusWithin(harness.timeline);
	harness.ownerDocument.activeElement = harness.editor;
	assert.equal(shouldRestoreFocusWithin(harness.view, previousActiveElement), false);
});

test('does not move composer focus to a timeline card during rendering', () => {
	const harness = createHarness();
	harness.ownerDocument.activeElement = harness.composer;
	assert.equal(captureFocusWithin(harness.timeline), null);
	assert.equal(shouldRestoreFocusWithin(harness.view, null), false);
});
