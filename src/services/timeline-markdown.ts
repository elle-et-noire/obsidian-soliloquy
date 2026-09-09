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
	text: string;
}

const H2_PATTERN = /^##(?:[ \t]+|$)/;

export function findTimelineSections(source: string, heading: string): TimelineSection[] {
	const lines = splitSourceLines(source);
	const headings = findMarkdownHeadings(lines);
	const sections: TimelineSection[] = [];

	for (const [headingIndex, current] of headings.entries()) {
		if (current.text !== heading) continue;
		const next = headings[headingIndex + 1];
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
	heading: string,
	post: string,
): string {
	const sections = findTimelineSections(source, heading);
	if (sections.length > 1) {
		throw new Error(`Multiple timeline sections named "${heading}" were found.`);
	}

	const lineEnding = detectLineEnding(source);
	const normalizedPost = post.replace(/\r\n?|\n/g, lineEnding);
	const section = sections[0];
	if (!section) {
		const separator = source.length > 0 && !source.endsWith('\n')
			? `${lineEnding}${lineEnding}`
			: '';
		return `${source}${separator}${heading}${lineEnding}${lineEnding}${normalizedPost}${lineEnding}`;
	}

	const before = source.slice(0, section.insertionOffset).replace(/[ \t\r\n]*$/, '');
	const after = source.slice(section.insertionOffset);
	return `${before}${lineEnding}${normalizedPost}${lineEnding}${after}`;
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

	for (const [lineIndex, line] of lines.entries()) {
		if (fence.consume(line.text)) continue;

		if (H2_PATTERN.test(line.text)) {
			headings.push({ lineIndex, start: line.start, text: line.text });
		}
	}

	return headings;
}

export function detectLineEnding(source: string): '\n' | '\r\n' {
	return source.match(/\r\n|\n/)?.[0] === '\r\n' ? '\r\n' : '\n';
}
