import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const result = await build({
	entryPoints: ['src/services/markdown-tasks.ts'],
	bundle: true, format: 'esm', write: false,
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Markdown task test bundle was not generated.');
const { findMarkdownTasks } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('Obsidian task statuses map to their exact source offsets in nested and ordered lists', () => {
	const lines = ['- [ ] Todo', '  - [-] Cancelled', '  - [/] Doing', '', '> 1. [?] Question', '', '1. [あ] Custom'];
	for (const newline of ['\n', '\r\n']) {
		const content = lines.join(newline);
		assert.deepEqual(findMarkdownTasks(content), lines.filter(line => line).map(line => ({
			markerOffset: content.indexOf(line) + line.indexOf('[') + 1,
		})));
	}
});

test('Obsidian block comments hide tasks and stop at the closing marker or container end', () => {
	const fixtures = [
		'%%\n- [ ] Hidden\n%%\n\n- [ ] Visible',
		'text\n%%\n- [ ] Hidden\n%%\n- [ ] Visible',
		'> %%\n> - [ ] Hidden\n> %%\n\n- [ ] Visible',
		'> %%\n> - [ ] Hidden\n\n- [ ] Visible',
		'- parent\n  %%\n  - [ ] Hidden\n  %%\n- [ ] Visible',
		'- parent\n  %%\n  - [ ] Hidden\n\n- [ ] Visible',
		'- %%\n  - [ ] Hidden\n- [ ] Visible',
		'%%%note\n- [ ] Hidden\n%%\n- [ ] Still hidden\n%%%\n- [ ] Visible',
		'- [ ] Visible\n\n%%\n- [ ] Hidden',
	];
	for (const fixture of fixtures) {
		for (const newline of ['\n', '\r\n']) {
			const content = fixture.replaceAll('\n', newline);
			assert.deepEqual(findMarkdownTasks(content), [{ markerOffset: content.indexOf('[ ] Visible') + 1 }], content);
		}
	}
	assert.deepEqual(findMarkdownTasks('%%\n- [ ] Hidden'), []);
});

test('code, inline comments and non-task paragraphs cannot introduce or hide source tasks', () => {
	for (const prefix of [
		'```md\n%%\n- [ ] Example\n```',
		'    %%\n    - [ ] Example',
		'- parent\n  ~~~\n  %%\n  - [ ] Example\n  ~~~',
		'%%inline comment%%',
		'- %%inline comment%% [ ] Plain',
		'- parent\n\n  [ ] Plain',
		'- [ ]\n  Plain\n- [-]\n- [ab] Plain',
	]) {
		const content = `${prefix}\n\n- [ ] Visible`;
		assert.deepEqual(findMarkdownTasks(content), [{ markerOffset: content.indexOf('[ ] Visible') + 1 }], content);
	}
});

test('tabs in quote comments retain the visible task and its original source offset', () => {
	for (const newline of ['\n', '\r\n']) {
		const content = ['> \t%%', '> - [ ] Visible', '> %%', '> - [ ] Hidden'].join(newline);
		assert.deepEqual(findMarkdownTasks(content), [{ markerOffset: content.indexOf('[ ] Visible') + 1 }]);
	}
});

test('task markers must follow their list marker on the same source line', () => {
	for (const bullet of ['-', '*', '+', '1.']) {
		for (const status of [' ', 'x', '-', '/', '?']) {
			for (const quote of ['', '> ']) {
				const content = `${quote}${bullet}\n${quote}  [${status}] Plain text\n\n- [ ] Real task`;
				assert.deepEqual(findMarkdownTasks(content), [{ markerOffset: content.indexOf('[ ] Real task') + 1 }], content);
				const task = `${quote}${bullet} [${status}] Real task`;
				assert.deepEqual(findMarkdownTasks(task), [{ markerOffset: task.indexOf('[') + 1 }], task);
			}
		}
	}
});

test('parenthesized numbers remain plain text under Obsidian task rules', () => {
	for (const status of [' ', 'x', '-', '/', '?']) {
		const content = `1) [${status}] Plain text\n\n- [ ] Real task`;
		assert.deepEqual(findMarkdownTasks(content), [{ markerOffset: content.indexOf('[ ] Real task') + 1 }]);
	}
});

test('shallow list comments end before the next sibling task', () => {
	for (let listIndent = 0; listIndent <= 3; listIndent++) {
		for (let commentIndent = 1; commentIndent <= 5; commentIndent++) {
			const content = `Text\n\n${' '.repeat(listIndent)}- [ ] A\n${' '.repeat(commentIndent)}%%\n- [ ] B`;
			assert.deepEqual(findMarkdownTasks(content), ['A', 'B'].map(label => ({ markerOffset: content.indexOf(`[ ] ${label}`) + 1 })), content);
		}
	}
});

test('list comments respect empty siblings, nested tasks and the surrounding quote boundary', () => {
	const fixtures = [
		['- [ ] A\n %%\n  - [ ] Hidden\n %%\n- [ ] B', ['A', 'B']],
		['- [ ] A\n %%\n -\n   - [ ] Nested sibling\n- [ ] B', ['A', 'Nested sibling', 'B']],
		['> - [ ] A\n  %%\n- [ ] Hidden', ['A']],
		['> > - [ ] A\n>   %%\n> - [ ] Hidden', ['A']],
		['> - [ ] A\n>  %%\n> - [ ] B', ['A', 'B']],
		['>\t- [ ] Code\n\n- [ ] B', ['B']],
	];
	for (const [content, labels] of fixtures) {
		assert.deepEqual(findMarkdownTasks(content), labels.map(label => ({ markerOffset: content.indexOf(`[ ] ${label}`) + 1 })), content);
	}
});

test('quote indentation preserves the order of spaces and tabs', () => {
	for (let before = 0; before <= 6; before++) {
		for (let after = 0; after <= 5; after++) {
			const content = `>${' '.repeat(before)}\t${' '.repeat(after)}- [ ] A\n\n- [ ] B`;
			const labels = before >= 2 && before <= 4 ? ['A', 'B'] : ['B'];
			assert.deepEqual(findMarkdownTasks(content), labels.map(label => ({ markerOffset: content.indexOf(`[ ] ${label}`) + 1 })), content);
		}
	}
	for (const gap of [' \t', '\t ']) {
		const content = `-${gap}[ ] Plain text\n\n- [ ] Task`;
		assert.deepEqual(findMarkdownTasks(content), [{ markerOffset: content.indexOf('[ ] Task') + 1 }]);
	}
});

test('a tab after list padding starts code instead of a block comment', () => {
	for (const marker of ['-', '*', '+', '1.']) {
		for (const quote of ['', '> ']) {
			for (const newline of ['\n', '\r\n']) {
				const content = [`${quote}${marker} \t%%`, `${quote}    - [ ] Nested`, '', '- [ ] Sibling'].join(newline);
				assert.deepEqual(findMarkdownTasks(content), ['Nested', 'Sibling'].map(label => ({
					markerOffset: content.indexOf(`[ ] ${label}`) + 1,
				})), content);
			}
		}
	}
});
