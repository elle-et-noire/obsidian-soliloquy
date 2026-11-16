import { App, moment, TFile } from 'obsidian';
import type { SoliloquySettings } from '../settings';
import type { TimelinePost } from '../types';
import { buildDailyNotePath, parseDailyNoteDate } from './daily-note-path';
import { DailyNoteSettingsResolver, type ResolvedDailyNotes } from './daily-note-settings';
import { expandDailyNoteTemplate, findTemplateFile } from './daily-note-template';
import { PostChangedError } from './errors';
import { findMarkdownTasks, type MarkdownTask } from './markdown-tasks';
import { TimelineIndex } from './timeline-index';
import {
	addPostBlockId,
	appendPostToTimelineSection,
	formatPost,
	parseTimelinePosts,
	replacePost,
} from './timeline-markdown';

/** Delay that coalesces bursts of vault events (typing, sync) into one check. */
const FILE_CHANGE_DELAY_MS = 100;

/** Posts sorted newest first with their index. Shared by every display; do not mutate. */
export interface TimelineSnapshot {
	readonly posts: readonly TimelinePost[];
	readonly index: TimelineIndex;
}

type TimerWindow = Pick<Window, 'setTimeout' | 'clearTimeout'>;

/**
 * Reads and writes timeline posts and is the single source of change
 * notifications: listeners hear about this plugin's writes, settings changes,
 * and vault changes that alter posts (not edits outside the timeline section).
 */
export class TimelineService {
	private readonly postsByFile = new Map<string, readonly TimelinePost[]>();
	private readonly pendingReads = new Map<string, Promise<readonly TimelinePost[]>>();
	private readonly fileVersions = new Map<string, number>();
	/** Daily-note dates by path; cleared when settings change (invalidateAll). */
	private readonly datesByPath = new Map<string, string | null>();
	private cacheEpoch = 0;
	/** Increases whenever the posts may have changed; tags the cached snapshot. */
	private version = 0;
	private snapshot?: { version: number; timeline: Promise<TimelineSnapshot> };
	private readonly listeners = new Set<() => void>();
	private readonly readFailureListeners = new Set<(paths: readonly string[]) => void>();
	private readonly templateFailureListeners = new Set<(templatePath: string) => void>();
	/** Today's note while it is being created, so concurrent posts share it. */
	private creatingNote?: { path: string; file: Promise<TFile> };
	/** Folder, format, and template in effect; changed only by explicit refreshes. */
	private readonly dailyNotes: DailyNoteSettingsResolver;
	/** Notes left out of the timeline because they could not be read, already reported. */
	private readonly unreadablePaths = new Set<string>();
	/** Vault changes awaiting a check: the current file, or null when removed. */
	private readonly changedFiles = new Map<string, TFile | null>();
	private changeTimer?: number;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => SoliloquySettings,
		private readonly timerWindow?: TimerWindow,
	) {
		this.dailyNotes = new DailyNoteSettingsResolver(app, getSettings);
	}

	/** The daily note folder, format, and template currently in effect. */
	get dailyNoteSettings(): ResolvedDailyNotes {
		return this.dailyNotes.current;
	}

	isDailyNote(file: TFile): boolean {
		return file.extension === 'md' && this.dateFromPath(file.path) !== null;
	}

	/** Subscribes to timeline changes. Returns the function that unsubscribes. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Subscribes to daily notes that could not be read and are left out of the
	 * timeline. A note is reported once until it is read successfully again.
	 */
	onReadFailure(listener: (paths: readonly string[]) => void): () => void {
		this.readFailureListeners.add(listener);
		return () => this.readFailureListeners.delete(listener);
	}

	/**
	 * Subscribes to templates that could not be used for a new daily note.
	 * The note is created without the template.
	 */
	onTemplateFailure(listener: (templatePath: string) => void): () => void {
		this.templateFailureListeners.add(listener);
		return () => this.templateFailureListeners.delete(listener);
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
		this.dailyNotes.refresh();
		this.resetCaches();
	}

	/**
	 * Rereads the core Daily notes settings, which Obsidian does not announce
	 * changes to, and reloads the timeline when the daily note location changed.
	 */
	refreshDailyNoteSettings(): void {
		if (this.dailyNotes.refresh()) this.resetCaches();
	}

	private resetCaches(): void {
		this.cacheEpoch += 1;
		this.postsByFile.clear();
		this.pendingReads.clear();
		this.fileVersions.clear();
		this.datesByPath.clear();
		this.changedFiles.clear();
		this.unreadablePaths.clear();
		this.clearChangeTimer();
		this.notifyChanged();
	}

	dispose(): void {
		this.clearChangeTimer();
		this.changedFiles.clear();
		this.listeners.clear();
		this.readFailureListeners.clear();
		this.templateFailureListeners.clear();
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

	/**
	 * Returns the cached snapshot, loading it only after posts changed. Notes
	 * that cannot be read are left out and reported through onReadFailure.
	 */
	getTimeline(): Promise<TimelineSnapshot> {
		if (this.snapshot?.version === this.version) return this.snapshot.timeline;
		const loading = this.loadTimeline();
		const timeline = loading.then(({ snapshot }) => snapshot);
		const snapshot = { version: this.version, timeline };
		this.snapshot = snapshot;
		// A failed or incomplete load must not be served again, so the next
		// request retries the unreadable notes. Callers still see this result.
		const forget = () => {
			if (this.snapshot === snapshot) this.snapshot = undefined;
		};
		loading.then(({ complete }) => {
			if (!complete) forget();
		}, forget);
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

	/** Returns the parent as identified for the reply, with its block ID. */
	async addReply(parent: TimelinePost, content: string): Promise<TimelinePost> {
		const identified = await this.ensureBlockId(parent);
		const target = identified.file.path.replace(/\.md$/, '');
		await this.appendPost(content, `[[${target}#^${identified.blockId}]]`);
		return identified;
	}

	private async appendPost(content: string, replyLink?: string): Promise<void> {
		const text = normalizePostContent(content);
		if (!text) return;

		const file = await this.getOrCreateTodayNote();
		const line = formatPost(moment().format('HH:mm'), text, this.createBlockId(), replyLink);
		const heading = this.getSettings().sectionHeading;

		await this.app.vault.process(file, (source) =>
			appendPostToTimelineSection(source, heading, line));
		this.fileWritten(file);
	}

	/** Returns the saved post; the given post is left unchanged. */
	async updatePost(post: TimelinePost, content: string): Promise<TimelinePost> {
		const text = normalizePostContent(content);
		if (!text) return post;
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
			const replaced = replacePost(source, current, formatPost(
				current.time,
				text,
				blockId,
				current.replyLink,
				current.bodyIndent,
			));
			updatedPost = {
				...current,
				content: text,
				blockId,
				lineEnd: replaced.lineEnd,
			};
			return replaced.source;
		});

		if (!updatedPost) throw new Error('The post could not be updated.');
		this.fileWritten(post.file);
		return updatedPost;
	}

	/** Returns the saved post; the given post is left unchanged. */
	async updateTask(post: TimelinePost, task: MarkdownTask, checked: boolean, options?: { verifiedByRenderer: boolean }): Promise<TimelinePost> {
		const offset = task.markerOffset;
		// Without renderer verification, accept only a line-based task candidate.
		// A verified caller must have rendered the exact post snapshot first.
		if (!Number.isInteger(offset) || offset < 1 || !/^\[[^\r\n]\][ \t]/.test(post.content.slice(offset - 1))
			|| (!options?.verifiedByRenderer && !findMarkdownTasks(post.content).some((item) => item.markerOffset === offset))) {
			throw new Error('The task could not be found in the post.');
		}
		const content = post.content.slice(0, offset)
			+ (checked ? 'x' : ' ') + post.content.slice(offset + 1);
		return this.updatePost(post, content);
	}

	private async loadTimeline(): Promise<{ snapshot: TimelineSnapshot; complete: boolean }> {
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isDailyNote(file));
		const currentPaths = new Set(files.map((file) => file.path));
		for (const path of this.postsByFile.keys()) {
			if (!currentPaths.has(path)) this.postsByFile.delete(path);
		}
		for (const path of this.unreadablePaths) {
			if (!currentPaths.has(path)) this.unreadablePaths.delete(path);
		}

		const failed: string[] = [];
		const posts = (await Promise.all(files.map(async (file) => {
			try {
				const filePosts = await this.getFilePosts(file);
				this.unreadablePaths.delete(file.path);
				return filePosts;
			} catch (error) {
				// One unreadable note must not hide the rest of the timeline.
				console.error(`Soliloquy: failed to read ${file.path}`, error);
				failed.push(file.path);
				return [];
			}
		}))).flat();
		posts.sort(compareNewestFirst);
		this.reportReadFailures(failed);
		return { snapshot: { posts, index: new TimelineIndex(posts) }, complete: failed.length === 0 };
	}

	/** Tells listeners about notes that newly failed; repeated loads stay quiet. */
	private reportReadFailures(paths: readonly string[]): void {
		const newlyFailed = paths.filter((path) => !this.unreadablePaths.has(path));
		for (const path of newlyFailed) this.unreadablePaths.add(path);
		if (newlyFailed.length === 0) return;
		for (const listener of Array.from(this.readFailureListeners)) {
			try {
				listener(newlyFailed);
			} catch (error) {
				console.error('Soliloquy: read failure listener failed', error);
			}
		}
	}

	private async getFilePosts(file: TFile): Promise<readonly TimelinePost[]> {
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

	private async readFilePosts(file: TFile): Promise<readonly TimelinePost[]> {
		const date = this.dateFromPath(file.path);
		if (!date) return [];
		const source = await this.app.vault.cachedRead(file);
		return parseTimelinePosts(source, this.getSettings().sectionHeading, date, file);
	}

	/** Returns the current post with a block ID, assigning one when it has none. */
	private async ensureBlockId(post: TimelinePost): Promise<TimelinePost> {
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
			const identified = addPostBlockId(source, current, proposedBlockId);
			if (identified === null) throw new PostChangedError('The parent post changed.');
			updatedPost = { ...current, blockId: proposedBlockId };
			return identified;
		});

		if (!updatedPost?.blockId) throw new Error('The parent post could not be identified.');
		if (written) this.fileWritten(post.file);
		return updatedPost;
	}

	private findCurrentPost(
		source: string,
		post: TimelinePost,
		requireUnchanged: boolean,
		errorMessage: string,
	): TimelinePost {
		const candidates = parseTimelinePosts(
			source,
			this.getSettings().sectionHeading,
			post.date,
			post.file,
		);
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

	private createBlockId(): string {
		return `sol-${crypto.randomUUID()}`;
	}

	private dateFromPath(path: string): string | null {
		const cached = this.datesByPath.get(path);
		if (cached !== undefined) return cached;
		const date = parseDailyNoteDate(path, this.dailyNotes.current);
		this.datesByPath.set(path, date);
		return date;
	}

	private async getOrCreateTodayNote(): Promise<TFile> {
		// Core Daily notes settings may have changed since they were last read.
		this.refreshDailyNoteSettings();
		const settings = this.dailyNotes.current;
		const now = moment();
		const path = buildDailyNotePath(settings, now);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (this.creatingNote?.path === path) return this.creatingNote.file;

		const file = this.createDailyNote(path, settings, now);
		const creating = { path, file };
		this.creatingNote = creating;
		try {
			return await file;
		} finally {
			if (this.creatingNote === creating) this.creatingNote = undefined;
		}
	}

	private async createDailyNote(
		path: string,
		settings: ResolvedDailyNotes,
		now: ReturnType<typeof moment>,
	): Promise<TFile> {
		const parts = path.split('/');
		const name = parts.pop() ?? path;
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}

		const content = await this.readDailyNoteTemplate(settings, now, name.replace(/\.md$/, ''));
		try {
			return await this.app.vault.create(path, content);
		} catch (error) {
			// Another plugin or a sync may have created the note meanwhile.
			const created = this.app.vault.getAbstractFileByPath(path);
			if (created instanceof TFile) return created;
			throw error;
		}
	}

	/** Returns the expanded template, or an empty note when there is none or it fails. */
	private async readDailyNoteTemplate(
		settings: ResolvedDailyNotes,
		now: ReturnType<typeof moment>,
		title: string,
	): Promise<string> {
		if (!settings.template) return '';
		try {
			const file = findTemplateFile(this.app, settings.template);
			if (!file) throw new Error('The template file was not found.');
			const template = await this.app.vault.cachedRead(file);
			return expandDailyNoteTemplate(template, now, settings.dailyNoteFormat, title);
		} catch (error) {
			console.error(`Soliloquy: could not use the daily note template ${settings.template}`, error);
			for (const listener of Array.from(this.templateFailureListeners)) {
				try {
					listener(settings.template);
				} catch (listenerError) {
					console.error('Soliloquy: template failure listener failed', listenerError);
				}
			}
			return '';
		}
	}
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
function postsSignature(posts: readonly TimelinePost[]): string {
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
