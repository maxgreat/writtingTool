import type { Change } from "./binder";

/**
 * A project folder kept in memory: what the browser preview edits instead
 * of the disk, and what the tests apply plans to. Changes follow the same
 * rules as the Rust core's `apply_changes`.
 */
export interface MemoryTree {
  /** File paths relative to the project root, with their text. */
  files: Map<string, string>;
  /** Folder paths relative to the project root (not the root itself). */
  folders: Set<string>;
}

const MOVABLE = ["manuscript/", "trash/"];

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const isInside = (path: string, folder: string) => path.startsWith(`${folder}/`);

function exists(tree: MemoryTree, path: string): boolean {
  return tree.files.has(path) || tree.folders.has(path);
}

function folderExists(tree: MemoryTree, path: string): boolean {
  return path === "" || tree.folders.has(path);
}

/**
 * Applies one change: creates the folders (sheet folders only if missing),
 * makes every move at once, then writes the files. Throws, leaving the tree as it was, if any part of it
 * can't be done.
 */
export function applyChange(tree: MemoryTree, change: Change): void {
  const files = new Map(tree.files);
  const folders = new Set(tree.folders);
  const next: MemoryTree = { files, folders };

  for (const folder of change.folders) {
    const allowed = folder === "manuscript" || folder === "trash" || MOVABLE.some((p) => folder.startsWith(p));
    if (!allowed) throw new Error(`${folder}: not a folder the binder uses`);
    if (exists(next, folder)) throw new Error(`${folder} already exists`);
    if (!folderExists(next, parentOf(folder))) throw new Error(`${folder}: its parent folder is missing`);
    folders.add(folder);
  }

  for (const folder of change.sheetFolders ?? []) {
    const parts = folder.split("/");
    if (parts[0] !== "sheets" || parts.length > 2 || parts.some((p) => p === "" || p.startsWith("."))) {
      throw new Error(`${folder}: not sheets/ or a sheet type folder in it`);
    }
    if (files.has(folder)) throw new Error(`${folder} is not a folder`);
    if (!folderExists(next, parentOf(folder))) throw new Error(`${folder}: its parent folder is missing`);
    folders.add(folder);
  }

  const { moves } = change;
  for (const [i, a] of moves.entries()) {
    for (const path of [a.from, a.to]) {
      if (!MOVABLE.some((p) => path.startsWith(p))) throw new Error(`${path}: not inside manuscript/ or trash/`);
    }
    if (!exists(next, a.from)) throw new Error(`${a.from} does not exist`);
    for (const [j, b] of moves.entries()) {
      if (i === j) continue;
      if (a.from === b.from || a.to === b.to) throw new Error(`${a.from}: two moves share a path`);
      if ([a.from, a.to].some((p) => isInside(p, b.from) || isInside(p, b.to))) {
        throw new Error(`${a.from}: a moved path is inside another`);
      }
    }
  }
  // Take every moved file or folder out, then put each in its new place, so
  // a name another move frees can be reused.
  const taken = moves.map((m) => ({
    move: m,
    files: [...files].filter(([path]) => path === m.from || isInside(path, m.from)),
    folders: [...folders].filter((path) => path === m.from || isInside(path, m.from)),
  }));
  for (const t of taken) {
    for (const [path] of t.files) files.delete(path);
    for (const path of t.folders) folders.delete(path);
  }
  for (const { move, files: moved, folders: movedFolders } of taken) {
    if (exists(next, move.to)) throw new Error(`${move.to} already exists`);
    if (!folderExists(next, parentOf(move.to))) throw new Error(`${move.to}: its folder is missing`);
    for (const [path, text] of moved) files.set(move.to + path.slice(move.from.length), text);
    for (const path of movedFolders) folders.add(move.to + path.slice(move.from.length));
  }

  for (const write of change.writes) {
    if (!folderExists(next, parentOf(write.path))) throw new Error(`${write.path}: its folder is missing`);
    if (folders.has(write.path)) throw new Error(`${write.path} is a folder`);
    if (write.mustBeNew && files.has(write.path)) throw new Error(`${write.path} already exists`);
    files.set(write.path, write.text);
  }

  tree.files = files;
  tree.folders = folders;
}
