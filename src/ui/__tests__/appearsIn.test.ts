// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { NameIndex } from "../../core/nameIndex";
import { buildNameMatcher, buildProject, withChapterText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS } from "../../core/settings";
import type { useProject } from "../../core/useProject";
import type { AppearancesSource } from "../AppearsIn";
import { SheetPreview, type SheetPreviewProps } from "../BottomSheet";
import { Inspector, type InspectorProps } from "../Inspector";
import { Workspace } from "../Workspace";

const PROLOGUE = "manuscript/00 Prologue.md";
const ARRIVAL = "manuscript/Part 1 - Arrival/01 The arrival.md";
const FERRYMAN = "manuscript/Part 1 - Arrival/02 The ferryman.md";
const UPSTREAM = "manuscript/Part 2 - The river/03 Upstream.md";
const EPILOGUE = "manuscript/04 Epilogue.md";

const ELENA = "sheets/characters/Elena Voss.md";
const VARN = "sheets/places/Varn.md";
const MAGIC = "sheets/notes/Magic system.md";

/** Elena appears in every chapter but The ferryman; the Epilogue, outside any part, comes last in the binder. */
const project = buildProject({
  root: "/test",
  folderName: "Test",
  projectJson: JSON.stringify({
    binder: [PROLOGUE, "manuscript/Part 1 - Arrival", "manuscript/Part 2 - The river", EPILOGUE],
  }),
  files: [
    { path: PROLOGUE, text: "# Prologue\n\nVoss dreams of the sea.\n" },
    { path: ARRIVAL, text: "# The arrival\n\nElena waits at the inn.\n\nElena Voss signs the book. Voss sleeps.\n" },
    { path: FERRYMAN, text: "# The ferryman\n\nArno rows across.\n" },
    { path: UPSTREAM, text: "# Upstream\n\nArno watches Elena.\n" },
    { path: EPILOGUE, text: "# Epilogue\n\nElena and Elena again.\n" },
    { path: ELENA, text: "---\nname: Elena Voss\naliases: [Elena, Voss]\nrole: Protagonist\n---\nA surveyor.\n" },
    { path: VARN, text: "---\nname: Varn\n---\nA city on the coast.\n" },
    { path: MAGIC, text: "---\nname: Magic system\n---\nElena can't use it.\n" },
  ],
  skipped: [],
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The list as shown: each group's part title (null outside parts), and its rows' titles and counts. */
function shownGroups(scope: ParentNode) {
  const section = scope.querySelector('section[aria-label="Appears in"]');
  return [...(section?.querySelectorAll(".chapter-group") ?? [])].map((group) => ({
    part: group.querySelector(".group-label")?.textContent ?? null,
    rows: [...group.querySelectorAll(".list-row")].map(
      (row) => `${row.querySelector(".list-row-title")!.textContent} ${row.querySelector(".num")!.textContent}`,
    ),
  }));
}

const rowFor = (scope: ParentNode, title: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('section[aria-label="Appears in"] .list-row')].find(
    (row) => row.querySelector(".list-row-title")?.textContent === title,
  )!;

describe("Appears in, in the inspector", () => {
  let props: InspectorProps;

  beforeEach(() => {
    props = {
      project,
      chapter: project.chapters[ARRIVAL],
      matcher: buildNameMatcher(project.sheets),
      index: new NameIndex(),
      sheetsById: new Map(project.sheets.map((s) => [s.id, s])),
      view: { kind: "sheet", id: ELENA },
      onViewChange: vi.fn(),
      onOpenSheet: vi.fn(),
      onOpenChapter: vi.fn(),
      onChapterDetails: vi.fn(),
      onCreateSheet: vi.fn(),
      onUpdateSheet: vi.fn(),
      ignoring: { ignored: [], setIgnored: vi.fn(), busy: false },
      onMarkNotName: vi.fn(),
      busy: false,
      versions: { list: async () => [], restore: async () => undefined, saveStatus: "saved", loads: 1, busy: false },
      visible: true,
    };
  });

  async function render(patch: Partial<InspectorProps> = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(Inspector, props)));
  }

  it("lists the chapters in reading order, grouped by part as in the binder, with counts", async () => {
    await render();
    expect(shownGroups(container)).toEqual([
      { part: null, rows: ["Prologue 1"] },
      { part: "Part 1 - Arrival", rows: ["The arrival 3"] },
      { part: "Part 2 - The river", rows: ["Upstream 1"] },
      { part: null, rows: ["Epilogue 2"] },
    ]);
    expect(rowFor(container, "The arrival").querySelector(".num")!.getAttribute("aria-label")).toBe("3 mentions");
    expect(rowFor(container, "Upstream").querySelector(".num")!.getAttribute("aria-label")).toBe("1 mention");
  });

  it("comes after the fields and before the notes", async () => {
    await render();
    const sections = [...container.querySelector(".sheet")!.children].map((el) => el.className);
    expect(sections).toEqual(["sheet-header", "sheet-aliases", "fields", "sheet-appearances", "sheet-notes"]);
  });

  it("marks the chapter open in the editor, and only that one", async () => {
    await render();
    const current = [...container.querySelectorAll('.sheet [aria-current="page"]')];
    expect(current).toEqual([rowFor(container, "The arrival")]);

    await render({ chapter: null });
    expect(container.querySelectorAll('.sheet [aria-current="page"]')).toHaveLength(0);
  });

  it("follows the text as it changes", async () => {
    await render();
    const edited = withChapterText(project, FERRYMAN, "# The ferryman\n\nArno rows Elena across.\n");
    await render({ project: edited, chapter: edited.chapters[ARRIVAL] });
    expect(shownGroups(container)[1]).toEqual({ part: "Part 1 - Arrival", rows: ["The arrival 3", "The ferryman 1"] });
  });

  it("says so when the sheet's names appear in no chapter", async () => {
    await render({ view: { kind: "sheet", id: VARN } });
    const section = container.querySelector('section[aria-label="Appears in"]')!;
    expect(section.querySelector(".empty-note")?.textContent).toBe("Not mentioned in any chapter yet.");
    expect(section.querySelectorAll(".list-row")).toHaveLength(0);
  });

  it("has no Appears in for a notes sheet", async () => {
    await render({ view: { kind: "sheet", id: MAGIC } });
    expect(container.querySelector(".sheet-name")?.textContent).toBe("Magic system");
    expect(container.querySelector('section[aria-label="Appears in"]')).toBeNull();
    expect(container.textContent).not.toContain("Appears in");
  });

  it("opens a clicked chapter and keeps showing the sheet", async () => {
    await render();
    await act(async () => rowFor(container, "Upstream").click());
    expect(props.onOpenChapter).toHaveBeenCalledExactlyOnceWith(UPSTREAM);
    expect(props.onViewChange).not.toHaveBeenCalled();
    expect(container.querySelector(".sheet-name")?.textContent).toBe("Elena Voss");
  });

  it("opens nothing while the project changes on disk", async () => {
    await render({ busy: true });
    const rows = [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Appears in"] .list-row')];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.disabled)).toBe(true);
    await act(async () => rows[0].click());
    expect(props.onOpenChapter).not.toHaveBeenCalled();

    await render({ busy: false });
    expect(rows.some((row) => row.disabled)).toBe(false);
  });
});

describe("Appears in, in the phone preview", () => {
  let props: SheetPreviewProps;
  let source: AppearancesSource;

  beforeEach(() => {
    source = {
      index: new NameIndex(),
      project,
      matcher: buildNameMatcher(project.sheets),
      openChapterId: ARRIVAL,
      onOpenChapter: vi.fn(),
      busy: false,
    };
    props = {
      sheet: project.sheets.find((s) => s.id === ELENA)!,
      open: true,
      onClose: vi.fn(),
      appearances: source,
      onEdit: vi.fn(),
      ignoring: { ignored: [], setIgnored: vi.fn(), busy: false },
    };
  });

  async function render(patch: Partial<SheetPreviewProps> = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(SheetPreview, props)));
  }

  const preview = () => document.querySelector<HTMLElement>(".bottom-sheet")!;

  it("closes, then opens the tapped chapter", async () => {
    await render();
    expect(shownGroups(preview()).map((g) => g.rows).flat()).toEqual(["Prologue 1", "The arrival 3", "Upstream 1", "Epilogue 2"]);
    await act(async () => rowFor(preview(), "Upstream").click());
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(source.onOpenChapter).toHaveBeenCalledExactlyOnceWith(UPSTREAM);
    expect(vi.mocked(props.onClose).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(source.onOpenChapter).mock.invocationCallOrder[0],
    );
  });

  it("opens nothing and stays open while the project changes on disk", async () => {
    await render({ appearances: { ...source, busy: true } });
    const row = rowFor(preview(), "Upstream");
    expect(row.disabled).toBe(true);
    await act(async () => row.click());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(source.onOpenChapter).not.toHaveBeenCalled();
  });
});

describe("a chapter tapped in the phone preview", () => {
  const backend = {
    kind: "browser",
    canOpenFolders: false,
    canCreateProjects: false,
    listProjects: async () => [],
    listVersions: async () => [],
    onCloseRequested: async () => () => undefined,
  } as unknown as Backend;
  // Stable, as useProject's are.
  const listVersions = async () => [];
  const restoreVersion = async () => undefined;
  const listProjects = async () => [];

  let opened: string[];

  beforeAll(() => {
    // A touchscreen phone: editors don't take focus when they mount.
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    // jsdom has no layout; the editors measure ranges to scroll the caret into view.
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });

  beforeEach(() => {
    opened = [];
  });

  /** The phone layout on the test project, in Plain (its names answer clicks without layout), Arrival open. */
  async function mount() {
    function Harness() {
      const [openChapterId, setOpenChapterId] = useState<string | null>(ARRIVAL);
      const [current] = useState<Project>(project);
      const matcher = useMemo(() => buildNameMatcher(current.sheets), [current.sheets]);
      const api = {
        backend,
        load: { status: "ready" },
        project: current,
        matcher,
        openChapterId,
        openChapter: (id: string) => {
          opened.push(id);
          setOpenChapterId(id);
        },
        updateChapter: () => undefined,
        save: { status: "saved" },
        saveNow: async () => undefined,
        openFolder: async () => undefined,
        openProjectAt: async () => undefined,
        createProject: async () => undefined,
        listProjects,
        listVersions,
        restoreVersion,
        switching: false,
        bookWords: 0,
        wordsToday: 0,
        loads: 1,
      } as unknown as ReturnType<typeof useProject>;
      return createElement(Workspace, {
        api,
        project: current,
        backend,
        settings: { ...DEFAULT_SETTINGS, mode: "plain" },
        update: () => undefined,
        isPhone: true,
      });
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const preview = () => document.querySelector<HTMLElement>(".bottom-sheet.is-open");

  /** Taps Elena in the text, which opens her sheet in the preview. */
  async function tapElena() {
    const mark = [...container.querySelectorAll(".cm-content .name-mark")].find((m) => m.textContent === "Elena")!;
    await act(async () => mark.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(preview()?.querySelector(".sheet-name")?.textContent).toBe("Elena Voss");
  }

  it("closes the preview and opens the chapter", async () => {
    await mount();
    await tapElena();
    await act(async () => rowFor(preview()!, "Upstream").click());
    expect(preview()).toBeNull();
    expect(opened).toEqual([UPSTREAM]);
    expect(container.querySelector(".cm-content")?.textContent).toContain("Arno watches Elena.");
  });

  it("when it is the open chapter, closes the preview and gives the text focus back", async () => {
    await mount();
    await tapElena();
    await act(async () => rowFor(preview()!, "The arrival").click());
    expect(preview()).toBeNull();
    expect(opened).toEqual([]);
    expect(document.activeElement?.closest(".editor-pane")).not.toBeNull();
  });
});
