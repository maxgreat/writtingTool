import type { ProjectSnapshot } from "./project";

/** What a sync changed on this device (the core's Outcome). */
export interface SyncOutcome {
  /** Files whose text changed on this device, before and after; null when there was, or is, no file. */
  changed: { path: string; before: string | null; after: string | null }[];
  /** Files another device moved, from and to. */
  moved: [string, string][];
  /** Files or folders came, went or moved: the binder must be read again. */
  reshaped: boolean;
  /** Files changed in the same places on two devices: both versions are in the text. */
  conflicts: string[];
  /** Things that could not be synced, as sentences for the writer. */
  problems: string[];
  /** Something changed in Dropbox while the sync ran: sync again soon. */
  again: boolean;
}

/** Whether a sync changed anything the project as shown is made from. */
export function changedAnything(outcome: SyncOutcome): boolean {
  return outcome.changed.length > 0 || outcome.moved.length > 0 || outcome.reshaped;
}

/** Where a file is after a sync's moves (a part's move takes its chapters along). */
export function followMoves(path: string, moved: readonly [string, string][]): string {
  for (const [from, to] of moved) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  }
  return path;
}

/**
 * The project as read from disk, with the edits not saved yet laid over it:
 * project.json, dictionary.txt, chapters and sheets.
 */
export function withUnsaved(snapshot: ProjectSnapshot, unsaved: ReadonlyMap<string, string>): ProjectSnapshot {
  if (unsaved.size === 0) return snapshot;
  const files = snapshot.files.map((file) => (unsaved.has(file.path) ? { ...file, text: unsaved.get(file.path)! } : file));
  for (const [path, text] of unsaved) {
    if (path !== "project.json" && path !== "dictionary.txt" && !files.some((f) => f.path === path)) {
      files.push({ path, text });
    }
  }
  return {
    ...snapshot,
    projectJson: unsaved.get("project.json") ?? snapshot.projectJson,
    dictionary: unsaved.get("dictionary.txt") ?? snapshot.dictionary,
    files,
  };
}
