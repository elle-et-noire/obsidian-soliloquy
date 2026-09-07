/** Consume Escape before Obsidian's modal handler or an input's cancel handler. */
export function handleModalEscape(
	event: KeyboardEvent,
	root: HTMLElement,
	close: () => void,
): void {
	if (event.key !== 'Escape') return;
	event.preventDefault();
	event.stopImmediatePropagation();
	if (event.isComposing || event.repeat) return;
	if (getFocusedTextInput(root)) root.focus({ preventScroll: true });
	else close();
}

export function getFocusedTextInput(root: HTMLElement): HTMLElement | null {
	const focused = root.ownerDocument.activeElement;
	return focused && root.contains(focused)
		&& focused.matches('textarea, input, [contenteditable="true"], [contenteditable=""]')
		? focused as HTMLElement : null;
}

/** Use slash as a focus shortcut only while the user is not entering text. */
export function handleModalSlash(
	event: KeyboardEvent,
	root: HTMLElement,
	focusInput: () => void,
): boolean {
	if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey
		|| event.isComposing || getFocusedTextInput(root)) return false;
	event.preventDefault();
	event.stopImmediatePropagation();
	if (!event.repeat) focusInput();
	return true;
}
