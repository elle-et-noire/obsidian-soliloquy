import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// Uses the real moment package so template dates match Obsidian's formatting.
const result = await build({
	stdin: {
		contents: `
			export { TimelineService } from './src/services/timeline-service';
			export { expandDailyNoteTemplate } from './src/services/daily-note-template';
			export { readCoreDailyNotesOptions, resolveDailyNotes } from './src/services/daily-note-settings';
			export { moment } from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
	plugins: [{
		name: 'obsidian-moment',
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-moment' }));
			builder.onLoad({ filter: /.*/, namespace: 'obsidian-moment' }, () => ({
				contents: `
					export { default as moment } from 'moment';
					export class App {}
					export class TFile {
						static [Symbol.hasInstance](value) { return typeof value?.extension === 'string'; }
					}
					export const normalizePath = (path) => path.split('/').filter(Boolean).join('/');
				`,
				loader: 'js',
				resolveDir: process.cwd(),
			}));
		},
	}],
});
const source = result.outputFiles[0]?.text;
if (!source) throw new Error('Core daily notes test bundle was not generated.');
const {
	TimelineService,
	expandDailyNoteTemplate,
	moment,
	readCoreDailyNotesOptions,
	resolveDailyNotes,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const OWN = {
	useCoreDailyNotes: true,
	dailyNoteFolder: 'log',
	dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD',
	sectionHeading: 'soliloquy',
};
const MANUAL_TIMERS = { setTimeout: () => 1, clearTimeout() {} };

function coreApp(options, enabled = true) {
	return {
		internalPlugins: {
			getPluginById: (id) => id === 'daily-notes' ? { enabled, instance: { options } } : null,
		},
	};
}

/** A vault with daily note creation and the core Daily notes options under test control. */
function createVault({ entries = [], core = null, settings = OWN } = {}) {
	const sources = new Map(entries);
	const files = new Map();
	const folders = new Set();
	const addFile = (path) => {
		const file = { path, extension: 'md', basename: path.split('/').pop().replace(/\.md$/, '') };
		files.set(path, file);
		return file;
	};
	for (const path of sources.keys()) addFile(path);
	const app = {
		...(core ? coreApp(core.options, core.enabled ?? true) : {}),
		vault: {
			getMarkdownFiles: () => Array.from(files.values()),
			getAbstractFileByPath: (path) => files.get(path) ?? (folders.has(path) ? { path, children: [] } : null),
			createFolder: async (path) => { folders.add(path); },
			create: async (path, content) => {
				if (files.has(path)) throw new Error('File already exists.');
				sources.set(path, content);
				return addFile(path);
			},
			cachedRead: async (file) => sources.get(file.path) ?? '',
			process: async (file, update) => {
				sources.set(file.path, update(sources.get(file.path) ?? ''));
			},
		},
	};
	let currentSettings = settings;
	const service = new TimelineService(app, () => currentSettings, MANUAL_TIMERS);
	const templateFailures = [];
	service.onTemplateFailure((path) => templateFailures.push(path));
	return {
		app, service, sources, files, folders, templateFailures,
		setSettings: (next) => { currentSettings = next; },
	};
}

test('expands core template variables with the note date and time', () => {
	const date = moment('2026-07-13 09:05:07', 'YYYY-MM-DD HH:mm:ss');
	const template = [
		'# {{title}}',
		'Date: {{date}} / {{ DATE }}',
		'Time: {{time}}',
		'Custom: {{date:dddd, MMMM D}} at {{time:HH:mm:ss}}',
		'Spaced: {{ date : YYYY }}',
		'Kept: {{title:YYYY}} {{unknown}} {{date',
	].join('\n');

	assert.equal(expandDailyNoteTemplate(template, date, 'YYYY-MM-DD', '2026-07-13'), [
		'# 2026-07-13',
		'Date: 2026-07-13 / 2026-07-13',
		'Time: 09:05',
		'Custom: Monday, July 13 at 09:05:07',
		'Spaced: 2026',
		'Kept: {{title:YYYY}} {{unknown}} {{date',
	].join('\n'));
});

test('{{date}} uses the daily note format and {{title}} only the note name', () => {
	const date = moment('2026-07-13', 'YYYY-MM-DD');
	assert.equal(
		expandDailyNoteTemplate('{{date}} | {{title}}', date, 'YYYY/MM/YYYY-MM-DD', '2026-07-13'),
		'2026/07/2026-07-13 | 2026-07-13',
	);
});

test('reads core options defensively and falls back when they are unavailable', () => {
	const options = { folder: '/Journal/', format: 'YYYY-MM-DD', template: 'Templates/Daily' };
	assert.deepEqual(readCoreDailyNotesOptions(coreApp(options)), options);
	assert.equal(readCoreDailyNotesOptions(coreApp(options, false)), null);
	assert.equal(readCoreDailyNotesOptions({}), null);
	assert.equal(readCoreDailyNotesOptions({ internalPlugins: { getPluginById: () => undefined } }), null);
	assert.equal(readCoreDailyNotesOptions({ internalPlugins: { plugins: { 'daily-notes': { enabled: true } } } }), null);
	assert.deepEqual(
		readCoreDailyNotesOptions({ internalPlugins: { plugins: { 'daily-notes': { enabled: true, instance: { options: { folder: 3 } } } } } }),
		{ folder: '', format: '', template: '' },
	);
	const throwing = { internalPlugins: { getPluginById: () => { throw new Error('changed'); } } };
	const originalError = console.error;
	console.error = () => {};
	try {
		assert.equal(readCoreDailyNotesOptions(throwing), null);
	} finally {
		console.error = originalError;
	}

	assert.deepEqual(resolveDailyNotes(OWN, readCoreDailyNotesOptions(coreApp(options))), {
		dailyNoteFolder: 'Journal',
		dailyNoteFormat: 'YYYY-MM-DD',
		template: 'Templates/Daily',
		source: 'core',
	});
	// An empty core format means the core default.
	assert.equal(resolveDailyNotes(OWN, { folder: '', format: ' ', template: '' }).dailyNoteFormat, 'YYYY-MM-DD');
	assert.deepEqual(resolveDailyNotes(OWN, null), {
		dailyNoteFolder: 'log', dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD', template: '', source: 'soliloquy', fallback: 'unavailable',
	});
	assert.equal(resolveDailyNotes(OWN, { folder: '', format: 'dddd', template: '' }).fallback, 'invalid-format');
	assert.deepEqual(resolveDailyNotes({ ...OWN, useCoreDailyNotes: false }, options), {
		dailyNoteFolder: 'log', dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD', template: '', source: 'soliloquy',
	});
});

test('creates today\'s note from the core template, then appends the post', async () => {
	const now = moment();
	const path = `Journal/${now.format('YYYY-MM-DD')}.md`;
	const vault = createVault({
		entries: [['Templates/Daily.md', '# {{title}}\n\nCreated {{date:YYYY}}\n']],
		core: { options: { folder: 'Journal', format: 'YYYY-MM-DD', template: 'Templates/Daily' } },
	});

	await vault.service.addPost('First post');

	assert.ok(vault.folders.has('Journal'));
	const note = vault.sources.get(path);
	assert.match(note, new RegExp(`^# ${now.format('YYYY-MM-DD')}\\n\\nCreated ${now.format('YYYY')}\\n`));
	assert.match(note, /## soliloquy\n\n?- \d\d:\d\d \^sol-[\w-]+\n\tFirst post/);
	assert.deepEqual(vault.templateFailures, []);

	// The existing note is reused; the template is not applied again.
	await vault.service.addPost('Second post');
	assert.equal(vault.sources.get(path).match(/^# /gm).length, 1);
	const timeline = await vault.service.getTimeline();
	assert.deepEqual(timeline.posts.map((post) => post.content).sort(), ['First post', 'Second post']);
	assert.equal(timeline.posts[0].date, now.format('YYYY-MM-DD'));
});

test('posts go below a timeline heading that the template already contains', async () => {
	const vault = createVault({
		entries: [['Templates/Daily.md', '# Day\n\n## Soliloquy\n\n## Notes\n']],
		core: { options: { folder: '', format: '', template: 'Templates/Daily.md' } },
	});
	await vault.service.addPost('Inside');
	const note = vault.sources.get(`${moment().format('YYYY-MM-DD')}.md`);
	assert.match(note, /^# Day\n\n## Soliloquy\n(?:\n)?- \d\d:\d\d \^sol-[\w-]+\n\tInside\n\n## Notes\n$/);
});

test('a missing template is reported and the post is still saved in an empty note', async (t) => {
	t.mock.method(console, 'error', () => {});
	const vault = createVault({
		core: { options: { folder: 'Journal', format: 'YYYY-MM-DD', template: 'Templates/Missing' } },
	});

	await vault.service.addPost('Still saved');

	assert.deepEqual(vault.templateFailures, ['Templates/Missing']);
	const note = vault.sources.get(`Journal/${moment().format('YYYY-MM-DD')}.md`);
	assert.match(note, /^## soliloquy\n\n?- \d\d:\d\d \^sol-[\w-]+\n\tStill saved\n?$/);
});

test('without core Daily notes, Soliloquy\'s own folder and format create an empty note', async () => {
	for (const core of [null, { enabled: false, options: { folder: 'Journal', format: 'YYYY-MM-DD', template: 'T' } }]) {
		const vault = createVault({ core, entries: [['T.md', 'Template text']] });
		assert.equal(vault.service.dailyNoteSettings.source, 'soliloquy');
		await vault.service.addPost('Own settings');
		const note = vault.sources.get(`log/${moment().format('YYYY/MM/YYYY-MM-DD')}.md`);
		assert.match(note, /^## soliloquy\n\n?- \d\d:\d\d \^sol-[\w-]+\n\tOwn settings/);
		assert.deepEqual(vault.templateFailures, []);
	}
});

test('daily note detection follows the core folder and format and refreshes when they change', async () => {
	const options = { folder: 'Journal', format: 'YYYY-MM-DD', template: '' };
	const vault = createVault({
		core: { options },
		entries: [
			['Journal/2026-07-13.md', '## soliloquy\n- 10:00 ^sol-core\n\tCore'],
			['log/2026/07/2026-07-12.md', '## soliloquy\n- 09:00 ^sol-own\n\tOwn'],
			['Daily/13-07-2026.md', '## soliloquy\n- 08:00 ^sol-daily\n\tDaily'],
		],
	});
	const { service } = vault;
	assert.equal(service.isDailyNote(vault.files.get('Journal/2026-07-13.md')), true);
	assert.equal(service.isDailyNote(vault.files.get('log/2026/07/2026-07-12.md')), false);
	assert.deepEqual((await service.getTimeline()).posts.map((post) => post.blockId), ['sol-core']);

	let changes = 0;
	service.onChange(() => { changes++; });
	// An unchanged location keeps the caches.
	service.refreshDailyNoteSettings();
	assert.equal(changes, 0);

	// Core settings changed outside Soliloquy: the next refresh invalidates the path cache.
	options.folder = 'Daily';
	options.format = 'DD-MM-YYYY';
	service.refreshDailyNoteSettings();
	assert.equal(changes, 1);
	assert.equal(service.isDailyNote(vault.files.get('Journal/2026-07-13.md')), false);
	const timeline = await service.getTimeline();
	assert.deepEqual(timeline.posts.map((post) => [post.blockId, post.date]), [['sol-daily', '2026-07-13']]);

	// Turning the option off returns to Soliloquy's own settings.
	vault.setSettings({ ...OWN, useCoreDailyNotes: false });
	service.invalidateAll();
	assert.deepEqual((await service.getTimeline()).posts.map((post) => post.blockId), ['sol-own']);
});

test('core settings are reread before creating today\'s note', async () => {
	const options = { folder: 'Before', format: 'YYYY-MM-DD', template: '' };
	const vault = createVault({ core: { options } });
	options.folder = 'After';
	await vault.service.addPost('Moved');
	assert.ok(vault.sources.has(`After/${moment().format('YYYY-MM-DD')}.md`));
	assert.equal(vault.service.dailyNoteSettings.dailyNoteFolder, 'After');
});

test('concurrent first posts share one new note and template', async () => {
	const vault = createVault({
		entries: [['Templates/Daily.md', '# {{title}}\n']],
		core: { options: { folder: 'Journal', format: 'YYYY-MM-DD', template: 'Templates/Daily' } },
	});
	await Promise.all([vault.service.addPost('One'), vault.service.addPost('Two')]);
	const note = vault.sources.get(`Journal/${moment().format('YYYY-MM-DD')}.md`);
	assert.equal(note.match(/^# /gm).length, 1);
	assert.match(note, /\tOne/);
	assert.match(note, /\tTwo/);
});
