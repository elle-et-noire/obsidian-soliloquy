import { App, Component, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import type { TimelinePost } from '../types';
import { findMarkdownTasks, type MarkdownTask } from '../services/markdown-tasks';
import { taskCheckboxes, resolveTaskChange } from './task-checkboxes';

export type PostContext = 'timeline' | 'root' | 'reply';

interface PostCardCallbacks {
	getReplies: (post: TimelinePost) => readonly TimelinePost[];
	getPostKey: (post: TimelinePost) => string;
	isFocused: (post: TimelinePost) => boolean;
	onEdit: (card: HTMLElement, post: TimelinePost) => void;
	onFocus: (card: HTMLElement, post: TimelinePost) => void;
	onMoveFocus: (card: HTMLElement, direction: -1 | 1) => boolean;
	onOpenDate: (post: TimelinePost) => void;
	onOpenLink: (destination: string, post: TimelinePost) => void;
	onOpenPost: (post: TimelinePost) => void;
	onOpenThread: (post: TimelinePost) => void;
	onReply: (
		card: HTMLElement,
		button: HTMLButtonElement,
		post: TimelinePost,
		stayOnTimeline: boolean,
	) => void;
	onSearchTag: (tag: string) => void;
	/** Saves a task change; saved receives the updated post as soon as it is written. */
	onTaskChange: (
		post: TimelinePost,
		task: MarkdownTask,
		checked: boolean,
		saved: (post: TimelinePost) => void,
	) => Promise<void>;
}

export class PostCardRenderer {
	private readonly componentsByCard = new Map<HTMLElement, Component>();

	constructor(
		private readonly app: App,
		private readonly owner: Component,
		private readonly callbacks: PostCardCallbacks,
	) {
		this.owner.register(() => this.componentsByCard.clear());
	}

	clear(): void {
		for (const component of this.componentsByCard.values()) {
			this.owner.removeChild(component);
		}
		this.componentsByCard.clear();
	}

	releaseCard(card: HTMLElement): void {
		const component = this.componentsByCard.get(card);
		if (!component) return;
		this.owner.removeChild(component);
		this.componentsByCard.delete(card);
	}

	async restoreCard(card: HTMLElement, post: TimelinePost): Promise<void> {
		const parent = card.parentElement;
		if (!parent) return;
		const context = (card.dataset.postContext ?? 'timeline') as PostContext;
		this.releaseCard(card);
		// render inserts the replacement synchronously, before awaiting Markdown.
		const rendering = this.render(post, parent, context, card);
		card.remove();
		await rendering;
	}

	/**
	 * Renders a post card. When rendering fails, the card is replaced in place
	 * by an error card and the error is rethrown for the caller to report.
	 */
	async render(
		post: TimelinePost,
		container: HTMLElement,
		context: PostContext = 'timeline',
		before?: HTMLElement,
	): Promise<void> {
		const card = container.createDiv({
			cls: `soliloquy-post${context === 'root' ? ' soliloquy-thread-root' : ''}`,
			attr: {
				role: 'article',
				tabindex: '0',
				'aria-label': `Post from ${post.date} at ${post.time}.`,
				'aria-keyshortcuts': 'ArrowUp ArrowDown Enter',
			},
		});
		card.dataset.postKey = this.callbacks.getPostKey(post);
		card.dataset.postContext = context;
		if (before) container.insertBefore(card, before);
		if (this.callbacks.isFocused(post)) card.addClass('is-focused');
		const renderOwner = this.owner.addChild(new Component());
		this.componentsByCard.set(card, renderOwner);
		try {
			await this.populate(card, post, context, renderOwner);
		} catch (error) {
			// A released card belongs to a page that was already replaced.
			if (this.componentsByCard.get(card) !== renderOwner) return;
			this.releaseCard(card);
			card.replaceWith(this.createErrorCard(card, post));
			throw error;
		}
	}

	private async populate(
		card: HTMLElement,
		post: TimelinePost,
		context: PostContext,
		renderOwner: Component,
	): Promise<void> {
		// The post this card shows. Its own task saves replace it, so later
		// actions and task offsets use the saved text.
		let current = post;
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

		const replies = this.callbacks.getReplies(post);
		const content = card.createDiv({ cls: 'soliloquy-post-content markdown-rendered' });
		await MarkdownRenderer.render(this.app, post.content, content, post.file.path, renderOwner);
		if (this.componentsByCard.get(card) !== renderOwner) return;
		const checkboxes = taskCheckboxes(content);
		const tasks = checkboxes.length ? findMarkdownTasks(post.content) : [];
		const taskByCheckbox = new Map<HTMLInputElement, MarkdownTask>();
		const checkedByCheckbox = new Map(checkboxes.map(checkbox => [checkbox, checkbox.checked]));
		for (const [index, checkbox] of checkboxes.entries()) {
			checkbox.setAttribute('aria-label', `Task ${index + 1} in post from ${post.date} at ${post.time}`);
			const task = tasks[index];
			// The i-th source candidate is only a hint for the i-th checkbox; the
			// renderer verifies it, including when an extension changes the checkboxes.
			if (tasks.length === checkboxes.length && task
				&& checkbox.checked === (post.content[task.markerOffset] !== ' ')) taskByCheckbox.set(checkbox, task);
		}
		content.addEventListener('change', (event) => {
			const target = event.target as HTMLInputElement;
			if (!checkedByCheckbox.has(target) || target.disabled) return;
			const wasChecked = checkedByCheckbox.get(target)!;
			const checked = target.checked;
			if (checked === wasChecked) return;
			const beforeSave = current;
			// Serialize changes to this card's snapshot, including other tasks.
			for (const checkbox of checkboxes) checkbox.disabled = true;
			void (async () => {
				const task = await resolveTaskChange(this.app, renderOwner, beforeSave, taskByCheckbox.get(target), checkboxes, target, checked,
					() => this.componentsByCard.get(card) === renderOwner);
				if (this.componentsByCard.get(card) !== renderOwner) return;
				if (!task) {
					new Notice('Could not identify the task. Reload the timeline and try again.');
					target.checked = wasChecked;
					return;
				}
				await this.callbacks.onTaskChange(beforeSave, task, checked, (saved) => { current = saved; });
				taskByCheckbox.set(target, task);
				checkedByCheckbox.set(target, checked);
			})()
				.catch(() => { target.checked = wasChecked; })
				.finally(() => {
					for (const checkbox of checkboxes) checkbox.disabled = false;
				});
		});

		const meta = card.createDiv({ cls: 'soliloquy-post-meta' });
		const dateButton = meta.createEl('button', {
			cls: 'soliloquy-date-button',
			text: post.date,
			attr: { type: 'button', 'aria-label': `Open daily note for ${post.date}` },
		});
		const timeButton = meta.createEl('button', {
			cls: 'soliloquy-time-button',
			text: post.time,
			attr: {
				type: 'button',
				'aria-label': `Open post from ${post.time} in the daily note`,
			},
		});
		const replyButton = meta.createEl('button', {
			cls: 'soliloquy-reply-button',
			attr: {
				type: 'button',
				'aria-label': `Reply to post; ${replies.length} existing ${replies.length === 1 ? 'reply' : 'replies'}`,
				'aria-expanded': 'false',
			},
		});
		setIcon(replyButton, 'message-circle');
		replyButton.createSpan({ text: String(replies.length), cls: 'soliloquy-reply-count' });
		const editButton = meta.createEl('button', {
			cls: 'soliloquy-edit-button',
			attr: {
				type: 'button',
				'aria-label': `Edit post from ${post.date} at ${post.time}`,
			},
		});
		setIcon(editButton, 'pencil');

		dateButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onOpenDate(current);
		});
		timeButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onOpenPost(current);
		});
		editButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onEdit(card, current);
		});
		replyButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onReply(card, replyButton, current, context === 'timeline');
		});
		content.addEventListener('click', (event) => this.handleContentClick(event, current));
		card.addEventListener('click', (event) => {
			const target = event.target;
			if (target instanceof Element && target.closest('a, button, input, textarea')) return;
			if (dragged) {
				dragged = false;
				return;
			}
			if (context !== 'root') this.callbacks.onOpenThread(current);
		});
		card.addEventListener('focus', () => this.callbacks.onFocus(card, current));
		card.addEventListener('keydown', (event) => {
			if (event.target !== card) return;
			if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
				const direction = event.key === 'ArrowUp' ? -1 : 1;
				if (!this.callbacks.onMoveFocus(card, direction)) return;
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				if (context !== 'root') this.callbacks.onOpenThread(current);
			}
		});
	}

	/** A focusable stand-in for a card that failed to render, with a way to open its note. */
	private createErrorCard(failed: HTMLElement, post: TimelinePost): HTMLElement {
		const card = failed.ownerDocument.createElement('div');
		card.className = failed.className;
		card.addClass('is-render-error');
		card.setAttribute('role', 'article');
		card.setAttribute('tabindex', '0');
		card.setAttribute('aria-label', `Post from ${post.date} at ${post.time} could not be rendered.`);
		card.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Enter');
		card.dataset.postKey = failed.dataset.postKey;
		card.dataset.postContext = failed.dataset.postContext;
		card.createDiv({ cls: 'soliloquy-post-error-message', text: 'Could not render this post.' });
		const open = card.createEl('button', {
			cls: 'soliloquy-post-error-open',
			text: 'Open note',
			attr: { type: 'button', 'aria-label': `Open post from ${post.date} at ${post.time} in the daily note` },
		});
		open.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onOpenPost(post);
		});
		card.addEventListener('focus', () => this.callbacks.onFocus(card, post));
		card.addEventListener('keydown', (event) => {
			if (event.target !== card) return;
			if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
				if (!this.callbacks.onMoveFocus(card, event.key === 'ArrowUp' ? -1 : 1)) return;
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				this.callbacks.onOpenPost(post);
			}
		});
		return card;
	}

	private handleContentClick(event: MouseEvent, post: TimelinePost): void {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const tagLink = target.closest('a.tag');
		if (tagLink) {
			const tag = tagLink.textContent?.trim();
			if (!tag) return;
			event.preventDefault();
			event.stopPropagation();
			this.callbacks.onSearchTag(tag.startsWith('#') ? tag : `#${tag}`);
			return;
		}

		const internalLink = target.closest('a.internal-link');
		if (!internalLink) return;
		const destination = internalLink.getAttribute('data-href')
			?? internalLink.getAttribute('href');
		if (!destination) return;
		event.preventDefault();
		event.stopPropagation();
		this.callbacks.onOpenLink(destination, post);
	}
}
