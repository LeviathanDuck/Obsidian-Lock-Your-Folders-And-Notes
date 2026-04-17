# Lock Your Folders & Notes

An Obsidian plugin that protects folders and individual notes from accidental editing or renaming. 

It locks the notes you select into reader view only, until you force unlock. 

This plugin is designed to work inside obsidian alone, and your files are still always editable at their source with other tools. The lock only exists inside of the Obsidian itself. 

Other plugins and tools will be able to override this, it is primarily to prevent accidental human changes to notes you want to lock from changes. 

## Features

- **Force read mode** on locked folders (cascades to every file inside) or individual locked notes.
- **Block rename** on locked folders and notes — any rename attempt is reverted with a notice.
- **Configurable lock icon** in the file explorer:
  - Toggle on/off
  - Optional accent color
  - Position (before or after the name) — independent toggles for folders and notes
  - Works with default file explorer and Notebook Navigator
- **Two ways to add a lock**:
  1. Settings tab → dynamic list with folder/file suggestions (works identically on desktop and mobile)
  2. Right-click (desktop) or long-press (mobile) any folder or note in the file tree → **Lock** / **Unlock**
- **Global toggle command** — temporarily disable all locks when you need to edit
- **Import from Force Read Mode** — on first run, existing `force-read-mode/data.json` is imported automatically

## Installation

### Via BRAT (recommended)
1. Install the [Obsidian42 BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT settings, add this repository: `LeviathanDuck/Obsidian-Lock-Your-Folders-And-Notes`
3. Enable the plugin in Settings → Community Plugins.

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Place them in `your-vault/.obsidian/plugins/lock-your-folders-and-notes/`.
3. Enable in Settings → Community Plugins.

## Safety

- **Never modifies Obsidian's source.** All state lives in the plugin's `data.json`.
- **Theme-safe CSS** — all selectors are scoped to `[data-path=...]` attributes. No theme variables are overridden. `!important` is used only on SVG mask properties (required for cross-theme reliability).
- **Clean uninstall** — disabling or removing the plugin immediately removes all injected CSS, body classes, and event listeners.

## Acknowledgements

- Lock enforcement logic adapted from [Force Read Mode](https://github.com/al3xw/force-read-mode) by al3xw, MIT License.
- Lock icon from the [Lucide](https://lucide.dev) icon library, ISC License.

## Roadmap

Planned features beyond v0.1.0:

- **Force-unlock command with optional password gate** — a single command that temporarily unlocks a specific note for editing, releasing on next file switch or plugin reload. An optional password in settings adds friction against accidental unlocks. Password is stored as a SHA-256 hash via the Web Crypto API (no reversible encryption, no plaintext in `data.json`).
- **Password reset / remove** — a button in settings that wipes the stored hash without requiring the current password. This is not a security control; it's accidental-edit protection. `data.json` is user-accessible, so anyone with filesystem access can bypass any protection here. Use a throwaway password, never a sensitive one.
- **Frontmatter opt-in** — allow a note to declare `lyfn-locked: true` in YAML frontmatter as an alternative to listing it in settings.
- **Canvas file support** — currently only markdown files are locked; canvas files and other file types pass through untouched.

## License

MIT. See [LICENSE](./LICENSE).
