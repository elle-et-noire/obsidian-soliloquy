import { Notice, Plugin, TFile } from 'obsidian';
import { SettingsCoordinator } from './services/settings-coordinator';
import { TimelineService } from './services/timeline-service';
import {
	DEFAULT_SETTINGS,
	SoliloquySettingTab,
	SoliloquySettings,
} from './settings';
import { runDetached } from './ui/report-failure';
import { SOLILOQUY_VIEW_TYPE, SoliloquyView, type SoliloquyFocusTarget } from './ui/soliloquy-view';
import { SoliloquyModal } from './ui/soliloquy-modal';

export default class SoliloquyPlugin extends Plugin {
	settings!: SoliloquySettings;
	service!: TimelineService;
	private settingsCoordinator!: SettingsCoordinator<SoliloquySettings>;
	private modal?: SoliloquyModal;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.service = new TimelineService(this.app, () => this.settings);
		// Unreadable notes are skipped; each is reported once, not on every refresh.
		this.register(this.service.onReadFailure((paths) => {
			new Notice(paths.length === 1
				? `Could not read ${paths[0]}. Its posts are not shown.`
				: `Could not read ${paths.length} daily notes. Their posts are not shown.`);
		}));
		this.register(this.service.onTemplateFailure((templatePath) => {
			new Notice(`Could not use the daily note template ${templatePath}. Today's note was created without it.`);
		}));
		this.settingsCoordinator = new SettingsCoordinator(
			500,
			(snapshot) => this.saveData(snapshot),
			(snapshot) => {
				if (!settingsEqual(this.settings, snapshot)) {
					this.settings = { ...snapshot };
					// Open displays refresh through the service's change notification.
					this.service.invalidateAll();
				}
				return Promise.resolve();
			},
			(error) => this.reportSettingsError(error),
		);

		this.registerView(
			SOLILOQUY_VIEW_TYPE,
			(leaf) => new SoliloquyView(leaf, this.service),
		);

		this.addRibbonIcon('messages-square', 'Open soliloquy', () => this.openView());
		this.addCommand({
			id: 'open-timeline',
			name: 'Open timeline',
			callback: () => this.openView(),
		});
		this.addCommand({
			id: 'open-timeline-modal',
			name: 'Open timeline in modal',
			callback: () => this.openModal(),
		});
		this.addCommand({
			id: 'focus-view',
			name: 'Focus view',
			callback: () => this.openView('view'),
		});
		this.addCommand({
			id: 'focus-search',
			name: 'Focus search',
			callback: () => this.openView('search'),
		});
		this.addCommand({
			id: 'focus-post',
			name: 'Focus post composer',
			callback: () => this.openView('post'),
		});
		this.addSettingTab(new SoliloquySettingTab(this.app, this));

		// The service checks changed daily notes and notifies open displays.
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile) this.service.fileChanged(file);
		}));
		// Vault emits 'create' for every existing file while loading; listen after that.
		this.app.workspace.onLayoutReady(() => {
			// Core plugin settings are final once the layout is ready.
			this.service.refreshDailyNoteSettings();
			this.registerEvent(this.app.vault.on('create', (file) => {
				if (file instanceof TFile) this.service.fileChanged(file);
			}));
		});
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile) this.service.fileRemoved(file.path);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			this.service.fileRemoved(oldPath);
			this.service.fileChanged(file);
		}));
		this.register(() => {
			this.modal?.close();
			this.service.dispose();
			runDetached(() => this.flushSettings(), 'save settings');
		});
	}

	async loadSettings(): Promise<void> {
		const settings: SoliloquySettings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SoliloquySettings>,
		);
		settings.useCoreDailyNotes = settings.useCoreDailyNotes === true;
		this.settings = settings;
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

	private openView(target: SoliloquyFocusTarget = 'view'): void {
		runDetached(() => this.activateView(target), 'open the timeline', 'Could not open the timeline.');
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
}

function settingsEqual(a: SoliloquySettings, b: SoliloquySettings): boolean {
	return a.useCoreDailyNotes === b.useCoreDailyNotes
		&& a.dailyNoteFolder === b.dailyNoteFolder
		&& a.dailyNoteFormat === b.dailyNoteFormat
		&& a.sectionHeading === b.sectionHeading;
}
