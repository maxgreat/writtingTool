import type { Backend } from "./backend";
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
    if (root !== ROOT || !files.has(path)) throw new Error(`${path} is not part of the sample project.`);
    files.set(path, text);
  },
  onCloseRequested: async () => () => undefined,
};
