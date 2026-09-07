import { Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { parseDailyNoteDate } from './services/daily-note-path';
import { SettingsCoordinator } from './services/settings-coordinator';
import { TimelineService } from './services/timeline-service';
import {
	DEFAULT_SETTINGS,
	SoliloquySettingTab,
	SoliloquySettings,
} from './settings';
import { SOLILOQUY_VIEW_TYPE, SoliloquyView, type SoliloquyFocusTarget } from './ui/soliloquy-view';
import { SoliloquyModal } from './ui/soliloquy-modal';

export default class SoliloquyPlugin extends Plugin {
	settings!: SoliloquySettings;
	service!: TimelineService;
	private refreshTimer?: number;
	private settingsCoordinator!: SettingsCoordinator<SoliloquySettings>;
	private modal?: SoliloquyModal;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.service = new TimelineService(this.app, () => this.settings);
		this.settingsCoordinator = new SettingsCoordinator(
			500,
			(snapshot) => this.saveData(snapshot),
			async (snapshot) => {
				if (settingsEqual(this.settings, snapshot)) return;
				this.settings = { ...snapshot };
				this.service.invalidateAll();
				await this.refreshViews();
			},
			(error) => this.reportSettingsError(error),
		);

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
		this.addCommand({
			id: 'open-timeline-modal',
			name: 'Open timeline in modal',
			callback: () => this.openModal(),
		});
		this.addCommand({
			id: 'focus-view',
			name: 'Focus view',
			callback: () => void this.activateView('view'),
		});
		this.addCommand({
			id: 'focus-search',
			name: 'Focus search',
			callback: () => void this.activateView('search'),
		});
		this.addCommand({
			id: 'focus-post',
			name: 'Focus post composer',
			callback: () => void this.activateView('post'),
		});
		this.addSettingTab(new SoliloquySettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on('modify', (file) => this.scheduleRefreshIfDailyNote(file)),
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => this.scheduleRefreshIfDailyNote(file)),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => this.scheduleRefreshIfDailyNote(file)),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				const wasDailyNote = parseDailyNoteDate(oldPath, this.settings) !== null;
				this.service.invalidatePath(oldPath);
				if (file instanceof TFile) this.service.invalidateFile(file);
				if (wasDailyNote || (file instanceof TFile && this.service.isDailyNote(file))) {
					this.scheduleRefresh();
				}
			}),
		);
		this.register(() => {
			this.modal?.close();
			if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
			void this.flushSettings();
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SoliloquySettings>,
		);
	}

	scheduleSettingsSave(settings: SoliloquySettings): void {
		this.settingsCoordinator.schedule({ ...settings });
	}

	async flushSettings(): Promise<void> {
		try {
			await this.settingsCoordinator.flush();
		} catch (error) {
			this.reportSettingsError(error);
		}
	}

	private reportSettingsError(error: unknown): void {
		console.error('Soliloquy: failed to save settings', error);
		new Notice('Could not save soliloquy settings.');
	}

	private async activateView(target: SoliloquyFocusTarget = 'view'): Promise<void> {
		if (this.modal) {
			this.modal.focus(target);
			return;
		}
		const workspace = this.app.workspace;
		let leaf = workspace.getActiveViewOfType(SoliloquyView)?.leaf
			?? workspace.getLeavesOfType(SOLILOQUY_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab');
			await leaf.setViewState({ type: SOLILOQUY_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		workspace.setActiveLeaf(leaf, { focus: true });
		if (leaf.view instanceof SoliloquyView) leaf.view.focus(target);
	}

	private openModal(): void {
		if (this.modal) {
			this.modal.focus('post');
			return;
		}
		this.modal = new SoliloquyModal(this.app, this.service, () => {
			this.modal = undefined;
		});
		this.modal.open();
	}

	private scheduleRefreshIfDailyNote(file: unknown): void {
		if (file instanceof TFile && this.service.isDailyNote(file)) {
			this.service.invalidateFile(file);
			this.scheduleRefresh();
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshViews();
		}, 100);
	}

	private async refreshViews(): Promise<void> {
		await Promise.all([
			this.modal?.refreshTimeline(),
			...this.app.workspace
				.getLeavesOfType(SOLILOQUY_VIEW_TYPE)
				.map((leaf: WorkspaceLeaf) => {
					const view = leaf.view;
					return view instanceof SoliloquyView
						? view.refreshTimeline()
						: Promise.resolve();
				}),
		]);
	}
}

function settingsEqual(a: SoliloquySettings, b: SoliloquySettings): boolean {
	return a.dailyNoteFolder === b.dailyNoteFolder
		&& a.dailyNoteFormat === b.dailyNoteFormat
		&& a.sectionHeading === b.sectionHeading;
}
