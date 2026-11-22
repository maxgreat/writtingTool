import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "./project";

/**
 * Everything the interface asks of the core. In the app this goes to Rust
 * over Tauri's IPC; in a plain browser (`npm run dev`) an in-memory copy of
 * the sample project stands in, so the interface can be worked on without
 * building the Rust side.
 */
export interface Backend {
  readonly kind: "app" | "browser";
  /** Whether `pickProjectFolder` can show a folder picker. */
  readonly canOpenFolders: boolean;
  openSampleProject(): Promise<ProjectSnapshot>;
  /** Opens a project folder by path (the one used last time, or one picked). */
  openProject(path: string): Promise<ProjectSnapshot>;
  /** Shows a folder picker; the chosen folder's path, or null if cancelled. Opens nothing. */
  pickProjectFolder(): Promise<string | null>;
  /**
   * Replaces one file of the open project. `root` is the root of the project
   * the text belongs to (from its snapshot); the save is refused if that
   * project is no longer the open one.
   */
  writeFile(root: string, path: string, text: string): Promise<void>;
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

const appBackend: Backend = {
  kind: "app",
  canOpenFolders: true,
  openSampleProject: () => call<ProjectSnapshot>("open_sample_project"),
  openProject: (path) => call<ProjectSnapshot>("open_project", { path }),
  async pickProjectFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, multiple: false, title: "Open a project folder" });
    return typeof path === "string" ? path : null;
  },
  writeFile: (root, path, text) => call<void>("write_project_file", { root, path, text }),
  async onCloseRequested(handler) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    });
  },
};

export async function loadBackend(): Promise<Backend> {
  if (isTauri()) return appBackend;
  const { browserBackend } = await import("./browserBackend");
  return browserBackend;
}
