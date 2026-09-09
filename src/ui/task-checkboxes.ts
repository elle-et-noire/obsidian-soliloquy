import { type App, Component, MarkdownRenderer } from 'obsidian';
import type { MarkdownTask } from '../services/markdown-tasks';
import type { TimelinePost } from '../types';

export function taskCheckboxes(element: HTMLElement): HTMLInputElement[] {
	return Array.from(element.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox'))
		.filter((checkbox) => !checkbox.closest('.internal-embed'));
}

/** The parser is a fast hint; the renderer decides which source marker is real. */
export async function resolveTaskChange(
	app: App,
	owner: Component,
	post: TimelinePost,
	preferred: MarkdownTask | undefined,
	checkboxes: HTMLInputElement[],
	target: HTMLInputElement,
	checked: boolean,
	isCurrent: () => boolean,
): Promise<MarkdownTask | undefined> {
	const candidates = preferred ? [preferred] : [];
	for (const match of post.content.matchAll(/\[[^\r\n]\][ \t]/g)) {
		const markerOffset = match.index + 1;
		if (markerOffset !== preferred?.markerOffset) candidates.push({ markerOffset });
	}
	for (const task of candidates) {
		if (!isCurrent()) return undefined;
		if ((post.content[task.markerOffset] !== ' ') === checked) continue;
		if (await verifyTaskChange(app, owner, post, task, checkboxes, target, checked)) {
			return isCurrent() ? task : undefined;
		}
	}
	return undefined;
}

/** Verify a source position through Obsidian's renderer before writing to it. */
export async function verifyTaskChange(
	app: App,
	owner: Component,
	post: TimelinePost,
	task: MarkdownTask,
	checkboxes: HTMLInputElement[],
	target: HTMLInputElement,
	checked: boolean,
): Promise<boolean> {
	const index = checkboxes.indexOf(target);
	const previous = post.content[task.markerOffset] !== ' ';
	if (index < 0 || previous === checked) return false;
	const states = checkboxes.map((checkbox) => checkbox === target ? previous : checkbox.checked);
	const labels = checkboxes.map(taskLabel);
	const text = post.content.slice(0, task.markerOffset) + (checked ? 'x' : ' ') + post.content.slice(task.markerOffset + 1);
	const probe = target.ownerDocument.createElement('div');
	const component = owner.addChild(new Component());
	try {
		// Static MarkdownRenderer.render does not expose source line positions.
		// A change to a hidden/wrong task must not authorize a visible checkbox.
		await MarkdownRenderer.render(app, text, probe, post.file.path, component);
		const rendered = taskCheckboxes(probe);
		return rendered.length === checkboxes.length && rendered.every((checkbox, position) =>
			checkbox.checked === (position === index ? checked : states[position])
			&& taskLabel(checkbox) === labels[position]);
	} catch (error) {
		console.error('Soliloquy: failed to verify task', error);
		return false;
	} finally {
		owner.removeChild(component);
	}
}

function taskLabel(checkbox: HTMLInputElement): string {
	return (checkbox.closest('li') ?? checkbox.parentElement)?.textContent ?? '';
}
