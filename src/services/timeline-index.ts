import type { TimelinePost } from '../types';

const EMPTY_POSTS: TimelinePost[] = [];

export class TimelineIndex {
	private readonly postByBlockId = new Map<string, TimelinePost>();
	private readonly repliesByParentId = new Map<string, TimelinePost[]>();
	private readonly searchTextByPost = new WeakMap<TimelinePost, string>();

	constructor(posts: TimelinePost[]) {
		for (const post of posts) {
			if (post.blockId && !this.postByBlockId.has(post.blockId)) {
				this.postByBlockId.set(post.blockId, post);
			}
			if (post.replyToBlockId) {
				const replies = this.repliesByParentId.get(post.replyToBlockId) ?? [];
				replies.push(post);
				this.repliesByParentId.set(post.replyToBlockId, replies);
			}
		}

		for (const replies of this.repliesByParentId.values()) {
			replies.sort(compareChronologically);
		}
		for (const post of posts) {
			const replies = this.getReplies(post);
			this.searchTextByPost.set(post, [
				post.date,
				post.time,
				post.content,
				...replies.map((reply) => reply.content),
			].join(' ').toLocaleLowerCase());
		}
	}

	getPostByBlockId(blockId: string): TimelinePost | undefined {
		return this.postByBlockId.get(blockId);
	}

	getReplies(post: TimelinePost): TimelinePost[] {
		return post.blockId ? this.repliesByParentId.get(post.blockId) ?? EMPTY_POSTS : EMPTY_POSTS;
	}

	getSearchText(post: TimelinePost): string {
		return this.searchTextByPost.get(post) ?? '';
	}
}

function compareChronologically(a: TimelinePost, b: TimelinePost): number {
	const chronological = `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`);
	if (chronological !== 0) return chronological;
	return a.lineStart - b.lineStart;
}
