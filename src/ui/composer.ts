import { type App, Component, moment, setIcon } from 'obsidian';
import type { TimelinePost } from '../types';
import { SoliloquyTextEditor } from './text-editor';

interface ComposerCallbacks {
	onPost: () => void;
	onSearchChange: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export class SoliloquyComposer {
	readonly element: HTMLElement;
	readonly input: SoliloquyTextEditor;
	private readonly statsEl: HTMLElement;
	private readonly searchButton: HTMLButtonElement;
	private readonly postButton: HTMLButtonElement;
	private searchMode = false;
	private posting = false;
	private searchChangeTimer?: number;

	constructor(
		app: App,
		root: HTMLElement,
		owner: Component,
		private readonly callbacks: ComposerCallbacks,
	) {
		this.element = root.createDiv({
			cls: 'soliloquy-composer',
			attr: { role: 'region', 'aria-label': 'Create or search posts' },
		});
		this.input = owner.addChild(new SoliloquyTextEditor(app, this.element, {
			cls: 'soliloquy-input',
			placeholder: 'Ctrl + Enter to post',
			label: 'Write a post',
		}));

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

		this.input.onChange = () => {
			this.postButton.disabled = this.posting || !this.input.value.trim();
			if (this.searchMode) this.scheduleSearchChange();
		};
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
		return this.searchMode ? this.input.value.trim().toLocaleLowerCase() : '';
	}

	clearPost(): void {
		this.input.value = '';
		this.postButton.disabled = true;
	}

	setPosting(posting: boolean): void {
		this.posting = posting;
		this.postButton.disabled = posting || !this.input.value.trim();
		this.postButton.setAttribute('aria-busy', String(posting));
	}

	searchFor(value: string): void {
		this.setSearchMode(true, false);
		this.input.value = value;
		this.notifySearchChange();
	}

	setSearchMode(enabled: boolean, notify = true): void {
		const changed = enabled !== this.searchMode;
		this.searchMode = enabled;
		this.searchButton.toggleClass('is-active', enabled);
		this.searchButton.setAttribute('aria-pressed', String(enabled));
		this.searchButton.setAttribute('aria-label', enabled ? 'Close search' : 'Search posts');
		setIcon(this.searchButton, enabled ? 'x' : 'search');
		// Keep the same editor and Vim state across both composer modes.
		this.input.element.toggleClass('soliloquy-input', !enabled);
		this.input.element.toggleClass('soliloquy-search', enabled);
		this.postButton.toggle(!enabled);
		this.postButton.disabled = this.posting || !this.input.value.trim();
		if (changed) this.input.setPresentation(
			enabled ? 'Search posts' : 'Write a post',
			enabled ? 'Search posts' : 'Ctrl + Enter to post',
		);

		this.input.focus();
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
