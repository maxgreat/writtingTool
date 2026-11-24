// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend";
import { NameMatcher } from "../names";
import { buildNameMatcher, buildProject, type Project, type ProjectSnapshot } from "../project";
import { useNameSuggestions, type NameSuggestions } from "../useNameSuggestions";

const ONE = "manuscript/01 One.md";
const TWO = "manuscript/02 Two.md";

function snapshotOf(p: Project): ProjectSnapshot {
  return {
    root: p.root,
    folderName: "P",
    projectJson: JSON.stringify(p.json),
    files: [...Object.values(p.chapters).map((c) => ({ path: c.id, text: c.text })), ...p.sheets.map((s) => ({ path: s.id, text: s.text }))],
    skipped: [],
  };
}

function project(texts: [string, string], extra: { language?: string; notNames?: string[] } = {}): Project {
  return buildProject({
    root: "/p",
    folderName: "P",
    projectJson: JSON.stringify({ language: extra.language ?? "en-GB", notNames: extra.notNames ?? [] }),
    files: [
      { path: ONE, text: texts[0] },
      { path: TWO, text: texts[1] },
      { path: "sheets/characters/Elena.md", text: "---\nname: Elena\n---\n" },
    ],
    skipped: [],
  });
}

/** "River" and "Monday" are ordinary words; everything else may be a name. */
const ordinaryWords = vi.fn(async (_language: string, words: string[]) => words.map((w) => ["River", "Monday"].includes(w)));

let root: Root;
let result: NameSuggestions;

function Probe({ backend, p }: { backend: Backend | null; p: Project }) {
  result = useNameSuggestions(backend, p, buildMatcherFor(p));
  return null;
}

const matchers = new WeakMap<Project["sheets"], ReturnType<typeof buildNameMatcher>>();
function buildMatcherFor(p: Project) {
  let m = matchers.get(p.sheets);
  if (!m) {
    m = buildNameMatcher(p.sheets);
    matchers.set(p.sheets, m);
  }
  return m;
}

async function render(backend: Backend | null, p: Project) {
  await act(async () => root.render(createElement(Probe, { backend, p })));
  await act(async () => {});
}

const appBackend = { ordinaryWords } as unknown as Backend;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  ordinaryWords.mockClear();
  root = createRoot(document.createElement("div"));
});

afterEach(() => act(() => root.unmount()));

const words = () => result.list.map((p) => [p.word, p.count]);

describe("useNameSuggestions", () => {
  it("offers every word the dictionary doesn't know, from its first use", async () => {
    await render(appBackend, project(["# One\n\nThen Tomas met Elena by the River on Monday.\n", "# Two\n\nAnd Ida.\n"]));
    expect(words()).toEqual([
      ["Ida", 1],
      ["Tomas", 1],
    ]);
    expect([...result.words].sort()).toEqual(["Ida", "Tomas"]);
    expect(result.rule).toBe("dictionary");
    expect(ordinaryWords).toHaveBeenCalledWith("en-GB", expect.arrayContaining(["Tomas", "River", "Monday", "Ida"]));
  });

  it("reads nothing in the render that shows the project, and the book after it", async () => {
    const p = project(["Then Tomas came.\n", "x\n"]);
    const matcher = buildMatcherFor(p);
    const find = vi.spyOn(matcher, "find");
    /** Lines the matcher had read when each render of the hook returned. */
    const readAt: number[] = [];
    function First() {
      const found = useNameSuggestions(appBackend, p, matcher);
      readAt.push(find.mock.calls.length);
      return found.list.length > 0 ? "found" : null;
    }
    await act(async () => root.render(createElement(First)));
    await act(async () => {});
    expect(readAt[0]).toBe(0);
    expect(find.mock.calls.length).toBeGreaterThan(0);
    find.mockRestore();
  });

  it("drops a word that became a sheet or was marked not a name in that very render, reading nothing", async () => {
    const before = project(["Then Tomas came. And Ida.\n", "x\n"]);
    const withTomas = buildProject({
      ...snapshotOf(before),
      files: [...snapshotOf(before).files, { path: "sheets/characters/Tomas.md", text: "---\nname: Tomas\n---\n" }],
    });
    const lists: string[][] = [];
    let readsInUrgentRender = -1;
    let urgentMatcher: ReturnType<typeof buildNameMatcher> | null = null;
    function Track({ p }: { p: Project }) {
      const m = buildMatcherFor(p);
      const found = useNameSuggestions(appBackend, p, m);
      lists.push(found.list.map((x) => x.word));
      if (m === urgentMatcher && readsInUrgentRender === -1) readsInUrgentRender = find.mock.calls.length;
      return null;
    }
    const find = vi.spyOn(NameMatcher.prototype, "find");
    await act(async () => root.render(createElement(Track, { p: before })));
    await act(async () => {});
    expect(lists.at(-1)).toEqual(["Ida", "Tomas"]);

    // A sheet for Tomas: every render from now on leaves him out, the urgent one too.
    const seen = lists.length;
    await act(async () => root.render(createElement(Track, { p: withTomas })));
    await act(async () => {});
    expect(lists.slice(seen).every((l) => !l.includes("Tomas"))).toBe(true);

    // Not a name: the urgent render reads no line of the book.
    const notIda = { ...withTomas, notNames: ["Ida"] };
    urgentMatcher = buildMatcherFor(notIda);
    find.mockClear();
    await act(async () => root.render(createElement(Track, { p: notIda })));
    expect(lists.at(-1)).toEqual([]);
    expect(readsInUrgentRender).toBe(0);
    find.mockRestore();
  });

  it("asks about each word once, and keeps the same set while the words don't change", async () => {
    const backend = appBackend;
    await render(backend, project(["Then Tomas came.\n", "x\n"]));
    const first = result.words;
    await render(backend, project(["Then Tomas came. Then Tomas left.\n", "x\n"]));
    expect(result.list[0]).toMatchObject({ word: "Tomas", count: 2 });
    expect(result.words).toBe(first);
    expect(ordinaryWords).toHaveBeenCalledTimes(1);
  });

  it("leaves out words marked as not names", async () => {
    await render(appBackend, project(["Then Tomas and Ida came.\n", "x\n"], { notNames: ["Ida"] }));
    expect(words()).toEqual([["Tomas", 1]]);
  });

  it("needs three uses without a dictionary for the language", async () => {
    const none = { ordinaryWords: vi.fn(async () => null) } as unknown as Backend;
    await render(none, project(["Then Tomas came. Then Tomas left. And Ida.\n", "So Tomas slept.\n"], { language: "de" }));
    expect(words()).toEqual([["Tomas", 3]]);
    expect(result.rule).toBe("count");
  });

  it("needs three uses where there are no dictionaries at all, or when the core fails", async () => {
    const texts: [string, string] = ["Then Tomas came. Then Tomas left. And Ida.\n", "So Tomas slept.\n"];
    await render({} as Backend, project(texts));
    expect(words()).toEqual([["Tomas", 3]]);
    const failing = { ordinaryWords: vi.fn(async () => Promise.reject(new Error("boom"))) } as unknown as Backend;
    root.unmount();
    root = createRoot(document.createElement("div"));
    await render(failing, project(texts));
    expect(words()).toEqual([["Tomas", 3]]);
  });

  it("drops an answer for a language the project no longer has", async () => {
    let answerEnglish: (value: boolean[]) => void = () => undefined;
    const slow = {
      ordinaryWords: vi.fn((language: string, ws: string[]) =>
        language === "en-GB" ? new Promise<boolean[]>((resolve) => (answerEnglish = resolve)) : Promise.resolve(ws.map(() => false)),
      ),
    } as unknown as Backend;
    const texts: [string, string] = ["Then Tomas came.\n", "x\n"];
    await render(slow, project(texts));
    await render(slow, project(texts, { language: "fr-FR" }));
    expect(words()).toEqual([["Tomas", 1]]);
    await act(async () => answerEnglish([true]));
    expect(words()).toEqual([["Tomas", 1]]);
  });
});
