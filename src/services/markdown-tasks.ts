import { parser, type BlockContext, type Line, type MarkdownConfig } from '@lezer/markdown';

export interface MarkdownTask {
	/** Offset of the single status character inside the source task marker. */
	markerOffset: number;
}

function isIndentedCode(line: Line): boolean {
	// Obsidian recognizes a leading tab or four literal spaces. A mixed prefix
	// such as two spaces then a tab is not equivalent, even at the same column.
	return /^(?: {4}|\t)/.test(line.text.slice(line.basePos));
}

function startList(context: BlockContext, line: Line, ordered: boolean): false | null {
	const prefix = (ordered ? /^(\d{1,9}\.)( {1,4}(?! )| |\t|$)/ : /^([-+*])( {1,4}(?! )| |\t|$)/).exec(line.text.slice(line.pos));
	if (!prefix) return false;
	const marker = prefix[1]!;
	const type = ordered ? 'OrderedList' : 'BulletList';
	const contentPos = line.pos + prefix[0].length;
	const contentIndent = line.countIndent(contentPos, line.pos, line.indent) + (prefix[2] ? 0 : 1);
	if (context.parentType().name !== type) {
		context.startComposite(type, line.basePos, marker.charCodeAt(marker.length - 1));
	}
	context.startComposite('ListItem', line.basePos, contentIndent - line.baseIndent);
	context.addElement(context.elt('ListMark', context.lineStart + line.pos, context.lineStart + line.pos + marker.length));
	// Only one tab OR up to four spaces belongs to the list prefix. Consuming
	// a following tab as padding would turn an indented code block into a comment.
	line.moveBaseColumn(contentIndent);
	return null;
}

function commentMarker(line: Line): string | undefined {
	if (isIndentedCode(line)) return undefined;
	return /^(%{2,})[^%]*$/.exec(line.text.slice(line.pos))?.[1];
}

function quoteContinues(context: BlockContext, line: Line): boolean {
	let quotes = 0;
	for (let depth = 0; depth < context.depth; depth++) {
		if (context.parentType(depth).name === 'Blockquote') quotes++;
	}
	return line.markers.filter((marker) => context.parser.nodeSet.types[marker.type]?.name === 'QuoteMark').length >= quotes;
}

function isListContinuation(context: BlockContext, line: Line): boolean {
	return context.parentType().name === 'ListItem' && line.indent > line.baseIndent && quoteContinues(context, line);
}

function consumeComment(context: BlockContext, line: Line, marker: string, baseIndent: number, lazy = false): number {
	let to = context.lineStart + line.text.length;
	while (context.nextLine()) {
		if (lazy && line.text.trim() && !quoteContinues(context, line)) break;
		if (line.baseIndent < baseIndent && line.text.trim()) {
			// A shallow continuation may still belong to the preceding list item.
			// A sibling list marker or an unindented line ends that item's comment.
			if (!lazy || line.indent === line.baseIndent || /^(?:[-+*]|\d+\.)(?:[ \t]|$)/.test(line.text.slice(line.pos))) break;
		}
		to = context.lineStart + line.text.length;
		if (line.text.includes(marker)) {
			context.nextLine();
			break;
		}
	}
	return to;
}

// Obsidian's block comments can interrupt paragraphs and contain Markdown
// that must not be parsed as tasks. Preserve literal code/list indentation too.
const obsidianBlocks: MarkdownConfig = {
	defineNodes: [{ name: 'ObsidianComment', block: true }],
	parseBlock: [{
		name: 'BulletList',
		parse: (context, line) => startList(context, line, false),
	}, {
		name: 'OrderedList',
		parse: (context, line) => startList(context, line, true),
	}, {
		name: 'IndentedCode',
		parse(context, line) {
			if (!isIndentedCode(line)) return false;
			const from = context.lineStart + line.basePos;
			const baseIndent = line.baseIndent;
			let to = context.lineStart + line.text.length;
			while (context.nextLine()) {
				if (line.text.trim() && (line.baseIndent < baseIndent || !isIndentedCode(line))) break;
				to = context.lineStart + line.text.length;
			}
			context.addElement(context.elt('CodeBlock', from, to));
			return true;
		},
	}, {
		name: 'ObsidianComment',
		before: 'FencedCode',
		endLeaf: (context, line) => commentMarker(line) !== undefined && !isListContinuation(context, line),
		leaf(context, leaf) {
			if (context.parentType().name !== 'ListItem') return null;
			const baseIndent = leaf.start - context.lineStart;
			return {
				nextLine(context, line, leaf) {
					const marker = commentMarker(line);
					if (!marker || !isListContinuation(context, line)) return false;
					const to = consumeComment(context, line, marker, baseIndent, true);
					context.addLeafElement(leaf, context.elt('Paragraph', leaf.start, to));
					return true;
				},
				finish: () => false,
			};
		},
		parse(context, line) {
			const marker = commentMarker(line);
			if (!marker) return false;
			const from = context.lineStart + line.pos;
			const to = consumeComment(context, line, marker, line.baseIndent);
			context.addElement(context.elt('ObsidianComment', from, to));
			return true;
		},
	}],
};

const taskParser = parser.configure(obsidianBlocks);

export function findMarkdownTasks(content: string): MarkdownTask[] {
	const tasks: MarkdownTask[] = [];
	taskParser.parse(content).iterate({
		enter(node) {
			if (node.name !== 'ListItem') return;
			const listMark = node.node.firstChild;
			const firstBlock = listMark?.nextSibling;
			if (firstBlock?.name !== 'Paragraph') return;
			const from = firstBlock.from;
			if (!listMark || !/^(?: {1,4}|\t)$/.test(content.slice(listMark.to, from))) return;
			// Obsidian recognizes numbered lists with a dot, not a closing parenthesis.
			if (content.slice(listMark.from, listMark.to).endsWith(')')) return;
			// Obsidian accepts any single status character (e.g. [-], [/], [?]),
			// whereas GFM's TaskList extension accepts only space/x/X.
			if (/^\[[^\r\n]\][ \t]/.test(content.slice(from, firstBlock.to))) {
				tasks.push({ markerOffset: from + 1 });
			}
		},
	});
	return tasks;
}
