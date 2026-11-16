import { Notice } from 'obsidian';

/** Whether an error only says that superseded work was cancelled. */
export function isCancellation(error: unknown): boolean {
	return typeof error === 'object' && error !== null
		&& (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Logs a failure and, for an action the user started, explains it in a
 * notice. Cancelled work is not a failure and is ignored.
 */
export function reportFailure(error: unknown, action: string, notice?: string): void {
	if (isCancellation(error)) return;
	console.error(`Soliloquy: failed to ${action}`, error);
	if (notice) new Notice(notice);
}

/**
 * Starts work that nobody awaits, such as an event handler's action. Its
 * failure is reported instead of becoming an unhandled rejection.
 */
export function runDetached(task: () => Promise<unknown>, action: string, notice?: string): void {
	try {
		task().catch((error: unknown) => reportFailure(error, action, notice));
	} catch (error) {
		reportFailure(error, action, notice);
	}
}
