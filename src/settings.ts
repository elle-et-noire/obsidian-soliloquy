import { App, PluginSettingTab, Setting } from 'obsidian';
import type SoliloquyPlugin from './main';

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
	constructor(app: App, private readonly plugin: SoliloquyPlugin) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();

		new Setting(this.containerEl)
			.setName('Daily note folder')
			.setDesc('Vault-relative folder containing daily notes.')
			.addText((text) =>
				text.setValue(this.plugin.settings.dailyNoteFolder).onChange(async (value) => {
					this.plugin.settings.dailyNoteFolder = value.trim().replace(/^\/+|\/+$/g, '');
					await this.plugin.saveSettings();
				}),
			);

		new Setting(this.containerEl)
			.setName('Daily note format')
			.setDesc('Moment-style path below the daily note folder.')
			.addText((text) =>
				text.setValue(this.plugin.settings.dailyNoteFormat).onChange(async (value) => {
					this.plugin.settings.dailyNoteFormat = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(this.containerEl)
			.setName('Timeline heading')
			.setDesc('Posts are stored below this level-two heading.')
			.addText((text) =>
				text.setValue(this.plugin.settings.sectionHeading).onChange(async (value) => {
					this.plugin.settings.sectionHeading = value.trim() || 'soliloquy';
					await this.plugin.saveSettings();
				}),
			);
	}
}
