// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_PRESETS, PAPERBACK, type BookLayout, type ExportSettings } from "../../core/exportSettings";
import {
  ExportDialog,
  LAYOUT_DELAY_MS,
  stepView,
  viewLabel,
  viewPages,
  type ExportChoice,
  type ExportDialogProps,
  type ExportSource,
} from "../ExportDialog";

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

const OUTLINE: ExportSource["outline"] = [
  { part: null, chapters: [{ id: "prologue", title: "Prologue" }] },
  {
    part: "Part One",
    chapters: [
      { id: "arrival", title: "The Arrival" },
      { id: "harbour", title: "The Harbour" },
    ],
  },
  { part: "Part Two", chapters: [{ id: "storm", title: "The Storm" }] },
];
const ALL = ["prologue", "arrival", "harbour", "storm"];
const OWN: ExportSettings = { ...PAPERBACK, fontSize: 10 };
const PRESETS: ExportSource["presets"] = [
  ...BUILT_IN_PRESETS.map((p) => ({ ...p, builtIn: true })),
  { name: "Proof copy", settings: OWN, builtIn: false },
];
const SAVED_TO = "/home/ada/Books/The Ferryman’s Debt.pdf";
const SVG_PREFIX = "data:image/svg+xml;charset=utf-8,";

/** Nine pages: title, contents, then chapters on pages 3, 5, 7 and 9. */
const layoutOf = (generation: number, pages = 9): BookLayout => ({
  generation,
  pages,
  width: 419.53,
  height: 595.28,
  chapterPages: [2, 4, 6, 8],
});

let asked: { choice: ExportChoice; answer: ReturnType<typeof deferred<BookLayout>> }[];
const layOut = vi.fn((choice: ExportChoice) => {
  const answer = deferred<BookLayout>();
  asked.push({ choice, answer });
  return answer.promise;
});
const page = vi.fn(
  async (generation: number, index: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${generation}:${index}</text></svg>`,
);
/**
 * A core that behaves as the app's (lay_out_book and book_page in src-tauri/src/lib.rs):
 * each layout asked for gets the next generation, the newest one made is the only one
 * kept, and a page of any other is refused. Layout `n` (from 0) is made with `make(n)`.
 */
function coreLike() {
  let next = 0;
  let kept = 0;
  const made: { choice: ExportChoice; generation: number; answer: ReturnType<typeof deferred<BookLayout>> }[] = [];
  /** Pages that can't be drawn from any layout, and why. */
  const broken = new Map<number, string>();
  const layOut = vi.fn((choice: ExportChoice) => {
    const answer = deferred<BookLayout>();
    made.push({ choice, generation: ++next, answer });
    return answer.promise;
  });
  const page = vi.fn(async (generation: number, index: number) => {
    if (generation !== kept) throw new Error("That layout has been replaced.");
    const reason = broken.get(index);
    if (reason !== undefined) throw new Error(reason);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${generation}:${index}</text></svg>`;
  });
  return {
    layOut,
    page,
    made,
    /** How many times page `index` of layout `generation` was asked for. */
    asks: (generation: number, index: number) =>
      page.mock.calls.filter(([g, i]) => g === generation && i === index).length,
    /** Page `index` fails from now on, whatever the layout. */
    refuse(index: number, reason: string) {
      broken.set(index, reason);
    },
    async make(n: number) {
      const { generation, answer } = made[n];
      kept = Math.max(kept, generation);
      await act(async () => answer.resolve(layoutOf(generation)));
      await settle();
    },
    /** Layout `n` fails: the core keeps the layout it had. */
    async fail(n: number, reason: string) {
      await act(async () => made[n].answer.reject(new Error(reason)));
      await settle();
    },
  };
}
const exportFile = vi.fn<(choice: ExportChoice) => Promise<string | null>>();
const savePreset = vi.fn<(name: string, settings: ExportSettings) => void>();
const remember = vi.fn<(choice: ExportChoice, presetName: string | null) => void>();
const onClose = vi.fn<() => void>();

function sourceWith(patch: Partial<ExportSource> = {}): ExportSource {
  return {
    outline: OUTLINE,
    title: "The Ferryman’s Debt",
    author: "Ada Quill",
    presets: PRESETS,
    initial: { presetName: "Paperback A5", settings: PAPERBACK, format: "pdf" },
    layOut,
    page,
    export: exportFile,
    savePreset,
    remember,
    ...patch,
  };
}

let container: HTMLDivElement;
let root: Root;
let props: ExportDialogProps;
/** What had focus before the window opened: the main menu's button, say. */
let opener: HTMLButtonElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  asked = [];
  for (const fn of [layOut, page, exportFile, savePreset, remember, onClose]) fn.mockClear();
  exportFile.mockReset();
  props = { open: true, source: sourceWith(), onClose, isPhone: false };
  container = document.createElement("div");
  opener = document.createElement("button");
  opener.textContent = "Main menu";
  document.body.append(opener, container);
  opener.focus();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  opener.remove();
  vi.useRealTimers();
});

/** Lets promises settle and React render what they set. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      for (let j = 0; j < 10; j++) await Promise.resolve();
    });
  }
}

async function render(patch: Partial<ExportDialogProps> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(ExportDialog, props)));
  await settle();
}

/** Answers layout request `n` (from 0). */
async function answer(n: number, layout: BookLayout) {
  await act(async () => asked[n].answer.resolve(layout));
  await settle();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
const text = () => dialog()?.textContent ?? "";
const status = () => dialog()!.querySelector('[role="status"].export-status')!.textContent;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) => {
  const found = buttons().find((b) => b.textContent === name || b.getAttribute("aria-label") === name);
  if (!found) throw new Error(`No button “${name}”`);
  return found;
};
/** What the popover open over the window says (Save as preset's form). */
const popoverText = () => document.querySelector(".popover")?.textContent ?? "";
const exportButton = () => dialog()!.querySelector<HTMLButtonElement>(".btn--primary.export-button")!;
const tab = (name: string) => [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
const presetButton = () => dialog()!.querySelector<HTMLButtonElement>(".export-preset")!;
const menuItem = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.popover [role^="menuitem"]')].find((i) =>
    i.querySelector(".menu-item-label")?.textContent === name,
  );
const position = () => dialog()!.querySelector(".export-position")?.textContent;

/**
 * A field by its label's text: inputs and selects labelled with `for`, checkboxes wrapped by
 * theirs. In the window or in a popover opened from it (Save as preset).
 */
function field<T extends HTMLElement = HTMLInputElement>(label: string): T {
  const found = [...document.querySelectorAll("label")].find((l) => l.textContent === label);
  if (!found) throw new Error(`No field “${label}”`);
  return (found.htmlFor ? document.getElementById(found.htmlFor) : found.querySelector("input")) as unknown as T;
}

/** The pages shown: what each <img> holds ("generation:index"), decoded from its data: URL. */
function shownPages(): string[] {
  return [...dialog()!.querySelectorAll<HTMLImageElement>(".export-page img")].map((img) => {
    const src = img.getAttribute("src")!;
    expect(src.startsWith(SVG_PREFIX)).toBe(true);
    return /<text>(.*)<\/text>/u.exec(decodeURIComponent(src.slice(SVG_PREFIX.length)))![1];
  });
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Opens the window and shows the first layout's pages. */
async function opened(patch: Partial<ExportDialogProps> = {}) {
  await render(patch);
  await answer(0, layoutOf(1));
}

/* Helpers ------------------------------------------------------------------------- */

describe("the pages each view shows", () => {
  it("one at a time, or as a book's spreads: page 1 alone on the right, then 2–3, 4–5", () => {
    expect(viewPages(false, 4, 9)).toEqual([4]);
    expect(viewPages(true, 0, 9)).toEqual([null, 0]);
    expect(viewPages(true, 1, 9)).toEqual([1, 2]);
    expect(viewPages(true, 2, 9)).toEqual([1, 2]);
    expect(viewPages(true, 8, 9)).toEqual([7, 8]);
    // An even count leaves the last page alone on the left.
    expect(viewPages(true, 7, 8)).toEqual([7, null]);
    expect(viewPages(true, 0, 0)).toEqual([]);
  });

  it("steps a view at a time, and stays at either end", () => {
    expect(stepView(true, 0, 9, 1)).toBe(1);
    expect(stepView(true, 2, 9, 1)).toBe(3);
    expect(stepView(true, 1, 9, -1)).toBe(0);
    expect(stepView(true, 0, 9, -1)).toBe(0);
    expect(stepView(true, 8, 9, 1)).toBe(7);
    expect(stepView(false, 3, 9, 1)).toBe(4);
    expect(stepView(false, 8, 9, 1)).toBe(8);
  });

  it("names them with an en dash", () => {
    expect(viewLabel([null, 0], 212)).toBe("1 of 212");
    expect(viewLabel([1, 2], 212)).toBe("2–3 of 212");
  });
});

/* The window ---------------------------------------------------------------------- */

describe("opening", () => {
  it("is a modal dialog named Export, in a portal, with focus inside", async () => {
    await render();
    const el = dialog()!;
    expect(container.contains(el)).toBe(false);
    expect(document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent).toBe("Export");
    expect(el.contains(document.activeElement)).toBe(true);
  });

  it("shows nothing while closed", async () => {
    await render({ open: false });
    expect(dialog()).toBeNull();
    expect(layOut).not.toHaveBeenCalled();
  });

  it("starts from the project's settings and lays them out at once", async () => {
    await render();
    expect(tab("PDF").getAttribute("aria-selected")).toBe("true");
    expect(field<HTMLSelectElement>("Size").value).toBe("a5");
    expect(field("Text size").value).toBe("11");
    expect(field("Author").value).toBe("Ada Quill");
    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Paperback A5");
    expect(layOut).toHaveBeenCalledTimes(1);
    expect(asked[0].choice).toEqual({ format: "pdf", settings: PAPERBACK, chapterIds: ALL, author: "Ada Quill" });
  });

  it("shows placeholder pages while the first layout is made", async () => {
    await render();
    expect(dialog()!.querySelectorAll(".export-page.is-loading")).toHaveLength(1);
    expect(dialog()!.querySelector(".export-page img")).toBeNull();
    expect(status()).toBe("Laying out the pages…");
  });

  it("shows the first layout's pages as data: images, and asks for the next view's ahead", async () => {
    await opened();
    expect(shownPages()).toEqual(["1:0"]);
    expect(dialog()!.querySelector(".export-page img")!.getAttribute("alt")).toBe("Page 1");
    expect(page.mock.calls.map(([g, i]) => `${g}:${i}`).sort()).toEqual(["1:0", "1:1", "1:2"]);
    expect(status()).toBe("The preview redraws after each change.");
    // Never as markup in the page.
    expect(dialog()!.querySelector(".export-page svg")).toBeNull();
  });
});

describe("laying out again", () => {
  it("waits for the settings to rest, keeps the pages meanwhile, and drops an answer that comes too late", async () => {
    vi.useFakeTimers();
    await opened();

    await type(field("Text size"), "12");
    expect(layOut).toHaveBeenCalledTimes(1);
    expect(status()).toBe("Laying out the pages…");
    expect(shownPages()).toEqual(["1:0"]);
    await advance(LAYOUT_DELAY_MS - 1);
    expect(layOut).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(layOut).toHaveBeenCalledTimes(2);
    expect(asked[1].choice.settings.fontSize).toBe(12);

    // Another change while that one is out: its answer is too late once it comes.
    await type(field("Text size"), "13");
    await advance(LAYOUT_DELAY_MS);
    expect(layOut).toHaveBeenCalledTimes(3);
    expect(asked[2].choice.settings.fontSize).toBe(13);
    await answer(2, layoutOf(3));
    expect(shownPages()).toEqual(["3:0"]);
    await answer(1, layoutOf(2));
    expect(shownPages()).toEqual(["3:0"]);
    expect(page.mock.calls.some(([g]) => g === 2)).toBe(false);
    expect(status()).toBe("The preview redraws after each change.");
  });

  it("asks once for changes made in quick succession", async () => {
    vi.useFakeTimers();
    await opened();
    await type(field("Text size"), "12");
    await advance(LAYOUT_DELAY_MS / 2);
    await choose(field<HTMLSelectElement>("Size"), "a4");
    await advance(LAYOUT_DELAY_MS / 2);
    expect(layOut).toHaveBeenCalledTimes(1);
    await advance(LAYOUT_DELAY_MS);
    expect(layOut).toHaveBeenCalledTimes(2);
    expect(asked[1].choice.settings).toMatchObject({ fontSize: 12, pageSize: "a4" });
  });

  it("shows why a layout failed, keeps the last good pages, and tries again", async () => {
    vi.useFakeTimers();
    await opened();
    await type(field("Text size"), "12");
    await advance(LAYOUT_DELAY_MS);
    await act(async () => asked[1].answer.reject(new Error("The font is missing.")));
    await settle();
    expect(status()).toBe("Couldn’t lay out the pages: The font is missing.");
    expect(dialog()!.querySelector(".export-preview-error")?.textContent).toContain("The font is missing.");
    expect(shownPages()).toEqual(["1:0"]);

    await click(button("Try again"));
    expect(layOut).toHaveBeenCalledTimes(3);
    await answer(2, layoutOf(4));
    expect(shownPages()).toEqual(["4:0"]);
    expect(dialog()!.querySelector(".export-preview-error")).toBeNull();
  });

  it("says why when the first layout fails", async () => {
    await render();
    await act(async () => asked[0].answer.reject(new Error("Typst stopped.")));
    await settle();
    expect(dialog()!.querySelector(".export-preview-note")?.textContent).toContain("Typst stopped.");
    expect(dialog()!.querySelector(".export-page")).toBeNull();
  });

  it("lays the settings out again when they come back while another layout is out", async () => {
    vi.useFakeTimers();
    const core = coreLike();
    await render({ source: sourceWith({ layOut: core.layOut, page: core.page }) });
    await core.make(0);
    expect(shownPages()).toEqual(["1:0"]);

    // A change is sent once the settings rest, then undone before the core answers it.
    await type(field("Text size"), "12");
    await advance(LAYOUT_DELAY_MS);
    expect(core.layOut).toHaveBeenCalledTimes(2);
    await type(field("Text size"), "11");
    // Its layout, made all the same, replaces the one shown in the core.
    await core.make(1);
    expect(shownPages()).toEqual(["1:0"]);
    expect(status()).toBe("Laying out the pages…");
    await advance(LAYOUT_DELAY_MS);
    expect(core.layOut).toHaveBeenCalledTimes(3);
    expect(core.made[2].choice.settings).toEqual(PAPERBACK);
    await core.make(2);
    expect(shownPages()).toEqual(["3:0"]);
    expect(status()).toBe("The preview redraws after each change.");

    // Pages not asked for yet come from the layout the core holds.
    await click(button("Next page"));
    await click(button("Next page"));
    expect(shownPages()).toEqual(["3:3", "3:4"]);
    expect(dialog()!.querySelector(".export-page.is-error")).toBeNull();
    expect(core.page.mock.calls.every(([g]) => g === 1 || g === 3)).toBe(true);
  });

  it("shows the layout the core holds when the last one fails after an earlier one replaced it", async () => {
    vi.useFakeTimers();
    const core = coreLike();
    await render({ source: sourceWith({ layOut: core.layOut, page: core.page }) });
    await core.make(0);
    await type(field("Text size"), "12");
    await advance(LAYOUT_DELAY_MS);
    await type(field("Text size"), "13");
    await advance(LAYOUT_DELAY_MS);
    expect(core.layOut).toHaveBeenCalledTimes(3);
    // The first change's layout is made, too late to show; the second's fails.
    await core.make(1);
    expect(shownPages()).toEqual(["1:0"]);
    await core.fail(2, "The font is missing.");
    expect(status()).toBe("Couldn’t lay out the pages: The font is missing.");
    expect(shownPages()).toEqual(["2:0"]);

    await click(button("Next page"));
    await click(button("Next page"));
    expect(shownPages()).toEqual(["2:3", "2:4"]);
    expect(dialog()!.querySelector(".export-page.is-error")).toBeNull();
  });

  it("keeps pages the core refuses loading while a layout is out, and draws them from the new one", async () => {
    vi.useFakeTimers();
    const core = coreLike();
    await render({ source: sourceWith({ layOut: core.layOut, page: core.page }) });
    await core.make(0);
    await type(field("Text size"), "12");
    await advance(LAYOUT_DELAY_MS);
    await type(field("Text size"), "13");
    await advance(LAYOUT_DELAY_MS);
    expect(core.layOut).toHaveBeenCalledTimes(3);
    // The first change's layout is made, too late to show: the core no longer holds the one shown.
    await core.make(1);
    expect(shownPages()).toEqual(["1:0"]);

    // Pages of it not drawn yet are refused: they stay loading, without an error.
    await click(button("Next page"));
    await click(button("Next page"));
    expect(position()).toBe("4–5 of 9");
    expect(core.asks(1, 3)).toBe(1);
    expect(dialog()!.querySelectorAll(".export-page.is-loading")).toHaveLength(2);
    expect(dialog()!.querySelector(".export-page.is-error")).toBeNull();
    expect(status()).toBe("Laying out the pages…");
    // Nor are they asked for again from that layout when they come back into view.
    await click(button("Previous page"));
    await click(button("Next page"));
    expect(core.asks(1, 3)).toBe(1);

    await core.make(2);
    expect(shownPages()).toEqual(["3:3", "3:4"]);
    expect(dialog()!.querySelector(".export-page.is-error")).toBeNull();
    expect(status()).toBe("The preview redraws after each change.");
  });

  it("shows why a page can't be drawn once nothing is waiting, if it still fails", async () => {
    vi.useFakeTimers();
    const core = coreLike();
    await render({ source: sourceWith({ layOut: core.layOut, page: core.page }) });
    await core.make(0);
    core.refuse(3, "Out of memory.");
    await type(field("Text size"), "12");
    await advance(LAYOUT_DELAY_MS);
    await click(button("Next page"));
    await click(button("Next page"));
    // While the layout is out, page 4 waits; page 5 comes from the layout the core still holds.
    expect(shownPages()).toEqual(["1:4"]);
    expect(dialog()!.querySelector(".export-page.is-error")).toBeNull();

    // The layout fails: page 4 is asked for again from the layout shown, and fails again.
    await core.fail(1, "The font is missing.");
    expect(core.asks(1, 3)).toBe(2);
    expect(dialog()!.querySelector(".export-page.is-error")?.textContent).toContain("Out of memory.");
    expect(shownPages()).toEqual(["1:4"]);
  });

  it("says when a page can't be drawn, and draws it again on request", async () => {
    page.mockRejectedValueOnce(new Error("Out of memory."));
    await opened();
    expect(dialog()!.querySelector(".export-page.is-error")?.textContent).toContain("Out of memory.");
    await click(button("Try again"));
    expect(shownPages()).toEqual(["1:0"]);
  });
});

describe("turning the pages", () => {
  it("numbers spreads and single pages as a book does", async () => {
    await opened();
    expect(position()).toBe("1 of 9");
    expect(button("Previous page").disabled).toBe(true);
    await click(button("Next page"));
    expect(position()).toBe("2–3 of 9");
    expect(shownPages()).toEqual(["1:1", "1:2"]);

    await click(button("Single"));
    expect(position()).toBe("2 of 9");
    await click(button("Next page"));
    expect(position()).toBe("3 of 9");
    expect(shownPages()).toEqual(["1:2"]);

    await click(button("Spread"));
    expect(position()).toBe("2–3 of 9");
  });

  it("turns with Page Up and Page Down, Home and End, when the preview has focus", async () => {
    await opened();
    const stage = dialog()!.querySelector<HTMLElement>(".export-stage")!;
    await act(async () => stage.focus());
    await key({ key: "PageDown" });
    await settle();
    expect(position()).toBe("2–3 of 9");
    await key({ key: "End" });
    await settle();
    expect(position()).toBe("8–9 of 9");
    expect(button("Next page").disabled).toBe(true);
    await key({ key: "PageUp" });
    await settle();
    expect(position()).toBe("6–7 of 9");
    await key({ key: "Home" });
    await settle();
    expect(position()).toBe("1 of 9");
  });

  it("jumps to a chapter from the chapter menu, which lists the included chapters with their pages", async () => {
    await opened();
    await click(button("Chapters"));
    const items = [...document.querySelectorAll(".popover .menu-item")].map((i) => i.textContent);
    expect(items).toEqual(["Prologue3", "The Arrival5", "The Harbour7", "The Storm9"]);
    await click(menuItem("The Harbour")!);
    expect(position()).toBe("6–7 of 9");
    expect(document.querySelector(".popover")).toBeNull();
    await click(button("Chapters"));
    expect(menuItem("The Harbour")!.getAttribute("aria-checked")).toBe("true");
  });

  it("shows one page at a time on phones, with Settings and Preview as tabs", async () => {
    await opened({ isPhone: true });
    const settings = dialog()!.querySelector<HTMLElement>(".export-settings")!;
    const preview = dialog()!.querySelector<HTMLElement>(".export-preview")!;
    expect(settings.hidden).toBe(false);
    expect(preview.hidden).toBe(true);
    await click(tab("Preview"));
    expect(settings.hidden).toBe(true);
    expect(preview.hidden).toBe(false);
    expect(buttons().some((b) => b.textContent === "Spread")).toBe(false);
    expect(position()).toBe("1 of 9");
    await click(button("Next page"));
    expect(position()).toBe("2 of 9");
    // Cancel gives way to the close button.
    expect(buttons().some((b) => b.textContent === "Cancel")).toBe(false);
    await click(button("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("presets", () => {
  it("lists the built-in presets, then the project's", async () => {
    await opened();
    await click(presetButton());
    const labels = [...document.querySelectorAll(".popover .menu-item-label")].map((l) => l.textContent);
    expect(labels).toEqual(["Paperback A5", "Standard manuscript", "Reading copy", "Proof copy"]);
    expect(menuItem("Paperback A5")!.getAttribute("aria-checked")).toBe("true");
    // The settings are the preset's own: nothing to save.
    expect(menuItem("Save as preset…")).toBeUndefined();
  });

  it("applies a preset's settings when chosen, and shows when they have been changed", async () => {
    await opened();
    await click(presetButton());
    await click(menuItem("Standard manuscript")!);
    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Standard manuscript");
    expect(field<HTMLSelectElement>("Size").value).toBe("letter");
    expect(field("Text size").value).toBe("12");
    expect(field<HTMLSelectElement>("Line spacing").value).toBe("2");
    expect(field("Justify").checked).toBe(false);

    await type(field("Text size"), "13");
    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Standard manuscript (changed)");
    expect(presetButton().textContent).toContain("Standard manuscript (changed)");
    // Back to the preset's value: no longer changed.
    await type(field("Text size"), "12");
    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Standard manuscript");
  });

  it("saves changed settings as a project preset, under a name no built-in preset has", async () => {
    await opened();
    await type(field("Text size"), "13");
    await click(presetButton());
    await click(menuItem("Save as preset…")!);
    const name = field("Preset name");
    expect(document.activeElement).toBe(name);

    await click(button("Save preset"));
    expect(savePreset).not.toHaveBeenCalled();
    expect(popoverText()).toContain("Give the preset a name.");

    await type(name, "paperback a5");
    await click(button("Save preset"));
    expect(savePreset).not.toHaveBeenCalled();
    expect(popoverText()).toContain("“Paperback A5” is a built-in preset. Choose another name.");
    expect(name.getAttribute("aria-invalid")).toBe("true");

    await type(name, "Large print");
    await click(button("Save preset"));
    expect(savePreset).toHaveBeenCalledWith("Large print", { ...PAPERBACK, fontSize: 13 });
    expect(document.querySelector(".popover")).toBeNull();
    expect(presetButton().getAttribute("aria-label")).toBe("Preset: Large print");
    expect(document.activeElement).toBe(presetButton());

    // It is in the menu at once, with the project's own.
    await click(presetButton());
    expect(menuItem("Large print")!.getAttribute("aria-checked")).toBe("true");
  });

  it("says when a name replaces one of the project's presets", async () => {
    await opened();
    await click(presetButton());
    await click(menuItem("Proof copy")!);
    await type(field("Text size"), "9");
    await click(presetButton());
    await click(menuItem("Save as preset…")!);
    expect(field("Preset name").value).toBe("Proof copy");
    expect(popoverText()).toContain("Replaces the preset of that name.");
    await click(button("Save preset"));
    expect(savePreset).toHaveBeenCalledWith("Proof copy", { ...OWN, fontSize: 9 });
  });
});

describe("exporting", () => {
  it("exports the choice, remembers it, and says where the file went", async () => {
    const written = deferred<string | null>();
    exportFile.mockReturnValue(written.promise);
    await opened();
    expect(exportButton().textContent).toBe("Export PDF");
    await click(exportButton());
    const choice: ExportChoice = { format: "pdf", settings: PAPERBACK, chapterIds: ALL, author: "Ada Quill" };
    expect(exportFile).toHaveBeenCalledWith(choice);
    expect(remember).toHaveBeenCalledWith(choice, "Paperback A5");
    expect(exportButton().disabled).toBe(true);
    expect(exportButton().textContent).toBe("Exporting…");
    expect(status()).toBe("Exporting the PDF…");

    await act(async () => written.resolve(SAVED_TO));
    await settle();
    expect(status()).toBe(`Saved to ${SAVED_TO}`);
    expect(exportButton().disabled).toBe(false);
    // The window stays open for another format; there is nothing left to cancel.
    expect(dialog()).not.toBeNull();
    expect(buttons().some((b) => b.textContent === "Cancel")).toBe(false);
    await click(button("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names the file saved, without a path, when the system doesn't say where (Android)", async () => {
    exportFile.mockResolvedValue("");
    await opened();
    await click(exportButton());
    expect(status()).toBe("Saved the PDF.");
    expect(dialog()!.querySelector(".export-status")!.classList).toContain("is-done");
    expect(dialog()!.querySelector(".export-status .path")).toBeNull();

    await click(tab("Word"));
    await click(exportButton());
    expect(status()).toBe("Saved the Word document.");

    // The format exported, even if another tab was chosen while it was written.
    const written = deferred<string | null>();
    exportFile.mockReturnValue(written.promise);
    await click(tab("EPUB"));
    await click(exportButton());
    await click(tab("Markdown"));
    await act(async () => written.resolve(""));
    await settle();
    expect(status()).toBe("Saved the EPUB.");
  });

  it("does nothing more when the save dialog is cancelled", async () => {
    exportFile.mockResolvedValue(null);
    await opened();
    await click(exportButton());
    expect(exportFile).toHaveBeenCalledTimes(1);
    expect(status()).toBe("The preview redraws after each change.");
    expect(text()).not.toContain("Saved to");
    expect(exportButton().disabled).toBe(false);
    expect(button("Cancel")).toBeDefined();
  });

  it("says why an export failed", async () => {
    exportFile.mockRejectedValue(new Error("The disk is full."));
    await opened();
    await click(exportButton());
    expect(status()).toBe("Couldn’t export: The disk is full.");
    expect(dialog()!.querySelector(".export-status")!.classList).toContain("is-error");
    expect(exportButton().disabled).toBe(false);
  });

  it("names each format on the button, and leaves out the settings a format doesn't use", async () => {
    await opened();
    await click(tab("EPUB"));
    expect(exportButton().textContent).toBe("Export EPUB");
    expect(text()).toContain("page and text settings apply to PDF only");
    expect(text()).not.toContain("Margins (mm)");
    expect(dialog()!.querySelector(".export-page")).toBeNull();
    expect(dialog()!.querySelector(".export-preview")!.textContent).toContain("no fixed pages");

    await click(tab("Word"));
    expect(exportButton().textContent).toBe("Export Word document");
    expect(field("Text size").value).toBe("11");
    expect(text()).not.toContain("Margins (mm)");

    await click(tab("Markdown"));
    expect(exportButton().textContent).toBe("Export Markdown");
    expect(text()).not.toContain("Scene break");

    exportFile.mockResolvedValue("/home/ada/Books/book.md");
    await click(exportButton());
    expect(exportFile.mock.calls[0][0].format).toBe("markdown");
    // Back to PDF: the same settings, so no new layout is needed.
    await click(tab("PDF"));
    expect(layOut).toHaveBeenCalledTimes(1);
    expect(shownPages()).toEqual(["1:0"]);
  });

  it("moves between the formats with the arrow keys", async () => {
    await opened();
    await act(async () => tab("PDF").focus());
    await key({ key: "ArrowRight" });
    expect(tab("EPUB").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("EPUB"));
    await key({ key: "End" });
    expect(exportButton().textContent).toBe("Export Markdown");
  });
});

describe("choosing chapters", () => {
  it("exports only the chosen chapters, chosen by part or one by one", async () => {
    vi.useFakeTimers();
    await opened();
    await choose(field<HTMLSelectElement>("Include"), "chosen");
    expect(text()).toContain("4 of 4 chapters");
    await act(async () => field("Part One").click());
    expect(text()).toContain("2 of 4 chapters");
    expect(field("The Arrival").checked).toBe(false);
    await act(async () => field("The Arrival").click());
    expect(field("Part One").indeterminate).toBe(true);
    await advance(LAYOUT_DELAY_MS);
    expect(asked.at(-1)!.choice.chapterIds).toEqual(["prologue", "arrival", "storm"]);
  });

  it("can't export without a chapter, and says why", async () => {
    await opened();
    await choose(field<HTMLSelectElement>("Include"), "chosen");
    for (const name of ["Not in a part", "Part One", "Part Two"]) await act(async () => field(name).click());
    expect(text()).toContain("0 of 4 chapters");
    expect(exportButton().disabled).toBe(true);
    expect(status()).toBe("Choose at least one chapter to export.");
    expect(document.getElementById(exportButton().getAttribute("aria-describedby")!)?.textContent).toBe(
      "Choose at least one chapter to export.",
    );
    expect(dialog()!.querySelector(".export-page")).toBeNull();
    await click(exportButton());
    expect(exportFile).not.toHaveBeenCalled();

    await choose(field<HTMLSelectElement>("Include"), "all");
    expect(exportButton().disabled).toBe(false);
  });
});

describe("where pages can't be drawn", () => {
  it("says so in the preview, and still exports", async () => {
    exportFile.mockResolvedValue(SAVED_TO);
    await render({ source: sourceWith({ layOut: undefined, page: undefined }) });
    expect(dialog()!.querySelector(".export-preview")!.textContent).toContain("Pages can’t be drawn here");
    expect(dialog()!.querySelector(".export-page")).toBeNull();
    expect(status()).toBe("");
    await click(exportButton());
    expect(status()).toBe(`Saved to ${SAVED_TO}`);
  });
});

describe("the keyboard and focus", () => {
  it("Escape closes the window, but only the menu when one is open", async () => {
    await opened();
    await click(presetButton());
    expect(document.querySelector(".popover")).not.toBeNull();
    await key({ key: "Escape" });
    expect(document.querySelector(".popover")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(presetButton());

    const event = await key({ key: "Escape" });
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the window", async () => {
    await opened();
    await act(async () => exportButton().focus());
    await key({ key: "Tab" });
    expect(document.activeElement).toBe(tab("PDF"));
    await key({ key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(exportButton());
  });

  it("keeps keys from the app beneath", async () => {
    const app = vi.fn();
    window.addEventListener("keydown", app);
    try {
      await opened();
      await key({ key: "s", ctrlKey: true }, field("Author"));
      expect(app).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", app);
    }
  });

  it("gives focus back where it was once closed", async () => {
    await opened();
    expect(document.activeElement).not.toBe(opener);
    await render({ open: false });
    expect(document.activeElement).toBe(opener);
  });

  it("does the same in StrictMode, whose effects run twice: one layout, focus back once closed", async () => {
    const strict = (open: boolean) =>
      act(async () => root.render(createElement(StrictMode, null, createElement(ExportDialog, { ...props, open }))));
    await strict(true);
    await settle();
    expect(layOut).toHaveBeenCalledTimes(1);
    await answer(0, layoutOf(1));
    expect(shownPages()).toEqual(["1:0"]);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await strict(false);
    expect(document.activeElement).toBe(opener);
  });

  it("starts afresh at each opening", async () => {
    await opened();
    await click(tab("EPUB"));
    await render({ open: false });
    await render({ open: true });
    expect(tab("PDF").getAttribute("aria-selected")).toBe("true");
  });
});
