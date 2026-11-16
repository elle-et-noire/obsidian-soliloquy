import type { TFile } from 'obsidian';

export interface TimelinePost {
	date: string;
	time: string;
	content: string;
	file: TFile;
	lineStart: number;
	lineEnd: number;
	blockId?: string;
	replyToBlockId?: string;
	replyLink?: string;
	/** Indentation of the body lines in the note, written back on edits. */
	bodyIndent?: string;
}
