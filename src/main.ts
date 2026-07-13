import { Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { TimelineService } from './services/timeline-service';
import {
	DEFAULT_SETTINGS,
	SoliloquySettingTab,
	SoliloquySettings,
} from './settings';
import { SOLILOQUY_VIEW_TYPE, SoliloquyView } from './ui/soliloquy-view';

export default class SoliloquyPlugin extends Plugin {
	settings!: SoliloquySettings;
	service!: TimelineService;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.service = new TimelineService(this.app, () => this.settings);

		this.registerView(
			SOLILOQUY_VIEW_TYPE,
			(leaf) => new SoliloquyView(leaf, this.service),
		);

		this.addRibbonIcon('messages-square', 'Open soliloquy', () => {
			void this.activateView();
		});
		this.addCommand({
			id: 'open-timeline',
			name: 'Open timeline',
			callback: () => void this.activateView(),
		});
		this.addSettingTab(new SoliloquySettingTab(this.app, this));
		this.registerDomEvent(
			activeWindow,
			'keydown',
			(event: KeyboardEvent) => this.handleGlobalKeydown(event),
			{ capture: true },
		);

		this.registerEvent(
			this.app.vault.on('modify', (file) => this.refreshIfDailyNote(file)),
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => this.refreshIfDailyNote(file)),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => this.refreshIfDailyNote(file)),
		);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SoliloquySettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		await this.refreshViews();
	}

	private async activateView(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(SOLILOQUY_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: SOLILOQUY_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private refreshIfDailyNote(file: unknown): void {
		if (file instanceof TFile && this.service.isDailyNote(file)) {
			void this.refreshViews();
		}
	}

	private handleGlobalKeydown(event: KeyboardEvent): void {
		const isBack = event.altKey
			&& !event.ctrlKey
			&& !event.metaKey
			&& !event.shiftKey
			&& (event.key === 'ArrowLeft' || event.code === 'ArrowLeft');
		if (isBack) {
			const view = this.app.workspace.getActiveViewOfType(SoliloquyView);
			if (!view?.goBack()) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}

		const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
		if (!event.ctrlKey || !isEnter) return;

		const handled = this.app.workspace
			.getLeavesOfType(SOLILOQUY_VIEW_TYPE)
			.some((leaf) => {
				const view = leaf.view;
				return view instanceof SoliloquyView && view.submitFromShortcut(event.target);
			});
		if (!handled) return;

		event.preventDefault();
		event.stopImmediatePropagation();
	}

	private async refreshViews(): Promise<void> {
		await Promise.all(
			this.app.workspace
				.getLeavesOfType(SOLILOQUY_VIEW_TYPE)
				.map((leaf: WorkspaceLeaf) => {
					const view = leaf.view;
					return view instanceof SoliloquyView
						? view.refreshTimeline()
						: Promise.resolve();
				}),
		);
	}
}
