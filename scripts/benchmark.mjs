import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const vaultPath = path.resolve(process.argv[2] ?? '.performance-vault');
const sources = new Map();
for (const filePath of await findMarkdownFiles(vaultPath)) {
	const relativePath = path.relative(vaultPath, filePath).replaceAll('\\', '/');
	sources.set(relativePath, await readFile(filePath, 'utf8'));
}

const { TimelineIndex } = await importBundled('src/services/timeline-index.ts');
const { TimelineService } = await importBundled('src/services/timeline-service.ts', true);
const files = Array.from(sources.keys(), (filePath) => ({ path: filePath, extension: 'md' }));
let reads = 0;
const app = {
	vault: {
		getMarkdownFiles: () => files,
		cachedRead: async (file) => {
			reads += 1;
			return sources.get(file.path) ?? '';
		},
	},
};
const settings = {
	dailyNoteFolder: 'log',
	dailyNoteFormat: 'YYYY/MM/YYYY-MM-DD',
	sectionHeading: 'soliloquy',
};
const service = new TimelineService(app, () => settings);

const cold = await measureAsync(() => service.getPosts());
const coldReads = reads;
const warm = await measureAsync(() => service.getPosts());
const posts = cold.value;
const indexBuild = measure(() => new TimelineIndex(posts));
const index = indexBuild.value;
const indexedReplyLookup = measure(() => {
	let replies = 0;
	for (const post of posts) replies += index.getReplies(post).length;
	return replies;
});
const oldReplyLookup = measure(() => {
	let replies = 0;
	for (const post of posts) {
		if (!post.blockId) continue;
		replies += posts.filter((candidate) => candidate.replyToBlockId === post.blockId).length;
	}
	return replies;
});
const terms = ['synthetic', 'benchmark'];
const indexedSearch = measure(() => posts.filter((post) => {
	const searchable = index.getSearchText(post);
	return terms.every((term) => searchable.includes(term));
}).length);
const oldSearch = measure(() => posts.filter((post) => {
	const replies = post.blockId
		? posts.filter((candidate) => candidate.replyToBlockId === post.blockId)
		: [];
	const searchable = `${post.date} ${post.time} ${post.content} ${replies.map((reply) => reply.content).join(' ')}`.toLocaleLowerCase();
	return terms.every((term) => searchable.includes(term));
}).length);
const scaling = [1_000, 5_000]
	.filter((size) => size < posts.length)
	.map((size) => benchmarkPostOperations(posts.slice(0, size)));
scaling.push({
	posts: posts.length,
	indexBuildMs: round(indexBuild.elapsed),
	indexedReplyLookupMs: round(indexedReplyLookup.elapsed),
	oldReplyLookupMs: round(oldReplyLookup.elapsed),
	indexedSearchMs: round(indexedSearch.elapsed),
	oldSearchMs: round(oldSearch.elapsed),
});

const result = {
	vaultPath,
	files: files.length,
	posts: posts.length,
	service: {
		coldMs: round(cold.elapsed),
		coldReads,
		warmMs: round(warm.elapsed),
		additionalWarmReads: reads - coldReads,
	},
	index: {
		buildMs: round(indexBuild.elapsed),
		replyLookupMs: round(indexedReplyLookup.elapsed),
		oldReplyLookupMs: round(oldReplyLookup.elapsed),
		replies: indexedReplyLookup.value,
	},
	search: {
		indexedMs: round(indexedSearch.elapsed),
		oldMs: round(oldSearch.elapsed),
		matches: indexedSearch.value,
	},
	rendering: {
		oldInitialMarkdownRenders: posts.length,
		newInitialMarkdownRenders: Math.min(50, posts.length),
	},
	scaling,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function findMarkdownFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await findMarkdownFiles(entryPath));
		else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
	}
	return files;
}

async function importBundled(entryPoint, stubObsidian = false) {
	const plugins = stubObsidian ? [{
		name: 'obsidian-stub',
		setup(builder) {
			builder.onResolve({ filter: /^obsidian$/ }, () => ({
				path: 'obsidian',
				namespace: 'obsidian-stub',
			}));
			builder.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
				contents: `
					export class App {}
					export class TFile {}
					export const normalizePath = (value) => value;
					export const moment = (value, format) => ({
						isValid: () => typeof value === 'string',
						format: (requested) => requested === format ? value : value?.slice(-10),
					});
				`,
				loader: 'js',
			}));
		},
	}] : [];
	const result = await build({
		entryPoints: [entryPoint],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		write: false,
		plugins,
	});
	const source = result.outputFiles[0]?.text;
	if (!source) throw new Error(`Bundle was not generated for ${entryPoint}.`);
	return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function measure(callback) {
	const started = performance.now();
	const value = callback();
	return { value, elapsed: performance.now() - started };
}

async function measureAsync(callback) {
	const started = performance.now();
	const value = await callback();
	return { value, elapsed: performance.now() - started };
}

function round(value) {
	return Number(value.toFixed(2));
}

function benchmarkPostOperations(sample) {
	const buildIndex = measure(() => new TimelineIndex(sample));
	const sampleIndex = buildIndex.value;
	const indexedReplies = measure(() => {
		let replies = 0;
		for (const post of sample) replies += sampleIndex.getReplies(post).length;
		return replies;
	});
	const oldReplies = measure(() => {
		let replies = 0;
		for (const post of sample) {
			if (!post.blockId) continue;
			replies += sample.filter((candidate) => candidate.replyToBlockId === post.blockId).length;
		}
		return replies;
	});
	const indexedQuery = measure(() => sample.filter((post) => {
		const searchable = sampleIndex.getSearchText(post);
		return terms.every((term) => searchable.includes(term));
	}).length);
	const oldQuery = measure(() => sample.filter((post) => {
		const replies = post.blockId
			? sample.filter((candidate) => candidate.replyToBlockId === post.blockId)
			: [];
		const searchable = `${post.date} ${post.time} ${post.content} ${replies.map((reply) => reply.content).join(' ')}`.toLocaleLowerCase();
		return terms.every((term) => searchable.includes(term));
	}).length);
	return {
		posts: sample.length,
		indexBuildMs: round(buildIndex.elapsed),
		indexedReplyLookupMs: round(indexedReplies.elapsed),
		oldReplyLookupMs: round(oldReplies.elapsed),
		indexedSearchMs: round(indexedQuery.elapsed),
		oldSearchMs: round(oldQuery.elapsed),
	};
}
