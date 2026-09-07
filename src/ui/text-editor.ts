import { type App, Component } from 'obsidian';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';

interface TextEditorOptions {
	cls: string;
	label: string;
	placeholder: string;
	value?: string;
}

/** One editor implementation for the composer, search, edits, and replies. */
export class SoliloquyTextEditor extends Component {
	readonly element: HTMLElement;
	readonly view: EditorView;
	onChange?: () => void;
	private readonly vimConfiguration = new Compartment();
	private readonly presentation = new Compartment();
	private vimEnabled: boolean;
	private startInInsertMode = true;

	constructor(private readonly app: App, parent: HTMLElement, options: TextEditorOptions) {
		super();
		this.element = parent.createDiv({ cls: `soliloquy-editor ${options.cls}` });
		this.vimEnabled = this.readVimSetting();
		this.view = new EditorView({
			parent: this.element,
			state: EditorState.create({
				doc: options.value ?? '',
				extensions: [
					this.vimConfiguration.of(this.vimEnabled ? vim() : []),
					history(),
					drawSelection(),
					keymap.of([
						// Only Insert mode captures Tab; other modes retain native focus navigation.
						{
							key: 'Tab',
							run: (view) => getCM(view)?.state.vim?.insertMode === true && indentMore(view),
							shift: (view) => getCM(view)?.state.vim?.insertMode === true && indentLess(view),
						},
						...defaultKeymap, ...historyKeymap,
					]),
					EditorView.lineWrapping,
					this.presentation.of(editorPresentation(options.label, options.placeholder)),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) this.onChange?.();
					}),
				],
			}),
		});
		// Settings changes are applied when returning to an existing input, without
		// rebuilding its document, selection, or undo history.
		this.registerDomEvent(this.element, 'focusin', () => this.syncVimSetting());
		this.registerDomEvent(this.element, 'click', (event) => event.stopPropagation());
		// Vim leaves a no-op Escape in Normal mode unhandled. Stop it after
		// CodeMirror and its prompts have run, before host DOM handlers can blur
		// the input. Scope alone only blocks Obsidian's parent key bindings.
		this.registerDomEvent(this.element, 'keydown', (event) => {
			if (event.key !== 'Escape' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
			event.preventDefault();
			event.stopPropagation();
		});
		this.register(() => this.view.destroy());
	}

	get value(): string { return this.view.state.doc.toString(); }

	set value(value: string) {
		this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } });
	}

	setPresentation(label: string, hint: string): void {
		this.view.dispatch({
			effects: this.presentation.reconfigure(editorPresentation(label, hint)),
		});
	}

	containsTarget(target: EventTarget | null): boolean {
		return target !== null && 'nodeType' in target && this.element.contains(target as Node);
	}

	focus(): void {
		this.syncVimSetting();
		this.view.focus();
		this.view.requestMeasure();
	}

	private readVimSetting(): boolean {
		// Obsidian exposes this at runtime, but not in its public Vault typings.
		const vault = this.app.vault as App['vault'] & { getConfig?: (key: string) => unknown };
		return vault.getConfig?.('vimMode') === true;
	}

	private syncVimSetting(): void {
		const enabled = this.readVimSetting();
		if (enabled !== this.vimEnabled) {
			this.vimEnabled = enabled;
			this.view.dispatch({
				effects: this.vimConfiguration.reconfigure(enabled ? vim() : []),
			});
			this.startInInsertMode = true;
		}
		if (enabled && this.startInInsertMode) {
			this.startInInsertMode = false;
			const cm = getCM(this.view);
			if (cm) Vim.handleKey(cm, 'i', 'user');
		}
	}
}

function editorPresentation(label: string, hint: string): Extension {
	return [placeholder(hint), EditorView.contentAttributes.of({
		'aria-label': label,
		'aria-keyshortcuts': 'Control+Enter Shift+Escape',
	})];
}
