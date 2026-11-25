// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  planMoveChapter,
  planNewChapter,
  planRestore,
  planTrashSheet,
  type ChapterDetails,
  type Plan,
} from "../../core/binder";
import { buildProject, type Project, type SheetType } from "../../core/project";
import { Binder, type BinderProps } from "../Binder";

const P1 = "manuscript/Part 1";
const P2 = "manuscript/Part 2";
const ONE = `${P1}/01 One.md`;
const TWO = `${P1}/02 Two.md`;
const THREE = `${P2}/03 Three.md`;
const OLD = "trash/04 Old.md";

function makeProject(withTrash = false): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson: JSON.stringify({ chapters: { [ONE]: { status: "Draft" } } }),
    files: [
      { path: ONE, text: "# One\n\nElena waits.\n" },
      { path: TWO, text: "# Two\n\nArno rows on.\n" },
      { path: THREE, text: "# Three\n\nThe river runs.\n" },
      ...(withTrash ? [{ path: OLD, text: "# Old\n\nGone for now.\n" }] : []),
    ],
    folders: ["manuscript", P1, P2, ...(withTrash ? ["trash"] : [])],
    skipped: [],
  });
}

let container: HTMLDivElement;
let root: Root;
let props: BinderProps;
/** The plans the binder asked for, made on the project it was given. */
let plans: (Plan | null)[];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  plans = [];
  const project = makeProject();
  props = {
    project,
    openChapterId: ONE,
    onOpenChapter: vi.fn(),
    onOpenSheet: vi.fn(),
    onEditSheet: vi.fn<(id: string) => void>(),
    // The Projects view itself is tested in projects.test.ts.
    projects: {
      source: {
        current: "/test",
        loads: 1,
        list: async () => [],
        open: async () => undefined,
        create: async () => undefined,
        canCreate: true,
        busy: false,
        phone: false,
      },
      id: "projects",
      opened: null,
      show: vi.fn(),
      close: vi.fn(),
      view: { intent: "open", openings: 0 },
      setPending: vi.fn(),
      dismiss: vi.fn(),
    },
    onChange: vi.fn(async (makePlan: (p: Project) => Plan | null) => {
      plans.push(makePlan(props.project));
    }),
    onChapterDetails: vi.fn<(id: string, details: ChapterDetails) => void>(),
    onCreateSheet: vi.fn(async (kind: string, name: string) => `sheets/${kind}/${name}.md`),
    onSheetCreated: vi.fn<(id: string) => void>(),
    busy: false,
    onChapterCreated: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(patch: Partial<BinderProps> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(Binder, props)));
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () => [...(menu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
const menuItem = (label: string) => menuItems().find((item) => item.textContent === label);
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === label,
  );
const row = (type: "chapter" | "part", id: string) =>
  [...container.querySelectorAll<HTMLElement>(`[data-drag-row="${type}"]`)].find((r) => r.dataset.dragId === id)!;
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

async function rightClick(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  });
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("Nothing to click");
  await act(async () => el.click());
}

async function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("a chapter's menu", () => {
  it("opens on right-click with rename, the statuses, moves, a new chapter and the Trash", async () => {
    await render();
    await rightClick(row("chapter", ONE));
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "Rename",
      "No status",
      "Idea",
      "Draft",
      "Revised",
      "Final",
      "Move up",
      "Move down",
      "Part 1",
      "Part 2",
      "Top level",
      "New chapter below",
      "Move to Trash",
    ]);
    expect(menuItem("Draft")?.getAttribute("aria-checked")).toBe("true");
    expect(menuItem("Part 1")?.getAttribute("aria-checked")).toBe("true");
    expect((menuItem("Move up") as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(menuItem("Rename"));
  });

  it("opens from the More button too, which closes it again", async () => {
    await render();
    await click(button("Actions for Two"));
    expect(menu()).not.toBeNull();
    expect(button("Actions for Two")?.getAttribute("aria-expanded")).toBe("true");
    await click(button("Actions for Two"));
    expect(menu()).toBeNull();
  });

  it("moves the chapter down within its part", async () => {
    await render();
    await rightClick(row("chapter", ONE));
    await click(menuItem("Move down"));
    expect(menu()).toBeNull();
    expect(plans).toEqual([planMoveChapter(props.project, ONE, { partId: P1, index: 1 })]);
  });

  it("moves the chapter to the end of another part", async () => {
    await render();
    await rightClick(row("chapter", ONE));
    await click(menuItem("Part 2"));
    expect(plans).toEqual([planMoveChapter(props.project, ONE, { partId: P2, index: 1 })]);
  });

  it("sets a status at once, and shows why by the row when the project refuses it", async () => {
    await render();
    await rightClick(row("chapter", TWO));
    await click(menuItem("Revised"));
    expect(props.onChapterDetails).toHaveBeenCalledWith(TWO, { status: "Revised" });

    vi.mocked(props.onChapterDetails).mockImplementation(() => {
      throw new Error("project.json could not be read.");
    });
    await rightClick(row("chapter", TWO));
    await click(menuItem("Final"));
    expect(alertText()).toBe("project.json could not be read.");
  });

  it("shows a failed move by the row, and nothing else changes", async () => {
    await render({ onChange: vi.fn(async () => Promise.reject(new Error("The disk is full."))) });
    await rightClick(row("chapter", ONE));
    await click(menuItem("Move to Trash"));
    expect(alertText()).toBe("The disk is full.");
    expect(row("chapter", ONE).nextElementSibling?.textContent).toBe("The disk is full.");
  });
});

describe("a part's menu", () => {
  it("says how many chapters go to the Trash with the part", async () => {
    await render();
    await rightClick(row("part", P1));
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "Rename",
      "New chapter in this part",
      "New part below",
      "Move up",
      "Move down",
      "Move to Trash with its 2 chapters",
    ]);
  });

  it("shows the part's word count", async () => {
    await render();
    expect(row("part", P1).querySelector(".binder-row-count")?.textContent).toBe("5 words");
  });
});

describe("titles typed in the binder", () => {
  async function startNewChapter() {
    await click(button("New chapter, part or sheet"));
    await click(menuItem("New chapter"));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Title of the new chapter"]');
    if (!input) throw new Error("No title input");
    return input;
  }

  it("asks for a title before making a chapter", async () => {
    await render();
    const input = await startNewChapter();
    expect(document.activeElement).toBe(input);
    await press(input, "Enter");
    expect(alertText()).toBe("Give the chapter a title.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(plans).toEqual([]);
  });

  it("makes the chapter at the end of the binder and reports it", async () => {
    await render();
    const input = await startNewChapter();
    await type(input, "Epilogue");
    await press(input, "Enter");
    expect(plans).toEqual([planNewChapter(props.project, { partId: null, index: 3 }, "Epilogue")]);
    expect(plans[0]?.created).toBe("manuscript/04 Epilogue.md");
    expect(props.onChapterCreated).toHaveBeenCalledOnce();
    expect(container.querySelector("input")).toBeNull();
  });

  it("keeps the title and shows why when the chapter can't be made", async () => {
    await render({ onChange: vi.fn(async () => Promise.reject(new Error("The disk is full."))) });
    const input = await startNewChapter();
    await type(input, "Epilogue");
    await press(input, "Enter");
    expect(alertText()).toBe("The disk is full.");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Epilogue");
    expect(props.onChapterCreated).not.toHaveBeenCalled();
  });

  it("drops the title on Escape and gives focus back", async () => {
    await render();
    const input = await startNewChapter();
    await type(input, "Never mind");
    await press(input, "Escape");
    expect(container.querySelector("input")).toBeNull();
    expect(document.activeElement).toBe(button("New chapter, part or sheet"));
  });

  it("renames a chapter in place, its title selected first", async () => {
    await render();
    await rightClick(row("chapter", TWO));
    await click(menuItem("Rename"));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Chapter title"]')!;
    expect(input.value).toBe("Two");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    await type(input, "Second");
    await press(input, "Enter");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.renamed.get(TWO)).toBe(`${P1}/02 Second.md`);
  });

  it("starts a new chapter when the empty project's button asks for one", async () => {
    await render();
    await render({ newChapterRequest: 1 });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Title of the new chapter");
  });
});

describe("the Trash", () => {
  it("says when it is empty", async () => {
    await render();
    await click(button("Trash"));
    expect(container.querySelector('section[aria-label="Trash"] .empty-note')?.textContent).toBe("Trash is empty.");
  });

  it("lists what is in it, and puts an item back", async () => {
    await render({ project: makeProject(true) });
    await click(button("Trash"));
    expect(container.querySelector(".trash-row")?.textContent).toBe("Old3 wordsRestore");
    await click(button("Restore Old"));
    expect(plans).toEqual([planRestore(props.project, OLD)]);
  });
});

describe("while the project is busy", () => {
  it("binder actions wait", async () => {
    await render({ busy: true });
    expect(button("Actions for One")?.disabled).toBe(true);
    expect(button("New chapter, part or sheet")?.disabled).toBe(true);
    await rightClick(row("chapter", ONE));
    expect(menu()).toBeNull();
  });
});

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

describe("new sheets in the binder", () => {
  /** A sheet type's New button, in its group's row (menus are outside the container). */
  const groupAdd = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  /** A group's row, and what it folds. */
  const group = (label: string) => button(label)!;
  const groupContent = (label: string) => document.getElementById(group(label).getAttribute("aria-controls")!)!;
  const nameInput = (noun: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="Name of the new ${noun}"]`);

  it("each sheet type has a New button on its row, labelled with its noun", async () => {
    await render();
    for (const [label, add] of [
      ["Characters", "New character"],
      ["Places", "New place"],
      ["Notes", "New note"],
    ]) {
      const plus = groupAdd(add);
      expect(plus.title).toBe(add);
      expect(plus.closest(".binder-item")?.contains(group(label))).toBe(true);
    }
    expect(groupContent("Characters").textContent).toBe("No characters yet.");
  });

  it("a type without its own word names its group", async () => {
    const creatures: SheetType = { folder: "creatures", label: "Creatures", fields: [] };
    const project = makeProject();
    await render({ project: { ...project, sheetTypes: [...project.sheetTypes, creatures] } });
    expect(groupAdd("New sheet in Creatures")).not.toBeNull();
    expect(groupContent("Creatures").textContent).toBe("No creatures yet.");
    await click(groupAdd("New sheet in Creatures"));
    expect(document.activeElement).toBe(nameInput("sheet"));
  });

  it("asks for the name in its group, opening the group if it was folded", async () => {
    await render();
    await click(group("Characters"));
    expect(groupContent("Characters").hidden).toBe(true);

    await click(groupAdd("New character"));
    const input = nameInput("character")!;
    expect(group("Characters").getAttribute("aria-expanded")).toBe("true");
    expect(groupContent("Characters").hidden).toBe(false);
    expect(groupContent("Characters").contains(input)).toBe(true);
    expect(input.placeholder).toBe("Name");
    expect(document.activeElement).toBe(input);
    // The group's empty note makes way for the name.
    expect(groupContent("Characters").querySelector(".empty-note")).toBeNull();
  });

  it("comes back to a name left typed, opening its group again if it was folded meanwhile", async () => {
    await render();
    await click(groupAdd("New character"));
    await type(nameInput("character")!, "Mira");
    await act(async () => nameInput("character")!.blur());
    await click(group("Characters"));
    expect(groupContent("Characters").hidden).toBe(true);

    await click(groupAdd("New character"));
    expect(groupContent("Characters").hidden).toBe(false);
    expect(document.activeElement).toBe(nameInput("character"));
    expect(nameInput("character")!.value).toBe("Mira");

    await act(async () => nameInput("character")!.blur());
    await click(group("Characters"));
    await click(button("New chapter, part or sheet"));
    await click(menuItem("New character"));
    expect(groupContent("Characters").hidden).toBe(false);
    expect(document.activeElement).toBe(nameInput("character"));
    expect(nameInput("character")!.value).toBe("Mira");
  });

  it("is offered in the add menu too, after chapters and parts, in its own group", async () => {
    await render();
    await click(group("Places"));
    expect(groupContent("Places").hidden).toBe(true);
    await click(button("New chapter, part or sheet"));
    expect(menu()?.getAttribute("aria-label")).toBe("Add to the project");
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "New chapter",
      "New part",
      "New character",
      "New place",
      "New note",
    ]);
    expect(menuItem("New character")?.previousElementSibling?.className).toBe("popover-gap");

    await click(menuItem("New place"));
    expect(menu()).toBeNull();
    const input = nameInput("place")!;
    expect(groupContent("Places").hidden).toBe(false);
    expect(groupContent("Places").contains(input)).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("Enter makes the sheet with its type and name, and opens it", async () => {
    await render();
    await click(groupAdd("New character"));
    const input = nameInput("character")!;
    await type(input, "  Mira Holt ");
    await press(input, "Enter");
    expect(props.onCreateSheet).toHaveBeenCalledExactlyOnceWith("characters", "Mira Holt");
    expect(props.onSheetCreated).toHaveBeenCalledExactlyOnceWith("sheets/characters/Mira Holt.md");
    expect(nameInput("character")).toBeNull();
    expect(plans).toEqual([]);
  });

  it("asks for a name before making the sheet", async () => {
    await render();
    await click(groupAdd("New place"));
    const input = nameInput("place")!;
    await press(input, "Enter");
    expect(alertText()).toBe("Give the place a name.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(props.onCreateSheet).not.toHaveBeenCalled();
  });

  it("Escape drops the name and gives focus back to the button it came from", async () => {
    await render();
    await click(groupAdd("New character"));
    let input = nameInput("character")!;
    await type(input, "Never mind");
    await press(input, "Escape");
    expect(nameInput("character")).toBeNull();
    expect(document.activeElement).toBe(groupAdd("New character"));

    await click(button("New chapter, part or sheet"));
    await click(menuItem("New note"));
    input = nameInput("note")!;
    await press(input, "Escape");
    expect(nameInput("note")).toBeNull();
    expect(document.activeElement).toBe(button("New chapter, part or sheet"));
    expect(props.onCreateSheet).not.toHaveBeenCalled();
  });

  it("shows a refusal below the name, which stays as typed for Enter to try again", async () => {
    vi.mocked(props.onCreateSheet).mockRejectedValueOnce(new Error("sheets/characters/Mira Holt.md already exists"));
    await render();
    await click(groupAdd("New character"));
    const input = nameInput("character")!;
    await type(input, "Mira Holt");
    await press(input, "Enter");
    expect(alertText()).toBe("sheets/characters/Mira Holt.md already exists");
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("Mira Holt");
    expect(input.readOnly).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(props.onSheetCreated).not.toHaveBeenCalled();

    // Typing clears the message; Enter tries again.
    await type(input, "Mira Holt 2");
    expect(alertText()).toBeNull();
    await press(input, "Enter");
    expect(props.onSheetCreated).toHaveBeenCalledExactlyOnceWith("sheets/characters/Mira Holt 2.md");
  });

  it("leaving the field drops an empty name and keeps a typed one for Enter", async () => {
    await render();
    await click(groupAdd("New character"));
    await act(async () => nameInput("character")!.blur());
    expect(nameInput("character")).toBeNull();

    await click(groupAdd("New character"));
    await type(nameInput("character")!, "Mira");
    await act(async () => nameInput("character")!.blur());
    expect(nameInput("character")?.value).toBe("Mira");
    expect(props.onCreateSheet).not.toHaveBeenCalled();

    // Its button again goes back to the name, as typed.
    await click(groupAdd("New character"));
    expect(document.activeElement).toBe(nameInput("character"));
    expect(nameInput("character")?.value).toBe("Mira");
  });

  it("waits while the project changes on disk, and while the sheet is being made", async () => {
    await render({ busy: true });
    expect(groupAdd("New character").disabled).toBe(true);
    expect(groupAdd("New note").disabled).toBe(true);

    await render({ busy: false });
    const answer = deferred<string>();
    vi.mocked(props.onCreateSheet).mockReturnValueOnce(answer.promise);
    await click(groupAdd("New character"));
    const input = nameInput("character")!;
    await type(input, "Tomas");
    await press(input, "Enter");
    expect(input.readOnly).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(groupAdd("New character").disabled).toBe(true);
    expect(button("New chapter, part or sheet")?.disabled).toBe(true);
    await press(input, "Enter");
    await press(input, "Escape");
    expect(props.onCreateSheet).toHaveBeenCalledOnce();
    expect(input.isConnected).toBe(true);

    await act(async () => answer.resolve("sheets/characters/Tomas.md"));
    expect(props.onSheetCreated).toHaveBeenCalledExactlyOnceWith("sheets/characters/Tomas.md");
    expect(input.isConnected).toBe(false);
    expect(groupAdd("New character").disabled).toBe(false);
  });

  it("doesn't open a sheet made after another project opened", async () => {
    const answer = deferred<string>();
    vi.mocked(props.onCreateSheet).mockReturnValueOnce(answer.promise);
    await render();
    await click(groupAdd("New character"));
    const input = nameInput("character")!;
    await type(input, "Tomas");
    await press(input, "Enter");
    await render({ project: { ...makeProject(), root: "/other" } });
    await act(async () => answer.resolve("sheets/characters/Tomas.md"));
    expect(props.onSheetCreated).not.toHaveBeenCalled();
    expect(nameInput("character")).toBeNull();
  });
});

describe("a sheet's menu", () => {
  const ARNO = "sheets/characters/Arno Kell.md";
  const ELENA = "sheets/characters/Elena Voss.md";
  const MIRA = "sheets/characters/Mira Holt.md";
  const VARN = "sheets/places/Varn.md";
  const SHEETS: Record<string, string> = {
    [ARNO]: "---\nname: Arno Kell\n---\n",
    [ELENA]: "---\nname: Elena Voss\nrole: Lead\n---\n\nShe keeps the inn.\n",
    [MIRA]: "---\nname: Mira Holt\n---\n",
    [VARN]: "---\nname: Varn\n---\n",
  };

  /** The test project with these sheets. */
  function withSheets(ids: string[]): Project {
    return buildProject({
      root: "/test",
      folderName: "Test",
      projectJson: null,
      files: [{ path: ONE, text: "# One\n\nElena waits.\n" }, ...ids.map((id) => ({ path: id, text: SHEETS[id] }))],
      folders: ["manuscript", P1],
      skipped: [],
    });
  }

  /** As useProject's changeBinder: the change is made, then the binder shows the project read again. */
  function readAgainAs(next: (plan: Plan | null) => Project) {
    return vi.fn(async (makePlan: (p: Project) => Plan | null) => {
      const plan = makePlan(props.project);
      plans.push(plan);
      props = { ...props, project: next(plan) };
      root.render(createElement(Binder, props));
    });
  }

  const sheetItem = (id: string) =>
    [...container.querySelectorAll<HTMLElement>("[data-sheet-row]")].find((r) => r.dataset.sheetRow === id)!;
  const sheetButton = (id: string) => sheetItem(id).querySelector<HTMLElement>(".binder-row")!;

  it("opens on right-click with Edit, then Move to Trash after a gap", async () => {
    await render({ project: withSheets([ARNO, ELENA, VARN]) });
    await rightClick(sheetItem(ELENA));
    expect(menu()?.getAttribute("aria-label")).toBe("Elena Voss");
    expect(menuItems().map((item) => item.textContent)).toEqual(["Edit", "Move to Trash"]);
    expect(menuItem("Move to Trash")?.previousElementSibling?.className).toBe("popover-gap");
    expect(document.activeElement).toBe(menuItem("Edit"));
    expect(sheetItem(ELENA).classList.contains("is-menu-open")).toBe(true);

    // Escape closes it and gives focus back to the row.
    await press(menuItem("Edit")!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(sheetButton(ELENA));
  });

  it("opens from the row's More button too, which closes it again", async () => {
    await render({ project: withSheets([ARNO, ELENA, VARN]) });
    const more = button("Actions for Varn")!;
    expect(sheetItem(VARN).contains(more)).toBe(true);
    await click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(menuItems().map((item) => item.textContent)).toEqual(["Edit", "Move to Trash"]);
    await click(more);
    expect(menu()).toBeNull();
  });

  it("Edit opens the sheet's form in the inspector", async () => {
    await render({ project: withSheets([ARNO, ELENA, VARN]) });
    await rightClick(sheetItem(ARNO));
    await click(menuItem("Edit"));
    expect(menu()).toBeNull();
    expect(props.onEditSheet).toHaveBeenCalledExactlyOnceWith(ARNO);
    expect(plans).toEqual([]);
  });

  it("Move to Trash moves it at once; focus goes to the next sheet of its type, the one before, or the type", async () => {
    const all = [ARNO, ELENA, MIRA, VARN];
    let left = all;
    const without = (id: string) => () => {
      left = left.filter((s) => s !== id);
      return withSheets(left);
    };

    // The first character: the next one takes focus.
    await render({ project: withSheets(all), onChange: readAgainAs(without(ARNO)) });
    let before = props.project;
    await rightClick(sheetItem(ARNO));
    await click(menuItem("Move to Trash"));
    expect(plans).toEqual([planTrashSheet(before, ARNO)]);
    expect(sheetItem(ARNO)).toBeUndefined();
    expect(document.activeElement).toBe(sheetButton(ELENA));

    // The last character: the one before.
    await render({ onChange: readAgainAs(without(MIRA)) });
    before = props.project;
    await click(button("Actions for Mira Holt"));
    await click(menuItem("Move to Trash"));
    expect(plans.at(-1)).toEqual(planTrashSheet(before, MIRA));
    expect(document.activeElement).toBe(sheetButton(ELENA));

    // The only one left: the Characters row.
    await render({ onChange: readAgainAs(without(ELENA)) });
    await rightClick(sheetItem(ELENA));
    await click(menuItem("Move to Trash"));
    expect(document.activeElement).toBe(button("Characters"));
    expect(alertText()).toBeNull();
  });

  it("shows why by the row when the sheet can't be moved, and focus comes back to it", async () => {
    await render({
      project: withSheets([ARNO, ELENA, VARN]),
      onChange: vi.fn(async () => Promise.reject(new Error("The disk is full."))),
    });
    await rightClick(sheetItem(ELENA));
    await click(menuItem("Move to Trash"));
    expect(alertText()).toBe("The disk is full.");
    expect(sheetItem(ELENA).nextElementSibling?.textContent).toBe("The disk is full.");
    expect(sheetItem(ELENA).nextElementSibling?.className).toContain("binder-error--nested");
    expect(document.activeElement).toBe(sheetButton(ELENA));
  });

  it("waits while the project changes on disk, and while the sheet is being moved", async () => {
    await render({ project: withSheets([ARNO, ELENA, VARN]), busy: true });
    expect(button("Actions for Elena Voss")?.disabled).toBe(true);
    await rightClick(sheetItem(ELENA));
    expect(menu()).toBeNull();

    const answer = deferred<void>();
    await render({ busy: false, onChange: vi.fn(() => answer.promise) });
    await rightClick(sheetItem(ELENA));
    await click(menuItem("Move to Trash"));
    expect(sheetItem(ELENA).getAttribute("aria-busy")).toBe("true");
    expect(sheetItem(ARNO).hasAttribute("aria-busy")).toBe(false);
    expect(button("Actions for Elena Voss")?.disabled).toBe(true);
    expect(button("Actions for Arno Kell")?.disabled).toBe(true);
    await rightClick(sheetItem(ARNO));
    expect(menu()).toBeNull();
    await act(async () => answer.resolve());
    expect(button("Actions for Arno Kell")?.disabled).toBe(false);
  });

  it("doesn't stop a long-press: the row has no touch handlers", async () => {
    await render({ project: withSheets([ARNO]) });
    const touch = new Event("touchstart", { bubbles: true, cancelable: true });
    await act(async () => {
      sheetButton(ARNO).dispatchEvent(touch);
    });
    expect(touch.defaultPrevented).toBe(false);
  });

  it("in the Trash, a sheet says what it is, and Restore puts it back", async () => {
    const project = buildProject({
      root: "/test",
      folderName: "Test",
      projectJson: JSON.stringify({ trash: { "trash/Elena Voss.md": { from: ELENA } } }),
      files: [
        { path: ONE, text: "# One\n" },
        { path: "trash/Elena Voss.md", text: SHEETS[ELENA] },
      ],
      folders: ["manuscript", P1, "trash"],
      skipped: [],
    });
    await render({ project });
    await click(button("Trash"));
    expect(container.querySelector(".trash-row .binder-row-meta")?.textContent).toBe("Character · 4 words");
    await click(button("Restore Elena Voss"));
    expect(plans).toEqual([planRestore(project, "trash/Elena Voss.md")]);
  });
});
