// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Backend } from "../../core/backend";
import { buildNameMatcher, buildProject, type Project } from "../../core/project";
import { DEFAULT_SETTINGS } from "../../core/settings";
import type { SaveState, useProject } from "../../core/useProject";
import { Workspace } from "../Workspace";

const CHAPTER = "manuscript/01 Arrival.md";

const withChapter = buildProject({
  root: "/test",
  folderName: "Test",
  projectJson: null,
  files: [{ path: CHAPTER, text: "# Arrival\n\nElena waits.\n" }],
  skipped: [],
});
const empty = buildProject({ root: "/empty", folderName: "Empty", projectJson: null, files: [], skipped: [] });

const unused = async () => {
  throw new Error("unused");
};

const backend: Backend = {
  kind: "app",
  canOpenFolders: true,
  canCreateProjects: true,
  listProjects: async () => [],
  createProject: unused,
  openSampleProject: unused,
  openProject: unused,
  pickProjectFolder: async () => null,
  applyChanges: unused,
  writeFile: async () => null,
  listVersions: async () => [],
  restoreVersion: unused,
  onCloseRequested: async () => () => undefined,
};

// Stable, as useProject's are.
const listVersions = async () => [];
const restoreVersion = async () => undefined;
const listProjects = async () => [];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A touchscreen phone: editors don't take focus when they mount.
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const noRect = () => new DOMRect();
  Range.prototype.getBoundingClientRect = noRect;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});

function setWindow(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

beforeEach(() => {
  setWindow(412, 915);
  const tokens = document.documentElement.style;
  tokens.setProperty("--size-swipe-edge", "24px");
  tokens.setProperty("--size-swipe-slop", "8px");
  tokens.setProperty("--size-swipe-distance", "32px");
  tokens.setProperty("--duration-swipe-hold", "300ms");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.onScreenKeyboard;
});

async function render(project: Project, { save = { status: "saved" } as SaveState, isPhone = true } = {}) {
  const api = {
    backend,
    load: { status: "ready" },
    project,
    matcher: buildNameMatcher(project.sheets),
    openChapterId: project.chapters[CHAPTER] ? CHAPTER : null,
    openChapter: () => undefined,
    updateChapter: () => undefined,
    save,
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
  await act(async () =>
    root.render(createElement(Workspace, { api, project, backend, settings: DEFAULT_SETTINGS, update: () => undefined, isPhone })),
  );
  // Tiptap reports "create" on the next tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const workspace = () => container.querySelector<HTMLElement>(".workspace")!;
const binderOpen = () => container.querySelector("#binder")!.classList.contains("is-open");

function touch(type: string, el: Element, x: number, y: number) {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: "touch", pointerId: 1, isPrimary: true }));
}

async function resize(width: number, height: number) {
  await act(async () => {
    setWindow(width, height);
    window.dispatchEvent(new Event("resize"));
  });
}

/** What the Android shell runs in the page when the keyboard is shown or hidden (MainActivity.kt). */
async function tell(state: "shown" | "hidden") {
  await act(async () => {
    document.documentElement.dataset.onScreenKeyboard = state;
    window.dispatchEvent(new Event("onscreenkeyboardchange"));
  });
}

async function focusText() {
  await act(async () => container.querySelector<HTMLElement>(".ProseMirror")!.focus());
}

describe("the phone layout", () => {
  it("slides the binder in on a swipe from the left edge of the text", async () => {
    await render(withChapter);
    expect(binderOpen()).toBe(false);
    const text = container.querySelector(".ProseMirror")!;
    await act(async () => {
      touch("pointerdown", text, 4, 400);
      touch("pointermove", text, 30, 401);
      touch("pointermove", text, 90, 402);
      touch("pointerup", text, 90, 402);
    });
    expect(binderOpen()).toBe(true);
  });

  it("takes the caret out of the text when a swipe brings a panel over it, so the keyboard goes", async () => {
    await render(withChapter);
    await focusText();
    const text = container.querySelector(".ProseMirror")!;
    await act(async () => {
      touch("pointerdown", text, 408, 400);
      touch("pointermove", text, 380, 401);
      touch("pointermove", text, 330, 402);
    });
    expect(container.querySelector("#inspector")!.classList.contains("is-open")).toBe(true);
    expect(document.activeElement?.closest(".editor-pane")).toBeNull();
  });

  it("docks the bar and hides the status bar while the shell says the keyboard is up for the chapter", async () => {
    await render(withChapter);
    await focusText();
    expect(workspace().classList.contains("is-keyboard")).toBe(false);
    await tell("shown");
    expect(workspace().classList.contains("is-keyboard")).toBe(true);
    expect(container.querySelector(".status-bar")).toBeNull();
    await tell("hidden");
    expect(workspace().classList.contains("is-keyboard")).toBe(false);
    expect(container.querySelector(".status-bar")).not.toBeNull();
  });

  it("keeps the status bar while the keyboard is up if a save failed", async () => {
    await render(withChapter, { save: { status: "error", message: "Disk full." } });
    await focusText();
    await tell("shown");
    expect(workspace().classList.contains("is-keyboard")).toBe(true);
    expect(container.querySelector(".status-bar")?.textContent).toContain("Couldn’t save");
  });

  it("never docks the bar on desktop", async () => {
    await render(withChapter, { isPhone: false });
    await focusText();
    await tell("shown");
    expect(workspace().classList.contains("is-keyboard")).toBe(false);
  });

  it("never docks the bar where the shell says nothing, however the window shrinks", async () => {
    await render(withChapter);
    await focusText();
    // A keyboard-sized drop, then a split-screen divider dragged up, then a narrower window.
    await resize(412, 560);
    await resize(412, 450);
    await resize(412, 250);
    await resize(360, 400);
    expect(workspace().classList.contains("is-keyboard")).toBe(false);
    expect(container.querySelector(".status-bar")).not.toBeNull();
  });

  it("keeps the bars where they are when a split screen shrinks the window with no keyboard", async () => {
    await render(withChapter);
    await focusText();
    await tell("shown");
    await tell("hidden");
    // The divider dragged up with the caret still in the text.
    await resize(412, 450);
    await resize(412, 250);
    expect(document.activeElement?.closest(".editor-pane")).not.toBeNull();
    expect(workspace().classList.contains("is-keyboard")).toBe(false);
    expect(container.querySelector(".status-bar")).not.toBeNull();
  });

  it("undocks the bar when the caret leaves the text, even with the keyboard still shown", async () => {
    await render(withChapter);
    await focusText();
    await tell("shown");
    expect(workspace().classList.contains("is-keyboard")).toBe(true);
    await act(async () => (document.activeElement as HTMLElement).blur());
    expect(workspace().classList.contains("is-keyboard")).toBe(false);
    expect(container.querySelector(".status-bar")).not.toBeNull();
  });
});

describe("an empty project", () => {
  it("offers New chapter; opening another folder is in the Projects view", async () => {
    await render(empty, { isPhone: false });
    const labels = [...container.querySelectorAll(".editor-empty button")].map((b) => b.textContent);
    expect(labels).toEqual(["New chapter"]);
    expect(container.querySelector(".binder-title-button")?.getAttribute("aria-haspopup")).toBe("dialog");
  });
});
