import type { App } from 'obsidian';
import type { SoliloquySettings } from '../settings';
import { validateDailyNoteFormat } from './daily-note-path';

/** The format the core Daily notes plugin uses when its format is empty. */
export const CORE_DAILY_NOTES_DEFAULT_FORMAT = 'YYYY-MM-DD';

/** Settings of the core Daily notes plugin, as stored by Obsidian. */
export interface CoreDailyNotesOptions {
	readonly folder: string;
	readonly format: string;
	readonly template: string;
}

/** The daily note location and template that are in effect. */
export interface ResolvedDailyNotes {
	readonly dailyNoteFolder: string;
	readonly dailyNoteFormat: string;
	/** Vault path of the template for new notes; empty for an empty note. */
	readonly template: string;
	readonly source: 'core' | 'soliloquy';
	/** Why the core settings are not used although the option is on. */
	readonly fallback?: 'unavailable' | 'invalid-format';
}

type DailyNoteSettings = Pick<
	SoliloquySettings,
	'dailyNoteFolder' | 'dailyNoteFormat' | 'useCoreDailyNotes'
>;

/**
 * Reads the core Daily notes options. They are internal to Obsidian, so
 * every access is guarded; returns null when the plugin is missing, disabled,
 * or its options cannot be read.
 */
export function readCoreDailyNotesOptions(app: App): CoreDailyNotesOptions | null {
	try {
		const internalPlugins = property(app, 'internalPlugins');
		const getPluginById = property(internalPlugins, 'getPluginById');
		const plugin = typeof getPluginById === 'function'
			? (getPluginById as (id: string) => unknown).call(internalPlugins, 'daily-notes')
			: property(property(internalPlugins, 'plugins'), 'daily-notes');
		if (property(plugin, 'enabled') !== true) return null;
		const options = property(property(plugin, 'instance'), 'options');
		if (typeof options !== 'object' || options === null) return null;
		return {
			folder: stringProperty(options, 'folder'),
			format: stringProperty(options, 'format'),
			template: stringProperty(options, 'template'),
		};
	} catch (error) {
		console.error('Soliloquy: could not read the Daily notes settings', error);
		return null;
	}
}

/**
 * Chooses the daily note location: the core Daily notes settings when the
 * option is on and they are usable, otherwise Soliloquy's own settings with
 * no template.
 */
export function resolveDailyNotes(
	settings: DailyNoteSettings,
	core: CoreDailyNotesOptions | null,
): ResolvedDailyNotes {
	const own = {
		dailyNoteFolder: settings.dailyNoteFolder,
		dailyNoteFormat: settings.dailyNoteFormat,
		template: '',
		source: 'soliloquy',
	} as const;
	if (!settings.useCoreDailyNotes) return own;
	if (!core) return { ...own, fallback: 'unavailable' };

	const format = core.format.trim() || CORE_DAILY_NOTES_DEFAULT_FORMAT;
	if (validateDailyNoteFormat(format)) return { ...own, fallback: 'invalid-format' };
	return {
		dailyNoteFolder: trimSlashes(core.folder),
		dailyNoteFormat: format,
		template: trimSlashes(core.template),
		source: 'core',
	};
}

/**
 * Holds the resolved daily note settings so that path detection stays
 * consistent between explicit refreshes. Obsidian does not announce changes
 * to core plugin settings, so callers refresh at known points.
 */
export class DailyNoteSettingsResolver {
	private resolved: ResolvedDailyNotes;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => DailyNoteSettings,
	) {
		this.resolved = this.resolve();
	}

	get current(): ResolvedDailyNotes {
		return this.resolved;
	}

	/** Rereads the settings. Returns true when the daily note location changed. */
	refresh(): boolean {
		const previous = this.resolved;
		this.resolved = this.resolve();
		return previous.dailyNoteFolder !== this.resolved.dailyNoteFolder
			|| previous.dailyNoteFormat !== this.resolved.dailyNoteFormat;
	}

	private resolve(): ResolvedDailyNotes {
		const settings = this.getSettings();
		return resolveDailyNotes(
			settings,
			settings.useCoreDailyNotes ? readCoreDailyNotesOptions(this.app) : null,
		);
	}
}

function property(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function stringProperty(value: unknown, key: string): string {
	const result = property(value, key);
	return typeof result === 'string' ? result : '';
}

function trimSlashes(path: string): string {
	return path.trim().replace(/^\/+|\/+$/g, '');
}
