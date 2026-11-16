import { normalizePath, TFile } from 'obsidian';
import type { App, moment } from 'obsidian';

type Moment = ReturnType<typeof moment>;

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*(date|time|title)\s*(?::(.*?))?\}\}/gi;

/**
 * Expands the variables that the core Daily notes plugin supports in its
 * template: {{date}} uses the daily note format, {{time}} is HH:mm,
 * {{title}} is the note name, and {{date:FORMAT}} or {{time:FORMAT}} format
 * the note's date and time with a Moment format. Other text is unchanged.
 */
export function expandDailyNoteTemplate(
	template: string,
	date: Moment,
	format: string,
	title: string,
): string {
	return template.replace(
		TEMPLATE_VARIABLE_PATTERN,
		(match, name: string, customFormat: string | undefined) => {
			const variable = name.toLowerCase();
			const requested = customFormat?.trim();
			if (variable === 'title') return customFormat === undefined ? title : match;
			if (requested) return date.format(requested);
			return variable === 'date' ? date.format(format) : date.format('HH:mm');
		},
	);
}

/**
 * Finds a template the way the core Daily notes plugin stores it: a vault
 * path or link text, usually without the .md extension.
 */
export function findTemplateFile(app: App, templatePath: string): TFile | null {
	const path = normalizePath(templatePath);
	const linked = app.metadataCache?.getFirstLinkpathDest?.(path, '');
	if (linked instanceof TFile) return linked;
	for (const candidate of path.toLowerCase().endsWith('.md') ? [path] : [`${path}.md`, path]) {
		const file = app.vault.getAbstractFileByPath(candidate);
		if (file instanceof TFile) return file;
	}
	return null;
}
