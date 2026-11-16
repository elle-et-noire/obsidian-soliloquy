import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Uses the real moment package so date formats behave as they do in Obsidian.
const result = await build({
	stdin: {
		contents: `
			export * from './src/services/daily-note-path';
			export { moment } from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
	plugins: [{
		name: 'obsidian-moment',
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-moment' }));
			builder.onLoad({ filter: /.*/, namespace: 'obsidian-moment' }, () => ({
				contents: `
					export { default as moment } from 'moment';
					export const normalizePath = (path) => path.split('/').filter(Boolean).join('/');
				`,
				loader: 'js',
				resolveDir: process.cwd(),
			}));
		},
	}],
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Daily note path test bundle was not generated.');
const {
	buildDailyNotePath,
	moment,
	parseDailyNoteDate,
	validateDailyNoteFormat,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const SETTINGS = { dailyNoteFolder: ' log/ ', dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD' };

test('builds and parses nested daily note paths', () => {
	const path = buildDailyNotePath(SETTINGS, moment('2026-07-13', 'YYYY-MM-DD'));
	assert.equal(path, 'log/2026/07/2026-07-13.md');
	assert.equal(parseDailyNoteDate(path, SETTINGS), '2026-07-13');
});

test('rejects paths that the format would not produce', () => {
	for (const path of [
		'log/2026/07/2026-7-13.md',
		'log/2026/02/2026-02-30.md',
		'log/2026/08/2026-07-13.md',
		'other/2026/07/2026-07-13.md',
		'log/2026/07/2026-07-13.txt',
		'log/2026/07/2026-07-13 copy.md',
	]) {
		assert.equal(parseDailyNoteDate(path, SETTINGS), null, path);
	}
	assert.equal(parseDailyNoteDate('2026-07-13.md', { ...SETTINGS, dailyNoteFormat: ' ' }), null);
});

test('works without a folder and with literal text in the format', () => {
	const settings = { dailyNoteFolder: '', dailyNoteFormat: '[Journal] YYYY-MM-DD ddd' };
	const path = buildDailyNotePath(settings, moment('2026-07-13', 'YYYY-MM-DD'));
	assert.equal(path, 'Journal 2026-07-13 Mon.md');
	assert.equal(parseDailyNoteDate(path, settings), '2026-07-13');
});

test('validates formats that cannot identify a single day or path', () => {
	assert.equal(validateDailyNoteFormat('YYYY-MM-DD'), null);
	assert.equal(validateDailyNoteFormat('YYYY/MM/YYYY-MM-DD'), null);
	assert.match(validateDailyNoteFormat(''), /Enter a daily note format/);
	assert.match(validateDailyNoteFormat('MM-DD'), /enough information|different note/);
	assert.match(validateDailyNoteFormat('YYYY-MM'), /enough information|different note/);
	assert.match(validateDailyNoteFormat(`[a${String.fromCharCode(92)}b] YYYY-MM-DD`), /forward slashes/);
	assert.match(validateDailyNoteFormat('YYYY/../DD'), /invalid path segment|enough information/);
});
