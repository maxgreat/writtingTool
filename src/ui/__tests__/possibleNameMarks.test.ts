// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { withNotName } from "../../core/nameChoices";
import { buildNameMatcher, buildProject, withSheetText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS, type EditorMode } from "../../core/settings";
import { newSheetPath, newSheetText } from "../../core/sheetFile";
import type { useProject } from "../../core/useProject";
import { HOVER_QUERY } from "../hooks";
import { Workspace } from "../Workspace";

const C = "manuscript/01 C.md";
const D = "manuscript/02 D.md";

/** Mara: three times, so offered even without a dictionary. Kit: twice. Elena has a sheet. */
function makeProject(): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson: null,
    files: [
      { path: C, text: "# C\n\nElena met Mara. She saw Mara twice. Ask Mara. Then Kit came. Then Kit left.\n" },
      { path: D, text: "# D\n\nNothing here.\n" },
      { path: "sheets/characters/Elena Voss.md", text: "---\nname: Elena Voss\naliases: [Elena]\n---\n" },
    ],
    skipped: [],
  });
}

/** A promise to resolve by hand, to control when the core answers. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* The project as useProject would keep it ------------------------------------ */

let latest: Project;
let showProject: (project: Project) => void = () => undefined;

function apply(next: Project) {
  latest = next;
  showProject(next);
}

/** As useProject's createSheet: the sheet joins the project, and its id comes back. */
const createSheet = vi.fn(async (kind: string, name: string) => {
  const id = newSheetPath(latest, kind, name);
  apply(withSheetText(latest, id, newSheetText(name)));
  return id;
});

/** As useProject's markNotName: saved in project.json; throws, changing nothing, when it can't be read. */
const markNotName = vi.fn((word: string, notName = true) => {
  const change = withNotName(latest, word, notName);
  if (change) apply(change.project);
});

/* The workspace ------------------------------------------------------------- */

const browser = {
  kind: "browser",
  canOpenFolders: false,
  canCreateProjects: false,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
} as unknown as Backend;

/** The app, with a dictionary in which no word of the test book is an ordinary word. */
const withDictionary = {
  ...browser,
  kind: "app",
  ordinaryWords: async (_language: string, words: string[]) => words.map(() => false),
} as unknown as Backend;

// Stable, as useProject's are.
const listVersions = async () => [];
const restoreVersion = async () => undefined;
const listProjects = async () => [];

function useMatchMedia({ phone = false, hover = false }) {
  window.matchMedia = ((query: string) => ({
    matches: (phone && query === "(pointer: coarse)") || (hover && query === HOVER_QUERY),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

interface Mount {
  isPhone?: boolean;
  mode?: EditorMode;
  backend?: Backend;
  switching?: boolean;
  hover?: boolean;
}

async function mount({ isPhone = false, mode = "plain", backend = browser, switching = false, hover = false }: Mount = {}) {
  useMatchMedia({ phone: isPhone, hover });
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
      markNotName,
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
  // Tiptap reports "create" on the next tick; the dictionary answers meanwhile.
  await settle();
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  latest = makeProject();
  createSheet.mockClear();
  markNotName.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* Finding things -------------------------------------------------------------- */

/** The words marked as possible names in the text, in either editor. */
const marked = () =>
  [...container.querySelectorAll<HTMLElement>(".editor-surface .possible-name")].map((m) => m.dataset.word);
const namesMarked = (name: string) =>
  [...container.querySelectorAll(".editor-surface .name-mark")].filter((m) => m.textContent === name);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const item = (text: string) => items().find((i) => i.textContent === text)!;
/** What the editor pane says to screen readers. */
const note = () => container.querySelector('.editor-pane > p.visually-hidden[role="status"]')?.textContent;
const caretInText = () => document.activeElement?.closest(".editor-surface") != null;

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

async function openMenu() {
  await click(container.querySelector(".cm-content .possible-name")!);
}

const press = (key: string, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

/* Tests ------------------------------------------------------------------------ */

describe("possible names in the text", () => {
  it("are the words the book's possible names hold: three uses without a dictionary", async () => {
    await mount();
    expect(marked()).toEqual(["Mara", "Mara", "Mara"]);
    // A dotted mark, not a name's.
    expect(container.querySelector(".possible-name")?.classList.contains("name-mark")).toBe(false);
  });

  it("are every word that isn't a dictionary word, from its first use, with one", async () => {
    await mount({ backend: withDictionary });
    expect(marked()).toEqual(["Mara", "Mara", "Mara", "Kit", "Kit"]);
  });

  it("are marked in Formatted mode too", async () => {
    await mount({ mode: "formatted" });
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
    expect(marked()).toEqual(["Mara", "Mara", "Mara"]);
  });

  it("are hidden in focus mode, and back when it ends", async () => {
    await mount();
    await press("F11", window);
    expect(container.querySelector(".workspace")?.classList.contains("is-focus")).toBe(true);
    expect(marked()).toEqual([]);
    await press("F11", window);
    expect(marked()).toEqual(["Mara", "Mara", "Mara"]);
  });

  it("show no name card under the pointer, as names do", async () => {
    await mount({ hover: true });
    const hoverOver = async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      await settle();
    };
    await hoverOver(container.querySelector(".cm-content .possible-name")!);
    expect(document.querySelector(".name-card")).toBeNull();
    // A name, by contrast, shows its card.
    await hoverOver(namesMarked("Elena")[0]);
    expect(document.querySelector(".name-card")).not.toBeNull();
  });
});

describe("the menu on a possible name", () => {
  it("opens on a click, with Add to for each type that holds names, and Not a name", async () => {
    await mount();
    await openMenu();
    expect(menu()?.getAttribute("aria-label")).toBe("Possible name: Mara");
    expect(menu()?.querySelector(".popover-title")?.textContent).toBe("Possible name");
    // Notes hold no names.
    expect(items().map((i) => i.textContent)).toEqual(["Add to Characters", "Add to Places", "Not a name"]);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("adds the word as a sheet: a name at once, with the caret back in the text and the inspector where it was", async () => {
    await mount();
    await openMenu();
    await click(item("Add to Places"));
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("places", "Mara");
    expect(menu()).toBeNull();
    expect(namesMarked("Mara")).toHaveLength(3);
    expect(namesMarked("Mara")[0].classList.contains("name-mark--places")).toBe(true);
    expect(marked()).toEqual([]);
    expect(caretInText()).toBe(true);
    expect(note()).toBe("Mara added to Places.");
    // No navigation: the inspector still shows This chapter.
    expect(container.querySelector(".inspector .chapter-info")).not.toBeNull();
  });

  it("waits while the sheet is being made", async () => {
    await mount();
    const answer = deferred<string>();
    createSheet.mockReturnValueOnce(answer.promise);
    await openMenu();
    await click(item("Add to Characters"));
    expect(menu()?.getAttribute("aria-busy")).toBe("true");
    expect(items().every((i) => i.disabled)).toBe(true);
    await click(item("Not a name"));
    expect(markNotName).not.toHaveBeenCalled();

    await act(async () => answer.resolve("sheets/characters/Mara.md"));
    expect(menu()).toBeNull();
  });

  it("shows and announces a refusal, and stays open with the item pressed focused", async () => {
    await mount();
    createSheet.mockRejectedValueOnce(new Error("sheets/characters/Mara.md already exists"));
    await openMenu();
    const add = item("Add to Characters");
    add.focus();
    await click(add);
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe("sheets/characters/Mara.md already exists");
    expect(container.querySelector('.editor-pane [role="alert"]')?.textContent).toBe(
      "sheets/characters/Mara.md already exists",
    );
    expect(items().some((i) => i.disabled)).toBe(false);
    expect(document.activeElement).toBe(item("Add to Characters"));
    expect(marked()).toEqual(["Mara", "Mara", "Mara"]);
  });

  it("marks the word as not a name: its marks go everywhere, and Undo takes the place of Not a name", async () => {
    await mount();
    await openMenu();
    const notName = item("Not a name");
    notName.focus();
    await click(notName);
    expect(markNotName).toHaveBeenCalledExactlyOnceWith("Mara", true);
    expect(latest.notNames).toEqual(["Mara"]);
    expect(marked()).toEqual([]);
    expect(items().map((i) => i.textContent)).toEqual(["Undo"]);
    expect(menu()?.querySelector(".popover-title")?.textContent).toBe("Not a name");
    // The same item, so focus stays on it.
    expect(document.activeElement).toBe(notName);
    expect(note()).toBe("Mara won’t be offered as a name again.");

    await click(notName);
    expect(markNotName).toHaveBeenLastCalledWith("Mara", false);
    expect(marked()).toEqual(["Mara", "Mara", "Mara"]);
    expect(note()).toBe("Mara is offered as a name again.");
  });

  it("shows a refusal to mark the word", async () => {
    markNotName.mockImplementationOnce(() => {
      throw new Error("project.json could not be read.");
    });
    await mount();
    await openMenu();
    await click(item("Not a name"));
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe("project.json could not be read.");
    expect(container.querySelector('.editor-pane [role="alert"]')?.textContent).toBe("project.json could not be read.");
    expect(items().map((i) => i.textContent)).toEqual(["Add to Characters", "Add to Places", "Not a name"]);
    expect(marked()).toEqual(["Mara", "Mara", "Mara"]);
  });

  it("waits while the project changes on disk", async () => {
    await mount({ switching: true });
    await openMenu();
    expect(items()).toHaveLength(3);
    expect(items().every((i) => i.disabled)).toBe(true);
    await click(item("Add to Characters"));
    await click(item("Not a name"));
    expect(createSheet).not.toHaveBeenCalled();
    expect(markNotName).not.toHaveBeenCalled();
  });

  it("starts afresh for each word clicked", async () => {
    await mount({ backend: withDictionary });
    await openMenu();
    await click(item("Not a name"));
    expect(items().map((i) => i.textContent)).toEqual(["Undo"]);
    // Another word clicked while the menu is open, with no press outside first (as assistive technology does).
    await click(container.querySelector('.cm-content .possible-name[data-word="Kit"]')!);
    expect(menu()?.getAttribute("aria-label")).toBe("Possible name: Kit");
    expect(items().map((i) => i.textContent)).toEqual(["Add to Characters", "Add to Places", "Not a name"]);
  });

  it("closes on Escape, with the caret back in the text", async () => {
    await mount();
    await openMenu();
    expect(caretInText()).toBe(false);
    await press("Escape");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
  });

  it("opens from a tap on a phone too, where adding opens no preview", async () => {
    await mount({ isPhone: true });
    await openMenu();
    expect(items().map((i) => i.textContent)).toEqual(["Add to Characters", "Add to Places", "Not a name"]);
    await click(item("Add to Characters"));
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("characters", "Mara");
    expect(menu()).toBeNull();
    expect(namesMarked("Mara")).toHaveLength(3);
    expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
  });
});
