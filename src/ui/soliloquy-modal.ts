import { App, Modal, Notice, Scope } from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { getFocusedTextInput, handleModalEscape, handleModalSlash } from './modal-keyboard';
import { TimelinePanel, type SoliloquyFocusTarget } from './timeline-panel';
import { captureWorkspaceFocus } from './workspace-focus';

export class SoliloquyModal extends Modal {
	private panel?: TimelinePanel;
	private lastTextInput?: HTMLElement;
	private readonly restoreFocus: () => void;
	private restoreOnClose = true;

	constructor(
		app: App,
		private readonly service: TimelineService,
		private readonly onClosed: () => void,
	) {
		super(app);
		this.restoreFocus = captureWorkspaceFocus(app);
		this.shouldRestoreSelection = false;
		this.setTitle('Soliloquy');
		this.titleEl.hide();
		this.modalEl.addClass('soliloquy-modal');
		// A child scope takes precedence over Modal's built-in Escape binding.
		this.scope = new Scope(this.scope);
		this.scope.register(null, 'Escape', (event) => {
			handleModalEscape(event, this.contentEl, () => this.close());
			return false;
		});
		this.scope.register(null, '/', (event) => {
			return handleModalSlash(event, this.contentEl, () => this.focusTextInput())
				? false : undefined;
		});
		this.scope.register(['Ctrl'], 'Enter', (event) => {
			if (!event.isComposing) this.submitFromShortcut(event.target);
			return false;
		});
		this.scope.register(['Alt'], 'ArrowLeft', (event) => {
			if (!event.isComposing) this.goBack();
			return false;
		});
	}

	onOpen(): void {
		const panel = new TimelinePanel(this.app, this.contentEl, this.service, () => {
			// Following a note link should focus its destination when the modal closes.
			this.restoreOnClose = false;
			this.close();
		});
		this.panel = panel;
		panel.load();
		panel.registerDomEvent(this.contentEl, 'keydown', (event) => {
			handleModalEscape(event, this.contentEl, () => this.close());
			handleModalSlash(event, this.contentEl, () => this.focusTextInput());
		}, { capture: true });
		panel.registerDomEvent(this.contentEl, 'focusin', () => {
			const input = getFocusedTextInput(this.contentEl);
			if (input) this.lastTextInput = input;
		});
		void panel.mount().catch((error: unknown) => {
			console.error('Soliloquy: failed to open modal timeline', error);
			if (this.panel === panel) new Notice('Could not load the timeline.');
		});
		panel.focus('post');
	}

	onClose(): void {
		this.panel?.unload();
		this.panel = undefined;
		this.lastTextInput = undefined;
		this.contentEl.empty();
		this.onClosed();
		// Modal removes its DOM after onClose; restore focus once that has finished.
		if (this.restoreOnClose) queueMicrotask(this.restoreFocus);
	}

	focus(target: SoliloquyFocusTarget = 'view'): void {
		this.panel?.focus(target);
	}

	private focusTextInput(): void {
		const input = this.lastTextInput;
		if (input && this.contentEl.contains(input) && input.isShown()) {
			input.focus();
		} else {
			this.panel?.focus(input?.matches('.soliloquy-search') ? 'search' : 'post');
		}
	}

	submitFromShortcut(target: EventTarget | null): boolean {
		return this.panel?.submitFromShortcut(target) ?? false;
	}

	goBack(): boolean {
		return this.panel?.goBack() ?? false;
	}

	refreshTimeline(): Promise<void> {
		return this.panel?.refreshTimeline(true) ?? Promise.resolve();
	}
}
