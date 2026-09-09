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
						export const moment = (value, format) => ({
							isValid: () => typeof value === 'string',
							format: (requested) => requested === format ? value : value?.slice(-10),
						});
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

const markdownBuildResult = await build({
	entryPoints: ['src/services/timeline-markdown.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
});
const bundledMarkdown = markdownBuildResult.outputFiles[0]?.text;
if (!bundledMarkdown) throw new Error('Timeline Markdown test bundle was not generated.');
const markdownBundleUrl = `data:text/javascript;base64,${Buffer.from(bundledMarkdown).toString('base64')}`;
const {
	appendPostToTimelineSection,
	findTimelineSections,
} = await import(markdownBundleUrl);

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

test('preserves CRLF line endings when editing a post', async () => {
	const harness = createHarness([
		'# Daily note',
		'## soliloquy',
		'- 10:00 ^sol-target',
		'\tTarget',
		'## next section',
		'Next content',
	].join('\r\n'));

	await harness.service.updatePost(post(), 'Updated');

	const updated = harness.getSource();
	assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
	assert.match(updated, /- 10:00 \^sol-target\r\n\tUpdated\r\n## next section/);
});

test('preserves CRLF line endings when updating a task', async () => {
	const harness = createHarness([
		'# Daily note',
		'## soliloquy',
		'- 10:00 ^sol-target',
		'\t- [ ] Task',
		'## next section',
		'Next content',
	].join('\r\n'));
	const target = post({ content: '- [ ] Task' });

	await harness.service.updateTask(target, { markerOffset: 3 }, true);

	const updated = harness.getSource();
	assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
	assert.match(updated, /- 10:00 \^sol-target\r\n\t- \[x\] Task\r\n## next section/);
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

test('matches only an exact H2 heading outside fenced code blocks', () => {
	const source = [
		'## soliloquy archive',
		'Archive content',
		'### soliloquy',
		'Nested content',
		'```md',
		'## soliloquy',
		'Fenced content',
		'```',
	].join('\n');

	assert.equal(findTimelineSections(source, '## soliloquy').length, 0);
	const updated = appendPostToTimelineSection(
		source,
		'## soliloquy',
		'- 12:00 ^sol-new\n\tNew post',
	);
	const sections = findTimelineSections(updated, '## soliloquy');

	assert.equal(sections.length, 1);
	assert.deepEqual(sections[0]?.lines.slice(1, 3), [
		'- 12:00 ^sol-new',
		'\tNew post',
	]);
});

test('does not end a timeline section at an H2 inside a code fence', () => {
	const source = [
		'## soliloquy',
		'- 10:00 ^sol-target',
		'\tTarget',
		'~~~md',
		'## fenced heading',
		'~~~',
		'After fence',
		'## actual next section',
		'Next content',
	].join('\n');
	const section = findTimelineSections(source, '## soliloquy')[0];

	assert.ok(section);
	assert.ok(section.lines.includes('## fenced heading'));
	assert.ok(section.lines.includes('After fence'));
	assert.ok(!section.lines.includes('## actual next section'));
});

test('rejects appending when exact timeline headings are duplicated', () => {
	const source = [
		'## soliloquy',
		'- 10:00 ^sol-first',
		'\tFirst',
		'## soliloquy',
		'- 11:00 ^sol-second',
		'\tSecond',
	].join('\n');

	assert.equal(findTimelineSections(source, '## soliloquy').length, 2);
	assert.throws(
		() => appendPostToTimelineSection(source, '## soliloquy', '- 12:00 ^sol-new'),
		/Multiple timeline sections/,
	);
});

test('preserves CRLF line endings when appending a post', () => {
	const source = [
		'## soliloquy',
		'',
		'## next section',
		'Next content',
		'',
	].join('\r\n');
	const updated = appendPostToTimelineSection(
		source,
		'## soliloquy',
		'- 12:00 ^sol-new\n\tNew post',
	);

	assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
	assert.match(updated, /## soliloquy\r\n- 12:00 \^sol-new\r\n\tNew post\r\n## next section/);
});

test('rereads only an invalidated daily note', async () => {
	const first = { path: 'log/2026/07/2026-07-12.md', extension: 'md' };
	const second = { path: 'log/2026/07/2026-07-13.md', extension: 'md' };
	const files = [first, second];
	const sources = new Map([
		[first.path, '## soliloquy\n- 09:00 ^sol-first\n\tFirst'],
		[second.path, '## soliloquy\n- 10:00 ^sol-second\n\tSecond'],
	]);
	const reads = new Map();
	const service = new TimelineService({
		vault: {
			getMarkdownFiles: () => files,
			cachedRead: async (file) => {
				reads.set(file.path, (reads.get(file.path) ?? 0) + 1);
				return sources.get(file.path) ?? '';
			},
		},
	}, () => SETTINGS);

	const [initial, concurrent] = await Promise.all([service.getPosts(), service.getPosts()]);
	assert.equal(initial.length, 2);
	assert.equal(concurrent.length, 2);
	assert.equal(reads.get(first.path), 1);
	assert.equal(reads.get(second.path), 1);

	sources.set(second.path, '## soliloquy\n- 10:00 ^sol-second\n\tUpdated');
	service.invalidateFile(second);
	const updated = await service.getPosts();

	assert.equal(updated[0]?.content, 'Updated');
	assert.equal(reads.get(first.path), 1);
	assert.equal(reads.get(second.path), 2);
});

test('editing never removes paragraphs, lists or code following a post', async () => {
	for (const ending of ['\n', '\r\n']) {
		for (const outside of [
			['Unrelated paragraph', '    Indented code'],
			['- Shopping', '  - Milk'],
			['```md', '- 11:00 ^sol-example', '\tExample', '```'],
		]) {
			const tail = ['', ...outside, '', '- 12:00 ^sol-next', '\tNext'].join(ending);
			const source = ['## soliloquy', '- 10:00 ^sol-target', '\tTarget'].join(ending) + ending + tail;
			const h = createHarness(source);
			await h.service.updatePost(post(), 'Updated');
			assert.equal(h.getSource(), ['## soliloquy', '- 10:00 ^sol-target', '\tUpdated'].join(ending) + ending + tail);
		}
	}
});

test('post parsing retains indented code and blank lines but ignores top-level fenced examples', async () => {
	const source = [
		'## soliloquy',
		'````md', '- 09:00 ^sol-example', '\tExample', '```', '- 09:30 ^sol-example2', '````',
		'- 10:00 ^sol-target', '\tTarget', '', '\tSecond paragraph', '\t', '\t```md', '\t- 09:00 ^sol-body-example', '\t```',
		'~~~', '- 11:00 ^sol-tilde-example', '\tExample', '~~~',
		'- 12:00 ^sol-next', '\tNext',
	].join('\n');
	const h = createHarness(source);
	const posts = h.service.parsePosts(source.split('\n').slice(1), 1, '2026-07-13', FILE);
	assert.deepEqual(posts.map(item => item.blockId), ['sol-target', 'sol-next']);
	assert.equal(posts[0].content, 'Target\n\nSecond paragraph\n\n```md\n- 09:00 ^sol-body-example\n```');
	assert.equal(posts[0].lineStart, 7);
	assert.equal(posts[0].lineEnd, 15);
	await h.service.updatePost(posts[0], 'Changed');
	assert.ok(h.getSource().includes('~~~\n- 11:00 ^sol-tilde-example\n\tExample\n~~~'));
	assert.ok(h.getSource().includes('- 09:00 ^sol-example\n\tExample'));
});

test('unclosed and mismatched fences cannot produce editable posts', () => {
	for (const opening of ['```md', '~~~~']) {
		const lines = [opening, '- 10:00 ^sol-example', '\tExample', '~~~', '- 11:00 ^sol-example2'];
		assert.deepEqual(createHarness('').service.parsePosts(lines, 1, '2026-07-13', FILE), []);
	}
});

test('task updates follow Markdown source positions through code, nested lists and quotes', async () => {
	const content = [
		'```md', '- [ ] Fenced example', '```', '',
		'    - [ ] Indented example', '',
		'- [ ] Actual parent', '  - [ ] Actual child', '',
		'> - [ ] Quoted task', '',
		'1. [ ] Ordered task', '',
		'- Item', '  ~~~', '  - [ ] Nested code', '  ~~~',
	].join('\n');
	for (const label of ['Actual parent', 'Actual child', 'Quoted task', 'Ordered task']) {
		const offset = content.indexOf(`[ ] ${label}`) + 1;
		const source = ['## soliloquy', '- 10:00 ^sol-target', ...content.split('\n').map(line => '\t' + line)].join('\n');
		const h = createHarness(source);
		const target = post({ content });
		await h.service.updateTask(target, { markerOffset: offset }, true);
		assert.equal(h.getSource(), source.replace(`[ ] ${label}`, `[x] ${label}`));
	}
	for (const label of ['Fenced example', 'Indented example', 'Nested code']) {
		const h = createHarness('');
		await assert.rejects(h.service.updateTask(post({ content }), {
			markerOffset: content.indexOf(`[ ] ${label}`) + 1,
		}, true), /task could not be found/);
	}
});

test('updating normal and custom tasks preserves Obsidian comments and all other statuses', async () => {
	const content = '%%\n- [ ] Hidden\n%%\n\n- [ ] Todo\n- [-] Cancelled\n- [/] Doing\n- [?] Question';
	for (const marker of ['[ ] Todo', '[-] Cancelled', '[/] Doing', '[?] Question']) {
		for (const checked of [true, false]) {
			const initial = ['## soliloquy', '- 10:00 ^sol-target', ...content.split('\n').map(line => '\t' + line)].join('\r\n');
			const h = createHarness(initial);
			await h.service.updateTask(post({ content }), { markerOffset: content.indexOf(marker) + 1 }, checked);
			assert.equal(h.getSource(), initial.replace(marker, `[${checked ? 'x' : ' '}]${marker.slice(3)}`));
		}
	}
	const h = createHarness('');
	await assert.rejects(h.service.updateTask(post({ content }), { markerOffset: content.indexOf('[ ] Hidden') + 1 }, true), /task could not be found/);
});
