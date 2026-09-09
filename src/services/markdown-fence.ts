/** Tracks top-level fenced code without changing source line numbers. */
export class MarkdownFenceTracker {
	private fence?: { marker: string; length: number };

	consume(line: string): boolean {
		if (this.fence) {
			const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
			if (closing?.[0] === this.fence.marker && closing.length >= this.fence.length) {
				this.fence = undefined;
			}
			return true;
		}
		const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const marker = opening?.[1];
		if (!marker || (marker[0] === '`' && opening?.[2]?.includes('`'))) return false;
		this.fence = { marker: marker[0]!, length: marker.length };
		return true;
	}
}
