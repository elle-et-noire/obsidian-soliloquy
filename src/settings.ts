import { App, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinition } from 'obsidian';
import type SoliloquyPlugin from './main';
import {
	dailyNoteFormatPreview,
	validateDailyNoteFormat,
} from './services/daily-note-path';
import {
	readCoreDailyNotesOptions,
	resolveDailyNotes,
} from './services/daily-note-settings';

export interface SoliloquySettings {
	/** Use the core Daily notes folder, format, and template when available. */
	useCoreDailyNotes: boolean;
	dailyNoteFolder: string;
	dailyNoteFormat: string;
	sectionHeading: string;
}

// Off by default: turning it on can move today's note and hide posts stored
// with Soliloquy's own folder and format.
export const DEFAULT_SETTINGS: SoliloquySettings = {
	useCoreDailyNotes: false,
	dailyNoteFolder: 'log',
	dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD',
	sectionHeading: 'soliloquy',
};

const CORE_TOGGLE_DESC = 'Use the folder, date format, and template of the core Daily notes plugin.';
const FOLDER_DESC = 'Vault-relative folder containing daily notes.';
const OVERRIDDEN_DESC = 'Not used while core daily notes settings are in effect.';

interface SoliloquySettingRow {
	name: string;
	desc: string;
	render: (setting: Setting) => void;
}

export class SoliloquySettingTab extends PluginSettingTab {
	private draft: SoliloquySettings;
	private coreToggleRow?: Setting;
	private folderRow?: Setting;
	private formatRow?: Setting;

	constructor(app: App, private readonly plugin: SoliloquyPlugin) {
		super(app, plugin);
		this.draft = { ...plugin.settings };
	}

	getSettingDefinitions(): SettingDefinition[] {
		this.plugin.service.refreshDailyNoteSettings();
		this.draft = { ...this.plugin.settings };
		return this.getSettingRows();
	}

	display(): void {
		this.containerEl.empty();
		this.plugin.service.refreshDailyNoteSettings();
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
				name: 'Use core daily notes settings',
				desc: CORE_TOGGLE_DESC,
				render: (setting) => this.addCoreDailyNotesControl(setting),
			},
			{
				name: 'Daily note folder',
				desc: FOLDER_DESC,
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

	private addCoreDailyNotesControl(setting: Setting): void {
		this.coreToggleRow = setting;
		setting.addToggle((toggle) =>
			toggle.setValue(this.draft.useCoreDailyNotes).onChange((value) => {
				this.draft.useCoreDailyNotes = value;
				this.scheduleDraft();
				this.updateDailyNoteRows();
			}),
		);
		this.updateDailyNoteRows();
	}

	/** Shows which settings are in effect and disables the overridden ones. */
	private updateDailyNoteRows(): void {
		const resolved = resolveDailyNotes(
			this.draft,
			this.draft.useCoreDailyNotes ? readCoreDailyNotesOptions(this.app) : null,
		);
		const usingCore = resolved.source === 'core';
		let status = '';
		if (usingCore) {
			const folder = resolved.dailyNoteFolder || 'the vault root';
			const template = resolved.template ? `, template ${resolved.template}` : '';
			status = ` Using ${resolved.dailyNoteFormat} in ${folder}${template}.`;
		} else if (resolved.fallback === 'unavailable') {
			status = ' Daily notes is off, so the settings below are used.';
		} else if (resolved.fallback === 'invalid-format') {
			status = ' The Daily notes date format is not supported, so the settings below are used.';
		}
		this.coreToggleRow?.setDesc(`${CORE_TOGGLE_DESC}${status}`);

		for (const row of [this.folderRow, this.formatRow]) {
			row?.setDisabled(usingCore);
			for (const component of row?.components ?? []) component.setDisabled(usingCore);
		}
		if (usingCore) {
			this.folderRow?.setDesc(OVERRIDDEN_DESC);
			this.formatRow?.setDesc(OVERRIDDEN_DESC);
		} else {
			this.folderRow?.setDesc(FOLDER_DESC);
			if (this.formatRow) this.updateFormatDescription(this.formatRow, this.draft.dailyNoteFormat);
		}
	}

	private addDailyNoteFolderControl(setting: Setting): void {
		this.folderRow = setting;
		setting.addText((text) =>
			text.setValue(this.draft.dailyNoteFolder).onChange((value) => {
				this.draft.dailyNoteFolder = value.trim().replace(/^\/+|\/+$/g, '');
				this.scheduleDraft();
			}),
		);
	}

	private addDailyNoteFormatControl(setting: Setting): void {
		this.formatRow = setting;
		setting.addText((text) =>
			text.setValue(this.draft.dailyNoteFormat).onChange((value) => {
				const format = value.trim();
				if (!this.updateFormatDescription(setting, format)) return;
				this.draft.dailyNoteFormat = format;
				this.scheduleDraft();
			}),
		);
		this.updateFormatDescription(setting, this.draft.dailyNoteFormat);
		this.updateDailyNoteRows();
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
