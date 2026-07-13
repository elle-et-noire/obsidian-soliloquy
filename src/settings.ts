import { App, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinition } from 'obsidian';
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

interface SoliloquySettingRow {
	name: string;
	desc: string;
	render: (setting: Setting) => void;
}

export class SoliloquySettingTab extends PluginSettingTab {
	private draft: SoliloquySettings;

	constructor(app: App, private readonly plugin: SoliloquyPlugin) {
		super(app, plugin);
		this.draft = { ...plugin.settings };
	}

	getSettingDefinitions(): SettingDefinition[] {
		this.draft = { ...this.plugin.settings };
		return this.getSettingRows();
	}

	display(): void {
		this.containerEl.empty();
		this.draft = { ...this.plugin.settings };

		for (const definition of this.getSettingRows()) {
			const setting = new Setting(this.containerEl)
				.setName(definition.name);
			if (definition.desc) setting.setDesc(definition.desc);
			definition.render(setting);
		}
	}

	hide(): void {
		void this.plugin.flushSettings();
		super.hide();
	}

	private scheduleDraft(): void {
		if (validateDailyNoteFormat(this.draft.dailyNoteFormat)) return;
		this.plugin.scheduleSettingsSave(this.draft);
	}

	private getSettingRows(): SoliloquySettingRow[] {
		return [
			{
				name: 'Daily note folder',
				desc: 'Vault-relative folder containing daily notes.',
				render: (setting) => this.addDailyNoteFolderControl(setting),
			},
			{
				name: 'Daily note format',
				desc: 'Moment-style path below the daily note folder.',
				render: (setting) => this.addDailyNoteFormatControl(setting),
			},
			{
				name: 'Timeline heading',
				desc: 'Posts are stored below this level-two heading.',
				render: (setting) => this.addTimelineHeadingControl(setting),
			},
		];
	}

	private addDailyNoteFolderControl(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(this.draft.dailyNoteFolder).onChange((value) => {
				this.draft.dailyNoteFolder = value.trim().replace(/^\/+|\/+$/g, '');
				this.scheduleDraft();
			}),
		);
	}

	private addDailyNoteFormatControl(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(this.draft.dailyNoteFormat).onChange((value) => {
				const format = value.trim();
				if (!this.updateFormatDescription(setting, format)) return;
				this.draft.dailyNoteFormat = format;
				this.scheduleDraft();
			}),
		);
		this.updateFormatDescription(setting, this.draft.dailyNoteFormat);
	}

	private addTimelineHeadingControl(setting: Setting): void {
		setting.addText((text) =>
			text.setValue(this.draft.sectionHeading).onChange((value) => {
				this.draft.sectionHeading = value.trim() || 'soliloquy';
				this.scheduleDraft();
			}),
		);
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
