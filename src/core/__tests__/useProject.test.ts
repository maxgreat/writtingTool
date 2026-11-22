// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend";
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

const writeFile = vi.fn<(root: string, path: string, text: string) => Promise<void>>();
const pickProjectFolder = vi.fn<() => Promise<string | null>>();
const openProject = vi.fn<(path: string) => Promise<ProjectSnapshot>>();

// Mutable, so a test can pose as the desktop app or make opening fail.
const fake: { -readonly [K in keyof Backend]: Backend[K] } = {
  kind: "browser",
  canOpenFolders: true,
  openSampleProject: async () => snapshot,
  openProject,
  pickProjectFolder,
  writeFile,
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
  writeFile.mockReset().mockResolvedValue(undefined);
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
