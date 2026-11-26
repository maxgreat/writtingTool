// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, DropboxBackend, SyncResult } from "../backend";
import type { ProjectSnapshot } from "../project";
import type { SyncOutcome } from "../syncApply";
import { AUTOSAVE_DELAY_MS, SAVE_TRIES, SYNC_AGAIN_MS, SYNC_INTERVAL_MS, useProject } from "../useProject";

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

function Probe({ autoSync }: { autoSync: boolean }) {
  api = useProject({ autoSync });
  return null;
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(autoSync = true) {
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { autoSync })));
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

/** Turns automatic syncs on or off, as the setting does. */
async function setAutoSync(autoSync: boolean) {
  await act(async () => root.render(createElement(Probe, { autoSync })));
  await settle();
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

describe("useProject with automatic syncs off", () => {
  it("syncs only when asked: not on opening, on a timer, on coming back or on the first edit", async () => {
    await mount(false);
    expect(sync).not.toHaveBeenCalled();
    await settle(SYNC_INTERVAL_MS * 2);
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows!\n"));
    await settle(AUTOSAVE_DELAY_MS);
    expect(sync).not.toHaveBeenCalled();
    expect(api.sync).toEqual({ status: "off" });
  });

  it("saves to Dropbox when asked, then says when edits made since aren't there", async () => {
    await mount(false);
    await act(async () => api.saveToDropbox());
    expect(sync).toHaveBeenCalledWith(ROOT);
    expect(putProject).not.toHaveBeenCalled();
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });

    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows!\n"));
    expect(api.sync).toMatchObject({ status: "synced", unsent: true });

    await act(async () => api.saveToDropbox());
    expect(writeFile).toHaveBeenCalledWith(ROOT, ONE, "# One\n\nElena waits.\n\nArno rows!\n");
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });
  });

  it("doesn't count what a sync puts in the open editor as an edit made here", async () => {
    await mount(false);
    const theirs = "# One\n\nElena waits at the inn.\n\nArno rows.\n";
    sync.mockImplementationOnce(async () => {
      disk = snapshotWith(theirs);
      return { state: "done", outcome: outcome({ changed: [{ path: ONE, before: ORIGINAL, after: theirs }] }) };
    });
    await act(async () => api.saveToDropbox());
    await settle(AUTOSAVE_DELAY_MS);
    expect(written).toEqual([theirs]);
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });
  });

  it("puts a project on this device only in Dropbox, showing Syncing… meanwhile", async () => {
    sync.mockResolvedValue({ state: "off" });
    await mount(false);
    const putting = deferred<SyncOutcome>();
    putProject.mockReturnValueOnce(putting.promise);
    let saved: Promise<void> | undefined;
    act(() => {
      saved = api.saveToDropbox();
    });
    await settle();
    expect(putProject).toHaveBeenCalledWith(ROOT);
    expect(api.sync).toMatchObject({ status: "syncing", at: null });
    await act(async () => {
      putting.resolve(outcome());
      await saved;
    });
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });
  });

  it("finishes a save Dropbox changed under at once, and never syncs again unasked", async () => {
    await mount(false);
    sync.mockResolvedValueOnce({ state: "done", outcome: outcome({ again: true }) });
    await act(async () => api.saveToDropbox());
    expect(sync).toHaveBeenCalledTimes(2);
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });
    await settle(SYNC_AGAIN_MS * 2);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("says the edits aren't all in Dropbox when it keeps changing under the save", async () => {
    await mount(false);
    sync.mockResolvedValue({ state: "done", outcome: outcome({ again: true }) });
    await act(async () => api.saveToDropbox());
    expect(sync).toHaveBeenCalledTimes(SAVE_TRIES);
    expect(api.sync).toMatchObject({ status: "synced", unsent: true });
    await settle(SYNC_AGAIN_MS * 2);
    expect(sync).toHaveBeenCalledTimes(SAVE_TRIES);
  });

  it("says why it couldn't save to Dropbox", async () => {
    await mount(false);
    sync.mockRejectedValueOnce(new Error("Dropbox could not be reached."));
    let failure: unknown = null;
    await act(async () => {
      await api.saveToDropbox().catch((error: unknown) => {
        failure = error;
      });
    });
    expect((failure as Error | null)?.message).toBe("Dropbox could not be reached.");
    expect(api.sync).toMatchObject({ status: "error", message: "Dropbox could not be reached." });
  });

  it("syncs at once when turned on, and says edits since the last sync wait when turned off", async () => {
    await mount(false);
    await setAutoSync(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });

    // The first edit in the chapter is checked with Dropbox, and goes with that sync; the second waits for the next.
    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows!\n"));
    await settle();
    act(() => api.updateChapter(ONE, "# One\n\nElena waits.\n\nArno rows!!\n"));
    expect(api.sync).toMatchObject({ status: "synced", unsent: false });
    await setAutoSync(false);
    expect(api.sync).toMatchObject({ status: "synced", unsent: true });
  });
});
