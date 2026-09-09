import { App, moment, TFile } from 'obsidian';
import type { SoliloquySettings } from '../settings';
import type { TimelinePost } from '../types';
import { buildDailyNotePath, parseDailyNoteDate } from './daily-note-path';
import { MarkdownFenceTracker } from './markdown-fence';
import { findMarkdownTasks, type MarkdownTask } from './markdown-tasks';
import {
	appendPostToTimelineSection,
	detectLineEnding,
	findTimelineSections,
} from './timeline-markdown';

const POST_PATTERN = /^- (\d{2}:\d{2})(?:\s+\^([\w-]+))?(?:\s+(.+))?\s*$/;
const REPLY_LINK_PATTERN = /^\[\[[^\]]*#\^([\w-]+)(?:\|[^\]]+)?\]\]$/;

export class TimelineService {
	private readonly postsByFile = new Map<string, TimelinePost[]>();
	private readonly pendingReads = new Map<string, Promise<TimelinePost[]>>();
	private readonly fileVersions = new Map<string, number>();
	private cacheEpoch = 0;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => SoliloquySettings,
	) {}

	isDailyNote(file: TFile): boolean {
		return file.extension === 'md'
			&& parseDailyNoteDate(file.path, this.getSettings()) !== null;
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
		const text = content.replace(/\r\n?/g, '\n').trim();
		if (!text) return;

		const file = await this.getOrCreateTodayNote();
		const line = this.formatPost(moment().format('HH:mm'), text, this.createBlockId(), replyLink);
		const heading = `## ${this.getSettings().sectionHeading}`;

		await this.app.vault.process(file, (source) =>
			appendPostToTimelineSection(source, heading, line));
		this.invalidateFile(file);
	}

	async updatePost(post: TimelinePost, content: string): Promise<void> {
		const text = content.replace(/\r\n?/g, '\n').trim();
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

	async updateTask(post: TimelinePost, task: MarkdownTask, checked: boolean): Promise<void> {
		const offset = task.markerOffset;
		if (!findMarkdownTasks(post.content).some((item) => item.markerOffset === offset)) {
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
		const heading = `## ${this.getSettings().sectionHeading}`;
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
		let current: TimelinePost | null = null;
		let blankLines = 0;
		const fence = new MarkdownFenceTracker();

		for (const [index, line] of lines.entries()) {
			// Stored body lines belong to the post, including its indented code fences.
			if (current && (line.startsWith('\t') || line.startsWith('  '))) {
				const continuation = line.startsWith('\t') ? line.slice(1) : line.slice(2);
				current.content += current.content ? `\n${'\n'.repeat(blankLines)}${continuation}` : continuation;
				current.lineEnd = lineOffset + index + 1;
				blankLines = 0;
				continue;
			}
			if (!line.trim()) {
				if (current) blankLines++;
				continue;
			}
			// Never extend a replacement range across unrelated paragraphs or lists.
			if (current) posts.push(this.withReplyMetadata(current));
			current = null;
			blankLines = 0;
			if (fence.consume(line)) continue;
			const match = POST_PATTERN.exec(line);
			if (match?.[1]) {
				current = {
					date,
					time: match[1],
					content: match[3] ?? '',
					file,
					lineStart: lineOffset + index,
					lineEnd: lineOffset + index + 1,
					blockId: match[2],
				};
				continue;
			}
		}

		if (current) posts.push(this.withReplyMetadata(current));
		return posts;
	}

	private formatPost(time: string, content: string, blockId: string, replyLink?: string): string {
		return [
			`- ${time} ^${blockId}`,
			...(replyLink ? [`\t${replyLink}`] : []),
			...content.split('\n').map((line) => `\t${line}`),
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

			const replacement = this.formatPost(
				current.time,
				current.content,
				proposedBlockId,
				current.replyLink,
			).split('\n');
			updatedPost = {
				...current,
				blockId: proposedBlockId,
				lineEnd: current.lineStart + replacement.length,
			};
			return this.replacePost(source, current, replacement);
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
		const heading = `## ${this.getSettings().sectionHeading}`;
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

		if (matches.length !== 1) throw new Error(errorMessage);
		const current = matches[0];
		if (!current || (requireUnchanged && !this.hasSameSnapshot(current, post))) {
			throw new Error(errorMessage);
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
		const lineEnding = detectLineEnding(source);
		const lines = source.split(/\r?\n/);
		lines.splice(
			current.lineStart,
			current.lineEnd - current.lineStart,
			...replacement,
		);
		return lines.join(lineEnding);
	}

	private createBlockId(): string {
		return `sol-${crypto.randomUUID()}`;
	}

	private dateFromPath(path: string): string | null {
		return parseDailyNoteDate(path, this.getSettings());
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
