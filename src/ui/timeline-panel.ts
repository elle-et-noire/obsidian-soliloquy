import {
	App,
	Component,
	MarkdownView,
	Notice,
	type Scope,
	setIcon,
} from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { TimelineIndex } from '../services/timeline-index';
import type { MarkdownTask } from '../services/markdown-tasks';
import type { TimelinePost } from '../types';
import { SoliloquyComposer } from './composer';
import { SoliloquyTextEditor } from './text-editor';
import { captureFocusWithin, shouldRestoreFocusWithin } from './focus-preservation';
import { PostCardRenderer, type PostContext } from './post-card';
import { registerTimelineKeyboard } from './timeline-keyboard';

export type SoliloquyFocusTarget = 'view' | 'search' | 'post';

const TIMELINE_PAGE_SIZE = 50;
const RENDER_BATCH_SIZE = 8;

type NavigationEntry =
	| { type: 'timeline'; scrollTop: number; focusedPostKey?: string }
	| { type: 'thread'; post: TimelinePost };

interface InlineDraft {
	post: TimelinePost;
	input: SoliloquyTextEditor;
	button: HTMLButtonElement;
	saving: boolean;
}

export class TimelinePanel extends Component {
	private timelineEl?: HTMLElement;
	private composer?: SoliloquyComposer;
	private readonly postRenderer: PostCardRenderer;
	private posts: TimelinePost[] = [];
	private postIndex = new TimelineIndex([]);
	private editing?: InlineDraft & { card: HTMLElement };
	private replying?: InlineDraft & { stayOnTimeline: boolean };
	private posting = false;
	private activeThread?: TimelinePost;
	private inlineReplyComposerEl?: HTMLElement;
	private inlineReplyButtonEl?: HTMLButtonElement;
	private inlineReplyPostKey?: string;
	private focusedPostKey?: string;
	private readonly navigationHistory: NavigationEntry[] = [];
	private renderEpoch = 0;
	private timelineResults: TimelinePost[] = [];
	private visiblePostCount = TIMELINE_PAGE_SIZE;
	private renderedTimelineCount = 0;
	private loadMoreEl?: HTMLElement;
	private loadingMore = false;
	private disposed = false;

	constructor(
		private readonly app: App,
		readonly contentEl: HTMLElement,
		private readonly service: TimelineService,
		private readonly onNavigate?: () => void,
	) {
		super();
		this.postRenderer = new PostCardRenderer(this.app, this, {
			getReplies: (post) => this.postIndex.getReplies(post),
			getPostKey: (post) => this.postKey(post),
			isFocused: (post) => this.focusedPostKey === this.postKey(post),
			onEdit: (card, post) => this.openEditor(card, post),
			onFocus: (card, post) => this.focusPost(card, post),
			onMoveFocus: (card, direction) => this.movePostFocus(card, direction),
			onOpenDate: (post) => {
				this.onNavigate?.();
				void this.app.workspace.getLeaf('tab').openFile(post.file, { active: true });
			},
			onOpenLink: (destination, post) => {
				this.onNavigate?.();
				void this.app.workspace.openLinkText(destination, post.file.path, true);
			},
			onOpenPost: (post) => void this.openDailyNoteAtPost(post),
			onOpenThread: (post) => void this.openThread(post),
			onReply: (card, button, post, stayOnTimeline) => {
				this.openInlineReply(card, button, post, stayOnTimeline);
			},
			onSearchTag: (tag) => this.searchForTag(tag),
			onTaskChange: (post, task, checked) => {
				void this.saveTaskState(post, task, checked);
			},
		});
		this.register(() => {
			this.disposed = true;
			this.renderEpoch++;
			this.postRenderer.clear();
		});
	}

	registerKeyboard(scope: Scope, leaveDisplay: () => void): void {
		registerTimelineKeyboard(this, scope, this.contentEl, {
			focus: (target) => this.focus(target),
			leaveDisplay,
			submit: (target) => this.submitFromShortcut(target),
			goBack: () => this.goBack(),
		});
	}

	async mount(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('soliloquy-view');
		root.tabIndex = -1;

		this.composer = new SoliloquyComposer(this.app, root, this, {
			onPost: () => void this.submit(),
			onSearchChange: () => void this.renderTimeline(undefined, true),
		});
		this.timelineEl = root.createDiv({
			cls: 'soliloquy-timeline',
			attr: {
				role: 'feed',
				'aria-label': 'Soliloquy timeline',
				'aria-busy': 'false',
			},
		});
		this.registerDomEvent(root, 'keydown', (event) => this.handlePostContainerKeydown(event));
		this.registerDomEvent(root.ownerDocument, 'focusin', (event) => this.handleTextFocus(event));
		await this.refreshTimeline();
	}

	focus(target: SoliloquyFocusTarget = 'view'): void {
		if (this.disposed) return;
		if (target === 'view') {
			const card = this.timelineEl?.querySelector<HTMLElement>(
				'.soliloquy-post.is-focused[data-post-key]',
			);
			(card ?? this.contentEl).focus({ preventScroll: true });
			return;
		}
		if (!this.composer) return;

		const wasThread = this.activeThread !== undefined;
		this.activeThread = undefined;
		this.navigationHistory.length = 0;
		this.composer.element.show();
		const searchMode = target === 'search';
		const modeChanged = this.composer.isSearching() !== searchMode;
		// Mode switches keep the composer state; focusin cancels any inline draft.
		this.composer.setSearchMode(searchMode, wasThread || modeChanged);
	}

	submitFromShortcut(target: EventTarget | null): boolean {
		if (this.disposed) return false;
		if (this.composer?.input.containsTarget(target) && !this.composer.isSearching()) {
			void this.submit();
			return true;
		}
		if (this.editing?.input.containsTarget(target)) {
			void this.saveEdit(this.editing.post, this.editing.input.value);
			return true;
		}
		if (this.replying?.input.containsTarget(target)) {
			const { post, input, stayOnTimeline } = this.replying;
			void this.saveReply(post, input.value, stayOnTimeline);
			return true;
		}
		return false;
	}

	goBack(): boolean {
		if (!this.activeThread) return false;
		void this.navigateBack();
		return true;
	}

	async refreshTimeline(preserveDrafts = false): Promise<void> {
		if (this.disposed || !this.timelineEl) return;
		if (preserveDrafts && this.hasOpenEditor()) return;
		const previousTimelineFocus = captureFocusWithin(this.timelineEl);
		const epoch = ++this.renderEpoch;
		this.timelineEl.setAttribute('aria-busy', 'true');
		try {
			const posts = await this.service.getPosts();
			if (epoch !== this.renderEpoch) return;
			// An editor may have opened while the daily notes were being read.
			if (preserveDrafts && this.hasOpenEditor()) return;
			this.clearEditor();
			this.posts = posts;
			this.postIndex = new TimelineIndex(posts);
			this.composer?.updateStats(this.posts);
			if (this.activeThread) {
				const current = this.findCurrentPost(this.activeThread);
				if (current) {
					this.activeThread = current;
					await this.renderThreadPage(current, epoch, previousTimelineFocus);
					return;
				}
				this.activeThread = undefined;
				this.navigationHistory.length = 0;
				this.focusedPostKey = undefined;
			}
			await this.renderTimeline(epoch, false, previousTimelineFocus);
		} finally {
			if (epoch === this.renderEpoch) this.timelineEl.setAttribute('aria-busy', 'false');
		}
	}

	private hasOpenEditor(): boolean {
		return this.editing !== undefined || this.inlineReplyComposerEl !== undefined;
	}

	private handleTextFocus(event: FocusEvent): void {
		const target = event.target as HTMLElement | null;
		if (!target?.closest) return;
		const field = target.closest('textarea, input, [contenteditable="true"], [contenteditable=""]');
		if (!field) return;
		if (field.tagName === 'INPUT'
			&& !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes((field as HTMLInputElement).type)) return;
		// Vim prompts and other descendants of the same editor are not a new field.
		if (this.editing?.input.containsTarget(target) || this.replying?.input.containsTarget(target)) return;
		if (this.editing) void this.cancelEdit(false);
		if (this.replying) void this.cancelReply(false);
	}

	private async renderTimeline(
		epoch = ++this.renderEpoch,
		resetVisiblePosts = false,
		previousTimelineFocus: Element | null = null,
	): Promise<void> {
		if (!this.timelineEl) return;
		this.timelineEl.setAttribute('aria-busy', 'true');
		this.composer?.element.show();
		this.closeInlineReply(false);
		this.timelineEl.removeClass('is-thread-page');
		this.timelineEl.setAttribute('role', 'feed');
		this.timelineEl.setAttribute('aria-label', 'Soliloquy timeline');
		this.clearEditor();
		if (resetVisiblePosts) this.visiblePostCount = TIMELINE_PAGE_SIZE;
		const query = this.composer?.getSearchQuery() ?? '';
		const terms = query.split(/\s+/).filter(Boolean);
		const posts = terms.length === 0
			? this.posts
			: this.posts.filter((post) => {
				const searchable = this.postIndex.getSearchText(post);
				return terms.every((term) => searchable.includes(term));
			});
		this.composer?.updateStats(this.posts, posts.length);
		this.timelineResults = posts;
		const focusedPost = posts.find((post) => this.postKey(post) === this.focusedPostKey)
			?? posts[0];
		this.focusedPostKey = focusedPost ? this.postKey(focusedPost) : undefined;
		this.renderedTimelineCount = 0;
		this.loadMoreEl = undefined;
		this.postRenderer.clear();
		this.timelineEl.empty();
		if (posts.length === 0) {
			this.timelineEl.createDiv({
				text: terms.length > 0 ? 'No matching posts.' : 'No posts yet.',
				cls: 'soliloquy-empty',
				attr: { role: 'status' },
			});
			if (epoch === this.renderEpoch) this.timelineEl.setAttribute('aria-busy', 'false');
			return;
		}
		const initialCount = Math.min(this.visiblePostCount, posts.length);
		try {
			await this.renderPostBatch(posts.slice(0, initialCount), epoch);
			if (epoch !== this.renderEpoch) return;
			this.renderedTimelineCount = initialCount;
			this.renderLoadMoreControl(epoch);
			this.restoreRenderedPostFocus(previousTimelineFocus, false);
		} finally {
			if (epoch === this.renderEpoch) {
				this.timelineEl.setAttribute('aria-busy', 'false');
			}
		}
	}

	private async renderPostBatch(posts: TimelinePost[], epoch: number): Promise<void> {
		if (!this.timelineEl) return;
		for (let index = 0; index < posts.length; index += RENDER_BATCH_SIZE) {
			if (epoch !== this.renderEpoch) return;
			const batch = posts.slice(index, index + RENDER_BATCH_SIZE);
			await Promise.all(batch.map((post) => this.renderPost(post, this.timelineEl!)));
			if (epoch !== this.renderEpoch) return;
			if (index + RENDER_BATCH_SIZE < posts.length) await nextAnimationFrame();
		}
	}

	private renderLoadMoreControl(epoch: number): void {
		this.loadMoreEl?.remove();
		this.loadMoreEl = undefined;
		if (!this.timelineEl || this.renderedTimelineCount >= this.timelineResults.length) return;
		const remaining = this.timelineResults.length - this.renderedTimelineCount;
		const amount = Math.min(TIMELINE_PAGE_SIZE, remaining);
		const control = this.timelineEl.createDiv({ cls: 'soliloquy-load-more' });
		this.loadMoreEl = control;
		const button = control.createEl('button', {
			text: `Load ${amount} older posts`,
			attr: {
				type: 'button',
				'aria-label': `Load ${amount} older posts; ${remaining} remaining`,
			},
		});
		button.addEventListener('click', () => void this.loadMorePosts(epoch, button));
	}

	private async loadMorePosts(epoch: number, button?: HTMLButtonElement): Promise<void> {
		if (this.loadingMore || epoch !== this.renderEpoch || !this.timelineEl) return;
		this.loadingMore = true;
		if (button) button.disabled = true;
		const start = this.renderedTimelineCount;
		const end = Math.min(start + TIMELINE_PAGE_SIZE, this.timelineResults.length);
		this.loadMoreEl?.remove();
		this.loadMoreEl = undefined;
		this.timelineEl.setAttribute('aria-busy', 'true');
		try {
			await this.renderPostBatch(this.timelineResults.slice(start, end), epoch);
			if (epoch !== this.renderEpoch) return;
			this.renderedTimelineCount = end;
			this.visiblePostCount = end;
			this.renderLoadMoreControl(epoch);
		} finally {
			this.loadingMore = false;
			if (epoch === this.renderEpoch) this.timelineEl.setAttribute('aria-busy', 'false');
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
			if (!this.disposed && stillPosting && !this.composer?.isSearching() && !this.hasOpenEditor()
				&& shouldRestoreFocusWithin(this.contentEl, previousFocus)) input.focus();
		} catch (error) {
			console.error('Soliloquy: failed to save post', error);
			new Notice('Could not save the post.');
		} finally {
			this.posting = false;
			if (!this.disposed) this.composer?.setPosting(false);
		}
	}

	private searchForTag(tag: string): void {
		this.activeThread = undefined;
		this.navigationHistory.length = 0;
		this.focusedPostKey = undefined;
		this.composer?.element.show();
		this.composer?.searchFor(tag);
	}

	private async renderPost(
		post: TimelinePost,
		container: HTMLElement,
		context: PostContext = 'timeline',
	): Promise<void> {
		await this.postRenderer.render(post, container, context);
	}

	private async openDailyNoteAtPost(post: TimelinePost): Promise<void> {
		this.onNavigate?.();
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

	private openInlineReply(
		card: HTMLElement,
		button: HTMLButtonElement,
		post: TimelinePost,
		stayOnTimeline: boolean,
	): void {
		const postKey = this.postKey(post);
		if (this.inlineReplyPostKey === postKey) {
			void this.cancelReply();
			return;
		}

		this.closeInlineReply(false);
		if (this.editing) void this.cancelEdit(false);
		const composer = card.createDiv({
			cls: 'soliloquy-inline-reply-composer',
			attr: { role: 'group', 'aria-label': `Reply to post from ${post.date} at ${post.time}` },
		});
		composer.addEventListener('click', (event) => event.stopPropagation());
		this.inlineReplyComposerEl = composer;
		this.inlineReplyButtonEl = button;
		this.inlineReplyPostKey = postKey;
		button.setAttribute('aria-expanded', 'true');
		const input = this.addChild(new SoliloquyTextEditor(this.app, composer, {
			cls: 'soliloquy-reply-input',
			placeholder: 'Ctrl + Enter to reply',
			label: 'Write a reply',
		}));
		const actions = composer.createDiv({ cls: 'soliloquy-inline-reply-actions' });
		const cancel = actions.createEl('button', {
			attr: { type: 'button', 'aria-label': 'Cancel reply' },
		});
		setIcon(cancel, 'x');
		const submit = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { type: 'button', 'aria-label': 'Reply' },
		});
		submit.disabled = true;
		setIcon(submit, 'send');
		const draft = { post, input, stayOnTimeline, button: submit, saving: false };
		this.replying = draft;
		input.onChange = () => { submit.disabled = draft.saving || !input.value.trim(); };
		cancel.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.cancelReply();
		});
		submit.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.saveReply(post, input.value, stayOnTimeline);
		});
		input.focus();
	}

	private async cancelReply(restoreFocus = true): Promise<void> {
		this.closeInlineReply(restoreFocus);
		try {
			await this.refreshTimeline(true);
		} catch (error) {
			console.error('Soliloquy: failed to refresh cancelled reply', error);
			new Notice('Could not refresh the timeline.');
		}
	}

	private closeInlineReply(restoreFocus = true): void {
		if (this.replying) this.removeChild(this.replying.input);
		this.replying = undefined;
		const button = this.inlineReplyButtonEl;
		button?.setAttribute('aria-expanded', 'false');
		this.inlineReplyComposerEl?.remove();
		this.inlineReplyComposerEl = undefined;
		this.inlineReplyButtonEl = undefined;
		this.inlineReplyPostKey = undefined;
		if (restoreFocus) button?.focus();
	}

	private async openThread(post: TimelinePost): Promise<void> {
		if (this.activeThread && this.postKey(this.activeThread) === this.postKey(post)) return;
		const previousTimelineFocus = captureFocusWithin(this.timelineEl!);
		if (this.activeThread) {
			this.navigationHistory.push({ type: 'thread', post: this.activeThread });
		} else {
			this.navigationHistory.push({
				type: 'timeline',
				scrollTop: this.contentEl.scrollTop,
				focusedPostKey: this.focusedPostKey,
			});
		}
		const epoch = ++this.renderEpoch;
		this.activeThread = post;
		this.focusedPostKey = this.postKey(post);
		await this.renderThreadPage(
			post,
			epoch,
			previousTimelineFocus ?? this.contentEl.ownerDocument.body,
		);
	}

	private async renderThreadPage(
		post: TimelinePost,
		epoch: number,
		previousTimelineFocus: Element | null = null,
	): Promise<void> {
		if (!this.timelineEl) return;
		this.closeInlineReply(false);
		this.composer?.element.hide();
		this.clearEditor();
		this.postRenderer.clear();
		this.timelineEl.empty();
		this.timelineEl.addClass('is-thread-page');
		this.timelineEl.setAttribute('role', 'region');
		this.timelineEl.setAttribute('aria-label', 'Soliloquy thread');
		const navigation = this.timelineEl.createDiv({ cls: 'soliloquy-thread-navigation' });
		const back = navigation.createEl('button', {
			cls: 'soliloquy-back-button',
			attr: {
				type: 'button',
				'aria-label': 'Back',
				'aria-keyshortcuts': 'Alt+ArrowLeft',
			},
		});
		setIcon(back, 'arrow-left');
		back.addEventListener('click', () => void this.navigateBack());

		const thread = this.timelineEl.createDiv({ cls: 'soliloquy-thread' });
		const path = this.findAncestorPath(post);
		for (const ancestor of path) {
			const node = thread.createDiv({ cls: 'soliloquy-thread-node is-ancestor has-next' });
			await this.renderPost(ancestor, node, 'reply');
			if (epoch !== this.renderEpoch) return;
		}

		const selectedNode = thread.createDiv({ cls: 'soliloquy-thread-node is-selected' });
		await this.renderPost(post, selectedNode, 'root');
		if (epoch !== this.renderEpoch) return;
		const visited = new Set(path.map((item) => this.postKey(item)));
		visited.add(this.postKey(post));
		await this.renderDescendants(thread, selectedNode, post, epoch, visited);
		if (epoch !== this.renderEpoch) return;
		this.restoreRenderedPostFocus(previousTimelineFocus, true);
	}

	private async navigateBack(): Promise<void> {
		const previousTimelineFocus = captureFocusWithin(this.timelineEl!);
		const epoch = ++this.renderEpoch;
		let previous = this.navigationHistory.pop();
		while (previous?.type === 'thread') {
			const post = this.findCurrentPost(previous.post);
			if (post) {
				this.activeThread = post;
				this.focusedPostKey = this.postKey(post);
				await this.renderThreadPage(post, epoch, previousTimelineFocus);
				return;
			}
			previous = this.navigationHistory.pop();
		}

		this.activeThread = undefined;
		this.focusedPostKey = previous?.focusedPostKey;
		await this.renderTimeline(epoch, false, previousTimelineFocus);
		if (epoch !== this.renderEpoch || previous?.type !== 'timeline') return;
		window.requestAnimationFrame(() => {
			if (epoch === this.renderEpoch) this.contentEl.scrollTop = previous.scrollTop;
		});
	}

	private async saveReply(
		parent: TimelinePost,
		content: string,
		stayOnTimeline = false,
	): Promise<void> {
		const draft = this.replying;
		if (!draft || draft.post !== parent || draft.saving || !content.trim()) return;
		this.setDraftSaving(draft, true);
		try {
			await this.service.addReply(parent, content);
			if (this.disposed) return;
			if (this.replying === draft && draft.input.value === content) {
				this.closeInlineReply();
				if (stayOnTimeline) {
					this.activeThread = undefined;
					this.navigationHistory.length = 0;
				} else {
					this.activeThread = this.activeThread ?? this.findThreadRoot(parent);
				}
			}
			await this.refreshTimeline(true);
		} catch (error) {
			console.error('Soliloquy: failed to save reply', error);
			new Notice('Could not save the reply.');
		} finally {
			this.setDraftSaving(draft, false);
		}
	}

	private async renderDescendants(
		container: HTMLElement,
		parentNode: HTMLElement,
		parent: TimelinePost,
		epoch: number,
		visited: Set<string>,
	): Promise<void> {
		const children = this.findChildren(parent).filter((child) => !visited.has(this.postKey(child)));
		if (children.length === 0) return;

		if (children.length === 1) {
			const child = children[0];
			if (!child) return;
			const key = this.postKey(child);
			visited.add(key);
			parentNode.addClass('has-next');
			const node = container.createDiv({ cls: 'soliloquy-thread-node is-descendant' });
			await this.renderPost(child, node, 'reply');
			if (epoch !== this.renderEpoch) return;
			await this.renderDescendants(container, node, child, epoch, visited);
			return;
		}

		const choices = container.createDiv({ cls: 'soliloquy-thread-choices' });
		for (const child of children) {
			const node = choices.createDiv({ cls: 'soliloquy-thread-node is-choice' });
			await this.renderPost(child, node, 'reply');
			if (epoch !== this.renderEpoch) return;
		}
	}

	private findChildren(parent: TimelinePost): TimelinePost[] {
		return this.postIndex.getReplies(parent);
	}

	private findThreadRoot(post: TimelinePost): TimelinePost {
		let current = post;
		const visited = new Set<string>();
		while (current.replyToBlockId && !visited.has(this.postKey(current))) {
			visited.add(this.postKey(current));
			const parent = this.postIndex.getPostByBlockId(current.replyToBlockId);
			if (!parent) break;
			current = parent;
		}
		return current;
	}

	private findAncestorPath(post: TimelinePost): TimelinePost[] {
		const ancestors: TimelinePost[] = [];
		let current = post;
		const visited = new Set<string>([this.postKey(post)]);
		while (current.replyToBlockId) {
			const parent = this.postIndex.getPostByBlockId(current.replyToBlockId);
			if (!parent || visited.has(this.postKey(parent))) break;
			ancestors.unshift(parent);
			visited.add(this.postKey(parent));
			current = parent;
		}
		return ancestors;
	}

	private findCurrentPost(post: TimelinePost): TimelinePost | undefined {
		if (post.blockId) return this.postIndex.getPostByBlockId(post.blockId);
		return this.posts.find((candidate) =>
			candidate.file.path === post.file.path
			&& candidate.time === post.time
			&& candidate.content === post.content,
		);
	}

	private focusPost(card: HTMLElement, post: TimelinePost): void {
		this.focusedPostKey = this.postKey(post);
		this.timelineEl
			?.querySelectorAll('.soliloquy-post.is-focused')
			.forEach((element) => element.removeClass('is-focused'));
		card.addClass('is-focused');
	}

	private movePostFocus(card: HTMLElement, direction: -1 | 1): boolean {
		const cards = this.getRenderedPostCards();
		const currentIndex = cards.indexOf(card);
		if (currentIndex < 0) return false;

		const nextCard = cards[currentIndex + direction];
		if (nextCard) {
			this.focusCard(nextCard, true, 'nearest');
			return true;
		}

		const canLoadMore = direction === 1
			&& !this.activeThread
			&& this.renderedTimelineCount < this.timelineResults.length;
		if (!canLoadMore) return false;
		if (this.loadingMore) return true;

		const epoch = this.renderEpoch;
		void this.loadMorePosts(epoch).then(() => {
			if (epoch !== this.renderEpoch || card.ownerDocument.activeElement !== card) return;
			const updatedCards = this.getRenderedPostCards();
			const updatedIndex = updatedCards.indexOf(card);
			const loadedNextCard = updatedCards[updatedIndex + 1];
			if (loadedNextCard) this.focusCard(loadedNextCard, true, 'nearest');
		});
		return true;
	}

	private handlePostContainerKeydown(event: KeyboardEvent): void {
		if (event.target !== this.contentEl && event.target !== this.timelineEl) return;
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		const focusedCard = this.timelineEl?.querySelector<HTMLElement>(
			'.soliloquy-post.is-focused[data-post-key]',
		);
		if (!focusedCard) return;
		const direction = event.key === 'ArrowUp' ? -1 : 1;
		if (!this.movePostFocus(focusedCard, direction)) return;
		event.preventDefault();
		event.stopPropagation();
	}

	private getRenderedPostCards(): HTMLElement[] {
		return Array.from(
			this.timelineEl?.querySelectorAll<HTMLElement>('.soliloquy-post[data-post-key]') ?? [],
		);
	}

	private focusCard(
		card: HTMLElement,
		scroll: boolean,
		block: ScrollLogicalPosition,
	): void {
		card.focus({ preventScroll: true });
		if (scroll) {
			const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
				? 'auto'
				: 'smooth';
			window.requestAnimationFrame(() => card.scrollIntoView({ behavior, block }));
		}
	}

	private restoreRenderedPostFocus(
		previousTimelineFocus: Element | null,
		scroll: boolean,
	): void {
		if (!shouldRestoreFocusWithin(this.contentEl, previousTimelineFocus)) return;
		const card = this.timelineEl?.querySelector<HTMLElement>(
			'.soliloquy-post.is-focused[data-post-key]',
		);
		if (card) this.focusCard(card, scroll, 'center');
	}

	private postKey(post: TimelinePost): string {
		return post.blockId ?? `${post.file.path}:${post.lineStart}:${post.time}`;
	}

	private openEditor(card: HTMLElement, post: TimelinePost): void {
		if (this.editing?.card === card) {
			this.editing.input.focus();
			return;
		}
		if (this.editing) void this.cancelEdit(false);
		this.closeInlineReply(false);
		this.focusedPostKey = this.postKey(post);
		this.postRenderer.releaseCard(card);
		card.empty();
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', `Edit post from ${post.date} at ${post.time}`);
		card.removeAttribute('aria-keyshortcuts');
		const input = this.addChild(new SoliloquyTextEditor(this.app, card, {
			cls: 'soliloquy-edit-input',
			placeholder: 'Ctrl + Enter to save',
			label: 'Edit post',
			value: post.content,
		}));
		const actions = card.createDiv({ cls: 'soliloquy-edit-actions' });
		const cancel = actions.createEl('button', {
			attr: { type: 'button', 'aria-label': 'Cancel edit' },
		});
		setIcon(cancel, 'x');
		const save = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { type: 'button', 'aria-label': 'Save edit' },
		});
		setIcon(save, 'check');

		const draft = { post, input, card, button: save, saving: false };
		this.editing = draft;
		save.disabled = !input.value.trim();
		input.onChange = () => { save.disabled = draft.saving || !input.value.trim(); };
		cancel.addEventListener('click', () => void this.cancelEdit());
		save.addEventListener('click', () => void this.saveEdit(post, input.value));
		input.focus();
	}

	private clearEditor(): void {
		const draft = this.editing;
		this.editing = undefined;
		if (draft) this.removeChild(draft.input);
	}

	private async cancelEdit(restoreFocus = true): Promise<void> {
		const draft = this.editing;
		if (!draft) return;
		const previousFocus = captureFocusWithin(this.timelineEl!);
		this.clearEditor();
		try {
			await this.postRenderer.restoreCard(draft.card, draft.post);
			if (restoreFocus && shouldRestoreFocusWithin(this.contentEl, previousFocus)) this.focus('view');
			await this.refreshTimeline(true);
		} catch (error) {
			console.error('Soliloquy: failed to refresh cancelled edit', error);
			new Notice('Could not refresh the timeline.');
		}
	}

	private async saveEdit(post: TimelinePost, content: string): Promise<void> {
		const draft = this.editing;
		if (!draft || draft.post !== post || draft.saving) return;
		if (!content.trim()) {
			new Notice('A post cannot be empty.');
			return;
		}
		this.setDraftSaving(draft, true);
		try {
			await this.service.updatePost(post, content);
			if (this.disposed) return;
			if (this.editing === draft && draft.input.value === content) this.clearEditor();
			await this.refreshTimeline(true);
		} catch (error) {
			console.error('Soliloquy: failed to edit post', error);
			new Notice('Could not edit the post. Reload the timeline and try again.');
		} finally {
			this.setDraftSaving(draft, false);
		}
	}

	private setDraftSaving(draft: InlineDraft, saving: boolean): void {
		draft.saving = saving;
		draft.button.disabled = saving || !draft.input.value.trim();
		draft.button.setAttribute('aria-busy', String(saving));
	}

	private async saveTaskState(
		post: TimelinePost,
		task: MarkdownTask,
		checked: boolean,
	): Promise<void> {
		try {
			await this.service.updateTask(post, task, checked);
			await this.refreshTimeline(true);
		} catch (error) {
			console.error('Soliloquy: failed to update task', error);
			new Notice('Could not update the task. Reload the timeline and try again.');
			await this.refreshTimeline(true);
		}
	}
}

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}
