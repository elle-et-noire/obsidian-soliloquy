/**
 * Hands out one cancellation signal per render pass. Starting a pass aborts
 * the previous one, so asynchronous rendering stops at its next check of
 * `signal.aborted` instead of appending stale cards.
 */
export class RenderPasses {
	private controller = new AbortController();

	/** The signal of the latest pass. */
	get current(): AbortSignal {
		return this.controller.signal;
	}

	start(): AbortSignal {
		this.controller.abort();
		this.controller = new AbortController();
		return this.controller.signal;
	}

	/** Aborts the latest pass without starting another, e.g. when the display closes. */
	cancel(): void {
		this.controller.abort();
	}
}
