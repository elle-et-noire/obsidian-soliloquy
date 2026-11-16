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

## Usage

1. Select the **Open soliloquy** ribbon icon, or run **Soliloquy: Open timeline** from the command palette.
2. Enter a post and select the send button, or press `Ctrl+Enter` (`Cmd+Enter` on macOS) in the editor.
3. Select the search button to filter the timeline. Multiple words are matched together.
4. Select a post card, or focus it and press `Enter`, to open its thread. Use the back button or `Alt+Left Arrow` to return.
5. Select the reply button with the reply count to write a reply, or the pencil button to edit a post.
6. Select a date to open its daily note, or a time to jump to that post in the note.

Soliloquy opens in the right sidebar by default. You can drag its tab to the left sidebar or the main area; commands reuse the existing view wherever you place it and expand the sidebar when it is collapsed.

### Commands

No default hotkeys are assigned. Search for **Soliloquy** under **Settings → Hotkeys** to add your own.

| Command | Action |
| --- | --- |
| **Open timeline** | Open or reveal the timeline view. |
| **Open timeline in modal** | Open the timeline in a temporary modal, or focus the modal that is already open. |
| **Focus view** | Focus the selected post, or the view itself if there is no selected post, keeping the current mode and thread. |
| **Focus search** | Switch to search mode and focus the search input. |
| **Focus post composer** | Switch to post mode and focus the post input. |

The focus commands open Soliloquy if it is closed and target the modal while it is open. **Focus search** and **Focus post composer** return from a thread to the timeline. Switching between search and posting keeps the input text, selection, Vim mode, and undo history.

### Keyboard

The sidebar, tab, and modal share these shortcuts. They apply while focus is in Soliloquy or nothing is focused; keys typed in other panes keep their usual behavior.

| Key | Where | Action |
| --- | --- | --- |
| `Ctrl+Enter` (`Cmd+Enter` on macOS) | Post, edit, or reply input | Post, save, or reply. |
| `Esc` | Any input | Stay in the editor. With Vim, exit Insert/Visual mode or cancel a command. Repeated presses never close the display. |
| `Shift+Esc` | Search input | Return to the post input with the same text and selection. |
| `Shift+Esc` | Post, edit, or reply input | Move focus to the timeline, keeping the draft and selection. |
| `/` | Outside text fields | Return to the last visible text field without typing a slash. If it is gone, focus the main composer, keeping search mode. |
| `Esc` or `Shift+Esc` | Outside text fields | Close a modal. In a sidebar or tab, move focus to another main pane. |
| `Enter` | Focused post | Open its thread. |
| `Alt+Left Arrow` | Thread | Return to the timeline. |

IME composition and held-key repeats do not change focus or close the display.

Inputs follow **Settings → Editor → Vim key bindings**. New Vim inputs start in Insert mode without a persistent mode indicator, and setting changes apply when an input receives focus again. In Insert mode, `Tab` and `Shift+Tab` indent and outdent the current or selected lines; in Normal mode they move focus. Custom mappings from other Vim plugins are not inherited.

### Editing and replying

- Only one edit or reply input stays open in each display. Moving focus to another text field (including the post/search input or a note editor) closes it. Changed text is kept and returns when you open the same edit or reply again; the cancel button discards it. Focusing a button or the timeline, or a Vim prompt in the same input, keeps the draft open.
- If a post changed in its note after you started editing it, saving shows the current post and keeps your text. Open the edit again to review and save it.
- While a save is in progress, repeated clicks and shortcuts do not submit the same input again. Failed saves keep the input for retry.
- Background updates wait while an edit or reply is open, so changes from another display do not discard the draft. Saving or cancelling refreshes the timeline.
- A post that cannot be displayed shows a short error with a link to its note; the rest of the timeline still loads. A daily note that cannot be read is skipped with a notice.

### Temporary modal

Run **Soliloquy: Open timeline in modal**. The modal starts with the post input focused and includes the full timeline, search, threads, replies, and editing. An open sidebar or tab keeps its own input and navigation state; both use the same daily notes.

- Posting keeps the modal open.
- Closing uses Obsidian's standard focus restoration. Following a date, time, or note link closes the modal and opens that destination.
- The close button and clicking outside the modal also close it. Unsubmitted modal text is discarded when it closes.

## How posts are stored

Posts are written below a configurable level-two heading in your daily notes. With the default settings, a post in `log/2026/07/2026-07-13.md` looks like this:

```md
## soliloquy

- 09:41 ^sol-550e8400-e29b-41d4-a716-446655440000
	A thought captured from the timeline.
	- [ ] Follow up later
```

The block ID lets Soliloquy locate a post safely after other lines are inserted. Replies are regular posts containing an Obsidian block link to their parent. You can read and edit the files normally; keep the timestamp line, indentation, and block ID intact if you edit a post by hand. Body lines may be indented with a tab or with spaces; edits keep the indentation the post already uses.

The timeline section is the level-two heading whose text matches the **Timeline heading** setting, ignoring letter case, extra spaces, and closing `#` characters. It ends at the next level-one or level-two heading; deeper headings stay inside it. Headings in code blocks and comments (`%% %%`, `<!-- -->`) are ignored. A note with more than one matching section is not changed.

### Creating today's note

When you post and today's note does not exist yet, Soliloquy creates it with the timeline heading and the post. By default the new note is otherwise empty. With **Use core daily notes settings** on, Soliloquy uses the folder, date format, and template of the core Daily notes plugin:

- The template is copied with `{{date}}` (in the daily note format), `{{time}}` (`HH:mm`), `{{title}}` (the note name), and `{{date:FORMAT}}` or `{{time:FORMAT}}` (any Moment format) filled in. Other text, including Templater commands, is copied unchanged. If the template contains the timeline heading, posts go below it; otherwise the heading is added at the end.
- If the template cannot be found or read, Soliloquy shows a notice, creates an empty note, and still saves the post.
- An existing note is never changed by the template, so a note created by Daily notes or another plugin keeps its content.
- Soliloquy does not run Templater. If Templater's **Trigger Templater on new file creation** is on, Templater may process the new note, including the first post's text. Soliloquy adds the post right after creating the note and always edits the current file contents, but a Templater run that reads the note before the post is added and writes afterwards (for example, while waiting for a prompt) can overwrite that post. Avoid posting until Templater has finished, or keep Templater commands out of the Daily notes template.

## Settings

Open **Settings → Soliloquy** to configure:

- **Use core daily notes settings**: Use the folder, date format, and template of the core Daily notes plugin. Default: off. While it is on and Daily notes is enabled with a supported format, the next two settings are not used; otherwise Soliloquy falls back to them and creates empty notes.
- **Daily note folder**: Vault-relative folder containing Soliloquy's daily notes. Default: `log`.
- **Daily note format**: Moment-style path below that folder. Default: `YYYY/MM/YYYY-MM-DD`.
- **Timeline heading**: The level-two heading under which posts are stored. Default: `soliloquy`.

Changing the folder, format, or heading, or turning the core daily notes option on or off, does not move existing posts. Posts outside the new location or under the previous heading disappear from the timeline until you move or rename them.

Obsidian does not notify plugins when the Daily notes settings change. Soliloquy rereads them when it loads, when the workspace is ready, when you open its settings, and before it creates today's note; reopen the Soliloquy settings or reload Obsidian to update the timeline right after changing them. Date formats that cannot identify each date from the file path (for example, a format without the year) are not supported.

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

Use Node.js 24 and npm. The supported Node.js ranges are `^20.19.0 || ^22.13.0 || >=24`, as declared in `package.json`.

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
npm run validate:version
```

The production build writes `main.js` at the repository root; build output and `node_modules` are not committed. CI runs the same checks on Node.js 20, 22, and 24 for pushes to `main` and for pull requests. See [AGENTS.md](AGENTS.md) for the code layout and implementation rules, and [PERFORMANCE.md](PERFORMANCE.md) for benchmarks.

## Releasing

1. Update the version with `npm version patch`, `npm version minor`, or `npm version major`.
2. Run `npm run validate:version -- <version>` to confirm `package.json`, `manifest.json`, and `versions.json` agree, then run the checks above.
3. Push a tag matching the version exactly, without a `v` prefix (for example, `0.2.0`).
4. The release workflow validates, tests, lints, builds, and creates a draft release with `main.js`, `manifest.json`, and `styles.css` attached. Review it and publish it manually.

## License

[0BSD](LICENSE)
