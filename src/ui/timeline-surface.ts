import type { TimelinePost } from '../types';
import { shouldRestoreFocusWithin } from './focus-preservation';
import type { PostCardRenderer, PostContext } from './post-card';
import { reportFailure } from './report-failure';

export type TimelinePage = 'timeline' | 'thread';

interface TimelineSurfaceHooks {
	/** Closes the open inline draft before its card is replaced. */
	closeDraft: () => void;
	setComposerShown: (shown: boolean) => void;
}

export function postKey(post: TimelinePost): string {
	return post.blockId ?? `${post.file.path}:${post.lineStart}:${post.time}`;
}

/**
 * Waits for the next frame of the window that shows `element`, which may be
 * a popout window rather than the main one.
 */
export function nextAnimationFrame(element: HTMLElement): Promise<void> {
	return new Promise((resolve) => element.win.requestAnimationFrame(() => resolve()));
}

/**
 * The timeline element shared by the list and thread pages: the keyboard
 * focused card, card focus restoration, and the reader's scroll position
 * across re-renders.
 */
export class TimelineSurface {
	timelineEl?: HTMLElement;
	/** Key of the card that receives keyboard focus. */
	focusedPostKey?: string;
	private scrollLock?: AbortSignal;

	constructor(
		/** The scrolling display root. */
		readonly contentEl: HTMLElement,
		readonly cards: PostCardRenderer,
		private readonly hooks: TimelineSurfaceHooks,
	) {}

	/** Closes the draft and removes the rendered cards to start a page. */
	beginPage(page: TimelinePage): HTMLElement | undefined {
		const timelineEl = this.timelineEl;
		if (!timelineEl) return undefined;
		const thread = page === 'thread';
		this.hooks.setComposerShown(!thread);
		this.hooks.closeDraft();
		this.cards.clear();
		timelineEl.empty();
		if (thread) timelineEl.addClass('is-thread-page');
		else timelineEl.removeClass('is-thread-page');
		timelineEl.setAttribute('role', thread ? 'region' : 'feed');
		timelineEl.setAttribute('aria-label', thread ? 'Soliloquy thread' : 'Soliloquy timeline');
		return timelineEl;
	}

	/**
	 * Renders one card. A card that fails shows an error card in its place and
	 * is logged, so the rest of the page still renders.
	 */
	async renderCard(
		post: TimelinePost,
		container: HTMLElement,
		context: PostContext = 'timeline',
	): Promise<void> {
		try {
			await this.cards.render(post, container, context);
		} catch (error) {
			reportFailure(error, `render the post from ${post.date} at ${post.time} in ${post.file.path}`);
		}
	}

	getRenderedPostCards(): HTMLElement[] {
		return Array.from(
			this.timelineEl?.querySelectorAll<HTMLElement>('.soliloquy-post[data-post-key]') ?? [],
		);
	}

	getFocusedCard(): HTMLElement | null {
		return this.timelineEl?.querySelector<HTMLElement>(
			'.soliloquy-post.is-focused[data-post-key]',
		) ?? null;
	}

	isFocused(post: TimelinePost): boolean {
		return this.focusedPostKey === postKey(post);
	}

	markFocused(card: HTMLElement, post: TimelinePost): void {
		this.focusedPostKey = postKey(post);
		this.timelineEl
			?.querySelectorAll('.soliloquy-post.is-focused')
			.forEach((element) => element.removeClass('is-focused'));
		card.addClass('is-focused');
	}

	focusCard(
		card: HTMLElement,
		scroll: boolean,
		block: ScrollLogicalPosition,
	): void {
		card.focus({ preventScroll: true });
		if (scroll) {
			const win = card.win;
			const behavior = win.matchMedia('(prefers-reduced-motion: reduce)').matches
				? 'auto'
				: 'smooth';
			win.requestAnimationFrame(() => card.scrollIntoView({ behavior, block }));
		}
	}

	/** Refocuses the focused card when focus was in the timeline before a render. */
	restoreRenderedPostFocus(
		previousTimelineFocus: Element | null,
		scroll: boolean,
	): void {
		if (!shouldRestoreFocusWithin(this.contentEl, previousTimelineFocus)) return;
		const card = this.getFocusedCard();
		if (card) this.focusCard(card, scroll, 'center');
	}

	/**
	 * Keeps the reader's place across a re-render: the first visible card stays
	 * at the same offset. At the top of the list, new posts stay visible instead.
	 */
	async preserveScrollPosition(signal: AbortSignal, render: () => Promise<void>): Promise<void> {
		const timelineEl = this.timelineEl;
		const scroller = this.contentEl;
		if (!timelineEl || !(scroller.scrollTop > 0)) {
			await render();
			return;
		}
		const scrollTop = scroller.scrollTop;
		const anchor = this.findScrollAnchor();
		// Hold the height so emptying the list does not clamp the scroll position.
		timelineEl.setCssProps({ '--soliloquy-locked-height': `${timelineEl.offsetHeight}px` });
		timelineEl.addClass('is-height-locked');
		this.scrollLock = signal;
		try {
			await render();
		} finally {
			if (this.scrollLock === signal) {
				this.scrollLock = undefined;
				timelineEl.removeClass('is-height-locked');
				if (!signal.aborted) {
					const card = anchor && this.getRenderedPostCards()
						.find((element) => element.dataset.postKey === anchor.key);
					scroller.scrollTop = card
						? scroller.scrollTop + card.getBoundingClientRect().top
							- scroller.getBoundingClientRect().top - anchor.offset
						: scrollTop;
				}
			}
		}
	}

	private findScrollAnchor(): { key: string; offset: number } | undefined {
		const top = this.contentEl.getBoundingClientRect().top;
		for (const card of this.getRenderedPostCards()) {
			const rect = card.getBoundingClientRect();
			if (rect.bottom > top && card.dataset.postKey) {
				return { key: card.dataset.postKey, offset: rect.top - top };
			}
		}
		return undefined;
	}
}
