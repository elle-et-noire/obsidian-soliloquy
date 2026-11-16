import type { TFile } from 'obsidian';

/**
 * A post as parsed from its daily note. Posts are immutable values shared by
 * the service cache and every display: an update returns a new post, and
 * holders replace their reference instead of changing fields.
 */
export interface TimelinePost {
	// Identity: the block ID is stable; posts without one match by content.
	readonly blockId?: string;
	readonly replyToBlockId?: string;
	readonly replyLink?: string;
	// Content.
	readonly date: string;
	readonly time: string;
	readonly content: string;
	/** Indentation of the body lines in the note, written back on edits. */
	readonly bodyIndent?: string;
	// Position when parsed; it changes whenever the note's lines shift.
	readonly file: TFile;
	readonly lineStart: number;
	readonly lineEnd: number;
}
