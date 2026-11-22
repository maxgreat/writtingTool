// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, Version } from "../backend";
import type { Change, Plan } from "../binder";
import type { ProjectSnapshot } from "../project";
import { AUTOSAVE_DELAY_MS, useProject } from "../useProject";

const CHAPTER = "manuscript/Part 1/01 One.md";

const snapshot: ProjectSnapshot = {
  root: "/projects/Test",
  folderName: "Test",
  projectJson: null,
  files: [
    { path: CHAPTER, text: "# One\n\nElena waits.\n" },
    { path: "manuscript/Part 1/02 Two.md", text: "# Two\n\nMore.\n" },
    { path: "sheets/characters/Elena.md", text: "---\nname: Elena\n---\n" },
  ],
  skipped: [],
};

const writeFile = vi.fn<(root: string, path: string, text: string) => Promise<string | null>>();
const applyChanges = vi.fn<(root: string, change: Change) => Promise<ProjectSnapshot>>();
const listVersions = vi.fn<(root: string, chapter: string) => Promise<Version[]>>();
const restoreVersion = vi.fn<(root: string, chapter: string, savedAt: number) => Promise<string>>();
const pickProjectFolder = vi.fn<() => Promise<string | null>>();
const openProject = vi.fn<(path: string) => Promise<ProjectSnapshot>>();

// Mutable, so a test can pose as the desktop app or make opening fail.
const fake: { -readonly [K in keyof Backend]: Backend[K] } = {
  kind: "browser",
  canOpenFolders: true,
  openSampleProject: async () => snapshot,
  openProject,
  pickProjectFolder,
  applyChanges,
  writeFile,
  listVersions,
  restoreVersion,
  onCloseRequested: async () => () => undefined,
};

vi.mock("../backend", () => ({ loadBackend: async () => fake }));

type Api = ReturnType<typeof useProject>;
let api: Api;
let root: Root;
let container: HTMLElement;

function Probe() {
  api = useProject();
  return null;
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  localStorage.clear();
  writeFile.mockReset().mockResolvedValue(null);
  listVersions.mockReset().mockResolvedValue([]);
  applyChanges.mockReset().mockResolvedValue(snapshot);
  restoreVersion.mockReset().mockResolvedValue("# One\n\nAn older text.\n");
  pickProjectFolder.mockReset().mockResolvedValue(null);
  openProject.mockReset().mockResolvedValue(snapshot);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("useProject", () => {
  it("opens the project and its first chapter", () => {
    expect(api.load.status).toBe("ready");
    expect(api.openChapterId).toBe(CHAPTER);
    expect(api.bookWords).toBe(3);
    expect(api.matcher.size).toBe(1);
  });

  it("saves once, about a second after typing stops, with the latest text", async () => {
    act(() => api.updateChapter(CHAPTER, "# One\n\nElena waits here."));
    await settle(AUTOSAVE_DELAY_MS / 2);
    act(() => api.updateChapter(CHAPTER, "# One\n\nElena waits here now."));
    expect(api.save.status).toBe("pending");
    expect(api.project?.chapters[CHAPTER].wordCount).toBe(4);

    await settle(AUTOSAVE_DELAY_MS - 1);
    expect(writeFile).not.toHaveBeenCalled();
    await settle(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith("/projects/Test", CHAPTER, "# One\n\nElena waits here now.\n");
    expect(api.save.status).toBe("saved");
  });

  it("does not write when the text did not change", async () => {
    act(() => api.updateChapter(CHAPTER, "# One\n\nElena waits."));
    await settle(AUTOSAVE_DELAY_MS * 2);
    expect(writeFile).not.toHaveBeenCalled();
    expect(api.save.status).toBe("saved");
  });

  it("keeps a failed save and retries it", async () => {
    writeFile.mockRejectedValueOnce(new Error("Disk full"));
    act(() => api.updateChapter(CHAPTER, "Changed."));
    await settle(AUTOSAVE_DELAY_MS);
    expect(api.save).toEqual({ status: "error", message: "Disk full" });

    await act(() => api.saveNow());
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenLastCalledWith("/projects/Test", CHAPTER, "Changed.\n");
    expect(api.save.status).toBe("saved");
  });

  it("saves pending changes at once when another chapter opens", async () => {
    act(() => api.updateChapter(CHAPTER, "Changed."));
    act(() => api.openChapter("manuscript/Part 1/02 Two.md"));
    await settle();
    expect(writeFile).toHaveBeenCalledWith("/projects/Test", CHAPTER, "Changed.\n");
    expect(api.openChapterId).toBe("manuscript/Part 1/02 Two.md");
  });

  it("refuses to open another project while changes are unsaved", async () => {
    writeFile.mockRejectedValue(new Error("Disk full"));
    pickProjectFolder.mockResolvedValue("/projects/Other");
    act(() => api.updateChapter(CHAPTER, "Changed."));
    let error: unknown = null;
    await act(async () => {
      await api.openFolder().catch((e: unknown) => {
        error = e;
      });
    });
    expect(error).toBeInstanceOf(Error);
    expect(openProject).not.toHaveBeenCalled();
    expect(api.switching).toBe(false);
    expect(api.project?.chapters[CHAPTER].text).toBe("Changed.\n");
  });
});

describe("opening another project", () => {
  const other: ProjectSnapshot = {
    ...snapshot,
    root: "/projects/Other",
    folderName: "Other",
    files: [{ path: CHAPTER, text: "# Other\n\nSomeone else's chapter.\n" }],
  };

  it("saves edits to the current project before the core opens the new one", async () => {
    pickProjectFolder.mockResolvedValue("/projects/Other");
    openProject.mockImplementation(async () => {
      expect(writeFile).toHaveBeenCalledWith("/projects/Test", CHAPTER, "Changed.\n");
      return other;
    });
    act(() => api.updateChapter(CHAPTER, "Changed."));
    const loadsBefore = api.loads;
    await act(() => api.openFolder());
    expect(openProject).toHaveBeenCalledWith("/projects/Other");
    expect(api.project?.root).toBe("/projects/Other");
    expect(api.loads).toBe(loadsBefore + 1);
  });

  it("counts reading the same folder again as a new load", async () => {
    pickProjectFolder.mockResolvedValue("/projects/Test");
    const loadsBefore = api.loads;
    await act(() => api.openFolder());
    expect(api.project?.root).toBe("/projects/Test");
    expect(api.loads).toBe(loadsBefore + 1);
  });

  it("refuses edits while the new project opens, and writes nothing for them", async () => {
    let finishOpening: (value: ProjectSnapshot) => void = () => undefined;
    pickProjectFolder.mockResolvedValue("/projects/Other");
    openProject.mockImplementation(() => new Promise((resolve) => (finishOpening = resolve)));
    let opening: Promise<void> = Promise.resolve();
    await act(async () => {
      opening = api.openFolder();
      await Promise.resolve();
    });
    await settle();
    expect(api.switching).toBe(true);

    act(() => api.updateChapter(CHAPTER, "Typed while opening."));
    expect(api.project?.chapters[CHAPTER].text).toBe("# One\n\nElena waits.\n");
    await settle(AUTOSAVE_DELAY_MS * 2);

    await act(async () => {
      finishOpening(other);
      await opening;
    });
    await settle(AUTOSAVE_DELAY_MS * 2);
    expect(writeFile).not.toHaveBeenCalled();
    expect(api.switching).toBe(false);
    expect(api.project?.root).toBe("/projects/Other");
  });
});

describe("versions", () => {
  it("says so when a save worked but the previous version could not be kept", async () => {
    writeFile.mockResolvedValueOnce("Saved, but the previous version could not be kept: Permission denied");
    act(() => api.updateChapter(CHAPTER, "Changed."));
    await settle(AUTOSAVE_DELAY_MS);
    expect(api.save).toEqual({
      status: "saved",
      warning: "Saved, but the previous version could not be kept: Permission denied",
    });

    act(() => api.updateChapter(CHAPTER, "Changed again."));
    await settle(AUTOSAVE_DELAY_MS);
    expect(api.save).toEqual({ status: "saved" });
  });

  it("lists the versions of a chapter of the open project", async () => {
    listVersions.mockResolvedValue([{ savedAt: 5, text: "# One\n" }]);
    await expect(api.listVersions(CHAPTER)).resolves.toEqual([{ savedAt: 5, text: "# One\n" }]);
    expect(listVersions).toHaveBeenCalledWith("/projects/Test", CHAPTER);
  });

  it("saves pending edits first, then restores and remounts the editors", async () => {
    const loads = api.loads;
    act(() => api.updateChapter(CHAPTER, "Typed just now."));
    await act(() => api.restoreVersion(CHAPTER, 5));
    expect(writeFile).toHaveBeenCalledWith("/projects/Test", CHAPTER, "Typed just now.\n");
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(restoreVersion.mock.invocationCallOrder[0]);
    expect(restoreVersion).toHaveBeenCalledWith("/projects/Test", CHAPTER, 5);
    expect(api.project?.chapters[CHAPTER].text).toBe("# One\n\nAn older text.\n");
    expect(api.project?.chapters[CHAPTER].wordCount).toBe(3);
    expect(api.loads).toBe(loads + 1);
    expect(api.switching).toBe(false);

    await settle(AUTOSAVE_DELAY_MS * 2);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(api.save.status).toBe("saved");
  });

  it("refuses edits while a version is restored", async () => {
    let finish: (text: string) => void = () => undefined;
    restoreVersion.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    let restoring: Promise<void> = Promise.resolve();
    act(() => {
      restoring = api.restoreVersion(CHAPTER, 5);
    });
    await settle();
    expect(api.switching).toBe(true);
    act(() => api.updateChapter(CHAPTER, "Typed while restoring."));
    expect(api.project?.chapters[CHAPTER].text).toBe("# One\n\nElena waits.\n");

    await act(async () => {
      finish("# One\n\nRestored.\n");
      await restoring;
    });
    expect(api.project?.chapters[CHAPTER].text).toBe("# One\n\nRestored.\n");
    await settle(AUTOSAVE_DELAY_MS * 2);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("does not restore over changes that could not be saved", async () => {
    writeFile.mockRejectedValue(new Error("Disk full"));
    act(() => api.updateChapter(CHAPTER, "Changed."));
    let error: unknown = null;
    await act(async () => {
      await api.restoreVersion(CHAPTER, 5).catch((reason: unknown) => {
        error = reason;
      });
    });
    expect(String(error)).toContain("could not be saved");
    expect(restoreVersion).not.toHaveBeenCalled();
    expect(api.project?.chapters[CHAPTER].text).toBe("Changed.\n");
    expect(api.switching).toBe(false);
  });
});

describe("chapter details and the binder", () => {
  const MOVED = "manuscript/Part 2/03 One.md";
  const moved: ProjectSnapshot = {
    ...snapshot,
    files: snapshot.files.map((f) => (f.path === CHAPTER ? { ...f, path: MOVED } : f)),
  };
  const change: Change = { folders: [], moves: [{ from: CHAPTER, to: MOVED }], writes: [] };
  const plan = (changes: Change[]): Plan => ({ changes, renamed: new Map([[CHAPTER, MOVED]]), created: null });

  it("saves chapter details in project.json, like an edit", async () => {
    act(() => api.updateChapterDetails(CHAPTER, { status: "Draft", synopsis: "Elena waits." }));
    expect(api.project?.chapters[CHAPTER]).toMatchObject({ status: "Draft", synopsis: "Elena waits." });
    expect(api.save.status).toBe("pending");
    await settle(AUTOSAVE_DELAY_MS);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, path, text] = writeFile.mock.calls[0];
    expect(path).toBe("project.json");
    expect(JSON.parse(text)).toEqual({ chapters: { [CHAPTER]: { status: "Draft", synopsis: "Elena waits." } } });
  });

  it("saves first, makes each step, and keeps the open chapter through a rename", async () => {
    const loads = api.loads;
    act(() => api.updateChapter(CHAPTER, "Typed."));
    applyChanges.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(moved);
    await act(() => api.changeBinder(() => plan([{ folders: [], moves: [], writes: [] }, change])));
    expect(writeFile).toHaveBeenCalledWith("/projects/Test", CHAPTER, "Typed.\n");
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(applyChanges.mock.invocationCallOrder[0]);
    expect(applyChanges).toHaveBeenCalledTimes(2);
    expect(applyChanges).toHaveBeenLastCalledWith("/projects/Test", change);
    expect(api.openChapterId).toBe(MOVED);
    expect(api.project?.chapters[MOVED]).toBeDefined();
    expect(api.loads).toBe(loads + 1);
    expect(api.switching).toBe(false);
  });

  it("plans on the saved project and does nothing for an empty plan", async () => {
    act(() => api.updateChapter(CHAPTER, "Typed."));
    let seen = "";
    await act(() =>
      api.changeBinder((project) => {
        seen = project.chapters[CHAPTER].text;
        return null;
      }),
    );
    expect(seen).toBe("Typed.\n");
    expect(applyChanges).not.toHaveBeenCalled();
  });

  it("shows the steps that were made when a later one fails", async () => {
    applyChanges.mockResolvedValueOnce(moved).mockRejectedValueOnce(new Error("Cannot change the binder: disk full."));
    let error: unknown = null;
    await act(async () => {
      await api.changeBinder(() => plan([change, change])).catch((reason: unknown) => {
        error = reason;
      });
    });
    expect(String(error)).toContain("disk full");
    expect(api.project?.chapters[MOVED]).toBeDefined();
    expect(api.switching).toBe(false);
  });

  it("keeps the open chapter where it is when a later step fails", async () => {
    applyChanges.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("Cannot change the binder: disk full."));
    await act(async () => {
      await api.changeBinder(() => plan([{ folders: [], moves: [], writes: [] }, change])).catch(() => undefined);
    });
    expect(api.openChapterId).toBe(CHAPTER);
  });

  it("does not change the binder over changes that could not be saved", async () => {
    writeFile.mockRejectedValue(new Error("Disk full"));
    act(() => api.updateChapter(CHAPTER, "Changed."));
    let error: unknown = null;
    await act(async () => {
      await api.changeBinder(() => plan([change])).catch((reason: unknown) => {
        error = reason;
      });
    });
    expect(String(error)).toContain("could not be saved");
    expect(applyChanges).not.toHaveBeenCalled();
  });
});

describe("reopening the last project", () => {
  it("falls back to the sample, says why, and keeps the remembered project", async () => {
    act(() => root.unmount());
    localStorage.setItem("writingTool.lastProject", "/media/usb/Novel");
    const original = { kind: fake.kind, openProject: fake.openProject };
    fake.kind = "app";
    fake.openProject = async () => {
      throw new Error("Cannot open /media/usb/Novel: No such file or directory");
    };
    try {
      root = createRoot(container);
      await act(async () => root.render(createElement(Probe)));
      await settle();
      expect(api.project?.root).toBe(snapshot.root);
      expect(api.project?.problems[0]).toContain("No such file or directory");
      expect(localStorage.getItem("writingTool.lastProject")).toBe("/media/usb/Novel");
    } finally {
      Object.assign(fake, original);
    }
  });
});
