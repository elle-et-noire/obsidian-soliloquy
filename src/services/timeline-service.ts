import { App, moment, TFile } from 'obsidian';
import type { SoliloquySettings } from '../settings';
import type { TimelinePost } from '../types';
import { buildDailyNotePath, parseDailyNoteDate } from './daily-note-path';
import { PostChangedError } from './errors';
import { MarkdownFenceTracker } from './markdown-fence';
import { findMarkdownTasks, type MarkdownTask } from './markdown-tasks';
import {
	appendPostToTimelineSection,
	findTimelineSections,
	replaceSourceLines,
} from './timeline-markdown';

const POST_PATTERN = /^- (\d{2}:\d{2})(?:\s+\^([\w-]+))?(?:\s+(.+))?\s*$/;
const REPLY_LINK_PATTERN = /^\[\[[^\]]*#\^([\w-]+)(?:\|[^\]]+)?\]\]$/;

export class TimelineService {
	private readonly postsByFile = new Map<string, TimelinePost[]>();
	private readonly pendingReads = new Map<string, Promise<TimelinePost[]>>();
	private readonly fileVersions = new Map<string, number>();
	/** Daily-note dates by path; cleared when settings change (invalidateAll). */
	private readonly datesByPath = new Map<string, string | null>();
	private cacheEpoch = 0;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => SoliloquySettings,
	) {}

	isDailyNote(file: TFile): boolean {
		return file.extension === 'md' && this.dateFromPath(file.path) !== null;
	}

	invalidateFile(file: TFile): void {
		this.invalidatePath(file.path);
	}

	invalidatePath(path: string): void {
		this.postsByFile.delete(path);
		this.pendingReads.delete(path);
		this.fileVersions.set(path, (this.fileVersions.get(path) ?? 0) + 1);
	}

	invalidateAll(): void {
		this.cacheEpoch += 1;
		this.postsByFile.clear();
		this.pendingReads.clear();
		this.fileVersions.clear();
		this.datesByPath.clear();
	}

	async addPost(content: string): Promise<void> {
		await this.appendPost(content);
	}

	async addReply(parent: TimelinePost, content: string): Promise<void> {
		const parentId = await this.ensureBlockId(parent);
		const target = parent.file.path.replace(/\.md$/, '');
		await this.appendPost(content, `[[${target}#^${parentId}]]`);
	}

	private async appendPost(content: string, replyLink?: string): Promise<void> {
		const text = normalizePostContent(content);
		if (!text) return;

		const file = await this.getOrCreateTodayNote();
		const line = this.formatPost(moment().format('HH:mm'), text, this.createBlockId(), replyLink);
		const heading = this.getSettings().sectionHeading;

		await this.app.vault.process(file, (source) =>
			appendPostToTimelineSection(source, heading, line));
		this.invalidateFile(file);
	}

	async updatePost(post: TimelinePost, content: string): Promise<void> {
		const text = normalizePostContent(content);
		if (!text) return;
		const proposedBlockId = post.blockId ?? this.createBlockId();
		let updatedPost: TimelinePost | undefined;

		await this.app.vault.process(post.file, (source) => {
			const current = this.findCurrentPost(
				source,
				post,
				true,
				'The post changed before it could be edited.',
			);
			const blockId = current.blockId ?? proposedBlockId;
			const replacement = this.formatPost(
				current.time,
				text,
				blockId,
				current.replyLink,
				current.bodyIndent,
			).split('\n');
			updatedPost = {
				...current,
				content: text,
				blockId,
				lineEnd: current.lineStart + replacement.length,
			};
			return this.replacePost(source, current, replacement);
		});

		if (!updatedPost) throw new Error('The post could not be updated.');
		Object.assign(post, updatedPost);
		this.invalidateFile(post.file);
	}

	async updateTask(post: TimelinePost, task: MarkdownTask, checked: boolean, options?: { verifiedByRenderer: boolean }): Promise<void> {
		const offset = task.markerOffset;
		// A renderer-verified position also handles Obsidian syntax that Lezer
		// cannot classify. The caller must verify the exact post snapshot first.
		if (!Number.isInteger(offset) || offset < 1 || !/^\[[^\r\n]\][ \t]/.test(post.content.slice(offset - 1))
			|| (!options?.verifiedByRenderer && !findMarkdownTasks(post.content).some((item) => item.markerOffset === offset))) {
			throw new Error('The task could not be found in the post.');
		}
		const content = post.content.slice(0, offset)
			+ (checked ? 'x' : ' ') + post.content.slice(offset + 1);
		await this.updatePost(post, content);
	}

	async getPosts(): Promise<TimelinePost[]> {
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isDailyNote(file));
		const currentPaths = new Set(files.map((file) => file.path));
		for (const path of this.postsByFile.keys()) {
			if (!currentPaths.has(path)) this.postsByFile.delete(path);
		}

		const posts = (await Promise.all(files.map((file) => this.getFilePosts(file)))).flat();

		return posts.sort((a, b) => {
			const chronological = `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`);
			if (chronological !== 0) return chronological;
			if (a.file.path === b.file.path) return b.lineStart - a.lineStart;
			return b.file.path.localeCompare(a.file.path);
		});
	}

	private async getFilePosts(file: TFile): Promise<TimelinePost[]> {
		const cached = this.postsByFile.get(file.path);
		if (cached) return cached;
		const pending = this.pendingReads.get(file.path);
		if (pending) return pending;

		const version = this.fileVersions.get(file.path) ?? 0;
		const epoch = this.cacheEpoch;
		const read = this.readFilePosts(file);
		this.pendingReads.set(file.path, read);

		try {
			const posts = await read;
			if (epoch === this.cacheEpoch && version === (this.fileVersions.get(file.path) ?? 0)) {
				this.postsByFile.set(file.path, posts);
			}
			return posts;
		} finally {
			if (this.pendingReads.get(file.path) === read) {
				this.pendingReads.delete(file.path);
			}
		}
	}

	private async readFilePosts(file: TFile): Promise<TimelinePost[]> {
		const posts: TimelinePost[] = [];
		const date = this.dateFromPath(file.path);
		if (!date) return posts;
		const source = await this.app.vault.cachedRead(file);
		const heading = this.getSettings().sectionHeading;
		for (const section of findTimelineSections(source, heading)) {
			posts.push(...this.parsePosts(section.lines, section.lineOffset, date, file));
		}
		return posts;
	}

	private parsePosts(
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
				current.post.lineEnd = lineOffset + index + 1;
				blankLines = 0;
				continue;
			}
			if (!line.trim()) {
				if (current) blankLines++;
				continue;
			}
			// Never extend a replacement range across unrelated paragraphs or lists.
			if (current) posts.push(this.withReplyMetadata(finishPost(current)));
			current = null;
			blankLines = 0;
			if (fence.consume(line)) continue;
			const match = POST_PATTERN.exec(line);
			if (match?.[1]) {
				current = {
					post: {
						date,
						time: match[1],
						content: '',
						file,
						lineStart: lineOffset + index,
						lineEnd: lineOffset + index + 1,
						blockId: match[2],
					},
					inline: match[3],
					body: [],
				};
				continue;
			}
		}

		if (current) posts.push(this.withReplyMetadata(finishPost(current)));
		return posts;
	}

	private formatPost(
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

	private withReplyMetadata(post: TimelinePost): TimelinePost {
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

	private async ensureBlockId(post: TimelinePost): Promise<string> {
		const proposedBlockId = post.blockId ?? this.createBlockId();
		let updatedPost: TimelinePost | undefined;
		await this.app.vault.process(post.file, (source) => {
			const current = this.findCurrentPost(
				source,
				post,
				post.blockId === undefined,
				'The parent post changed.',
			);
			if (current.blockId) {
				updatedPost = current;
				return source;
			}

			// Only the first line changes, so the body keeps its exact formatting.
			const firstLine = source.split(/\r?\n/)[current.lineStart] ?? '';
			const identified = firstLine.replace(/^- (\d{2}:\d{2})/, `- $1 ^${proposedBlockId}`);
			if (identified === firstLine) throw new PostChangedError('The parent post changed.');
			updatedPost = { ...current, blockId: proposedBlockId };
			return replaceSourceLines(source, current.lineStart, current.lineStart + 1, [identified]);
		});

		if (!updatedPost?.blockId) throw new Error('The parent post could not be identified.');
		Object.assign(post, updatedPost);
		this.invalidateFile(post.file);
		return updatedPost.blockId;
	}

	private findCurrentPost(
		source: string,
		post: TimelinePost,
		requireUnchanged: boolean,
		errorMessage: string,
	): TimelinePost {
		const heading = this.getSettings().sectionHeading;
		const candidates = findTimelineSections(source, heading).flatMap((section) =>
			this.parsePosts(
				section.lines,
				section.lineOffset,
				post.date,
				post.file,
			));
		const matches = post.blockId
			? candidates.filter((candidate) => candidate.blockId === post.blockId)
			: candidates.filter((candidate) => this.hasSameSnapshot(candidate, post));

		if (matches.length !== 1) throw new PostChangedError(errorMessage);
		const current = matches[0];
		if (!current || (requireUnchanged && !this.hasSameSnapshot(current, post))) {
			throw new PostChangedError(errorMessage);
		}
		return current;
	}

	private hasSameSnapshot(current: TimelinePost, expected: TimelinePost): boolean {
		return current.time === expected.time
			&& current.content === expected.content
			&& current.replyLink === expected.replyLink;
	}

	private replacePost(
		source: string,
		current: TimelinePost,
		replacement: string[],
	): string {
		return replaceSourceLines(source, current.lineStart, current.lineEnd, replacement);
	}

	private createBlockId(): string {
		return `sol-${crypto.randomUUID()}`;
	}

	private dateFromPath(path: string): string | null {
		const cached = this.datesByPath.get(path);
		if (cached !== undefined) return cached;
		const date = parseDailyNoteDate(path, this.getSettings());
		this.datesByPath.set(path, date);
		return date;
	}

	private async getOrCreateTodayNote(): Promise<TFile> {
		const settings = this.getSettings();
		const path = buildDailyNotePath(settings);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;

		const parts = path.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
		return this.app.vault.create(path, '');
	}
}

interface ParsedPost {
	post: TimelinePost;
	inline?: string;
	/** Raw continuation lines, with '' for blank lines between them. */
	body: string[];
}

/** Removes one indentation unit and remembers it so edits can write it back. */
function finishPost({ post, inline, body }: ParsedPost): TimelinePost {
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
		...(body.length > 0 ? { bodyIndent } : {}),
	};
}

/** Normalizes line breaks and outer blank lines without changing indentation. */
function normalizePostContent(content: string): string {
	return content
		.replace(/\r\n?/g, '\n')
		.replace(/^(?:[ \t]*\n)+/, '')
		.trimEnd();
}
