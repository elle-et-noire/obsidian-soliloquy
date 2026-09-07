import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { TimelinePanel, type SoliloquyFocusTarget } from './timeline-panel';

export const SOLILOQUY_VIEW_TYPE = 'soliloquy-timeline';
export type { SoliloquyFocusTarget } from './timeline-panel';

export class SoliloquyView extends ItemView {
	private panel?: TimelinePanel;

	constructor(leaf: WorkspaceLeaf, private readonly service: TimelineService) {
		super(leaf);
	}

	getViewType(): string {
		return SOLILOQUY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Soliloquy';
	}

	getIcon(): string {
		return 'messages-square';
	}

	async onOpen(): Promise<void> {
		this.panel = this.addChild(new TimelinePanel(this.app, this.contentEl, this.service));
		await this.panel.mount();
	}

	onClose(): Promise<void> {
		if (this.panel) this.removeChild(this.panel);
		this.panel = undefined;
		this.contentEl.empty();
		return Promise.resolve();
	}

	focus(target: SoliloquyFocusTarget = 'view'): void {
		this.panel?.focus(target);
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
