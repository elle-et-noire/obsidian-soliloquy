import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const target = path.resolve(process.argv[2] ?? '.performance-vault');
const postCount = Number(process.argv[3] ?? 10_000);
const postsPerFile = 100;

if (!Number.isSafeInteger(postCount) || postCount < 1) {
	throw new Error('Post count must be a positive integer.');
}

await mkdir(target, { recursive: false });

const start = new Date(Date.UTC(2000, 0, 1));
let createdFiles = 0;
for (let fileIndex = 0; fileIndex * postsPerFile < postCount; fileIndex += 1) {
	const date = new Date(start);
	date.setUTCDate(start.getUTCDate() + fileIndex);
	const dateText = date.toISOString().slice(0, 10);
	const [year, month] = dateText.split('-');
	if (!year || !month) throw new Error(`Could not format benchmark date ${dateText}.`);
	const relativeFile = `log/${year}/${month}/${dateText}.md`;
	const directory = path.join(target, 'log', year, month);
	await mkdir(directory, { recursive: true });

	const lines = [`# ${dateText}`, '', '## soliloquy', ''];
	const firstPost = fileIndex * postsPerFile;
	const filePostCount = Math.min(postsPerFile, postCount - firstPost);
	for (let offset = 0; offset < filePostCount; offset += 1) {
		const itemIndex = firstPost + offset;
		const hour = String(Math.floor(offset / 60)).padStart(2, '0');
		const minute = String(offset % 60).padStart(2, '0');
		lines.push(`- ${hour}:${minute} ^sol-bench-${itemIndex}`);
		if (itemIndex > 0 && itemIndex % 5 === 0) {
			const parentIndex = itemIndex - 1;
			const parentFileIndex = Math.floor(parentIndex / postsPerFile);
			const parentDate = new Date(start);
			parentDate.setUTCDate(start.getUTCDate() + parentFileIndex);
			const parentDateText = parentDate.toISOString().slice(0, 10);
			const [parentYear, parentMonth] = parentDateText.split('-');
			lines.push(`\t[[log/${parentYear}/${parentMonth}/${parentDateText}#^sol-bench-${parentIndex}]]`);
		}
		lines.push(`\tSynthetic benchmark post ${itemIndex} #benchmark`);
		if (itemIndex % 17 === 0) lines.push('\t- [ ] Synthetic task');
	}
	await writeFile(path.join(target, relativeFile), `${lines.join('\n')}\n`, { flag: 'wx' });
	createdFiles += 1;
}

process.stdout.write(`${JSON.stringify({ target, postCount, createdFiles }, null, 2)}\n`);
