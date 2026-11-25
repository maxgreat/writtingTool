// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, DropboxBackend, DropboxProject } from "../../core/backend";
import { withFinalNewline } from "../../core/markdown";
import { buildNameMatcher, buildProject, withChapterText } from "../../core/project";
import type { ProjectEntry } from "../../core/projects";
import { DEFAULT_SETTINGS, type EditorMode, type ViewSettings } from "../../core/settings";
import type { SyncState, useProject } from "../../core/useProject";
import { Workspace } from "../Workspace";

const ARRIVAL = "manuscript/01 Arrival.md";
const ROOT = "/data/projects/Test";

const BOOK = buildProject({
  root: ROOT,
  folderName: "Test",
  projectJson: null,
  files: [{ path: ARRIVAL, text: "# Arrival\n\nElena waits.\n" }],
  skipped: [],
});

const CURRENT: ProjectEntry = { path: ROOT, title: "Test", inAppFolder: true, inDropbox: false };
const SALT: DropboxProject = { folder: "/Salt Roads", title: "Salt Roads", local: null };

const dropbox = {
  status: async () => ({ account: { accountId: "id", name: "Ada", email: "ada@example.com" }, tokenInFile: false }),
  signInCancel: async () => undefined,
} as unknown as DropboxBackend;

/** The desktop app, with Dropbox in this build unless left out. */
function app(withDropbox = true): Backend {
  return {
    kind: "app",
    canOpenFolders: true,
    canCreateProjects: true,
    listProjects: async () => [],
    listVersions: async () => [],
    onCloseRequested: async () => () => undefined,
    ...(withDropbox && { dropbox }),
  } as unknown as Backend;
}

// Stable, as useProject's are.
const listProjects = async () => [CURRENT];
const listVersions = async () => [];
const restoreVersion = async () => undefined;
const saveNow = async () => undefined;
const syncNow = vi.fn<() => Promise<void>>();
const putInDropbox = vi.fn<() => Promise<void>>();
const listDropboxProjects = vi.fn<() => Promise<DropboxProject[]>>();
const openFromDropbox = vi.fn<(folder: string) => Promise<void>>();
/** What the workspace hands useProject to write into the open chapter's editor; null once it takes it back. */
const setEditorWriter = vi.fn<(writer: ((markdown: string) => boolean) | null) => void>();
/** The writer has seen the files edited on two devices: as useProject's, the report then has none. */
const dismissConflicts = vi.fn<() => void>();
/** Sets the sync state useProject reports, as a sync ending would. */
let setSync: (sync: SyncState) => void = () => undefined;
const updateChapter = vi.fn<(id: string, markdown: string) => void>();
const update = vi.fn<(patch: Partial<ViewSettings>) => void>();

/** Stands for App and useProject: the project in state, changed as useProject changes it. */
function Harness({ backend, initialSync, mode }: { backend: Backend; initialSync: SyncState; mode: EditorMode }) {
  const [project, setProject] = useState(BOOK);
  const [sync, setSyncState] = useState(initialSync);
  setSync = setSyncState;
  const matcher = useMemo(() => buildNameMatcher(project.sheets), [project.sheets]);
  const api = {
    backend,
    load: { status: "ready" },
    project,
    matcher,
    openChapterId: ARRIVAL,
    openChapter: () => undefined,
    updateChapter: (id: string, markdown: string) => {
      updateChapter(id, markdown);
      setProject((p) => withChapterText(p, id, withFinalNewline(markdown)));
    },
    save: { status: "saved" },
    saveNow,
    hasUnsaved: () => false,
    listProjects,
    listVersions,
    restoreVersion,
    switching: false,
    bookWords: 0,
    wordsToday: 0,
    loads: 1,
    sync,
    syncNow,
    putInDropbox,
    listDropboxProjects,
    openFromDropbox,
    setEditorWriter,
    dismissConflicts: () => {
      dismissConflicts();
      setSyncState((state) => (state.status === "synced" ? { ...state, conflicts: [] } : state));
    },
  } as unknown as ReturnType<typeof useProject>;
  return createElement(Workspace, {
    api,
    project,
    backend,
    settings: { ...DEFAULT_SETTINGS, mode },
    update,
    isPhone: false,
  });
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-GB"] });
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  syncNow.mockReset().mockResolvedValue(undefined);
  putInDropbox.mockReset().mockResolvedValue(undefined);
  listDropboxProjects.mockReset().mockResolvedValue([SALT]);
  openFromDropbox.mockReset().mockResolvedValue(undefined);
  setEditorWriter.mockReset();
  dismissConflicts.mockReset();
  updateChapter.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Lets the editors settle: Tiptap reports "create" on the next tick, and takes focus a frame later. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

async function mount({
  backend = app(),
  sync = { status: "synced", at: Date.now(), conflicts: [], problems: [] } as SyncState,
  mode = "plain" as EditorMode,
} = {}) {
  await act(async () => root.render(createElement(Harness, { backend, initialSync: sync, mode })));
  await settle();
}

/** The writer the workspace handed over last. */
const writer = () => setEditorWriter.mock.calls.filter(([w]) => w !== null).at(-1)?.[0] ?? null;

describe("sync in the workspace", () => {
  it.each(["plain", "formatted"] as const)(
    "hands sync a writer for the open chapter's editor (%s), and takes it back when it goes",
    async (mode) => {
      await mount({ mode });
      const write = writer();
      expect(write).not.toBeNull();
      let taken = false;
      await act(async () => {
        taken = write!("# Arrival\n\nElena waits. Arno rows.\n");
      });
      expect(taken).toBe(true);
      // As an edit typed there: the editor hands the text to the project (useProject ends it with a newline).
      const [id, text] = updateChapter.mock.calls.at(-1)!;
      expect(id).toBe(ARRIVAL);
      expect(withFinalNewline(text)).toBe("# Arrival\n\nElena waits. Arno rows.\n");

      act(() => root.unmount());
      expect(setEditorWriter.mock.calls.at(-1)).toEqual([null]);
      root = createRoot(container);
    },
  );

  it("hands over no writer where the build has no Dropbox", async () => {
    await mount({ backend: app(false) });
    expect(setEditorWriter).not.toHaveBeenCalled();
  });

  it("shows the open project's sync in the status bar", async () => {
    await mount();
    expect(container.querySelector(".status-bar")?.textContent).toContain("Synced with Dropbox");
  });

  it("names the files edited on two devices by their chapter's title, and takes them away once seen", async () => {
    const warning = () => container.querySelector<HTMLButtonElement>(".status-bar button.status-problems");
    await mount({ sync: { status: "synced", at: Date.now(), conflicts: [ARRIVAL], problems: [] } });
    await act(async () => warning()!.click());
    expect(document.querySelector(".popover .problems-list li")?.textContent).toBe("Arrival");
    expect(dismissConflicts).not.toHaveBeenCalled();

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dismissConflicts).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".popover")).toBeNull();
    expect(warning()).toBeNull();
    expect(container.querySelector(".status-bar")?.textContent).toContain("Synced with Dropbox");
    // The warning went with focus on it: the caret goes back to the text.
    expect(document.activeElement).toBe(document.body);
    await settle();
    expect(document.activeElement?.closest(".cm-content")).not.toBeNull();

    // A later sync finds the chapter edited on two devices again: the warning comes back.
    await act(async () => setSync({ status: "synced", at: Date.now(), conflicts: [ARRIVAL], problems: [] }));
    expect(warning()?.textContent).toBe("1 file edited on two devices");
  });

  it("gives the Projects view what it needs to put the project in Dropbox and open those there", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>(".binder-title-button")!.click());
    const view = document.querySelector('[role="dialog"]');
    expect(view?.querySelector(".projects-cloud h3")?.textContent).toBe("In your Dropbox");
    expect(listDropboxProjects).toHaveBeenCalled();
    expect(view?.querySelector(".projects-list--cloud .project-title")?.textContent).toBe("Salt Roads");
    await act(async () => view!.querySelector<HTMLButtonElement>(".project-put")!.click());
    expect(putInDropbox).toHaveBeenCalledTimes(1);
  });
});
