// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act, createElement, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Backend } from "../../core/backend";
import { buildNameMatcher, buildProject, withChapterText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS, type ViewSettings } from "../../core/settings";
import type { useProject } from "../../core/useProject";
import { PLAIN_ONLY_NOTE_ID } from "../EditorPane";
import { Workspace } from "../Workspace";

const LISTS = "manuscript/01 Lists.md";
const SIMPLE = "manuscript/02 Simple.md";
const HEADING_LIST = "manuscript/03 Heading list.md";

const LISTS_TEXT = "Elena says:\n\n- Bonjour, dit-elle.\n- Bonsoir.\n";
const HEADING_LIST_TEXT = "# Lists\n\n- Bonjour, dit-elle.\n- Bonsoir.\n";

const initialProject = buildProject({
  root: "/test",
  folderName: "Test",
  projectJson: null,
  files: [
    { path: LISTS, text: LISTS_TEXT },
    { path: SIMPLE, text: "# Simple\n\nElena waits.\n" },
    { path: HEADING_LIST, text: HEADING_LIST_TEXT },
  ],
  skipped: [],
});

const backend: Backend = {
  kind: "browser",
  canOpenFolders: false,
  openSampleProject: async () => {
    throw new Error("unused");
  },
  openProject: async () => {
    throw new Error("unused");
  },
  pickProjectFolder: async () => null,
  applyChanges: async () => {
    throw new Error("unused");
  },
  writeFile: async () => null,
  listVersions: async () => [],
  restoreVersion: async () => {
    throw new Error("unused");
  },
  onCloseRequested: async () => () => undefined,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  const noRect = () => new DOMRect();
  Range.prototype.getBoundingClientRect = noRect;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

// Stable, as useProject's are: the inspector reads versions again when these change.
const listVersions = async () => [];
const restoreVersion = async () => undefined;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** Tiptap reports "create" on the next tick; the switch to Plain renders after it. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(firstChapter: string, mode: ViewSettings["mode"] = "formatted") {
  const settingsSeen: ViewSettings[] = [];
  const saved: [string, string][] = [];
  let project: Project = initialProject;
  let replaceProject: (next: Project) => void = () => undefined;
  let countLoad: () => void = () => undefined;

  function Harness() {
    const [openChapterId, setOpenChapterId] = useState<string | null>(firstChapter);
    const [current, setProject] = useState(initialProject);
    const [loads, setLoads] = useState(1);
    replaceProject = setProject;
    countLoad = () => setLoads((n) => n + 1);
    const [settings, setSettings] = useState<ViewSettings>({ ...DEFAULT_SETTINGS, mode });
    const matcher = useMemo(() => buildNameMatcher(current.sheets), [current.sheets]);
    project = current;
    const update = (patch: Partial<ViewSettings>) =>
      setSettings((s) => {
        const next = { ...s, ...patch };
        settingsSeen.push(next);
        return next;
      });
    const api = {
      backend,
      load: { status: "ready" },
      project: current,
      matcher,
      openChapterId,
      openChapter: setOpenChapterId,
      // Like useProject: an edit replaces the chapter text at once.
      updateChapter: (id: string, text: string) => {
        saved.push([id, text]);
        setProject((p) => withChapterText(p, id, text));
      },
      save: { status: "saved" },
      saveNow: async () => undefined,
      openFolder: async () => undefined,
      listVersions,
      restoreVersion,
      switching: false,
      bookWords: 0,
      wordsToday: 0,
      loads,
    } as unknown as ReturnType<typeof useProject>;
    return createElement(Workspace, { api, project: current, backend, settings, update, isPhone: false });
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  await settle();
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const modeOption = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!;
  const openChapter = async (title: string) => {
    const row = [...container.querySelectorAll<HTMLButtonElement>(".binder-row--chapter")].find((b) =>
      b.textContent?.startsWith(title),
    )!;
    await act(async () => row.click());
    await settle();
  };
  const note = () => container.querySelector(`#${PLAIN_ONLY_NOTE_ID}`);
  const plainView = () => EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  const shown = () =>
    container.querySelector(".chapter-text-plain") ? "plain" : container.querySelector(".chapter-text") ? "formatted" : null;
  return {
    container,
    settingsSeen,
    saved,
    modeOption,
    openChapter,
    note,
    shown,
    plainView,
    text: (id: string) => project.chapters[id].text,
    /** Like a project read from disk (useProject counts it as a load); the open chapter id is kept. */
    openProject: async (next: Project) => {
      await act(async () => {
        replaceProject(next);
        countLoad();
      });
      await settle();
    },
  };
}

describe("opening another project", () => {
  it("shows the new project's chapter even when its path is the same", async () => {
    const ui = await mount(SIMPLE);
    expect(ui.container.querySelector(".chapter-text")?.textContent).toContain("Elena waits.");
    const other = buildProject({
      root: "/other",
      folderName: "Other",
      projectJson: null,
      files: [{ path: SIMPLE, text: "# Simple\n\nArno rows on.\n" }],
      skipped: [],
    });
    await ui.openProject(other);
    const text = ui.container.querySelector(".chapter-text")?.textContent ?? "";
    expect(text).toContain("Arno rows on.");
    expect(text).not.toContain("Elena waits.");
  });

  it("starts the editors of a new read without the old read's caret", async () => {
    const ui = await mount(SIMPLE, "plain");
    const inWaits = ui.plainView().state.doc.toString().indexOf("waits");
    await act(async () => ui.plainView().dispatch({ selection: { anchor: inWaits } }));
    await ui.openChapter("Lists");
    await ui.openChapter("Simple");
    expect(ui.plainView().state.selection.main.head).toBe(inWaits);

    await ui.openProject(withChapterText(initialProject, SIMPLE, "# Simple\n\nElena waits, and waits.\n"));
    expect(ui.plainView().state.doc.toString()).toContain("and waits");
    expect(ui.plainView().state.selection.main.head).toBe(0);
  });

  it("gives parts with non-Latin names their own panel ids", async () => {
    const ui = await mount(SIMPLE);
    await ui.openProject(
      buildProject({
        root: "/parts",
        folderName: "Parts",
        projectJson: null,
        files: [
          { path: "manuscript/Часть первая/01 A.md", text: "# A\n" },
          { path: "manuscript/Часть вторая/02 B.md", text: "# B\n" },
        ],
        skipped: [],
      }),
    );
    const parts = [...ui.container.querySelectorAll<HTMLButtonElement>(".binder-row--group")].filter((b) =>
      b.textContent?.includes("Часть"),
    );
    const ids = parts.map((b) => b.getAttribute("aria-controls"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(ui.container.querySelector(`[id="${id}"]`)?.textContent).toMatch(/^[AB]/);
  });

  it("shows the new text when the same folder is read again after an outside edit", async () => {
    const ui = await mount(SIMPLE);
    const reread = withChapterText(initialProject, SIMPLE, "# Simple\n\nChanged in another editor.\n");
    expect(reread.root).toBe(initialProject.root);
    await ui.openProject(reread);
    const text = ui.container.querySelector(".chapter-text")?.textContent ?? "";
    expect(text).toContain("Changed in another editor.");
    expect(text).not.toContain("Elena waits.");
  });
});

describe("a chapter the formatted view can't keep", () => {
  it("opens in Plain with a note, without changing the mode setting or the text", async () => {
    const ui = await mount(LISTS);
    expect(ui.shown()).toBe("plain");
    expect(ui.note()?.textContent).toContain("open in Plain");
    expect(ui.settingsSeen).toEqual([]);
    expect(ui.saved).toEqual([]);
    expect(ui.text(LISTS)).toBe(LISTS_TEXT);
  });

  it("shows Plain as the mode and offers no way back to the read-only view", async () => {
    const ui = await mount(LISTS);
    const formatted = ui.modeOption("Formatted");
    expect(ui.modeOption("Plain").getAttribute("aria-checked")).toBe("true");
    expect(formatted.getAttribute("aria-checked")).toBe("false");
    expect(formatted.disabled).toBe(true);
    expect(formatted.getAttribute("aria-describedby")).toBe(PLAIN_ONLY_NOTE_ID);

    await act(async () => ui.modeOption("Plain").click());
    expect(ui.settingsSeen).toEqual([]);
    expect(ui.shown()).toBe("plain");
  });

  it("ends when another chapter is opened, and is found again on coming back", async () => {
    const ui = await mount(LISTS);
    await ui.openChapter("Simple");
    expect(ui.shown()).toBe("formatted");
    expect(ui.note()).toBeNull();
    expect(ui.modeOption("Formatted").disabled).toBe(false);
    expect(ui.modeOption("Formatted").getAttribute("aria-checked")).toBe("true");

    await ui.openChapter("Lists");
    expect(ui.shown()).toBe("plain");
    expect(ui.note()).not.toBeNull();
    expect(ui.text(LISTS)).toBe(LISTS_TEXT);
  });

  it("is found when switching to Formatted from Plain, and the setting follows the choice", async () => {
    const ui = await mount(LISTS, "plain");
    expect(ui.note()).toBeNull();
    await act(async () => ui.modeOption("Formatted").click());
    await settle();
    expect(ui.settingsSeen.at(-1)?.mode).toBe("formatted");
    expect(ui.shown()).toBe("plain");
    expect(ui.note()).not.toBeNull();
    expect(ui.text(LISTS)).toBe(LISTS_TEXT);
  });

  it("keeps the caret when switching to Formatted sends the chapter back to Plain", async () => {
    const ui = await mount(LISTS, "plain");
    const caret = LISTS_TEXT.indexOf("Bonsoir") + 3;
    await act(async () => ui.plainView().dispatch({ selection: { anchor: caret } }));
    await act(async () => ui.modeOption("Formatted").click());
    await settle();
    expect(ui.note()).not.toBeNull();
    expect(ui.plainView().state.selection.main.head).toBe(caret);
  });

  // The matcher refresh dispatches before Tiptap's "create" and the trailing-node
  // plugin turns it into a doc change; FormattedEditor must not save that.
  it("never saves a chapter that ends in unsupported Markdown after a heading", async () => {
    const ui = await mount(HEADING_LIST);
    expect(ui.saved).toEqual([]);
    expect(ui.text(HEADING_LIST)).toBe(HEADING_LIST_TEXT);
    expect(ui.shown()).toBe("plain");
  });
});

describe("a chapter the formatted view can keep", () => {
  it("opens in Formatted with no note, and the mode switch works as before", async () => {
    const ui = await mount(SIMPLE);
    expect(ui.shown()).toBe("formatted");
    expect(ui.note()).toBeNull();
    await act(async () => ui.modeOption("Plain").click());
    await settle();
    expect(ui.settingsSeen.at(-1)?.mode).toBe("plain");
    expect(ui.shown()).toBe("plain");
    await act(async () => ui.modeOption("Formatted").click());
    await settle();
    expect(ui.settingsSeen.at(-1)?.mode).toBe("formatted");
    expect(ui.shown()).toBe("formatted");
  });

  it("keeps the caret through a Plain, Formatted, Plain round trip", async () => {
    const ui = await mount(SIMPLE, "plain");
    const caret = "# Simple\n\nElena wa".length;
    await act(async () => ui.plainView().dispatch({ selection: { anchor: caret } }));
    await act(async () => ui.modeOption("Formatted").click());
    await settle();
    expect(ui.shown()).toBe("formatted");
    await act(async () => ui.modeOption("Plain").click());
    await settle();
    expect(ui.plainView().state.selection.main.head).toBe(caret);
  });
});
