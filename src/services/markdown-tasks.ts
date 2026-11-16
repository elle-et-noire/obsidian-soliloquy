export interface MarkdownTask {
	/** Offset of the single status character inside the source task marker. */
	markerOffset: number;
}

interface HiddenBlock {
	kind: 'fence' | 'comment';
	marker: string;
	quotes: number;
	/** Lines indented less than this, or with fewer quote markers, end the block's container. */
	indent: number;
}

const QUOTE_PREFIX = /^(?: {0,3}>[ ]?)*/;
// Obsidian accepts any single status character (e.g. [-], [/], [?]) and
// numbered lists with a dot, not a closing parenthesis.
const TASK_PREFIX = /^(?:[-+*]|\d{1,9}\.)(?: {1,4}|\t)(?=\[[^\r\n]\][ \t])/;
const LIST_PREFIX = /^(?:[-+*]|\d{1,9}[.)])(?: {1,4}|\t|$)/;

/**
 * Lists source task markers in document order as candidates for the rendered
 * checkboxes. This is a line-based approximation that skips fenced code,
 * indented code and Obsidian block comments; it is only a hint. Callers that
 * write a task must verify the position with Obsidian's renderer.
 */
export function findMarkdownTasks(content: string): MarkdownTask[] {
	const tasks: MarkdownTask[] = [];
	let hidden: HiddenBlock | undefined;
	let listOpen = false;
	let previousBlank = true;
	let indentedCode = false;
	let lineStart = 0;
	for (const segment of content.split('\n')) {
		const start = lineStart;
		lineStart += segment.length + 1;
		const text = segment.endsWith('\r') ? segment.slice(0, -1) : segment;
		const quote = QUOTE_PREFIX.exec(text)![0];
		const quotes = quote.split('>').length - 1;
		const rest = text.slice(quote.length);
		const body = rest.trimStart();
		const indent = columns(rest.slice(0, rest.length - body.length));
		const blank = body === '';

		if (hidden && !blank && (quotes < hidden.quotes || indent < hidden.indent)) hidden = undefined;
		if (hidden) {
			if (hidden.kind === 'fence' ? closesFence(body, hidden.marker) : body.includes(hidden.marker)) hidden = undefined;
			previousBlank = blank;
			continue;
		}
		if (blank) {
			previousBlank = true;
			continue;
		}
		if (indent >= 4 && !listOpen && (previousBlank || indentedCode)) {
			indentedCode = true;
			previousBlank = false;
			continue;
		}
		indentedCode = false;

		const list = LIST_PREFIX.exec(body)?.[0];
		if (list !== undefined) listOpen = true;
		else if (indent === 0 && previousBlank) listOpen = false;
		previousBlank = false;

		const task = TASK_PREFIX.exec(body)?.[0];
		if (task !== undefined) {
			tasks.push({ markerOffset: start + text.length - body.length + task.length + 1 });
			continue;
		}
		// A list item's content may itself open a fence or comment. Content
		// after extra padding is code, not a block opener.
		const opener = list === undefined ? body : body.slice(list.length);
		const marker = hiddenBlockMarker(opener);
		if (!marker) continue;
		hidden = {
			kind: marker.startsWith('%') ? 'comment' : 'fence',
			marker,
			quotes,
			indent: list !== undefined ? indent + list.length : listOpen ? indent : 0,
		};
	}
	return tasks;
}

function hiddenBlockMarker(text: string): string | undefined {
	const comment = /^(%{2,})[^%]*$/.exec(text)?.[1];
	if (comment) return comment;
	const fence = /^(`{3,}|~{3,})(.*)$/.exec(text);
	if (!fence || (fence[1]![0] === '`' && fence[2]!.includes('`'))) return undefined;
	return fence[1];
}

function closesFence(text: string, marker: string): boolean {
	const closing = /^(`+|~+)[ \t]*$/.exec(text)?.[1];
	return closing !== undefined && closing[0] === marker[0] && closing.length >= marker.length;
}

function columns(whitespace: string): number {
	let column = 0;
	for (const character of whitespace) column = character === '\t' ? column + 4 - (column % 4) : column + 1;
	return column;
}
