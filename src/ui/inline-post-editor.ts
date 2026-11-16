import { type App, type Component, Notice, setIcon } from 'obsidian';
import { PostChangedError, TimelineUserError } from '../services/errors';
import type { TimelineService } from '../services/timeline-service';
import { applyPostUpdate } from '../services/post-snapshot';
import type { TimelinePost } from '../types';
import { captureFocusWithin, shouldRestoreFocusWithin } from './focus-preservation';
import type { PostCardRenderer } from './post-card';
import { SoliloquyTextEditor } from './text-editor';

interface DraftInput {
	post: TimelinePost;
	input: SoliloquyTextEditor;
	button: HTMLButtonElement;
	saving: boolean;
	/** Identifies the draft target so closed drafts can be restored. */
	key: string;
}

/** Text of a draft that closed without being saved or explicitly cancelled. */
interface KeptDraft {
	text: string;
	/** Post content the draft was written against (edits only). */
	base?: string;
}

type InlineDraft = DraftInput & (
	| { kind: 'edit'; card: HTMLElement; sourcePost: TimelinePost }
	| {
		kind: 'reply';
		element: HTMLElement;
		trigger: HTMLButtonElement;
		postKey: string;
		stayOnTimeline: boolean;
	}
);

interface InlineEditorCallbacks {
	refresh: () => Promise<void>;
	focusTimeline: () => void;
	onReplySaved: (parent: TimelinePost, stayOnTimeline: boolean) => void;
}

/** Owns the single edit or reply draft in a display, including pending saves. */
export class InlinePostEditor {
	private active?: InlineDraft;
	private disposed = false;
	private readonly keptDrafts = new Map<string, KeptDraft>();

	constructor(
		private readonly app: App,
		private readonly owner: Component,
		private readonly root: HTMLElement,
		private readonly service: TimelineService,
		private readonly renderer: PostCardRenderer,
		private readonly callbacks: InlineEditorCallbacks,
	) {
		owner.register(() => { this.disposed = true; });
	}

	registerFocusEvents(): void {
		this.owner.registerDomEvent(this.root.ownerDocument, 'focusin', (event) => {
			const target = event.target as HTMLElement | null;
			if (!target?.closest) return;
			const field = target.closest('textarea, input, [contenteditable="true"], [contenteditable=""]');
			if (!field) return;
			if (field.tagName === 'INPUT'
				&& !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes((field as HTMLInputElement).type)) return;
			// Vim prompts within this editor do not close its draft. Other fields
			// close it, keeping any changes for when it is opened again.
			if (this.active && !this.active.input.containsTarget(target)) void this.cancel(false, true);
		});
	}

	isOpen(): boolean {
		return this.active !== undefined;
	}

	submitFromShortcut(target: EventTarget | null): boolean {
		if (this.disposed || !this.active?.input.containsTarget(target)) return false;
		void this.save();
		return true;
	}

	openEdit(card: HTMLElement, post: TimelinePost): void {
		if (this.active?.kind === 'edit' && this.active.card === card) {
			this.active.input.focus();
			return;
		}
		this.replaceDraft();
		this.renderer.releaseCard(card);
		card.empty();
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', `Edit post from ${post.date} at ${post.time}`);
		card.removeAttribute('aria-keyshortcuts');
		const key = `edit:${card.dataset.postKey ?? `${post.file.path}:${post.lineStart}:${post.time}`}`;
		const draft: InlineDraft = {
			...this.createInput(card, { ...post }, 'edit', key),
			kind: 'edit', card, sourcePost: post,
		};
		this.activate(draft);
	}

	openReply(
		card: HTMLElement,
		trigger: HTMLButtonElement,
		post: TimelinePost,
		postKey: string,
		stayOnTimeline: boolean,
	): void {
		if (this.active?.kind === 'reply' && this.active.postKey === postKey) {
			void this.cancel(true, true);
			return;
		}
		this.replaceDraft();
		const element = card.createDiv({
			cls: 'soliloquy-inline-reply-composer',
			attr: { role: 'group', 'aria-label': `Reply to post from ${post.date} at ${post.time}` },
		});
		element.addEventListener('click', (event) => event.stopPropagation());
		trigger.setAttribute('aria-expanded', 'true');
		const draft: InlineDraft = {
			...this.createInput(element, post, 'reply', `reply:${postKey}`),
			kind: 'reply', element, trigger, postKey, stayOnTimeline,
		};
		this.activate(draft);
	}

	/**
	 * Closes the open draft. Unless keep is false (saved or explicitly
	 * cancelled), changed text is kept and restored when the draft reopens.
	 */
	clear(restoreFocus = false, keep = true): void {
		const draft = this.active;
		this.active = undefined;
		if (!draft) return;
		if (keep) this.keepDraft(draft);
		else this.keptDrafts.delete(draft.key);
		this.owner.removeChild(draft.input);
		if (draft.kind === 'reply') {
			draft.trigger.setAttribute('aria-expanded', 'false');
			draft.element.remove();
			if (restoreFocus) draft.trigger.focus();
		}
	}

	private replaceDraft(): void {
		// Restoring an edit inserts its card synchronously. Its later refresh
		// preserves the new draft that is about to receive focus.
		if (this.active?.kind === 'edit') void this.cancel(false, true);
		else this.clear();
	}

	private keepDraft(draft: InlineDraft): void {
		// A save in flight owns its text; it is not an abandoned draft.
		if (draft.saving) return;
		const text = draft.input.value;
		const changed = draft.kind === 'edit' ? text !== draft.post.content : text.trim() !== '';
		if (!changed) {
			this.keptDrafts.delete(draft.key);
			return;
		}
		this.keptDrafts.set(draft.key, draft.kind === 'edit' ? { text, base: draft.post.content } : { text });
		if (!this.disposed) new Notice(`Your ${draft.kind} was kept. Open it again to continue.`);
	}

	private createInput(
		parent: HTMLElement,
		post: TimelinePost,
		kind: 'edit' | 'reply',
		key: string,
	): DraftInput {
		const editing = kind === 'edit';
		const kept = this.keptDrafts.get(key);
		this.keptDrafts.delete(key);
		if (kept && editing && kept.base !== post.content) {
			new Notice('This post changed after your edit was kept. Review it before saving.');
		}
		const input = this.owner.addChild(new SoliloquyTextEditor(this.app, parent, {
			cls: `soliloquy-${kind}-input`,
			placeholder: editing ? 'Ctrl + Enter to save' : 'Ctrl + Enter to reply',
			label: editing ? 'Edit post' : 'Write a reply',
			value: kept?.text ?? (editing ? post.content : ''),
		}));
		const actions = parent.createDiv({ cls: editing ? 'soliloquy-edit-actions' : 'soliloquy-inline-reply-actions' });
		const cancel = actions.createEl('button', {
			attr: { type: 'button', 'aria-label': `Cancel ${kind}` },
		});
		setIcon(cancel, 'x');
		const button = actions.createEl('button', {
			cls: 'mod-cta',
			attr: { type: 'button', 'aria-label': editing ? 'Save edit' : 'Reply' },
		});
		setIcon(button, editing ? 'check' : 'send');
		cancel.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.cancel();
		});
		button.addEventListener('click', (event) => {
			event.stopPropagation();
			void this.save();
		});
		return { post, input, button, saving: false, key };
	}

	private activate(draft: InlineDraft): void {
		this.active = draft;
		draft.input.onChange = () => this.updateButton(draft);
		this.updateButton(draft);
		draft.input.focus();
	}

	private updateButton(draft: InlineDraft): void {
		draft.button.disabled = draft.saving || !draft.input.value.trim();
		draft.button.setAttribute('aria-busy', String(draft.saving));
	}

	private async cancel(restoreFocus = true, keep = false): Promise<void> {
		const draft = this.active;
		if (!draft) return;
		const previousFocus = captureFocusWithin(this.root);
		this.clear(restoreFocus, keep);
		try {
			if (draft.kind === 'edit') {
				await this.renderer.restoreCard(draft.card, draft.sourcePost);
				if (!this.disposed && restoreFocus && shouldRestoreFocusWithin(this.root, previousFocus)) {
					this.callbacks.focusTimeline();
				}
			}
			if (!this.disposed) await this.callbacks.refresh();
		} catch (error) {
			console.error(`Soliloquy: failed to refresh cancelled ${draft.kind}`, error);
			new Notice('Could not refresh the timeline.');
		}
	}

	private async save(): Promise<void> {
		const draft = this.active;
		if (this.disposed || !draft || draft.saving) return;
		const content = draft.input.value;
		if (!content.trim()) {
			if (draft.kind === 'edit') new Notice('A post cannot be empty.');
			return;
		}
		draft.saving = true;
		this.updateButton(draft);
		let previousFocus: Element | null = null;
		try {
			if (draft.kind === 'edit') {
				const beforeSave = { ...draft.post };
				await this.service.updatePost(draft.post, content);
				applyPostUpdate(draft.sourcePost, beforeSave, draft.post);
			}
			else await this.service.addReply(draft.post, content);
			if (this.keptDrafts.get(draft.key)?.text === content) this.keptDrafts.delete(draft.key);
			if (this.disposed) return;
			// A pending save must not close a newer field or discard additional text.
			if (this.active === draft && draft.input.value === content) {
				if (draft.kind === 'edit') previousFocus = captureFocusWithin(draft.card);
				this.clear(true, false);
				if (draft.kind === 'reply') this.callbacks.onReplySaved(draft.post, draft.stayOnTimeline);
			}
			await this.callbacks.refresh();
			if (!this.disposed && !this.active && shouldRestoreFocusWithin(this.root, previousFocus)) {
				this.callbacks.focusTimeline();
			}
		} catch (error) {
			console.error(`Soliloquy: failed to save ${draft.kind}`, error);
			if (error instanceof PostChangedError && this.active === draft && !this.disposed) {
				// Retrying against the old snapshot cannot succeed: show the current
				// post and keep the text for when the draft is opened again.
				const text = draft.input.value;
				const closing = this.cancel(false, false);
				this.keptDrafts.set(draft.key, { text, base: draft.post.content });
				new Notice(`The post changed outside the timeline. Your ${draft.kind} was kept: open it again to review it.`);
				await closing;
				return;
			}
			const reason = error instanceof TimelineUserError ? ` ${error.message}` : '';
			new Notice(draft.kind === 'edit'
				? `Could not edit the post.${reason}`
				: `Could not save the reply.${reason}`);
		} finally {
			draft.saving = false;
			this.updateButton(draft);
		}
	}
}
