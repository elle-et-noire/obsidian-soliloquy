import { App, Modal, Scope } from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { runDetached } from './report-failure';
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
		this.panel = new TimelinePanel(this.app, this.contentEl, this.service);
		const panel = this.panel;
		runDetached(() => panel.attach({
			scope: this.scope,
			// Obsidian may focus the modal itself rather than an element in the panel.
			keyboardBoundary: this.containerEl,
			leaveDisplay: () => this.close(),
			onNavigate: () => {
				// Following a note link should focus its destination when the modal closes.
				this.shouldRestoreSelection = false;
				this.close();
			},
		}), 'open the timeline');
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
}
