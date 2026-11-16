/** A failure whose message is safe and useful to show to the user. */
export class TimelineUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TimelineUserError';
	}
}

/** The post no longer matches the snapshot the caller started from. */
export class PostChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PostChangedError';
	}
}
