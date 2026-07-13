import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const buildResult = await build({
	entryPoints: ['src/services/timeline-index.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
});
const bundledSource = buildResult.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Timeline index test bundle was not generated.');
const bundleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`;
const { TimelineIndex } = await import(bundleUrl);

const FILE = { path: 'log/2026/07/2026-07-13.md' };

function post(index, overrides = {}) {
	return {
		date: '2026-07-13',
		time: `${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
		content: `Post ${index}`,
		file: FILE,
		lineStart: index * 2,
		lineEnd: index * 2 + 2,
		blockId: `sol-${index}`,
		...overrides,
	};
}

test('indexes replies and parents while preserving chronological reply order', () => {
	const parent = post(0, { content: 'Parent' });
	const later = post(2, { content: 'Later reply', replyToBlockId: parent.blockId });
	const earlier = post(1, { content: 'Earlier reply', replyToBlockId: parent.blockId });
	const index = new TimelineIndex([later, parent, earlier]);

	assert.equal(index.getPostByBlockId(parent.blockId), parent);
	assert.deepEqual(index.getReplies(parent), [earlier, later]);
	assert.equal(index.getReplies(earlier).length, 0);
	assert.match(index.getSearchText(parent), /parent earlier reply later reply/);
});

test('builds and queries a 10,000 post reply index', () => {
	const posts = Array.from({ length: 10_000 }, (_, itemIndex) => post(itemIndex, {
		replyToBlockId: itemIndex > 0 && itemIndex % 5 === 0 ? `sol-${itemIndex - 1}` : undefined,
	}));
	const started = performance.now();
	const index = new TimelineIndex(posts);
	const elapsed = performance.now() - started;

	assert.equal(index.getReplies(posts[4]).length, 1);
	assert.equal(index.getPostByBlockId('sol-9999'), posts[9999]);
	assert.match(index.getSearchText(posts[4]), /post 5/);
	assert.ok(elapsed < 1_000, `Expected index build under 1s, received ${elapsed.toFixed(1)}ms`);
});
