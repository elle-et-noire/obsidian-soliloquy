import type { TimelinePost } from '../types';

/** Publish a successful save without replacing a concurrently updated post. */
export function applyPostUpdate(post: TimelinePost, expected: TimelinePost, updated: TimelinePost): void {
	if (post.content === expected.content && post.time === expected.time
		&& (post.blockId === expected.blockId || post.blockId === updated.blockId)
		&& post.replyLink === expected.replyLink) {
		Object.assign(post, updated);
	}
}
