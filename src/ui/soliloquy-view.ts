import {
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	moment,
	Notice,
	setIcon,
	WorkspaceLeaf,
} from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import type { TimelinePost } from '../types';

export const SOLILOQUY_VIEW_TYPE = 'soliloquy-timeline';

export class SoliloquyView extends ItemView {
	private timelineEl?: HTMLElement;
	private composerEl?: HTMLElement;
	private textareaEl?: HTMLTextAreaElement;
	private searchEl?: HTMLTextAreaElement;
	private searchButtonEl?: HTMLButtonElement;
	private postButtonEl?: HTMLButtonElement;
	private statsEl?: HTMLElement;
	private searchMode = false;
	private posts: TimelinePost[] = [];
	private editing?: { post: TimelinePost; textarea: HTMLTextAreaElement };
	private replyTargets = new WeakMap<HTMLTextAreaElement, TimelinePost>();
	private timelineReplyTargets = new WeakSet<HTMLTextAreaElement>();
	private activeThread?: TimelinePost;
	private inlineReplyComposerEl?: HTMLElement;
	private inlineReplyPostKey?: string;
	private focusedPostKey?: string;
	private timelineScrollTop?: number;
	private renderEpoch = 0;

	constructor(leaf: WorkspaceLeaf, private readonly service: TimelineService) {
		super(leaf);
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

		const composer = root.createDiv({ cls: 'soliloquy-composer' });
		this.composerEl = composer;
		this.textareaEl = composer.createEl('textarea', {
			cls: 'soliloquy-input',
			attr: { placeholder: 'Ctrl + Enter to post', rows: '1' },
		});
		this.searchEl = composer.createEl('textarea', {
			cls: 'soliloquy-search',
			attr: {
				rows: '1',
				placeholder: 'Search posts',
				'aria-label': 'Search posts',
			},
		});
		this.searchEl.hide();
		const actions = composer.createDiv({ cls: 'soliloquy-composer-actions' });
		this.statsEl = actions.createSpan({ cls: 'soliloquy-stats' });
		const buttons = actions.createDiv({ cls: 'soliloquy-composer-buttons' });
		const searchToggle = buttons.createEl('button', {
			cls: 'soliloquy-search-toggle',
			attr: { 'aria-label': 'Search', 'aria-pressed': 'false' },
		});
		this.searchButtonEl = searchToggle;
		setIcon(searchToggle, 'search');
		const postButton = buttons.createEl('button', {
			cls: 'mod-cta soliloquy-post-button',
			attr: { 'aria-label': 'Post' },
		});
		this.postButtonEl = postButton;
		setIcon(postButton, 'send');

		this.registerDomEvent(this.textareaEl, 'input', () => this.resizeTextarea(this.textareaEl!));
		postButton.addEventListener('click', () => {
			if (this.searchMode) {
				this.setSearchMode(false);
			} else {
				void this.submit();
			}
		});
		searchToggle.addEventListener('click', () => {
			this.setSearchMode(true);
		});
		this.registerDomEvent(this.searchEl, 'input', () => {
			this.resizeTextarea(this.searchEl!);
			void this.renderTimeline();
		});
		this.timelineEl = root.createDiv({ cls: 'soliloquy-timeline' });
		await this.refreshTimeline();
	}

	submitFromShortcut(target: EventTarget | null): boolean {
		if (this.textareaEl && target === this.textareaEl) {
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
		this.editing = undefined;
		this.replyTargets = new WeakMap<HTMLTextAreaElement, TimelinePost>();
		this.timelineReplyTargets = new WeakSet<HTMLTextAreaElement>();
		const posts = await this.service.getPosts();
		if (epoch !== this.renderEpoch) return;
		this.posts = posts;
		this.updateStats();
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
	}

	private async renderTimeline(epoch = ++this.renderEpoch): Promise<void> {
		if (!this.timelineEl) return;
		this.composerEl?.show();
		this.inlineReplyComposerEl = undefined;
		this.inlineReplyPostKey = undefined;
		this.timelineEl.removeClass('is-thread-page');
		this.editing = undefined;
		const query = this.searchEl?.value.trim().toLocaleLowerCase() ?? '';
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
		this.updateStats(posts.length);
		this.timelineEl.empty();
		if (posts.length === 0) {
			this.timelineEl.createDiv({
				text: terms.length > 0 ? 'No matching posts.' : 'No posts yet.',
				cls: 'soliloquy-empty',
			});
			return;
		}
		await Promise.all(posts.map((post) => this.renderPost(post, this.timelineEl!)));
		if (epoch !== this.renderEpoch) return;
	}

	private async submit(): Promise<void> {
		const input = this.textareaEl;
		if (!input || !input.value.trim()) return;
		try {
			await this.service.addPost(input.value);
			input.value = '';
			this.resizeTextarea(input);
			await this.refreshTimeline();
			input.focus();
		} catch (error) {
			console.error('Soliloquy: failed to save post', error);
			new Notice('Could not save the post.');
		}
	}

	private setSearchMode(enabled: boolean): void {
		this.searchMode = enabled;
		this.searchButtonEl?.toggleClass('is-active', enabled);
		this.searchButtonEl?.setAttribute('aria-pressed', String(enabled));
		this.postButtonEl?.toggleClass('is-muted', enabled);
		this.textareaEl?.toggle(!enabled);
		this.searchEl?.toggle(enabled);
		if (enabled) {
			if (this.searchEl) this.resizeTextarea(this.searchEl);
			void this.renderTimeline();
			this.searchEl?.focus();
			return;
		}
		if (this.searchEl) {
			this.searchEl.value = '';
			this.resizeTextarea(this.searchEl);
		}
		void this.renderTimeline();
		this.textareaEl?.focus();
	}

	private async searchForTag(tag: string): Promise<void> {
		this.activeThread = undefined;
		this.focusedPostKey = undefined;
		this.setSearchMode(true);
		if (!this.searchEl) return;
		this.searchEl.value = tag;
		this.resizeTextarea(this.searchEl);
		await this.renderTimeline();
		this.searchEl.focus();
	}

	private resizeTextarea(textarea: HTMLTextAreaElement): void {
		textarea.setCssProps({ '--soliloquy-textarea-height': 'auto' });
		const overflowing = textarea.scrollHeight > 240;
		textarea.setCssProps({
			'--soliloquy-textarea-height': `${Math.min(textarea.scrollHeight, 240)}px`,
		});
		textarea.toggleClass('is-overflowing', overflowing);
	}

	private updateStats(hitCount?: number): void {
		if (!this.statsEl) return;
		this.statsEl.empty();
		if (this.searchMode) {
			const matches = hitCount ?? this.posts.length;
			const resultStat = this.statsEl.createSpan({
				cls: 'soliloquy-stat',
				attr: { 'aria-label': `Matches: ${matches}` },
			});
			setIcon(resultStat, 'search');
			resultStat.createSpan({ text: String(matches) });
			return;
		}
		const today = moment().format('YYYY-MM-DD');
		const todayCount = this.posts.filter((post) => post.date === today).length;
		const todayStat = this.statsEl.createSpan({
			cls: 'soliloquy-stat',
			attr: { 'aria-label': `Today: ${todayCount}` },
		});
		setIcon(todayStat, 'calendar-days');
		todayStat.createSpan({ text: String(todayCount) });
		const totalStat = this.statsEl.createSpan({
			cls: 'soliloquy-stat',
			attr: { 'aria-label': `Total: ${this.posts.length}` },
		});
		setIcon(totalStat, 'messages-square');
		totalStat.createSpan({ text: String(this.posts.length) });
	}

	private async renderPost(
		post: TimelinePost,
		container: HTMLElement,
		context: 'timeline' | 'root' | 'reply' = 'timeline',
	): Promise<void> {
		const card = container.createDiv({
			cls: `soliloquy-post${context === 'root' ? ' soliloquy-thread-root' : ''}`,
		});
		card.tabIndex = -1;
		let dragStart: { x: number; y: number } | undefined;
		let dragged = false;
		card.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) return;
			dragStart = { x: event.clientX, y: event.clientY };
			dragged = false;
		});
		card.addEventListener('pointermove', (event) => {
			if (!dragStart || (event.buttons & 1) === 0) return;
			const distance = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
			if (distance > 4) dragged = true;
		});
		const replies = post.blockId
			? this.posts.filter((candidate) => candidate.replyToBlockId === post.blockId)
			: [];
		const content = card.createDiv({ cls: 'soliloquy-post-content markdown-rendered' });
		await MarkdownRenderer.render(this.app, post.content, content, post.file.path, this);
		content.addEventListener('change', (event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
			const checkboxes = Array.from(content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
			const taskIndex = checkboxes.indexOf(target);
			if (taskIndex < 0) return;
			void this.saveTaskState(post, taskIndex, target.checked);
		});
		const meta = card.createDiv({ cls: 'soliloquy-post-meta' });
		const dateButton = meta.createEl('button', {
			cls: 'soliloquy-date-button',
			text: post.date,
			attr: { 'aria-label': `Open daily note for ${post.date}` },
		});
		const timeButton = meta.createEl('button', {
			cls: 'soliloquy-time-button',
			text: post.time,
			attr: { 'aria-label': `Open post from ${post.time} in the daily note` },
		});
		const replyButton = meta.createEl('button', {
			cls: 'soliloquy-reply-button',
			attr: {
				'aria-label': `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`,
			},
		});
		setIcon(replyButton, 'message-circle');
		replyButton.createSpan({ text: String(replies.length), cls: 'soliloquy-reply-count' });
		const editButton = meta.createEl('button', {
			cls: 'soliloquy-edit-button',
			attr: { 'aria-label': 'Edit' },
		});
		setIcon(editButton, 'pencil');
		dateButton.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.app.workspace.getLeaf('tab').openFile(post.file, { active: true });
		});
		timeButton.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.openDailyNoteAtPost(post);
		});
		editButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.openEditor(card, post);
		});
		replyButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.openInlineReply(card, post, context === 'timeline');
		});
		content.addEventListener('click', (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const tagLink = target.closest('a.tag');
			if (tagLink) {
				const tag = tagLink.textContent?.trim();
				if (!tag) return;
				event.preventDefault();
				event.stopPropagation();
				void this.searchForTag(tag.startsWith('#') ? tag : `#${tag}`);
				return;
			}
			const internalLink = target.closest('a.internal-link');
			if (!internalLink) return;
			const destination = internalLink.getAttribute('data-href')
				?? internalLink.getAttribute('href');
			if (!destination) return;
			event.preventDefault();
			event.stopPropagation();
			void this.app.workspace.openLinkText(destination, post.file.path, true);
		});
		card.addEventListener('click', (event) => {
			const target = event.target;
			if (target instanceof Element && target.closest('a, button, input, textarea')) return;
			if (dragged) {
				dragged = false;
				return;
			}
			if (this.focusedPostKey !== this.postKey(post)) void this.openThread(post);
		});
		if (context !== 'timeline' && this.focusedPostKey === this.postKey(post)) {
			this.focusPost(card, post, true);
		}
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
		post: TimelinePost,
		stayOnTimeline: boolean,
	): void {
		const postKey = this.postKey(post);
		if (this.inlineReplyPostKey === postKey) {
			this.closeInlineReply();
			return;
		}

		this.closeInlineReply();
		const composer = card.createDiv({ cls: 'soliloquy-inline-reply-composer' });
		composer.addEventListener('click', (event) => event.stopPropagation());
		this.inlineReplyComposerEl = composer;
		this.inlineReplyPostKey = postKey;
		const textarea = composer.createEl('textarea', {
			cls: 'soliloquy-reply-input',
			attr: { rows: '1', placeholder: 'Ctrl + Enter to reply' },
		});
		this.replyTargets.set(textarea, post);
		if (stayOnTimeline) this.timelineReplyTargets.add(textarea);
		this.registerDomEvent(textarea, 'input', () => this.resizeTextarea(textarea));
		const actions = composer.createDiv({ cls: 'soliloquy-inline-reply-actions' });
		const cancel = actions.createEl('button', {
			attr: { 'aria-label': 'Cancel' },
		});
		setIcon(cancel, 'x');
		const submit = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { 'aria-label': 'Reply' },
		});
		setIcon(submit, 'send');
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

	private closeInlineReply(): void {
		this.inlineReplyComposerEl?.remove();
		this.inlineReplyComposerEl = undefined;
		this.inlineReplyPostKey = undefined;
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
		this.inlineReplyComposerEl = undefined;
		this.inlineReplyPostKey = undefined;
		this.composerEl?.hide();
		this.timelineEl.empty();
		this.timelineEl.addClass('is-thread-page');
		const navigation = this.timelineEl.createDiv({ cls: 'soliloquy-thread-navigation' });
		const back = navigation.createEl('button', {
			cls: 'soliloquy-back-button',
			attr: {
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
		this.focusedPostKey = undefined;
		this.timelineEl?.removeClass('is-thread-page');
		await this.renderTimeline();
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
			window.requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }));
		}
	}

	private postKey(post: TimelinePost): string {
		return post.blockId ?? `${post.file.path}:${post.lineStart}:${post.time}`;
	}

	private openEditor(card: HTMLElement, post: TimelinePost): void {
		card.empty();
		const textarea = card.createEl('textarea', {
			cls: 'soliloquy-edit-input',
			attr: { rows: '1', placeholder: 'Ctrl + Enter to save' },
		});
		textarea.value = post.content;
		this.registerDomEvent(textarea, 'input', () => this.resizeTextarea(textarea));
		this.resizeTextarea(textarea);
		this.editing = { post, textarea };
		const actions = card.createDiv({ cls: 'soliloquy-edit-actions' });
		const cancel = actions.createEl('button', {
			attr: { 'aria-label': 'Cancel' },
		});
		setIcon(cancel, 'x');
		const save = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { 'aria-label': 'Save' },
		});
		setIcon(save, 'check');

		cancel.addEventListener('click', () => void this.refreshTimeline());
		save.addEventListener('click', () => void this.saveEdit(post, textarea.value));
		textarea.focus();
	}

	private async saveEdit(post: TimelinePost, content: string): Promise<void> {
		if (!content.trim()) {
			new Notice('A post cannot be empty.');
			return;
		}
		try {
			await this.service.updatePost(post, content);
			await this.refreshTimeline();
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
