/*
 * Lock Your Folders & Notes
 * Protect folders and individual notes from accidental editing or renaming.
 *
 * Lock enforcement logic adapted from Force Read Mode (https://github.com/al3xw/force-read-mode)
 * by al3xw, MIT License.
 *
 * Lock icon from Lucide (https://lucide.dev), ISC License.
 */

import {
  App,
  Menu,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Scope,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";

// ---- Constants ----

const STYLE_EL_ID = "lyfn-icon-styles";
const BODY_CLASS_ACTIVE_LOCKED = "lyfn-active-file-locked";
const FORCE_READ_MODE_DATA_PATH = ".obsidian/plugins/force-read-mode/data.json";
const REPO_URL =
  "https://github.com/LeviathanDuck/Obsidian-Lock-Your-Folders-And-Notes";

const LOCK_SVG_DATA_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E\")";

// ---- Settings ----

type IconPosition = "before" | "after";

interface LYFNSettings {
  lockedFolders: string[];
  lockedNotes: string[];
  unlockExceptions: string[];
  isEnabled: boolean;
  blockRename: boolean;
  showLockIcon: boolean;
  lockIconUseAccent: boolean;
  lockIconPositionFolders: IconPosition;
  lockIconPositionNotes: IconPosition;
  // Force unlock
  forceUnlockEnabled: boolean;
  forceUnlockPasswordHash: string; // "" = no password required
}

const DEFAULT_SETTINGS: LYFNSettings = {
  lockedFolders: [],
  lockedNotes: [],
  unlockExceptions: [],
  isEnabled: true,
  blockRename: false,
  showLockIcon: true,
  lockIconUseAccent: false,
  lockIconPositionFolders: "after",
  lockIconPositionNotes: "after",
  forceUnlockEnabled: false,
  forceUnlockPasswordHash: "",
};

// ---- Crypto helpers ----

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Helpers ----

function isUnderException(
  filePath: string,
  settings: LYFNSettings
): boolean {
  for (const ex of settings.unlockExceptions) {
    if (!ex) continue;
    if (filePath === ex) return true;
    if (filePath.startsWith(ex + "/")) return true;
  }
  return false;
}

function isPathLocked(
  filePath: string,
  settings: LYFNSettings,
  sessionUnlocked?: ReadonlySet<string>
): boolean {
  // Session unlock beats every other rule (including explicit note locks).
  if (sessionUnlocked && sessionUnlocked.has(filePath)) return false;
  // Priority: explicit note lock > unlock exception > folder lock
  if (settings.lockedNotes.includes(filePath)) return true;
  if (isUnderException(filePath, settings)) return false;
  for (const folder of settings.lockedFolders) {
    if (!folder) continue;
    if (filePath === folder) return true;
    if (filePath.startsWith(folder + "/")) return true;
  }
  return false;
}

function isOldPathLocked(oldPath: string, settings: LYFNSettings): boolean {
  // Same as isPathLocked but used at rename time — oldPath may be a folder or file
  if (settings.lockedNotes.includes(oldPath)) return true;
  if (isUnderException(oldPath, settings)) return false;
  if (settings.lockedFolders.includes(oldPath)) return true;
  for (const folder of settings.lockedFolders) {
    if (!folder) continue;
    if (oldPath.startsWith(folder + "/")) return true;
  }
  for (const note of settings.lockedNotes) {
    if (!note) continue;
    if (oldPath === note) return true;
  }
  return false;
}

function cssEscapePath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildIconCSS(settings: LYFNSettings): string {
  if (!settings.showLockIcon) return "";
  if (
    settings.lockedFolders.length === 0 &&
    settings.lockedNotes.length === 0
  ) {
    return "";
  }

  const color = settings.lockIconUseAccent
    ? "var(--interactive-accent)"
    : "currentColor";

  const maskRules = `
    -webkit-mask-image: ${LOCK_SVG_DATA_URI} !important;
    mask-image: ${LOCK_SVG_DATA_URI} !important;
    -webkit-mask-size: contain !important;
    mask-size: contain !important;
    -webkit-mask-repeat: no-repeat !important;
    mask-repeat: no-repeat !important;
    -webkit-mask-position: center !important;
    mask-position: center !important;`;

  const commonRules = `
    content: "";
    display: inline-block;
    width: 0.85em;
    height: 0.85em;
    background-color: ${color};
    vertical-align: -2px;
    opacity: 0.65;${maskRules}`;

  const parts: string[] = [];

  const folderPaths = settings.lockedFolders.filter((p) => p && p.length > 0);
  const notePaths = settings.lockedNotes.filter((p) => p && p.length > 0);
  const folderPos = settings.lockIconPositionFolders;
  const notePos = settings.lockIconPositionNotes;
  const folderMargin =
    folderPos === "before" ? "margin-right: 6px;" : "margin-left: 6px;";
  const noteMargin =
    notePos === "before" ? "margin-right: 6px;" : "margin-left: 6px;";

  // Folder selectors (both exact matches and prefix-match for descendant folders)
  const folderSelectors: string[] = [];
  for (const f of folderPaths) {
    const esc = cssEscapePath(f);
    // Exact match (the folder itself)
    folderSelectors.push(`.nav-folder-title[data-path="${esc}"]::${folderPos}`);
    folderSelectors.push(
      `.nn-navitem[data-path="${esc}"] .nn-navitem-name::${folderPos}`
    );
    // Descendant folders (any depth)
    folderSelectors.push(
      `.nav-folder-title[data-path^="${esc}/"]::${folderPos}`
    );
    folderSelectors.push(
      `.nn-navitem[data-path^="${esc}/"] .nn-navitem-name::${folderPos}`
    );
  }
  if (folderSelectors.length > 0) {
    parts.push(
      `${folderSelectors.join(",\n")} {\n${commonRules}\n    ${folderMargin}\n  }`
    );
  }

  // Note selectors (exact matches for listed notes + prefix-match for files
  // inside any locked folder)
  const noteSelectors: string[] = [];
  for (const n of notePaths) {
    const esc = cssEscapePath(n);
    noteSelectors.push(`.nav-file-title[data-path="${esc}"]::${notePos}`);
    noteSelectors.push(`.nn-file[data-path="${esc}"] .nn-file-name::${notePos}`);
  }
  for (const f of folderPaths) {
    const esc = cssEscapePath(f);
    noteSelectors.push(`.nav-file-title[data-path^="${esc}/"]::${notePos}`);
    noteSelectors.push(
      `.nn-file[data-path^="${esc}/"] .nn-file-name::${notePos}`
    );
  }
  if (noteSelectors.length > 0) {
    parts.push(
      `${noteSelectors.join(",\n")} {\n${commonRules}\n    ${noteMargin}\n  }`
    );
  }

  // Unlock-exception suppressors — hide the lock pseudo-element on any
  // path that is an exception or a descendant of one. Uses !important
  // display:none to override the icon rules above regardless of order.
  const exceptionPaths = settings.unlockExceptions.filter(
    (p) => p && p.length > 0
  );
  if (exceptionPaths.length > 0) {
    const hideSelectors: string[] = [];
    for (const e of exceptionPaths) {
      const esc = cssEscapePath(e);
      // Exact match (the exception itself, folder or note)
      hideSelectors.push(`.nav-folder-title[data-path="${esc}"]::before`);
      hideSelectors.push(`.nav-folder-title[data-path="${esc}"]::after`);
      hideSelectors.push(`.nav-file-title[data-path="${esc}"]::before`);
      hideSelectors.push(`.nav-file-title[data-path="${esc}"]::after`);
      hideSelectors.push(
        `.nn-navitem[data-path="${esc}"] .nn-navitem-name::before`
      );
      hideSelectors.push(
        `.nn-navitem[data-path="${esc}"] .nn-navitem-name::after`
      );
      hideSelectors.push(`.nn-file[data-path="${esc}"] .nn-file-name::before`);
      hideSelectors.push(`.nn-file[data-path="${esc}"] .nn-file-name::after`);
      // Descendants (any depth)
      hideSelectors.push(`.nav-folder-title[data-path^="${esc}/"]::before`);
      hideSelectors.push(`.nav-folder-title[data-path^="${esc}/"]::after`);
      hideSelectors.push(`.nav-file-title[data-path^="${esc}/"]::before`);
      hideSelectors.push(`.nav-file-title[data-path^="${esc}/"]::after`);
      hideSelectors.push(
        `.nn-navitem[data-path^="${esc}/"] .nn-navitem-name::before`
      );
      hideSelectors.push(
        `.nn-navitem[data-path^="${esc}/"] .nn-navitem-name::after`
      );
      hideSelectors.push(
        `.nn-file[data-path^="${esc}/"] .nn-file-name::before`
      );
      hideSelectors.push(
        `.nn-file[data-path^="${esc}/"] .nn-file-name::after`
      );
    }
    parts.push(
      `${hideSelectors.join(",\n")} {\n    display: none !important;\n  }`
    );
  }

  return `/* Generated by Lock Your Folders & Notes */\n${parts.join("\n\n")}\n`;
}

// ---- TextInputSuggest base (adapted from Templater's suggest.ts, MIT by SilentVoid13) ----

abstract class TextInputSuggest<T> {
  protected app: App;
  protected inputEl: HTMLInputElement;
  private scope: Scope;
  private suggestEl: HTMLElement;
  private contentEl: HTMLElement;
  private suggestions: T[] = [];
  private selectedIndex = 0;
  private isOpen = false;

  constructor(app: App, inputEl: HTMLInputElement) {
    this.app = app;
    this.inputEl = inputEl;
    this.scope = new Scope();

    this.suggestEl = document.createElement("div");
    this.suggestEl.addClass("suggestion-container");
    this.suggestEl.addClass("lyfn-suggest");

    this.contentEl = this.suggestEl.createDiv({ cls: "suggestion" });

    document.body.appendChild(this.suggestEl);

    this.inputEl.addEventListener("input", this.onInput);
    this.inputEl.addEventListener("focus", this.onInput);
    this.inputEl.addEventListener("blur", this.onBlur);
    this.contentEl.addEventListener("mousedown", (e) => e.preventDefault());

    this.scope.register([], "ArrowDown", (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      this.setSelected(Math.min(this.selectedIndex + 1, this.suggestions.length - 1));
    });
    this.scope.register([], "ArrowUp", (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      this.setSelected(Math.max(this.selectedIndex - 1, 0));
    });
    this.scope.register([], "Enter", (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      const item = this.suggestions[this.selectedIndex];
      if (item !== undefined) this.useSuggestion(item);
    });
    this.scope.register([], "Escape", (e) => {
      if (!this.isOpen) return;
      e.preventDefault();
      this.close();
    });
  }

  abstract getSuggestions(inputStr: string): T[];
  abstract renderSuggestion(item: T, el: HTMLElement): void;
  abstract selectSuggestion(item: T): void;

  onInput = (): void => {
    const val = this.inputEl.value;
    this.suggestions = this.getSuggestions(val);
    if (this.suggestions.length === 0) {
      this.close();
      return;
    }
    this.selectedIndex = 0;
    this.render();
    this.open();
  };

  onBlur = (): void => {
    // Delay so clicks inside suggestions register first
    window.setTimeout(() => this.close(), 150);
  };

  private render(): void {
    this.contentEl.empty();
    for (let i = 0; i < this.suggestions.length; i++) {
      const item = this.suggestions[i];
      const row = this.contentEl.createDiv({ cls: "suggestion-item" });
      this.renderSuggestion(item, row);
      if (i === this.selectedIndex) row.addClass("is-selected");
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.useSuggestion(item);
      });
    }
  }

  private setSelected(i: number): void {
    this.selectedIndex = i;
    const rows = this.contentEl.querySelectorAll(".suggestion-item");
    rows.forEach((el, idx) =>
      el.toggleClass("is-selected", idx === this.selectedIndex)
    );
    const sel = rows[this.selectedIndex] as HTMLElement | undefined;
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  private useSuggestion(item: T): void {
    this.selectSuggestion(item);
    this.close();
  }

  private open(): void {
    if (this.isOpen) {
      this.position();
      return;
    }
    this.isOpen = true;
    this.suggestEl.addClass("is-open");
    this.position();
    this.app.keymap.pushScope(this.scope);
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.suggestEl.removeClass("is-open");
    this.app.keymap.popScope(this.scope);
  }

  private position(): void {
    const rect = this.inputEl.getBoundingClientRect();
    this.suggestEl.style.left = rect.left + window.scrollX + "px";
    this.suggestEl.style.top = rect.bottom + window.scrollY + "px";
    this.suggestEl.style.minWidth = rect.width + "px";
  }

  destroy(): void {
    this.close();
    this.inputEl.removeEventListener("input", this.onInput);
    this.inputEl.removeEventListener("focus", this.onInput);
    this.inputEl.removeEventListener("blur", this.onBlur);
    this.suggestEl.detach();
  }
}

class FolderSuggest extends TextInputSuggest<TFolder> {
  getSuggestions(inputStr: string): TFolder[] {
    const all = this.app.vault.getAllLoadedFiles();
    const q = inputStr.toLowerCase();
    const folders: TFolder[] = [];
    for (const f of all) {
      if (f instanceof TFolder && f.path !== "/") {
        if (f.path.toLowerCase().contains(q)) folders.push(f);
      }
    }
    folders.sort((a, b) => a.path.localeCompare(b.path));
    return folders.slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.inputEl.blur();
  }
}

class FileSuggest extends TextInputSuggest<TFile> {
  getSuggestions(inputStr: string): TFile[] {
    const all = this.app.vault.getMarkdownFiles();
    const q = inputStr.toLowerCase();
    const matched = all.filter((f) => f.path.toLowerCase().contains(q));
    matched.sort((a, b) => a.path.localeCompare(b.path));
    return matched.slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.inputEl.trigger("input");
    this.inputEl.blur();
  }
}

class AnySuggest extends TextInputSuggest<TAbstractFile> {
  getSuggestions(inputStr: string): TAbstractFile[] {
    const all = this.app.vault.getAllLoadedFiles();
    const q = inputStr.toLowerCase();
    const matched: TAbstractFile[] = [];
    for (const f of all) {
      if (f instanceof TFolder) {
        if (f.path === "/") continue;
        if (f.path.toLowerCase().contains(q)) matched.push(f);
      } else if (f instanceof TFile && f.extension === "md") {
        if (f.path.toLowerCase().contains(q)) matched.push(f);
      }
    }
    matched.sort((a, b) => a.path.localeCompare(b.path));
    return matched.slice(0, 50);
  }

  renderSuggestion(item: TAbstractFile, el: HTMLElement): void {
    const label = item instanceof TFolder ? `📁 ${item.path}` : item.path;
    el.setText(label);
  }

  selectSuggestion(item: TAbstractFile): void {
    this.inputEl.value = item.path;
    this.inputEl.trigger("input");
    this.inputEl.blur();
  }
}

// ---- Password modal ----

class PasswordModal extends Modal {
  private onSubmit: (attempt: string) => void | Promise<void>;

  constructor(app: App, onSubmit: (attempt: string) => void | Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Force unlock" });
    contentEl.createEl("p", {
      text: "Enter the force-unlock password to edit this locked note for the current session.",
      cls: "setting-item-description",
    });
    const input = contentEl.createEl("input", {
      attr: { type: "password", placeholder: "Password" },
      cls: "lyfn-password-input",
    });
    input.focus();

    const btnRow = contentEl.createDiv({ cls: "lyfn-password-btn-row" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const submitBtn = btnRow.createEl("button", {
      text: "Unlock",
      cls: "mod-cta",
    });
    const submit = async () => {
      const attempt = input.value;
      this.close();
      await this.onSubmit(attempt);
    };
    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---- Plugin ----

export default class LYFNPlugin extends Plugin {
  settings: LYFNSettings = { ...DEFAULT_SETTINGS };
  // Paths that the user has force-unlocked for the current session.
  // Cleared on plugin reload (not persisted).
  sessionUnlockedPaths: Set<string> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.migrateFromForceReadMode();

    this.addSettingTab(new LYFNSettingTab(this.app, this));
    this.registerCommands();
    this.injectIconStyles();

    this.app.workspace.onLayoutReady(() => {
      this.onLayoutChange();

      this.registerEvent(
        this.app.workspace.on("layout-change", this.onLayoutChange)
      );
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", this.onActiveLeafChange)
      );
      this.registerEvent(
        this.app.workspace.on("file-menu", this.onFileMenu)
      );
      this.registerEvent(
        this.app.vault.on("rename", this.onVaultRename)
      );
    });
  }

  onunload(): void {
    this.removeIconStyles();
    document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LYFNSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ---- CSS injection ----

  injectIconStyles(): void {
    this.removeIconStyles();
    const css = buildIconCSS(this.settings);
    if (!css) return;
    const styleEl = document.head.createEl("style");
    styleEl.id = STYLE_EL_ID;
    styleEl.setText(css);
  }

  removeIconStyles(): void {
    const existing = document.getElementById(STYLE_EL_ID);
    if (existing) existing.remove();
  }

  refreshIconStyles(): void {
    this.injectIconStyles();
  }

  // ---- Commands ----

  registerCommands(): void {
    this.addCommand({
      id: "toggle-global-lock",
      name: "Toggle global lock enforcement",
      callback: async () => {
        this.settings.isEnabled = !this.settings.isEnabled;
        await this.saveSettings();
        new Notice(
          `Lock Your Folders & Notes: ${this.settings.isEnabled ? "Enabled" : "Disabled"}`
        );
        this.onLayoutChange();
        if (!this.settings.isEnabled) {
          document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
        }
      },
    });

    this.addCommand({
      id: "force-unlock-current-note",
      name: "Force unlock current note (session only)",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const view = leaf?.view;
        if (!(view instanceof MarkdownView)) return false;
        const file = view.file;
        if (!file) return false;
        if (!this.settings.forceUnlockEnabled) return false;
        if (!isPathLocked(file.path, this.settings)) return false;
        if (checking) return true;
        void this.promptForceUnlock(file.path);
        return true;
      },
    });
  }

  async promptForceUnlock(path: string): Promise<void> {
    if (!this.settings.forceUnlockPasswordHash) {
      this.applyForceUnlock(path);
      return;
    }
    new PasswordModal(this.app, async (attempt) => {
      const hash = await sha256Hex(attempt);
      if (hash === this.settings.forceUnlockPasswordHash) {
        this.applyForceUnlock(path);
      } else {
        new Notice("Incorrect password.");
      }
    }).open();
  }

  applyForceUnlock(path: string): void {
    this.sessionUnlockedPaths.add(path);
    document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
    new Notice(
      `Unlocked for this session: ${path}\nRe-locks when you reload the plugin.`,
      5000
    );
    // Nudge the active leaf out of forced-preview.
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (leaf) {
      const state = leaf.getViewState();
      leaf.setViewState({
        ...state,
        state: { ...(state.state ?? {}), mode: "source" },
      });
    }
  }

  // ---- Lock enforcement ----

  enforceLockOnLeaf(leaf: WorkspaceLeaf): void {
    if (!this.settings.isEnabled) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const file = view.file;
    if (!file) return;
    if (!isPathLocked(file.path, this.settings, this.sessionUnlockedPaths))
      return;

    const state = leaf.getViewState();
    const currentMode = (state.state as { mode?: string } | undefined)?.mode;
    if (currentMode === "preview") return;

    leaf.setViewState({
      ...state,
      state: { ...(state.state ?? {}), mode: "preview" },
    });
  }

  onLayoutChange = (): void => {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) this.enforceLockOnLeaf(leaf);
  };

  onActiveLeafChange = (leaf: WorkspaceLeaf | null): void => {
    if (!leaf) {
      document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
      return;
    }
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
      return;
    }
    const file = view.file;
    if (!file) {
      document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
      return;
    }
    const locked =
      this.settings.isEnabled &&
      isPathLocked(file.path, this.settings, this.sessionUnlockedPaths);
    document.body.toggleClass(BODY_CLASS_ACTIVE_LOCKED, locked);

    if (!locked) return;

    const state = leaf.getViewState();
    const currentMode = (state.state as { mode?: string } | undefined)?.mode;
    if (currentMode !== "preview") {
      new Notice(
        "This note is locked. Run 'Toggle global lock enforcement' to edit."
      );
      this.enforceLockOnLeaf(leaf);
    }
  };

  onVaultRename = async (
    file: TAbstractFile,
    oldPath: string
  ): Promise<void> => {
    if (!this.settings.isEnabled) return;
    if (!this.settings.blockRename) return;
    if (!isOldPathLocked(oldPath, this.settings)) return;

    try {
      await this.app.fileManager.renameFile(file, oldPath);
      new Notice("This path is locked. Rename was reverted.");
    } catch (err) {
      new Notice("Could not revert rename on locked path.");
    }
  };

  // ---- File menu integration ----

  onFileMenu = (menu: Menu, file: TAbstractFile): void => {
    if (file instanceof TFolder) {
      if (file.path === "/") return;
      const locked = this.settings.lockedFolders.includes(file.path);
      const isException = this.settings.unlockExceptions.includes(file.path);
      const insideLocked =
        !locked &&
        this.settings.lockedFolders.some(
          (lf) => lf && file.path.startsWith(lf + "/")
        );

      menu.addItem((item) =>
        item
          .setTitle(locked ? "Unlock folder" : "Lock folder (and contents)")
          .setIcon(locked ? "unlock" : "lock")
          .onClick(async () => {
            if (locked) {
              this.settings.lockedFolders = this.settings.lockedFolders.filter(
                (p) => p !== file.path
              );
            } else {
              this.settings.lockedFolders.push(file.path);
            }
            await this.saveSettings();
            this.refreshIconStyles();
            this.onLayoutChange();
          })
      );

      if (insideLocked || isException) {
        menu.addItem((item) =>
          item
            .setTitle(
              isException
                ? "Remove unlock exception"
                : "Add unlock exception (allow edit)"
            )
            .setIcon(isException ? "lock" : "unlock")
            .onClick(async () => {
              if (isException) {
                this.settings.unlockExceptions =
                  this.settings.unlockExceptions.filter(
                    (p) => p !== file.path
                  );
              } else {
                this.settings.unlockExceptions.push(file.path);
              }
              await this.saveSettings();
              this.refreshIconStyles();
              this.onLayoutChange();
            })
        );
      }
    } else if (file instanceof TFile && file.extension === "md") {
      const locked = this.settings.lockedNotes.includes(file.path);
      const isException = this.settings.unlockExceptions.includes(file.path);
      const insideLocked =
        !locked &&
        this.settings.lockedFolders.some(
          (lf) => lf && file.path.startsWith(lf + "/")
        );

      menu.addItem((item) =>
        item
          .setTitle(locked ? "Unlock note" : "Lock this note")
          .setIcon(locked ? "unlock" : "lock")
          .onClick(async () => {
            if (locked) {
              this.settings.lockedNotes = this.settings.lockedNotes.filter(
                (p) => p !== file.path
              );
            } else {
              this.settings.lockedNotes.push(file.path);
            }
            await this.saveSettings();
            this.refreshIconStyles();
            this.onLayoutChange();
          })
      );

      if (insideLocked || isException) {
        menu.addItem((item) =>
          item
            .setTitle(
              isException
                ? "Remove unlock exception"
                : "Add unlock exception (allow edit)"
            )
            .setIcon(isException ? "lock" : "unlock")
            .onClick(async () => {
              if (isException) {
                this.settings.unlockExceptions =
                  this.settings.unlockExceptions.filter(
                    (p) => p !== file.path
                  );
              } else {
                this.settings.unlockExceptions.push(file.path);
              }
              await this.saveSettings();
              this.refreshIconStyles();
              this.onLayoutChange();
            })
        );
      }
    }
  };

  // ---- Migration ----

  async migrateFromForceReadMode(): Promise<void> {
    if (
      this.settings.lockedFolders.length > 0 ||
      this.settings.lockedNotes.length > 0
    ) {
      return;
    }
    const exists = await this.app.vault.adapter.exists(
      FORCE_READ_MODE_DATA_PATH
    );
    if (!exists) return;

    try {
      const raw = await this.app.vault.adapter.read(FORCE_READ_MODE_DATA_PATH);
      const parsed = JSON.parse(raw) as { targetFolderPaths?: string[] };
      const inputs = parsed.targetFolderPaths ?? [];
      const folders: string[] = [];
      const notes: string[] = [];
      for (const raw of inputs) {
        const cleaned = raw
          .replace(/\/\*\*$/, "")
          .replace(/\*\*$/, "")
          .replace(/\/$/, "");
        if (!cleaned) continue;
        const last = cleaned.split("/").pop() ?? "";
        if (last.includes(".")) notes.push(cleaned);
        else folders.push(cleaned);
      }
      if (folders.length === 0 && notes.length === 0) return;
      this.settings.lockedFolders = folders;
      this.settings.lockedNotes = notes;
      await this.saveSettings();
      new Notice(
        "Lock Your Folders & Notes: imported settings from Force Read Mode. You can disable that plugin now.",
        8000
      );
    } catch (err) {
      // ignore — migration is best-effort
    }
  }
}

// ---- Settings Tab ----

class LYFNSettingTab extends PluginSettingTab {
  plugin: LYFNPlugin;

  constructor(app: App, plugin: LYFNPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ---- Beta notice ----
    const betaNotice = containerEl.createDiv({ cls: "lyfn-beta-notice" });
    const betaTitle = betaNotice.createEl("strong");
    betaTitle.setText("🧪 Public beta");
    const betaBody = betaNotice.createEl("p");
    betaBody.appendText(
      "This plugin is in active testing. If you hit something unexpected, please "
    );
    const betaLink = betaBody.createEl("a", {
      text: "submit an issue on GitHub",
      href: REPO_URL + "/issues",
    });
    betaLink.setAttr("target", "_blank");
    betaLink.setAttr("rel", "noopener");
    betaBody.appendText(" — thanks for helping make it better.");

    // ---- Scope notice ----
    const notice = containerEl.createDiv({ cls: "lyfn-scope-notice" });
    notice.createEl("p", {
      text: "This plugin prevents accidental human edits inside Obsidian only. Your files remain editable at their source with any other tool (finder, text editor, CLI). Other Obsidian plugins that modify files directly can also override these locks.",
    });
    notice.createEl("p", {
      text: "Think of it as a soft guard against slips — not a security control.",
      cls: "mod-warning",
    });

    // ---- Lock Icon Appearance ----
    const appearanceHeading = containerEl.createEl("h3", {
      text: "Lock icon appearance ",
    });
    appearanceHeading.appendChild(this.buildPreviewIcon());

    const compatNote = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    compatNote.appendText(
      "Lock icons are rendered in the native Obsidian file tree and in the Notebook Navigator plugin. If your theme hides or misaligns the icons, or you use a different file-tree plugin you'd like supported, please "
    );
    const issuesLink = compatNote.createEl("a", {
      text: "open a GitHub issue",
      href: REPO_URL + "/issues",
    });
    issuesLink.setAttr("target", "_blank");
    issuesLink.setAttr("rel", "noopener");
    compatNote.appendText(".");

    new Setting(containerEl)
      .setName("Show lock icon in file explorer")
      .setDesc("Paints a small lock icon on locked folders and notes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showLockIcon).onChange(async (v) => {
          this.plugin.settings.showLockIcon = v;
          await this.plugin.saveSettings();
          this.plugin.refreshIconStyles();
          this.display();
        })
      );

    const appearanceDisabled = !this.plugin.settings.showLockIcon;

    new Setting(containerEl)
      .setName("Use accent color")
      .setDesc(
        "When on, the icon uses your vault's accent color. When off, it follows the surrounding text color."
      )
      .addToggle((t) => {
        t.setValue(this.plugin.settings.lockIconUseAccent).onChange(
          async (v) => {
            this.plugin.settings.lockIconUseAccent = v;
            await this.plugin.saveSettings();
            this.plugin.refreshIconStyles();
          }
        );
        t.setDisabled(appearanceDisabled);
      });

    const folderPositionSetting = new Setting(containerEl)
      .setName("Folder icon position")
      .setDesc("Where the icon appears on locked folders.")
      .addDropdown((d) => {
        d.addOption("after", "After folder name");
        d.addOption("before", "Before folder name");
        d.setValue(this.plugin.settings.lockIconPositionFolders);
        d.onChange(async (v) => {
          this.plugin.settings.lockIconPositionFolders = v as IconPosition;
          await this.plugin.saveSettings();
          this.plugin.refreshIconStyles();
          this.display();
        });
        d.selectEl.disabled = appearanceDisabled;
      });
    folderPositionSetting.nameEl.appendChild(
      this.buildPositionPreview("folder", this.plugin.settings.lockIconPositionFolders)
    );

    const notePositionSetting = new Setting(containerEl)
      .setName("Note icon position")
      .setDesc("Where the icon appears on individually-locked notes.")
      .addDropdown((d) => {
        d.addOption("after", "After note name");
        d.addOption("before", "Before note name");
        d.setValue(this.plugin.settings.lockIconPositionNotes);
        d.onChange(async (v) => {
          this.plugin.settings.lockIconPositionNotes = v as IconPosition;
          await this.plugin.saveSettings();
          this.plugin.refreshIconStyles();
          this.display();
        });
        d.selectEl.disabled = appearanceDisabled;
      });
    notePositionSetting.nameEl.appendChild(
      this.buildPositionPreview("note", this.plugin.settings.lockIconPositionNotes)
    );

    // ---- Locked Folders ----
    containerEl.createEl("h3", { text: "Locked folders" });
    containerEl.createEl("p", {
      text: "Every note inside a locked folder (at any depth) is protected from editing and renaming. Type a folder path or use the suggestion dropdown.",
      cls: "setting-item-description",
    });

    this.renderPathList(
      containerEl,
      this.plugin.settings.lockedFolders,
      "folder",
      "Add folder"
    );

    // ---- Locked Notes ----
    containerEl.createEl("h3", { text: "Locked notes" });
    containerEl.createEl("p", {
      text: "Lock individual notes. Only .md files are suggested.",
      cls: "setting-item-description",
    });

    this.renderPathList(
      containerEl,
      this.plugin.settings.lockedNotes,
      "note",
      "Add note"
    );

    // ---- Unlock Exceptions ----
    containerEl.createEl("h3", { text: "Unlock exceptions" });
    containerEl.createEl("p", {
      text: "Carve out specific folders or notes inside a locked folder that should remain editable. Exceptions override folder locks. Individually-locked notes still win over exceptions.",
      cls: "setting-item-description",
    });

    this.renderPathList(
      containerEl,
      this.plugin.settings.unlockExceptions,
      "any",
      "Add exception"
    );

    // ---- Force Unlock ----
    containerEl.createEl("h3", { text: "Force unlock" });
    containerEl.createEl("p", {
      text: "Optional escape hatch. When enabled, the command palette exposes 'Force unlock current note (session only)'. Unlocks last until you reload the plugin — they do not persist. If a password is set, you must enter it every time.",
      cls: "setting-item-description",
    });

    const warnP = containerEl.createEl("p", { cls: "setting-item-description" });
    const warnStrong = warnP.createEl("strong");
    warnStrong.setText("⚠ Not a security control.");
    warnP.appendText(
      " The password is stored as a SHA-256 hash in data.json. Anyone with filesystem access can wipe the hash and bypass. Use a throwaway password."
    );

    new Setting(containerEl)
      .setName("Enable force-unlock command")
      .setDesc(
        "Registers the 'Force unlock current note' command in the palette."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.forceUnlockEnabled).onChange(async (v) => {
          this.plugin.settings.forceUnlockEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Password")
      .setDesc(
        this.plugin.settings.forceUnlockPasswordHash
          ? "A password is set. Type a new value to change it; leave empty to keep the current one."
          : "No password — force-unlock will work without prompting. Type a password to set one."
      )
      .addText((t) => {
        t.inputEl.setAttr("type", "password");
        t.setPlaceholder("Type new password…");
        t.onChange(async (v) => {
          if (!v) return;
          const hash = await sha256Hex(v);
          this.plugin.settings.forceUnlockPasswordHash = hash;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Reset password")
      .setDesc(
        "Wipes the stored password hash. Does NOT require the current password to reset."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset password")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.forceUnlockPasswordHash = "";
            await this.plugin.saveSettings();
            new Notice("Force-unlock password cleared.");
            this.display();
          })
      );

    // ---- Global Status ----
    containerEl.createEl("h3", { text: "Global status" });
    new Setting(containerEl)
      .setName("Global lock enforcement")
      .setDesc(
        "Master kill-switch. When off, no read-mode forcing and no rename blocking (icons remain visible)."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.isEnabled).onChange(async (v) => {
          this.plugin.settings.isEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.onLayoutChange();
          if (!v) document.body.removeClass(BODY_CLASS_ACTIVE_LOCKED);
        })
      );

    new Setting(containerEl)
      .setName("Also block rename (experimental)")
      .setDesc(
        "When on, rename attempts on locked folders/notes are reverted with a notice. Note: Obsidian has no pre-rename hook, so the rename happens briefly before the revert. This can race with other plugins or network sync. Recommended off unless you really need it."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.blockRename).onChange(async (v) => {
          this.plugin.settings.blockRename = v;
          await this.plugin.saveSettings();
        })
      );

    // ---- Credits ----
    containerEl.createEl("h3", { text: "Credits" });
    const credits = containerEl.createDiv({ cls: "setting-item-description" });
    credits.createEl("p", {
      text: "Lock enforcement logic adapted from Force Read Mode by al3xw (MIT).",
    });
    credits.createEl("p", {
      text: "Lock icon from the Lucide icon library (ISC).",
    });
    const linkP = credits.createEl("p");
    linkP.appendText("Source & issues: ");
    const link = linkP.createEl("a", { text: REPO_URL, href: REPO_URL });
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener");

    // ---- Author block ----
    const authorBlock = containerEl.createDiv({ cls: "lyfn-author-block" });
    const nameDiv = authorBlock.createEl("div", { cls: "lyfn-author-name" });
    const nameLink = nameDiv.createEl("a", {
      text: "Leviathan Duck",
      href: "https://github.com/LeviathanDuck",
    });
    nameLink.setAttr("target", "_blank");
    nameLink.setAttr("rel", "noopener");
    authorBlock.createEl("div", {
      cls: "lyfn-author-meta",
      text: "Leftcoast Media House Inc.",
    });
    const moreP = authorBlock.createEl("div", { cls: "lyfn-author-meta" });
    const moreLink = moreP.createEl("a", {
      text: "More Obsidian plugins & themes",
      href: "https://github.com/LeviathanDuck?tab=repositories",
    });
    moreLink.setAttr("target", "_blank");
    moreLink.setAttr("rel", "noopener");
  }

  private countChildren(folder: TFolder): { folders: number; files: number } {
    let folders = 0;
    let files = 0;
    const walk = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFolder) {
          folders++;
          walk(child);
        } else if (child instanceof TFile && child.extension === "md") {
          files++;
        }
      }
    };
    walk(folder);
    return { folders, files };
  }

  private buildPreviewIcon(): HTMLSpanElement {
    const icon = document.createElement("span");
    icon.addClass("lyfn-preview-icon");
    return icon;
  }

  private buildPositionPreview(
    kind: "folder" | "note",
    position: IconPosition
  ): HTMLSpanElement {
    const wrap = document.createElement("span");
    wrap.addClass("lyfn-preview-sample");
    const icon = document.createElement("span");
    icon.addClass("lyfn-preview-icon");
    const label = document.createElement("span");
    label.addClass("lyfn-preview-label");
    label.setText(kind === "folder" ? "My folder" : "My note");
    if (position === "before") {
      wrap.appendChild(icon);
      wrap.appendChild(label);
    } else {
      wrap.appendChild(label);
      wrap.appendChild(icon);
    }
    return wrap;
  }

  private renderPathList(
    containerEl: HTMLElement,
    paths: string[],
    kind: "folder" | "note" | "any",
    addLabel: string
  ): void {
    const listEl = containerEl.createDiv({ cls: "lyfn-path-list" });

    paths.forEach((path, index) => {
      const rowContainer = listEl.createDiv({ cls: "lyfn-setting-row" });
      const setting = new Setting(rowContainer);
      setting.addSearch((search) => {
        search.setPlaceholder(
          kind === "folder"
            ? "folder/path"
            : kind === "note"
              ? "folder/note.md"
              : "folder/path or folder/note.md"
        );
        search.setValue(path);

        // Attach suggester (folder+file for "any")
        if (kind === "folder") {
          new FolderSuggest(this.app, search.inputEl);
        } else if (kind === "note") {
          new FileSuggest(this.app, search.inputEl);
        } else {
          new AnySuggest(this.app, search.inputEl);
        }

        const updatePreview = () => {
          const preview = rowContainer.querySelector(".lyfn-folder-preview");
          if (preview) preview.remove();
          if (kind === "note") return;
          const trimmed = (paths[index] ?? "").trim();
          if (!trimmed) return;
          const af = this.app.vault.getAbstractFileByPath(
            normalizePath(trimmed)
          );
          if (!(af instanceof TFolder)) return;
          const counts = this.countChildren(af);
          if (counts.folders === 0 && counts.files === 0) return;
          const p = rowContainer.createEl("div", {
            cls: "lyfn-folder-preview",
          });
          p.setText(
            `↳ ${counts.folders} subfolder${counts.folders === 1 ? "" : "s"}, ${counts.files} file${counts.files === 1 ? "" : "s"} will be affected`
          );
        };

        search.onChange(async (v) => {
          const trimmed = v.trim();
          paths[index] = trimmed;
          // validation warning
          if (trimmed.length > 0) {
            const normalized = normalizePath(trimmed);
            const af = this.app.vault.getAbstractFileByPath(normalized);
            let valid = false;
            if (kind === "folder") valid = af instanceof TFolder;
            else if (kind === "note")
              valid = af instanceof TFile && af.extension === "md";
            else
              valid =
                af instanceof TFolder ||
                (af instanceof TFile && af.extension === "md");
            rowContainer.toggleClass("has-warning", !valid);
          } else {
            rowContainer.removeClass("has-warning");
          }
          updatePreview();
          await this.plugin.saveSettings();
          this.plugin.refreshIconStyles();
          this.plugin.onLayoutChange();
        });

        // initial render of preview after suggester attached
        window.setTimeout(updatePreview, 0);
      });
      setting.addExtraButton((btn) =>
        btn
          .setIcon("x")
          .setTooltip("Remove")
          .onClick(async () => {
            paths.splice(index, 1);
            await this.plugin.saveSettings();
            this.plugin.refreshIconStyles();
            this.plugin.onLayoutChange();
            this.display();
          })
      );
    });

    new Setting(listEl).addButton((btn) =>
      btn
        .setButtonText(addLabel)
        .setCta()
        .onClick(async () => {
          paths.push("");
          await this.plugin.saveSettings();
          this.display();
        })
    );
  }
}
