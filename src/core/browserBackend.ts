import type { Backend, Version } from "./backend";
import { applyChange, type MemoryTree } from "./memoryFiles";
import { buildProject, type ProjectSnapshot } from "./project";

/**
 * Stand-in for the Rust core when the interface runs in a plain browser. It
 * serves the bundled sample project from memory; edits last until the page
 * reloads and never reach the disk.
 */
const PREFIX = "../../sample-project/MyNovel/";

const sources = import.meta.glob<string>("../../sample-project/MyNovel/**/*.{md,json}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const tree: MemoryTree = { files: new Map(), folders: new Set() };
for (const [key, text] of Object.entries(sources)) {
  const path = key.slice(PREFIX.length);
  tree.files.set(path, text);
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    tree.folders.add(path.slice(0, slash));
  }
}

const ROOT = "(browser preview)";

const inBinder = (path: string) => ["manuscript", "trash"].some((top) => path === top || path.startsWith(`${top}/`));

/** The same rules as the Rust core: keep 20 versions, at most one per ten minutes of editing. */
const VERSIONS_KEPT = 20;
const VERSION_INTERVAL_MS = 10 * 60 * 1000;
/** Versions of each chapter, oldest first. */
let versions = new Map<string, Version[]>();

function keepVersion(chapter: string, text: string, force: boolean): void {
  const kept = versions.get(chapter) ?? [];
  const newest = kept.at(-1);
  const now = Date.now();
  if (newest && ((!force && now - newest.savedAt < VERSION_INTERVAL_MS) || newest.text === text)) return;
  kept.push({ savedAt: newest ? Math.max(now, newest.savedAt + 1) : now, text });
  versions.set(chapter, kept.slice(-VERSIONS_KEPT));
}

function checkRoot(root: string): void {
  if (root !== ROOT) throw new Error("That project is no longer open.");
}

function checkChapter(root: string, chapter: string): string {
  checkRoot(root);
  const text = tree.files.get(chapter);
  if (!chapter.startsWith("manuscript/") || text === undefined) {
    throw new Error(`${chapter} is not a chapter of the sample project.`);
  }
  return text;
}

function snapshot(): ProjectSnapshot {
  return {
    root: ROOT,
    folderName: "MyNovel",
    projectJson: tree.files.get("project.json") ?? null,
    files: [...tree.files]
      .filter(([path]) => path.endsWith(".md") && (inBinder(path) || path.startsWith("sheets/")))
      .map(([path, text]) => ({ path, text })),
    folders: [...tree.folders].filter(inBinder).sort(),
    skipped: [],
  };
}

export const browserBackend: Backend = {
  kind: "browser",
  canOpenFolders: false,
  canCreateProjects: false,
  openSampleProject: async () => snapshot(),
  openProject: async () => {
    throw new Error("The browser preview can only open the sample project.");
  },
  pickProjectFolder: async () => null,
  async listProjects() {
    const { title } = buildProject(snapshot());
    return [{ path: ROOT, title, inAppFolder: true }];
  },
  createProject: async () => {
    throw new Error("The browser preview can only open the sample project.");
  },
  async writeFile(root, path, text) {
    checkRoot(root);
    const current = tree.files.get(path);
    if (current === undefined) throw new Error(`${path} is not part of the sample project.`);
    if (path.startsWith("manuscript/") && current !== text) keepVersion(path, current, false);
    tree.files.set(path, text);
    return null;
  },
  async applyChanges(root, change) {
    checkRoot(root);
    applyChange(tree, change);
    // Versions follow their chapter or part, as in the Rust core.
    const moved = new Map<string, Version[]>();
    for (const [path, kept] of versions) {
      const move = change.moves.find((m) => path === m.from || path.startsWith(`${m.from}/`));
      moved.set(move ? move.to + path.slice(move.from.length) : path, kept);
    }
    versions = moved;
    return snapshot();
  },
  async listVersions(root, chapter) {
    checkChapter(root, chapter);
    return [...(versions.get(chapter) ?? [])].reverse();
  },
  async restoreVersion(root, chapter, savedAt) {
    const current = checkChapter(root, chapter);
    const version = versions.get(chapter)?.find((v) => v.savedAt === savedAt);
    if (!version) throw new Error("That version is no longer kept.");
    keepVersion(chapter, current, true);
    tree.files.set(chapter, version.text);
    return version.text;
  },
  onCloseRequested: async () => () => undefined,
};
