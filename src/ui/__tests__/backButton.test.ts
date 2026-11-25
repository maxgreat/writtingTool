// @vitest-environment jsdom
// A phone's Back button, through the whole app: the real App, useProject and Workspace, on a
// project kept in memory, pressed through the handler the app gives the backend.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import type { Backend, Version } from "../../core/backend";
import type { Change } from "../../core/binder";
import { applyChange, type MemoryTree } from "../../core/memoryFiles";
import type { ProjectSnapshot } from "../../core/project";
import type { ProjectEntry } from "../../core/projects";
import { BACK_AGAIN } from "../BackStack";
import { HOVER_QUERY, PHONE_QUERY } from "../hooks";

const ROOT = "/data/projects/Test";
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

/* The backend -------------------------------------------------------------------- */

const unused = async () => {
  throw new Error("unused");
};

/** The handler the app gave for Back, while it has one. */
let back: (() => void) | null = null;
const onBackButton = vi.fn(async (handler: () => void) => {
  back = handler;
  return () => {
    if (back === handler) back = null;
  };
});
const exitApp = vi.fn<() => Promise<void>>();

async function write(_root: string, path: string, text: string): Promise<string | null> {
  tree.files.set(path, text);
  return null;
}
const writeFile = vi.fn(write);
const applyChanges = vi.fn(async (_root: string, change: Change) => {
  applyChange(tree, change);
  return snapshot();
});
const openSampleProject = vi.fn(async () => snapshot());
const openProject = vi.fn<(path: string) => Promise<ProjectSnapshot>>();

const VERSION: Version = { savedAt: Date.now() - 60 * 60 * 1000, text: "# Arrival\n\nElena waited.\n" };
const CURRENT: ProjectEntry = { path: ROOT, title: "Test", inAppFolder: true };
const OTHER: ProjectEntry = { path: "/data/projects/Lighthouse", title: "The Lighthouse", inAppFolder: true };

/** Android: no folder picker and no window to close, but a Back button and a way to close the app. */
function android(): Backend {
  return {
    kind: "app",
    canOpenFolders: false,
    canCreateProjects: true,
    listProjects: async () => [CURRENT, OTHER],
    createProject: unused,
    openSampleProject,
    openProject,
    pickProjectFolder: async () => null,
    applyChanges,
    writeFile,
    listVersions: async () => [VERSION],
    restoreVersion: unused,
    onCloseRequested: async () => () => undefined,
    onBackButton,
    exitApp,
  };
}

/** The desktop app: a window to close, and no Back button. */
function desktop(): Backend {
  const { onBackButton: _onBackButton, exitApp: _exitApp, ...rest } = android();
  return { ...rest, canOpenFolders: true, closeWindow: async () => undefined };
}

let fake: Backend;
vi.mock("../../core/backend", () => ({ loadBackend: async () => fake }));

/* The device ----------------------------------------------------------------------- */

/** A phone (narrow, touch), a tablet (wide, touch), a desktop, or a desktop window made narrow. */
type Device = "phone" | "tablet" | "desktop" | "narrow desktop";

function useDevice(device: Device) {
  const phone = device === "phone" || device === "narrow desktop";
  const touch = device === "phone" || device === "tablet";
  window.matchMedia = ((query: string) => ({
    matches:
      (phone && query === PHONE_QUERY) ||
      (touch && query === "(pointer: coarse)") ||
      (!touch && query === HOVER_QUERY),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

let container: HTMLDivElement;
let root: Root;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount({ backend = android(), device = "phone" as Device } = {}) {
  fake = backend;
  useDevice(device);
  await act(async () => root.render(createElement(App)));
  await settle();
  await settle();
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

beforeEach(() => {
  localStorage.clear();
  // Plain, whose names answer taps without layout.
  localStorage.setItem("writingTool.viewSettings.v1", JSON.stringify({ mode: "plain" }));
  tree = {
    files: new Map([
      [CHAPTER, "# Arrival\n\nElena waits.\n"],
      [ELENA, "---\nname: Elena Voss\naliases: [Elena]\n---\n"],
    ]),
    folders: new Set(["manuscript", "sheets", "sheets/characters"]),
  };
  back = null;
  onBackButton.mockClear();
  exitApp.mockReset().mockResolvedValue(undefined);
  writeFile.mockReset().mockImplementation(write);
  applyChanges.mockClear();
  openSampleProject.mockReset().mockImplementation(async () => snapshot());
  openProject.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* Finding and doing things ------------------------------------------------------- */

/** Android's Back button, through the handler the app gave the backend. */
async function pressBack() {
  if (!back) throw new Error("Back isn't handled");
  await act(async () => back!());
  await settle();
}

async function click(el: Element | null | undefined) {
  if (!(el instanceof HTMLElement)) throw new Error("Nothing to click");
  await act(async () => el.click());
}

async function rightClick(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }));
  });
}

/** Types in a field, as the keyboard does. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    field.focus();
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
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

const binderOpen = () => container.querySelector("#binder")!.classList.contains("is-open");
const inspectorOpen = () => container.querySelector("#inspector")!.classList.contains("is-open");
const barButton = (label: string) => container.querySelector<HTMLButtonElement>(`.format-bar button[aria-label^="${label}"]`);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')].find((i) => i.textContent === label);
const bottomSheet = () => document.querySelector<HTMLElement>(".bottom-sheet.is-open");
const chapterRow = () => container.querySelector<HTMLElement>(`[data-drag-row="chapter"][data-drag-id="${CHAPTER}"]`)!;
const chapterTitle = () => chapterRow().querySelector(".binder-row-title")?.textContent;
const inspector = () => container.querySelector<HTMLElement>("#inspector")!;
const tab = (label: string) => [...inspector().querySelectorAll(".inspector-tabs .tab")].find((t) => t.textContent === label);
const currentTab = () => inspector().querySelector('.inspector-tabs [aria-current="true"]')?.textContent;
const sheetPage = () => inspector().querySelector(".sheet-nav");
const sheetRow = (name: string) =>
  [...inspector().querySelectorAll(".sheet-list .list-row")].find((r) => r.querySelector(".list-row-title")?.textContent === name);
const saveError = () => container.querySelector<HTMLElement>(".status-bar .save-error-text")?.title ?? "";

async function showBinder() {
  await click(barButton("Show binder"));
  expect(binderOpen()).toBe(true);
}

async function showInspector() {
  await click(barButton("Show inspector"));
  await settle();
  expect(inspectorOpen()).toBe(true);
}

/** Elena Voss's sheet, from the Characters list in the inspector. */
async function openElenaFromList() {
  await showInspector();
  await click(tab("Characters"));
  await click(sheetRow("Elena Voss"));
  expect(sheetPage()).not.toBeNull();
}

/** An edit waiting to be saved: the chapter's synopsis, typed in the inspector, which Back then closes. */
async function leaveAnEditPending() {
  await showInspector();
  await type(inspector().querySelector<HTMLTextAreaElement>('textarea[aria-label="Synopsis"]')!, "Elena arrives.");
  await pressBack();
  expect(inspectorOpen()).toBe(false);
}

/* Tests ------------------------------------------------------------------------------ */

describe("Back closes one thing per press, the one on top", () => {
  it("a menu opened in the binder, then the binder, then the app", async () => {
    await mount();
    await showBinder();
    await rightClick(chapterRow());
    expect(menu()).not.toBeNull();

    await pressBack();
    expect(menu()).toBeNull();
    expect(binderOpen()).toBe(true);

    await pressBack();
    expect(binderOpen()).toBe(false);
    expect(exitApp).not.toHaveBeenCalled();

    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("reads each press against the screen as the press before left it, however fast they come", async () => {
    await mount();
    await showBinder();
    await rightClick(chapterRow());
    expect(menu()).not.toBeNull();
    // As in the app: no act, so nothing renders between the two presses unless Back makes it.
    await asInTheApp(async () => {
      back!();
      expect(menu()).toBeNull();
      expect(binderOpen()).toBe(true);
      back!();
      expect(binderOpen()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("the main menu", async () => {
    await mount();
    await click(barButton("Main menu"));
    expect(menu()).not.toBeNull();
    await pressBack();
    expect(menu()).toBeNull();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("the Projects sheet opened from the binder, then the binder", async () => {
    await mount();
    await showBinder();
    await click(container.querySelector(".binder-title-button"));
    expect(bottomSheet()?.textContent).toContain("Projects");

    await pressBack();
    expect(bottomSheet()).toBeNull();
    expect(binderOpen()).toBe(true);

    await pressBack();
    expect(binderOpen()).toBe(false);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("the preview of a name tapped in the text", async () => {
    await mount();
    const mark = [...container.querySelectorAll(".cm-content .name-mark")].find((m) => m.textContent === "Elena")!;
    await act(async () => mark.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(bottomSheet()?.querySelector(".sheet-name")?.textContent).toBe("Elena Voss");

    await pressBack();
    expect(bottomSheet()).toBeNull();
    expect(exitApp).not.toHaveBeenCalled();

    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("a chapter's title being typed in the binder, as Escape does: the title stays as it was", async () => {
    await mount();
    await showBinder();
    await rightClick(chapterRow());
    await click(menuItem("Rename"));
    const field = container.querySelector<HTMLInputElement>('.binder input[aria-label="Chapter title"]')!;
    await type(field, "Departure");

    await pressBack();
    expect(container.querySelector('.binder input[aria-label="Chapter title"]')).toBeNull();
    expect(chapterTitle()).toBe("Arrival");
    expect(applyChanges).not.toHaveBeenCalled();
    expect(binderOpen()).toBe(true);

    await pressBack();
    expect(binderOpen()).toBe(false);
  });

  it("a new sheet's name in the inspector's list, then the inspector", async () => {
    await mount();
    await showInspector();
    await click(tab("Characters"));
    await click([...inspector().querySelectorAll(".sheet-list .add-button")].find((b) => b.textContent === "New character"));
    await type(inspector().querySelector<HTMLInputElement>('input[aria-label="Name of the new character"]')!, "Mara");

    await pressBack();
    expect(inspector().querySelector('input[aria-label="Name of the new character"]')).toBeNull();
    expect(applyChanges).not.toHaveBeenCalled();
    expect(inspectorOpen()).toBe(true);

    await pressBack();
    expect(inspectorOpen()).toBe(false);
  });

  it("the question before restoring a version, then the inspector", async () => {
    await mount();
    await showInspector();
    await click(inspector().querySelector(".version-restore"));
    expect(inspector().querySelector(".version-confirm")).not.toBeNull();

    await pressBack();
    expect(inspector().querySelector(".version-confirm")).toBeNull();
    expect(inspectorOpen()).toBe(true);

    await pressBack();
    expect(inspectorOpen()).toBe(false);
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("nothing left open in a panel that was closed: it is off screen, so Back closes the app", async () => {
    await mount();
    await showInspector();
    await click(inspector().querySelector(".version-restore"));
    expect(inspector().querySelector(".version-confirm")).not.toBeNull();
    await click(barButton("Hide inspector"));
    expect(inspectorOpen()).toBe(false);

    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("focus mode", async () => {
    await mount();
    await key({ key: "F11", code: "F11" });
    expect(container.querySelector(".workspace")!.classList.contains("is-focus")).toBe(true);

    await pressBack();
    expect(container.querySelector(".workspace")!.classList.contains("is-focus")).toBe(false);
    expect(exitApp).not.toHaveBeenCalled();

    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("spends the press on what is on top even when it can't close yet: nothing under it closes, the app stays", async () => {
    const opening = deferred<ProjectSnapshot>();
    openProject.mockReturnValue(opening.promise);
    await mount();
    await showBinder();
    await click(container.querySelector(".binder-title-button"));
    await settle();
    await click([...bottomSheet()!.querySelectorAll("button.project-row")].find((b) => b.textContent?.includes("The Lighthouse")));

    // The project is opening: the sheet waits for it.
    await pressBack();
    await pressBack();
    expect(bottomSheet()).not.toBeNull();
    expect(binderOpen()).toBe(true);
    expect(exitApp).not.toHaveBeenCalled();

    await act(async () => opening.reject(new Error("The folder is gone.")));
    await settle();
    await pressBack();
    expect(bottomSheet()).toBeNull();
    expect(binderOpen()).toBe(true);
  });
});

describe("Back in the inspector", () => {
  it("goes from a sheet back to the list it was opened from, then closes the inspector", async () => {
    await mount();
    await openElenaFromList();

    await pressBack();
    expect(sheetPage()).toBeNull();
    expect(currentTab()).toBe("Characters");
    expect(sheetRow("Elena Voss")).toBeDefined();
    expect(inspectorOpen()).toBe(true);

    await pressBack();
    expect(inspectorOpen()).toBe(false);
  });

  it("keeps that way back through Edit, closing a new field's name first, and takes a name being typed", async () => {
    await mount();
    await openElenaFromList();
    await click([...inspector().querySelectorAll("button")].find((b) => b.textContent === "Edit"));
    await click([...inspector().querySelectorAll(".sheet-form .add-button")].find((b) => b.textContent === "Add a field"));
    expect(inspector().querySelector('input[aria-label="Name of the new field"]')).not.toBeNull();

    await pressBack();
    expect(inspector().querySelector('input[aria-label="Name of the new field"]')).toBeNull();
    expect(inspector().querySelector(".sheet-form")).not.toBeNull();

    // Back to the list, with the name being typed in the form taken, as a tap outside would.
    const name = inspector().querySelector<HTMLInputElement>('.sheet-form input[aria-label="Name"]')!;
    await type(name, "Elena Vale");
    expect(document.activeElement).toBe(name);
    await pressBack();
    expect(sheetPage()).toBeNull();
    expect(currentTab()).toBe("Characters");
    expect(sheetRow("Elena Vale")).toBeDefined();

    await pressBack();
    expect(inspectorOpen()).toBe(false);
  });

  it("closes at once for a sheet opened from the binder, back to the text", async () => {
    await mount();
    await showBinder();
    await click(container.querySelector(`[data-sheet-row="${ELENA}"] .binder-row`));
    expect(inspectorOpen()).toBe(true);
    expect(sheetPage()).not.toBeNull();

    await pressBack();
    expect(inspectorOpen()).toBe(false);
    expect(binderOpen()).toBe(false);
    expect(exitApp).not.toHaveBeenCalled();
  });
});

describe("Back on the main screen", () => {
  it("saves what is waiting, then closes the app", async () => {
    await mount();
    await leaveAnEditPending();
    await pressBack();
    expect(writeFile).toHaveBeenCalledWith(ROOT, "project.json", expect.stringContaining("Elena arrives."));
    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.invocationCallOrder.at(-1)).toBeLessThan(exitApp.mock.invocationCallOrder[0]);
  });

  it("stays open when the edits can't be saved, says how to leave without them, and closes on the next press", async () => {
    writeFile.mockRejectedValue(new Error("Disk full."));
    await mount();
    await leaveAnEditPending();

    await pressBack();
    expect(exitApp).not.toHaveBeenCalled();
    expect(saveError()).toBe(`Disk full. ${BACK_AGAIN}`);

    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("ignores a press while the first one is saving: one save, and the app stays if it fails", async () => {
    await mount();
    await leaveAnEditPending();
    const saving = deferred<string | null>();
    writeFile.mockReturnValueOnce(saving.promise).mockRejectedValue(new Error("Disk full."));

    await pressBack();
    await pressBack();
    expect(writeFile).toHaveBeenCalledTimes(1);
    await act(async () => saving.reject(new Error("Disk full.")));
    await settle();
    expect(exitApp).not.toHaveBeenCalled();
    expect(saveError()).toContain(BACK_AGAIN);

    // The press after the failure leaves without the edit.
    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("closes the app once for two presses while it saves", async () => {
    await mount();
    await leaveAnEditPending();
    const saving = deferred<string | null>();
    writeFile.mockReturnValueOnce(saving.promise);

    await pressBack();
    await pressBack();
    await act(async () => saving.resolve(null));
    await settle();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("doesn't close the app if something was opened while it saved", async () => {
    await mount();
    await leaveAnEditPending();
    const saving = deferred<string | null>();
    writeFile.mockReturnValueOnce(saving.promise);

    await pressBack();
    await click(barButton("Main menu"));
    await act(async () => saving.resolve(null));
    await settle();
    expect(exitApp).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();

    await pressBack();
    expect(menu()).toBeNull();
    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("closes the app while the project is still opening", async () => {
    openSampleProject.mockReturnValue(new Promise<ProjectSnapshot>(() => undefined));
    await mount();
    expect(container.querySelector('.workspace[aria-busy="true"]')).not.toBeNull();
    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("closes the app when the project couldn't be opened", async () => {
    openSampleProject.mockRejectedValue(new Error("The sample is missing."));
    await mount();
    expect(container.querySelector(".error-screen")).not.toBeNull();
    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  it("gives Back back to the system once the app is gone", async () => {
    await mount();
    expect(onBackButton).toHaveBeenCalledTimes(1);
    expect(back).not.toBeNull();
    await act(async () => root.unmount());
    expect(back).toBeNull();
    root = createRoot(container);
  });
});

describe("on a tablet, with the binder and inspector beside the text", () => {
  it("leaves the panels alone, and cancels a pen's drag in the binder as Escape does", async () => {
    await mount({ device: "tablet" });
    expect(binderOpen()).toBe(true);
    const pen = { bubbles: true, pointerType: "pen", pointerId: 1, button: 0 };
    await act(async () => {
      chapterRow().dispatchEvent(new PointerEvent("pointerdown", { ...pen, clientX: 10, clientY: 10 }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...pen, clientX: 10, clientY: 60 }));
    });
    expect(container.querySelector(".binder.is-dragging")).not.toBeNull();

    await pressBack();
    expect(container.querySelector(".binder.is-dragging")).toBeNull();
    expect(binderOpen()).toBe(true);
    expect(exitApp).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new PointerEvent("pointerup", { ...pen, clientX: 10, clientY: 60 })));
    expect(applyChanges).not.toHaveBeenCalled();

    // The binder is part of the main screen here.
    await pressBack();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});

describe("on desktops, which have no Back button", () => {
  it("handles none, and Escape still closes a menu", async () => {
    await mount({ backend: desktop(), device: "desktop" });
    expect(onBackButton).not.toHaveBeenCalled();
    expect(back).toBeNull();
    await click(barButton("Main menu"));
    expect(menu()).not.toBeNull();
    await key({ key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(barButton("Main menu"));
  });

  it("leaves Escape to close a narrow window's panel, after a menu in it", async () => {
    await mount({ backend: desktop(), device: "narrow desktop" });
    await showBinder();
    await rightClick(chapterRow());
    expect(menu()).not.toBeNull();
    await key({ key: "Escape" });
    expect(menu()).toBeNull();
    expect(binderOpen()).toBe(true);
    await key({ key: "Escape" });
    expect(binderOpen()).toBe(false);
  });
});
