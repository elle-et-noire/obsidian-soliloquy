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
						export class TFile {
							static [Symbol.hasInstance](value) { return typeof value?.extension === 'string'; }
						}
						export const normalizePath = (path) => path;
						// Without arguments, "now" is 2026-07-13 11:00.
						export const moment = (value = '2026/07/2026-07-13', format = 'YYYY/MM/YYYY-MM-DD') => ({
							isValid: () => typeof value === 'string',
							format: (requested) => requested === 'HH:mm' ? '11:00'
								: requested === format ? value : value?.slice(-10),
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
	parsePosts,
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

	const updated = await harness.service.updatePost(target, 'Updated');

	assert.match(harness.getSource(), /- 10:00 \^sol-other\n\tOther/);
	assert.match(harness.getSource(), /- 10:00 \^sol-target\n\tUpdated/);
	assert.equal(updated.lineStart, 7);
	assert.equal(updated.content, 'Updated');
	assert.deepEqual(target, post());
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

	const updated = await harness.service.updatePost(legacy, 'Updated legacy');

	assert.match(updated.blockId ?? '', /^sol-[\w-]+$/);
	assert.ok(harness.getSource().includes(`- 10:00 ^${updated.blockId}\n\tUpdated legacy`));
	assert.equal(legacy.blockId, undefined);
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

	assert.equal(findTimelineSections(source, 'soliloquy').length, 0);
	const updated = appendPostToTimelineSection(
		source,
		'soliloquy',
		'- 12:00 ^sol-new\n\tNew post',
	);
	const sections = findTimelineSections(updated, 'soliloquy');

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
	const section = findTimelineSections(source, 'soliloquy')[0];

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

	assert.equal(findTimelineSections(source, 'soliloquy').length, 2);
	assert.throws(
		() => appendPostToTimelineSection(source, 'soliloquy', '- 12:00 ^sol-new'),
		/more than one "soliloquy" section/,
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
		'soliloquy',
		'- 12:00 ^sol-new\n\tNew post',
	);

	assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
	assert.match(updated, /## soliloquy\r\n- 12:00 \^sol-new\r\n\tNew post\r\n\r\n## next section/);
});

const MANUAL_TIMERS = { setTimeout: () => 1, clearTimeout() {} };

/** A vault of daily notes with reads, writes, and change events under test control. */
function createVault(entries) {
	const sources = new Map(entries);
	const files = new Map(Array.from(sources.keys(), (path) => [path, { path, extension: 'md' }]));
	const reads = new Map();
	let writes = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => Array.from(files.values()),
			getAbstractFileByPath: (path) => files.get(path) ?? null,
			cachedRead: async (file) => {
				reads.set(file.path, (reads.get(file.path) ?? 0) + 1);
				return sources.get(file.path) ?? '';
			},
			process: async (file, update) => {
				writes++;
				sources.set(file.path, update(sources.get(file.path) ?? ''));
			},
		},
	};
	const service = new TimelineService(app, () => SETTINGS, MANUAL_TIMERS);
	let changes = 0;
	service.onChange(() => { changes++; });
	return {
		app, service, sources, files, reads,
		file: (path) => files.get(path),
		changes: () => changes,
		writes: () => writes,
	};
}

const FIRST = 'log/2026/07/2026-07-12.md';
const SECOND = 'log/2026/07/2026-07-13.md';

test('rereads only a changed daily note', async () => {
	const vault = createVault([
		[FIRST, '## soliloquy\n- 09:00 ^sol-first\n\tFirst'],
		[SECOND, '## soliloquy\n- 10:00 ^sol-second\n\tSecond'],
	]);
	const { service, reads } = vault;

	const [initial, concurrent] = await Promise.all([service.getTimeline(), service.getTimeline()]);
	assert.equal(initial, concurrent);
	assert.equal(initial.posts.length, 2);
	assert.equal(reads.get(FIRST), 1);
	assert.equal(reads.get(SECOND), 1);

	vault.sources.set(SECOND, '## soliloquy\n- 10:00 ^sol-second\n\tUpdated');
	service.fileChanged(vault.file(SECOND));
	await service.flushFileChanges();
	const updated = await service.getTimeline();

	assert.equal(vault.changes(), 1);
	assert.equal(updated.posts[0]?.content, 'Updated');
	assert.equal(updated.index.getPostByBlockId('sol-second'), updated.posts[0]);
	assert.equal(reads.get(FIRST), 1);
	assert.equal(reads.get(SECOND), 2);
});

test('the sorted snapshot is shared until posts change', async () => {
	const vault = createVault([
		[FIRST, '## soliloquy\n- 09:00 ^sol-a\n\tA\n- 09:00 ^sol-b\n\tB'],
		[SECOND, '## soliloquy\n- 08:00 ^sol-c\n\tC'],
	]);
	const timeline = await vault.service.getTimeline();
	assert.deepEqual(timeline.posts.map((post) => post.blockId), ['sol-c', 'sol-b', 'sol-a']);
	assert.equal(await vault.service.getTimeline(), timeline);
});

test('only vault changes that alter posts notify displays', async () => {
	const vault = createVault([[SECOND, '# Day\n\n## soliloquy\n- 10:00 ^sol-a\n\tA\n']]);
	const { service } = vault;
	await service.getTimeline();
	// Moving a post changes the lines a later edit targets, so it is a change.
	vault.sources.set(SECOND, '# Day\nNew notes above\n\n## soliloquy\n- 10:00 ^sol-a\n\tA\n');
	service.fileChanged(vault.file(SECOND));
	await service.flushFileChanges();
	assert.equal(vault.changes(), 1);
	const current = await service.getTimeline();

	vault.sources.set(SECOND, '# Day\nEdited notes\n\n## soliloquy\n- 10:00 ^sol-a\n\tA\n\n## Other\nText');
	service.fileChanged(vault.file(SECOND));
	await service.flushFileChanges();
	assert.equal(vault.changes(), 1);
	assert.equal(await service.getTimeline(), current);
});

test('a write notifies displays once and its vault echo does not notify again', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 ^sol-a\n\tA']]);
	const { service } = vault;
	const [post] = (await service.getTimeline()).posts;
	await service.updatePost(post, 'Edited');
	assert.equal(vault.changes(), 1);
	const updated = await service.getTimeline();
	assert.equal(updated.posts[0]?.content, 'Edited');

	service.fileChanged(vault.file(SECOND));
	await service.flushFileChanges();
	assert.equal(vault.changes(), 1);
	assert.equal(await service.getTimeline(), updated);
});

test('identifying a post that already has an ID does not notify displays', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 ^sol-a\n\tA']]);
	const [post] = (await vault.service.getTimeline()).posts;
	assert.equal((await vault.service.ensureBlockId(post)).blockId, 'sol-a');
	assert.equal(vault.writes(), 1); // vault.process runs, but the source is unchanged.
	assert.equal(vault.changes(), 0);
});

test('updates return new posts and leave the cached snapshot unchanged', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 ^sol-a\n\tA']]);
	const timeline = await vault.service.getTimeline();
	const [post] = timeline.posts;
	const updated = await vault.service.updatePost(post, 'Edited');
	assert.notEqual(updated, post);
	assert.equal(updated.content, 'Edited');
	assert.equal(post.content, 'A');
	assert.equal(timeline.index.getSearchText(post).includes(' a'), true);
	const current = await vault.service.getTimeline();
	assert.notEqual(current, timeline);
	assert.deepEqual(current.posts, [updated]);
});

test('an edited legacy post accepts a reply through the post the edit returned', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 legacy text']]);
	const [original] = (await vault.service.getTimeline()).posts;
	const edited = await vault.service.updatePost(original, 'Edited');
	assert.match(edited.blockId ?? '', /^sol-[\w-]+$/);
	assert.equal(original.blockId, undefined);

	const parent = await vault.service.addReply(edited, 'Reply');
	assert.equal(parent.blockId, edited.blockId);
	const { posts, index } = await vault.service.getTimeline();
	assert.equal(vault.sources.get(SECOND), [
		'## soliloquy',
		`- 10:00 ^${edited.blockId}`,
		'\tEdited',
		`- 11:00 ^${posts[0].blockId}`,
		`\t[[log/2026/07/2026-07-13#^${edited.blockId}]]`,
		'\tReply',
		'',
	].join('\n'));
	assert.deepEqual(index.getReplies(posts[1]).map((reply) => reply.content), ['Reply']);

	// The pre-edit post no longer matches the note.
	await assert.rejects(vault.service.addReply(original, 'Stale'), { name: 'PostChangedError' });
});

test('a task toggle after an edit uses the post the edit returned', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 ^sol-a\n\t- [ ] One']]);
	const [original] = (await vault.service.getTimeline()).posts;
	const edited = await vault.service.updatePost(original, '- [ ] One\n- [ ] Two');
	const first = await vault.service.updateTask(edited, { markerOffset: 3 }, true);
	const second = await vault.service.updateTask(first, { markerOffset: 13 }, true);
	assert.equal(second.content, '- [x] One\n- [x] Two');
	assert.equal(vault.sources.get(SECOND), '## soliloquy\n- 10:00 ^sol-a\n\t- [x] One\n\t- [x] Two');
	await assert.rejects(
		vault.service.updateTask(original, { markerOffset: 3 }, true),
		{ name: 'PostChangedError' },
	);
	await assert.rejects(
		vault.service.updateTask(first, { markerOffset: 13 }, false),
		{ name: 'PostChangedError' },
	);
});

test('replies reuse the block ID assigned for the first reply', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 legacy text']]);
	const [original] = (await vault.service.getTimeline()).posts;
	const parent = await vault.service.addReply(original, 'First');
	assert.match(parent.blockId ?? '', /^sol-[\w-]+$/);
	assert.equal(parent.content, 'legacy text');
	assert.equal(original.blockId, undefined);

	assert.equal((await vault.service.addReply(parent, 'Second')).blockId, parent.blockId);
	// A reply from the unchanged pre-ID post adopts the same ID instead of adding one.
	assert.equal((await vault.service.addReply(original, 'Third')).blockId, parent.blockId);
	const source = vault.sources.get(SECOND);
	assert.equal(source.split('\n')[1], `- 10:00 ^${parent.blockId} legacy text`);
	assert.equal(source.split(`#^${parent.blockId}]]`).length - 1, 3);
	const { posts, index } = await vault.service.getTimeline();
	const root = posts.find((post) => post.blockId === parent.blockId);
	assert.deepEqual(index.getReplies(root).map((reply) => reply.content), ['First', 'Second', 'Third']);
});

test('removing or renaming a daily note with posts notifies displays', async () => {
	const vault = createVault([
		[FIRST, '## soliloquy\n- 09:00 ^sol-first\n\tFirst'],
		[SECOND, '## soliloquy\n- 10:00 ^sol-second\n\tSecond'],
	]);
	const { service } = vault;
	await service.getTimeline();
	vault.files.delete(SECOND);
	service.fileRemoved(SECOND);
	service.fileRemoved('Notes/unrelated.md');
	await service.flushFileChanges();
	assert.equal(vault.changes(), 1);
	assert.deepEqual((await service.getTimeline()).posts.map((post) => post.blockId), ['sol-first']);

	const renamed = { path: 'Archive/2026-07-12.md', extension: 'md' };
	vault.files.delete(FIRST);
	vault.files.set(renamed.path, renamed);
	service.fileRemoved(FIRST);
	service.fileChanged(renamed);
	await service.flushFileChanges();
	assert.equal(vault.changes(), 2);
	assert.deepEqual((await service.getTimeline()).posts, []);
});

test('changing settings notifies displays and rereads every note', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 ^sol-a\n\tA']]);
	const timeline = await vault.service.getTimeline();
	vault.service.invalidateAll();
	assert.equal(vault.changes(), 1);
	assert.notEqual(await vault.service.getTimeline(), timeline);
	assert.equal(vault.reads.get(SECOND), 2);
});

test('vault events are coalesced, checked after a delay, and stop on dispose', async () => {
	const vault = createVault([[SECOND, '## soliloquy\n- 10:00 ^sol-a\n\tA']]);
	const timers = [];
	const service = new TimelineService(vault.app, () => SETTINGS, {
		setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
		clearTimeout: (id) => { timers[id - 1].cleared = true; },
	});
	let changes = 0;
	const unsubscribe = service.onChange(() => { changes++; });
	await service.getTimeline();
	vault.sources.set(SECOND, '## soliloquy\n- 10:00 ^sol-a\n\tB');
	service.fileChanged(vault.file(SECOND));
	service.fileChanged(vault.file(SECOND));
	service.fileChanged({ path: 'Notes/unrelated.md', extension: 'md' });
	assert.deepEqual(timers.map((timer) => [timer.delay, timer.cleared ?? false]), [[100, true], [100, false]]);
	timers[1].callback();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(changes, 1);
	assert.equal((await service.getTimeline()).posts[0]?.content, 'B');

	unsubscribe();
	service.invalidateAll();
	assert.equal(changes, 1);
	service.fileChanged(vault.file(SECOND));
	service.dispose();
	assert.equal(timers[2].cleared, true);
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
	const posts = parsePosts(source.split('\n').slice(1), 1, '2026-07-13', FILE);
	assert.deepEqual(posts.map(item => item.blockId), ['sol-target', 'sol-next']);
	assert.equal(posts[0].content, 'Target\n\nSecond paragraph\n\n```md\n- 09:00 ^sol-body-example\n```');
	assert.equal(posts[0].lineStart, 7);
	assert.equal(posts[0].lineEnd, 15);
	await h.service.updatePost(posts[0], 'Changed');
	assert.ok(h.getSource().includes('~~~\n- 11:00 ^sol-tilde-example\n\tExample\n~~~'));
	assert.ok(h.getSource().includes('- 09:00 ^sol-example\n\tExample'));
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

test('edits and task updates keep a space-indented body in its own indentation', async () => {
	const harness = createHarness([
		'## soliloquy',
		'- 10:00 ^sol-target',
		'    - [ ] Task',
		'        nested detail',
		'',
		'    Closing line',
		'## next',
	].join('\n'));
	const target = post({
		content: '- [ ] Task\n    nested detail\n\nClosing line',
		lineStart: 1,
		lineEnd: 6,
	});

	await harness.service.updateTask(target, { markerOffset: 3 }, true);

	assert.equal(harness.getSource(), [
		'## soliloquy',
		'- 10:00 ^sol-target',
		'    - [x] Task',
		'        nested detail',
		'',
		'    Closing line',
		'## next',
	].join('\n'));
});

test('editing keeps the indentation of the first content line', async () => {
	const harness = createHarness(['## soliloquy', '- 10:00 ^sol-target', '\tTarget'].join('\n'));

	await harness.service.updatePost(post({ lineStart: 1, lineEnd: 3 }), '\n    indented code\nnext\n\n');

	assert.equal(harness.getSource(), ['## soliloquy', '- 10:00 ^sol-target', '\t    indented code', '\tnext'].join('\n'));
});

test('editing a post leaves mixed line endings elsewhere in the note untouched', async () => {
	const initial = '# Day\r\nintro\n## soliloquy\r\n- 10:00 ^sol-target\r\n\tTarget\r\n## next\nmore\r\n';
	const harness = createHarness(initial);

	await harness.service.updatePost(post({ lineStart: 3, lineEnd: 5 }), 'Updated');

	assert.equal(harness.getSource(), initial.replace('\tTarget', '\tUpdated'));
});

test('assigning a block ID changes only the first line of a legacy post', async () => {
	const initial = ['## soliloquy', '- 10:00 inline text', '    body line', '', '    second paragraph'].join('\n');
	const harness = createHarness(initial);
	const legacy = post({
		content: 'inline text\nbody line\n\nsecond paragraph',
		blockId: undefined,
		lineStart: 1,
		lineEnd: 5,
	});

	const identified = await harness.service.ensureBlockId(legacy);
	const { blockId } = identified;

	assert.match(blockId, /^sol-[\w-]+$/);
	assert.equal(harness.getSource(), initial.replace('- 10:00 inline text', `- 10:00 ^${blockId} inline text`));
	assert.deepEqual(identified, { ...legacy, blockId, bodyIndent: '    ' });
	assert.equal(legacy.blockId, undefined);
});

test('a post that changed since it was displayed is rejected as a conflict', async () => {
	const harness = createHarness(['## soliloquy', '- 10:00 ^sol-target', '\tChanged'].join('\n'));

	await assert.rejects(
		harness.service.updatePost(post(), 'Updated'),
		{ name: 'PostChangedError' },
	);
});

test('an unreadable daily note is skipped, reported once, and read again later', async (t) => {
	const vault = createVault([
		[FIRST, '## soliloquy\n- 09:00 ^sol-first\n\tFirst'],
		[SECOND, '## soliloquy\n- 10:00 ^sol-second\n\tSecond'],
	]);
	const originalError = console.error;
	const errors = [];
	console.error = (...args) => { errors.push(args); };
	t.after(() => { console.error = originalError; });
	const read = vault.app.vault.cachedRead;
	let unreadable = true;
	vault.app.vault.cachedRead = async (file) => {
		if (unreadable && file.path === FIRST) throw new Error('Read failed');
		return read(file);
	};
	const reported = [];
	vault.service.onReadFailure((paths) => { reported.push(paths); });

	const timeline = await vault.service.getTimeline();
	assert.deepEqual(timeline.posts.map((post) => post.blockId), ['sol-second']);
	assert.deepEqual(reported, [[FIRST]]);
	assert.equal(errors.length, 1);
	assert.match(errors[0][0], /failed to read log\/2026\/07\/2026-07-12\.md/);

	// An incomplete snapshot is not served again, and the failure is not reported twice.
	const retried = await vault.service.getTimeline();
	assert.notEqual(retried, timeline);
	assert.deepEqual(retried.posts.map((post) => post.blockId), ['sol-second']);
	assert.deepEqual(reported, [[FIRST]]);
	assert.equal(vault.reads.get(SECOND), 1);

	unreadable = false;
	const recovered = await vault.service.getTimeline();
	assert.deepEqual(recovered.posts.map((post) => post.blockId), ['sol-second', 'sol-first']);
	assert.equal(await vault.service.getTimeline(), recovered);

	// A note that fails again after recovering is reported again.
	unreadable = true;
	vault.service.fileChanged(vault.file(FIRST));
	await vault.service.flushFileChanges();
	assert.deepEqual((await vault.service.getTimeline()).posts.map((post) => post.blockId), ['sol-second']);
	assert.deepEqual(reported, [[FIRST], [FIRST]]);
});
