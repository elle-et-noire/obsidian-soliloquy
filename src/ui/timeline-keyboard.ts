import type { Component, Scope } from 'obsidian';

interface TimelineKeyboardActions {
	focus: (target: 'post' | 'search') => void;
	exitSearch: () => void;
	submit: (target: EventTarget | null) => boolean;
	goBack: () => boolean;
}

/** Share input behavior; leave closing and workspace focus to the host scope. */
export function registerTimelineKeyboard(
	owner: Component,
	scope: Scope,
	root: HTMLElement,
	actions: TimelineKeyboardActions,
): void {
	let lastTextInput: HTMLElement | null = null;
	const focusInput = () => {
		if (lastTextInput && root.contains(lastTextInput) && lastTextInput.isShown()) {
			lastTextInput.focus();
		} else {
			actions.focus(lastTextInput?.matches('.soliloquy-search') ? 'search' : 'post');
		}
	};
	const handleKeydown = (event: KeyboardEvent): boolean => {
		if (event.defaultPrevented) return false;
		if (handleInputEscape(event, root, actions.exitSearch)
			|| handleInputSlash(event, root, focusInput)) return true;
		if (event.isComposing) return false;
		const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
		const isBack = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
			&& (event.key === 'ArrowLeft' || event.code === 'ArrowLeft');
		if (event.ctrlKey && isEnter && actions.submit(event.target)
			|| isBack && actions.goBack()) {
			consumeKey(event);
			return true;
		}
		return false;
	};
	// An exact-key binding returning undefined still blocks the parent in Obsidian.
	// A wildcard can handle input shortcuts and delegate all other keys normally.
	const handler = scope.register(null, null, (event) => handleKeydown(event) ? false : undefined);
	owner.register(() => {
		scope.unregister(handler);
		lastTextInput = null;
	});
	owner.registerDomEvent(root, 'keydown', (event) => { handleKeydown(event); }, { capture: true });
	owner.registerDomEvent(root, 'focusin', () => {
		const input = getFocusedTextInput(root);
		if (input) lastTextInput = input;
	});
}

export function handleInputEscape(
	event: KeyboardEvent,
	root: HTMLElement,
	exitSearch: () => void,
): boolean {
	if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
		return false;
	}
	if (event.isComposing || event.repeat) {
		consumeKey(event);
		return true;
	}
	const input = getFocusedTextInput(root);
	if (!input) return false;
	consumeKey(event);
	if (input.matches('.soliloquy-search')) exitSearch();
	else root.focus({ preventScroll: true });
	return true;
}

export function getFocusedTextInput(root: HTMLElement): HTMLElement | null {
	const focused = root.ownerDocument.activeElement;
	return focused && root.contains(focused)
		&& focused.matches('textarea, input, [contenteditable="true"], [contenteditable=""]')
		? focused as HTMLElement : null;
}

/** Use slash as a focus shortcut only while the user is not entering text. */
export function handleInputSlash(
	event: KeyboardEvent,
	root: HTMLElement,
	focusInput: () => void,
): boolean {
	if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey
		|| event.isComposing || getFocusedTextInput(root)) return false;
	consumeKey(event);
	if (!event.repeat) focusInput();
	return true;
}

function consumeKey(event: KeyboardEvent): void {
	event.preventDefault();
	event.stopImmediatePropagation();
}
