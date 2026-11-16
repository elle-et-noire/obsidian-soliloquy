import { setIcon } from 'obsidian';
import type { TimelineSnapshot } from '../services/timeline-service';
import type { TimelinePost } from '../types';
import { captureFocusWithin } from './focus-preservation';
import type { RenderPasses } from './render-pass';
import { runDetached } from './report-failure';
import { postKey, type TimelineSurface } from './timeline-surface';

type NavigationEntry =
	| { type: 'timeline'; scrollTop: number; focusedPostKey?: string }
	| { type: 'thread'; post: TimelinePost };

interface ThreadViewSource {
	/** The loaded posts and their index. */
	getTimeline: () => TimelineSnapshot;
	/** Renders the timeline feed for a pass, keeping its loaded pages. */
	renderTimeline: (signal: AbortSignal, previousTimelineFocus: Element | null) => Promise<void>;
}

/** Renders thread pages and their back navigation to earlier threads or the timeline. */
export class ThreadView {
	private activeThread?: TimelinePost;
	private readonly navigationHistory: NavigationEntry[] = [];

	constructor(
		private readonly surface: TimelineSurface,
		private readonly passes: RenderPasses,
		private readonly source: ThreadViewSource,
	) {}

	isOpen(): boolean {
		return this.activeThread !== undefined;
	}

	/** Forgets the open thread and its history; the caller shows the timeline. */
	close(): void {
		this.activeThread = undefined;
		this.navigationHistory.length = 0;
	}

	/** A saved reply keeps the thread page open, or opens the reply's thread. */
	onReplySaved(parent: TimelinePost, stayOnTimeline: boolean): void {
		if (stayOnTimeline) this.close();
		else this.activeThread = this.activeThread ?? this.findThreadRoot(parent);
	}

	goBack(): boolean {
		if (!this.activeThread) return false;
		runDetached(() => this.navigateBack(), 'go back', 'Could not go back.');
		return true;
	}

	async open(post: TimelinePost): Promise<void> {
		const timelineEl = this.surface.timelineEl;
		if (!timelineEl) return;
		if (this.activeThread && postKey(this.activeThread) === postKey(post)) return;
		const previousTimelineFocus = captureFocusWithin(timelineEl);
		if (this.activeThread) {
			this.navigationHistory.push({ type: 'thread', post: this.activeThread });
		} else {
			this.navigationHistory.push({
				type: 'timeline',
				scrollTop: this.surface.contentEl.scrollTop,
				focusedPostKey: this.surface.focusedPostKey,
			});
		}
		const signal = this.passes.start();
		this.activeThread = post;
		this.surface.focusedPostKey = postKey(post);
		await this.renderThreadPage(
			post,
			signal,
			previousTimelineFocus ?? this.surface.contentEl.ownerDocument.body,
		);
	}

	/**
	 * Re-renders the open thread from the reloaded posts. Returns false when
	 * no thread is open or it no longer exists, so the timeline is shown.
	 */
	async refresh(signal: AbortSignal, previousTimelineFocus: Element | null): Promise<boolean> {
		if (!this.activeThread) return false;
		const current = this.findCurrentPost(this.activeThread);
		if (current) {
			this.activeThread = current;
			await this.renderThreadPage(current, signal, previousTimelineFocus);
			return true;
		}
		this.close();
		this.surface.focusedPostKey = undefined;
		return false;
	}

	private async renderThreadPage(
		post: TimelinePost,
		signal: AbortSignal,
		previousTimelineFocus: Element | null = null,
	): Promise<void> {
		const timelineEl = this.surface.beginPage('thread');
		if (!timelineEl) return;
		const navigation = timelineEl.createDiv({ cls: 'soliloquy-thread-navigation' });
		const back = navigation.createEl('button', {
			cls: 'soliloquy-back-button',
			attr: {
				type: 'button',
				'aria-label': 'Back',
				'aria-keyshortcuts': 'Alt+ArrowLeft',
			},
		});
		setIcon(back, 'arrow-left');
		back.addEventListener('click', () => runDetached(
			() => this.navigateBack(), 'go back', 'Could not go back.',
		));

		const thread = timelineEl.createDiv({ cls: 'soliloquy-thread' });
		const path = this.findAncestorPath(post);
		for (const ancestor of path) {
			const node = thread.createDiv({ cls: 'soliloquy-thread-node is-ancestor has-next' });
			await this.surface.renderCard(ancestor, node, 'reply');
			if (signal.aborted) return;
		}

		const selectedNode = thread.createDiv({ cls: 'soliloquy-thread-node is-selected' });
		await this.surface.renderCard(post, selectedNode, 'root');
		if (signal.aborted) return;
		const visited = new Set(path.map((item) => postKey(item)));
		visited.add(postKey(post));
		await this.renderDescendants(thread, selectedNode, post, signal, visited);
		if (signal.aborted) return;
		this.surface.restoreRenderedPostFocus(previousTimelineFocus, true);
	}

	private async navigateBack(): Promise<void> {
		const previousTimelineFocus = captureFocusWithin(this.surface.timelineEl!);
		const signal = this.passes.start();
		let previous = this.navigationHistory.pop();
		while (previous?.type === 'thread') {
			const post = this.findCurrentPost(previous.post);
			if (post) {
				this.activeThread = post;
				this.surface.focusedPostKey = postKey(post);
				await this.renderThreadPage(post, signal, previousTimelineFocus);
				return;
			}
			previous = this.navigationHistory.pop();
		}

		this.activeThread = undefined;
		this.surface.focusedPostKey = previous?.focusedPostKey;
		await this.source.renderTimeline(signal, previousTimelineFocus);
		if (signal.aborted || previous?.type !== 'timeline') return;
		const contentEl = this.surface.contentEl;
		contentEl.win.requestAnimationFrame(() => {
			if (!signal.aborted) contentEl.scrollTop = previous.scrollTop;
		});
	}

	private async renderDescendants(
		container: HTMLElement,
		parentNode: HTMLElement,
		parent: TimelinePost,
		signal: AbortSignal,
		visited: Set<string>,
	): Promise<void> {
		const children = this.source.getTimeline().index.getReplies(parent)
			.filter((child) => !visited.has(postKey(child)));
		if (children.length === 0) return;

		if (children.length === 1) {
			const child = children[0];
			if (!child) return;
			visited.add(postKey(child));
			parentNode.addClass('has-next');
			const node = container.createDiv({ cls: 'soliloquy-thread-node is-descendant' });
			await this.surface.renderCard(child, node, 'reply');
			if (signal.aborted) return;
			await this.renderDescendants(container, node, child, signal, visited);
			return;
		}

		const choices = container.createDiv({ cls: 'soliloquy-thread-choices' });
		for (const child of children) {
			const node = choices.createDiv({ cls: 'soliloquy-thread-node is-choice' });
			await this.surface.renderCard(child, node, 'reply');
			if (signal.aborted) return;
		}
	}

	private findThreadRoot(post: TimelinePost): TimelinePost {
		const { index } = this.source.getTimeline();
		let current = post;
		const visited = new Set<string>();
		while (current.replyToBlockId && !visited.has(postKey(current))) {
			visited.add(postKey(current));
			const parent = index.getPostByBlockId(current.replyToBlockId);
			if (!parent) break;
			current = parent;
		}
		return current;
	}

	private findAncestorPath(post: TimelinePost): TimelinePost[] {
		const { index } = this.source.getTimeline();
		const ancestors: TimelinePost[] = [];
		let current = post;
		const visited = new Set<string>([postKey(post)]);
		while (current.replyToBlockId) {
			const parent = index.getPostByBlockId(current.replyToBlockId);
			if (!parent || visited.has(postKey(parent))) break;
			ancestors.unshift(parent);
			visited.add(postKey(parent));
			current = parent;
		}
		return ancestors;
	}

	private findCurrentPost(post: TimelinePost): TimelinePost | undefined {
		const { posts, index } = this.source.getTimeline();
		if (post.blockId) return index.getPostByBlockId(post.blockId);
		return posts.find((candidate) =>
			candidate.file.path === post.file.path
			&& candidate.time === post.time
			&& candidate.content === post.content,
		);
	}
}
