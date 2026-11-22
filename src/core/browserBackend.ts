import type { Backend, Version } from "./backend";
import type { ProjectSnapshot } from "./project";

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

const files = new Map<string, string>();
for (const [key, text] of Object.entries(sources)) files.set(key.slice(PREFIX.length), text);

const ROOT = "(browser preview)";

/** The same rules as the Rust core: keep 20 versions, at most one per ten minutes of editing. */
const VERSIONS_KEPT = 20;
const VERSION_INTERVAL_MS = 10 * 60 * 1000;
/** Versions of each chapter, oldest first. */
const versions = new Map<string, Version[]>();

function keepVersion(chapter: string, text: string, force: boolean): void {
  const kept = versions.get(chapter) ?? [];
  const newest = kept.at(-1);
  const now = Date.now();
  if (newest && ((!force && now - newest.savedAt < VERSION_INTERVAL_MS) || newest.text === text)) return;
  kept.push({ savedAt: newest ? Math.max(now, newest.savedAt + 1) : now, text });
  versions.set(chapter, kept.slice(-VERSIONS_KEPT));
}

function checkChapter(root: string, chapter: string): string {
  const text = files.get(chapter);
  if (root !== ROOT || !chapter.startsWith("manuscript/") || text === undefined) {
    throw new Error(`${chapter} is not a chapter of the sample project.`);
  }
  return text;
}

function snapshot(): ProjectSnapshot {
  return {
    root: ROOT,
    folderName: "MyNovel",
    projectJson: files.get("project.json") ?? null,
    files: [...files]
      .filter(([path]) => path.startsWith("manuscript/") || path.startsWith("sheets/"))
      .map(([path, text]) => ({ path, text })),
    skipped: [],
  };
}

export const browserBackend: Backend = {
  kind: "browser",
  canOpenFolders: false,
  openSampleProject: async () => snapshot(),
  openProject: async () => {
    throw new Error("The browser preview can only open the sample project.");
  },
  pickProjectFolder: async () => null,
  async writeFile(root, path, text) {
    const current = files.get(path);
    if (root !== ROOT || current === undefined) throw new Error(`${path} is not part of the sample project.`);
    if (path.startsWith("manuscript/") && current !== text) keepVersion(path, current, false);
    files.set(path, text);
    return null;
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
    files.set(chapter, version.text);
    return version.text;
  },
  onCloseRequested: async () => () => undefined,
};
