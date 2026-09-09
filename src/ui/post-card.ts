import { App, Component, MarkdownRenderer, Notice, setIcon } from 'obsidian';
import type { TimelinePost } from '../types';
import { findMarkdownTasks, type MarkdownTask } from '../services/markdown-tasks';
import { applyPostUpdate } from '../services/post-snapshot';
import { taskCheckboxes, resolveTaskChange } from './task-checkboxes';

export type PostContext = 'timeline' | 'root' | 'reply';

interface PostCardCallbacks {
	getReplies: (post: TimelinePost) => TimelinePost[];
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
	onTaskChange: (post: TimelinePost, task: MarkdownTask, checked: boolean, saved: () => void) => Promise<void>;
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

	async render(
		post: TimelinePost,
		container: HTMLElement,
		context: PostContext = 'timeline',
		before?: HTMLElement,
	): Promise<void> {
		// A pending edit can mutate the shared post while this card stays visible.
		// Task offsets must always refer to the text that was actually rendered.
		const renderedPost = { ...post };
		const postKey = this.callbacks.getPostKey(post);
		const card = container.createDiv({
			cls: `soliloquy-post${context === 'root' ? ' soliloquy-thread-root' : ''}`,
			attr: {
				role: 'article',
				tabindex: '0',
				'aria-label': `Post from ${post.date} at ${post.time}.`,
				'aria-keyshortcuts': 'ArrowUp ArrowDown Enter',
			},
		});
		card.dataset.postKey = postKey;
		card.dataset.postContext = context;
		if (before) container.insertBefore(card, before);
		if (this.callbacks.isFocused(post)) card.addClass('is-focused');
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
		const renderOwner = this.owner.addChild(new Component());
		this.componentsByCard.set(card, renderOwner);
		try {
			await MarkdownRenderer.render(this.app, renderedPost.content, content, renderedPost.file.path, renderOwner);
		} catch (error) {
			this.releaseCard(card);
			throw error;
		}
		if (this.componentsByCard.get(card) !== renderOwner) return;
		const checkboxes = taskCheckboxes(content);
		const tasks = checkboxes.length ? findMarkdownTasks(renderedPost.content) : [];
		const taskByCheckbox = new Map<HTMLInputElement, MarkdownTask>();
		const checkedByCheckbox = new Map(checkboxes.map(checkbox => [checkbox, checkbox.checked]));
		for (const [index, checkbox] of checkboxes.entries()) {
			checkbox.setAttribute('aria-label', `Task ${index + 1} in post from ${post.date} at ${post.time}`);
			const task = tasks[index];
			// Treat parser positions as hints, including when a renderer extension
			// changes the number or order of the visible checkboxes.
			if (tasks.length === checkboxes.length && task
				&& checkbox.checked === (renderedPost.content[task.markerOffset] !== ' ')) taskByCheckbox.set(checkbox, task);
		}
		content.addEventListener('change', (event) => {
			const target = event.target as HTMLInputElement;
			if (!checkedByCheckbox.has(target) || target.disabled) return;
			const wasChecked = checkedByCheckbox.get(target)!;
			const checked = target.checked;
			if (checked === wasChecked) return;
			const beforeSave = { ...renderedPost };
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
				await this.callbacks.onTaskChange(renderedPost, task, checked, () => {
					// Editing/thread actions keep using the shared post. Do not overwrite
					// a newer edit that completed while the task save was pending.
					applyPostUpdate(post, beforeSave, renderedPost);
				});
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
			this.callbacks.onOpenDate(post);
		});
		timeButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onOpenPost(post);
		});
		editButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onEdit(card, post);
		});
		replyButton.addEventListener('click', (event) => {
			event.stopPropagation();
			this.callbacks.onReply(card, replyButton, post, context === 'timeline');
		});
		content.addEventListener('click', (event) => this.handleContentClick(event, post));
		card.addEventListener('click', (event) => {
			const target = event.target;
			if (target instanceof Element && target.closest('a, button, input, textarea')) return;
			if (dragged) {
				dragged = false;
				return;
			}
			if (context !== 'root') this.callbacks.onOpenThread(post);
		});
		card.addEventListener('focus', () => this.callbacks.onFocus(card, post));
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
				if (context !== 'root') this.callbacks.onOpenThread(post);
			}
		});
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
