import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Change } from "./binder";
import type { BookContent } from "./exportBook";
import type { BookLayout, ExportFormat, ExportSettings } from "./exportSettings";
import type { ProjectSnapshot } from "./project";
import type { NewProject, ProjectEntry } from "./projects";

/** A grammar problem in a paragraph, as the core finds it (Harper, or a LanguageTool server). */
export interface GrammarProblem {
  /** Where it is in the paragraph's text, in UTF-16 code units (string offsets). */
  from: number;
  to: number;
  /** What is wrong, as a sentence for the writer. */
  message: string;
  /** The checker's category, such as "Agreement". */
  kind: string;
  /** Text to put in place of the problem, best first; "" removes it. */
  fixes: string[];
}

/** A LanguageTool server the writer chose, as the core takes it; paragraphs checked are sent there. */
export type GrammarServer =
  | { mode: "public" }
  | { mode: "premium"; username: string; apiKey: string }
  | { mode: "own"; url: string };

/** An earlier version of a chapter, kept on this device. */
export interface Version {
  /** When it was kept, in milliseconds since 1970. Also names the version. */
  savedAt: number;
  text: string;
}

/** A Dropbox account, as the core shows it. */
export interface DropboxAccount {
  accountId: string;
  /** The account's display name, such as "Ada Lovelace". */
  name: string;
  email: string;
}

/** The Dropbox connection on this device. */
export interface DropboxStatus {
  /** Null when no account is connected. */
  account: DropboxAccount | null;
  /** The sign-in is kept in a file only this user can read, as this desktop has no keyring service. */
  tokenInFile: boolean;
}

/** What `signInFinish` rejects with after `signInCancel`. */
export const DROPBOX_SIGN_IN_CANCELLED = "Signing in to Dropbox was cancelled.";

/** The writer's Dropbox, signed in on Dropbox's own page in the browser. */
export interface DropboxBackend {
  /** Which account is connected, read on this device. */
  status(): Promise<DropboxStatus>;
  /**
   * Opens Dropbox's sign-in page in the browser. With `manual`, Dropbox will
   * show a code for the writer to paste (signInFinish(code)), as the app
   * could not listen for its answer; otherwise signInFinish() waits for it.
   * A sign-in still waiting is cancelled.
   */
  signInStart(): Promise<{ manual: boolean }>;
  /**
   * Finishes the sign-in: waits for Dropbox's answer, or uses the pasted
   * `code`, and resolves to the connection. Rejects with the reason, or with
   * DROPBOX_SIGN_IN_CANCELLED once cancelled. After a pasted code fails, it
   * can be corrected and tried again.
   */
  signInFinish(code?: string): Promise<DropboxStatus>;
  /** Stops waiting for Dropbox. */
  signInCancel(): Promise<void>;
  /**
   * Signs out on this device. Resolves to a note for the writer when Dropbox
   * could not be told (offline): the access can then be removed in
   * Dropbox's settings. Otherwise null.
   */
  signOut(): Promise<string | null>;
}

/**
 * Everything the interface asks of the core. In the app this goes to Rust
 * over Tauri's IPC; in a plain browser (`npm run dev`) an in-memory copy of
 * the sample project stands in, so the interface can be worked on without
 * building the Rust side.
 */
export interface Backend {
  readonly kind: "app" | "browser";
  /** Whether `pickProjectFolder` can show a folder picker (desktops; on phones projects live in the app's folder). */
  readonly canOpenFolders: boolean;
  /** Whether `createProject` can create projects (not in the browser preview). */
  readonly canCreateProjects: boolean;
  /** The writer's Dropbox. Absent in builds without the app's Dropbox key, and in the browser preview. */
  readonly dropbox?: DropboxBackend;
  openSampleProject(): Promise<ProjectSnapshot>;
  /** Opens a project folder by path (the one used last time, or one picked). */
  openProject(path: string): Promise<ProjectSnapshot>;
  /** Shows a folder picker; the chosen folder's path, or null if cancelled. Opens nothing. */
  pickProjectFolder(): Promise<string | null>;
  /**
   * Opens a web page in the system browser, since the app's window doesn't
   * follow links. Only the app's website may be opened (see
   * src-tauri/capabilities/default.json). Absent in the browser preview,
   * where a link opens in a new tab by itself.
   */
  openUrl?(url: string): Promise<void>;
  /**
   * The projects on this device: those in the app's own folder, then the
   * `recent` folders opened from elsewhere that still open.
   */
  listProjects(recent: string[]): Promise<ProjectEntry[]>;
  /** Creates a project in the app's own folder and opens it. */
  createProject(project: NewProject): Promise<ProjectSnapshot>;
  /**
   * Makes a change to the binder (create folders, move chapters and parts,
   * write files) as a whole or not at all, and resolves to the project as it
   * is afterwards.
   */
  applyChanges(root: string, change: Change): Promise<ProjectSnapshot>;
  /**
   * Replaces one file of the open project. `root` is the root of the project
   * the text belongs to (from its snapshot); the save is refused if that
   * project is no longer the open one. A chapter's previous text is kept as a
   * version first (at most every ten minutes). Resolves to a warning when the
   * text was saved but that version could not be kept, otherwise to null.
   */
  writeFile(root: string, path: string, text: string): Promise<string | null>;
  /** The kept versions of a chapter, newest first. */
  listVersions(root: string, chapter: string): Promise<Version[]>;
  /**
   * Puts a kept version back as the chapter's text, on disk, and resolves to
   * that text. The text it replaces is kept as a version first.
   */
  restoreVersion(root: string, chapter: string, savedAt: number): Promise<string>;
  /**
   * For each word, whether it is an ordinary word of `language` (a project
   * language such as "en-GB") written with a capital, such as "River",
   * rather than a name, from the dictionaries bundled with the app.
   * Resolves to null when there is no dictionary for the language. Absent
   * where there are no dictionaries at all (the browser preview).
   */
  ordinaryWords?(language: string, words: string[]): Promise<boolean[] | null>;
  /**
   * For each word, whether the dictionary of `language` spells it this way.
   * Resolves to null when there is no dictionary for the language. Absent
   * where there are no dictionaries (the browser preview without its dev
   * server).
   */
  checkWords?(language: string, words: string[]): Promise<boolean[] | null>;
  /**
   * Corrections for a misspelled word, best first (at most six). Resolves
   * to null when there is no dictionary for the language. There exactly
   * where checkWords is.
   */
  suggestWords?(language: string, word: string): Promise<string[] | null>;
  /**
   * Each paragraph's grammar problems, in order. Paragraphs are their text
   * as it reads, without Markdown. With `server`, the paragraphs are sent to
   * that LanguageTool server; without, English is checked on this device
   * (Harper) and other languages resolve to null. Rejects with a reason
   * when a server can't be reached or refuses. Absent in the browser preview.
   */
  checkGrammar?(language: string, paragraphs: string[], server: GrammarServer | null): Promise<GrammarProblem[][] | null>;
  /**
   * Lays the book out into pages with Typst, for the export preview; the
   * core keeps the pages for bookPage. Absent where pages can't be drawn
   * (the browser preview without its dev server).
   */
  layOutBook?(book: BookContent, settings: ExportSettings): Promise<BookLayout>;
  /** One page of a layout as SVG; rejects once a newer layout replaced it. There exactly where layOutBook is. */
  bookPage?(generation: number, index: number): Promise<string>;
  /**
   * Writes the book in `format` where the writer chooses in the system's
   * save dialog (`fileName` suggested). Resolves to where it went, "" when
   * the system doesn't say (Android's save dialog gives no path), or null
   * when the dialog was cancelled. Absent in the browser preview.
   */
  exportBook?(book: BookContent, settings: ExportSettings, format: ExportFormat, fileName: string): Promise<string | null>;
  /**
   * Desktop app only: shows the text's context menu, native, at a point in
   * the window (client coordinates): `items` first, in groups set apart by
   * separators, then Cut, Copy, Paste and Select All, which the system
   * carries out on the text. Absent on phones and in the browser preview,
   * where the page shows its own menu.
   */
  popupTextMenu?(items: TextMenuEntry[], x: number, y: number): Promise<void>;
  /**
   * Desktop app only: closes the window as its own close button does, so
   * `onCloseRequested` runs first and pending saves finish. Absent on phones
   * and in the browser preview, which have no window to close.
   */
  closeWindow?(): Promise<void>;
  /**
   * Desktop app only: the window's own theme (its title bar), light, dark,
   * or the system's (null). Absent on phones and in the browser preview.
   */
  setWindowTheme?(theme: "light" | "dark" | null): Promise<void>;
  /**
   * Runs before the window closes, so pending saves can finish. The window
   * stays open if the handler resolves to false. Resolves to an unsubscribe.
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
  /**
   * Phones only: runs `handler` on each press of the system's Back button,
   * in place of what Back does by itself (leaving the app). Resolves to an
   * unsubscribe, after which Back leaves the app again. The on-screen
   * keyboard takes a press itself to go away, so the handler doesn't see
   * that one. Absent on desktops and in the browser preview.
   */
  onBackButton?(handler: () => void): Promise<() => void>;
  /** Phones only: closes the app, as Back does by itself. There exactly where onBackButton is. */
  exitApp?(): Promise<void>;
}

/** An item of the app's own entries in the text's context menu. */
export interface TextMenuItem {
  text: string;
  enabled?: boolean;
  action(): void;
}

/** A line between two groups of the app's own entries in the text's context menu. */
export interface TextMenuSeparator {
  separator: true;
}

/** What the app puts in the text's context menu: items, and separators between their groups. */
export type TextMenuEntry = TextMenuItem | TextMenuSeparator;

export const TEXT_MENU_SEPARATOR: TextMenuSeparator = { separator: true };

export function isTextMenuSeparator(entry: TextMenuEntry): entry is TextMenuSeparator {
  return "separator" in entry && entry.separator;
}

/**
 * The entries as the menu shows them: a separator only between two groups,
 * never first, last or twice in a row, so a group left empty leaves no
 * line behind.
 */
export function tidyTextMenu(entries: TextMenuEntry[]): TextMenuEntry[] {
  const tidy: TextMenuEntry[] = [];
  for (const entry of entries) {
    const last = tidy.at(-1);
    if (isTextMenuSeparator(entry) && (last === undefined || isTextMenuSeparator(last))) continue;
    tidy.push(entry);
  }
  if (tidy.length > 0 && isTextMenuSeparator(tidy[tidy.length - 1])) tidy.pop();
  return tidy;
}

/** Tauri rejects commands with the string the Rust side returned. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw asError(error);
  }
}

/**
 * The text menu shown last: the menu and its items. They live in the core
 * until closed (Tauri resources), so each new menu closes the last one's
 * first; closing an item also drops its action. At most one stays open.
 */
let shownTextMenu: { close(): Promise<void> }[] = [];
let textMenus: Promise<void> = Promise.resolve();

async function showTextMenu(entries: TextMenuEntry[], x: number, y: number): Promise<void> {
  const { Menu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const { LogicalPosition } = await import("@tauri-apps/api/dpi");
  const previous = shownTextMenu;
  shownTextMenu = [];
  await Promise.allSettled(previous.map((resource) => resource.close()));
  const own = await Promise.all(
    tidyTextMenu(entries).map((entry) =>
      isTextMenuSeparator(entry)
        ? PredefinedMenuItem.new({ item: "Separator" })
        : // "&" marks a mnemonic in a native menu; "&&" shows one, as names, messages and fixes may hold.
          MenuItem.new({ text: entry.text.replaceAll("&", "&&"), enabled: entry.enabled ?? true, action: () => entry.action() }),
    ),
  );
  const separator = own.length > 0 ? [await PredefinedMenuItem.new({ item: "Separator" })] : [];
  const edit = await Promise.all(
    (["Cut", "Copy", "Paste", "Separator", "SelectAll"] as const).map((item) => PredefinedMenuItem.new({ item })),
  );
  const menu = await Menu.new({ items: [...own, ...separator, ...edit] });
  shownTextMenu = [menu, ...own, ...separator, ...edit];
  await menu.popup(new LogicalPosition(x, y));
}

const dropboxBackend: DropboxBackend = {
  status: () => call<DropboxStatus>("dropbox_status"),
  signInStart: () => call<{ manual: boolean }>("dropbox_sign_in_start"),
  signInFinish: (code) => call<DropboxStatus>("dropbox_sign_in_finish", { code: code ?? null }),
  signInCancel: () => call<void>("dropbox_sign_in_cancel"),
  signOut: () => call<string | null>("dropbox_sign_out"),
};

const appBackend: Omit<Backend, "canOpenFolders"> = {
  kind: "app",
  canCreateProjects: true,
  openSampleProject: () => call<ProjectSnapshot>("open_sample_project"),
  openProject: (path) => call<ProjectSnapshot>("open_project", { path }),
  async pickProjectFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, multiple: false, title: "Open a project folder" });
    return typeof path === "string" ? path : null;
  },
  async openUrl(url) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (error) {
      throw asError(error);
    }
  },
  listProjects: (recent) => call<ProjectEntry[]>("list_projects", { recent }),
  createProject: ({ name, folders, files }) => call<ProjectSnapshot>("create_project", { name, folders, files }),
  applyChanges: (root, change) => call<ProjectSnapshot>("apply_changes", { root, change }),
  writeFile: (root, path, text) => call<string | null>("write_project_file", { root, path, text }),
  listVersions: (root, chapter) => call<Version[]>("list_versions", { root, chapter }),
  restoreVersion: (root, chapter, savedAt) => call<string>("restore_version", { root, chapter, savedAt }),
  ordinaryWords: (language, words) => call<boolean[] | null>("ordinary_words", { language, words }),
  checkWords: (language, words) => call<boolean[] | null>("check_words", { language, words }),
  suggestWords: (language, word) => call<string[] | null>("suggest_words", { language, word }),
  checkGrammar: (language, paragraphs, server) =>
    call<GrammarProblem[][] | null>("check_grammar", { language, paragraphs, server }),
  layOutBook: (book, settings) => call<BookLayout>("lay_out_book", { book, settings }),
  bookPage: (generation, index) => call<string>("book_page", { generation, index }),
  exportBook: (book, settings, format, fileName) =>
    call<string | null>("export_book", { book, settings, format, fileName }),
  popupTextMenu(items, x, y) {
    // One at a time, so each menu frees the one before it.
    const shown = textMenus.then(() => showTextMenu(items, x, y));
    textMenus = shown.catch(() => undefined);
    return shown;
  },
  async closeWindow() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    try {
      await getCurrentWindow().close();
    } catch (error) {
      throw asError(error);
    }
  },
  async setWindowTheme(theme) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    try {
      await getCurrentWindow().setTheme(theme);
    } catch (error) {
      throw asError(error);
    }
  },
  async onCloseRequested(handler) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    });
  },
  async onBackButton(handler) {
    const { onBackButtonPress } = await import("@tauri-apps/api/app");
    const listener = await onBackButtonPress(() => handler()).catch((error: unknown) => {
      throw asError(error);
    });
    return () => {
      listener.unregister().catch((error: unknown) => console.error("Cannot stop handling the Back button", error));
    };
  },
  async exitApp() {
    const { exit } = await import("@tauri-apps/api/app");
    try {
      await exit(0);
    } catch (error) {
      throw asError(error);
    }
  },
};

export async function loadBackend(): Promise<Backend> {
  if (isTauri()) {
    const info = await call<{ canOpenFolders: boolean; dropbox: boolean }>("app_info");
    const desktop = info.canOpenFolders;
    // A native context menu exists on desktops only, the same ones that can open folders.
    const popupTextMenu = desktop ? appBackend.popupTextMenu : undefined;
    // Phones have no window to close: the system closes apps.
    const closeWindow = desktop ? appBackend.closeWindow : undefined;
    const setWindowTheme = desktop ? appBackend.setWindowTheme : undefined;
    // Phones have a Back button instead, which closes the app from its main screen.
    const onBackButton = desktop ? undefined : appBackend.onBackButton;
    const exitApp = desktop ? undefined : appBackend.exitApp;
    const dropbox = info.dropbox ? dropboxBackend : undefined;
    return { ...appBackend, canOpenFolders: desktop, dropbox, popupTextMenu, closeWindow, setWindowTheme, onBackButton, exitApp };
  }
  const { browserBackend } = await import("./browserBackend");
  return browserBackend;
}
