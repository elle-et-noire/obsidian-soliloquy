import { moment, normalizePath } from 'obsidian';
import type { SoliloquySettings } from '../settings';

type DailyNotePathSettings = Pick<
	SoliloquySettings,
	'dailyNoteFolder' | 'dailyNoteFormat'
>;

const MARKDOWN_EXTENSION = '.md';
const INVALID_FILE_NAME_PATTERN = /[<>:"|?*]/;

export function buildDailyNotePath(
	settings: DailyNotePathSettings,
	date = moment(),
): string {
	const folder = normalizeFolder(settings.dailyNoteFolder);
	const relativePath = date.format(settings.dailyNoteFormat.trim());
	return normalizePath(folder
		? `${folder}/${relativePath}${MARKDOWN_EXTENSION}`
		: `${relativePath}${MARKDOWN_EXTENSION}`);
}

export function parseDailyNoteDate(
	path: string,
	settings: DailyNotePathSettings,
): string | null {
	if (!path.endsWith(MARKDOWN_EXTENSION)) return null;

	const folder = normalizeFolder(settings.dailyNoteFolder);
	const prefix = folder ? `${folder}/` : '';
	if (!path.startsWith(prefix)) return null;

	const relativePath = path.slice(prefix.length, -MARKDOWN_EXTENSION.length);
	const format = settings.dailyNoteFormat.trim();
	if (!format) return null;

	const parsed = moment(relativePath, format, true);
	if (!parsed.isValid() || parsed.format(format) !== relativePath) return null;
	return parsed.format('YYYY-MM-DD');
}

export function validateDailyNoteFormat(format: string): string | null {
	const normalizedFormat = format.trim();
	if (!normalizedFormat) return 'Enter a daily note format.';

	const samples = ['2001-02-03', '2001-02-04', '2002-02-03']
		.map((value) => moment(value, 'YYYY-MM-DD', true));
	const renderedPaths = new Set<string>();

	for (const sample of samples) {
		const renderedPath = sample.format(normalizedFormat);
		const pathError = validateRelativePath(renderedPath);
		if (pathError) return pathError;

		const parsed = moment(renderedPath, normalizedFormat, true);
		if (
			!parsed.isValid()
			|| parsed.format(normalizedFormat) !== renderedPath
			|| parsed.format('YYYY-MM-DD') !== sample.format('YYYY-MM-DD')
		) {
			return 'The format must contain enough information to identify each date.';
		}
		renderedPaths.add(renderedPath);
	}

	if (renderedPaths.size !== samples.length) {
		return 'The format must produce a different note for each day.';
	}
	return null;
}

export function dailyNoteFormatPreview(format: string): string | null {
	if (validateDailyNoteFormat(format)) return null;
	return `${moment().format(format.trim())}${MARKDOWN_EXTENSION}`;
}

function normalizeFolder(folder: string): string {
	const trimmed = folder.trim();
	return trimmed ? normalizePath(trimmed) : '';
}

function validateRelativePath(path: string): string | null {
	if (!path || path.startsWith('/') || path.startsWith('\\')) {
		return 'The format must produce a relative path.';
	}
	if (path.includes('\\')) {
		return 'Use forward slashes for folders.';
	}
	if (path.toLocaleLowerCase().endsWith(MARKDOWN_EXTENSION)) {
		return 'Do not include the .md extension.';
	}

	const parts = path.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) {
		return 'The format contains an invalid path segment.';
	}
	if (parts.some((part) => (
		INVALID_FILE_NAME_PATTERN.test(part)
		|| Array.from(part).some((character) => character.charCodeAt(0) <= 0x1F)
	))) {
		return 'The format contains characters that are not valid in file names.';
	}
	return null;
}
