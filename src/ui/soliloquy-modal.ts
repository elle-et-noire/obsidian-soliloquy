import { App, Modal, Notice, Scope } from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { TimelinePanel, type SoliloquyFocusTarget } from './timeline-panel';

export class SoliloquyModal extends Modal {
	private panel?: TimelinePanel;

	constructor(
		app: App,
		private readonly service: TimelineService,
		private readonly onClosed: () => void,
	) {
		super(app);
		this.setTitle('Soliloquy');
		this.titleEl.hide();
		this.modalEl.addClass('soliloquy-modal');
		// Shared input shortcuts run before Modal's standard close binding.
		this.scope = new Scope(this.scope);
	}

	onOpen(): void {
		const panel = new TimelinePanel(this.app, this.contentEl, this.service, () => {
			// Following a note link should focus its destination when the modal closes.
			this.shouldRestoreSelection = false;
			this.close();
		});
		this.panel = panel;
		panel.load();
		panel.registerKeyboard(this.scope);
		void panel.mount().catch((error: unknown) => {
			console.error('Soliloquy: failed to open modal timeline', error);
			if (this.panel === panel) new Notice('Could not load the timeline.');
		});
	}

	onClose(): void {
		this.panel?.unload();
		this.panel = undefined;
		this.contentEl.empty();
		this.onClosed();
	}

	focus(target: SoliloquyFocusTarget = 'view'): void {
		this.panel?.focus(target);
	}

	refreshTimeline(): Promise<void> {
		return this.panel?.refreshTimeline(true) ?? Promise.resolve();
	}
}
