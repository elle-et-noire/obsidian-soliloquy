import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import type { TimelinePost } from '../types';

export type PostContext = 'timeline' | 'root' | 'reply';

interface PostCardCallbacks {
	getReplies: (post: TimelinePost) => TimelinePost[];
	getPostKey: (post: TimelinePost) => string;
	isFocused: (post: TimelinePost) => boolean;
	onEdit: (card: HTMLElement, post: TimelinePost) => void;
	onFocus: (card: HTMLElement, post: TimelinePost, scroll: boolean) => void;
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
	onTaskChange: (post: TimelinePost, taskIndex: number, checked: boolean) => void;
}

export class PostCardRenderer {
	private readonly renderedComponents = new Set<Component>();

	constructor(
		private readonly app: App,
		private readonly owner: Component,
		private readonly callbacks: PostCardCallbacks,
	) {
		this.owner.register(() => this.renderedComponents.clear());
	}

	clear(): void {
		for (const component of this.renderedComponents) {
			this.owner.removeChild(component);
		}
		this.renderedComponents.clear();
	}

	async render(
		post: TimelinePost,
		container: HTMLElement,
		context: PostContext = 'timeline',
	): Promise<void> {
		const postKey = this.callbacks.getPostKey(post);
		const card = container.createDiv({
			cls: `soliloquy-post${context === 'root' ? ' soliloquy-thread-root' : ''}`,
			attr: {
				role: 'article',
				tabindex: '0',
				'aria-label': `Post from ${post.date} at ${post.time}. Press Enter to open thread.`,
				'aria-keyshortcuts': 'Enter',
			},
		});
		card.dataset.postKey = postKey;
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
		this.renderedComponents.add(renderOwner);
		try {
			await MarkdownRenderer.render(this.app, post.content, content, post.file.path, renderOwner);
		} catch (error) {
			this.owner.removeChild(renderOwner);
			this.renderedComponents.delete(renderOwner);
			throw error;
		}
		const checkboxes = Array.from(
			content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
		);
		for (const [index, checkbox] of checkboxes.entries()) {
			checkbox.setAttribute('aria-label', `Task ${index + 1} in post from ${post.date} at ${post.time}`);
		}
		content.addEventListener('change', (event) => {
			const target = event.target;
			if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
			const taskIndex = checkboxes.indexOf(target);
			if (taskIndex < 0) return;
			this.callbacks.onTaskChange(post, taskIndex, target.checked);
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
			if (!this.callbacks.isFocused(post)) this.callbacks.onOpenThread(post);
		});
		card.addEventListener('keydown', (event) => {
			if (event.target !== card || event.key !== 'Enter') return;
			event.preventDefault();
			if (!this.callbacks.isFocused(post)) this.callbacks.onOpenThread(post);
		});
		if (this.callbacks.isFocused(post)) {
			this.callbacks.onFocus(card, post, context !== 'timeline');
		}
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
