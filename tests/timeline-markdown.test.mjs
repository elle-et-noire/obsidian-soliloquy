import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
	entryPoints: ['src/services/timeline-markdown.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Timeline Markdown test bundle was not generated.');
const {
	addPostBlockId,
	appendPostToTimelineSection,
	findTimelineSections,
	formatPost,
	parsePosts,
	parseTimelinePosts,
	replacePost,
	replaceSourceLines,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('an H1 after the timeline section ends it for reading and appending', () => {
	const note = [
		'## soliloquy',
		'',
		'- 09:00 ^a',
		'\tpost',
		'',
		'# Schedule',
		'- 10:00 meeting with Bob',
		'',
	].join('\n');

	const [section] = findTimelineSections(note, 'soliloquy');
	assert.ok(section);
	assert.ok(!section.lines.includes('- 10:00 meeting with Bob'));

	const updated = appendPostToTimelineSection(note, 'soliloquy', '- 11:00 ^b\n\tnew');
	assert.equal(updated, [
		'## soliloquy',
		'',
		'- 09:00 ^a',
		'\tpost',
		'- 11:00 ^b',
		'\tnew',
		'',
		'# Schedule',
		'- 10:00 meeting with Bob',
		'',
	].join('\n'));
});

test('H3 and deeper headings stay inside the timeline section', () => {
	const note = ['## soliloquy', '- 09:00 ^a', '### Notes', 'text', '## Next'].join('\n');
	const [section] = findTimelineSections(note, 'soliloquy');
	assert.deepEqual(section?.lines, ['- 09:00 ^a', '### Notes', 'text']);
});

test('heading matching ignores spacing, a closing sequence and letter case', () => {
	for (const heading of ['## soliloquy ', '##  soliloquy', '## Soliloquy', '## soliloquy ##', '##\tsoliloquy']) {
		const note = `${heading}\n- 09:00 ^a\n\tpost\n`;
		assert.equal(findTimelineSections(note, 'soliloquy').length, 1, JSON.stringify(heading));
		const updated = appendPostToTimelineSection(note, 'soliloquy', '- 10:00 ^b\n\tnew');
		assert.equal(updated.split('\n').filter((line) => line.startsWith('##')).length, 1, JSON.stringify(heading));
	}
	assert.equal(findTimelineSections('## soliloquy archive\n', 'soliloquy').length, 0);
	assert.equal(findTimelineSections('### soliloquy\n', 'soliloquy').length, 0);
	assert.equal(findTimelineSections('##soliloquy\n', 'soliloquy').length, 0);
});

test('headings inside Obsidian and HTML comments are not sections', () => {
	const note = [
		'%%',
		'## soliloquy',
		'%%',
		'<!--',
		'## soliloquy',
		'-->',
		'## soliloquy',
		'- 09:00 ^a',
		'\tpost',
		'%% inline %% text',
		'## Next',
	].join('\n');
	const sections = findTimelineSections(note, 'soliloquy');
	assert.equal(sections.length, 1);
	assert.equal(sections[0]?.lineOffset, 7);
	assert.ok(!sections[0]?.lines.includes('## Next'));
	assert.doesNotThrow(() => appendPostToTimelineSection(note, 'soliloquy', '- 10:00 ^b'));
});

test('indented headings in post bodies do not end the section', () => {
	const note = ['## soliloquy', '- 09:00 ^a', '  # Title in a post', '  body', '## Next'].join('\n');
	const [section] = findTimelineSections(note, 'soliloquy');
	assert.deepEqual(section?.lines, ['- 09:00 ^a', '  # Title in a post', '  body']);
});

test('appending keeps the blank lines before the next heading', () => {
	const note = '## soliloquy\n\n- 09:00 ^a\n\tpost\n\n\n## Tasks\n- [ ] one\n';
	assert.equal(
		appendPostToTimelineSection(note, 'soliloquy', '- 10:00 ^b\n\tnew'),
		'## soliloquy\n\n- 09:00 ^a\n\tpost\n- 10:00 ^b\n\tnew\n\n\n## Tasks\n- [ ] one\n',
	);
	assert.equal(
		appendPostToTimelineSection('## soliloquy\n- 09:00 ^a', 'soliloquy', '- 10:00 ^b'),
		'## soliloquy\n- 09:00 ^a\n- 10:00 ^b\n',
	);
});

test('a missing section is created with the configured heading text', () => {
	assert.equal(
		appendPostToTimelineSection('# Day', ' soliloquy ', '- 10:00 ^b'),
		'# Day\n\n## soliloquy\n\n- 10:00 ^b\n',
	);
});

test('replacing lines leaves other line endings untouched', () => {
	const note = 'a\r\nb\nc\r\nd\ne';
	assert.equal(replaceSourceLines(note, 1, 3, ['x', 'y', 'z']), 'a\r\nx\ny\nz\r\nd\ne');
	assert.equal(replaceSourceLines(note, 4, 5, ['last']), 'a\r\nb\nc\r\nd\nlast');
	assert.equal(replaceSourceLines(note, 0, 1, ['first']), 'first\r\nb\nc\r\nd\ne');
	assert.throws(() => replaceSourceLines(note, 4, 6, ['x']), /outside the note/);
});

const FILE = { path: 'log/2026-07-13.md' };

function parseNote(note) {
	return parseTimelinePosts(note, 'soliloquy', '2026-07-13', FILE);
}

test('parsing reads time, block ID, inline text, body and source range', () => {
	const posts = parsePosts(['- 09:00 ^a inline', '\tbody', '- 10:00', '\tsecond'], 5, '2026-07-13', FILE);
	assert.deepEqual(posts, [
		{
			date: '2026-07-13',
			time: '09:00',
			content: 'inline\nbody',
			file: FILE,
			lineStart: 5,
			lineEnd: 7,
			blockId: 'a',
			bodyIndent: '\t',
		},
		{
			date: '2026-07-13',
			time: '10:00',
			content: 'second',
			file: FILE,
			lineStart: 7,
			lineEnd: 9,
			blockId: undefined,
			bodyIndent: '\t',
		},
	]);
});

test('parsing keeps blank lines inside a body but not before or after it', () => {
	const [post] = parsePosts(['- 09:00 ^a', '', '\tfirst', '', '', '\tsecond', '', 'paragraph'], 0, 'd', FILE);
	assert.equal(post?.content, 'first\n\n\nsecond');
	assert.equal(post?.lineEnd, 6);
	const [inline] = parsePosts(['- 09:00 ^a text', '', '\tbody'], 0, 'd', FILE);
	assert.equal(inline?.content, 'text\n\nbody');
});

test('parsing removes one space indentation unit and remembers it', () => {
	const [four] = parsePosts(['- 09:00 ^a', '    one', '        nested', '    two'], 0, 'd', FILE);
	assert.equal(four?.content, 'one\n    nested\ntwo');
	assert.equal(four?.bodyIndent, '    ');
	const [two] = parsePosts(['- 09:00 ^a', '  one', '    - nested'], 0, 'd', FILE);
	assert.equal(two?.content, 'one\n  - nested');
	assert.equal(two?.bodyIndent, '  ');
	const [none] = parsePosts(['- 09:00 ^a only inline'], 0, 'd', FILE);
	assert.equal(none?.content, 'only inline');
	assert.equal(none?.bodyIndent, undefined);
});

test('parsing separates a reply link from the content', () => {
	const [post] = parsePosts(['- 09:00 ^b', '\t[[log/2026-07-12#^a|parent]]', '\treply'], 0, 'd', FILE);
	assert.equal(post?.content, 'reply');
	assert.equal(post?.replyLink, '[[log/2026-07-12#^a|parent]]');
	assert.equal(post?.replyToBlockId, 'a');
});

test('parsing ends a post at unindented text and skips fenced examples', () => {
	const posts = parsePosts([
		'- 09:00 ^a',
		'\tpost',
		'paragraph',
		'```',
		'- 10:00 ^example',
		'```',
		'- 11:00 ^c',
	], 0, 'd', FILE);
	assert.deepEqual(posts.map((post) => [post.blockId, post.lineStart, post.lineEnd]), [['a', 0, 2], ['c', 6, 7]]);
});

test('unclosed and mismatched fences cannot produce editable posts', () => {
	for (const opening of ['```md', '~~~~']) {
		const lines = [opening, '- 10:00 ^sol-example', '\tExample', '~~~', '- 11:00 ^sol-example2'];
		assert.deepEqual(parsePosts(lines, 1, '2026-07-13', FILE), []);
	}
});

test('parsing a note reads every timeline section with source line numbers', () => {
	const note = '# Day\r\n## soliloquy\r\n- 09:00 ^a\r\n\tone\r\n## Other\r\n- 10:00 ^x\r\n## Soliloquy\r\n- 11:00 ^b\r\n';
	assert.deepEqual(parseNote(note).map((post) => [post.blockId, post.content, post.lineStart, post.lineEnd]), [
		['a', 'one', 2, 4],
		['b', '', 7, 8],
	]);
});

test('formatting indents the body and reply link with the given unit', () => {
	assert.equal(formatPost('09:00', 'one\n\ntwo', 'a'), '- 09:00 ^a\n\tone\n\t\n\ttwo');
	assert.equal(
		formatPost('09:00', 'one\n\n  nested', 'a', '[[n#^p]]', '  '),
		'- 09:00 ^a\n  [[n#^p]]\n  one\n\n    nested',
	);
});

test('replacing a post splices only its lines and keeps their line ending', () => {
	const note = '## soliloquy\r\n- 09:00 ^a\r\n\told\r\n- 10:00 ^b\r\n\tkeep\nafter';
	const [post] = parseNote(note);
	assert.ok(post);
	const replaced = replacePost(note, post, formatPost(post.time, 'new\nlines', 'a'));
	assert.equal(replaced.source, '## soliloquy\r\n- 09:00 ^a\r\n\tnew\r\n\tlines\r\n- 10:00 ^b\r\n\tkeep\nafter');
	assert.equal(replaced.lineEnd, 4);
	assert.deepEqual(parseNote(replaced.source).map((item) => item.content), ['new\nlines', 'keep']);
});

test('formatting a parsed post writes back its exact source', () => {
	const note = '## soliloquy\n- 09:00 ^a\n    one\n\n        nested\n    [[x#^p]]\n- 10:00 ^b\n\tone\n\t\n\ttwo\n';
	for (const post of parseNote(note)) {
		const formatted = formatPost(post.time, post.content, post.blockId, post.replyLink, post.bodyIndent);
		assert.equal(replacePost(note, post, formatted).source, note);
	}
});

test('adding a block ID changes only the post line', () => {
	const note = '## soliloquy\r\n- 09:00 text\r\n  body\n';
	assert.equal(addPostBlockId(note, { lineStart: 1 }, 'sol-1'), '## soliloquy\r\n- 09:00 ^sol-1 text\r\n  body\n');
	assert.equal(addPostBlockId(note, { lineStart: 2 }, 'sol-1'), null);
	assert.equal(addPostBlockId(note, { lineStart: 9 }, 'sol-1'), null);
});
