// @vitest-environment jsdom
// Save and Quit by their shortcuts, from a field that hands its edit over only when it is left.
// The real useProject and Workspace, on a project kept in memory.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import type { Change } from "../../core/binder";
import { applyChange, type MemoryTree } from "../../core/memoryFiles";
import type { ProjectSnapshot } from "../../core/project";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { useProject } from "../../core/useProject";
import { HOVER_QUERY } from "../hooks";
import { Workspace } from "../Workspace";

const ROOT = "/projects/Test";
const CHAPTER = "manuscript/01 Arrival.md";
const ELENA = "sheets/characters/Elena Voss.md";

/* The disk, as the Rust core keeps it ------------------------------------------ */

let tree: MemoryTree;

function snapshot(): ProjectSnapshot {
  return {
    root: ROOT,
    folderName: "Test",
    projectJson: null,
    files: [...tree.files].map(([path, text]) => ({ path, text })),
    folders: [...tree.folders].filter((f) => f.startsWith("manuscript")),
    skipped: [],
  };
}

const unused = async () => {
  throw new Error("unused");
};

/** As the core's: writes the file. */
async function write(_root: string, path: string, text: string): Promise<string | null> {
  tree.files.set(path, text);
  return null;
}
const writeFile = vi.fn(write);
const applyChanges = vi.fn(async (_root: string, change: Change) => {
  applyChange(tree, change);
  return snapshot();
});
/** The page's handler for the window's close: the workspace's close dialog. */
let beforeClose: (() => Promise<boolean>) | null = null;
/** The window went away: its close was allowed. */
const closed = vi.fn();
/** As the app's: the window asks the page first, and closes if the page allows it. */
const closeWindow = vi.fn(async () => {
  if (await beforeClose?.()) closed();
});

const fake: Backend = {
  kind: "app",
  canOpenFolders: false,
  canCreateProjects: true,
  listProjects: async () => [],
  createProject: unused,
  openSampleProject: async () => snapshot(),
  openProject: unused,
  pickProjectFolder: async () => null,
  applyChanges,
  writeFile,
  listVersions: async () => [],
  restoreVersion: unused,
  closeWindow,
  onCloseRequested: async (handler) => {
    beforeClose = handler;
    return () => {
      beforeClose = null;
    };
  },
};

vi.mock("../../core/backend", () => ({ loadBackend: async () => fake }));

/* The window ---------------------------------------------------------------------- */

function App() {
  const api = useProject();
  if (api.load.status !== "ready" || !api.project || !api.backend) return null;
  return createElement(Workspace, {
    api,
    project: api.project,
    backend: api.backend,
    settings: { ...DEFAULT_SETTINGS, mode: "plain" },
    update: () => undefined,
    isPhone: false,
  });
}

let container: HTMLDivElement;
let root: Root;
/** A touch screen, where editors don't take focus when they mount; else a mouse. */
let coarse = false;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: coarse ? query === "(pointer: coarse)" : query === HOVER_QUERY,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

beforeEach(async () => {
  coarse = false;
  localStorage.clear();
  tree = {
    files: new Map([
      [CHAPTER, "# Arrival\n\nElena waits.\n"],
      [ELENA, "---\nname: Elena Voss\naliases: [Elena]\n---\n"],
    ]),
    folders: new Set(["manuscript", "sheets", "sheets/characters"]),
  };
  writeFile.mockReset().mockImplementation(write);
  applyChanges.mockReset().mockImplementation(async (_root: string, change: Change) => {
    applyChange(tree, change);
    return snapshot();
  });
  closeWindow.mockClear();
  closed.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
  await settle();
  await settle();
});

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.unmount());
  container.remove();
});

/* Finding and doing things ------------------------------------------------------- */

const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((i) => i.textContent === label);
const nameField = () => container.querySelector<HTMLInputElement>('.sheet-form input[aria-label="Name"]')!;
const titleField = () => container.querySelector<HTMLInputElement>('.binder input[aria-label="Chapter title"]');
const saveCheck = () => container.querySelector(".status-bar svg.lucide-check");
const alerts = () => [...container.querySelectorAll('.sheet-form [role="alert"]')].map((a) => a.textContent);
/** The close dialog, open while a close waits for an answer. */
const closeDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const dialogButton = (label: string) =>
  [...(closeDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (b) => b.textContent?.trim() === label,
  );

async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  });
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("Nothing to click");
  await act(async () => el.click());
}

/** Types in a field, as the keyboard does, and leaves the caret at `caret`. */
async function type(field: HTMLInputElement, value: string, caret = value.length) {
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  field.setSelectionRange(caret, caret);
}

/** Ctrl and a letter where focus is. Resolves to the event, to see whether it was handled. */
async function ctrl(letter: string) {
  const event = new KeyboardEvent("keydown", {
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  await settle();
  return event;
}

/** A key that isn't a shortcut, where focus is. */
const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

/** A key pressed where focus is, outside act. */
const keyDown = (init: KeyboardEventInit) =>
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
const CTRL_Q = { key: "q", code: "KeyQ", ctrlKey: true };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` holds, in real time: for what happens after a frame, or as the app runs. */
async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Runs React as the app does: outside act, which would render every update
 * at its end. Updates render in later tasks, and effects after them.
 */
async function asInTheApp(run: () => Promise<void>) {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await run();
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

/** A promise to settle by hand, to control when the core answers. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Elena Voss's form in the inspector, from her Edit in the binder. */
async function openElenaForm() {
  await rightClick(container.querySelector(`[data-sheet-row="${ELENA}"]`)!);
  await click(menuItem("Edit"));
  expect(nameField().value).toBe("Elena Voss");
}

/** The chapter's title in the binder, ready to be changed. */
async function renameChapter(): Promise<HTMLInputElement> {
  const row = [...container.querySelectorAll<HTMLElement>('[data-drag-row="chapter"]')].find(
    (r) => r.dataset.dragId === CHAPTER,
  )!;
  await rightClick(row);
  await click(menuItem("Rename"));
  return titleField()!;
}

/* Tests ------------------------------------------------------------------------------ */

describe("Ctrl+S in a field that is taken when left", () => {
  it("saves a sheet's new name, shows the check, and leaves the caret where it was", async () => {
    await openElenaForm();
    await type(nameField(), "Elena Marsh", 5);
    expect(writeFile).not.toHaveBeenCalled();

    const event = await ctrl("s");
    expect(event.defaultPrevented).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(ROOT, ELENA, expect.stringContaining("name: Elena Marsh"));
    expect(tree.files.get(ELENA)).toContain("name: Elena Marsh");
    expect(saveCheck()).not.toBeNull();
    expect(document.activeElement).toBe(nameField());
    expect([nameField().selectionStart, nameField().selectionEnd]).toEqual([5, 5]);
  });

  it("saves a sheet's other names too", async () => {
    await openElenaForm();
    const alias = container.querySelector<HTMLInputElement>('.sheet-form input[aria-label="Also called"]')!;
    await type(alias, "Lena");
    await ctrl("s");
    expect(tree.files.get(ELENA)).toContain("Lena");
    expect(saveCheck()).not.toBeNull();
    expect(document.activeElement).toBe(alias);
  });

  it("shows no check when the field refuses what was typed, which says why", async () => {
    await openElenaForm();
    await type(nameField(), "  ");
    await ctrl("s");
    expect(alerts()).toEqual(["A sheet needs a name."]);
    expect(saveCheck()).toBeNull();
    expect(tree.files.get(ELENA)).toContain("name: Elena Voss");
    expect(document.activeElement).toBe(nameField());
  });

  it("renames a chapter typed in the binder before it shows the check", async () => {
    const field = await renameChapter();
    await type(field, "The landing");
    await ctrl("s");
    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(tree.files.has("manuscript/01 The landing.md")).toBe(true);
    expect(container.querySelector(".binder")?.textContent).toContain("The landing");
    expect(saveCheck()).not.toBeNull();
  });

  it("shows no check when the binder can't make the change, and keeps the title with the reason", async () => {
    applyChanges.mockRejectedValueOnce(new Error("manuscript/01 The landing.md already exists"));
    const field = await renameChapter();
    await type(field, "The landing");
    await ctrl("s");
    expect(saveCheck()).toBeNull();
    expect(titleField()?.value).toBe("The landing");
    expect(document.activeElement).toBe(titleField());
    expect(container.querySelector(".binder [role='alert']")?.textContent).toBe(
      "manuscript/01 The landing.md already exists",
    );
  });

  it("leaves the chapter's text alone: no blur, the caret stays", async () => {
    const text = container.querySelector<HTMLElement>(".cm-content")!;
    await act(async () => text.focus());
    const blurred = vi.fn();
    text.addEventListener("blur", blurred);
    await ctrl("s");
    expect(blurred).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(text);
    expect(saveCheck()).not.toBeNull();
  });
});

describe("Ctrl+Q in a field that is taken when left", () => {
  it("asks to save the sheet's new name, and writes it before the window closes", async () => {
    await openElenaForm();
    await type(nameField(), "Elena Marsh");
    await ctrl("q");
    // Taken from the field, waiting for the answer: autosave waits too.
    expect(closeDialog()?.textContent).toContain("Save changes before closing?");
    await act(async () => {
      await sleep(1500);
    });
    expect(writeFile).not.toHaveBeenCalled();
    await click(dialogButton("Save and close"));
    await settle();
    expect(writeFile).toHaveBeenCalledWith(ROOT, ELENA, expect.stringContaining("name: Elena Marsh"));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(closed.mock.invocationCallOrder[0]);
  });

  it("closes without the new name after Close without saving", async () => {
    await openElenaForm();
    await type(nameField(), "Elena Marsh");
    await ctrl("q");
    await click(dialogButton("Close without saving"));
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
    expect(tree.files.get(ELENA)).toContain("name: Elena Voss");
  });

  it("stays open after Cancel, and autosave writes the name again", async () => {
    await openElenaForm();
    await type(nameField(), "Elena Marsh");
    await ctrl("q");
    await click(dialogButton("Cancel"));
    await settle();
    expect(closeDialog()).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    await act(async () => {
      await sleep(1100);
    });
    expect(tree.files.get(ELENA)).toContain("name: Elena Marsh");
  });

  it("renames a chapter typed in the binder before asking, then says everything is saved", async () => {
    const field = await renameChapter();
    await type(field, "The landing");
    await ctrl("q");
    expect(applyChanges).toHaveBeenCalledTimes(1);
    expect(tree.files.has("manuscript/01 The landing.md")).toBe(true);
    expect(closeDialog()?.textContent).toContain("All your changes are saved.");
    await click(dialogButton("Close"));
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stays open once for a field that refused what was typed, so its reason shows", async () => {
    await openElenaForm();
    await type(nameField(), "");
    await ctrl("q");
    expect(closeDialog()).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["A sheet needs a name."]);
    expect(document.activeElement).toBe(nameField());
    // The field refuses again (emptied with no key, to keep only Ctrl between the two Quits)…
    await type(nameField(), "");
    // …and Ctrl, on its way to Ctrl+Q, isn't something else pressed: this Quit goes on without the name.
    await press("Control");
    await ctrl("q");
    await click(dialogButton("Close"));
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a key", () => press("Backspace")],
    ["a press", () => act(async () => nameField().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))],
  ])("stops again for a later refusal once %s came between", async (_, between) => {
    await openElenaForm();
    await type(nameField(), "");
    await ctrl("q");
    expect(closed).not.toHaveBeenCalled();
    await between();
    await type(nameField(), "");
    await ctrl("q");
    expect(closeDialog()).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["A sheet needs a name."]);
  });

});

describe("a binder change still being made when Save or Quit is pressed", () => {
  /** The chapter renamed with Enter, its change waiting on the core; resolves to the core's answer, to fail. */
  async function renameUnderWay() {
    const answer = deferred<ProjectSnapshot>();
    applyChanges.mockImplementationOnce(() => answer.promise);
    const field = await renameChapter();
    await type(field, "The landing");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(applyChanges).toHaveBeenCalledTimes(1);
    return answer;
  }

  const binderAlert = () => container.querySelector(".binder [role='alert']")?.textContent ?? null;
  const REFUSAL = "manuscript/01 The landing.md already exists";

  it("doesn't quit if it fails: the title and the reason stay", async () => {
    const answer = await renameUnderWay();
    await asInTheApp(async () => {
      keyDown(CTRL_Q);
      answer.reject(new Error(REFUSAL));
      await waitFor(() => binderAlert() === REFUSAL);
      // Time for the Quit to go on, were it to.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(closeDialog()).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(titleField()?.value).toBe("The landing");
  });

  it("shows no check if it fails", async () => {
    const answer = await renameUnderWay();
    await asInTheApp(async () => {
      keyDown({ key: "s", code: "KeyS", ctrlKey: true });
      answer.reject(new Error(REFUSAL));
      await waitFor(() => binderAlert() === REFUSAL);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(saveCheck()).toBeNull();
  });

  it("shows the check once it is made", async () => {
    const answer = await renameUnderWay();
    await asInTheApp(async () => {
      keyDown({ key: "s", code: "KeyS", ctrlKey: true });
      applyChange(tree, applyChanges.mock.calls[0][1]);
      answer.resolve(snapshot());
      await waitFor(() => saveCheck() !== null);
    });
    expect(tree.files.has("manuscript/01 The landing.md")).toBe(true);
  });
});

describe("one Quit at a time", () => {
  const binderAlert = () => container.querySelector(".binder [role='alert']")?.textContent ?? null;
  const REFUSAL = "manuscript/01 The landing.md already exists";
  const menuButton = () => container.querySelector<HTMLButtonElement>('.format-bar button[aria-label="Main menu"]')!;
  const quitItem = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find(
      (i) => i.querySelector(".menu-item-label")?.textContent === "Quit",
    );

  /** The chapter renamed with Enter to a title the core will refuse, its answer held back. */
  async function failingRename() {
    let fail: (error: Error) => void = () => undefined;
    applyChanges.mockImplementationOnce(
      () =>
        new Promise<ProjectSnapshot>((_, reject) => {
          fail = reject;
        }),
    );
    const field = await renameChapter();
    await type(field, "The landing");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    return () => fail(new Error(REFUSAL));
  }

  it("ignores a second Ctrl+Q while the first waits: the window stays open, the title and reason stay", async () => {
    const fail = await failingRename();
    await asInTheApp(async () => {
      keyDown(CTRL_Q);
      // A separate press: Ctrl again, then Q.
      keyDown({ key: "Control", ctrlKey: true });
      keyDown(CTRL_Q);
      fail();
      await waitFor(() => binderAlert() === REFUSAL);
      await sleep(100);
    });
    expect(closeDialog()).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(titleField()?.value).toBe("The landing");

    // The Quit after the one that stopped goes on without the title.
    await ctrl("q");
    await click(dialogButton("Close"));
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("can't be chosen again from the menu while the first waits", async () => {
    const fail = await failingRename();
    await asInTheApp(async () => {
      menuButton().click();
      await waitFor(() => quitItem() !== undefined);
      quitItem()!.click();
      await waitFor(() => quitItem() === undefined);
      menuButton().click();
      await waitFor(() => quitItem() !== undefined);
      expect(quitItem()!.disabled).toBe(true);
      quitItem()!.click();
      fail();
      await waitFor(() => binderAlert() === REFUSAL);
      await sleep(100);
      // Ready for the next Quit once this one has stopped.
      await waitFor(() => quitItem()?.disabled === false);
    });
    expect(closed).not.toHaveBeenCalled();
    expect(titleField()?.value).toBe("The landing");
  });

  it("ignores a second close while the dialog asks, and stays open when the save fails, saying why", async () => {
    await openElenaForm();
    await type(nameField(), "Elena Marsh");
    let fail: (error: Error) => void = () => undefined;
    writeFile.mockImplementationOnce(
      () =>
        new Promise<string | null>((_, reject) => {
          fail = reject;
        }),
    );
    await asInTheApp(async () => {
      keyDown(CTRL_Q);
      await waitFor(() => dialogButton("Save and close") !== undefined);
      // The dialog's question stands: Ctrl+Q waits, and the window's close button is refused.
      keyDown({ key: "Control", ctrlKey: true });
      keyDown(CTRL_Q);
      await closeWindow();
      await sleep(50);
      expect(closeWindow).toHaveBeenCalledTimes(2);
      expect(closed).not.toHaveBeenCalled();
      dialogButton("Save and close")!.click();
      await waitFor(() => writeFile.mock.calls.length === 1);
      fail(new Error("Disk full"));
      await waitFor(() => closeDialog()?.textContent?.includes("Disk full") ?? false);
      await sleep(100);
    });
    expect(closed).not.toHaveBeenCalled();
    expect(closeDialog()?.textContent).toContain("Couldn’t save your changes");

    await click(dialogButton("Close without saving"));
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(tree.files.get(ELENA)).toContain("name: Elena Voss");
  });
});

describe("a field that goes once its edit is taken", () => {
  const addFieldButton = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".sheet-form button")].find((b) => b.textContent === "Add a field");

  it("hands focus to the new field's value, for a new field's name", async () => {
    await openElenaForm();
    await click(addFieldButton());
    const name = container.querySelector<HTMLInputElement>('.sheet-form input[aria-label="Name of the new field"]')!;
    expect(document.activeElement).toBe(name);
    // Characters already have an age: Eyes is new.
    await type(name, "Eyes");
    await ctrl("s");
    await waitFor(() => !name.isConnected && document.activeElement !== document.body);
    const label = [...container.querySelectorAll<HTMLLabelElement>(".sheet-form .field label")].find(
      (l) => l.textContent === "Eyes",
    )!;
    expect(document.activeElement).toBe(document.getElementById(label.htmlFor));
  });

  it("hands focus to Add a field, for an empty new field's name", async () => {
    await openElenaForm();
    await click(addFieldButton());
    await ctrl("s");
    await waitFor(() => document.activeElement === addFieldButton());
  });

  it("leaves the caret in the chapter's text after a rename, where it goes on its own with a mouse", async () => {
    const field = await renameChapter();
    await type(field, "The landing");
    await ctrl("s");
    await waitFor(() => !field.isConnected);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement?.closest(".editor-pane")).not.toBeNull();
  });

  it("hands focus to the renamed row on a touch screen", async () => {
    coarse = true;
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(App)));
    await settle();
    await settle();
    const field = await renameChapter();
    await type(field, "The landing");
    await ctrl("s");
    await waitFor(() => !field.isConnected && document.activeElement !== document.body);
    const row = container.querySelector('[data-drag-row="chapter"][data-drag-id="manuscript/01 The landing.md"]');
    expect(document.activeElement).toBe(row?.querySelector(".binder-row"));
  });
});
