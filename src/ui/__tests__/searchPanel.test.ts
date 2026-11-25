// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findInBook, replaceInChapter, type SearchMatch } from "../../core/search";
import {
  RESULT_LIMIT,
  resultLine,
  SEARCH_DELAY_MS,
  SearchPanel,
  type SearchPanelProps,
  type SearchSource,
} from "../SearchPanel";

const SHORE = "manuscript/01 The shore.md";
const STORM = "manuscript/02 The storm.md";
const CALM = "manuscript/03 Calm.md";

interface Chapter {
  id: string;
  title: string;
  text: string;
}

/** "Ela" is in The shore 4 times (once inside Elaine) and in The storm 3 times (once as "ela"), never in Calm. */
const BOOK: Chapter[] = [
  {
    id: SHORE,
    title: "The shore",
    text: "# The shore\n\nEla walked to the shore.\n\n“Ela?” called Marco from the boat, and Elaine waved back at him.\n\nEla asleep at noon.\n",
  },
  { id: STORM, title: "The storm", text: "# The storm\n\nThe storm found *Ela* asleep.\n\nela woke. Ela said nothing.\n" },
  { id: CALM, title: "Calm", text: "# Calm\n\nNothing here.\n" },
];

const open = vi.fn<(match: SearchMatch) => void>();
const onClose = vi.fn<() => void>();
/** Every call to replace, with what it was given. */
let replaced: { matches: SearchMatch[]; replacement: string }[];
/** When set, replace throws this, as the workspace does when it can't write. */
let replaceFailure: string | null;
/**
 * How many of the matches replace is given it leaves as they are (the last ones), as
 * replaceInChapter does with one whose replacing would change the formatting around it.
 */
let unreplaceable: number;
/** When set, find throws this. */
let findFailure: string | null;
/** The book's text as the harness holds it; set from a test to stand for typing in the editor. */
let setBook: (book: Chapter[]) => void;

/**
 * Stands for the workspace: the book's text in state, a new source each time it changes, and
 * replace that writes the text with replaceInChapter, as the real one does.
 */
function Harness({ busy, panel }: { busy: boolean; panel: Omit<SearchPanelProps, "source"> }) {
  const [book, set] = useState(BOOK);
  setBook = set;
  const source = useMemo<SearchSource>(
    () => ({
      chapters: book.map(({ id, title }) => ({ id, title })),
      find(query, options) {
        if (findFailure !== null) throw new Error(findFailure);
        return findInBook(book, query, options);
      },
      open,
      replace(matches, replacement) {
        replaced.push({ matches, replacement });
        if (replaceFailure !== null) throw new Error(replaceFailure);
        const done = matches.slice(0, Math.max(0, matches.length - unreplaceable));
        let count = 0;
        set(
          book.map((chapter) => {
            const mine = done.filter((m) => m.chapterId === chapter.id);
            if (mine.length === 0) return chapter;
            const result = replaceInChapter(chapter.text, mine, replacement);
            count += result.replaced;
            return { ...chapter, text: result.text };
          }),
        );
        return count;
      },
      busy,
    }),
    [book, busy],
  );
  return createElement(SearchPanel, { source, ...panel });
}

let container: HTMLDivElement;
let root: Root;
let panel: Omit<SearchPanelProps, "source">;
let busy: boolean;
/** Escape that got past the panel to the window, where the phone layout closes the panel too. */
const windowEscape = vi.fn();
const onWindowKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") windowEscape();
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  open.mockReset();
  onClose.mockReset();
  windowEscape.mockReset();
  replaced = [];
  replaceFailure = null;
  unreplaceable = 0;
  findFailure = null;
  busy = false;
  panel = { focusRequest: 1, initialMode: "find", initialQuery: "", onClose };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.addEventListener("keydown", onWindowKey);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener("keydown", onWindowKey);
  vi.useRealTimers();
});

async function render(patch: Partial<Omit<SearchPanelProps, "source">> = {}, nowBusy = busy) {
  panel = { ...panel, ...patch };
  busy = nowBusy;
  await act(async () => root.render(createElement(Harness, { busy, panel })));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

/** Types in Find and lets the pause pass. */
async function search(query: string) {
  await type(findField(), query);
  await advance(SEARCH_DELAY_MS);
}

const findField = () => container.querySelector<HTMLInputElement>('input[aria-label="Find"]')!;
const replaceField = () => container.querySelector<HTMLInputElement>('input[aria-label="Replace with"]');
const summary = () => container.querySelector(".search-summary")!.textContent;
const replaceStatus = () => container.querySelector(".search-replace-status")?.textContent;
const alertText = () => [...container.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
const results = () => [...container.querySelectorAll<HTMLButtonElement>(".search-result")];
const resultTexts = () => results().map((r) => r.textContent);
const items = () => [...container.querySelectorAll<HTMLElement>(".search-item")];
const groups = () =>
  [...container.querySelectorAll(".search-group")].map((g) => ({
    title: g.querySelector(".search-group-name")!.textContent,
    count: g.querySelector(".search-group-count")!.textContent,
    rows: g.querySelectorAll(".search-result").length,
  }));
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) => {
  const found = buttons().find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  if (!found) throw new Error(`No button “${name}”`);
  return found;
};
const replaceAllButton = () => container.querySelector<HTMLButtonElement>(".search-replace-all");
const rowReplace = (item: HTMLElement) => item.querySelector<HTMLButtonElement>(".search-replace-one");

describe("finding", () => {
  it("starts empty, with focus in Find, and says what to do", async () => {
    await render();
    expect(document.activeElement).toBe(findField());
    expect(findField().value).toBe("");
    expect(summary()).toBe("Type a word or phrase to find it in every chapter.");
    expect(results()).toHaveLength(0);
    expect(replaceField()).toBeNull();
  });

  it("searches once typing pauses, and lists the results by chapter with their counts", async () => {
    await render();
    await type(findField(), "Ela");
    await advance(SEARCH_DELAY_MS - 1);
    expect(results()).toHaveLength(0);
    await advance(1);
    expect(summary()).toBe("7 results in 2 chapters");
    expect(groups()).toEqual([
      { title: "The shore", count: "4 results", rows: 4 },
      { title: "The storm", count: "3 results", rows: 3 },
    ]);
    expect(resultTexts()).toEqual([
      "Ela walked to the shore.",
      "“Ela?” called Marco from the boat, and Elain…",
      "…boat, and Elaine waved back at him.",
      "Ela asleep at noon.",
      "…storm found Ela asleep.",
      "ela woke. Ela said nothing.",
      "ela woke. Ela said nothing.",
    ]);
    // The match is marked in its line.
    expect([...container.querySelectorAll("mark.search-match")].map((m) => m.textContent)).toEqual([
      "Ela",
      "Ela",
      "Ela",
      "Ela",
      "Ela",
      "ela",
      "Ela",
    ]);
  });

  it("empties the list at once when Find is cleared", async () => {
    await render();
    await search("Ela");
    await type(findField(), "");
    expect(results()).toHaveLength(0);
    expect(summary()).toBe("Type a word or phrase to find it in every chapter.");
  });

  it("searches again when Match case or Whole word is toggled", async () => {
    await render();
    await search("Ela");
    const matchCase = button("Match case");
    const wholeWord = button("Whole word");
    expect(matchCase.getAttribute("aria-pressed")).toBe("false");

    await click(matchCase);
    expect(matchCase.getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toBe("6 results in 2 chapters");
    expect([...container.querySelectorAll("mark.search-match")].map((m) => m.textContent)).not.toContain("ela");

    await click(wholeWord);
    expect(wholeWord.getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toBe("5 results in 2 chapters");

    await click(matchCase);
    expect(summary()).toBe("6 results in 2 chapters");
  });

  it("says when nothing is found, and which options narrowed it", async () => {
    await render();
    await search("Arno");
    expect(summary()).toBe("No results for “Arno”.");
    await click(button("Match case"));
    await click(button("Whole word"));
    await search("ELA");
    expect(summary()).toBe("No results for “ELA”. Match case and Whole word are on.");
    expect(results()).toHaveLength(0);
  });

  it("finds again when the book's text changes", async () => {
    await render();
    await search("Ela");
    await act(async () => setBook(BOOK.map((c) => (c.id === CALM ? { ...c, text: "# Calm\n\nEla rests.\n" } : c))));
    expect(summary()).toBe("8 results in 3 chapters");
    expect(groups().at(-1)).toEqual({ title: "Calm", count: "1 result", rows: 1 });
  });

  it("shows why a search failed", async () => {
    findFailure = "The pattern is too long.";
    await render();
    await search("Ela");
    expect(alertText()).toBe("Couldn’t search: The pattern is too long.");
    expect(summary()).toBe("");
    expect(results()).toHaveLength(0);
  });

  it(`lists the first ${RESULT_LIMIT} results and asks for a narrower search`, async () => {
    await render();
    await act(async () => setBook([{ id: CALM, title: "Calm", text: "a ".repeat(RESULT_LIMIT + 100) }]));
    await search("a");
    expect(summary()).toBe("1,100 results in 1 chapter");
    expect(groups()).toEqual([{ title: "Calm", count: "1,100 results", rows: RESULT_LIMIT }]);
    expect(container.querySelector(".search-more")?.textContent).toBe(
      "Showing the first 1,000 results. Type more to narrow the search.",
    );
  });
});

describe("what it searches for", () => {
  it("is said once typing pauses, and when an option changes, for the text's marks", async () => {
    const onSearchChange = vi.fn();
    await render({ onSearchChange });
    expect(onSearchChange).toHaveBeenLastCalledWith("", { matchCase: false, wholeWord: false });
    onSearchChange.mockClear();
    await type(findField(), "Ela");
    await advance(SEARCH_DELAY_MS - 1);
    expect(onSearchChange).not.toHaveBeenCalled();
    await advance(1);
    expect(onSearchChange).toHaveBeenLastCalledWith("Ela", { matchCase: false, wholeWord: false });
    await click(button("Match case"));
    expect(onSearchChange).toHaveBeenLastCalledWith("Ela", { matchCase: true, wholeWord: false });
    await type(findField(), "");
    expect(onSearchChange).toHaveBeenLastCalledWith("", { matchCase: true, wholeWord: false });
    expect(onSearchChange).toHaveBeenCalledTimes(3);
  });

  it("is said again with the selection it is opened with", async () => {
    const onSearchChange = vi.fn();
    await render({ onSearchChange, initialQuery: "storm" });
    expect(onSearchChange).toHaveBeenLastCalledWith("storm", { matchCase: false, wholeWord: false });
    await render({ focusRequest: 2, initialQuery: "Ela" });
    expect(onSearchChange).toHaveBeenLastCalledWith("Ela", { matchCase: false, wholeWord: false });
  });
});

describe("opening results", () => {
  it("opens a clicked result and marks it as the active one", async () => {
    await render();
    await search("Ela");
    await click(results()[2]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({ chapterId: SHORE, line: 4, from: 39, text: "Ela" });
    expect(results()[2].getAttribute("aria-current")).toBe("true");
    expect(results().filter((r) => r.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("goes through the results with Enter and Shift+Enter in Find, round the ends", async () => {
    await render();
    await search("Ela");
    const opened = () => open.mock.calls.map(([m]) => `${m.chapterId === SHORE ? "shore" : "storm"}:${m.line}:${m.from}`);

    await key({ key: "Enter" }, findField());
    await key({ key: "Enter" }, findField());
    await key({ key: "Enter", shiftKey: true }, findField());
    await key({ key: "Enter", shiftKey: true }, findField());
    expect(opened()).toEqual(["shore:2:0", "shore:4:1", "shore:2:0", "storm:4:10"]);
    expect(results()[6].getAttribute("aria-current")).toBe("true");

    await key({ key: "Enter" }, findField());
    expect(opened().at(-1)).toBe("shore:2:0");
  });

  it("goes on from the active result after the text changes", async () => {
    await render();
    await search("Ela");
    await click(results()[3]);
    // The result opened is gone (the writer changed it in the editor): Enter goes to the one after where it was.
    await act(async () =>
      setBook(BOOK.map((c) => (c.id === SHORE ? { ...c, text: c.text.replace("Ela asleep", "Nobody") } : c))),
    );
    await key({ key: "Enter" }, findField());
    expect(open.mock.calls.at(-1)![0]).toMatchObject({ chapterId: STORM, line: 2 });
  });

  it("searches at once when Enter comes before the pause ends", async () => {
    await render();
    await type(findField(), "storm");
    await key({ key: "Enter" }, findField());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toMatchObject({ chapterId: STORM, line: 0, text: "storm" });
    expect(summary()).toBe("2 results in 1 chapter");
  });

  it("moves between results with the arrow keys, Home and End, and back up to Find", async () => {
    await render();
    await search("Ela");
    await key({ key: "ArrowDown" }, findField());
    expect(document.activeElement).toBe(results()[0]);
    await key({ key: "ArrowDown" });
    expect(document.activeElement).toBe(results()[1]);
    // One stop for Tab: the row last moved to.
    expect(results().filter((r) => r.tabIndex === 0)).toEqual([results()[1]]);
    await key({ key: "End" });
    expect(document.activeElement).toBe(results()[6]);
    await key({ key: "ArrowDown" });
    expect(document.activeElement).toBe(results()[6]);
    await key({ key: "Home" });
    expect(document.activeElement).toBe(results()[0]);
    await key({ key: "ArrowUp" });
    expect(document.activeElement).toBe(findField());
    expect(open).not.toHaveBeenCalled();
  });
});

describe("Escape and closing", () => {
  it("clears Find, then closes the panel, without the key reaching the window", async () => {
    await render();
    await search("Ela");
    await key({ key: "Escape" }, findField());
    expect(findField().value).toBe("");
    expect(results()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    await key({ key: "Escape" }, findField());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowEscape).not.toHaveBeenCalled();
  });

  it("closes from a result, and from the close button", async () => {
    await render();
    await search("Ela");
    await key({ key: "Escape" }, results()[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(button("Close Find in book"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(windowEscape).not.toHaveBeenCalled();
  });
});

describe("opening again", () => {
  it("fills Find with the selection it was opened with, selected, and lists its results at once", async () => {
    await render({ initialQuery: "storm" });
    expect(findField().value).toBe("storm");
    expect(document.activeElement).toBe(findField());
    expect([findField().selectionStart, findField().selectionEnd]).toEqual([0, 5]);
    expect(summary()).toBe("2 results in 1 chapter");
  });

  it("leaves Find empty for a selection over several paragraphs", async () => {
    await render({ initialQuery: "Ela walked.\n\nThe storm" });
    expect(findField().value).toBe("");
  });

  it("takes focus back, its text selected, each time it is asked again", async () => {
    await render();
    await search("Ela");
    results()[0].focus();
    await render({ focusRequest: 2 });
    expect(document.activeElement).toBe(findField());
    expect([findField().selectionStart, findField().selectionEnd]).toEqual([0, 3]);
    expect(findField().value).toBe("Ela");

    // With a new selection, it searches for that instead.
    await render({ focusRequest: 3, initialQuery: "noon" });
    expect(findField().value).toBe("noon");
    expect(summary()).toBe("1 result in 1 chapter");
  });

  it("opens Replace when asked for it, and keeps it open when asked to find", async () => {
    await render({ initialMode: "replace" });
    expect(replaceField()).not.toBeNull();
    expect(document.activeElement).toBe(findField());
    await click(button("Replace"));
    expect(replaceField()).toBeNull();
    await render({ focusRequest: 2, initialMode: "replace" });
    expect(replaceField()).not.toBeNull();
    expect(button("Replace").getAttribute("aria-expanded")).toBe("true");
    await render({ focusRequest: 3, initialMode: "find" });
    expect(replaceField()).not.toBeNull();
  });
});

describe("replacing", () => {
  async function replaceMode(query: string, replacement: string) {
    await render({ initialMode: "replace" });
    await search(query);
    await type(replaceField()!, replacement);
  }

  it("shows a Replace on each row only while the replacement shows", async () => {
    await render();
    await search("Ela");
    expect(container.querySelectorAll(".search-replace-one")).toHaveLength(0);
    await click(button("Replace"));
    expect(container.querySelectorAll(".search-replace-one")).toHaveLength(7);
    await type(replaceField()!, "Elena");
    expect(rowReplace(items()[0])!.getAttribute("aria-label")).toBe("Replace with “Elena”");
  });

  it("replaces one result, then moves focus on to the next one's Replace", async () => {
    await replaceMode("Ela", "Elena");
    await act(async () => rowReplace(items()[0])!.focus());
    await click(rowReplace(items()[0])!);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].replacement).toBe("Elena");
    expect(replaced[0].matches).toHaveLength(1);
    expect(replaced[0].matches[0]).toMatchObject({ chapterId: SHORE, line: 2, from: 0 });
    expect(summary()).toBe("6 results in 2 chapters");
    expect(replaceStatus()).toBe("Replaced 1.");
    expect(document.activeElement).toBe(rowReplace(items()[0]));
    expect(results()[0].textContent).toBe("“Ela?” called Marco from the boat, and Elain…");
  });

  it("asks before Replace all, and replaces every result once confirmed", async () => {
    await replaceMode("Ela", "Elena");
    expect(replaceAllButton()!.textContent).toBe("Replace all 7");
    expect(container.querySelectorAll(".btn--primary")).toHaveLength(1);

    await click(replaceAllButton()!);
    expect(replaced).toHaveLength(0);
    expect(container.querySelector(".search-confirm p")!.textContent).toBe(
      "Replace 7 “Ela” with “Elena” across 2 chapters? Undo only works in the chapter that’s open.",
    );
    // The question takes Replace all's place: still one primary action.
    expect(replaceAllButton()).toBeNull();
    expect(container.querySelectorAll(".btn--primary")).toHaveLength(1);
    expect(document.activeElement).toBe(button("Replace 7"));

    await click(button("Replace 7"));
    expect(replaced).toHaveLength(1);
    expect(replaced[0].matches).toHaveLength(7);
    expect(replaceStatus()).toBe("Replaced 7.");
    expect(summary()).toBe("No results for “Ela”.");
    expect(container.querySelector(".search-confirm")).toBeNull();
    expect(replaceAllButton()!.disabled).toBe(true);
    expect(replaceAllButton()!.textContent).toBe("Replace all");
    // Nothing left to replace: focus waits in the replacement.
    expect(document.activeElement).toBe(replaceField());
  });

  it("asks to delete when the replacement is empty", async () => {
    await replaceMode("Ela", "");
    expect(rowReplace(items()[0])!.getAttribute("aria-label")).toBe("Delete");
    await click(replaceAllButton()!);
    expect(container.querySelector(".search-confirm p")!.textContent).toBe(
      "Delete 7 “Ela” across 2 chapters? Undo only works in the chapter that’s open.",
    );
    await click(button("Delete 7"));
    expect(replaced[0].replacement).toBe("");
  });

  it("takes the question back with Cancel or Escape, focus back on Replace all, the panel open", async () => {
    await replaceMode("storm", "gale");
    await click(replaceAllButton()!);
    expect(container.querySelector(".search-confirm p")!.textContent).toContain("in 1 chapter?");
    await click(button("Cancel"));
    expect(container.querySelector(".search-confirm")).toBeNull();
    expect(document.activeElement).toBe(replaceAllButton());

    await click(replaceAllButton()!);
    await key({ key: "Escape" });
    expect(container.querySelector(".search-confirm")).toBeNull();
    expect(document.activeElement).toBe(replaceAllButton());
    expect(onClose).not.toHaveBeenCalled();
    expect(windowEscape).not.toHaveBeenCalled();
    expect(replaced).toHaveLength(0);
  });

  it("asks from Enter in the replacement too", async () => {
    await replaceMode("storm", "gale");
    await key({ key: "Enter" }, replaceField()!);
    expect(document.activeElement).toBe(button("Replace 2"));
    expect(replaced).toHaveLength(0);
  });

  it("drops the question when the search or the replacement changes", async () => {
    await replaceMode("Ela", "Elena");
    await click(replaceAllButton()!);
    await type(replaceField()!, "Elina");
    expect(container.querySelector(".search-confirm")).toBeNull();
    await click(replaceAllButton()!);
    await type(findField(), "storm");
    expect(container.querySelector(".search-confirm")).toBeNull();
  });

  it("doesn't offer to replace a result partly in italics or bold, and says so", async () => {
    await replaceMode("Ela asleep", "Ela slept");
    expect(summary()).toBe("2 results in 2 chapters");
    const [plain, crossing] = items();
    expect(rowReplace(plain)).not.toBeNull();
    expect(rowReplace(crossing)).toBeNull();
    expect(crossing.querySelector(".search-note")!.textContent).toBe("Partly italic or bold: change it in the text.");
    expect(crossing.querySelector(".search-result")!.getAttribute("aria-describedby")).toBe(
      crossing.querySelector(".search-note")!.id,
    );
    // It still opens.
    await click(crossing.querySelector<HTMLButtonElement>(".search-result")!);
    expect(open.mock.calls[0][0]).toMatchObject({ chapterId: STORM, acrossFormatting: true });

    expect(replaceAllButton()!.textContent).toBe("Replace all 1");
    expect(container.querySelector(".search-hint")!.textContent).toBe(
      "1 result is partly italic or bold: change it in the text.",
    );
    await click(replaceAllButton()!);
    await click(button("Replace 1"));
    expect(replaced[0].matches.map((m) => m.chapterId)).toEqual([SHORE]);
    expect(replaceStatus()).toBe("Replaced 1. Left 1 that is partly italic or bold.");
    expect(summary()).toBe("1 result in 1 chapter");
  });

  it("says why a row's result was left as it is, and keeps it listed", async () => {
    unreplaceable = 1;
    await replaceMode("Ela", "Elena");
    await act(async () => rowReplace(items()[0])!.focus());
    await click(rowReplace(items()[0])!);
    expect(replaced).toHaveLength(1);
    expect(replaceStatus()).toBe(
      "Replacing that one would change the formatting around it: change it in the text.",
    );
    expect(alertText()).toBe("");
    expect(summary()).toBe("7 results in 2 chapters");
    expect(results()[0].textContent).toBe("Ela walked to the shore.");
    expect(document.activeElement).toBe(rowReplace(items()[0]));
  });

  it("says so for a result the text can't take the replacement in without losing its bold", async () => {
    await render({ initialMode: "replace" });
    await act(async () => setBook([{ id: CALM, title: "Calm", text: "# Calm\n\n**well,**, ax\n" }]));
    // Replace with left empty: deleting ", a" would leave "**well,**x", which doesn't read as bold.
    await search(", a");
    expect(summary()).toBe("1 result in 1 chapter");
    await click(rowReplace(items()[0])!);
    expect(replaceStatus()).toBe(
      "Replacing that one would change the formatting around it: change it in the text.",
    );
    expect(summary()).toBe("1 result in 1 chapter");
  });

  it("says how many Replace all left, and why", async () => {
    await replaceMode("Ela", "Elena");

    unreplaceable = 7;
    await click(replaceAllButton()!);
    await click(button("Replace 7"));
    expect(replaceStatus()).toBe("Replacing all 7 would change the formatting around them: change those in the text.");
    expect(summary()).toBe("7 results in 2 chapters");

    unreplaceable = 2;
    await click(replaceAllButton()!);
    await click(button("Replace 7"));
    expect(replaceStatus()).toBe(
      "Replaced 5 of 7. Replacing the other 2 would change the formatting around them: change those in the text.",
    );
    expect(summary()).toBe("2 results in 1 chapter");

    unreplaceable = 1;
    await click(replaceAllButton()!);
    await click(button("Replace 2"));
    expect(replaceStatus()).toBe(
      "Replaced 1 of 2. Replacing the other one would change the formatting around it: change it in the text.",
    );
    expect(summary()).toBe("1 result in 1 chapter");
  });

  it("says why for both kinds left, those partly italic or bold too", async () => {
    await render({ initialMode: "replace" });
    await act(async () => setBook(BOOK.map((c) => (c.id === CALM ? { ...c, text: "# Calm\n\nEla asleep again.\n" } : c))));
    await search("Ela asleep");
    await type(replaceField()!, "Ela slept");
    expect(summary()).toBe("3 results in 3 chapters");
    expect(replaceAllButton()!.textContent).toBe("Replace all 2");

    unreplaceable = 1;
    await click(replaceAllButton()!);
    await click(button("Replace 2"));
    expect(replaceStatus()).toBe(
      "Replaced 1 of 2. Replacing the other one would change the formatting around it: change it in the text. Left 1 that is partly italic or bold.",
    );
    expect(summary()).toBe("2 results in 2 chapters");
  });

  it("waits while the text is being changed elsewhere", async () => {
    busy = true;
    await replaceMode("Ela", "Elena");
    expect(replaceAllButton()!.disabled).toBe(true);
    expect(items().every((item) => rowReplace(item)!.disabled)).toBe(true);
    // Results still open.
    await click(results()[0]);
    expect(open).toHaveBeenCalledTimes(1);

    await render({}, false);
    expect(replaceAllButton()!.disabled).toBe(false);
    await click(replaceAllButton()!);
    await render({}, true);
    expect(button("Replace 7").disabled).toBe(true);
  });

  it("shows why a replace failed, and keeps the question for another try", async () => {
    replaceFailure = "The Storm couldn’t be saved: the disk is full.";
    await replaceMode("Ela", "Elena");
    await click(rowReplace(items()[0])!);
    expect(alertText()).toBe("The Storm couldn’t be saved: the disk is full.");
    expect(summary()).toBe("7 results in 2 chapters");

    await click(replaceAllButton()!);
    expect(alertText()).toBe("");
    await click(button("Replace 7"));
    expect(alertText()).toBe("The Storm couldn’t be saved: the disk is full.");
    expect(container.querySelector(".search-confirm")).not.toBeNull();
    expect(replaceStatus()).toBe("");

    replaceFailure = null;
    await click(button("Replace 7"));
    expect(alertText()).toBe("");
    expect(replaceStatus()).toBe("Replaced 7.");
  });
});

describe("resultLine", () => {
  const match = (before: string, text: string, after: string): SearchMatch => ({
    chapterId: SHORE,
    line: 0,
    from: before.length,
    to: before.length + text.length,
    before,
    text,
    after,
    acrossFormatting: false,
  });

  it("keeps a short start of paragraph whole", () => {
    expect(resultLine(match("She said ", "Ela", " twice."))).toEqual({ lead: "She said ", text: "Ela", trail: " twice." });
  });

  it("keeps a few whole words before the match, and marks where the paragraph goes on", () => {
    expect(resultLine(match("Long before the storm had come, she said ", "Ela", "")).lead).toBe("…she said ");
    expect(resultLine(match("x".repeat(30), "Ela", "")).lead).toBe(`…${"x".repeat(12)}`);
    expect(resultLine(match("", "Ela", "y".repeat(40))).trail).toBe(`${"y".repeat(40)}…`);
  });
});
