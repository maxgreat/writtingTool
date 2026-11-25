// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, DropboxBackend, SyncResult } from "../backend";
import type { ProjectSnapshot } from "../project";
import type { SyncOutcome } from "../syncApply";
import { AUTOSAVE_DELAY_MS, SYNC_AGAIN_MS, SYNC_INTERVAL_MS, useProject } from "../useProject";

const ONE = "manuscript/01 One.md";
const TWO = "manuscript/02 Two.md";
const ROOT = "/projects/Test";

function snapshotWith(one: string, two = "# Two\n\nMore.\n", onePath = ONE): ProjectSnapshot {
  return {
    root: ROOT,
    folderName: "Test",
    projectJson: null,
    files: [
      { path: onePath, text: one },
      { path: TWO, text: two },
    ],
    skipped: [],
  };
}

const ORIGINAL = "# One\n\nElena waits.\n\nArno rows.\n";

function outcome(change: Partial<SyncOutcome> = {}): SyncOutcome {
  return { changed: [], moved: [], reshaped: false, conflicts: [], problems: [], again: false, ...change };
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let disk: ProjectSnapshot;
const writeFile = vi.fn<(root: string, path: string, text: string) => Promise<string | null>>();
const openProject = vi.fn<(path: string) => Promise<ProjectSnapshot>>();
const sync = vi.fn<(root: string) => Promise<SyncResult>>();
const putProject = vi.fn<(root: string) => Promise<SyncOutcome>>();
const merge = vi.fn<(path: string, base: string, ours: string, theirs: string) => Promise<{ text: string; conflicts: number }>>();

const dropbox: DropboxBackend = {
  status: async () => ({ account: null, tokenInFile: false }),
  signInStart: async () => ({ manual: false }),
  signInFinish: async () => ({ account: null, tokenInFile: false }),
  signInCancel: async () => undefined,
  signOut: async () => null,
  projects: async () => [],
  openProject: async () => disk,
  putProject,
  sync,
  merge,
};

const fake: Backend = {
  kind: "app",
  canOpenFolders: true,
  canCreateProjects: true,
  dropbox,
  listProjects: async () => [],
  createProject: async () => disk,
  openSampleProject: async () => disk,
  openProject,
  pickProjectFolder: async () => null,
  applyChanges: async () => disk,
  writeFile,
  listVersions: async () => [],
  restoreVersion: async () => "",
  onCloseRequested: async () => () => undefined,
};

vi.mock("../backend", () => ({ loadBackend: async () => fake }));

let api: ReturnType<typeof useProject>;
let root: Root;
/** What the open chapter's editor was given by sync, in order. */
let written: string[];

function Probe() {
  api = useProject();
  return null;
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount() {
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  await settle();
  written = [];
  act(() =>
    api.setEditorWriter((markdown) => {
      written.push(markdown);
      api.updateChapter(ONE, markdown);
      return true;
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  disk = snapshotWith(ORIGINAL);
  writeFile.mockReset().mockResolvedValue(null);
  openProject.mockReset().mockImplementation(async () => disk);
  sync.mockReset().mockResolvedValue({ state: "done", outcome: outcome() });
  putProject.mockReset().mockResolvedValue(outcome());
  merge.mockReset().mockImplementation(async (_path, _base, ours, theirs) => ({ text: `${ours}|${theirs}`, conflicts: 0 }));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useProject with Dropbox", () => {
  it("syncs when the project opens, and says so", async () => {
    await mount();
    expect(sync).toHaveBeenCalledWith(ROOT);
    expect(api.sync.status).toBe("synced");
  });

  it("shows nothing for a project on this device only, even while checking", async () => {
    sync.mockResolvedValue({ state: "off" });
    await mount();
    expect(api.sync).toEqual({ status: "off" });
    const checking = deferred<SyncResult>();
    sync.mockReturnValueOnce(checking.promise);
    await act(async () => void api.syncNow());
    expect(api.sync).toEqual({ status: "off" });
    await act(async () => checking.resolve({ state: "off" }));
  });

  it("puts what another device wrote in the open editor, without remounting it", async () => {
    await mount();
    const loads = api.loads;
    const theirs = "# One\n\nElena waits at the inn.\n\nArno rows.\n";
    sync.mockImplementationOnce(async () => {
      disk = snapshotWith(theirs);
      return { state: "done", outcome: outcome({ changed: [{ path: ONE, before: ORIGINAL, after: theirs }] }) };
    });
    await act(async () => void api.syncNow());
    await settle();
    expect(written).toEqual([theirs]);
    expect(api.project?.chapters[ONE].text).toBe(theirs);
    expect(api.loads).toBe(loads);
    expect(api.openChapterId).toBe(ONE);
    expect(merge).not.toHaveBeenCalled();
  });

  it("merges what is typed during a sync with what arrived, and saves meanwhile wait", async () => {
    await mount();
    const running = deferred<SyncResult>();
    sync.mockReturnValueOnce(running.promise);
    await act(async () => void api.syncNow());
    expect(api.sync.status).toBe("syncing");

    const ours = "# One\n\nElena waits.\n\nArno rows hard.\n";
    act(() => api.updateChapter(ONE, ours));
    await settle(AUTOSAVE_DELAY_MS * 3);
    expect(writeFile).not.toHaveBeenCalled();

    const theirs = "# One\n\nElena waits at the inn.\n\nArno rows.\n";
    disk = snapshotWith(theirs);
    await act(async () => running.resolve({ state: "done", outcome: outcome({ changed: [{ path: ONE, before: ORIGINAL, after: theirs }] }) }));
    await settle();
    expect(merge).toHaveBeenCalledWith(ONE, ORIGINAL, ours, theirs);
    expect(written).toEqual([`${ours}|${theirs}`]);
    expect(api.project?.chapters[ONE].text).toBe(`${ours}|${theirs}`);

    await settle(AUTOSAVE_DELAY_MS);
    expect(writeFile).toHaveBeenLastCalledWith(ROOT, ONE, `${ours}|${theirs}`);
  });

  it("reports clashes with what was typed during a sync, and keeps reporting until seen", async () => {
    await mount();
    const running = deferred<SyncResult>();
    sync.mockReturnValueOnce(running.promise);
    await act(async () => void api.syncNow());
    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows hard.\n"));
    merge.mockImplementationOnce(async (_path, _base, ours, theirs) => ({ text: `${ours}${theirs}`, conflicts: 1 }));
    const theirs = "# One\n\nElena waits.\n\nArno rows slowly.\n";
    disk = snapshotWith(theirs);
    await act(async () =>
      running.resolve({ state: "done", outcome: outcome({ changed: [{ path: ONE, before: ORIGINAL, after: theirs }], conflicts: [TWO] }) }),
    );
    await settle();
    expect(api.sync).toMatchObject({ status: "synced", conflicts: [TWO, ONE] });

    await act(async () => void api.syncNow());
    await settle();
    expect(api.sync).toMatchObject({ status: "synced", conflicts: [TWO, ONE] });
    act(() => api.dismissConflicts());
    expect(api.sync).toMatchObject({ status: "synced", conflicts: [] });
  });

  it("merges project.json as JSON when it was changed during a sync", async () => {
    await mount();
    const running = deferred<SyncResult>();
    sync.mockReturnValueOnce(running.promise);
    await act(async () => void api.syncNow());
    act(() => api.setLanguage("fr-FR"));
    const theirs = '{\n  "title": "Test",\n  "notNames": ["Harbor"]\n}\n';
    disk = { ...snapshotWith(ORIGINAL), projectJson: theirs };
    await act(async () =>
      running.resolve({ state: "done", outcome: outcome({ changed: [{ path: "project.json", before: null, after: theirs }] }) }),
    );
    await settle();
    expect(merge).toHaveBeenCalledWith("project.json", "", expect.stringContaining("fr-FR"), theirs);
  });

  it("follows the open chapter when another device moves it", async () => {
    await mount();
    const loads = api.loads;
    const moved = "manuscript/03 One.md";
    sync.mockImplementationOnce(async () => {
      disk = snapshotWith(ORIGINAL, undefined, moved);
      return { state: "done", outcome: outcome({ moved: [[ONE, moved]], reshaped: true }) };
    });
    await act(async () => void api.syncNow());
    await settle();
    expect(api.openChapterId).toBe(moved);
    expect(api.loads).toBe(loads + 1);
  });

  it("says why a sync failed, and tries again later", async () => {
    await mount();
    sync.mockRejectedValueOnce(new Error("Dropbox could not be reached."));
    await act(async () => void api.syncNow());
    await settle();
    expect(api.sync).toMatchObject({ status: "error", message: "Dropbox could not be reached." });
    await settle(SYNC_INTERVAL_MS);
    expect(api.sync.status).toBe("synced");
  });

  it("checks for changes on the first edit in a chapter", async () => {
    await mount();
    sync.mockClear();
    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows!\n"));
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows!!\n"));
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("syncs again soon after meeting a change made meanwhile", async () => {
    await mount();
    sync.mockClear();
    sync.mockResolvedValueOnce({ state: "done", outcome: outcome({ again: true }) });
    await act(async () => void api.syncNow());
    await settle(SYNC_AGAIN_MS);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("puts the project in Dropbox, and says why it couldn't", async () => {
    sync.mockResolvedValue({ state: "off" });
    await mount();
    await act(async () => api.putInDropbox());
    expect(putProject).toHaveBeenCalledWith(ROOT);
    expect(api.sync.status).toBe("synced");

    putProject.mockRejectedValueOnce(new Error("This project is already in Dropbox."));
    let failure: unknown = null;
    await act(async () => {
      await api.putInDropbox().catch((error: unknown) => {
        failure = error;
      });
    });
    expect((failure as Error | null)?.message).toBe("This project is already in Dropbox.");
  });
});
