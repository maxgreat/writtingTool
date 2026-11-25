// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { buildNameMatcher, buildProject } from "../../core/project";
import type { ProjectEntry } from "../../core/projects";
import { DEFAULT_SETTINGS, type ViewSettings } from "../../core/settings";
import type { SaveState, useProject } from "../../core/useProject";
import { HOVER_QUERY } from "../hooks";
import { Workspace } from "../Workspace";

const CHAPTER = "manuscript/01 Arrival.md";

const project = buildProject({
  root: "/data/projects/Test",
  folderName: "Test",
  projectJson: null,
  files: [{ path: CHAPTER, text: "# Arrival\n\nElena waits.\n" }],
  skipped: [],
});

const CURRENT: ProjectEntry = { path: "/data/projects/Test", title: "Test", inAppFolder: true };
const OTHER: ProjectEntry = { path: "/data/projects/Lighthouse", title: "The Lighthouse", inAppFolder: true };

/* The backend and useProject, as the app has them ---------------------------- */

const closeWindow = vi.fn<() => Promise<void>>();
/** The window went away: the page allowed its close. */
const closed = vi.fn();
/** What the workspace set to decide the window's close (its close dialog). */
let closeHandler: (() => Promise<boolean>) | null = null;
/** As the app's window: asks the page, then closes if it may. */
async function askThenClose() {
  if (await closeHandler?.()) closed();
}

/** The desktop app: a folder picker and a window to close, unless left out. */
function app({ folders = true, quit = true } = {}): Backend {
  return {
    kind: "app",
    canOpenFolders: folders,
    canCreateProjects: true,
    listProjects: async () => [],
    listVersions: async () => [],
    onCloseRequested: async () => () => undefined,
    ...(quit && { closeWindow }),
  } as unknown as Backend;
}

/** The browser preview: the sample project only, no folders, no window to close. */
const preview = {
  kind: "browser",
  canOpenFolders: false,
  canCreateProjects: false,
  listProjects: async () => [],
  listVersions: async () => [],
  onCloseRequested: async () => () => undefined,
} as unknown as Backend;

// Stable, as useProject's are.
const listProjects = vi.fn(async () => [CURRENT, OTHER]);
const listVersions = async () => [];
const restoreVersion = async () => undefined;
const openFolder = vi.fn<() => Promise<void>>();
const openProjectAt = vi.fn<(path: string) => Promise<void>>();
const createProject = vi.fn<(title: string, language: string) => Promise<void>>();
const saveNow = vi.fn<() => Promise<void>>();
/** As useProject's: saves, then says whether the window may close. */
const mayClose = vi.fn<() => Promise<boolean>>();
const setCloseHandler = (handler: (() => Promise<boolean>) | null) => {
  closeHandler = handler;
};
/** Autosave held while the close dialog asks: the release is counted. */
const resumeAutosave = vi.fn();
const holdAutosave = vi.fn(() => resumeAutosave);
const discardPending = vi.fn();
/** The project's language, changed from Settings. */
const setLanguage = vi.fn<(code: string) => void>();
/** The view settings, changed from Settings (and the bar). */
const update = vi.fn<(patch: Partial<ViewSettings>) => void>();
/** Whether edits wait to be saved: as the save state says. */
let unsaved = false;

/** Sets the save state useProject reports. */
let setSave: (save: SaveState) => void = () => undefined;

function useMatchMedia({ phone = false, hover = true }) {
  window.matchMedia = ((query: string) => ({
    matches: (phone && query === "(pointer: coarse)") || (hover && query === HOVER_QUERY),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

interface Mount {
  backend?: Backend;
  isPhone?: boolean;
  /** A mouse or touchpad: shortcuts are shown, and focus mode is offered. */
  hover?: boolean;
  save?: SaveState;
  switching?: boolean;
  settings?: Partial<ViewSettings>;
}

async function mount({
  backend = app(),
  isPhone = false,
  hover = !isPhone,
  save: initialSave = { status: "saved" },
  switching = false,
  settings = {},
}: Mount = {}) {
  useMatchMedia({ phone: isPhone, hover });
  function Harness() {
    const [save, setSaveState] = useState<SaveState>(initialSave);
    setSave = (next) => {
      unsaved = next.status === "pending" || next.status === "error";
      setSaveState(next);
    };
    unsaved = save.status === "pending" || save.status === "error";
    const api = {
      backend,
      load: { status: "ready" },
      project,
      matcher: buildNameMatcher(project.sheets),
      openChapterId: CHAPTER,
      openChapter: () => undefined,
      updateChapter: () => undefined,
      save,
      saveNow,
      mayClose,
      setCloseHandler,
      holdAutosave,
      discardPending,
      setLanguage,
      hasUnsaved: () => unsaved,
      openFolder,
      openProjectAt,
      createProject,
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
      project,
      backend,
      settings: { ...DEFAULT_SETTINGS, mode: "plain", ...settings },
      update,
      isPhone,
    });
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-GB"] });
  // jsdom has no layout; the editors measure ranges to scroll the caret into view.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  closeWindow.mockReset().mockImplementation(askThenClose);
  closed.mockClear();
  closeHandler = null;
  resumeAutosave.mockClear();
  holdAutosave.mockClear();
  discardPending.mockClear();
  setLanguage.mockReset();
  update.mockClear();
  listProjects.mockClear();
  openFolder.mockReset().mockResolvedValue(undefined);
  openProjectAt.mockReset().mockResolvedValue(undefined);
  createProject.mockReset().mockResolvedValue(undefined);
  // As useProject's: "Saving…" while the edits are written, then saved.
  saveNow.mockReset().mockImplementation(async () => {
    setSave({ status: "saving" });
    await Promise.resolve();
    setSave({ status: "saved" });
  });
  mayClose.mockReset().mockImplementation(async () => {
    await saveNow();
    return true;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* Finding and doing things ----------------------------------------------------- */

const menuButton = () => container.querySelector<HTMLButtonElement>('.format-bar button[aria-label="Main menu"]')!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Main menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
const labels = () => items().map((i) => i.querySelector(".menu-item-label")?.textContent);
const item = (label: string) => items().find((i) => i.querySelector(".menu-item-label")?.textContent === label);
const hint = (label: string) => item(label)?.querySelector(".menu-hint")?.textContent ?? null;
const projectsView = () => document.querySelector<HTMLElement>('.projects-popover[role="dialog"]');
const openSheet = () => document.querySelector<HTMLElement>(".bottom-sheet.is-open");
const statusBar = () => container.querySelector<HTMLElement>(".status-bar");
const saveCheck = () => statusBar()?.querySelector(".status-group--end svg.lucide-check") ?? null;
/** What the workspace last said to screen readers about saving. */
const said = () => [...container.querySelectorAll('.workspace > p.visually-hidden[role="status"]')].at(-1)?.textContent;
const alerted = () => container.querySelector('.workspace > p.visually-hidden[role="alert"]')?.textContent;
const caretInText = () => document.activeElement?.closest(".editor-pane") != null;
const isFocusMode = () => container.querySelector(".workspace")!.classList.contains("is-focus");
const settingsDialog = () => document.querySelector<HTMLElement>('.settings-dialog[role="dialog"]');
/** A switch in the Settings dialog, by its label. */
const settingsSwitch = (label: string) =>
  [...(settingsDialog()?.querySelectorAll<HTMLElement>('[role="switch"]') ?? [])].find(
    (s) => document.getElementById(s.getAttribute("aria-labelledby") ?? "")?.textContent === label,
  );

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("Nothing to click");
  await act(async () => el.click());
}

async function openMenu() {
  await click(menuButton());
  expect(menu()).not.toBeNull();
}

async function choose(label: string) {
  await openMenu();
  await click(item(label));
}

/** A key pressed where focus is (Ctrl on Linux and Windows). Resolves to the event, to see whether it was handled. */
async function key(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const ctrl = (letter: string) => key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true });
const ctrlComma = (init: KeyboardEventInit = {}) => key({ key: ",", code: "Comma", ctrlKey: true, ...init });

/** Lets a frame go by, for what waits until React has shown a change. */
const afterFrame = () =>
  act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

async function focusText() {
  await act(async () => container.querySelector<HTMLElement>(".cm-content")!.focus());
}

/* Tests ------------------------------------------------------------------------ */

describe("the main menu button", () => {
  it("is the first thing in the bar, named, with a tooltip, and opens a menu", async () => {
    await mount();
    const first = container.querySelector(".format-bar button");
    expect(first).toBe(menuButton());
    expect(menuButton().title).toBe("Main menu");
    expect(menuButton().getAttribute("aria-haspopup")).toBe("menu");
    expect(menuButton().querySelector(".chevron")).toBeNull();
    await openMenu();
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("is there with the binder hidden, and in focus mode, where the panel buttons aren't", async () => {
    await mount({ settings: { binderOpen: false } });
    expect(menuButton()).not.toBeNull();
    await key({ key: "F11" }, window);
    expect(isFocusMode()).toBe(true);
    expect(container.querySelector('.format-bar button[aria-controls="binder"]')).toBeNull();
    await choose("Open project…");
    expect(projectsView()).not.toBeNull();
  });

  it("groups the app's commands, each with its shortcut", async () => {
    await mount();
    await openMenu();
    expect(labels()).toEqual([
      "New project…",
      "Open project…",
      "Open folder…",
      "Save",
      "Export…",
      "Settings…",
      "Focus mode",
      "Quit",
    ]);
    expect(hint("Open project…")).toBe("Ctrl+O");
    expect(hint("Save")).toBe("Ctrl+S");
    expect(hint("Settings…")).toBe("Ctrl+,");
    expect(hint("Focus mode")).toBe("F11");
    expect(hint("Quit")).toBe("Ctrl+Q");
    expect(hint("New project…")).toBeNull();
    // Groups are set apart by space.
    expect(menu()!.querySelectorAll(".popover-gap")).toHaveLength(4);
  });

  it("closes once a command is chosen", async () => {
    await mount();
    await choose("Save");
    expect(menu()).toBeNull();
  });
});

describe("New project…", () => {
  it("opens the Projects view under the menu, with the new project's title field ready", async () => {
    await mount();
    await choose("New project…");
    expect(projectsView()?.getAttribute("aria-label")).toBe("Projects");
    const field = projectsView()!.querySelector("form input");
    expect(document.activeElement).toBe(field);
    expect(menuButton().getAttribute("aria-controls")).toBeNull();
    await key({ key: "Escape" });
    expect(projectsView()).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it("makes the project from there", async () => {
    await mount();
    await choose("New project…");
    const field = document.activeElement as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Night Ferry");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field.form!.requestSubmit());
    expect(createProject).toHaveBeenCalledWith("Night Ferry", "en-GB");
  });

  it("waits for the app in the browser preview, and says so", async () => {
    await mount({ backend: preview });
    await openMenu();
    expect(item("New project…")?.disabled).toBe(true);
    expect(hint("New project…")).toBe("Needs the app");
  });

  it("opens the sheet on phones, with the title field ready", async () => {
    await mount({ isPhone: true });
    await choose("New project…");
    expect(openSheet()).not.toBeNull();
    expect(document.activeElement).toBe(openSheet()!.querySelector("form input"));
  });
});

describe("Open project…", () => {
  it("opens the Projects view at its list", async () => {
    await mount();
    await choose("Open project…");
    expect(projectsView()).not.toBeNull();
    const first = projectsView()!.querySelector<HTMLElement>(".projects-list button.project-row");
    expect(first?.textContent).toContain(OTHER.title);
    expect(document.activeElement).toBe(first);
    await click(first!);
    expect(openProjectAt).toHaveBeenCalledWith(OTHER.path);
  });

  it("opens the sheet on phones, at its list", async () => {
    await mount({ isPhone: true });
    await choose("Open project…");
    expect(openSheet()?.querySelector(".projects-list")).not.toBeNull();
    // One view, whichever opened it.
    expect(document.querySelectorAll(".bottom-sheet .projects")).toHaveLength(1);
  });
});

describe("Open folder…", () => {
  it("shows the folder picker and opens the folder chosen, as in the Projects view", async () => {
    await mount();
    await choose("Open folder…");
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(projectsView()).toBeNull();
    expect(caretInText()).toBe(true);
  });

  it("says why a folder couldn't be opened, under the menu, until the next key", async () => {
    openFolder.mockRejectedValue(new Error("Cannot open /tmp: not a project folder"));
    await mount();
    await choose("Open folder…");
    const note = document.querySelector(".text-note");
    expect(note?.textContent).toContain("Couldn’t open the folder");
    expect(note?.textContent).toContain("Cannot open /tmp: not a project folder");
    expect(alerted()).toBe("Couldn’t open the folder. Cannot open /tmp: not a project folder");
    await key({ key: "a" });
    expect(document.querySelector(".text-note")).toBeNull();
  });

  it("waits while a folder is being opened, or the project on disk is changing", async () => {
    let finish: () => void = () => undefined;
    openFolder.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await choose("Open folder…");
    await openMenu();
    expect(item("Open folder…")?.disabled).toBe(true);
    await act(async () => finish());
    expect(item("Open folder…")?.disabled).toBe(false);

    act(() => root.unmount());
    root = createRoot(container);
    await mount({ switching: true });
    await openMenu();
    expect(item("Open folder…")?.disabled).toBe(true);
  });

  it("is only there with a folder picker", async () => {
    await mount({ backend: app({ folders: false }) });
    await openMenu();
    expect(item("Open folder…")).toBeUndefined();
  });
});

describe("Save", () => {
  it("writes pending edits now, then shows a check in the status bar until the next key", async () => {
    await mount({ save: { status: "pending" } });
    await choose("Save");
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(saveCheck()).not.toBeNull();
    expect(statusBar()?.textContent).toContain("Saved on this device");
    expect(said()).toBe("Saved on this device.");
    expect(caretInText()).toBe(true);
    await key({ key: "ArrowDown" });
    expect(saveCheck()).toBeNull();
    expect(statusBar()?.textContent).toContain("Saved on this device");
    expect(said()).toBe("");
  });

  it("shows why it failed, with Retry", async () => {
    saveNow.mockImplementation(async () => setSave({ status: "error", message: "Disk full." }));
    await mount({ save: { status: "pending" } });
    await choose("Save");
    expect(saveCheck()).toBeNull();
    expect(statusBar()?.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t save: Disk full.");
    expect(said()).toBe("");
  });

  it("says where the browser preview keeps the edits", async () => {
    await mount({ backend: preview });
    await choose("Save");
    expect(saveCheck()).not.toBeNull();
    expect(statusBar()?.textContent).toContain("Browser preview · saved in this tab");
    expect(said()).toBe("Saved in this tab.");
  });

  it("drops the check when the text changes again", async () => {
    await mount();
    await choose("Save");
    expect(saveCheck()).not.toBeNull();
    await act(async () => setSave({ status: "pending" }));
    expect(saveCheck()).toBeNull();
    expect(statusBar()?.textContent).toContain("Unsaved");
  });

  it("waits while a save is being written", async () => {
    await mount({ save: { status: "saving" } });
    await openMenu();
    expect(item("Save")?.disabled).toBe(true);
  });
});

describe("Export…", () => {
  it("is there, but not yet: disabled, and says so", async () => {
    await mount();
    await openMenu();
    expect(item("Export…")?.disabled).toBe(true);
    expect(hint("Export…")).toBe("Coming soon");
  });
});

describe("Settings…", () => {
  it("opens the Settings dialog, and Done puts the caret back in the text", async () => {
    await mount();
    await choose("Settings…");
    const dialog = settingsDialog();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog!.getAttribute("aria-labelledby")!)?.textContent).toBe("Settings");
    expect(dialog!.contains(document.activeElement)).toBe(true);
    const done = [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Done");
    await click(done);
    expect(settingsDialog()).toBeNull();
    await afterFrame();
    expect(caretInText()).toBe(true);
  });

  it("shows the settings and the project's language, and changes them where they live", async () => {
    await mount();
    await choose("Settings…");
    const typewriter = settingsSwitch("Typewriter scrolling");
    expect(typewriter?.getAttribute("aria-checked")).toBe("false");
    await click(typewriter);
    expect(update).toHaveBeenCalledWith({ typewriter: true });

    const language = settingsDialog()!.querySelector<HTMLSelectElement>("select")!;
    expect(language.value).toBe(project.language);
    await act(async () => {
      language.value = "fr-FR";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setLanguage).toHaveBeenCalledWith("fr-FR");
  });

  it("opens a sheet on phones, its close button ready", async () => {
    await mount({ isPhone: true, backend: app({ folders: false, quit: false }) });
    await choose("Settings…");
    expect(openSheet()?.classList.contains("settings-sheet")).toBe(true);
    expect(document.activeElement).toBe(openSheet()!.querySelector('button[aria-label="Close"]'));
    expect(settingsDialog()).toBeNull();
  });
});

describe("Focus mode", () => {
  it("enters focus mode with the caret in the text, and leaves it from the same place", async () => {
    await mount();
    await choose("Focus mode");
    expect(isFocusMode()).toBe(true);
    expect(caretInText()).toBe(true);
    await choose("Leave focus mode");
    expect(isFocusMode()).toBe(false);
    expect(caretInText()).toBe(true);
  });

  it("isn't offered on touch screens, which can't bring the bar back, nor are shortcuts shown", async () => {
    // The phone app: no folder picker, no window to close.
    await mount({ isPhone: true, backend: app({ folders: false, quit: false }) });
    await openMenu();
    expect(labels()).toEqual(["New project…", "Open project…", "Save", "Export…", "Settings…"]);
    expect(items().map((i) => i.querySelector(".menu-hint")?.textContent ?? null)).toEqual([
      null,
      null,
      null,
      "Coming soon",
      null,
    ]);
  });

  it("keeps the bar in view while the Projects view hangs from the menu", async () => {
    await mount();
    await key({ key: "F11" }, window);
    await choose("Open project…");
    expect(container.querySelector(".bar-slot")!.classList.contains("is-revealed")).toBe(true);
  });

  it("shows the status bar for a failed save, or for the check after Save, until the next key", async () => {
    await mount();
    await key({ key: "F11" }, window);
    expect(statusBar()).toBeNull();
    await focusText();
    await ctrl("s");
    expect(saveCheck()).not.toBeNull();
    await key({ key: "a" });
    expect(statusBar()).toBeNull();

    saveNow.mockImplementation(async () => setSave({ status: "error", message: "Disk full." }));
    await ctrl("s");
    expect(statusBar()?.textContent).toContain("Couldn’t save");
  });
});

describe("Quit", () => {
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const dialogButton = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.trim() === label);
  const press = (label: string) =>
    act(async () => {
      dialogButton(label)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("asks first, saying everything is saved, and closes the window on Close", async () => {
    await mount();
    await choose("Quit");
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(dialog()?.textContent).toContain("All your changes are saved.");
    expect(holdAutosave).toHaveBeenCalledTimes(1);
    expect(closed).not.toHaveBeenCalled();
    await press("Close");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(resumeAutosave).not.toHaveBeenCalled();
  });

  it("offers to save edits that wait, and closes once they are written", async () => {
    await mount({ save: { status: "pending" } });
    saveNow.mockImplementation(async () => setSave({ status: "saved" }));
    await choose("Quit");
    expect(dialog()?.textContent).toContain("Save changes before closing?");
    await press("Save and close");
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stays open, saying why, when the edits can't be saved; Close without saving drops them", async () => {
    await mount({ save: { status: "pending" } });
    saveNow.mockImplementation(async () => setSave({ status: "error", message: "Disk full." }));
    await choose("Quit");
    await press("Save and close");
    expect(closed).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Disk full.");
    await press("Close without saving");
    expect(discardPending).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stays open on Cancel, autosave going on, and can be chosen again", async () => {
    await mount({ save: { status: "pending" } });
    await choose("Quit");
    await press("Cancel");
    expect(dialog()).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(resumeAutosave).toHaveBeenCalledTimes(1);
    await openMenu();
    expect(item("Quit")?.disabled).toBe(false);
  });

  it("asks once: Ctrl+Q waits, and the window's close button is refused while the dialog is open", async () => {
    await mount();
    await choose("Quit");
    await ctrl("q");
    expect(closeWindow).toHaveBeenCalledTimes(1);
    // The window's own close button, pressed again.
    await act(async () => {
      await closeWindow();
    });
    expect(closed).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await press("Cancel");
    expect(closed).not.toHaveBeenCalled();
    await openMenu();
    expect(item("Quit")?.disabled).toBe(false);
  });

  it("leaves the shortcuts alone while it asks", async () => {
    await mount();
    await choose("Quit");
    await key({ key: "F11" }, window);
    expect(isFocusMode()).toBe(false);
    await ctrl("s");
    expect(saveNow).not.toHaveBeenCalled();
    await press("Cancel");
  });

  it("says why the window couldn't be closed", async () => {
    closeWindow.mockRejectedValue(new Error("window.close not allowed"));
    await mount();
    await choose("Quit");
    expect(document.querySelector(".text-note")?.textContent).toContain("Couldn’t quit");
    expect(alerted()).toBe("Couldn’t quit. window.close not allowed");
  });

  it("is only there with a window to close", async () => {
    await mount({ backend: app({ quit: false }) });
    await openMenu();
    expect(item("Quit")).toBeUndefined();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount({ backend: preview });
    await openMenu();
    expect(item("Quit")).toBeUndefined();
    expect(item("Open folder…")).toBeUndefined();
  });
});

describe("the shortcuts", () => {
  it("Ctrl+S saves from the text, never the browser's Save page", async () => {
    await mount({ save: { status: "pending" } });
    await focusText();
    const event = await ctrl("s");
    expect(event.defaultPrevented).toBe(true);
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(saveCheck()).not.toBeNull();
    // Caps Lock on.
    await key({ key: "S", code: "KeyS", ctrlKey: true });
    expect(saveNow).toHaveBeenCalledTimes(2);
  });

  it("Ctrl+O opens the Projects view at its list, and Escape puts the caret back in the text", async () => {
    await mount();
    await focusText();
    const event = await ctrl("o");
    expect(event.defaultPrevented).toBe(true);
    expect(projectsView()).not.toBeNull();
    expect(projectsView()!.contains(document.activeElement)).toBe(true);
    await key({ key: "Escape" });
    expect(projectsView()).toBeNull();
    expect(caretInText()).toBe(true);
  });

  it("Ctrl+O in focus mode brings the bar the view hangs from, and lets it go after", async () => {
    await mount();
    await key({ key: "F11" }, window);
    await ctrl("o");
    expect(container.querySelector(".bar-slot")!.classList.contains("is-revealed")).toBe(true);
    await key({ key: "Escape" });
    expect(isFocusMode()).toBe(true);
    expect(container.querySelector(".bar-slot")!.classList.contains("is-revealed")).toBe(false);
  });

  it("Ctrl+Q quits where there is a window to close, and is left alone elsewhere", async () => {
    await mount();
    const event = await ctrl("q");
    expect(event.defaultPrevented).toBe(true);
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    closeWindow.mockClear();
    await mount({ backend: preview });
    const ignored = await ctrl("q");
    expect(ignored.defaultPrevented).toBe(false);
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("Ctrl+, opens Settings from the text, and Escape puts the caret back", async () => {
    await mount();
    await focusText();
    const event = await ctrlComma();
    expect(event.defaultPrevented).toBe(true);
    expect(settingsDialog()).not.toBeNull();
    expect(settingsDialog()!.contains(document.activeElement)).toBe(true);
    await key({ key: "Escape" });
    expect(settingsDialog()).toBeNull();
    expect(caretInText()).toBe(true);
  });

  it("leave Settings its keys: nothing else happens behind it", async () => {
    await mount({ save: { status: "pending" } });
    await focusText();
    await ctrlComma();
    await key({ key: "F11" });
    expect(isFocusMode()).toBe(false);
    await ctrl("s");
    expect(saveNow).not.toHaveBeenCalled();
    await ctrl("o");
    expect(projectsView()).toBeNull();
    await key({ key: "B", code: "KeyB", ctrlKey: true, altKey: true });
    expect(update).not.toHaveBeenCalled();
    expect(settingsDialog()).not.toBeNull();
    await key({ key: "Escape" });
    expect(settingsDialog()).toBeNull();
    // Back to work: the shortcuts are there again.
    await ctrl("s");
    expect(saveNow).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl+Shift+, and Ctrl+Alt+, alone", async () => {
    await mount();
    expect((await ctrlComma({ shiftKey: true })).defaultPrevented).toBe(false);
    expect((await ctrlComma({ altKey: true })).defaultPrevented).toBe(false);
    expect(settingsDialog()).toBeNull();
  });

  it("leaves Ctrl+N and Ctrl+Shift+S to the system", async () => {
    await mount();
    expect((await ctrl("n")).defaultPrevented).toBe(false);
    const shifted = await key({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(saveNow).not.toHaveBeenCalled();
  });
});
