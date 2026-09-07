import { Component, moment, setIcon } from 'obsidian';
import type { TimelinePost } from '../types';

interface ComposerCallbacks {
	onPost: () => void;
	onSearchChange: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export class SoliloquyComposer {
	readonly element: HTMLElement;
	readonly postInput: HTMLTextAreaElement;
	readonly searchInput: HTMLTextAreaElement;
	private readonly statsEl: HTMLElement;
	private readonly searchButton: HTMLButtonElement;
	private readonly postButton: HTMLButtonElement;
	private searchMode = false;
	private searchChangeTimer?: number;

	constructor(
		root: HTMLElement,
		owner: Component,
		private readonly callbacks: ComposerCallbacks,
	) {
		this.element = root.createDiv({
			cls: 'soliloquy-composer',
			attr: { role: 'region', 'aria-label': 'Create or search posts' },
		});
		this.postInput = this.element.createEl('textarea', {
			cls: 'soliloquy-input',
			attr: {
				placeholder: 'Ctrl + Enter to post',
				rows: '1',
				'aria-label': 'Write a post',
				'aria-keyshortcuts': 'Control+Enter',
			},
		});
		this.searchInput = this.element.createEl('textarea', {
			cls: 'soliloquy-search',
			attr: {
				rows: '1',
				placeholder: 'Search posts',
				'aria-label': 'Search posts',
			},
		});
		this.searchInput.hide();

		const actions = this.element.createDiv({ cls: 'soliloquy-composer-actions' });
		this.statsEl = actions.createSpan({
			cls: 'soliloquy-stats',
			attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
		});
		const buttons = actions.createDiv({ cls: 'soliloquy-composer-buttons' });
		this.searchButton = buttons.createEl('button', {
			cls: 'soliloquy-search-toggle',
			attr: {
				type: 'button',
				'aria-label': 'Search posts',
				'aria-pressed': 'false',
			},
		});
		setIcon(this.searchButton, 'search');
		this.postButton = buttons.createEl('button', {
			cls: 'mod-cta soliloquy-post-button',
			attr: { type: 'button', 'aria-label': 'Post' },
		});
		this.postButton.disabled = true;
		setIcon(this.postButton, 'send');

		owner.registerDomEvent(this.postInput, 'input', () => {
			resizeTextarea(this.postInput);
			this.postButton.disabled = !this.postInput.value.trim();
		});
		owner.registerDomEvent(this.searchInput, 'input', () => {
			resizeTextarea(this.searchInput);
			this.scheduleSearchChange();
		});
		owner.registerDomEvent(this.postButton, 'click', () => this.callbacks.onPost());
		owner.registerDomEvent(this.searchButton, 'click', () => {
			this.setSearchMode(!this.searchMode);
		});
		owner.register(() => this.cancelScheduledSearch());
	}

	isSearching(): boolean {
		return this.searchMode;
	}

	getSearchQuery(): string {
		return this.searchMode ? this.searchInput.value.trim().toLocaleLowerCase() : '';
	}

	clearPost(): void {
		this.postInput.value = '';
		this.postButton.disabled = true;
		resizeTextarea(this.postInput);
	}

	searchFor(value: string): void {
		this.setSearchMode(true, false);
		this.searchInput.value = value;
		resizeTextarea(this.searchInput);
		this.notifySearchChange();
	}

	setSearchMode(enabled: boolean, notify = true): void {
		const input = enabled ? this.searchInput : this.postInput;
		if (enabled !== this.searchMode) {
			const previousInput = this.searchMode ? this.searchInput : this.postInput;
			input.value = previousInput.value;
			input.setSelectionRange(
				previousInput.selectionStart,
				previousInput.selectionEnd,
				previousInput.selectionDirection,
			);
		}
		this.searchMode = enabled;
		this.searchButton.toggleClass('is-active', enabled);
		this.searchButton.setAttribute('aria-pressed', String(enabled));
		this.searchButton.setAttribute('aria-label', enabled ? 'Close search' : 'Search posts');
		setIcon(this.searchButton, enabled ? 'x' : 'search');
		this.postInput.toggle(!enabled);
		this.postButton.toggle(!enabled);
		this.postButton.disabled = !this.postInput.value.trim();
		this.searchInput.toggle(enabled);

		resizeTextarea(input);
		input.focus();
		if (notify) this.notifySearchChange();
	}

	private scheduleSearchChange(): void {
		this.cancelScheduledSearch();
		this.searchChangeTimer = window.setTimeout(() => {
			this.searchChangeTimer = undefined;
			this.callbacks.onSearchChange();
		}, SEARCH_DEBOUNCE_MS);
	}

	private notifySearchChange(): void {
		this.cancelScheduledSearch();
		this.callbacks.onSearchChange();
	}

	private cancelScheduledSearch(): void {
		if (this.searchChangeTimer === undefined) return;
		window.clearTimeout(this.searchChangeTimer);
		this.searchChangeTimer = undefined;
	}

	updateStats(posts: TimelinePost[], hitCount?: number): void {
		this.statsEl.empty();
		if (this.searchMode) {
			const matches = hitCount ?? posts.length;
			const resultStat = this.statsEl.createSpan({
				cls: 'soliloquy-stat',
				attr: { 'aria-label': `Matches: ${matches}` },
			});
			setIcon(resultStat, 'search');
			resultStat.createSpan({ text: String(matches) });
			return;
		}

		const today = moment().format('YYYY-MM-DD');
		const todayCount = posts.filter((post) => post.date === today).length;
		const todayStat = this.statsEl.createSpan({
			cls: 'soliloquy-stat',
			attr: { 'aria-label': `Today: ${todayCount}` },
		});
		setIcon(todayStat, 'calendar-days');
		todayStat.createSpan({ text: String(todayCount) });
		const totalStat = this.statsEl.createSpan({
			cls: 'soliloquy-stat',
			attr: { 'aria-label': `Total: ${posts.length}` },
		});
		setIcon(totalStat, 'messages-square');
		totalStat.createSpan({ text: String(posts.length) });
	}
}

export function resizeTextarea(textarea: HTMLTextAreaElement): void {
	textarea.setCssProps({ '--soliloquy-textarea-height': 'auto' });
	const overflowing = textarea.scrollHeight > 240;
	textarea.setCssProps({
		'--soliloquy-textarea-height': `${Math.min(textarea.scrollHeight, 240)}px`,
	});
	textarea.toggleClass('is-overflowing', overflowing);
}
