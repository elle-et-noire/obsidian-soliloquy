import type { TFile } from 'obsidian';
import type { TimelinePost } from '../types';
import { TimelineUserError } from './errors';
import { MarkdownFenceTracker } from './markdown-fence';

export interface TimelineSection {
	lines: string[];
	lineOffset: number;
	insertionOffset: number;
}

interface SourceLine {
	text: string;
	start: number;
}

interface MarkdownHeading {
	lineIndex: number;
	start: number;
	level: number;
	text: string;
}

/** Timeline sections are H2 headings; they end at the next H1 or H2. */
const TIMELINE_HEADING_LEVEL = 2;
// Only unindented headings: indented ones belong to post bodies (list items).
const ATX_HEADING_PATTERN = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_SEQUENCE_PATTERN = /(?:^|[ \t]+)#+$/;
const POST_PATTERN = /^- (\d{2}:\d{2})(?:\s+\^([\w-]+))?(?:\s+(.+))?\s*$/;
const REPLY_LINK_PATTERN = /^\[\[[^\]]*#\^([\w-]+)(?:\|[^\]]+)?\]\]$/;

/** A post being parsed; its end line grows with each body line. */
interface ParsedPost {
	post: Omit<TimelinePost, 'content' | 'lineEnd'>;
	lineEnd: number;
	inline?: string;
	/** Raw continuation lines, with '' for blank lines between them. */
	body: string[];
}

/**
 * Compares heading text the way a reader would: surrounding and repeated
 * whitespace, an ATX closing sequence and letter case are not significant.
 */
export function normalizeHeadingText(text: string): string {
	return text
		.trim()
		.replace(CLOSING_SEQUENCE_PATTERN, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

export function findTimelineSections(source: string, headingText: string): TimelineSection[] {
	const target = normalizeHeadingText(headingText);
	const lines = splitSourceLines(source);
	const headings = findMarkdownHeadings(lines);
	const sections: TimelineSection[] = [];

	for (const [headingIndex, current] of headings.entries()) {
		if (current.level !== TIMELINE_HEADING_LEVEL || current.text !== target) continue;
		const next = headings
			.slice(headingIndex + 1)
			.find((heading) => heading.level <= TIMELINE_HEADING_LEVEL);
		const lineOffset = current.lineIndex + 1;
		const endLine = next?.lineIndex ?? lines.length;
		sections.push({
			lines: lines.slice(lineOffset, endLine).map((line) => line.text),
			lineOffset,
			insertionOffset: next?.start ?? source.length,
		});
	}

	return sections;
}

export function appendPostToTimelineSection(
	source: string,
	headingText: string,
	post: string,
): string {
	const sections = findTimelineSections(source, headingText);
	if (sections.length > 1) {
		throw new TimelineUserError(
			`This daily note has more than one "${headingText.trim()}" section.`,
		);
	}

	const lineEnding = detectLineEnding(source);
	const normalizedPost = post.replace(/\r\n?|\n/g, lineEnding);
	const section = sections[0];
	if (!section) {
		const separator = source.length > 0 && !source.endsWith('\n')
			? `${lineEnding}${lineEnding}`
			: '';
		return `${source}${separator}## ${headingText.trim()}${lineEnding}${lineEnding}${normalizedPost}${lineEnding}`;
	}

	// Insert after the last content line but keep the whitespace that
	// separates the section from the next heading.
	const sectionSource = source.slice(0, section.insertionOffset);
	const contentEnd = sectionSource.replace(/[ \t\r\n]*$/, '').length;
	const trailing = sectionSource.slice(contentEnd);
	const separatorAfter = /\r?\n/.test(trailing) ? trailing.replace(/^[ \t]*\r?\n/, '') : '';
	return `${source.slice(0, contentEnd)}${lineEnding}${normalizedPost}${lineEnding}`
		+ `${separatorAfter}${source.slice(section.insertionOffset)}`;
}

/**
 * Replaces source lines [lineStart, lineEnd) and leaves every other character,
 * including mixed line endings, untouched.
 */
export function replaceSourceLines(
	source: string,
	lineStart: number,
	lineEnd: number,
	replacement: string[],
): string {
	const lines = splitSourceLines(source);
	const first = lines[lineStart];
	if (!first || lineEnd <= lineStart || lineEnd > lines.length) {
		throw new Error('The post range is outside the note.');
	}
	const endOffset = lines[lineEnd]?.start ?? source.length;
	const replaced = source.slice(first.start, endOffset);
	const lineEnding = replaced.match(/\r\n|\n/)?.[0] ?? detectLineEnding(source);
	const trailingBreak = replaced.match(/\r?\n$/)?.[0] ?? '';
	return `${source.slice(0, first.start)}${replacement.join(lineEnding)}${trailingBreak}`
		+ source.slice(endOffset);
}

/** Parses the posts in every timeline section of a daily note. */
export function parseTimelinePosts(
	source: string,
	headingText: string,
	date: string,
	file: TFile,
): TimelinePost[] {
	return findTimelineSections(source, headingText).flatMap((section) =>
		parsePosts(section.lines, section.lineOffset, date, file));
}

/** Parses the posts in one timeline section's lines, starting at source line lineOffset. */
export function parsePosts(
	lines: string[],
	lineOffset: number,
	date: string,
	file: TFile,
): TimelinePost[] {
	const posts: TimelinePost[] = [];
	let current: ParsedPost | null = null;
	let blankLines = 0;
	const fence = new MarkdownFenceTracker();

	for (const [index, line] of lines.entries()) {
		// Stored body lines belong to the post, including its indented code fences.
		if (current && (line.startsWith('\t') || line.startsWith('  '))) {
			for (let blank = 0; blank < blankLines; blank++) current.body.push('');
			current.body.push(line);
			current.lineEnd = lineOffset + index + 1;
			blankLines = 0;
			continue;
		}
		if (!line.trim()) {
			if (current) blankLines++;
			continue;
		}
		// Never extend a replacement range across unrelated paragraphs or lists.
		if (current) posts.push(withReplyMetadata(finishPost(current)));
		current = null;
		blankLines = 0;
		if (fence.consume(line)) continue;
		const match = POST_PATTERN.exec(line);
		if (match?.[1]) {
			current = {
				post: {
					date,
					time: match[1],
					file,
					lineStart: lineOffset + index,
					blockId: match[2],
				},
				lineEnd: lineOffset + index + 1,
				inline: match[3],
				body: [],
			};
			continue;
		}
	}

	if (current) posts.push(withReplyMetadata(finishPost(current)));
	return posts;
}

/** Formats a post as its source lines, joined with '\n'. */
export function formatPost(
	time: string,
	content: string,
	blockId: string,
	replyLink?: string,
	indent = '\t',
): string {
	// Tab-indented posts keep their historic tab-only blank lines.
	const indentLine = (line: string) => (line || indent === '\t' ? `${indent}${line}` : '');
	return [
		`- ${time} ^${blockId}`,
		...(replyLink ? [indentLine(replyLink)] : []),
		...content.split('\n').map(indentLine),
	].join('\n');
}

/**
 * Replaces a post's source lines with formatted post text (lines joined with
 * '\n') and returns the new source and the post's new end line.
 */
export function replacePost(
	source: string,
	post: Pick<TimelinePost, 'lineStart' | 'lineEnd'>,
	formatted: string,
): { source: string; lineEnd: number } {
	const replacement = formatted.split('\n');
	return {
		source: replaceSourceLines(source, post.lineStart, post.lineEnd, replacement),
		lineEnd: post.lineStart + replacement.length,
	};
}

/**
 * Adds a block ID to a post's first line and leaves its body untouched.
 * Returns null when that line is no longer a post line.
 */
export function addPostBlockId(
	source: string,
	post: Pick<TimelinePost, 'lineStart'>,
	blockId: string,
): string | null {
	const firstLine = splitSourceLines(source)[post.lineStart]?.text ?? '';
	const identified = firstLine.replace(/^- (\d{2}:\d{2})/, `- $1 ^${blockId}`);
	if (identified === firstLine) return null;
	return replaceSourceLines(source, post.lineStart, post.lineStart + 1, [identified]);
}

/** Removes one indentation unit and remembers it so edits can write it back. */
function finishPost({ post, lineEnd, inline, body }: ParsedPost): TimelinePost {
	const indented = body.filter((line) => line.trim());
	const spaceWidths = indented
		.filter((line) => line.startsWith(' '))
		.map((line) => line.length - line.trimStart().length);
	const spaceUnit = spaceWidths.length > 0 ? Math.min(...spaceWidths) : 2;
	const bodyIndent = indented[0]?.startsWith(' ') ? ' '.repeat(spaceUnit) : '\t';
	const bodyLines = body.map((line) => {
		if (line.startsWith('\t')) return line.slice(1);
		const width = line.length - line.trimStart().length;
		return line.slice(Math.min(width, spaceUnit));
	});
	// Without inline text, blank lines before the first body line are not content.
	const firstBody = bodyLines.findIndex((line) => line !== '');
	const parts = inline === undefined
		? (firstBody < 0 ? [] : bodyLines.slice(firstBody))
		: [inline, ...bodyLines];
	return {
		...post,
		content: parts.join('\n'),
		lineEnd,
		...(body.length > 0 ? { bodyIndent } : {}),
	};
}

function withReplyMetadata(post: TimelinePost): TimelinePost {
	const lines = post.content.split('\n');
	const match = lines[0] ? REPLY_LINK_PATTERN.exec(lines[0]) : null;
	if (!match?.[1]) return post;
	return {
		...post,
		content: lines.slice(1).join('\n'),
		replyToBlockId: match[1],
		replyLink: lines[0],
	};
}

function splitSourceLines(source: string): SourceLine[] {
	const lines = source.split(/\r?\n/);
	let offset = 0;
	return lines.map((text) => {
		const line = { text, start: offset };
		offset += text.length;
		if (source.startsWith('\r\n', offset)) {
			offset += 2;
		} else if (source[offset] === '\n') {
			offset += 1;
		}
		return line;
	});
}

function findMarkdownHeadings(lines: SourceLine[]): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	const fence = new MarkdownFenceTracker();
	const comments = new CommentTracker();

	for (const [lineIndex, line] of lines.entries()) {
		if (comments.consume(line.text)) continue;
		if (fence.consume(line.text)) continue;
		comments.open(line.text);

		const match = ATX_HEADING_PATTERN.exec(line.text);
		if (match?.[1]) {
			headings.push({
				lineIndex,
				start: line.start,
				level: match[1].length,
				text: normalizeHeadingText(match[2] ?? ''),
			});
		}
	}

	return headings;
}

/** Tracks Obsidian `%%` and HTML comment blocks that span lines. */
class CommentTracker {
	private closing?: '%%' | '-->';

	/** Returns true when the line starts inside a comment. */
	consume(line: string): boolean {
		if (!this.closing) return false;
		const end = line.indexOf(this.closing);
		if (end < 0) return true;
		const rest = line.slice(end + this.closing.length);
		this.closing = undefined;
		this.open(rest);
		return true;
	}

	/** Records a comment that opens on this line and does not close on it. */
	open(line: string): void {
		let index = 0;
		while (index < line.length) {
			const obsidian = line.indexOf('%%', index);
			const html = line.indexOf('<!--', index);
			if (obsidian < 0 && html < 0) return;
			const useObsidian = obsidian >= 0 && (html < 0 || obsidian < html);
			const openEnd = useObsidian ? obsidian + 2 : html + 4;
			const closing = useObsidian ? '%%' : '-->';
			const close = line.indexOf(closing, openEnd);
			if (close < 0) {
				this.closing = closing;
				return;
			}
			index = close + closing.length;
		}
	}
}

export function detectLineEnding(source: string): '\n' | '\r\n' {
	return source.match(/\r\n|\n/)?.[0] === '\r\n' ? '\r\n' : '\n';
}
