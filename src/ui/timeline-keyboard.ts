import { type Component, Platform, type Scope } from 'obsidian';

interface TimelineKeyboardActions {
	focus: (target: 'post' | 'search') => void;
	leaveDisplay: () => void;
	submit: (target: EventTarget | null) => boolean;
	goBack: () => boolean;
}

/** Obsidian's Mod key: Cmd on macOS, Ctrl elsewhere. */
function isModKey(event: KeyboardEvent): boolean {
	return Platform.isMacOS ? event.metaKey : event.ctrlKey;
}

/** Placeholder naming the platform's submit shortcut, e.g. "Ctrl + Enter to post". */
export function submitShortcutHint(action: string): string {
	return `${Platform.isMacOS ? '⌘' : 'Ctrl'} + Enter to ${action}`;
}

/** The submit shortcut in `aria-keyshortcuts` syntax. */
export function submitKeyShortcut(): string {
	return Platform.isMacOS ? 'Meta+Enter' : 'Control+Enter';
}

/**
 * Share keyboard routing; hosts supply only their final close/focus action.
 * The Scope stays active while the host is the active leaf or open modal, so
 * it handles only keys aimed at `boundary` (the panel unless the host owns a
 * larger element, such as a modal container) or at no element at all.
 */
export function registerTimelineKeyboard(
	owner: Component,
	scope: Scope,
	root: HTMLElement,
	actions: TimelineKeyboardActions,
	boundary: HTMLElement = root,
): void {
	let lastTextInput: HTMLElement | null = null;
	let lastInputWasSearch = false;
	const focusInput = () => {
		if (lastTextInput && root.contains(lastTextInput) && lastTextInput.isShown()) {
			lastTextInput.focus();
		} else {
			actions.focus(lastInputWasSearch ? 'search' : 'post');
		}
	};
	const handleKeydown = (event: KeyboardEvent): boolean => {
		if (event.defaultPrevented) return false;
		if (handleInputEscape(event, root, actions.leaveDisplay, () => actions.focus('post'))
			|| handleInputSlash(event, root, focusInput)) return true;
		if (event.isComposing) return false;
		const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
		const isBack = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
			&& (event.key === 'ArrowLeft' || event.code === 'ArrowLeft');
		if (isModKey(event) && isEnter && actions.submit(event.target)
			|| isBack && actions.goBack()) {
			consumeKey(event);
			return true;
		}
		return false;
	};
	// An exact-key binding returning undefined still blocks the parent in Obsidian.
	// A wildcard can handle input shortcuts and delegate all other keys normally.
	const handler = scope.register(null, null, (event) => {
		// Keys aimed at other elements, e.g. a sidebar field, keep their usual
		// behavior even while this view stays the active leaf.
		if (!isDisplayTarget(event.target, root, boundary)) return undefined;
		if (handleKeydown(event)) return false;
		// true stops parent Scope bindings without cancelling the DOM event.
		// In particular, Modal must not close before CodeMirror receives Escape.
		if (isEscape(event) && getFocusedTextInput(root)) return true;
		return undefined;
	});
	owner.register(() => {
		scope.unregister(handler);
		lastTextInput = null;
	});
	owner.registerDomEvent(root, 'keydown', (event) => { handleKeydown(event); }, { capture: true });
	owner.registerDomEvent(root, 'focusin', () => {
		const input = getFocusedTextInput(root);
		if (input) {
			lastTextInput = input;
			lastInputWasSearch = !!input.closest('.soliloquy-search');
		}
	});
}

export function handleInputEscape(
	event: KeyboardEvent,
	root: HTMLElement,
	leaveDisplay: () => void,
	focusPost: () => void,
): boolean {
	if (!isEscape(event)) return false;
	if (event.isComposing || event.repeat) {
		consumeKey(event);
		return true;
	}
	const input = getFocusedTextInput(root);
	// Plain Escape always belongs to the focused editor, including Vim's
	// search/Ex prompt. Shift+Escape returns Soliloquy search to posting;
	// other inputs keep their drafts and move focus to the timeline.
	if (input && !event.shiftKey) return false;
	consumeKey(event);
	if (input?.closest('.soliloquy-search')) focusPost();
	else if (input) root.focus({ preventScroll: true });
	else leaveDisplay();
	return true;
}

export function getFocusedTextInput(root: HTMLElement): HTMLElement | null {
	const focused = root.ownerDocument.activeElement;
	return focused && root.contains(focused)
		&& (focused.matches('textarea, input, [contenteditable="true"], [contenteditable=""]')
			|| focused.closest('.soliloquy-editor'))
		? focused as HTMLElement : null;
}

function isDisplayTarget(target: EventTarget | null, root: HTMLElement, boundary: HTMLElement): boolean {
	// With nothing focused (e.g. after opening the view or leaving its input),
	// keys target the body and belong to the active display.
	const doc = root.ownerDocument;
	if (!target || target === doc || target === doc.body || target === doc.documentElement) return true;
	return 'nodeType' in target && boundary.contains(target as Node);
}

function isEscape(event: KeyboardEvent): boolean {
	return event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey;
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
