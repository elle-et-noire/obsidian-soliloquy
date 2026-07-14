import {
	ItemView,
	MarkdownView,
	Notice,
	setIcon,
	WorkspaceLeaf,
} from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { TimelineIndex } from '../services/timeline-index';
import type { TimelinePost } from '../types';
import { resizeTextarea, SoliloquyComposer } from './composer';
import { PostCardRenderer, type PostContext } from './post-card';

export const SOLILOQUY_VIEW_TYPE = 'soliloquy-timeline';

const TIMELINE_PAGE_SIZE = 50;
const RENDER_BATCH_SIZE = 8;

type NavigationEntry =
	| { type: 'timeline'; scrollTop: number; focusedPostKey?: string }
	| { type: 'thread'; post: TimelinePost };

export class SoliloquyView extends ItemView {
	private timelineEl?: HTMLElement;
	private composer?: SoliloquyComposer;
	private readonly postRenderer: PostCardRenderer;
	private posts: TimelinePost[] = [];
	private postIndex = new TimelineIndex([]);
	private editing?: { post: TimelinePost; textarea: HTMLTextAreaElement };
	private replyTargets = new WeakMap<HTMLTextAreaElement, TimelinePost>();
	private timelineReplyTargets = new WeakSet<HTMLTextAreaElement>();
	private activeThread?: TimelinePost;
	private inlineReplyComposerEl?: HTMLElement;
	private inlineReplyButtonEl?: HTMLButtonElement;
	private inlineReplyPostKey?: string;
	private focusedPostKey?: string;
	private focusTimelineOnRender = true;
	private readonly navigationHistory: NavigationEntry[] = [];
	private renderEpoch = 0;
	private timelineResults: TimelinePost[] = [];
	private visiblePostCount = TIMELINE_PAGE_SIZE;
	private renderedTimelineCount = 0;
	private loadMoreEl?: HTMLElement;
	private loadingMore = false;

	constructor(leaf: WorkspaceLeaf, private readonly service: TimelineService) {
		super(leaf);
		this.postRenderer = new PostCardRenderer(this.app, this, {
			getReplies: (post) => this.postIndex.getReplies(post),
			getPostKey: (post) => this.postKey(post),
			isFocused: (post) => this.focusedPostKey === this.postKey(post),
			onEdit: (card, post) => this.openEditor(card, post),
			onFocus: (card, post, scroll) => this.focusPost(card, post, scroll),
			onMoveFocus: (card, direction) => this.movePostFocus(card, direction),
			onOpenDate: (post) => {
				void this.app.workspace.getLeaf('tab').openFile(post.file, { active: true });
			},
			onOpenLink: (destination, post) => {
				void this.app.workspace.openLinkText(destination, post.file.path, true);
			},
			onOpenPost: (post) => void this.openDailyNoteAtPost(post),
			onOpenThread: (post) => void this.openThread(post),
			onReply: (card, button, post, stayOnTimeline) => {
				this.openInlineReply(card, button, post, stayOnTimeline);
			},
			onSearchTag: (tag) => this.searchForTag(tag),
			onTaskChange: (post, taskIndex, checked) => {
				void this.saveTaskState(post, taskIndex, checked);
			},
		});
	}

	getViewType(): string {
		return SOLILOQUY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Soliloquy';
	}

	getIcon(): string {
		return 'messages-square';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('soliloquy-view');

		this.composer = new SoliloquyComposer(root, this, {
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
		await this.refreshTimeline();
	}

	submitFromShortcut(target: EventTarget | null): boolean {
		if (this.composer && target === this.composer.postInput) {
			void this.submit();
			return true;
		}
		if (this.editing && target === this.editing.textarea) {
			void this.saveEdit(this.editing.post, this.editing.textarea.value);
			return true;
		}
		if (target instanceof HTMLTextAreaElement) {
			const parent = this.replyTargets.get(target);
			if (!parent) return false;
			void this.saveReply(parent, target.value, this.timelineReplyTargets.has(target));
			return true;
		}
		return false;
	}

	goBack(): boolean {
		if (!this.activeThread) return false;
		void this.navigateBack();
		return true;
	}

	async refreshTimeline(): Promise<void> {
		if (!this.timelineEl) return;
		const epoch = ++this.renderEpoch;
		this.timelineEl.setAttribute('aria-busy', 'true');
		this.editing = undefined;
		this.replyTargets = new WeakMap<HTMLTextAreaElement, TimelinePost>();
		this.timelineReplyTargets = new WeakSet<HTMLTextAreaElement>();
		try {
			const posts = await this.service.getPosts();
			if (epoch !== this.renderEpoch) return;
			this.posts = posts;
			this.postIndex = new TimelineIndex(posts);
			this.composer?.updateStats(this.posts);
			if (this.activeThread) {
				const current = this.findCurrentPost(this.activeThread);
				if (current) {
					this.activeThread = current;
					await this.renderThreadPage(current, epoch);
					return;
				}
				this.activeThread = undefined;
				this.navigationHistory.length = 0;
				this.focusedPostKey = undefined;
				this.focusTimelineOnRender = true;
			}
			await this.renderTimeline(epoch);
		} finally {
			if (epoch === this.renderEpoch) this.timelineEl.setAttribute('aria-busy', 'false');
		}
	}

	private async renderTimeline(
		epoch = ++this.renderEpoch,
		resetVisiblePosts = false,
	): Promise<void> {
		if (!this.timelineEl) return;
		this.timelineEl.setAttribute('aria-busy', 'true');
		this.composer?.element.show();
		this.closeInlineReply(false);
		this.timelineEl.removeClass('is-thread-page');
		this.timelineEl.setAttribute('role', 'feed');
		this.timelineEl.setAttribute('aria-label', 'Soliloquy timeline');
		this.editing = undefined;
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
			this.focusTimelineOnRender = false;
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
		} finally {
			if (epoch === this.renderEpoch) {
				this.focusTimelineOnRender = false;
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
		const input = this.composer?.postInput;
		if (!input || !input.value.trim()) return;
		try {
			await this.service.addPost(input.value);
			this.composer?.clearPost();
			await this.refreshTimeline();
			input.focus();
		} catch (error) {
			console.error('Soliloquy: failed to save post', error);
			new Notice('Could not save the post.');
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
			this.closeInlineReply();
			return;
		}

		this.closeInlineReply(false);
		const composer = card.createDiv({
			cls: 'soliloquy-inline-reply-composer',
			attr: { role: 'group', 'aria-label': `Reply to post from ${post.date} at ${post.time}` },
		});
		composer.addEventListener('click', (event) => event.stopPropagation());
		this.inlineReplyComposerEl = composer;
		this.inlineReplyButtonEl = button;
		this.inlineReplyPostKey = postKey;
		button.setAttribute('aria-expanded', 'true');
		const textarea = composer.createEl('textarea', {
			cls: 'soliloquy-reply-input',
			attr: {
				rows: '1',
				placeholder: 'Ctrl + Enter to reply',
				'aria-label': 'Write a reply',
				'aria-keyshortcuts': 'Control+Enter',
			},
		});
		this.replyTargets.set(textarea, post);
		if (stayOnTimeline) this.timelineReplyTargets.add(textarea);
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
		textarea.addEventListener('input', () => {
			resizeTextarea(textarea);
			submit.disabled = !textarea.value.trim();
		});
		textarea.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			this.closeInlineReply();
		});
		cancel.addEventListener('click', (event) => {
			event.stopPropagation();
			this.closeInlineReply();
		});
		submit.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.saveReply(post, textarea.value, stayOnTimeline);
		});
		textarea.addEventListener('click', (event) => event.stopPropagation());
		textarea.focus();
	}

	private closeInlineReply(restoreFocus = true): void {
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
		await this.renderThreadPage(post, epoch);
	}

	private async renderThreadPage(post: TimelinePost, epoch: number): Promise<void> {
		if (!this.timelineEl) return;
		this.closeInlineReply(false);
		this.composer?.element.hide();
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
	}

	private async navigateBack(): Promise<void> {
		const epoch = ++this.renderEpoch;
		let previous = this.navigationHistory.pop();
		while (previous?.type === 'thread') {
			const post = this.findCurrentPost(previous.post);
			if (post) {
				this.activeThread = post;
				this.focusedPostKey = this.postKey(post);
				await this.renderThreadPage(post, epoch);
				return;
			}
			previous = this.navigationHistory.pop();
		}

		this.activeThread = undefined;
		this.focusedPostKey = previous?.focusedPostKey;
		this.focusTimelineOnRender = true;
		await this.renderTimeline(epoch);
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
		if (!content.trim()) return;
		try {
			await this.service.addReply(parent, content);
			if (stayOnTimeline) {
				this.activeThread = undefined;
				this.navigationHistory.length = 0;
			} else {
				this.activeThread = this.activeThread ?? this.findThreadRoot(parent);
			}
			await this.refreshTimeline();
		} catch (error) {
			console.error('Soliloquy: failed to save reply', error);
			new Notice('Could not save the reply.');
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

	private focusPost(card: HTMLElement, post: TimelinePost, scroll = false): void {
		this.focusedPostKey = this.postKey(post);
		this.timelineEl
			?.querySelectorAll('.soliloquy-post.is-focused')
			.forEach((element) => element.removeClass('is-focused'));
		card.addClass('is-focused');
		if (this.activeThread || this.focusTimelineOnRender || card.ownerDocument.activeElement === card) {
			this.focusCard(card, scroll, 'center');
		}
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

	private postKey(post: TimelinePost): string {
		return post.blockId ?? `${post.file.path}:${post.lineStart}:${post.time}`;
	}

	private openEditor(card: HTMLElement, post: TimelinePost): void {
		this.focusedPostKey = this.postKey(post);
		card.empty();
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', `Edit post from ${post.date} at ${post.time}`);
		card.removeAttribute('aria-keyshortcuts');
		const textarea = card.createEl('textarea', {
			cls: 'soliloquy-edit-input',
			attr: {
				rows: '1',
				placeholder: 'Ctrl + Enter to save',
				'aria-label': 'Edit post',
				'aria-keyshortcuts': 'Control+Enter',
			},
		});
		textarea.value = post.content;
		resizeTextarea(textarea);
		this.editing = { post, textarea };
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

		textarea.addEventListener('input', () => {
			resizeTextarea(textarea);
			save.disabled = !textarea.value.trim();
		});
		textarea.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			void this.cancelEdit();
		});
		cancel.addEventListener('click', () => void this.cancelEdit());
		save.addEventListener('click', () => void this.saveEdit(post, textarea.value));
		textarea.focus();
	}

	private async cancelEdit(): Promise<void> {
		await this.refreshTimeline();
		this.focusedPostKey = undefined;
	}

	private async saveEdit(post: TimelinePost, content: string): Promise<void> {
		if (!content.trim()) {
			new Notice('A post cannot be empty.');
			return;
		}
		try {
			await this.service.updatePost(post, content);
			await this.refreshTimeline();
			this.focusedPostKey = undefined;
		} catch (error) {
			console.error('Soliloquy: failed to edit post', error);
			new Notice('Could not edit the post. Reload the timeline and try again.');
		}
	}

	private async saveTaskState(
		post: TimelinePost,
		taskIndex: number,
		checked: boolean,
	): Promise<void> {
		try {
			await this.service.updateTask(post, taskIndex, checked);
			await this.refreshTimeline();
		} catch (error) {
			console.error('Soliloquy: failed to update task', error);
			new Notice('Could not update the task. Reload the timeline and try again.');
			await this.refreshTimeline();
		}
	}
}

function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}
