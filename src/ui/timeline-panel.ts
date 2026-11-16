import {
	App,
	Component,
	MarkdownView,
	Notice,
	type Scope,
} from 'obsidian';
import { TimelineUserError } from '../services/errors';
import type { TimelineService, TimelineSnapshot } from '../services/timeline-service';
import { TimelineIndex } from '../services/timeline-index';
import type { MarkdownTask } from '../services/markdown-tasks';
import type { TimelinePost } from '../types';
import { SoliloquyComposer } from './composer';
import { InlinePostEditor } from './inline-post-editor';
import { captureFocusWithin, shouldRestoreFocusWithin } from './focus-preservation';
import { PostCardRenderer } from './post-card';
import { RenderPasses } from './render-pass';
import { runDetached } from './report-failure';
import { ThreadView } from './thread-view';
import { registerTimelineKeyboard } from './timeline-keyboard';
import { TimelineList } from './timeline-list';
import { postKey, TimelineSurface } from './timeline-surface';

export type SoliloquyFocusTarget = 'view' | 'search' | 'post';

/** What a view or modal supplies when it shows a timeline panel. */
export interface TimelinePanelHost {
	/** Receives the display's keyboard shortcuts. */
	scope: Scope;
	/**
	 * Element whose focused descendants receive those shortcuts, when the host
	 * owns more than the panel (e.g. a modal container). Defaults to the panel.
	 */
	keyboardBoundary?: HTMLElement;
	/** Moves focus out of the display, e.g. on Escape outside inputs. */
	leaveDisplay: () => void;
	/** Runs before the panel opens a note or link in the workspace. */
	onNavigate?: () => void;
}

const EMPTY_TIMELINE: TimelineSnapshot = { posts: [], index: new TimelineIndex([]) };

export class TimelinePanel extends Component {
	private composer?: SoliloquyComposer;
	private readonly postRenderer: PostCardRenderer;
	private readonly inlineEditor: InlinePostEditor;
	private readonly surface: TimelineSurface;
	private readonly list: TimelineList;
	private readonly thread: ThreadView;
	/** One cancellation signal per render pass; unloading cancels the latest. */
	private readonly passes = new RenderPasses();
	private host?: TimelinePanelHost;
	private posting = false;
	private disposed = false;
	/** Service snapshot last loaded for display, to skip no-op refreshes. */
	private loadedTimeline = EMPTY_TIMELINE;

	constructor(
		private readonly app: App,
		readonly contentEl: HTMLElement,
		private readonly service: TimelineService,
	) {
		super();
		this.postRenderer = new PostCardRenderer(this.app, this, {
			getReplies: (post) => this.loadedTimeline.index.getReplies(post),
			getPostKey: postKey,
			isFocused: (post) => this.surface.isFocused(post),
			onEdit: (card, post) => {
				this.surface.focusedPostKey = postKey(post);
				this.inlineEditor.openEdit(card, post);
			},
			onFocus: (card, post) => this.surface.markFocused(card, post),
			onMoveFocus: (card, direction) => this.movePostFocus(card, direction),
			onOpenDate: (post) => {
				this.host?.onNavigate?.();
				runDetached(
					() => this.app.workspace.getLeaf('tab').openFile(post.file, { active: true }),
					`open ${post.file.path}`,
					'Could not open the daily note.',
				);
			},
			onOpenLink: (destination, post) => {
				this.host?.onNavigate?.();
				runDetached(
					() => this.app.workspace.openLinkText(destination, post.file.path, true),
					`open the link ${destination}`,
					'Could not open the link.',
				);
			},
			onOpenPost: (post) => runDetached(
				() => this.openDailyNoteAtPost(post),
				`open the post in ${post.file.path}`,
				'Could not open the daily note.',
			),
			onOpenThread: (post) => runDetached(
				() => this.thread.open(post),
				'open the thread',
				'Could not open the thread.',
			),
			onReply: (card, button, post, stayOnTimeline) => {
				this.inlineEditor.openReply(card, button, post, postKey(post), stayOnTimeline);
			},
			onSearchTag: (tag) => this.searchForTag(tag),
			onTaskChange: (post, task, checked, saved) => this.saveTaskState(post, task, checked, saved),
		});
		this.inlineEditor = new InlinePostEditor(this.app, this, this.contentEl, this.service, this.postRenderer, {
			refresh: () => this.refreshTimeline(true),
			focusTimeline: () => this.focus('view'),
			onReplySaved: (parent, stayOnTimeline) => this.thread.onReplySaved(parent, stayOnTimeline),
		});
		this.surface = new TimelineSurface(this.contentEl, this.postRenderer, {
			closeDraft: () => this.inlineEditor.clear(),
			setComposerShown: (shown) => {
				if (shown) this.composer?.element.show();
				else this.composer?.element.hide();
			},
		});
		this.list = new TimelineList(this.surface, {
			getTimeline: () => this.loadedTimeline,
			getSearchQuery: () => this.composer?.getSearchQuery() ?? '',
			updateStats: (posts, hits) => this.composer?.updateStats(posts, hits),
		});
		this.thread = new ThreadView(this.surface, this.passes, {
			getTimeline: () => this.loadedTimeline,
			renderTimeline: (signal, previousFocus) => this.list.render(signal, false, previousFocus),
		});
		this.register(() => {
			this.disposed = true;
			this.passes.cancel();
			this.postRenderer.clear();
		});
	}

	/**
	 * Shows the panel in its host: loads it unless the host already added it
	 * as a child, routes the host's keys, and renders the timeline. The host
	 * unloads the panel when it closes. Resolves once the first render ends;
	 * a failure is reported instead of rejecting.
	 */
	async attach(host: TimelinePanelHost): Promise<void> {
		this.host = host;
		this.load();
		registerTimelineKeyboard(this, host.scope, this.contentEl, {
			focus: (target) => this.focus(target),
			leaveDisplay: host.leaveDisplay,
			submit: (target) => this.submitFromShortcut(target),
			goBack: () => this.thread.goBack(),
		}, host.keyboardBoundary);
		try {
			await this.mount();
		} catch (error) {
			console.error('Soliloquy: failed to open timeline', error);
			if (!this.disposed) new Notice('Could not load the timeline.');
		}
	}

	private async mount(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('soliloquy-view');
		root.tabIndex = -1;

		this.composer = new SoliloquyComposer(this.app, root, this, {
			onPost: () => runDetached(() => this.submit(), 'save the post', 'Could not save the post.'),
			onSearchChange: () => runDetached(
				() => this.list.render(this.passes.start(), true),
				'search the timeline',
				'Could not search the timeline.',
			),
		});
		this.surface.timelineEl = root.createDiv({
			cls: 'soliloquy-timeline',
			attr: {
				role: 'feed',
				'aria-label': 'Soliloquy timeline',
				'aria-busy': 'false',
			},
		});
		this.registerDomEvent(root, 'keydown', (event) => this.handlePostContainerKeydown(event));
		this.inlineEditor.registerFocusEvents();
		// Every display, including the one that saved, refreshes on this signal.
		// A background refresh is logged only; the service reports unreadable notes.
		this.register(this.service.onChange(() => runDetached(
			() => this.refreshTimeline(true, true),
			'refresh the timeline',
		)));
		await this.refreshTimeline();
	}

	focus(target: SoliloquyFocusTarget = 'view'): void {
		if (this.disposed) return;
		if (target === 'view') {
			(this.surface.getFocusedCard() ?? this.contentEl).focus({ preventScroll: true });
			return;
		}
		if (!this.composer) return;

		const wasThread = this.thread.isOpen();
		this.thread.close();
		this.composer.element.show();
		const searchMode = target === 'search';
		const modeChanged = this.composer.isSearching() !== searchMode;
		// Mode switches keep the composer state; focusin cancels any inline draft.
		this.composer.setSearchMode(searchMode, wasThread || modeChanged);
	}

	submitFromShortcut(target: EventTarget | null): boolean {
		if (this.disposed) return false;
		if (this.composer?.input.containsTarget(target) && !this.composer.isSearching()) {
			runDetached(() => this.submit(), 'save the post', 'Could not save the post.');
			return true;
		}
		return this.inlineEditor.submitFromShortcut(target);
	}

	/**
	 * Loads the service snapshot and re-renders. With onlyIfChanged, a refresh
	 * that finds the snapshot already displayed leaves the DOM untouched.
	 * Background refreshes preserve open drafts; their changes are shown when
	 * the draft closes, which refreshes explicitly.
	 */
	async refreshTimeline(preserveDrafts = false, onlyIfChanged = false): Promise<void> {
		const timelineEl = this.surface.timelineEl;
		if (this.disposed || !timelineEl) return;
		if (preserveDrafts && this.inlineEditor.isOpen()) return;
		const previousTimelineFocus = captureFocusWithin(timelineEl);
		const signal = this.passes.start();
		timelineEl.setAttribute('aria-busy', 'true');
		try {
			const timeline = await this.service.getTimeline();
			if (signal.aborted) return;
			// An editor may have opened while the daily notes were being read.
			if (preserveDrafts && this.inlineEditor.isOpen()) return;
			if (onlyIfChanged && timeline === this.loadedTimeline) return;
			this.inlineEditor.clear();
			this.loadedTimeline = timeline;
			await this.surface.preserveScrollPosition(signal, async () => {
				if (await this.thread.refresh(signal, previousTimelineFocus)) return;
				await this.list.render(signal, false, previousTimelineFocus);
			});
		} finally {
			if (!signal.aborted) timelineEl.setAttribute('aria-busy', 'false');
		}
	}

	private async submit(): Promise<void> {
		const input = this.composer?.input;
		if (this.posting || !input || !input.value.trim() || this.composer?.isSearching()) return;
		const submitted = input.value;
		const previousFocus = captureFocusWithin(this.contentEl);
		this.posting = true;
		this.composer?.setPosting(true);
		try {
			await this.service.addPost(submitted);
			if (this.disposed) return;
			const stillPosting = !this.composer?.isSearching() && input.value === submitted;
			if (stillPosting) this.composer?.clearPost();
			await this.refreshTimeline(true);
			if (!this.disposed && stillPosting && !this.composer?.isSearching() && !this.inlineEditor.isOpen()
				&& shouldRestoreFocusWithin(this.contentEl, previousFocus)) input.focus();
		} catch (error) {
			console.error('Soliloquy: failed to save post', error);
			new Notice(error instanceof TimelineUserError
				? `Could not save the post. ${error.message}`
				: 'Could not save the post.');
		} finally {
			this.posting = false;
			if (!this.disposed) this.composer?.setPosting(false);
		}
	}

	private searchForTag(tag: string): void {
		this.thread.close();
		this.surface.focusedPostKey = undefined;
		this.composer?.element.show();
		this.composer?.searchFor(tag);
	}

	private async openDailyNoteAtPost(post: TimelinePost): Promise<void> {
		this.host?.onNavigate?.();
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(post.file, { active: true });

		// Open Tab Settings may redirect the file to an existing leaf when it
		// deduplicates tabs, so use the active Markdown view after opening.
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.file?.path !== post.file.path) return;

		const start = { line: post.lineStart, ch: 0 };
		const end = { line: Math.max(post.lineStart, post.lineEnd - 1), ch: 0 };
		view.editor.setCursor(start);
		view.editor.scrollIntoView({ from: start, to: end }, true);
		view.editor.focus();
	}

	private movePostFocus(card: HTMLElement, direction: -1 | 1): boolean {
		const cards = this.surface.getRenderedPostCards();
		const currentIndex = cards.indexOf(card);
		if (currentIndex < 0) return false;

		const nextCard = cards[currentIndex + direction];
		if (nextCard) {
			this.surface.focusCard(nextCard, true, 'nearest');
			return true;
		}

		const canLoadMore = direction === 1 && !this.thread.isOpen() && this.list.hasMore();
		if (!canLoadMore) return false;
		if (this.list.isLoadingMore) return true;

		const signal = this.passes.current;
		runDetached(async () => {
			await this.list.loadMore(signal);
			if (signal.aborted || card.ownerDocument.activeElement !== card) return;
			const updatedCards = this.surface.getRenderedPostCards();
			const updatedIndex = updatedCards.indexOf(card);
			const loadedNextCard = updatedCards[updatedIndex + 1];
			if (loadedNextCard) this.surface.focusCard(loadedNextCard, true, 'nearest');
		}, 'load older posts', 'Could not load older posts.');
		return true;
	}

	private handlePostContainerKeydown(event: KeyboardEvent): void {
		if (event.target !== this.contentEl && event.target !== this.surface.timelineEl) return;
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		const focusedCard = this.surface.getFocusedCard();
		if (!focusedCard) return;
		const direction = event.key === 'ArrowUp' ? -1 : 1;
		if (!this.movePostFocus(focusedCard, direction)) return;
		event.preventDefault();
		event.stopPropagation();
	}

	private async saveTaskState(
		post: TimelinePost,
		task: MarkdownTask,
		checked: boolean,
		saved: (post: TimelinePost) => void,
	): Promise<void> {
		try {
			saved(await this.service.updateTask(post, task, checked, { verifiedByRenderer: true }));
		} catch (error) {
			console.error('Soliloquy: failed to update task', error);
			new Notice('Could not update the task. Reload the timeline and try again.');
			try {
				await this.refreshTimeline(true);
			} catch (refreshError) {
				console.error('Soliloquy: failed to refresh after task failure', refreshError);
			}
			throw error; // Let the card restore the checkbox when the update was rejected.
		}
		try {
			await this.refreshTimeline(true);
		} catch (error) {
			console.error('Soliloquy: failed to refresh after updating task', error);
			new Notice('Task saved, but the timeline could not refresh.');
		}
	}
}
