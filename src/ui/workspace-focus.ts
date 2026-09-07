import { App, MarkdownView, View } from 'obsidian';

/** Capture the workspace view even when a command palette currently owns DOM focus. */
export function captureWorkspaceFocus(app: App): () => void {
	const view = app.workspace.getActiveViewOfType(View);
	const element = activeDocument.activeElement;
	const editor = view instanceof MarkdownView && view.getMode() === 'source'
		? view.editor : undefined;
	const file = view instanceof MarkdownView ? view.file : undefined;
	const selections = editor?.listSelections();
	const scroll = editor?.getScrollInfo();

	return () => {
		if (!view || app.workspace.getActiveViewOfType(View) !== view) return;
		let attached = false;
		app.workspace.iterateAllLeaves((leaf) => {
			if (leaf === view.leaf) attached = true;
		});
		if (!attached) return;
		app.workspace.setActiveLeaf(view.leaf, { focus: false });
		if (view instanceof MarkdownView && view.file === file && editor && selections && scroll) {
			const current = editor.listSelections();
			const unchanged = current.length === selections.length && current.every((selection, index) => {
				const saved = selections[index];
				return saved && selection.anchor.line === saved.anchor.line
					&& selection.anchor.ch === saved.anchor.ch
					&& selection.head.line === saved.head.line
					&& selection.head.ch === saved.head.ch;
			});
			if (!unchanged) editor.setSelections(selections);
			editor.focus();
			editor.scrollTo(scroll.left, scroll.top);
			// CodeMirror may scroll the selection into view during its next layout pass.
			view.containerEl.win.requestAnimationFrame(() => {
				if (app.workspace.getActiveViewOfType(View) === view
					&& view.file === file && editor.hasFocus()) {
					editor.scrollTo(scroll.left, scroll.top);
				}
			});
		} else if (element?.instanceOf(HTMLElement) && element.isConnected
			&& view.containerEl.contains(element)) {
			element.focus({ preventScroll: true });
		} else {
			app.workspace.setActiveLeaf(view.leaf, { focus: true });
		}
	};
}
