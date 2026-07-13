import { App, moment, TFile } from 'obsidian';
import type { SoliloquySettings } from '../settings';
import type { TimelinePost } from '../types';
import { buildDailyNotePath, parseDailyNoteDate } from './daily-note-path';

const POST_PATTERN = /^- (\d{2}:\d{2})(?:\s+\^([\w-]+))?(?:\s+(.+))?\s*$/;
const REPLY_LINK_PATTERN = /^\[\[[^\]]*#\^([\w-]+)(?:\|[^\]]+)?\]\]$/;
const TASK_MARKER_PATTERN = /^(\s*[-*+]\s+\[)[ xX](\])/;

export class TimelineService {
	constructor(
		private readonly app: App,
		private readonly getSettings: () => SoliloquySettings,
	) {}

	isDailyNote(file: TFile): boolean {
		return file.extension === 'md'
			&& parseDailyNoteDate(file.path, this.getSettings()) !== null;
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

		await this.app.vault.process(file, (source) => {
			const sectionStart = source.indexOf(heading);
			if (sectionStart < 0) {
				const prefix = source.length > 0 && !source.endsWith('\n') ? '\n\n' : '';
				return `${source}${prefix}${heading}\n\n${line}\n`;
			}

			const contentStart = sectionStart + heading.length;
			const nextHeading = source.slice(contentStart).search(/\n##\s/);
			const insertionPoint = nextHeading < 0 ? source.length : contentStart + nextHeading;
			const before = source.slice(0, insertionPoint).replace(/\s*$/, '');
			const after = source.slice(insertionPoint);
			return `${before}\n${line}\n${after}`;
		});
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
	}

	async updateTask(post: TimelinePost, taskIndex: number, checked: boolean): Promise<void> {
		let currentIndex = 0;
		let found = false;
		const content = post.content
			.split('\n')
			.map((line) => line.replace(TASK_MARKER_PATTERN, (match, prefix: string, suffix: string) => {
				if (currentIndex++ !== taskIndex) return match;
				found = true;
				return `${prefix}${checked ? 'x' : ' '}${suffix}`;
			}))
			.join('\n');

		if (!found) throw new Error('The task could not be found in the post.');
		await this.updatePost(post, content);
	}

	async getPosts(): Promise<TimelinePost[]> {
		const posts: TimelinePost[] = [];
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isDailyNote(file));

		await Promise.all(files.map(async (file) => {
			const date = this.dateFromPath(file.path);
			if (!date) return;
			const source = await this.app.vault.cachedRead(file);
			const section = this.timelineLines(source);
			posts.push(...this.parsePosts(section.lines, section.lineOffset, date, file));
		}));

		return posts.sort((a, b) => {
			const chronological = `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`);
			if (chronological !== 0) return chronological;
			if (a.file.path === b.file.path) return b.lineStart - a.lineStart;
			return b.file.path.localeCompare(a.file.path);
		});
	}

	private parsePosts(
		lines: string[],
		lineOffset: number,
		date: string,
		file: TFile,
	): TimelinePost[] {
		const posts: TimelinePost[] = [];
		let current: TimelinePost | null = null;

		for (const [index, line] of lines.entries()) {
			const match = POST_PATTERN.exec(line);
			if (match?.[1]) {
				if (current) posts.push(this.withReplyMetadata(current));
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
			if (current && (line.startsWith('\t') || line.startsWith('  '))) {
				const continuation = line.startsWith('\t') ? line.slice(1) : line.slice(2);
				current.content += current.content ? `\n${continuation}` : continuation;
				current.lineEnd = lineOffset + index + 1;
			}
		}

		if (current) posts.push(this.withReplyMetadata(current));
		return posts;
	}

	private timelineLines(source: string): { lines: string[]; lineOffset: number } {
		const heading = `## ${this.getSettings().sectionHeading}`;
		const lines = source.split(/\r?\n/);
		const headingIndex = lines.findIndex((line) => line === heading);
		if (headingIndex < 0) return { lines: [], lineOffset: 0 };
		const lineOffset = headingIndex + 1;
		const nextHeading = lines.findIndex(
			(line, index) => index >= lineOffset && /^##\s/.test(line),
		);
		return {
			lines: lines.slice(lineOffset, nextHeading < 0 ? undefined : nextHeading),
			lineOffset,
		};
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
		return updatedPost.blockId;
	}

	private findCurrentPost(
		source: string,
		post: TimelinePost,
		requireUnchanged: boolean,
		errorMessage: string,
	): TimelinePost {
		const section = this.timelineLines(source);
		const candidates = this.parsePosts(
			section.lines,
			section.lineOffset,
			post.date,
			post.file,
		);
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
		const lines = source.split(/\r?\n/);
		lines.splice(
			current.lineStart,
			current.lineEnd - current.lineStart,
			...replacement,
		);
		return lines.join('\n');
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
