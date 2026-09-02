export function captureFocusWithin(element: HTMLElement): Element | null {
	const activeElement = element.ownerDocument.activeElement;
	return activeElement && element.contains(activeElement) ? activeElement : null;
}

export function shouldRestoreFocusWithin(
	element: HTMLElement,
	previousActiveElement: Element | null,
): boolean {
	if (!previousActiveElement) return false;
	const { activeElement, body } = element.ownerDocument;
	return activeElement === previousActiveElement || activeElement === body;
}
