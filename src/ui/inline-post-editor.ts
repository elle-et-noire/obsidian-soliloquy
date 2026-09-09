import { type App, type Component, Notice, setIcon } from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import type { TimelinePost } from '../types';
import { captureFocusWithin, shouldRestoreFocusWithin } from './focus-preservation';
import type { PostCardRenderer } from './post-card';
import { SoliloquyTextEditor } from './text-editor';

interface DraftInput {
	post: TimelinePost;
	input: SoliloquyTextEditor;
	button: HTMLButtonElement;
	saving: boolean;
}

type InlineDraft = DraftInput & (
	| { kind: 'edit'; card: HTMLElement }
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
			// Vim prompts within this editor do not cancel its draft.
			if (this.active && !this.active.input.containsTarget(target)) void this.cancel(false);
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
		const draft: InlineDraft = {
			...this.createInput(card, post, 'edit'),
			kind: 'edit', card,
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
			void this.cancel();
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
			...this.createInput(element, post, 'reply'),
			kind: 'reply', element, trigger, postKey, stayOnTimeline,
		};
		this.activate(draft);
	}

	clear(restoreFocus = false): void {
		const draft = this.active;
		this.active = undefined;
		if (!draft) return;
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
		if (this.active?.kind === 'edit') void this.cancel(false);
		else this.clear();
	}

	private createInput(parent: HTMLElement, post: TimelinePost, kind: 'edit' | 'reply'): DraftInput {
		const editing = kind === 'edit';
		const input = this.owner.addChild(new SoliloquyTextEditor(this.app, parent, {
			cls: `soliloquy-${kind}-input`,
			placeholder: editing ? 'Ctrl + Enter to save' : 'Ctrl + Enter to reply',
			label: editing ? 'Edit post' : 'Write a reply',
			value: editing ? post.content : '',
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
		return { post, input, button, saving: false };
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

	private async cancel(restoreFocus = true): Promise<void> {
		const draft = this.active;
		if (!draft) return;
		const previousFocus = captureFocusWithin(this.root);
		this.clear(restoreFocus);
		try {
			if (draft.kind === 'edit') {
				await this.renderer.restoreCard(draft.card, draft.post);
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
		try {
			if (draft.kind === 'edit') await this.service.updatePost(draft.post, content);
			else await this.service.addReply(draft.post, content);
			if (this.disposed) return;
			// A pending save must not close a newer field or discard additional text.
			if (this.active === draft && draft.input.value === content) {
				this.clear(true);
				if (draft.kind === 'reply') this.callbacks.onReplySaved(draft.post, draft.stayOnTimeline);
			}
			await this.callbacks.refresh();
		} catch (error) {
			console.error(`Soliloquy: failed to save ${draft.kind}`, error);
			new Notice(draft.kind === 'edit'
				? 'Could not edit the post. Reload the timeline and try again.'
				: 'Could not save the reply.');
		} finally {
			draft.saving = false;
			this.updateButton(draft);
		}
	}
}
