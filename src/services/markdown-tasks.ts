import { parser, TaskList } from '@lezer/markdown';

export interface MarkdownTask {
	/** Offset of the space/x inside the source task marker. */
	markerOffset: number;
}

const taskParser = parser.configure(TaskList);

export function findMarkdownTasks(content: string): MarkdownTask[] {
	const tasks: MarkdownTask[] = [];
	taskParser.parse(content).iterate({
		enter(node) {
			if (node.name === 'TaskMarker') tasks.push({ markerOffset: node.from + 1 });
		},
	});
	return tasks;
}
