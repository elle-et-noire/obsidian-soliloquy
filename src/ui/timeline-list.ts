import type { TimelineSnapshot } from '../services/timeline-service';
import type { TimelinePost } from '../types';
import { runDetached } from './report-failure';
import { nextAnimationFrame, postKey, type TimelineSurface } from './timeline-surface';

const TIMELINE_PAGE_SIZE = 50;
const RENDER_BATCH_SIZE = 8;

interface TimelineListSource {
	/** The loaded posts and their index. */
	getTimeline: () => TimelineSnapshot;
	getSearchQuery: () => string;
	updateStats: (posts: readonly TimelinePost[], hits: number) => void;
}

/** Renders the searchable, paged timeline feed and its "Load older" control. */
export class TimelineList {
	private results: readonly TimelinePost[] = [];
	private visiblePostCount = TIMELINE_PAGE_SIZE;
	private renderedCount = 0;
	private loadMoreEl?: HTMLElement;
	private loadingMore = false;

	constructor(
		private readonly surface: TimelineSurface,
		private readonly source: TimelineListSource,
	) {}

	get isLoadingMore(): boolean {
		return this.loadingMore;
	}

	hasMore(): boolean {
		return this.renderedCount < this.results.length;
	}

	/**
	 * Replaces the page with the posts matching the search query. Earlier
	 * pages stay loaded unless resetPaging is set (a new search).
	 */
	async render(
		signal: AbortSignal,
		resetPaging = false,
		previousTimelineFocus: Element | null = null,
	): Promise<void> {
		const timelineEl = this.surface.beginPage('timeline');
		if (!timelineEl) return;
		timelineEl.setAttribute('aria-busy', 'true');
		if (resetPaging) this.visiblePostCount = TIMELINE_PAGE_SIZE;
		const { posts: allPosts, index } = this.source.getTimeline();
		const query = this.source.getSearchQuery();
		const terms = query.split(/\s+/).filter(Boolean);
		const posts = terms.length === 0
			? allPosts
			: allPosts.filter((post) => {
				const searchable = index.getSearchText(post);
				return terms.every((term) => searchable.includes(term));
			});
		this.source.updateStats(allPosts, posts.length);
		this.results = posts;
		const focusedPost = posts.find((post) => postKey(post) === this.surface.focusedPostKey)
			?? posts[0];
		this.surface.focusedPostKey = focusedPost ? postKey(focusedPost) : undefined;
		this.renderedCount = 0;
		this.loadMoreEl = undefined;
		if (posts.length === 0) {
			timelineEl.createDiv({
				text: terms.length > 0 ? 'No matching posts.' : 'No posts yet.',
				cls: 'soliloquy-empty',
				attr: { role: 'status' },
			});
			if (!signal.aborted) timelineEl.setAttribute('aria-busy', 'false');
			return;
		}
		const initialCount = Math.min(this.visiblePostCount, posts.length);
		try {
			await this.renderPostBatch(timelineEl, posts.slice(0, initialCount), signal);
			if (signal.aborted) return;
			this.renderedCount = initialCount;
			this.renderLoadMoreControl(signal);
			this.surface.restoreRenderedPostFocus(previousTimelineFocus, false);
		} finally {
			if (!signal.aborted) timelineEl.setAttribute('aria-busy', 'false');
		}
	}

	/** Appends the next page of results rendered by the pass of signal. */
	async loadMore(signal: AbortSignal, button?: HTMLButtonElement): Promise<void> {
		const timelineEl = this.surface.timelineEl;
		if (this.loadingMore || signal.aborted || !timelineEl) return;
		this.loadingMore = true;
		if (button) button.disabled = true;
		const start = this.renderedCount;
		const end = Math.min(start + TIMELINE_PAGE_SIZE, this.results.length);
		this.loadMoreEl?.remove();
		this.loadMoreEl = undefined;
		timelineEl.setAttribute('aria-busy', 'true');
		try {
			await this.renderPostBatch(timelineEl, this.results.slice(start, end), signal);
			if (signal.aborted) return;
			this.renderedCount = end;
			this.visiblePostCount = end;
			this.renderLoadMoreControl(signal);
		} finally {
			this.loadingMore = false;
			if (!signal.aborted) timelineEl.setAttribute('aria-busy', 'false');
		}
	}

	private async renderPostBatch(
		timelineEl: HTMLElement,
		posts: readonly TimelinePost[],
		signal: AbortSignal,
	): Promise<void> {
		for (let index = 0; index < posts.length; index += RENDER_BATCH_SIZE) {
			if (signal.aborted) return;
			const batch = posts.slice(index, index + RENDER_BATCH_SIZE);
			// A failed card shows an error card; the rest of the batch still renders.
			await Promise.all(batch.map((post) => this.surface.renderCard(post, timelineEl)));
			if (signal.aborted) return;
			if (index + RENDER_BATCH_SIZE < posts.length) await nextAnimationFrame(timelineEl);
		}
	}

	private renderLoadMoreControl(signal: AbortSignal): void {
		this.loadMoreEl?.remove();
		this.loadMoreEl = undefined;
		const timelineEl = this.surface.timelineEl;
		if (!timelineEl || this.renderedCount >= this.results.length) return;
		const remaining = this.results.length - this.renderedCount;
		const amount = Math.min(TIMELINE_PAGE_SIZE, remaining);
		const control = timelineEl.createDiv({ cls: 'soliloquy-load-more' });
		this.loadMoreEl = control;
		const button = control.createEl('button', {
			text: `Load ${amount} older posts`,
			attr: {
				type: 'button',
				'aria-label': `Load ${amount} older posts; ${remaining} remaining`,
			},
		});
		button.addEventListener('click', () => runDetached(
			() => this.loadMore(signal, button),
			'load older posts',
			'Could not load older posts.',
		));
	}
}
