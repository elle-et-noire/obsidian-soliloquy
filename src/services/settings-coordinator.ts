export class SettingsCoordinator<T> {
	private timer?: number;
	private pending?: T;
	private revision = 0;
	private writeChain = Promise.resolve();

	constructor(
		private readonly delayMs: number,
		private readonly persist: (value: T) => Promise<void>,
		private readonly apply: (value: T) => Promise<void>,
		private readonly onError: (error: unknown) => void,
		private readonly timerWindow: Pick<Window, 'setTimeout' | 'clearTimeout'> = window,
	) {}

	schedule(value: T): void {
		this.pending = value;
		this.revision += 1;
		if (this.timer !== undefined) this.timerWindow.clearTimeout(this.timer);
		this.timer = this.timerWindow.setTimeout(() => {
			this.timer = undefined;
			void this.flushPending().catch(this.onError);
		}, this.delayMs);
	}

	flush(): Promise<void> {
		if (this.timer !== undefined) {
			this.timerWindow.clearTimeout(this.timer);
			this.timer = undefined;
		}
		return this.flushPending();
	}

	private flushPending(): Promise<void> {
		const snapshot = this.pending;
		if (snapshot === undefined) return this.writeChain;
		this.pending = undefined;
		const revision = this.revision;
		const operation = this.writeChain.then(async () => {
			await this.persist(snapshot);
			if (revision === this.revision) await this.apply(snapshot);
		});
		this.writeChain = operation.catch(() => undefined);
		return operation;
	}
}
