import { App, moment, TFile } from 'obsidian';
import type { SoliloquySettings } from '../settings';
import type { TimelinePost } from '../types';
import { buildDailyNotePath, parseDailyNoteDate } from './daily-note-path';
import { PostChangedError } from './errors';
import { MarkdownFenceTracker } from './markdown-fence';
import { findMarkdownTasks, type MarkdownTask } from './markdown-tasks';
import { TimelineIndex } from './timeline-index';
import {
	appendPostToTimelineSection,
	findTimelineSections,
	replaceSourceLines,
} from './timeline-markdown';

const POST_PATTERN = /^- (\d{2}:\d{2})(?:\s+\^([\w-]+))?(?:\s+(.+))?\s*$/;
const REPLY_LINK_PATTERN = /^\[\[[^\]]*#\^([\w-]+)(?:\|[^\]]+)?\]\]$/;

/** Delay that coalesces bursts of vault events (typing, sync) into one check. */
const FILE_CHANGE_DELAY_MS = 100;

/** Posts sorted newest first with their index. Shared by every display; do not mutate. */
export interface TimelineSnapshot {
	readonly posts: TimelinePost[];
	readonly index: TimelineIndex;
}

type TimerWindow = Pick<Window, 'setTimeout' | 'clearTimeout'>;

/**
 * Reads and writes timeline posts and is the single source of change
 * notifications: listeners hear about this plugin's writes, settings changes,
 * and vault changes that alter posts (not edits outside the timeline section).
 */
export class TimelineService {
	private readonly postsByFile = new Map<string, TimelinePost[]>();
	private readonly pendingReads = new Map<string, Promise<TimelinePost[]>>();
	private readonly fileVersions = new Map<string, number>();
	/** Daily-note dates by path; cleared when settings change (invalidateAll). */
	private readonly datesByPath = new Map<string, string | null>();
	private cacheEpoch = 0;
	/** Increases whenever the posts may have changed; tags the cached snapshot. */
	private version = 0;
	private snapshot?: { version: number; timeline: Promise<TimelineSnapshot> };
	private readonly listeners = new Set<() => void>();
	/** Vault changes awaiting a check: the current file, or null when removed. */
	private readonly changedFiles = new Map<string, TFile | null>();
	private changeTimer?: number;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => SoliloquySettings,
		private readonly timerWindow?: TimerWindow,
	) {}

	isDailyNote(file: TFile): boolean {
		return file.extension === 'md' && this.dateFromPath(file.path) !== null;
	}

	/** Subscribes to timeline changes. Returns the function that unsubscribes. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A daily note was created or modified in the vault. */
	fileChanged(file: TFile): void {
		if (this.isDailyNote(file)) this.queueFileChange(file.path, file);
	}

	/** A file was deleted or renamed away from this path. */
	fileRemoved(path: string): void {
		if (this.dateFromPath(path) !== null) this.queueFileChange(path, null);
	}

	/** Settings changed: forget every cached note and notify listeners. */
	invalidateAll(): void {
		this.cacheEpoch += 1;
		this.postsByFile.clear();
		this.pendingReads.clear();
		this.fileVersions.clear();
		this.datesByPath.clear();
		this.changedFiles.clear();
		this.clearChangeTimer();
		this.notifyChanged();
	}

	dispose(): void {
		this.clearChangeTimer();
		this.changedFiles.clear();
		this.listeners.clear();
	}

	/**
	 * Rereads the queued files and notifies listeners only when their posts
	 * differ from the cached ones. This plugin's own writes were already
	 * published, so their echoes do not render again.
	 */
	async flushFileChanges(): Promise<void> {
		this.clearChangeTimer();
		const changes = Array.from(this.changedFiles);
		this.changedFiles.clear();
		if (changes.length === 0) return;
		const epoch = this.cacheEpoch;
		const results = await Promise.all(changes.map(async ([path, file]) => {
			const previous = this.postsByFile.get(path);
			this.forgetPath(path);
			if (!file) return previous === undefined || previous.length > 0;
			try {
				const posts = await this.getFilePosts(file);
				const unchanged = postsSignature(previous ?? []) === postsSignature(posts);
				// Keep the cached objects so the current snapshot stays consistent.
				if (unchanged && previous && this.postsByFile.get(path) === posts) {
					this.postsByFile.set(path, previous);
				}
				return !unchanged;
			} catch (error) {
				console.error(`Soliloquy: failed to read ${path}`, error);
				return true;
			}
		}));
		if (epoch === this.cacheEpoch && results.some(Boolean)) this.notifyChanged();
	}

	/** Returns the cached snapshot, loading it only after posts changed. */
	getTimeline(): Promise<TimelineSnapshot> {
		if (this.snapshot?.version === this.version) return this.snapshot.timeline;
		const timeline = this.loadTimeline();
		const snapshot = { version: this.version, timeline };
		this.snapshot = snapshot;
		// A failed load must not be served again; callers still see the error.
		timeline.catch(() => {
			if (this.snapshot === snapshot) this.snapshot = undefined;
		});
		return timeline;
	}

	private queueFileChange(path: string, file: TFile | null): void {
		this.changedFiles.set(path, file);
		this.clearChangeTimer();
		this.changeTimer = (this.timerWindow ?? window).setTimeout(() => {
			this.changeTimer = undefined;
			this.flushFileChanges().catch((error: unknown) => {
				console.error('Soliloquy: failed to check changed daily notes', error);
			});
		}, FILE_CHANGE_DELAY_MS);
	}

	private clearChangeTimer(): void {
		if (this.changeTimer === undefined) return;
		(this.timerWindow ?? window).clearTimeout(this.changeTimer);
		this.changeTimer = undefined;
	}

	/** Drops a file's cached posts and any read in progress. */
	private forgetPath(path: string): void {
		this.postsByFile.delete(path);
		this.pendingReads.delete(path);
		this.fileVersions.set(path, (this.fileVersions.get(path) ?? 0) + 1);
	}

	/** Records a write by this plugin and publishes it to every display. */
	private fileWritten(file: TFile): void {
		this.forgetPath(file.path);
		this.notifyChanged();
	}

	private notifyChanged(): void {
		this.version += 1;
		for (const listener of Array.from(this.listeners)) {
			try {
				listener();
			} catch (error) {
				console.error('Soliloquy: timeline change listener failed', error);
			}
		}
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
		this.fileWritten(file);
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
		this.fileWritten(post.file);
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

	private async loadTimeline(): Promise<TimelineSnapshot> {
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isDailyNote(file));
		const currentPaths = new Set(files.map((file) => file.path));
		for (const path of this.postsByFile.keys()) {
			if (!currentPaths.has(path)) this.postsByFile.delete(path);
		}

		const posts = (await Promise.all(files.map((file) => this.getFilePosts(file)))).flat();
		posts.sort(compareNewestFirst);
		return { posts, index: new TimelineIndex(posts) };
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
		let written = false;
		await this.app.vault.process(post.file, (source) => {
			written = false;
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
			written = true;

			// Only the first line changes, so the body keeps its exact formatting.
			const firstLine = source.split(/\r?\n/)[current.lineStart] ?? '';
			const identified = firstLine.replace(/^- (\d{2}:\d{2})/, `- $1 ^${proposedBlockId}`);
			if (identified === firstLine) throw new PostChangedError('The parent post changed.');
			updatedPost = { ...current, blockId: proposedBlockId };
			return replaceSourceLines(source, current.lineStart, current.lineStart + 1, [identified]);
		});

		if (!updatedPost?.blockId) throw new Error('The parent post could not be identified.');
		Object.assign(post, updatedPost);
		if (written) this.fileWritten(post.file);
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

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first; posts in one note keep their reverse source order. */
function compareNewestFirst(a: TimelinePost, b: TimelinePost): number {
	const chronological = compareText(b.date, a.date) || compareText(b.time, a.time);
	if (chronological !== 0) return chronological;
	if (a.file.path === b.file.path) return b.lineStart - a.lineStart;
	return b.file.path.localeCompare(a.file.path);
}

/** Everything about a note's posts that affects the timeline, to detect real changes. */
function postsSignature(posts: TimelinePost[]): string {
	return posts.map((post) => [
		post.date,
		post.time,
		post.lineStart,
		post.lineEnd,
		post.blockId ?? '',
		post.replyLink ?? '',
		post.bodyIndent ?? '',
		post.content,
	].join('\u0000')).join('\u0001');
}

/** Normalizes line breaks and outer blank lines without changing indentation. */
function normalizePostContent(content: string): string {
	return content
		.replace(/\r\n?/g, '\n')
		.replace(/^(?:[ \t]*\n)+/, '')
		.trimEnd();
}
