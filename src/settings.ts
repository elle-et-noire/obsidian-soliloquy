import { App, PluginSettingTab, Setting } from 'obsidian';
import type SoliloquyPlugin from './main';
import {
	dailyNoteFormatPreview,
	validateDailyNoteFormat,
} from './services/daily-note-path';

export interface SoliloquySettings {
	dailyNoteFolder: string;
	dailyNoteFormat: string;
	sectionHeading: string;
}

export const DEFAULT_SETTINGS: SoliloquySettings = {
	dailyNoteFolder: 'log',
	dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD',
	sectionHeading: 'soliloquy',
};

export class SoliloquySettingTab extends PluginSettingTab {
	private draft: SoliloquySettings;

	constructor(app: App, private readonly plugin: SoliloquyPlugin) {
		super(app, plugin);
		this.draft = { ...plugin.settings };
	}

	display(): void {
		this.containerEl.empty();
		this.draft = { ...this.plugin.settings };

		new Setting(this.containerEl)
			.setName('Daily note folder')
			.setDesc('Vault-relative folder containing daily notes.')
			.addText((text) =>
				text.setValue(this.draft.dailyNoteFolder).onChange((value) => {
					this.draft.dailyNoteFolder = value.trim().replace(/^\/+|\/+$/g, '');
					this.scheduleDraft();
				}),
			);

		const formatSetting = new Setting(this.containerEl)
			.setName('Daily note format')
			.setDesc('Moment-style path below the daily note folder.')
			.addText((text) =>
				text.setValue(this.draft.dailyNoteFormat).onChange((value) => {
					const format = value.trim();
					if (!this.updateFormatDescription(formatSetting, format)) return;
					this.draft.dailyNoteFormat = format;
					this.scheduleDraft();
				}),
			);
		this.updateFormatDescription(formatSetting, this.draft.dailyNoteFormat);

		new Setting(this.containerEl)
			.setName('Timeline heading')
			.setDesc('Posts are stored below this level-two heading.')
			.addText((text) =>
				text.setValue(this.draft.sectionHeading).onChange((value) => {
					this.draft.sectionHeading = value.trim() || 'soliloquy';
					this.scheduleDraft();
				}),
			);
	}

	hide(): void {
		void this.plugin.flushSettings();
		super.hide();
	}

	private scheduleDraft(): void {
		if (validateDailyNoteFormat(this.draft.dailyNoteFormat)) return;
		this.plugin.scheduleSettingsSave(this.draft);
	}

	private updateFormatDescription(setting: Setting, format: string): boolean {
		const error = validateDailyNoteFormat(format);
		if (error) {
			setting.setDesc(`Invalid format: ${error}`);
			return false;
		}

		const preview = dailyNoteFormatPreview(format);
		setting.setDesc(`Moment-style path below the daily note folder. Example: ${preview ?? ''}`);
		return true;
	}
}
