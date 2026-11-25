// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act, createElement, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { bookContent, withExportChoice, withExportPreset, type BookContent } from "../../core/exportBook";
import {
  BUILT_IN_PRESETS,
  PAPERBACK,
  type BookLayout,
  type ExportFormat,
  type ExportSettings,
} from "../../core/exportSettings";
import { withFinalNewline } from "../../core/markdown";
import { buildNameMatcher, buildProject, withChapterText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS, type ViewSettings } from "../../core/settings";
import type { useProject } from "../../core/useProject";
import type { ExportDialogProps, ExportSource } from "../ExportDialog";
import { HOVER_QUERY } from "../hooks";
import { Workspace } from "../Workspace";

/*
 * The Export window wired into the workspace: opened from the main menu,
 * working from the project (its parts and chapters, its presets, its last
 * export and author) and from the backend's layout, pages and export.
 */

/** Each source the workspace hands the Export window, as it renders; the window itself is the real one. */
const seen = vi.hoisted(() => ({ sources: [] as ExportSource[] }));
vi.mock("../ExportDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ExportDialog")>();
  const react = await import("react");
  return {
    ...actual,
    ExportDialog: (props: ExportDialogProps) => {
      seen.sources.push(props.source);
      return react.createElement(actual.ExportDialog, props);
    },
  };
});

const PROLOGUE = "manuscript/00 Prologue.md";
const SHORE = "manuscript/Part One/01 The shore.md";
const STORM = "manuscript/Part One/02 The storm.md";
const ALL = [PROLOGUE, SHORE, STORM];
const TITLE = "The Ferryman’s Debt";

/** The project's own preset, which its last export used. */
const PROOF: ExportSettings = { ...PAPERBACK, fontSize: 10 };

/** The book, with what project.json keeps of export (and its author), or nothing yet. */
function book(exported: Record<string, unknown> | null): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson: JSON.stringify({
      version: 1,
      title: TITLE,
      language: "en-GB",
      ...(exported && { author: "Ada Quill", export: exported }),
    }),
    files: [
      { path: PROLOGUE, text: "# Prologue\n\nThe river was high that year.\n" },
      { path: SHORE, text: "# The shore\n\nElena walked to the river.\n" },
      { path: STORM, text: "# The storm\n\nRain fell on the river.\n" },
    ],
    skipped: [],
  });
}

const EXPORTED = book({
  presets: [{ name: "Proof copy", settings: PROOF }],
  last: { preset: "Proof copy", settings: PROOF, format: "pdf" },
});
const NEVER_EXPORTED = book(null);

/* The backend: the app's, which lays out, draws and writes; the browser preview's, which does none of that. */

let generation = 0;
const layOutBook = vi.fn(
  async (_book: BookContent, _settings: ExportSettings): Promise<BookLayout> => ({
    generation: ++generation,
    pages: 5,
    width: 419.53,
    height: 595.28,
    chapterPages: [2, 3, 4],
  }),
);
const bookPage = vi.fn(
  async (at: number, index: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${at}:${index}</text></svg>`,
);
const exportBook = vi.fn(
  async (_book: BookContent, _settings: ExportSettings, _format: ExportFormat, fileName: string): Promise<string | null> =>
    `/home/ada/Books/${fileName}`,
);

const common = {
  canOpenFolders: false,
  canCreateProjects: true,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
};
const app = { ...common, kind: "app", layOutBook, bookPage, exportBook } as unknown as Backend;
const preview = { ...common, kind: "browser" } as unknown as Backend;

/* useProject, as the workspace is given it ---------------------------------------- */

// Stable, as useProject's are.
const listProjects = async () => [];
const listVersions = async () => [];
const restoreVersion = async () => undefined;
const saveNow = async () => undefined;
const update = vi.fn<(patch: Partial<ViewSettings>) => void>();
/** What the window asked useProject to keep in project.json. */
const saveExportPreset = vi.fn<(name: string, settings: ExportSettings) => void>();
const rememberExport = vi.fn<(choice: { format: ExportFormat; settings: ExportSettings; author: string }, presetName: string | null) => void>();

/** The project as the workspace was last given it. */
let current: Project = EXPORTED;
/** Renders the workspace again with nothing changed. */
let renderAgain: () => void = () => undefined;

/** Stands for App and useProject: the project in state, changed as useProject changes it. */
function Harness({ start, backend, switching }: { start: Project; backend: Backend; switching: boolean }) {
  const [project, setProject] = useState(start);
  const [, setRenders] = useState(0);
  renderAgain = () => setRenders((n) => n + 1);
  current = project;
  const latest = useRef(project);
  latest.current = project;
  const matcher = useMemo(() => buildNameMatcher(project.sheets), [project.sheets]);
  // Stable, as useProject's are; they change project.json as it does.
  const [exportApi] = useState(() => ({
    saveExportPreset: (name: string, settings: ExportSettings) => {
      saveExportPreset(name, settings);
      setProject(withExportPreset(latest.current, name, settings).project);
    },
    rememberExport: (choice: { format: ExportFormat; settings: ExportSettings; author: string }, presetName: string | null) => {
      rememberExport(choice, presetName);
      const change = withExportChoice(latest.current, choice, presetName);
      if (change) setProject(change.project);
    },
  }));
  const api = {
    backend,
    load: { status: "ready" },
    project,
    matcher,
    openChapterId: SHORE,
    openChapter: () => undefined,
    updateChapter: (id: string, markdown: string) => setProject((p) => withChapterText(p, id, withFinalNewline(markdown))),
    ...exportApi,
    save: { status: "saved" },
    saveNow,
    hasUnsaved: () => false,
    listProjects,
    listVersions,
    restoreVersion,
    switching,
    bookWords: 0,
    wordsToday: 0,
    loads: 1,
  } as unknown as ReturnType<typeof useProject>;
  return createElement(Workspace, {
    api,
    project,
    backend,
    settings: { ...DEFAULT_SETTINGS, mode: "plain" },
    update,
    isPhone: false,
  });
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

beforeEach(() => {
  seen.sources.length = 0;
  generation = 0;
  for (const fn of [layOutBook, bookPage, exportBook, saveExportPreset, rememberExport, update]) fn.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Lets promises settle and React render what they set, and a frame go by. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

/** A desktop with a mouse: the editor takes focus when it mounts. */
async function mount({ start = EXPORTED, backend = app, switching = false } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: query === HOVER_QUERY,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  await act(async () => root.render(createElement(Harness, { start, backend, switching })));
  await settle();
}

async function click(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement)) throw new Error("Nothing to click");
  await act(async () => el.click());
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.popover [role^="menuitem"]')].find(
    (i) => i.querySelector(".menu-item-label")?.textContent === name,
  );

/** Export…, from the main menu. */
async function openExport() {
  await click(container.querySelector('.format-bar button[aria-label="Main menu"]'));
  await click(menuItem("Export…"));
}

const dialog = () => document.querySelector<HTMLElement>('.export-dialog[role="dialog"]');
const source = () => seen.sources.at(-1)!;
const status = () => dialog()!.querySelector(".export-status")!.textContent;
const exportButton = () => dialog()!.querySelector<HTMLButtonElement>(".btn--primary.export-button")!;
const presetButton = () => dialog()!.querySelector<HTMLButtonElement>(".export-preset")!;
const tab = (name: string) => [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name);
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);
/** A field by its label's text: labelled with `for`, or wrapped by its label (checkboxes). */
function field(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll("label")].find((l) => l.textContent === label);
  if (!found) throw new Error(`No field “${label}”`);
  return (found.htmlFor ? document.getElementById(found.htmlFor) : found.querySelector("input")) as HTMLInputElement;
}
const plainView = () => EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;

const builtIn = BUILT_IN_PRESETS.map((p) => ({ ...p, builtIn: true }));

describe("Export in the workspace", () => {
  it("opens from the main menu, starting from the project's parts and chapters, presets, last export and author", async () => {
    await mount();
    expect(dialog()).toBeNull();
    await openExport();
    expect(dialog()).not.toBeNull();

    expect(source().outline).toEqual([
      { part: null, chapters: [{ id: PROLOGUE, title: "Prologue" }] },
      {
        part: "Part One",
        chapters: [
          { id: SHORE, title: "The shore" },
          { id: STORM, title: "The storm" },
        ],
      },
    ]);
    expect(source().title).toBe(TITLE);
    expect(source().author).toBe("Ada Quill");
    // Built-in presets first, then the project's own.
    expect(source().presets).toEqual([...builtIn, { name: "Proof copy", settings: PROOF, builtIn: false }]);
    expect(source().initial).toEqual({ presetName: "Proof copy", settings: PROOF, format: "pdf" });

    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Proof copy");
    expect(tab("PDF")?.getAttribute("aria-selected")).toBe("true");
    expect(field("Author").value).toBe("Ada Quill");
  });

  it("starts a project's first export from the first built-in preset, as a PDF", async () => {
    await mount({ start: NEVER_EXPORTED });
    await openExport();
    expect(source().presets).toEqual(builtIn);
    expect(source().initial).toEqual({ presetName: BUILT_IN_PRESETS[0].name, settings: BUILT_IN_PRESETS[0].settings, format: "pdf" });
    expect(source().author).toBe("");
    expect(presetButton().getAttribute("aria-label")).toBe(`Preset: ${BUILT_IN_PRESETS[0].name}`);
    expect(tab("PDF")?.getAttribute("aria-selected")).toBe("true");
  });

  it("lays the pages out from the text as the editor has it, edits made just before opening included", async () => {
    await mount();
    const end = plainView().state.doc.length;
    act(() => plainView().dispatch({ changes: { from: end, insert: "\nThe tide turned.\n" } }));
    await openExport();

    expect(layOutBook).toHaveBeenCalledTimes(1);
    const [laidOut, settings] = layOutBook.mock.calls[0];
    expect(settings).toEqual(PROOF);
    expect(laidOut).toEqual(bookContent(current, ALL, "Ada Quill"));
    expect(laidOut.sections.map((s) => s.part)).toEqual([null, "Part One"]);
    expect(laidOut.sections[1].chapters[0].markdown).toContain("The tide turned.");
    // The first page, alone on the right of its spread, drawn by the core.
    expect(bookPage).toHaveBeenCalledWith(1, 0);
    expect(dialog()!.querySelector('.export-page img[alt="Page 1"]')).not.toBeNull();
  });

  it("keeps the same source while it is open, so the pages aren't laid out again", async () => {
    await mount();
    await openExport();
    const first = source();
    await act(async () => renderAgain());
    await settle();
    expect(source()).toBe(first);
    expect(new Set(seen.sources).size).toBe(1);
    expect(layOutBook).toHaveBeenCalledTimes(1);
  });

  it("writes the file through the core under the book's title, remembers the choice, and says where it went", async () => {
    await mount();
    await openExport();
    await click(exportButton());
    expect(rememberExport).toHaveBeenCalledWith(
      { format: "pdf", settings: PROOF, chapterIds: ALL, author: "Ada Quill" },
      "Proof copy",
    );
    expect(exportBook).toHaveBeenCalledWith(bookContent(current, ALL, "Ada Quill"), PROOF, "pdf", `${TITLE}.pdf`);
    expect(status()).toBe(`Saved to /home/ada/Books/${TITLE}.pdf`);
    // project.json changed (the last export): the pages already shown stay.
    expect(layOutBook).toHaveBeenCalledTimes(1);

    // Each format with its own extension.
    await click(tab("Markdown"));
    await click(exportButton());
    expect(exportBook).toHaveBeenLastCalledWith(expect.anything(), PROOF, "markdown", `${TITLE}.md`);
    await click(tab("Word"));
    await click(exportButton());
    expect(exportBook).toHaveBeenLastCalledWith(expect.anything(), PROOF, "docx", `${TITLE}.docx`);
  });

  it("in the browser preview, without the core's export, says why the pages aren't drawn and the file isn't saved", async () => {
    await mount({ backend: preview });
    await openExport();
    expect(source().layOut).toBeUndefined();
    expect(source().page).toBeUndefined();
    expect(dialog()!.querySelector(".export-preview-note-title")?.textContent).toBe("Pages can’t be drawn here");
    await click(exportButton());
    expect(status()).toBe("Couldn’t export: The browser preview can’t save files. Use the desktop or Android app.");
    expect(exportButton().disabled).toBe(false);
  });

  it("saves the settings as a preset of the project", async () => {
    await mount();
    await openExport();
    await click(field("Justify"));
    await click(presetButton());
    await click(menuItem("Save as preset…"));
    await type(field("Preset name"), "Large print");
    await click(button("Save preset"));
    expect(saveExportPreset).toHaveBeenCalledWith("Large print", { ...PROOF, justify: false });
    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Large print");
    // Handed back by the project, after its own.
    expect(source().presets.map((p) => p.name)).toEqual([...builtIn.map((p) => p.name), "Proof copy", "Large print"]);
  });

  it("refuses to save a preset while the project changes on disk, and says so", async () => {
    await mount({ switching: true });
    await openExport();
    await click(field("Justify"));
    await click(presetButton());
    await click(menuItem("Save as preset…"));
    await type(field("Preset name"), "Large print");
    await click(button("Save preset"));
    expect(saveExportPreset).not.toHaveBeenCalled();
    expect(document.querySelector(".export-save-note")?.textContent).toBe(
      "The project is changing on disk. Try again in a moment.",
    );
  });

  it("closes with Escape, the caret back in the text", async () => {
    await mount();
    await openExport();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement?.closest(".editor-pane")).not.toBeNull();
  });
});
