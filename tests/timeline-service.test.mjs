import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const buildResult = await build({
	entryPoints: ['src/services/timeline-service.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
	plugins: [
		{
			name: 'obsidian-stub',
			setup(builder) {
				builder.onResolve({ filter: /^obsidian$/ }, () => ({
					path: 'obsidian',
					namespace: 'obsidian-stub',
				}));
				builder.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
					contents: `
						export class App {}
						export class TFile {}
						export const normalizePath = (path) => path;
						export const moment = () => {
							throw new Error('moment is not used by these tests');
						};
					`,
					loader: 'js',
				}));
			},
		},
	],
});
const bundledSource = buildResult.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Timeline service test bundle was not generated.');
const bundleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`;
const { TimelineService } = await import(bundleUrl);

const SETTINGS = {
	dailyNoteFolder: 'log',
	dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD',
	sectionHeading: 'soliloquy',
};
const FILE = { path: 'log/2026/07/2026-07-13.md' };

function createHarness(initialSource) {
	let source = initialSource;
	const app = {
		vault: {
			process: async (_file, update) => {
				source = update(source);
			},
		},
	};
	return {
		service: new TimelineService(app, () => SETTINGS),
		getSource: () => source,
	};
}

function post(overrides = {}) {
	return {
		date: '2026-07-13',
		time: '10:00',
		content: 'Target',
		file: FILE,
		lineStart: 2,
		lineEnd: 4,
		blockId: 'sol-target',
		...overrides,
	};
}

test('updates by block ID after external lines shift', async () => {
	const harness = createHarness([
		'# Daily note',
		'External introduction',
		'',
		'## soliloquy',
		'',
		'- 10:00 ^sol-other',
		'\tOther',
		'- 10:00 ^sol-target',
		'\tTarget',
		'',
	].join('\n'));
	const target = post();

	await harness.service.updatePost(target, 'Updated');

	assert.match(harness.getSource(), /- 10:00 \^sol-other\n\tOther/);
	assert.match(harness.getSource(), /- 10:00 \^sol-target\n\tUpdated/);
	assert.equal(target.lineStart, 7);
});

test('rejects an edit when the current post content changed', async () => {
	const initialSource = [
		'## soliloquy',
		'- 10:00 ^sol-target',
		'\tChanged externally',
	].join('\n');
	const harness = createHarness(initialSource);

	await assert.rejects(
		harness.service.updatePost(post(), 'Updated'),
		/The post changed before it could be edited\./,
	);
	assert.equal(harness.getSource(), initialSource);
});

test('rejects duplicate block IDs instead of choosing by line number', async () => {
	const initialSource = [
		'## soliloquy',
		'- 10:00 ^sol-target',
		'\tTarget',
		'- 10:00 ^sol-target',
		'\tTarget',
	].join('\n');
	const harness = createHarness(initialSource);

	await assert.rejects(
		harness.service.updatePost(post(), 'Updated'),
		/The post changed before it could be edited\./,
	);
	assert.equal(harness.getSource(), initialSource);
});

test('assigns a block ID to a unique legacy post after lines shift', async () => {
	const harness = createHarness([
		'# Daily note',
		'External introduction',
		'## soliloquy',
		'- 10:00',
		'\tLegacy',
	].join('\n'));
	const legacy = post({ content: 'Legacy', blockId: undefined });

	await harness.service.updatePost(legacy, 'Updated legacy');

	assert.match(harness.getSource(), /- 10:00 \^sol-[\w-]+\n\tUpdated legacy/);
	assert.match(legacy.blockId ?? '', /^sol-[\w-]+$/);
});

test('rejects indistinguishable legacy posts', async () => {
	const initialSource = [
		'## soliloquy',
		'- 10:00',
		'\tLegacy',
		'- 10:00',
		'\tLegacy',
	].join('\n');
	const harness = createHarness(initialSource);
	const legacy = post({ content: 'Legacy', blockId: undefined });

	await assert.rejects(
		harness.service.updatePost(legacy, 'Updated legacy'),
		/The post changed before it could be edited\./,
	);
	assert.equal(harness.getSource(), initialSource);
});
