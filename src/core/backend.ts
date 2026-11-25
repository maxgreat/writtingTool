import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Change } from "./binder";
import type { ProjectSnapshot } from "./project";
import type { NewProject, ProjectEntry } from "./projects";

/** An earlier version of a chapter, kept on this device. */
export interface Version {
  /** When it was kept, in milliseconds since 1970. Also names the version. */
  savedAt: number;
  text: string;
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
   * Desktop app only: shows the text's context menu, native, at a point in
   * the window (client coordinates): `items` first, then Cut, Copy, Paste
   * and Select All, which the system carries out on the text. Absent on
   * phones and in the browser preview, where the page shows its own menu.
   */
  popupTextMenu?(items: TextMenuItem[], x: number, y: number): Promise<void>;
  /**
   * Desktop app only: closes the window as its own close button does, so
   * `onCloseRequested` runs first and pending saves finish. Absent on phones
   * and in the browser preview, which have no window to close.
   */
  closeWindow?(): Promise<void>;
  /**
   * Runs before the window closes, so pending saves can finish. The window
   * stays open if the handler resolves to false. Resolves to an unsubscribe.
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
}

/** An item of the app's own entries in the text's context menu. */
export interface TextMenuItem {
  text: string;
  enabled?: boolean;
  action(): void;
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

async function showTextMenu(items: TextMenuItem[], x: number, y: number): Promise<void> {
  const { Menu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const { LogicalPosition } = await import("@tauri-apps/api/dpi");
  const previous = shownTextMenu;
  shownTextMenu = [];
  await Promise.allSettled(previous.map((resource) => resource.close()));
  const own = await Promise.all(
    items.map((item) => MenuItem.new({ text: item.text, enabled: item.enabled ?? true, action: () => item.action() })),
  );
  const separator = own.length > 0 ? [await PredefinedMenuItem.new({ item: "Separator" })] : [];
  const edit = await Promise.all(
    (["Cut", "Copy", "Paste", "Separator", "SelectAll"] as const).map((item) => PredefinedMenuItem.new({ item })),
  );
  const menu = await Menu.new({ items: [...own, ...separator, ...edit] });
  shownTextMenu = [menu, ...own, ...separator, ...edit];
  await menu.popup(new LogicalPosition(x, y));
}

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
  async onCloseRequested(handler) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    });
  },
};

export async function loadBackend(): Promise<Backend> {
  if (isTauri()) {
    const info = await call<{ canOpenFolders: boolean }>("app_info");
    // A native context menu exists on desktops only, the same ones that can open folders.
    const popupTextMenu = info.canOpenFolders ? appBackend.popupTextMenu : undefined;
    // Phones have no window to close: the system closes apps.
    const closeWindow = info.canOpenFolders ? appBackend.closeWindow : undefined;
    return { ...appBackend, canOpenFolders: info.canOpenFolders, popupTextMenu, closeWindow };
  }
  const { browserBackend } = await import("./browserBackend");
  return browserBackend;
}
