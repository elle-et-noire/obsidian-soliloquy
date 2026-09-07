# Soliloquy

Soliloquy is a local-first, timeline-style journal for [Obsidian](https://obsidian.md). Capture short thoughts without leaving the timeline; every post remains ordinary Markdown in your daily notes.

## Features

- Write timestamped, multiline posts from a dedicated Obsidian view.
- Open the full timeline in a temporary modal and return to your note when finished.
- Browse posts from all matching daily notes in reverse chronological order.
- Search dates, times, post text, and replies.
- Edit posts and check Markdown tasks directly in the timeline.
- Reply to a post and follow the resulting conversation in a thread view.
- Open a post or its date in the original daily note.
- Render Obsidian-flavored Markdown, including links and tags.
- Use the same vault on desktop and mobile; Soliloquy does not require a network service.

## How posts are stored

Soliloquy creates today's note when needed and writes below a configurable level-two heading. With the default settings, a post in `log/2026/07/2026-07-13.md` looks like this:

```md
## soliloquy

- 09:41 ^sol-550e8400-e29b-41d4-a716-446655440000
	A thought captured from the timeline.
	- [ ] Follow up later
```

The block ID lets Soliloquy locate a post safely after other lines are inserted. Replies are regular posts containing an Obsidian block link to their parent. You can read and edit the files normally; keep the timestamp line, indentation, and block ID intact if you edit a post by hand.

## Usage

1. Select the **Open soliloquy** ribbon icon, or run **Soliloquy: Open timeline** from the command palette.
2. Enter a post and select the send button. You can also press `Ctrl+Enter` (`Control+Enter` on macOS) while the editor is focused.
3. Select the search button to filter the timeline. Multiple words are matched together.
4. Use the reply count to open a thread, or the pencil button to edit a post.
5. Select a date to open its daily note, or a time to jump to that post in the note.

In a thread, use the back button or `Alt+Left Arrow` to return to the timeline.

### Sidebar and keyboard shortcuts

Soliloquy opens in the right sidebar by default. You can drag its tab to the left sidebar or the main area; commands reuse the existing view wherever you place it and expand the sidebar when it is collapsed.

Assign your preferred shortcuts under **Settings → Hotkeys** by searching for **Soliloquy**:

| Command | Action |
| --- | --- |
| **Soliloquy: Focus view** | Focus the selected post, or the view itself if there is no selected post, while keeping the current mode and thread. |
| **Soliloquy: Focus search** | Switch to search mode and focus the search input. |
| **Soliloquy: Focus post composer** | Switch to post mode and focus the post input. |

All three commands open Soliloquy if it is closed, and target the modal while it is open. The search and post commands return from a thread to the timeline. Switching between search and posting preserves the input text, selection, Vim mode, and undo history, just like the search button. No default hotkeys are assigned.

Sidebar, tab, and modal displays share the same input shortcuts:

- Inputs follow Obsidian's **Settings → Editor → Vim key bindings** setting. New Vim inputs start in Insert mode without a persistent mode indicator. Setting changes apply when an input receives focus again. Custom mappings from other Vim plugins are not automatically inherited.
- `Esc` inside a post, search, edit, or reply input stays in the editor. With Vim enabled, it exits Insert/Visual mode or cancels a Vim command. Repeated presses never close the display.
- `Shift+Esc` in search returns to the post input, carrying over the text and selection. In a post, edit, or reply input, it moves focus to the timeline without discarding the draft or selection. Use the cancel button to discard an edit or reply. IME composition and held-key repeats do not change focus or close the display.
- Outside text fields, `/` returns to the last visible text field without inserting a slash. If that field is no longer visible, it focuses the main composer (preserving search mode when returning from search). Inside text fields, `/` is entered normally.
- Outside text fields, either `Esc` or `Shift+Esc` closes a modal. A sidebar or regular tab stays open and focus moves to another main workspace pane; if there is no other pane, focus leaves the Soliloquy content.

### Temporary modal

Run **Soliloquy: Open timeline in modal**, or assign it a hotkey under **Settings → Hotkeys**. The modal starts with the post input focused and includes the full timeline, search, threads, replies, and editing. An existing sidebar or tab stays open with its own input and navigation state; both displays use the same daily notes.

- `Ctrl+Enter` posts, replies, or saves an edit. Posting keeps the modal open.
- Closing uses Obsidian's standard focus restoration. Following a date, time, or note link closes the modal and opens that destination instead.
- Running the modal command again focuses the existing modal rather than opening another one.
- Background updates wait while a post editor or reply composer is open so that another display's posts do not discard that draft. Saving or cancelling refreshes the timeline.

The close button and clicking outside the modal also close it. Unsubmitted modal text is discarded when it closes.

## Settings

Open **Settings → Soliloquy** to configure:

- **Daily note folder**: Vault-relative folder containing Soliloquy's daily notes. Default: `log`.
- **Daily note format**: Moment-style path below that folder. Default: `YYYY/MM/YYYY-MM-DD`.
- **Timeline heading**: The level-two heading under which posts are stored. Default: `soliloquy`.

The folder and format must describe the same files you want Soliloquy to read. Changing them does not move existing notes.

## Installation

### From Obsidian Community plugins

Once Soliloquy is listed, open **Settings → Community plugins → Browse**, search for “Soliloquy,” then select **Install** and **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Create `<vault>/.obsidian/plugins/soliloquy/`.
3. Copy the three files into that folder.
4. Reload Obsidian, then enable **Soliloquy** under **Settings → Community plugins**.

## Privacy

Soliloquy works entirely inside your vault. It does not send network requests, collect analytics, or transmit filenames or note contents. Obsidian Sync and other vault synchronization tools operate independently of this plugin.

## Development

Node.js 18 or newer and npm are required.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run lint
npm run build
```

The production build creates `main.js` at the repository root. Generated build output and `node_modules` are not committed.

## Releasing

1. Update the version with `npm version patch`, `npm version minor`, or `npm version major`.
2. Confirm `package.json`, `manifest.json`, and the new `versions.json` entry agree.
3. Run `npm run validate:version -- <version>`, followed by the test, lint, and build commands above.
4. Push a tag matching the version exactly, without a `v` prefix (for example, `0.2.0`).

The release workflow publishes `main.js`, `manifest.json`, and `styles.css` as release assets.

## License

[0BSD](LICENSE)
