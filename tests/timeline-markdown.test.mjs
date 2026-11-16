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
	appendPostToTimelineSection,
	findTimelineSections,
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
