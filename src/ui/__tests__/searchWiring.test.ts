// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { withFinalNewline } from "../../core/markdown";
import { buildNameMatcher, buildProject, withChapterText } from "../../core/project";
import { DEFAULT_SETTINGS, type EditorMode, type ViewSettings } from "../../core/settings";
import type { useProject } from "../../core/useProject";
import { HOVER_QUERY } from "../hooks";
import { SEARCH_DELAY_MS } from "../SearchPanel";
import { Workspace } from "../Workspace";

/*
 * Find in book wired into the workspace: opened from its shortcuts in the
 * inspector's place, searching the project's chapters, opening results in
 * the editor, replacing in every chapter, and marking matches in the text.
 */

const SHORE = "manuscript/01 The shore.md";
const STORM = "manuscript/02 The storm.md";
const ELENA = "sheets/characters/Elena Voss.md";

/** "river" twice in The shore, once in The storm; Elena is a character. */
const BOOK = buildProject({
  root: "/test",
  folderName: "Test",
  projectJson: null,
  files: [
    { path: SHORE, text: "# The shore\n\nElena walked to the river.\n\nThe river was *high* that spring.\n" },
    { path: STORM, text: "# The storm\n\nRain fell on the river and on Elena.\n" },
    { path: ELENA, text: "---\nname: Elena Voss\naliases: [Elena]\n---\n" },
  ],
  skipped: [],
});

const backend = {
  kind: "app",
  canOpenFolders: false,
  canCreateProjects: true,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
} as unknown as Backend;

// Stable, as useProject's are.
const listProjects = async () => [];
const listVersions = async () => [];
const restoreVersion = async () => undefined;
const saveNow = async () => undefined;

/** Chapters opened, and chapter text handed to the project, as useProject is asked. */
const openChapter = vi.fn<(id: string) => void>();
const updateChapter = vi.fn<(id: string, markdown: string) => void>();
const update = vi.fn<(patch: Partial<ViewSettings>) => void>();

/** Stands for App and useProject: the project and the open chapter in state, changed as useProject changes them. */
function Harness({ mode, isPhone }: { mode: EditorMode; isPhone: boolean }) {
  const [project, setProject] = useState(BOOK);
  const [openId, setOpenId] = useState(SHORE);
  const matcher = useMemo(() => buildNameMatcher(project.sheets), [project.sheets]);
  const api = {
    backend,
    load: { status: "ready" },
    project,
    matcher,
    openChapterId: openId,
    openChapter: (id: string) => {
      openChapter(id);
      setOpenId(id);
    },
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
  } as unknown as ReturnType<typeof useProject>;
  return createElement(Workspace, {
    api,
    project,
    backend,
    settings: { ...DEFAULT_SETTINGS, mode },
    update,
    isPhone,
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
  openChapter.mockClear();
  updateChapter.mockClear();
  update.mockClear();
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

/** A desktop with a mouse (the editors take focus when they mount), or a touchscreen phone. */
async function mount({ mode = "plain" as EditorMode, isPhone = false } = {}) {
  window.matchMedia = ((query: string) => ({
    matches: isPhone ? query === "(pointer: coarse)" : query === HOVER_QUERY,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  await act(async () => root.render(createElement(Harness, { mode, isPhone })));
  await settle();
}

async function key(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const findKeys = () => key({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
const replaceKeys = () => key({ key: "h", code: "KeyH", ctrlKey: true });

async function click(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement)) throw new Error("Nothing to click");
  await act(async () => el.click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Types in Find and lets the pause after typing pass. */
async function search(query: string) {
  await type(findField()!, query);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 20));
  });
}

const text = () => container.querySelector<HTMLElement>(".editor-surface")!;
const focusText = () => act(async () => container.querySelector<HTMLElement>(".cm-content, .ProseMirror")!.focus());
const panel = () => container.querySelector<HTMLElement>("#inspector .search-panel");
/** The panel is in the inspector's place, not kept out of sight. */
const panelShown = () => panel() !== null && !panel()!.closest<HTMLElement>(".search-slot")!.hidden;
const findField = () => panel()?.querySelector<HTMLInputElement>('input[aria-label="Find"]') ?? null;
const replaceField = () => panel()?.querySelector<HTMLInputElement>('input[aria-label="Replace with"]') ?? null;
const summary = () => panel()?.querySelector(".search-summary")?.textContent;
const groupNames = () => [...(panel()?.querySelectorAll(".search-group-name") ?? [])].map((g) => g.textContent);
const results = () => [...(panel()?.querySelectorAll<HTMLButtonElement>(".search-result") ?? [])];
const resultIn = (title: string) =>
  [...(panel()?.querySelectorAll(".search-group") ?? [])]
    .find((g) => g.querySelector(".search-group-name")?.textContent === title)
    ?.querySelector<HTMLButtonElement>(".search-result");
const panelButton = (name: string) =>
  [...(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
/** What the text marks as matches, and as the result opened. */
const marked = () => [...text().querySelectorAll(".search-match")].map((m) => m.textContent);
const current = () => [...text().querySelectorAll(".search-current")].map((m) => m.textContent);
const focusInPanel = () => panel()?.contains(document.activeElement) ?? false;
const inspectorOpen = () => container.querySelector("#inspector")!.classList.contains("is-open");
/** The last text handed to the project for a chapter. */
const lastText = (id: string) => updateChapter.mock.calls.filter(([chapter]) => chapter === id).at(-1)?.[1];

describe("Find in book in the workspace", () => {
  it("searches every chapter as you type, lists the results by chapter, and marks them in the text until it closes", async () => {
    await mount();
    await focusText();
    await findKeys();
    expect(panelShown()).toBe(true);
    expect(document.activeElement).toBe(findField());
    expect(marked()).toEqual([]);

    await search("river");
    expect(summary()).toBe("3 results in 2 chapters");
    expect(groupNames()).toEqual(["The shore", "The storm"]);
    expect(marked()).toEqual(["river", "river"]);

    await click(panelButton("Close Find in book"));
    expect(panel()).toBeNull();
    expect(marked()).toEqual([]);
    expect(container.querySelector("#inspector .inspector")).not.toBeNull();
  });

  it("selects a result in the open chapter, marked, with focus left in the panel", async () => {
    await mount();
    await findKeys();
    await search("river");
    await click(results()[1]);
    expect(openChapter).not.toHaveBeenCalled();
    expect(current()).toEqual(["river"]);
    expect(focusInPanel()).toBe(true);
    // Enter in Find goes on to the next result, in the next chapter.
    await key({ key: "Enter" }, findField()!);
    expect(openChapter).toHaveBeenCalledWith(STORM);
  });

  it.each(["plain", "formatted"] as const)(
    "opens a result in another chapter with it selected in the %s editor, focus left in the panel",
    async (mode) => {
      await mount({ mode });
      await findKeys();
      await search("river");
      const result = resultIn("The storm")!;
      // As a mouse press would, before the click.
      await act(async () => result.focus());
      await click(result);
      await settle();
      expect(openChapter).toHaveBeenCalledWith(STORM);
      expect(text().textContent).toContain("Rain fell on the river");
      expect(current()).toEqual(["river"]);
      expect(marked()).toEqual(["river"]);
      expect(document.activeElement).toBe(result);
    },
  );

  it("fills Find with the text's selection when asked for again from the text", async () => {
    await mount();
    await findKeys();
    await search("Elena walked");
    await click(results()[0]);
    await click(panelButton("Close Find in book"));
    expect(document.activeElement?.closest(".editor-pane")).not.toBeNull();
    await findKeys();
    expect(findField()!.value).toBe("Elena walked");
    expect(findField()!.selectionStart).toBe(0);
    expect(findField()!.selectionEnd).toBe("Elena walked".length);
  });

  it("replaces every result once confirmed: the open chapter through its editor, which Undo takes back, the other as an edit", async () => {
    await mount();
    await focusText();
    await replaceKeys();
    expect(replaceField()).not.toBeNull();
    await search("river");
    await type(replaceField()!, "stream");
    await click(panelButton("Replace all 3"));
    await click(panelButton("Replace 3"));

    expect(lastText(SHORE)).toBe("# The shore\n\nElena walked to the stream.\n\nThe stream was *high* that spring.\n");
    expect(lastText(STORM)).toBe("# The storm\n\nRain fell on the stream and on Elena.\n");
    expect(text().textContent).toContain("Elena walked to the stream.");
    expect(panel()!.querySelector(".search-replace-status")?.textContent).toBe("Replaced 3.");
    expect(summary()).toBe("No results for “river”.");

    // Undo, in the text: the open chapter's replacements go back in one step; the other chapter keeps its own.
    await focusText();
    await key({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(lastText(SHORE)).toBe("# The shore\n\nElena walked to the river.\n\nThe river was *high* that spring.\n");
    expect(lastText(STORM)).toBe("# The storm\n\nRain fell on the stream and on Elena.\n");
  });

  it("replaces one result from its row in a chapter that isn't open, leaving the text as it is", async () => {
    await mount();
    await replaceKeys();
    await search("river");
    await type(replaceField()!, "stream");
    const row = resultIn("The storm")!.closest(".search-item")!;
    await click(row.querySelector(".search-replace-one"));
    expect(updateChapter).toHaveBeenCalledTimes(1);
    expect(lastText(STORM)).toBe("# The storm\n\nRain fell on the stream and on Elena.\n");
    expect(text().textContent).toContain("Elena walked to the river.");
    expect(summary()).toBe("2 results in 1 chapter");
  });

  it("makes way for a sheet opened from a name in the text, and comes back as it was", async () => {
    await mount();
    await findKeys();
    await search("river");
    await click(text().querySelector(".name-mark"));
    expect(panelShown()).toBe(false);
    expect(container.querySelector("#inspector .inspector")).not.toBeNull();
    expect(marked()).toEqual([]);

    await focusText();
    await findKeys();
    expect(panelShown()).toBe(true);
    expect(findField()!.value).toBe("river");
    expect(summary()).toBe("3 results in 2 chapters");
    expect(marked()).toEqual(["river", "river"]);
  });

  it("on a phone, slides away to show a result, and the inspector's button brings it back", async () => {
    await mount({ isPhone: true });
    await findKeys();
    expect(inspectorOpen()).toBe(true);
    await search("river");
    await click(resultIn("The storm"));
    await settle();
    expect(inspectorOpen()).toBe(false);
    expect(current()).toEqual(["river"]);
    expect(document.activeElement?.closest(".editor-pane") ?? null).toBeNull();

    await click(container.querySelector('button[aria-controls="inspector"]'));
    expect(inspectorOpen()).toBe(true);
    expect(panelShown()).toBe(true);
    expect(resultIn("The storm")!.getAttribute("aria-current")).toBe("true");
    // Escape closes it, and the overlay with it.
    await key({ key: "Escape" }, findField()!);
    await key({ key: "Escape" }, findField()!);
    expect(panel()).toBeNull();
    expect(inspectorOpen()).toBe(false);
  });
});
