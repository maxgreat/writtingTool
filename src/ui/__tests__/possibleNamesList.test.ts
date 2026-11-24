// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { withNotName } from "../../core/nameChoices";
import { NameIndex } from "../../core/nameIndex";
import { buildNameMatcher, buildProject, withSheetText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { newSheetPath, newSheetText } from "../../core/sheetFile";
import type { useProject } from "../../core/useProject";
import { Inspector, type InspectorView } from "../Inspector";
import { Workspace } from "../Workspace";

const A = "manuscript/01 A.md";
const B = "manuscript/02 B.md";
const C = "manuscript/03 C.md";
const D = "manuscript/04 D.md";

/**
 * Tomas: twice in A, once in B. Lowmere: once in A, three times in B. Mara:
 * three times in C. Kit, twice in C, is too rare; Elena has a sheet; and
 * words that start a sentence don't count.
 */
function makeProject(projectJson: string | null = null): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson,
    files: [
      { path: A, text: "# A\n\nThen Tomas came. Then Tomas left. They saw Lowmere.\n" },
      { path: B, text: "# B\n\nAt dawn Tomas rowed. Near Lowmere it rained. By Lowmere they slept. Into Lowmere again.\n" },
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

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;
let index: NameIndex;
let views: InspectorView[];

beforeEach(() => {
  latest = makeProject();
  createSheet.mockClear();
  markNotName.mockClear();
  index = new NameIndex();
  views = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

interface Shown {
  chapter: string;
  visible: boolean;
  busy: boolean;
}

function Harness({ chapter, visible, busy }: Shown) {
  const [project, setProject] = useState(latest);
  showProject = setProject;
  const [view, setView] = useState<InspectorView>({ kind: "chapter" });
  const matcher = useMemo(
    () => buildNameMatcher(project.sheets, project.ignoredNames),
    [project.sheets, project.ignoredNames],
  );
  const sheetsById = useMemo(() => new Map(project.sheets.map((s) => [s.id, s])), [project.sheets]);
  return createElement(Inspector, {
    project,
    chapter: project.chapters[chapter],
    matcher,
    index,
    sheetsById,
    view,
    onViewChange: (next: InspectorView) => {
      views.push(next);
      setView(next);
    },
    onOpenSheet: (id: string) => setView({ kind: "sheet", id }),
    onOpenChapter: () => undefined,
    onChapterDetails: () => undefined,
    onCreateSheet: createSheet,
    onUpdateSheet: () => undefined,
    ignoring: { ignored: project.ignoredNames, setIgnored: () => undefined, busy },
    onMarkNotName: markNotName,
    busy,
    versions: { list: async () => [], restore: async () => undefined, saveStatus: "saved", loads: 1, busy: false },
    visible,
  });
}

let shown: Shown;

/** Shows This chapter for `chapter`; later calls keep the inspector's state. */
async function render(patch: Partial<Shown> = {}) {
  shown = { ...shown, ...patch };
  await act(async () => root.render(createElement(Harness, shown)));
}

beforeEach(() => {
  shown = { chapter: A, visible: true, busy: false };
});

/* Finding things -------------------------------------------------------------- */

const section = () => container.querySelector<HTMLElement>('section[aria-label="Possible names"]');
const rowFor = (word: string) =>
  [...(section()?.querySelectorAll<HTMLElement>(".possible-row") ?? [])].find(
    (row) => row.querySelector(".possible-word-text")?.textContent === word,
  )!;
/** Each row as shown: the word, its book-wide count, and its buttons. */
const rows = () =>
  [...(section()?.querySelectorAll(".possible-row") ?? [])].map((row) =>
    [
      row.querySelector(".possible-word-text")!.textContent,
      row.querySelector(".num")!.textContent,
      ...[...row.querySelectorAll("button")].map((b) => b.textContent),
    ].join(" | "),
  );
const buttonIn = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const menuItems = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
const namesFound = () =>
  [...container.querySelectorAll(".names-found .list-row")].map((row) => row.textContent);

const click = (el: HTMLElement) =>
  act(async () => {
    el.click();
  });

/* Tests ------------------------------------------------------------------------ */

describe("possible names", () => {
  it("lists the open chapter's, most found first, with how often the whole book has each", async () => {
    await render();
    expect(rows()).toEqual(["Lowmere | 4 | Add to | Not a name", "Tomas | 3 | Add to | Not a name"]);
    expect(rowFor("Lowmere").querySelector(".visually-hidden")?.textContent).toBe(", 4 times in the book");
    // After Names in this chapter.
    const order = [...container.querySelector(".chapter-info")!.children].map((el) => el.className);
    expect(order.indexOf("possible-names")).toBe(order.indexOf("names-found") + 1);

    await render({ chapter: C });
    expect(rows()).toEqual(["Mara | 3 | Add to | Not a name"]);
  });

  it("isn't there when the chapter has none", async () => {
    await render({ chapter: D });
    expect(section()).toBeNull();
    expect(container.textContent).not.toContain("Possible names");
  });

  it("reads nothing while the inspector is hidden", async () => {
    const read = vi.spyOn(index, "possibleNames");
    await render({ visible: false });
    expect(section()).toBeNull();
    expect(read).not.toHaveBeenCalled();

    await render({ visible: true });
    expect(rows()).toHaveLength(2);
    expect(read).toHaveBeenCalled();
  });

  it("adds a word as a sheet of a type that holds names: it becomes a name of this chapter", async () => {
    await render();
    await click(buttonIn(rowFor("Tomas"), "Add to"));
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Add Tomas to");
    // Notes hold no names.
    expect(menuItems().map((i) => i.textContent)).toEqual(["Characters", "Places"]);

    await click(menuItems()[1]);
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("places", "Tomas");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(rows()).toEqual(["Lowmere | 4 | Add to | Not a name"]);
    expect(namesFound()).toEqual(["Tomas2"]);
    expect(container.querySelector(".names-found .group-label")?.textContent).toBe("Places");
    // The view stays on This chapter, and focus goes to the new name.
    expect(views).toEqual([]);
    expect(document.activeElement?.textContent).toBe("Tomas2");
    expect(container.querySelector('.chapter-info > [role="status"]')?.textContent).toBe("Tomas added to Places.");
  });

  it("offers one button when only one type holds names", async () => {
    latest = makeProject(
      JSON.stringify({
        sheetTypes: [
          { folder: "characters", label: "Characters" },
          { folder: "notes", label: "Notes" },
        ],
      }),
    );
    await render({ chapter: C });
    expect(rows()).toEqual(["Mara | 3 | Add to Characters | Not a name"]);
    await click(buttonIn(rowFor("Mara"), "Add to Characters"));
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("characters", "Mara");
    expect(section()).toBeNull();
    expect(namesFound()).toEqual(["Mara3", "Elena Voss1"]);
  });

  it("waits while a sheet is being made, and shows a refusal in its row", async () => {
    await render();
    const answer = deferred<string>();
    createSheet.mockReturnValueOnce(answer.promise);
    await click(buttonIn(rowFor("Tomas"), "Add to"));
    await click(menuItems()[0]);
    expect(rowFor("Tomas").getAttribute("aria-busy")).toBe("true");
    const buttons = [...section()!.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    await click(buttonIn(rowFor("Lowmere"), "Not a name"));
    expect(markNotName).not.toHaveBeenCalled();

    await act(async () => answer.reject(new Error("sheets/characters/Tomas.md already exists")));
    const alert = rowFor("Tomas").querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("sheets/characters/Tomas.md already exists");
    expect(rows()).toEqual(["Lowmere | 4 | Add to | Not a name", "Tomas | 3 | Add to | Not a name"]);
    expect(buttons.some((b) => b.disabled)).toBe(false);
    // Focus goes back to the row's Add to, from the menu that went away.
    expect(document.activeElement).toBe(buttonIn(rowFor("Tomas"), "Add to"));
  });

  it("marks a word as not a name, keeping it in place with Undo", async () => {
    await render();
    const notName = buttonIn(rowFor("Lowmere"), "Not a name");
    notName.focus();
    await click(notName);
    expect(markNotName).toHaveBeenCalledExactlyOnceWith("Lowmere", true);
    expect(latest.notNames).toEqual(["Lowmere"]);
    expect(rows()).toEqual(["Lowmere | 4 | Undo", "Tomas | 3 | Add to | Not a name"]);
    expect(rowFor("Lowmere").querySelector(".possible-note")?.textContent).toBe("Not a name");
    expect(document.activeElement).toBe(notName);
    expect(container.querySelector('.chapter-info > [role="status"]')?.textContent).toBe(
      "Lowmere won’t be offered as a name again.",
    );

    await click(notName);
    expect(markNotName).toHaveBeenLastCalledWith("Lowmere", false);
    expect(latest.notNames).toEqual([]);
    expect(rows()).toEqual(["Lowmere | 4 | Add to | Not a name", "Tomas | 3 | Add to | Not a name"]);

    // Opening another chapter puts a dismissed word away.
    await click(notName);
    await render({ chapter: B });
    expect(rows()).toEqual(["Tomas | 3 | Add to | Not a name"]);
  });

  it("leaves out words already marked as not names", async () => {
    latest = makeProject(JSON.stringify({ notNames: ["Tomas"] }));
    await render();
    expect(rows()).toEqual(["Lowmere | 4 | Add to | Not a name"]);
  });

  it("shows a refusal to mark a word in its row", async () => {
    markNotName.mockImplementationOnce(() => {
      throw new Error("project.json could not be read.");
    });
    await render();
    await click(buttonIn(rowFor("Tomas"), "Not a name"));
    expect(rowFor("Tomas").querySelector('[role="alert"]')?.textContent).toBe("project.json could not be read.");
    expect(rows()).toEqual(["Lowmere | 4 | Add to | Not a name", "Tomas | 3 | Add to | Not a name"]);
  });

  it("waits while the project changes on disk", async () => {
    await render({ busy: true });
    const buttons = [...section()!.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons).toHaveLength(4);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    await click(buttonIn(rowFor("Tomas"), "Not a name"));
    expect(markNotName).not.toHaveBeenCalled();
  });

  it("follows the text as it is typed, across the book", async () => {
    await render({ chapter: D });
    expect(section()).toBeNull();
    // A third Kit, here, makes Kit a possible name, in this chapter and in C.
    const edited = { ...latest.chapters[D], text: "# D\n\nThey met Tomas. Then Kit came.\n" };
    await act(async () => apply({ ...latest, chapters: { ...latest.chapters, [D]: edited } }));
    expect(rows()).toEqual(["Tomas | 4 | Add to | Not a name", "Kit | 3 | Add to | Not a name"]);
    await render({ chapter: C });
    expect(rows()).toEqual(["Kit | 3 | Add to | Not a name", "Mara | 3 | Add to | Not a name"]);
  });
});

describe("possible names on a phone", () => {
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

  beforeAll(() => {
    // A touchscreen phone: editors don't take focus when they mount.
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });

  async function mount() {
    function PhoneHarness() {
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
        createSheet,
        markNotName,
        save: { status: "saved" },
        saveNow: async () => undefined,
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
    await act(async () => root.render(createElement(PhoneHarness)));
  }

  it("are read once the inspector slides in, and work there", async () => {
    await mount();
    expect(section()).toBeNull();
    await click(container.querySelector<HTMLButtonElement>('button[aria-controls="inspector"]')!);
    expect(container.querySelector(".panel--inspector")!.classList.contains("is-open")).toBe(true);
    expect(rows()).toEqual(["Mara | 3 | Add to | Not a name"]);

    await click(buttonIn(rowFor("Mara"), "Add to"));
    await click(menuItems()[0]);
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("characters", "Mara");
    expect(section()).toBeNull();
    expect(namesFound()).toEqual(["Mara3", "Elena Voss1"]);
    // Highlighted in the text at once.
    const marks = [...container.querySelectorAll(".cm-content .name-mark")].map((m) => m.textContent);
    expect(marks.filter((m) => m === "Mara")).toHaveLength(3);
  });
});
