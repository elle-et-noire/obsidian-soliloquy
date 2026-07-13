import {
	ItemView,
	MarkdownView,
	Notice,
	setIcon,
	WorkspaceLeaf,
} from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import type { TimelinePost } from '../types';
import { resizeTextarea, SoliloquyComposer } from './composer';
import { PostCardRenderer, type PostContext } from './post-card';

export const SOLILOQUY_VIEW_TYPE = 'soliloquy-timeline';

export class SoliloquyView extends ItemView {
	private timelineEl?: HTMLElement;
	private composer?: SoliloquyComposer;
	private readonly postRenderer: PostCardRenderer;
	private posts: TimelinePost[] = [];
	private editing?: { post: TimelinePost; textarea: HTMLTextAreaElement };
	private replyTargets = new WeakMap<HTMLTextAreaElement, TimelinePost>();
	private timelineReplyTargets = new WeakSet<HTMLTextAreaElement>();
	private activeThread?: TimelinePost;
	private inlineReplyComposerEl?: HTMLElement;
	private inlineReplyButtonEl?: HTMLButtonElement;
	private inlineReplyPostKey?: string;
	private focusedPostKey?: string;
	private timelineScrollTop?: number;
	private renderEpoch = 0;

	constructor(leaf: WorkspaceLeaf, private readonly service: TimelineService) {
		super(leaf);
		this.postRenderer = new PostCardRenderer(this.app, this, {
			getReplies: (post) => post.blockId
				? this.posts.filter((candidate) => candidate.replyToBlockId === post.blockId)
				: [],
			getPostKey: (post) => this.postKey(post),
			isFocused: (post) => this.focusedPostKey === this.postKey(post),
			onEdit: (card, post) => this.openEditor(card, post),
			onFocus: (card, post, scroll) => this.focusPost(card, post, scroll),
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
			onSearchChange: () => void this.renderTimeline(),
		});
		this.timelineEl = root.createDiv({
			cls: 'soliloquy-timeline',
			attr: {
				role: 'feed',
				'aria-label': 'Soliloquy timeline',
				'aria-busy': 'false',
			},
		});
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
		void this.closeThread();
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
			this.composer?.updateStats(this.posts);
			if (this.activeThread) {
				const current = this.findCurrentPost(this.activeThread);
				if (current) {
					this.activeThread = current;
					await this.renderThreadPage(current, epoch);
					return;
				}
				this.activeThread = undefined;
			}
			await this.renderTimeline(epoch);
		} finally {
			if (epoch === this.renderEpoch) this.timelineEl.setAttribute('aria-busy', 'false');
		}
	}

	private async renderTimeline(epoch = ++this.renderEpoch): Promise<void> {
		if (!this.timelineEl) return;
		this.composer?.element.show();
		this.closeInlineReply(false);
		this.timelineEl.removeClass('is-thread-page');
		this.timelineEl.setAttribute('role', 'feed');
		this.timelineEl.setAttribute('aria-label', 'Soliloquy timeline');
		this.editing = undefined;
		const query = this.composer?.getSearchQuery() ?? '';
		const terms = query.split(/\s+/).filter(Boolean);
		const posts = terms.length === 0
			? this.posts
			: this.posts.filter((post) => {
				const replies = post.blockId
					? this.posts.filter((candidate) => candidate.replyToBlockId === post.blockId)
					: [];
				const searchable = `${post.date} ${post.time} ${post.content} ${replies.map((reply) => reply.content).join(' ')}`.toLocaleLowerCase();
				return terms.every((term) => searchable.includes(term));
			});
		this.composer?.updateStats(this.posts, posts.length);
		this.timelineEl.empty();
		if (posts.length === 0) {
			this.timelineEl.createDiv({
				text: terms.length > 0 ? 'No matching posts.' : 'No posts yet.',
				cls: 'soliloquy-empty',
				attr: { role: 'status' },
			});
			return;
		}
		await Promise.all(posts.map((post) => this.renderPost(post, this.timelineEl!)));
		if (epoch !== this.renderEpoch) return;
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
		const epoch = ++this.renderEpoch;
		if (!this.activeThread) this.timelineScrollTop = this.contentEl.scrollTop;
		this.activeThread = post;
		this.focusedPostKey = this.postKey(post);
		await this.renderThreadPage(post, epoch);
	}

	private async renderThreadPage(post: TimelinePost, epoch: number): Promise<void> {
		if (!this.timelineEl) return;
		this.closeInlineReply(false);
		this.composer?.element.hide();
		this.timelineEl.empty();
		this.timelineEl.addClass('is-thread-page');
		this.timelineEl.setAttribute('role', 'region');
		this.timelineEl.setAttribute('aria-label', 'Soliloquy thread');
		const navigation = this.timelineEl.createDiv({ cls: 'soliloquy-thread-navigation' });
		const back = navigation.createEl('button', {
			cls: 'soliloquy-back-button',
			attr: {
				type: 'button',
				'aria-label': 'Back to timeline',
				'aria-keyshortcuts': 'Alt+ArrowLeft',
			},
		});
		setIcon(back, 'arrow-left');
		back.addEventListener('click', () => void this.closeThread());

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

	private async closeThread(): Promise<void> {
		const scrollTop = this.timelineScrollTop;
		this.timelineScrollTop = undefined;
		this.activeThread = undefined;
		this.timelineEl?.removeClass('is-thread-page');
		this.timelineEl?.setAttribute('role', 'feed');
		this.timelineEl?.setAttribute('aria-label', 'Soliloquy timeline');
		await this.renderTimeline();
		this.focusedPostKey = undefined;
		if (scrollTop !== undefined) {
			window.requestAnimationFrame(() => {
				this.contentEl.scrollTop = scrollTop;
			});
		}
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
		if (!parent.blockId) return [];
		return this.posts
			.filter((candidate) => candidate.replyToBlockId === parent.blockId)
			.sort((a, b) => {
				const chronological = `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);
				if (chronological !== 0) return chronological;
				return a.lineStart - b.lineStart;
			});
	}

	private findThreadRoot(post: TimelinePost): TimelinePost {
		let current = post;
		const visited = new Set<string>();
		while (current.replyToBlockId && !visited.has(this.postKey(current))) {
			visited.add(this.postKey(current));
			const parent = this.posts.find(
				(candidate) => candidate.blockId === current.replyToBlockId,
			);
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
			const parent = this.posts.find(
				(candidate) => candidate.blockId === current.replyToBlockId,
			);
			if (!parent || visited.has(this.postKey(parent))) break;
			ancestors.unshift(parent);
			visited.add(this.postKey(parent));
			current = parent;
		}
		return ancestors;
	}

	private findCurrentPost(post: TimelinePost): TimelinePost | undefined {
		if (post.blockId) return this.posts.find((candidate) => candidate.blockId === post.blockId);
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
		card.focus({ preventScroll: true });
		if (scroll) {
			const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
				? 'auto'
				: 'smooth';
			window.requestAnimationFrame(() => card.scrollIntoView({ behavior, block: 'center' }));
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
