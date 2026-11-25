// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import type { Editor } from "@tiptap/core";
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tidyTextMenu, TEXT_MENU_SEPARATOR, type Backend, type TextMenuEntry, type TextMenuItem } from "../../core/backend";
import { buildNameMatcher, buildProject, withSheetText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS, type EditorMode } from "../../core/settings";
import { newSheetPath, newSheetText } from "../../core/sheetFile";
import { readPersonalDictionary, spellingKey } from "../../core/spelling";
import type { useProject } from "../../core/useProject";
import { HOVER_QUERY } from "../hooks";
import { Workspace } from "../Workspace";

/*
 * jsdom has no layout, so the editors' words under the pointer are faked
 * here: the word to check is found in the editor's text by its spelling,
 * at its real place, so replacing it is the editors' own work. The
 * editors' own tests cover finding words on screen.
 */
const fake = vi.hoisted(() => ({
  /** The word under the pointer, as a name would be written. */
  word: null as string | null,
  /** The word the spelling check reads under the pointer: its first use in the text. */
  spelling: null as string | null,
  selection: "",
  onSelection: null as boolean | null,
}));
const clickedOnSelection = () => fake.onSelection ?? fake.selection !== "";
const firstUse = (text: string, word: string) => text.search(new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, "u"));

vi.mock("../../core/editor/codemirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/editor/codemirror")>();
  return {
    ...actual,
    plainWordAt: () => fake.word,
    plainSelectedName: () => fake.selection,
    plainSelectionContains: () => clickedOnSelection(),
    plainSpellingWordAt: (view: EditorView) => {
      const word = fake.spelling;
      const at = word ? firstUse(view.state.doc.toString(), word) : -1;
      return word && at !== -1 ? { word, from: at, to: at + word.length } : null;
    },
  };
});

vi.mock("../../core/editor/prosemirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/editor/prosemirror")>();
  return {
    ...actual,
    wordAtPoint: () => fake.word,
    selectedNameIn: () => fake.selection,
    selectionContainsPoint: () => clickedOnSelection(),
    spellingWordAtPoint: (view: { state: { doc: import("@tiptap/pm/model").Node } }) => {
      const word = fake.spelling;
      if (!word) return null;
      let found: { word: string; from: number; to: number } | null = null;
      view.state.doc.descendants((node, pos) => {
        if (found || !node.isText) return;
        const at = firstUse(node.text ?? "", word);
        if (at !== -1) found = { word, from: pos + at, to: pos + at + word.length };
      });
      return found;
    },
  };
});

const C = "manuscript/01 C.md";
const SENTENCE = "The skif was moored at the jety. Rose met Elena there.";

/** "skif" and "jety" are misspelled; Elena has a sheet. */
function makeProject(): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson: null,
    files: [
      { path: C, text: `# C\n\n${SENTENCE}\n` },
      { path: "sheets/characters/Elena Voss.md", text: "---\nname: Elena Voss\naliases: [Elena]\n---\n" },
    ],
    skipped: [],
  });
}

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

const createSheet = vi.fn(async (kind: string, name: string) => {
  const id = newSheetPath(latest, kind, name);
  apply(withSheetText(latest, id, newSheetText(name)));
  return id;
});

/** As useProject's addToDictionary: the word joins dictionary.txt, accepted at once. */
const addToDictionary = vi.fn((word: string) => {
  apply({ ...latest, dictionary: [...latest.dictionary, spellingKey(word)] });
});

/* Backends: a dictionary that knows every word but two ------------------------ */

const MISSPELLED = new Set(["skif", "jety"]);
const CORRECTIONS: Record<string, string[]> = { skif: ["skiff", "skid"], jety: ["jetty", "jet"] };

const checkWords = vi.fn(async (_language: string, words: string[]) => words.map((w) => !MISSPELLED.has(w)));
const suggestWords = vi.fn(async (_language: string, word: string): Promise<string[] | null> => CORRECTIONS[word] ?? []);

const browser = {
  kind: "browser",
  canOpenFolders: false,
  canCreateProjects: false,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
  checkWords,
  suggestWords,
} as unknown as Backend;

/** The desktop app's native text menu: records what it was asked to show. */
const popupTextMenu = vi.fn(async (_entries: TextMenuEntry[], _x: number, _y: number) => undefined);

const desktop = { ...browser, kind: "app", canOpenFolders: true, popupTextMenu } as unknown as Backend;

const listVersions = async () => [];
const restoreVersion = async () => undefined;
const listProjects = async () => [];

interface Mount {
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
      addToDictionary,
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
  // Tiptap reports "create" on the next tick, and focuses the text a frame later; the dictionary answers meanwhile.
  await settle();
  await nextFrame();
  await settle();
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Tiptap gives the text focus in the next animation frame. */
const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
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
  addToDictionary.mockClear();
  checkWords.mockClear();
  suggestWords.mockClear();
  popupTextMenu.mockClear();
  localStorage.clear();
  fake.word = null;
  fake.spelling = null;
  fake.selection = "";
  fake.onSelection = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/* Finding things and acting ----------------------------------------------------- */

/** The words marked as misspelled in the text, in either editor. */
const marked = () =>
  [...container.querySelectorAll<HTMLElement>(".editor-surface .spelling-mark")].map((m) => m.dataset.word);
const mark = (word: string) => container.querySelector<HTMLElement>(`.editor-surface .spelling-mark[data-word="${word}"]`)!;
const paragraph = () =>
  [...container.querySelectorAll(".cm-line, .ProseMirror p")].find((l) => l.textContent?.startsWith("The s"))!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const item = (text: string) => items().find((i) => i.textContent === text)!;
const corrections = () => [...(menu()?.querySelectorAll(".spelling-correction") ?? [])].map((i) => i.textContent);
/** What the editor pane says to screen readers, politely, and in an alert (the menu's, then its own). */
const note = () => container.querySelector('.editor-pane > p.visually-hidden[role="status"]')?.textContent;
const alerts = () =>
  [...container.querySelectorAll('.editor-pane > p.visually-hidden[role="alert"]')]
    .map((p) => p.textContent)
    .filter((t) => t !== "");
const caretInText = () => document.activeElement?.closest(".editor-surface") != null;

/** The chapter's paragraph as the editor holds it. */
const plainText = () => EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!.state.doc.toString();
const plainCaret = () => EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!.state.selection.main.head;
/** Tiptap keeps its editor on its element. */
const formatted = () => (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;

async function rightClick(el: Element, x = 120, y = 80) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await settle();
  return event;
}

/** Right-clicks a word: the pointer is over it, as a name and for the spelling check. */
const rightClickWord = (word: string) => {
  fake.word = word;
  fake.spelling = word;
  return rightClick(MISSPELLED.has(word) ? mark(word) : paragraph());
};

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

const press = (key: string, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

/** What the native menu was last asked to show: each item's text, "—" for a separator. */
function nativeMenu() {
  const entries = popupTextMenu.mock.lastCall![0];
  const texts = entries.map((e) => ("separator" in e ? "—" : e.text));
  const itemNamed = (text: string) => entries.find((e): e is TextMenuItem => !("separator" in e) && e.text === text)!;
  return { entries, texts, item: itemNamed };
}

/** Storage that refuses to keep anything, as when the browser blocks it. */
function blockStorage() {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("The quota has been exceeded.");
  });
}

/* The marks ---------------------------------------------------------------------- */

describe("misspelled words in the text", () => {
  it("are marked in Plain mode, and not as names", async () => {
    await mount();
    expect(marked()).toEqual(["skif", "jety"]);
    expect(mark("skif").classList.contains("name-mark")).toBe(false);
    expect(mark("skif").classList.contains("possible-name")).toBe(false);
  });

  it("are marked the same in Formatted mode", async () => {
    await mount({ mode: "formatted" });
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
    expect(marked()).toEqual(["skif", "jety"]);
  });

  it("are not marked in focus mode, which offers no corrections either", async () => {
    await mount();
    await press("F11", window);
    expect(marked()).toEqual([]);
    fake.word = "skif";
    fake.spelling = "skif";
    const event = await rightClick(paragraph());
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });
});

/* Browser preview: the page's own menu ----------------------------------------------- */

describe("a right-click on a misspelled word in the browser preview", () => {
  it("opens the spelling menu, titled with the word: corrections, the dictionaries, then Add to each type", async () => {
    await mount();
    const event = await rightClickWord("skif");
    expect(event.defaultPrevented).toBe(true);
    expect(suggestWords).toHaveBeenCalledOnce();
    expect(suggestWords.mock.lastCall?.[1]).toBe("skif");
    expect(menu()?.getAttribute("aria-label")).toBe("Spelling: skif");
    expect(menu()?.querySelector(".popover-title")?.textContent).toBe("“skif”");
    expect(items().map((i) => i.textContent)).toEqual([
      "skiff",
      "skid",
      "Add to project dictionary",
      "Add to my dictionary",
      "Add to Characters",
      "Add to Places",
    ]);
    // Groups set apart by space.
    expect(menu()?.querySelectorAll(".popover-gap")).toHaveLength(2);
    // The best correction takes focus once it is there.
    expect(document.activeElement).toBe(item("skiff"));
  });

  it("replaces the word with the correction chosen, with the caret after it", async () => {
    await mount();
    await rightClickWord("skif");
    await click(item("skiff"));
    expect(plainText()).toContain("The skiff was moored at the jety.");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    expect(plainCaret()).toBe(plainText().indexOf("skiff") + "skiff".length);
    expect(marked()).toEqual(["jety"]);
    expect(note()).toBe("skif changed to skiff.");
  });

  it("replaces the word in Formatted mode too, as one step to undo", async () => {
    await mount({ mode: "formatted" });
    await rightClickWord("skif");
    await click(item("skid"));
    await nextFrame();
    const editor = formatted();
    expect(editor.state.doc.textContent).toContain("The skid was moored");
    expect(caretInText()).toBe(true);
    const { head } = editor.state.selection;
    expect(editor.state.doc.textBetween(0, head, "\n")).toBe("C\nThe skid");
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent).toContain(SENTENCE);
  });

  it("adds the word to the project's dictionary: its mark goes at once", async () => {
    await mount();
    await rightClickWord("skif");
    await click(item("Add to project dictionary"));
    expect(addToDictionary).toHaveBeenCalledExactlyOnceWith("skif");
    expect(marked()).toEqual(["jety"]);
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    expect(note()).toBe("skif added to the project dictionary.");
  });

  it("adds the word to the personal dictionary, for every project on this device: its mark goes at once", async () => {
    await mount();
    await rightClickWord("jety");
    await click(item("Add to my dictionary"));
    expect(readPersonalDictionary()).toEqual(["jety"]);
    expect(addToDictionary).not.toHaveBeenCalled();
    expect(marked()).toEqual(["skif"]);
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    expect(note()).toBe("jety added to your dictionary, for every project on this device.");
  });

  it("shows a refusal to remember the word in the menu, which stays open", async () => {
    await mount();
    blockStorage();
    await rightClickWord("skif");
    await click(item("Add to my dictionary"));
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe(
      "Couldn’t add skif to your dictionary. The quota has been exceeded.",
    );
    expect(alerts()).toEqual(["Couldn’t add skif to your dictionary. The quota has been exceeded."]);
    expect(marked()).toEqual(["skif", "jety"]);
    expect(items().every((i) => !i.disabled)).toBe(true);
  });

  it("adds the word as a name: a misspelled word may be one", async () => {
    await mount();
    await rightClickWord("skif");
    await click(item("Add to Places"));
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("places", "skif");
    expect(menu()).toBeNull();
    expect(note()).toBe("skif added to Places.");
  });

  it("refuses a correction when the word has changed since the menu opened", async () => {
    await mount();
    await rightClickWord("skif");
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
    const at = plainText().indexOf("skif");
    act(() => view.dispatch({ changes: { from: at, to: at + 4, insert: "boat" } }));
    await click(item("skiff"));
    expect(plainText()).toContain("The boat was moored");
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe(
      "Couldn’t change skif. The text there has changed since the menu opened.",
    );
  });

  it("waits while another project opens", async () => {
    await mount({ switching: true });
    await rightClickWord("skif");
    expect(item("skiff").disabled).toBe(true);
    expect(item("Add to project dictionary").disabled).toBe(true);
    await click(item("Add to project dictionary"));
    expect(addToDictionary).not.toHaveBeenCalled();
    // The personal dictionary is this device's, not the project's.
    expect(item("Add to my dictionary").disabled).toBe(false);
  });

  it("closes on Escape, with the caret back in the text", async () => {
    await mount();
    await rightClickWord("skif");
    await press("Escape");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
  });

  it("leaves a word spelled right to the add-name menu, as before", async () => {
    await mount();
    await rightClickWord("Rose");
    expect(menu()?.getAttribute("aria-label")).toBe("Add as name: Rose");
    expect(suggestWords).not.toHaveBeenCalled();
  });

  it("leaves a selection that could be a name to the add-name menu, unless it is the word itself", async () => {
    await mount();
    fake.selection = "skif was";
    await rightClickWord("skif");
    expect(menu()?.getAttribute("aria-label")).toBe("Add as name: skif was");
    await press("Escape");

    fake.selection = "skif";
    await rightClickWord("skif");
    expect(menu()?.getAttribute("aria-label")).toBe("Spelling: skif");
  });
});

describe("the spelling menu's corrections", () => {
  it("show placeholder rows while they are looked up, then the corrections", async () => {
    await mount();
    const answer = deferred<string[] | null>();
    suggestWords.mockReturnValueOnce(answer.promise);
    await rightClickWord("skif");
    expect(menu()?.querySelector(".spelling-loading .skeleton")).not.toBeNull();
    expect(menu()?.getAttribute("aria-busy")).toBe("true");
    expect(corrections()).toEqual([]);
    // The dictionaries don't wait for them.
    expect(item("Add to project dictionary").disabled).toBe(false);

    await act(async () => answer.resolve(["skiff"]));
    expect(menu()?.querySelector(".spelling-loading")).toBeNull();
    expect(menu()?.hasAttribute("aria-busy")).toBe(false);
    expect(corrections()).toEqual(["skiff"]);
    expect(document.activeElement).toBe(item("skiff"));
  });

  it("leave focus where it was moved while they were looked up", async () => {
    await mount();
    const answer = deferred<string[] | null>();
    suggestWords.mockReturnValueOnce(answer.promise);
    await rightClickWord("skif");
    await press("ArrowDown");
    expect(document.activeElement).toBe(item("Add to my dictionary"));
    await act(async () => answer.resolve(["skiff"]));
    expect(document.activeElement).toBe(item("Add to my dictionary"));
  });

  it("say so when there are none, or no dictionary to ask", async () => {
    await mount();
    suggestWords.mockResolvedValueOnce([]);
    await rightClickWord("skif");
    expect(item("No suggestions").disabled).toBe(true);
    expect(corrections()).toEqual([]);
    await press("Escape");

    suggestWords.mockResolvedValueOnce(null);
    await rightClickWord("skif");
    expect(item("No suggestions").disabled).toBe(true);
  });

  it("say why when they can't be had, and the dictionaries still work", async () => {
    await mount();
    suggestWords.mockRejectedValueOnce(new Error("The dictionary couldn’t be read."));
    await rightClickWord("skif");
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe(
      "Couldn’t get suggestions. The dictionary couldn’t be read.",
    );
    expect(alerts()).toEqual(["Couldn’t get suggestions. The dictionary couldn’t be read."]);
    expect(menu()?.hasAttribute("aria-busy")).toBe(false);
    await click(item("Add to project dictionary"));
    expect(addToDictionary).toHaveBeenCalledExactlyOnceWith("skif");
  });
});

/* Desktop app: the native menu -------------------------------------------------------- */

describe("a right-click on a misspelled word in the desktop app", () => {
  it("starts the native menu with the corrections, then the dictionaries, then the name items, set apart", async () => {
    await mount({ backend: desktop });
    const event = await rightClickWord("skif");
    expect(event.defaultPrevented).toBe(true);
    expect(popupTextMenu).toHaveBeenCalledOnce();
    expect(nativeMenu().texts).toEqual([
      "skiff",
      "skid",
      "—",
      "Add “skif” to project dictionary",
      "Add “skif” to my dictionary",
      "—",
      "Add “skif” to Characters",
      "Add “skif” to Places",
    ]);
    expect(popupTextMenu.mock.lastCall?.slice(1)).toEqual([120, 80]);
  });

  it("replaces the word with a correction chosen there, the caret back in the text after it", async () => {
    await mount({ backend: desktop });
    await rightClickWord("skif");
    // The native menu took the window's attention for a moment.
    (document.activeElement as HTMLElement).blur();
    await act(async () => nativeMenu().item("skiff").action());
    expect(plainText()).toContain("The skiff was moored");
    expect(caretInText()).toBe(true);
    expect(plainCaret()).toBe(plainText().indexOf("skiff") + "skiff".length);
    expect(note()).toBe("skif changed to skiff.");
  });

  it("adds the word to either dictionary from there: its mark goes at once", async () => {
    await mount({ backend: desktop });
    await rightClickWord("skif");
    await act(async () => nativeMenu().item("Add “skif” to project dictionary").action());
    expect(addToDictionary).toHaveBeenCalledExactlyOnceWith("skif");
    expect(note()).toBe("skif added to the project dictionary.");

    await rightClickWord("jety");
    await act(async () => nativeMenu().item("Add “jety” to my dictionary").action());
    expect(readPersonalDictionary()).toEqual(["jety"]);
    expect(marked()).toEqual([]);
    expect(caretInText()).toBe(true);
  });

  it("says, greyed, that there are no corrections, or that they couldn't be had", async () => {
    await mount({ backend: desktop });
    suggestWords.mockResolvedValueOnce([]);
    await rightClickWord("skif");
    expect(nativeMenu().entries[0]).toMatchObject({ text: "No suggestions", enabled: false });
    expect(nativeMenu().texts.slice(1, 3)).toEqual(["—", "Add “skif” to project dictionary"]);

    suggestWords.mockRejectedValueOnce(new Error("The dictionary couldn’t be read."));
    await rightClickWord("skif");
    expect(nativeMenu().entries[0]).toMatchObject({ text: "Couldn’t get suggestions", enabled: false });
    expect(nativeMenu().texts).toContain("Add “skif” to my dictionary");
  });

  it("shows a refusal to remember the word where the menu was", async () => {
    await mount({ backend: desktop });
    blockStorage();
    await rightClickWord("skif");
    await act(async () => nativeMenu().item("Add “skif” to my dictionary").action());
    const shown = document.querySelector(".text-note");
    expect(shown?.querySelector(".text-note-title")?.textContent).toBe("Couldn’t add skif to your dictionary");
    expect(shown?.querySelector(".text-note-message")?.textContent).toBe("The quota has been exceeded.");
    expect(alerts()).toEqual(["Couldn’t add skif to your dictionary. The quota has been exceeded."]);
    expect(marked()).toEqual(["skif", "jety"]);
  });

  it("disables the corrections and the project's dictionary while another project opens", async () => {
    await mount({ backend: desktop, switching: true });
    await rightClickWord("skif");
    const enabled = (text: string) => nativeMenu().item(text).enabled !== false;
    expect(enabled("skiff")).toBe(false);
    expect(enabled("Add “skif” to project dictionary")).toBe(false);
    expect(enabled("Add “skif” to my dictionary")).toBe(true);
  });

  it("gives a word spelled right the menu as before, without asking for corrections", async () => {
    await mount({ backend: desktop });
    await rightClickWord("Rose");
    expect(nativeMenu().texts).toEqual(["Add “Rose” to Characters", "Add “Rose” to Places"]);
    expect(suggestWords).not.toHaveBeenCalled();
  });
});

/* Touch screens: a tap on the word ------------------------------------------------------ */

describe("a tap on a misspelled word on a touch screen", () => {
  it("opens its menu on a phone, and a correction replaces the word", async () => {
    await mount({ isPhone: true });
    fake.spelling = "skif";
    await click(mark("skif"));
    await settle();
    expect(menu()?.getAttribute("aria-label")).toBe("Spelling: skif");
    expect(corrections()).toEqual(["skiff", "skid"]);
    await click(item("skiff"));
    expect(plainText()).toContain("The skiff was moored");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    // Correcting opens nothing else on a phone.
    expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
  });

  it("opens it in Formatted mode too", async () => {
    await mount({ isPhone: true, mode: "formatted" });
    fake.spelling = "jety";
    // ProseMirror takes a click from its own mousedown and mouseup, which need a layout: its click handler is called here.
    const { view } = formatted();
    await act(async () => {
      view.someProp("handleClick", (handle) => handle(view, 0, { target: mark("jety") } as unknown as MouseEvent));
    });
    await settle();
    expect(menu()?.getAttribute("aria-label")).toBe("Spelling: jety");
    await click(item("Add to project dictionary"));
    expect(addToDictionary).toHaveBeenCalledExactlyOnceWith("jety");
    expect(marked()).toEqual(["skif"]);
  });

  it("opens it even where the word can't be found again, without correcting it", async () => {
    await mount({ isPhone: true });
    fake.spelling = null;
    await click(mark("skif"));
    await settle();
    await click(item("skiff"));
    expect(plainText()).toContain(SENTENCE);
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe(
      "Couldn’t change skif. The text there has changed since the menu opened.",
    );
  });

  it("only places the caret with a mouse, which has the right-click", async () => {
    await mount({ hover: true });
    fake.spelling = "skif";
    await click(mark("skif"));
    await settle();
    expect(menu()).toBeNull();
  });
});

/* The native menu's groups --------------------------------------------------------------- */

describe("tidyTextMenu", () => {
  const item = (text: string) => ({ text, action: () => undefined });

  it("keeps a separator only between two groups", () => {
    const tidy = tidyTextMenu([
      TEXT_MENU_SEPARATOR,
      item("a"),
      TEXT_MENU_SEPARATOR,
      TEXT_MENU_SEPARATOR,
      item("b"),
      TEXT_MENU_SEPARATOR,
    ]);
    expect(tidy.map((e) => ("separator" in e ? "—" : e.text))).toEqual(["a", "—", "b"]);
    expect(tidyTextMenu([TEXT_MENU_SEPARATOR])).toEqual([]);
  });
});
