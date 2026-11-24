// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Backend, TextMenuItem } from "../../core/backend";
import { buildNameMatcher, buildProject, withSheetText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS, type EditorMode } from "../../core/settings";
import { newSheetPath, newSheetText } from "../../core/sheetFile";
import type { useProject } from "../../core/useProject";
import { HOVER_QUERY } from "../hooks";
import { Workspace } from "../Workspace";

/*
 * jsdom has no layout, so the editors' word under the pointer and their
 * selection, as a name, are faked here; the editors' own tests cover them.
 */
const fake = vi.hoisted(() => ({
  word: null as string | null,
  selection: "",
  /** Whether a right-click lands on the selection: by default, on it whenever there is one. */
  onSelection: null as boolean | null,
  points: [] as [number, number][],
}));
const clickedOnSelection = () => fake.onSelection ?? fake.selection !== "";

vi.mock("../../core/editor/codemirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/editor/codemirror")>();
  return {
    ...actual,
    plainWordAt: (_view: unknown, x: number, y: number) => {
      fake.points.push([x, y]);
      return fake.word;
    },
    plainSelectedName: () => fake.selection,
    plainSelectionContains: () => clickedOnSelection(),
  };
});

vi.mock("../../core/editor/prosemirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/editor/prosemirror")>();
  return {
    ...actual,
    wordAtPoint: (_view: unknown, x: number, y: number) => {
      fake.points.push([x, y]);
      return fake.word;
    },
    selectedNameIn: () => fake.selection,
    selectionContainsPoint: () => clickedOnSelection(),
  };
});

const C = "manuscript/01 C.md";

/** Rose and Will: ordinary words, so never offered as possible names. Elena has a sheet. */
function makeProject(): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson: null,
    files: [
      { path: C, text: "# C\n\nRose met Elena at the Harbor Inn. Rose smiled at Will.\n" },
      { path: "sheets/characters/Elena Voss.md", text: "---\nname: Elena Voss\naliases: [Elena]\n---\n" },
    ],
    skipped: [],
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/* The project as useProject would keep it ------------------------------------ */

let latest: Project;
let showProject: (project: Project) => void = () => undefined;

const createSheet = vi.fn(async (kind: string, name: string) => {
  const id = newSheetPath(latest, kind, name);
  latest = withSheetText(latest, id, newSheetText(name));
  showProject(latest);
  return id;
});

/* Backends ------------------------------------------------------------------ */

const browser = {
  kind: "browser",
  canOpenFolders: false,
  canCreateProjects: false,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
} as unknown as Backend;

/** The desktop app's native text menu: records what it was asked to show. */
const popupTextMenu = vi.fn(async (_items: TextMenuItem[], _x: number, _y: number) => undefined);

const desktop = { ...browser, kind: "app", canOpenFolders: true, popupTextMenu } as unknown as Backend;

const listVersions = async () => [];
const restoreVersion = async () => undefined;
const listProjects = async () => [];

interface Mount {
  /** Phone layout, on a touch screen. */
  isPhone?: boolean;
  mode?: EditorMode;
  /** A real pointer (mouse, trackpad): false for touch screens. */
  hover?: boolean;
  backend?: Backend;
  switching?: boolean;
}

async function mount({ isPhone = false, mode = "plain", hover = !isPhone, backend = browser, switching = false }: Mount = {}) {
  window.matchMedia = ((query: string) => ({
    matches: (!hover && query === "(pointer: coarse)") || (hover && query === HOVER_QUERY),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  function Harness() {
    const [current, setCurrent] = useState<Project>(latest);
    showProject = setCurrent;
    const matcher = useMemo(
      () => buildNameMatcher(current.sheets, current.ignoredNames),
      [current.sheets, current.ignoredNames],
    );
    const api = {
      backend,
      load: { status: "ready" },
      project: current,
      matcher,
      openChapterId: C,
      openChapter: () => undefined,
      updateChapter: () => undefined,
      ignoreName: () => undefined,
      createSheet,
      markNotName: () => undefined,
      save: { status: "saved" },
      saveNow: async () => undefined,
      openFolder: async () => undefined,
      openProjectAt: async () => undefined,
      createProject: async () => undefined,
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
      project: current,
      backend,
      settings: { ...DEFAULT_SETTINGS, mode },
      update: () => undefined,
      isPhone,
    });
  }
  await act(async () => root.render(createElement(Harness)));
  await settle();
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/* Layout, faked: the pane, the selection and the button have a place on screen. */

const PANE = new DOMRect(0, 56, 412, 800);
const BUTTON = { width: 120, height: 40 };
const MENU = { width: 200, height: 100 };
/** Where a fixed element was put, with a size. */
const placed = (el: HTMLElement, size: { width: number; height: number }) =>
  new DOMRect(Number.parseFloat(el.style.left) || 0, Number.parseFloat(el.style.top) || 0, size.width, size.height);
let selectionBox = new DOMRect();
let rects: MockInstance;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Range.prototype.getBoundingClientRect = () => selectionBox;
  Range.prototype.getClientRects = () => [selectionBox] as unknown as DOMRectList;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  latest = makeProject();
  createSheet.mockClear();
  popupTextMenu.mockClear();
  fake.word = null;
  fake.selection = "";
  fake.onSelection = null;
  fake.points = [];
  selectionBox = new DOMRect();
  const tokens = document.documentElement.style;
  tokens.setProperty("--space-1", "4px");
  tokens.setProperty("--space-2", "8px");
  tokens.setProperty("--size-selection-handle", "28px");
  const original = HTMLElement.prototype.getBoundingClientRect;
  rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("editor-pane")) return PANE;
    if (this.classList.contains("add-name-button")) return placed(this, BUTTON);
    if (this.classList.contains("popover")) return placed(this, MENU);
    return original.call(this);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  rects.mockRestore();
  document.documentElement.removeAttribute("style");
  document.getSelection()?.removeAllRanges();
  delete (window as { visualViewport?: unknown }).visualViewport;
});

/* Finding things and acting ----------------------------------------------------- */

const paragraph = () => [...container.querySelectorAll(".cm-line")].find((l) => l.textContent?.startsWith("Rose"))!;
const namesMarked = (name: string) =>
  [...container.querySelectorAll(".editor-surface .name-mark")].filter((m) => m.textContent === name);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const item = (text: string) => items().find((i) => i.textContent === text)!;
const button = () => document.querySelector<HTMLButtonElement>(".add-name-button");
const note = () => container.querySelector('.editor-pane > p.visually-hidden[role="status"]')?.textContent;
const alertText = () => container.querySelector('.editor-pane > p.visually-hidden[role="alert"]')?.textContent;
const caretInText = () => document.activeElement?.closest(".editor-surface") != null;
const sheetShown = () => container.querySelector(".inspector .sheet-name")?.textContent ?? null;
const openedFromText = () => container.querySelector('.inspector section[aria-label="Opened from the text"]');

/** A right-click at a point (client coordinates); the event, to see whether the page took it. */
async function rightClick(el: Element, x = 120, y = 80, init: { pointerType?: string } = {}) {
  const options = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 };
  const event = init.pointerType
    ? new PointerEvent("contextmenu", { ...options, pointerType: init.pointerType })
    : new MouseEvent("contextmenu", options);
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

/** What the native menu was last asked to show: the app's items, and where. */
function nativeMenu() {
  const call = popupTextMenu.mock.lastCall!;
  return { items: call[0], texts: call[0].map((i) => i.text), x: call[1], y: call[2] };
}

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

const press = (key: string, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

/**
 * Selects the paragraph, as a long-press selects text: in the page, and in
 * the editor, which restores it when it takes focus back. Then waits for the
 * frame in which it is read. The selection as a name is `name`.
 */
async function select(name: string, box = new DOMRect(100, 300, 80, 24)) {
  fake.selection = name;
  selectionBox = box;
  const line = paragraph();
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
  const from = view.posAtDOM(line, 0);
  act(() => view.dispatch({ selection: { anchor: from, head: from + line.textContent!.length } }));
  const range = document.createRange();
  range.selectNodeContents(line);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await selectionChanged();
}

async function selectionChanged() {
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  // The selection is read a frame later.
  await settle(50);
}

/* Desktop app: the native menu ------------------------------------------------------ */

describe("a right-click in the desktop app", () => {
  it("shows the native menu, with Add “word” to each type that holds names", async () => {
    await mount({ backend: desktop });
    fake.word = "Rose";
    const event = await rightClick(paragraph(), 120, 80);
    expect(event.defaultPrevented).toBe(true);
    expect(fake.points).toEqual([[120, 80]]);
    expect(popupTextMenu).toHaveBeenCalledOnce();
    const shown = nativeMenu();
    // Notes hold no names.
    expect(shown.texts).toEqual(["Add “Rose” to Characters", "Add “Rose” to Places"]);
    expect(shown.items.every((i) => i.enabled !== false)).toBe(true);
    expect([shown.x, shown.y]).toEqual([120, 80]);
  });

  it("adds the word: a name at once, with the caret back in the text", async () => {
    await mount({ backend: desktop });
    fake.word = "Rose";
    await rightClick(paragraph());
    // The native menu took the window's attention for a moment.
    (document.activeElement as HTMLElement).blur();
    await act(async () => nativeMenu().items[0].action());
    await settle();
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("characters", "Rose");
    expect(namesMarked("Rose")).toHaveLength(2);
    expect(namesMarked("Rose")[0].classList.contains("name-mark--characters")).toBe(true);
    expect(caretInText()).toBe(true);
    expect(note()).toBe("Rose added to Characters.");
    // No navigation: the inspector still shows This chapter.
    expect(sheetShown()).toBeNull();
  });

  it("takes the selection over the word under the pointer", async () => {
    await mount({ backend: desktop });
    fake.word = "Harbor";
    fake.selection = "Harbor Inn";
    await rightClick(paragraph());
    expect(nativeMenu().texts).toEqual(["Add “Harbor Inn” to Characters", "Add “Harbor Inn” to Places"]);
    expect(fake.points).toEqual([]);
    await act(async () => nativeMenu().items[1].action());
    await settle();
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("places", "Harbor Inn");
    expect(namesMarked("Harbor Inn")).toHaveLength(1);
  });

  it("takes the word under the pointer when the right-click is off the selection", async () => {
    await mount({ backend: desktop });
    fake.word = "Rose";
    fake.selection = "Harbor Inn";
    fake.onSelection = false;
    await rightClick(paragraph());
    expect(nativeMenu().texts).toEqual(["Add “Rose” to Characters", "Add “Rose” to Places"]);
  });

  it("offers Open for a highlighted name, which opens as a click on it would", async () => {
    await mount({ backend: desktop });
    fake.word = "Elena";
    await rightClick(namesMarked("Elena")[0]);
    expect(nativeMenu().texts).toEqual(["Open Elena Voss"]);
    await act(async () => nativeMenu().items[0].action());
    expect(sheetShown()).toBe("Elena Voss");
    expect(openedFromText()).not.toBeNull();
    expect(caretInText()).toBe(true);
    expect(createSheet).not.toHaveBeenCalled();
  });

  it("offers Open for a selection that is already a name", async () => {
    await mount({ backend: desktop });
    fake.selection = "Elena Voss";
    await rightClick(paragraph());
    expect(nativeMenu().texts).toEqual(["Open Elena Voss"]);
    await act(async () => nativeMenu().items[0].action());
    expect(sheetShown()).toBe("Elena Voss");
    // Not opened from one place in the text, so no Ignore here.
    expect(openedFromText()).toBeNull();
  });

  it("works the same in Formatted mode", async () => {
    await mount({ backend: desktop, mode: "formatted" });
    fake.word = "Rose";
    const text = [...container.querySelectorAll(".ProseMirror p")].find((p) => p.textContent?.startsWith("Rose"))!;
    await rightClick(text, 140, 90);
    expect(fake.points).toEqual([[140, 90]]);
    expect(nativeMenu().texts).toEqual(["Add “Rose” to Characters", "Add “Rose” to Places"]);
    await act(async () => nativeMenu().items[0].action());
    await settle();
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("characters", "Rose");
    expect(namesMarked("Rose")).toHaveLength(2);
  });

  it("passes no items of its own over the space between words, only the system's", async () => {
    await mount({ backend: desktop });
    const event = await rightClick(paragraph());
    expect(event.defaultPrevented).toBe(true);
    expect(nativeMenu().texts).toEqual([]);
  });

  it("leaves the menu alone outside the chapter text", async () => {
    await mount({ backend: desktop });
    fake.word = "Rose";
    const event = await rightClick(container.querySelector(".editor-column")!);
    expect(event.defaultPrevented).toBe(false);
    expect(popupTextMenu).not.toHaveBeenCalled();
  });

  it("offers no names in focus mode", async () => {
    await mount({ backend: desktop });
    await press("F11", window);
    fake.word = "Rose";
    await rightClick(paragraph());
    expect(nativeMenu().texts).toEqual([]);
    expect(fake.points).toEqual([]);
  });

  it("disables its items while the project changes on disk", async () => {
    await mount({ backend: desktop, switching: true });
    fake.word = "Rose";
    await rightClick(paragraph());
    expect(nativeMenu().items.map((i) => i.enabled)).toEqual([false, false]);
    await act(async () => nativeMenu().items[0].action());
    expect(createSheet).not.toHaveBeenCalled();
  });

  it("disables its items while a sheet chosen there is being made", async () => {
    await mount({ backend: desktop });
    const answer = deferred<string>();
    createSheet.mockReturnValueOnce(answer.promise);
    fake.word = "Rose";
    await rightClick(paragraph());
    await act(async () => nativeMenu().items[0].action());
    fake.word = "Will";
    await rightClick(paragraph());
    expect(nativeMenu().items.map((i) => i.enabled)).toEqual([false, false]);
    await act(async () => answer.resolve("sheets/characters/Rose.md"));
    await rightClick(paragraph());
    expect(nativeMenu().items.map((i) => i.enabled)).toEqual([true, true]);
  });

  it("shows a refusal where the menu was, until the next key", async () => {
    await mount({ backend: desktop });
    createSheet.mockRejectedValueOnce(new Error("sheets/characters/Rose.md already exists"));
    fake.word = "Rose";
    await rightClick(paragraph());
    await act(async () => nativeMenu().items[0].action());
    await settle();
    const shown = document.querySelector(".text-note");
    expect(shown?.querySelector(".text-note-title")?.textContent).toBe("Couldn’t add Rose to Characters");
    expect(shown?.querySelector(".text-note-message")?.textContent).toBe("sheets/characters/Rose.md already exists");
    expect(alertText()).toBe("Couldn’t add Rose to Characters. sheets/characters/Rose.md already exists");
    expect(namesMarked("Rose")).toHaveLength(0);
    await press("a");
    expect(document.querySelector(".text-note")).toBeNull();
    expect(alertText()).toBe("");
  });
});

/* Browser preview: the page's own menu ----------------------------------------------- */

describe("a right-click in the browser preview", () => {
  it("opens the page's menu over a word, titled with it: Add to each type that holds names", async () => {
    await mount();
    fake.word = "Rose";
    const event = await rightClick(paragraph(), 120, 80);
    expect(event.defaultPrevented).toBe(true);
    expect(menu()?.getAttribute("aria-label")).toBe("Add as name: Rose");
    expect(menu()?.querySelector(".popover-title")?.textContent).toBe("“Rose”");
    expect(items().map((i) => i.textContent)).toEqual(["Add to Characters", "Add to Places"]);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("adds the word: a name at once, the menu closed and the caret back in the text", async () => {
    await mount();
    fake.word = "Rose";
    await rightClick(paragraph());
    await click(item("Add to Places"));
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("places", "Rose");
    expect(menu()).toBeNull();
    expect(namesMarked("Rose")).toHaveLength(2);
    expect(namesMarked("Rose")[0].classList.contains("name-mark--places")).toBe(true);
    expect(caretInText()).toBe(true);
    expect(note()).toBe("Rose added to Places.");
  });

  it("takes the selection over the word", async () => {
    await mount();
    fake.word = "Harbor";
    fake.selection = "Harbor Inn";
    await rightClick(paragraph());
    expect(menu()?.getAttribute("aria-label")).toBe("Add as name: Harbor Inn");
    expect(fake.points).toEqual([]);
  });

  it("offers Open for a name", async () => {
    await mount();
    await rightClick(namesMarked("Elena")[0]);
    expect(menu()?.getAttribute("aria-label")).toBe("Name: Elena");
    expect(items().map((i) => i.textContent)).toEqual(["Open Elena Voss"]);
    await click(item("Open Elena Voss"));
    expect(menu()).toBeNull();
    expect(sheetShown()).toBe("Elena Voss");
    expect(openedFromText()).not.toBeNull();
  });

  it("leaves the browser's menu alone between words", async () => {
    await mount();
    const event = await rightClick(paragraph());
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("leaves the browser's menu alone for a touch, and in focus mode", async () => {
    await mount();
    fake.word = "Rose";
    const touch = await rightClick(paragraph(), 120, 80, { pointerType: "touch" });
    expect(touch.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();

    await press("F11", window);
    const focus = await rightClick(paragraph());
    expect(focus.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it("shows a refusal in the menu, which stays open", async () => {
    await mount();
    createSheet.mockRejectedValueOnce(new Error("sheets/characters/Rose.md already exists"));
    fake.word = "Rose";
    await rightClick(paragraph());
    await click(item("Add to Characters"));
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe("sheets/characters/Rose.md already exists");
    expect(container.querySelector('.editor-pane [role="alert"]')?.textContent).toBe(
      "sheets/characters/Rose.md already exists",
    );
    expect(items().every((i) => !i.disabled)).toBe(true);
  });

  it("waits while the project changes on disk", async () => {
    await mount({ switching: true });
    fake.word = "Rose";
    await rightClick(paragraph());
    expect(items().every((i) => i.disabled)).toBe(true);
    await click(item("Add to Characters"));
    expect(createSheet).not.toHaveBeenCalled();
  });
});

/* Touch screens: Add as name under a selection ------------------------------------- */

describe("a selection on a touch screen", () => {
  it("offers Add as name just below it, past the selection handles", async () => {
    await mount({ isPhone: true });
    await select("Harbor Inn", new DOMRect(100, 300, 80, 24));
    expect(button()?.textContent).toBe("Add as name");
    expect(button()?.getAttribute("aria-label")).toBe("Add as name: Harbor Inn");
    // 324 (the selection's bottom) + 28 (the handles); centred under it: 140 - 120 / 2.
    expect(button()?.style.top).toBe("352px");
    expect(button()?.style.left).toBe("80px");
  });

  it("opens the add menu from the button, and Add makes the sheet", async () => {
    await mount({ isPhone: true });
    await select("Harbor Inn");
    await click(button()!);
    expect(menu()?.getAttribute("aria-label")).toBe("Add as name: Harbor Inn");
    expect(items().map((i) => i.textContent)).toEqual(["Add to Characters", "Add to Places"]);
    // The menu takes the button's place.
    expect(button()).toBeNull();
    await click(item("Add to Places"));
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("places", "Harbor Inn");
    expect(menu()).toBeNull();
    expect(namesMarked("Harbor Inn")).toHaveLength(1);
    expect(caretInText()).toBe(true);
    await selectionChanged();
    // A name now: nothing more to add.
    expect(button()).toBeNull();
  });

  it("makes way for the menu, which opens where it was, or above the selection, never over it", async () => {
    await mount({ isPhone: true });
    // The window is 768 px tall. The button is at 352 to 392, under the selection (300 to 324).
    await select("Harbor Inn", new DOMRect(100, 300, 80, 24));
    await click(button()!);
    expect(menu()?.style.top).toBe("396px");
    expect(menu()?.style.left).toBe("80px");
    await press("Escape");

    // Lower down there is no room below the button (652 to 692): the menu goes above the selection (600 to 624).
    await select("Harbor Inn", new DOMRect(100, 600, 80, 24));
    await click(button()!);
    expect(Number.parseFloat(menu()!.style.top) + MENU.height).toBe(596);
  });

  it("comes back if the menu is closed without adding", async () => {
    await mount({ isPhone: true });
    await select("Harbor Inn");
    await click(button()!);
    await press("Escape");
    expect(menu()).toBeNull();
    await selectionChanged();
    expect(button()).not.toBeNull();
  });

  it("goes when the selection goes, or is no longer something to add", async () => {
    await mount({ isPhone: true });
    await select("Harbor Inn");
    expect(button()).not.toBeNull();
    // Already a name.
    await select("Elena");
    expect(button()).toBeNull();
    await select("Will");
    expect(button()).not.toBeNull();
    // Too long, or across paragraphs: the editor gives no name.
    await select("");
    expect(button()).toBeNull();
    await select("Will");
    document.getSelection()!.removeAllRanges();
    await selectionChanged();
    expect(button()).toBeNull();
  });

  it("stays inside the text, above the on-screen keyboard", async () => {
    await mount({ isPhone: true });
    // The keyboard takes the bottom of the screen: 500 px are left.
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetTop: 0, offsetLeft: 0, width: 412, height: 500, addEventListener() {}, removeEventListener() {} },
    });
    await select("Will", new DOMRect(370, 440, 36, 24));
    // Above the keyboard's edge, 8 px clear: 500 - 8 - 40. Inside the right edge: 412 - 8 - 120.
    expect(button()?.style.top).toBe("452px");
    expect(button()?.style.left).toBe("284px");
  });

  it("isn't offered for a selection scrolled out of sight", async () => {
    await mount({ isPhone: true });
    await select("Will", new DOMRect(100, 20, 36, 24));
    expect(button()).toBeNull();
  });

  it("isn't offered on a device with a mouse, which has the right-click", async () => {
    await mount({ hover: true });
    await select("Harbor Inn");
    expect(button()).toBeNull();
  });

  it("isn't offered in focus mode", async () => {
    await mount({ isPhone: true });
    await select("Harbor Inn");
    expect(button()).not.toBeNull();
    await press("F11", window);
    expect(button()).toBeNull();
    await selectionChanged();
    expect(button()).toBeNull();
  });

  it("isn't offered while the project changes on disk", async () => {
    await mount({ isPhone: true, switching: true });
    await select("Harbor Inn");
    expect(button()).toBeNull();
  });

  it("is offered on a tablet too: a touch screen in the desktop layout", async () => {
    await mount({ hover: false });
    await select("Harbor Inn");
    expect(button()).not.toBeNull();
  });
});
