// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { planMoveChapter, planNewChapter, planRestore, type ChapterDetails, type Plan } from "../../core/binder";
import { buildProject, type Project } from "../../core/project";
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
    projects: {
      current: "/test",
      loads: 1,
      list: async () => [],
      open: async () => undefined,
      create: async () => undefined,
      canCreate: true,
      busy: false,
      phone: false,
    },
    onChange: vi.fn(async (makePlan: (p: Project) => Plan | null) => {
      plans.push(makePlan(props.project));
    }),
    onChapterDetails: vi.fn<(id: string, details: ChapterDetails) => void>(),
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
    await click(button("New chapter or part"));
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
    expect(document.activeElement).toBe(button("New chapter or part"));
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
    expect(button("New chapter or part")?.disabled).toBe(true);
    await rightClick(row("chapter", ONE));
    expect(menu()).toBeNull();
  });
});
