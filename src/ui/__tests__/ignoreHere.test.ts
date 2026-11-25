// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import type { NameHit } from "../../core/editor/types";
import { withIgnoredName } from "../../core/nameChoices";
import { NameIndex } from "../../core/nameIndex";
import type { IgnoredName } from "../../core/names";
import { buildNameMatcher, buildProject, type Project } from "../../core/project";
import { DEFAULT_SETTINGS } from "../../core/settings";
import type { useProject } from "../../core/useProject";
import { Inspector, type InspectorView } from "../Inspector";
import { NameChoice } from "../NameCard";
import { Workspace } from "../Workspace";

const CHAPTER = "manuscript/01 One.md";
const ELENA = "sheets/characters/Elena Voss.md";
const DUPONT = "sheets/characters/Marie Dupont.md";
const CURIE = "sheets/characters/Marie Curie.md";
const VARN = "sheets/places/Varn.md";

const WAITS = { name: "Elena", sentence: "Elena waits for the ferryman." };
const SLEEPS = { name: "Elena", sentence: "Elena sleeps." };
const MARIE = { name: "Marie", sentence: "Marie came." };

/** Two Elenas in two sentences; two sheets share Marie. */
function makeProject(projectJson: string | null = null): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson,
    files: [
      { path: CHAPTER, text: "# One\n\nElena waits for the ferryman. Elena sleeps.\n\nMarie came. Then Varn.\n" },
      { path: ELENA, text: "---\nname: Elena Voss\naliases: [Elena]\n---\n" },
      { path: DUPONT, text: "---\nname: Marie Dupont\naliases: [Marie]\nrole: Baker\n---\n" },
      { path: CURIE, text: "---\nname: Marie Curie\naliases: [Marie]\n---\n" },
      { path: VARN, text: "---\nname: Varn\n---\n" },
    ],
    skipped: [],
  });
}

/* The project as useProject would keep it ------------------------------------ */

let latest: Project;
let showProject: (project: Project) => void = () => undefined;

/** As useProject's ignoreName: saved in project.json; throws, changing nothing, when it can't be read. */
const ignoreName = vi.fn((entry: IgnoredName, ignore = true) => {
  const change = withIgnoredName(latest, entry, ignore);
  if (!change) return;
  latest = change.project;
  showProject(latest);
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
  ignoreName.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* The workspace ------------------------------------------------------------- */

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

function useMatchMedia(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    // A touchscreen phone, or a desktop without hover cards: editors take focus only on desktop.
    matches: phone && query === "(pointer: coarse)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

/** The workspace on the test project, in Plain (its names answer clicks without layout). */
async function mount(isPhone: boolean) {
  useMatchMedia(isPhone);
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
      openChapterId: CHAPTER,
      openChapter: () => undefined,
      updateChapter: () => undefined,
      ignoreName,
      markNotName: () => undefined,
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
      isPhone,
    });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The highlighted names in the text, each with the sentence it is in. */
const marks = () =>
  [...container.querySelectorAll<HTMLElement>(".cm-content .name-mark")].map(
    (m) => `${m.textContent} | ${m.getAttribute("data-sentence")}`,
  );

async function clickName(sentence: string) {
  const mark = [...container.querySelectorAll(".cm-content .name-mark")].find(
    (m) => m.getAttribute("data-sentence") === sentence,
  )!;
  await act(async () => mark.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const buttonIn = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

const click = (el: HTMLElement) =>
  act(async () => {
    el.click();
  });

/** The "Opened from the text" block in a scope: its label, sentence, button, and whether the name is highlighted. */
function occurrenceIn(scope: ParentNode) {
  const block = scope.querySelector<HTMLElement>('section[aria-label="Opened from the text"]');
  if (!block) return null;
  return {
    label: block.querySelector('[role="status"]')?.textContent,
    sentence: block.querySelector(".excerpt")?.textContent,
    highlighted: block.querySelector(".excerpt-name")?.classList.contains("is-highlighted"),
    button: block.querySelector<HTMLButtonElement>("button")!,
    error: block.querySelector('[role="alert"]')?.textContent ?? null,
  };
}

const inspector = () => container.querySelector<HTMLElement>(".panel--inspector")!;

describe("Ignore here, in the desktop inspector", () => {
  it("shows where the name was clicked, stops highlighting it there, and offers to undo", async () => {
    await mount(false);
    await clickName(WAITS.sentence);
    expect(inspector().querySelector(".sheet-name")?.textContent).toBe("Elena Voss");
    expect(occurrenceIn(inspector())).toMatchObject({
      label: "Opened from the text",
      sentence: "Elena waits for the ferryman.",
      highlighted: true,
    });
    // The caret stays in the text.
    expect(document.activeElement?.closest(".editor-pane")).not.toBeNull();

    const ignore = occurrenceIn(inspector())!.button;
    ignore.focus();
    await click(ignore);
    expect(ignoreName).toHaveBeenCalledExactlyOnceWith(WAITS, true);
    // Only that occurrence stops being highlighted.
    expect(marks()).toEqual(["Elena | Elena sleeps.", "Marie | Marie came.", "Varn | Then Varn."]);
    const after = occurrenceIn(inspector())!;
    expect(after).toMatchObject({ label: "Not highlighted here", highlighted: false });
    expect(after.button.textContent).toBe("Highlight again");
    // The same button, so focus stays on it.
    expect(after.button).toBe(ignore);
    expect(document.activeElement).toBe(ignore);

    await click(after.button);
    expect(ignoreName).toHaveBeenLastCalledWith(WAITS, false);
    expect(marks()).toContain("Elena | Elena waits for the ferryman.");
    expect(occurrenceIn(inspector())?.button.textContent).toBe("Ignore here");
  });

  it("keeps the occurrence through Edit and Done, as it is the same opening", async () => {
    await mount(false);
    await clickName(SLEEPS.sentence);
    await click(buttonIn(inspector(), "Edit")!);
    expect(occurrenceIn(inspector())).toBeNull();
    await click(buttonIn(inspector(), "Done")!);
    expect(occurrenceIn(inspector())?.sentence).toBe("Elena sleeps.");
  });

  it("shows none for a sheet opened from a list or from This chapter", async () => {
    await mount(false);
    await clickName(WAITS.sentence);
    expect(occurrenceIn(inspector())).not.toBeNull();

    // Back to Characters, and Elena from the list.
    await click(inspector().querySelector<HTMLButtonElement>(".back-link")!);
    const row = [...inspector().querySelectorAll<HTMLButtonElement>(".list-row")].find((r) =>
      r.textContent?.startsWith("Elena Voss"),
    )!;
    await click(row);
    expect(inspector().querySelector(".sheet-name")?.textContent).toBe("Elena Voss");
    expect(occurrenceIn(inspector())).toBeNull();

    // From the names in This chapter.
    await click(buttonIn(inspector(), "This chapter")!);
    const name = [...inspector().querySelectorAll<HTMLButtonElement>(".names-found .list-row")].find((r) =>
      r.textContent?.startsWith("Elena Voss"),
    )!;
    await click(name);
    expect(occurrenceIn(inspector())).toBeNull();
  });
});

describe("Ignore here, in the phone's name preview", () => {
  const preview = () => document.querySelector<HTMLElement>(".bottom-sheet.is-open");

  it("stops highlighting the tapped name there, and offers to undo in the same place", async () => {
    await mount(true);
    await clickName(SLEEPS.sentence);
    expect(preview()?.querySelector(".sheet-name")?.textContent).toBe("Elena Voss");
    expect(occurrenceIn(preview()!)).toMatchObject({ label: "Opened from the text", sentence: "Elena sleeps." });

    await click(occurrenceIn(preview()!)!.button);
    expect(ignoreName).toHaveBeenCalledExactlyOnceWith(SLEEPS, true);
    expect(marks()).not.toContain("Elena | Elena sleeps.");
    expect(preview()).not.toBeNull();
    expect(occurrenceIn(preview()!)).toMatchObject({ label: "Not highlighted here", highlighted: false });

    await click(occurrenceIn(preview()!)!.button);
    expect(ignoreName).toHaveBeenLastCalledWith(SLEEPS, false);
    expect(marks()).toContain("Elena | Elena sleeps.");
  });

  it("starts afresh for each tap", async () => {
    await mount(true);
    await clickName(WAITS.sentence);
    await click(preview()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
    await clickName(SLEEPS.sentence);
    expect(occurrenceIn(preview()!)?.sentence).toBe("Elena sleeps.");
  });
});

describe("Ignore here, in the choice for a shared name", () => {
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const items = () => [...menu()!.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
  const item = (text: string) =>
    [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => i.textContent === text)!;

  it("is offered after the sheets, for when the name means none of them", async () => {
    await mount(false);
    await clickName(MARIE.sentence);
    expect(items()).toEqual(["Marie Curie", "Marie DupontBaker", "Ignore here"]);

    await click(item("Ignore here"));
    expect(ignoreName).toHaveBeenCalledExactlyOnceWith(MARIE, true);
    expect(marks()).not.toContain("Marie | Marie came.");
    // The menu stays, offering to undo where Ignore here was.
    expect(items()).toEqual(["Marie Curie", "Marie DupontBaker", "Highlight again"]);
    expect(container.querySelector('.editor-pane [role="status"].visually-hidden')?.textContent).toBe(
      "Marie is no longer highlighted here.",
    );

    await click(item("Highlight again"));
    expect(ignoreName).toHaveBeenLastCalledWith(MARIE, false);
    expect(marks()).toContain("Marie | Marie came.");
  });

  it("opens the chosen sheet with the occurrence", async () => {
    await mount(false);
    await clickName(MARIE.sentence);
    await click(item("Marie Curie"));
    expect(menu()).toBeNull();
    expect(inspector().querySelector(".sheet-name")?.textContent).toBe("Marie Curie");
    expect(occurrenceIn(inspector())?.sentence).toBe("Marie came.");
  });

  describe("on its own", () => {
    const hit: NameHit = { sheetIds: [DUPONT, CURIE], ambiguous: true, rect: new DOMRect(), occurrence: MARIE };

    async function renderChoice(setIgnored: (o: IgnoredName, ignore: boolean) => void, busy: boolean) {
      const project = makeProject();
      await act(async () =>
        root.render(
          createElement(NameChoice, {
            hit,
            sheets: project.sheets.filter((s) => s.id === DUPONT || s.id === CURIE),
            onChoose: () => undefined,
            onClose: () => undefined,
            ignoring: { ignored: [], setIgnored, busy },
          }),
        ),
      );
    }

    it("waits while the project changes on disk", async () => {
      const setIgnored = vi.fn();
      await renderChoice(setIgnored, true);
      expect(item("Ignore here").disabled).toBe(true);
      await click(item("Ignore here"));
      expect(setIgnored).not.toHaveBeenCalled();
    });

    it("shows and announces a refusal", async () => {
      await renderChoice(() => {
        throw new Error("project.json could not be read. Fix or remove it, then open the project again.");
      }, false);
      await click(item("Ignore here"));
      expect(menu()!.querySelector(".popover-note")?.textContent).toBe(
        "project.json could not be read. Fix or remove it, then open the project again.",
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "project.json could not be read. Fix or remove it, then open the project again.",
      );
      expect(items()).toEqual(["Marie Curie", "Marie DupontBaker", "Ignore here"]);
    });
  });
});

/* The inspector alone --------------------------------------------------------- */

describe("a sheet's ignored mentions", () => {
  const json = JSON.stringify({ ignoredNames: [SLEEPS, WAITS, MARIE] });

  async function render(view: InspectorView, busy = false, setIgnored?: (o: IgnoredName, ignore: boolean) => void) {
    latest = makeProject(json);
    function Harness() {
      const [project, setProject] = useState(latest);
      showProject = setProject;
      const matcher = useMemo(
        () => buildNameMatcher(project.sheets, project.ignoredNames),
        [project.sheets, project.ignoredNames],
      );
      const [index] = useState(() => new NameIndex());
      return createElement(Inspector, {
        project,
        chapter: project.chapters[CHAPTER],
        matcher,
        index,
        sheetsById: new Map(project.sheets.map((s) => [s.id, s])),
        view,
        onViewChange: () => undefined,
        onOpenSheet: () => undefined,
        onOpenChapter: () => undefined,
        onChapterDetails: () => undefined,
        onCreateSheet: async () => "",
        onUpdateSheet: () => undefined,
        onTrashSheet: async () => undefined,
        ignoring: { ignored: project.ignoredNames, setIgnored: setIgnored ?? ignoreName, busy },
        suggestions: { list: [], words: new Set<string>(), rule: null },
        onMarkNotName: () => undefined,
        busy,
        versions: { list: async () => [], restore: async () => undefined, saveStatus: "saved", loads: 1, busy: false },
        visible: true,
      });
    }
    await act(async () => root.render(createElement(Harness)));
  }

  const section = () => container.querySelector<HTMLElement>('section[aria-label="Ignored mentions"]');
  const rows = () =>
    [...(section()?.querySelectorAll(".mention-row") ?? [])].map(
      (row) => `${row.querySelector(".excerpt")!.textContent} | ${row.querySelector("button")!.textContent}`,
    );

  it("lists the sentences where the sheet's names are ignored, in the order they were ignored", async () => {
    await render({ kind: "sheet", id: ELENA });
    expect(rows()).toEqual(["Elena sleeps. | Highlight again", "Elena waits for the ferryman. | Highlight again"]);
    // After Appears in, before the notes.
    const order = [...container.querySelector(".sheet")!.children].map((el) => el.className);
    expect(order.slice(-3)).toEqual(["sheet-appearances", "sheet-ignored", "sheet-notes"]);
  });

  it("highlights a mention again, keeping it in place to ignore again", async () => {
    await render({ kind: "sheet", id: ELENA });
    const button = section()!.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    await click(button);
    expect(ignoreName).toHaveBeenCalledExactlyOnceWith(SLEEPS, false);
    expect(latest.ignoredNames).toEqual([WAITS, MARIE]);
    expect(rows()).toEqual(["Elena sleeps. | Ignore here", "Elena waits for the ferryman. | Highlight again"]);
    expect(document.activeElement).toBe(button);
    expect(section()!.querySelector('[role="status"]')?.textContent).toBe("Elena is highlighted again in that sentence.");

    await click(button);
    expect(ignoreName).toHaveBeenLastCalledWith(SLEEPS, true);
    expect(rows()[0]).toBe("Elena sleeps. | Highlight again");
  });

  it("leaves out the occurrence the sheet was opened from, which has its own button", async () => {
    await render({ kind: "sheet", id: ELENA, occurrence: WAITS });
    expect(occurrenceIn(container)).toMatchObject({ label: "Not highlighted here", sentence: WAITS.sentence });
    expect(rows()).toEqual(["Elena sleeps. | Highlight again"]);
  });

  it("isn't there for a sheet with none", async () => {
    await render({ kind: "sheet", id: VARN });
    expect(section()).toBeNull();
    expect(container.textContent).not.toContain("Ignored mentions");
  });

  it("waits while the project changes on disk, Ignore here too", async () => {
    await render({ kind: "sheet", id: ELENA, occurrence: { name: "Elena", sentence: "Elena rows." } }, true);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".sheet-ignored button, .sheet-occurrence button")];
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("shows a refusal under the mention, and under Ignore here", async () => {
    const refuse = () => {
      throw new Error("project.json could not be read.");
    };
    await render({ kind: "sheet", id: ELENA, occurrence: { name: "Elena", sentence: "Elena rows." } }, false, refuse);
    await click(section()!.querySelector<HTMLButtonElement>("button")!);
    const alert = section()!.querySelector('.mention-row [role="alert"]');
    expect(alert?.textContent).toBe("project.json could not be read.");
    expect(rows()[0]).toBe("Elena sleeps. | Highlight again");

    await click(occurrenceIn(container)!.button);
    expect(occurrenceIn(container)).toMatchObject({
      label: "Opened from the text",
      error: "project.json could not be read.",
    });
    expect(occurrenceIn(container)!.button.getAttribute("aria-describedby")).toContain(
      container.querySelector('.sheet-occurrence [role="alert"]')!.id,
    );
  });
});
