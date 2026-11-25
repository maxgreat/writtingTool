// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import type { Editor } from "@tiptap/core";
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tidyTextMenu, type Backend, type GrammarProblem, type TextMenuEntry, type TextMenuItem } from "../../core/backend";
import { buildNameMatcher, buildProject, type Project } from "../../core/project";
import { DEFAULT_SETTINGS, type EditorMode } from "../../core/settings";
import type { Grammar } from "../../core/useGrammar";
import type { useProject } from "../../core/useProject";
import { fixLabel, grammarTextMenuItems, shortened } from "../GrammarMenu";
import { HOVER_QUERY } from "../hooks";
import { StatusBar } from "../StatusBar";
import { Workspace } from "../Workspace";

/*
 * The grammar check itself (useGrammar) has its own tests: here it answers
 * at once with the problems below, so the menus can be tried. jsdom has no
 * layout, so what is under the pointer is faked as in the spelling menu's
 * tests; the marks, and finding their text in the editors, are real.
 */
const fake = vi.hoisted(() => ({
  grammar: { problems: new Map(), error: null } as { problems: ReadonlyMap<string, readonly unknown[]>; error: string | null },
  /** The word under the pointer, as a name would be written. */
  word: null as string | null,
  selection: "",
  onSelection: null as boolean | null,
}));
const clickedOnSelection = () => fake.onSelection ?? fake.selection !== "";

vi.mock("../../core/useGrammar", () => ({ useGrammar: (): Grammar => fake.grammar as Grammar }));

vi.mock("../../core/editor/codemirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/editor/codemirror")>();
  return {
    ...actual,
    plainWordAt: () => fake.word,
    plainSelectedName: () => fake.selection,
    plainSelectionContains: () => clickedOnSelection(),
    plainSpellingWordAt: () => null,
  };
});

vi.mock("../../core/editor/prosemirror", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/editor/prosemirror")>();
  return {
    ...actual,
    wordAtPoint: () => fake.word,
    selectedNameIn: () => fake.selection,
    selectionContainsPoint: () => clickedOnSelection(),
    spellingWordAtPoint: () => null,
  };
});

const C = "manuscript/01 C.md";
const SENTENCE = "She have a skiff by the the jetty.";
const AGREEMENT = "Use “has” with a singular subject such as “She”.";
const REPEATED = "The word “the” is repeated.";

/** "have" should agree with "She"; the second "the" (with its space) repeats the first. */
const PROBLEMS: GrammarProblem[] = [
  { from: 4, to: 8, message: AGREEMENT, kind: "Agreement", fixes: ["has", "had"] },
  { from: 23, to: 27, message: REPEATED, kind: "Repetition", fixes: [""] },
];

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

/* Backends: no dictionary, so nothing is marked but grammar ---------------------- */

const browser = {
  kind: "browser",
  canOpenFolders: false,
  canCreateProjects: false,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
} as unknown as Backend;

/** The desktop app's native text menu: records what it was asked to show. */
const popupTextMenu = vi.fn(async (_entries: TextMenuEntry[], _x: number, _y: number) => undefined);

const desktop = { ...browser, kind: "app", canOpenFolders: true, popupTextMenu } as unknown as Backend;

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
  const project = makeProject();
  function Harness() {
    const [current] = useState<Project>(project);
    const matcher = useMemo(() => buildNameMatcher(current.sheets, current.ignoredNames), [current.sheets, current.ignoredNames]);
    const api = {
      backend,
      load: { status: "ready" },
      project: current,
      matcher,
      openChapterId: C,
      openChapter: () => undefined,
      updateChapter: () => undefined,
      ignoreName: () => undefined,
      createSheet: async () => "",
      markNotName: () => undefined,
      addToDictionary: () => undefined,
      save: { status: "saved" },
      saveNow: async () => undefined,
      openFolder: async () => undefined,
      openProjectAt: async () => undefined,
      createProject: async () => undefined,
      listProjects: async () => [],
      listVersions: async () => [],
      restoreVersion: async () => undefined,
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
  // Tiptap reports "create" on the next tick, and focuses the text a frame later.
  await settle();
  await nextFrame();
  await settle();
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

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
  fake.grammar = { problems: new Map([[SENTENCE, PROBLEMS]]), error: null };
  fake.word = null;
  fake.selection = "";
  fake.onSelection = null;
  popupTextMenu.mockClear();
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

/** The text of each grammar mark in the chapter, in either editor. */
const marked = () => [...container.querySelectorAll<HTMLElement>(".editor-surface .grammar-mark")].map((m) => m.dataset.text);
const mark = (text: string) =>
  [...container.querySelectorAll<HTMLElement>(".editor-surface .grammar-mark")].find((m) => m.dataset.text === text)!;
const paragraph = () => [...container.querySelectorAll(".cm-line, .ProseMirror p")].find((l) => l.textContent?.startsWith("She"))!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const item = (text: string) => items().find((i) => i.textContent === text)!;
const fixes = () => [...(menu()?.querySelectorAll(".grammar-fix") ?? [])].map((i) => i.textContent);
/** What the editor pane says to screen readers, politely, and in an alert (the menu's, then its own). */
const note = () => container.querySelector('.editor-pane > p.visually-hidden[role="status"]')?.textContent;
const alerts = () =>
  [...container.querySelectorAll('.editor-pane > p.visually-hidden[role="alert"]')].map((p) => p.textContent).filter((t) => t !== "");
const caretInText = () => document.activeElement?.closest(".editor-surface") != null;

const plainView = () => EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
const plainText = () => plainView().state.doc.toString();
const plainCaret = () => plainView().state.selection.main.head;
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

const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

const press = (key: string, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

/** ProseMirror takes a click from its own mousedown and mouseup, which need a layout: its click handler is called here. */
async function tapFormatted(el: Element) {
  const { view } = formatted();
  await act(async () => {
    view.someProp("handleClick", (handle) => handle(view, 0, { target: el } as unknown as MouseEvent));
  });
  await settle();
}

/** What the native menu last showed, its groups tidied as the app does: each item's text, "—" for a separator. */
function nativeMenu() {
  const entries = tidyTextMenu(popupTextMenu.mock.lastCall![0]);
  const texts = entries.map((e) => ("separator" in e ? "—" : e.text));
  const itemNamed = (text: string) => entries.find((e): e is TextMenuItem => !("separator" in e) && e.text === text)!;
  return { entries, texts, item: itemNamed };
}

/* The marks ---------------------------------------------------------------------- */

describe("grammar problems in the text", () => {
  it("are marked in Plain mode, apart from names and spelling", async () => {
    await mount();
    expect(marked()).toEqual(["have", " the"]);
    expect(mark("have").classList.contains("spelling-mark")).toBe(false);
    expect(mark("have").dataset.message).toBe(AGREEMENT);
  });

  it("are marked the same in Formatted mode", async () => {
    await mount({ mode: "formatted" });
    expect(container.querySelector(".ProseMirror")).not.toBeNull();
    expect(marked()).toEqual(["have", " the"]);
  });

  it("are not marked in focus mode, which offers no fixes either", async () => {
    await mount();
    await press("F11", window);
    expect(marked()).toEqual([]);
    const event = await rightClick(paragraph());
    expect(event.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });
});

/* Browser preview: the page's own menu ----------------------------------------------- */

describe("a right-click on a grammar problem in the browser preview", () => {
  it("opens its menu: what is wrong as text, the fixes, then Ignore", async () => {
    await mount();
    const event = await rightClick(mark("have"));
    expect(event.defaultPrevented).toBe(true);
    expect(menu()?.getAttribute("aria-label")).toBe("Grammar: “have”");
    // The message is the menu's description, not an item.
    const message = menu()?.querySelector(".grammar-message");
    expect(message?.textContent).toBe(AGREEMENT);
    expect(message?.getAttribute("role")).toBe("none");
    expect(menu()?.getAttribute("aria-describedby")).toBe(message?.id);
    expect(items().map((i) => i.textContent)).toEqual(["has", "had", "Ignore"]);
    expect(fixes()).toEqual(["has", "had"]);
    // Fixes and Ignore set apart by space.
    expect(menu()?.querySelectorAll(".popover-gap")).toHaveLength(1);
    // The best fix takes focus.
    expect(document.activeElement).toBe(item("has"));
  });

  it("puts a fix in place of the text, with the caret after it", async () => {
    await mount();
    await rightClick(mark("have"));
    await click(item("has"));
    expect(plainText()).toContain("She has a skiff by the the jetty.");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    expect(plainCaret()).toBe(plainText().indexOf("has") + "has".length);
    expect(note()).toBe("Changed “have” to “has”.");
  });

  it("removes the text with an empty fix", async () => {
    await mount();
    await rightClick(mark(" the"));
    expect(menu()?.querySelector(".grammar-message")?.textContent).toBe(REPEATED);
    expect(items().map((i) => i.textContent)).toEqual(["Remove “the”", "Ignore"]);
    await click(item("Remove “the”"));
    expect(plainText()).toContain("She have a skiff by the jetty.");
    expect(caretInText()).toBe(true);
    expect(note()).toBe("Removed “the”.");
  });

  it("fixes the text in Formatted mode too, as one step to undo", async () => {
    await mount({ mode: "formatted" });
    await rightClick(mark("have"));
    await click(item("had"));
    await nextFrame();
    const editor = formatted();
    expect(editor.state.doc.textContent).toContain("She had a skiff");
    expect(caretInText()).toBe(true);
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent).toContain(SENTENCE);
  });

  it("ignores the problem: its mark goes at once, and the others stay", async () => {
    await mount();
    await rightClick(mark("have"));
    await click(item("Ignore"));
    expect(marked()).toEqual([" the"]);
    expect(plainText()).toContain(SENTENCE);
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    expect(note()).toBe("Ignored “have”.");
  });

  it("refuses a fix when the text has changed since the menu opened, and stays open", async () => {
    await mount();
    await rightClick(mark("have"));
    const at = plainText().indexOf("have");
    act(() => plainView().dispatch({ changes: { from: at, to: at + 4, insert: "owns" } }));
    await click(item("has"));
    expect(plainText()).toContain("She owns a skiff");
    expect(menu()?.querySelector(".popover-note")?.textContent).toBe(
      "Couldn’t change “have”. The text there has changed since the menu opened.",
    );
    expect(alerts()).toEqual(["Couldn’t change “have”. The text there has changed since the menu opened."]);
  });

  it("waits to fix while another project opens, but can still ignore", async () => {
    await mount({ switching: true });
    await rightClick(mark("have"));
    expect(item("has").disabled).toBe(true);
    await click(item("has"));
    expect(plainText()).toContain(SENTENCE);
    expect(item("Ignore").disabled).toBe(false);
    expect(document.activeElement).toBe(item("Ignore"));
  });

  it("shows no fixes when there are none, only what is wrong and Ignore", async () => {
    fake.grammar = { problems: new Map([[SENTENCE, [{ ...PROBLEMS[0], fixes: [] }]]]), error: null };
    await mount();
    await rightClick(mark("have"));
    expect(menu()?.querySelector(".grammar-message")?.textContent).toBe(AGREEMENT);
    expect(items().map((i) => i.textContent)).toEqual(["Ignore"]);
    expect(menu()?.querySelector(".popover-gap")).toBeNull();
  });

  it("closes on Escape, with the caret back in the text", async () => {
    await mount();
    await rightClick(mark("have"));
    await press("Escape");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
  });

  it("leaves a selection that could be a name to the add-name menu, unless it is the problem's text", async () => {
    await mount();
    fake.selection = "She have";
    await rightClick(mark("have"));
    expect(menu()?.getAttribute("aria-label")).toBe("Add as name: She have");
    await press("Escape");

    fake.selection = "have";
    await rightClick(mark("have"));
    expect(menu()?.getAttribute("aria-label")).toBe("Grammar: “have”");
  });
});

/* Touch screens: a tap on the mark ------------------------------------------------------ */

describe("a tap on a grammar problem on a touch screen", () => {
  it("opens its menu on a phone, and a fix replaces the text", async () => {
    await mount({ isPhone: true });
    await click(mark("have"));
    await settle();
    expect(menu()?.getAttribute("aria-label")).toBe("Grammar: “have”");
    expect(menu()?.querySelector(".grammar-message")?.textContent).toBe(AGREEMENT);
    expect(fixes()).toEqual(["has", "had"]);
    await click(item("has"));
    expect(plainText()).toContain("She has a skiff");
    expect(menu()).toBeNull();
    expect(caretInText()).toBe(true);
    // Fixing opens nothing else on a phone.
    expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
  });

  it("opens it in Formatted mode too, where an empty fix removes the text", async () => {
    await mount({ isPhone: true, mode: "formatted" });
    await tapFormatted(mark(" the"));
    expect(menu()?.getAttribute("aria-label")).toBe("Grammar: “the”");
    await click(item("Remove “the”"));
    await nextFrame();
    expect(formatted().state.doc.textContent).toContain("She have a skiff by the jetty.");
  });

  it("only places the caret with a mouse, which has the right-click", async () => {
    await mount({ hover: true });
    await click(mark("have"));
    await settle();
    expect(menu()).toBeNull();
  });
});

/* Desktop app: the native menu -------------------------------------------------------- */

describe("a right-click on a grammar problem in the desktop app", () => {
  it("starts the native menu with what is wrong, greyed, then the fixes, then Ignore", async () => {
    await mount({ backend: desktop });
    const event = await rightClick(mark("have"));
    expect(event.defaultPrevented).toBe(true);
    expect(popupTextMenu).toHaveBeenCalledOnce();
    expect(nativeMenu().texts).toEqual([AGREEMENT, "has", "had", "—", "Ignore"]);
    expect(nativeMenu().entries[0]).toMatchObject({ enabled: false });
    expect(popupTextMenu.mock.lastCall?.slice(1)).toEqual([120, 80]);
    // No page menu as well.
    expect(menu()).toBeNull();
  });

  it("keeps the name items after them, as for any word", async () => {
    await mount({ backend: desktop });
    fake.word = "have";
    await rightClick(mark("have"));
    expect(nativeMenu().texts).toEqual([
      AGREEMENT,
      "has",
      "had",
      "—",
      "Ignore",
      "—",
      "Add “have” to Characters",
      "Add “have” to Places",
    ]);
  });

  it("puts a fix chosen there in place, the caret back in the text after it", async () => {
    await mount({ backend: desktop });
    await rightClick(mark("have"));
    // The native menu took the window's attention for a moment.
    (document.activeElement as HTMLElement).blur();
    await act(async () => nativeMenu().item("has").action());
    expect(plainText()).toContain("She has a skiff");
    expect(caretInText()).toBe(true);
    expect(plainCaret()).toBe(plainText().indexOf("has") + "has".length);
    expect(note()).toBe("Changed “have” to “has”.");
  });

  it("says Remove for an empty fix, and removes the text", async () => {
    await mount({ backend: desktop });
    await rightClick(mark(" the"));
    expect(nativeMenu().texts).toEqual([REPEATED, "Remove “the”", "—", "Ignore"]);
    await act(async () => nativeMenu().item("Remove “the”").action());
    expect(plainText()).toContain("She have a skiff by the jetty.");
  });

  it("ignores the problem from there: its mark goes at once", async () => {
    await mount({ backend: desktop });
    await rightClick(mark("have"));
    await act(async () => nativeMenu().item("Ignore").action());
    expect(marked()).toEqual([" the"]);
    expect(caretInText()).toBe(true);
    expect(note()).toBe("Ignored “have”.");
  });

  it("shows a refused fix where the menu was", async () => {
    await mount({ backend: desktop });
    await rightClick(mark("have"));
    const at = plainText().indexOf("have");
    act(() => plainView().dispatch({ changes: { from: at, to: at + 4, insert: "owns" } }));
    await act(async () => nativeMenu().item("has").action());
    const shown = document.querySelector(".text-note");
    expect(shown?.querySelector(".text-note-title")?.textContent).toBe("Couldn’t change “have”");
    expect(shown?.querySelector(".text-note-message")?.textContent).toBe("The text there has changed since the menu opened.");
    expect(plainText()).toContain("She owns a skiff");
  });

  it("disables the fixes while another project opens, but not Ignore", async () => {
    await mount({ backend: desktop, switching: true });
    await rightClick(mark("have"));
    const enabled = (text: string) => nativeMenu().item(text).enabled !== false;
    expect(enabled("has")).toBe(false);
    expect(enabled("Ignore")).toBe(true);
  });
});

describe("grammarTextMenuItems", () => {
  const act = { fix: () => undefined, ignore: () => undefined };
  const texts = (entries: TextMenuEntry[]) => entries.map((e) => ("separator" in e ? "—" : e.text));

  it("cuts a long message at the end of a word, so the menu stays narrow", () => {
    const message = "The pronoun “She” is usually used with a third-person or a past tense verb, not with “have” here.";
    const [first] = grammarTextMenuItems({ message, fixes: ["has"], text: "have" }, true, act);
    const text = (first as TextMenuItem).text;
    expect(text).toBe("The pronoun “She” is usually used with a third-person or a past…");
    expect([...text].length).toBeLessThanOrEqual(64);
  });

  it("leaves out an empty message", () => {
    expect(texts(grammarTextMenuItems({ message: " ", fixes: ["has"], text: "have" }, true, act))).toEqual(["has", "—", "Ignore"]);
  });
});

describe("fix labels", () => {
  it("say what a fix does when it would read as nothing", () => {
    expect(fixLabel("", " the")).toBe("Remove “the”");
    expect(fixLabel("", "  ")).toBe("Remove the spaces");
    expect(fixLabel(" ", "  ")).toBe("Replace with one space");
    expect(fixLabel("has", "have")).toBe("has");
  });

  it("quote long text cut short", () => {
    expect(fixLabel("", "a very long stretch of repeated words that goes on and on and on")).toBe(
      "Remove “a very long stretch of repeated words…”",
    );
    expect(shortened("short", 10)).toBe("short");
    // A word that ends where the room does is kept.
    expect(shortened("one two three four", 10)).toBe("one two…");
    expect(shortened("one two three four", 9)).toBe("one two…");
    expect(shortened("Antidisestablishmentarianism", 10)).toBe("Antidises…");
  });
});

/* The status bar ---------------------------------------------------------------------- */

describe("the status bar when grammar can't be checked", () => {
  const REASON = "Couldn’t reach the LanguageTool server: timed out.";
  const grammarNote = () => container.querySelector<HTMLElement>(".status-grammar");

  it("shows a quiet note next to the language, with the reason on hover and for screen readers", async () => {
    fake.grammar = { problems: new Map([[SENTENCE, PROBLEMS]]), error: REASON };
    await mount();
    const shown = grammarNote();
    expect(shown?.querySelector(".muted")?.textContent).toBe("Grammar check unavailable");
    expect(shown?.getAttribute("title")).toBe(REASON);
    expect(shown?.querySelector(".visually-hidden")?.textContent).toBe(`. ${REASON}`);
    // Beside the language, in the same group.
    expect(shown?.previousElementSibling?.textContent).toBe("English");
    // The marks already found stay.
    expect(marked()).toEqual(["have", " the"]);
  });

  it("shows nothing when the check works", async () => {
    await mount();
    expect(grammarNote()).toBeNull();
    expect(container.querySelector(".status-bar")?.textContent).not.toContain("Grammar");
  });

  it("is left out on phones, as the language is", () => {
    act(() =>
      root.render(
        createElement(StatusBar, {
          chapterWords: 10,
          bookWords: 100,
          wordsToday: 0,
          language: "en",
          save: { status: "saved" },
          onRetry: async () => undefined,
          backendKind: "app",
          problems: [],
          grammarError: REASON,
          compact: true,
        }),
      ),
    );
    expect(grammarNote()).toBeNull();
  });
});
