import { ItemView, Scope, WorkspaceLeaf } from 'obsidian';
import type { TimelineService } from '../services/timeline-service';
import { runDetached } from './report-failure';
import { TimelinePanel, type SoliloquyFocusTarget } from './timeline-panel';

export const SOLILOQUY_VIEW_TYPE = 'soliloquy-timeline';
export type { SoliloquyFocusTarget } from './timeline-panel';

export class SoliloquyView extends ItemView {
	private panel?: TimelinePanel;

	constructor(leaf: WorkspaceLeaf, private readonly service: TimelineService) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
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

	onOpen(): Promise<void> {
		const panel = this.addChild(new TimelinePanel(this.app, this.contentEl, this.service));
		this.panel = panel;
		// Reading every daily note must not hold up workspace layout restoration.
		runDetached(
			() => panel.attach({ scope: this.scope!, leaveDisplay: () => this.leaveDisplay() }),
			'open the timeline',
		);
		return Promise.resolve();
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

	private leaveDisplay(): void {
		const workspace = this.app.workspace;
		let destination = workspace.getMostRecentLeaf(workspace.rootSplit);
		if (destination?.view.getViewType() === SOLILOQUY_VIEW_TYPE) destination = null;
		if (!destination) {
			workspace.iterateAllLeaves((leaf) => {
				if (!destination && leaf.getRoot() === workspace.rootSplit
					&& leaf.view.getViewType() !== SOLILOQUY_VIEW_TYPE) destination = leaf;
			});
		}
		if (destination) workspace.setActiveLeaf(destination, { focus: true });
		else {
			const focused = this.contentEl.ownerDocument.activeElement;
			if (focused && this.contentEl.contains(focused)) (focused as HTMLElement).blur();
		}
	}
}
