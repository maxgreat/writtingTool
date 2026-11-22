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
   * Runs before the window closes, so pending saves can finish. The window
   * stays open if the handler resolves to false. Resolves to an unsubscribe.
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
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
  listProjects: (recent) => call<ProjectEntry[]>("list_projects", { recent }),
  createProject: ({ name, folders, files }) => call<ProjectSnapshot>("create_project", { name, folders, files }),
  applyChanges: (root, change) => call<ProjectSnapshot>("apply_changes", { root, change }),
  writeFile: (root, path, text) => call<string | null>("write_project_file", { root, path, text }),
  listVersions: (root, chapter) => call<Version[]>("list_versions", { root, chapter }),
  restoreVersion: (root, chapter, savedAt) => call<string>("restore_version", { root, chapter, savedAt }),
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
    return { ...appBackend, canOpenFolders: info.canOpenFolders };
  }
  const { browserBackend } = await import("./browserBackend");
  return browserBackend;
}
