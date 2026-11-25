// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend";
import { NameMatcher } from "../names";
import { SPELLING_DELAY_MS, useSpelling, type Spelling } from "../useSpelling";

/** A dictionary that knows a handful of words. */
const KNOWN = new Set(["the", "then", "boat", "was", "by", "river", "and", "saw", "it"]);
const checkWords = vi.fn(async (_language: string, words: string[]) => words.map((w) => KNOWN.has(w.toLowerCase())));
const app = { checkWords } as unknown as Backend;

const ELENA = new NameMatcher([{ text: "Elena", sheetId: "e", kind: "characters", ignoreCase: false }]);
const NONE: ReadonlySet<string> = new Set();

let root: Root;
let result: Spelling;

interface Props {
  backend: Backend | null;
  language?: string;
  text: string | null;
  suggestions?: ReadonlySet<string>;
  accepted?: ReadonlySet<string>;
}

function Probe({ backend, language = "en-GB", text, suggestions = NONE, accepted = NONE }: Props) {
  result = useSpelling(backend, language, text, ELENA, suggestions, accepted);
  return null;
}

async function render(props: Props) {
  await act(async () => root.render(createElement(Probe, props)));
}

/** Typing stops: the check runs, and its answer comes back. */
async function pause() {
  await act(async () => {
    vi.advanceTimersByTime(SPELLING_DELAY_MS);
  });
  await act(async () => {});
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  checkWords.mockClear();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const marked = () => [...result.misspelled].sort();

describe("useSpelling", () => {
  it("marks the words the dictionary doesn't know: at once on opening, then once typing has stopped", async () => {
    await render({ backend: app, text: "# The boat\n\nElena saw teh boat by the rivr.\n" });
    await act(async () => {});
    expect(marked()).toEqual(["rivr", "teh"]);
    await render({ backend: app, text: "# The boat\n\nElena saw teh boat by the rivr. Bt\n" });
    await act(async () => {});
    expect(marked()).toEqual(["rivr", "teh"]);
    await pause();
    expect(marked()).toEqual(["Bt", "rivr", "teh"]);
    expect(result.available).toBe(true);
    // Names are never asked about.
    expect(checkWords.mock.calls.flatMap(([, words]) => words)).not.toContain("Elena");
  });

  it("asks once per word, and only about new words", async () => {
    await render({ backend: app, text: "the boat, the boat" });
    await pause();
    expect(checkWords).toHaveBeenCalledTimes(1);
    expect(checkWords.mock.calls[0][1]).toEqual(["the", "boat"]);
    await render({ backend: app, text: "the boat, the bot" });
    await pause();
    expect(checkWords).toHaveBeenCalledTimes(2);
    expect(checkWords.mock.calls[1][1]).toEqual(["bot"]);
    expect(marked()).toEqual(["bot"]);
  });

  it("leaves possible names and the writer's words alone", async () => {
    const text = "Then Mara saw teh skiff.";
    await render({ backend: app, text, suggestions: new Set(["Mara"]), accepted: new Set(["skiff"]) });
    await pause();
    expect(marked()).toEqual(["teh"]);
  });

  it("keeps the same set while the misspelled words don't change", async () => {
    await render({ backend: app, text: "teh boat" });
    await pause();
    const first = result.misspelled;
    await render({ backend: app, text: "teh boat was" });
    await pause();
    expect(result.misspelled).toBe(first);
  });

  it("marks nothing without a dictionary, or without the core", async () => {
    const none = { checkWords: vi.fn(async () => null) } as unknown as Backend;
    await render({ backend: none, language: "de", text: "Das Boot" });
    await pause();
    expect(marked()).toEqual([]);
    expect(result.available).toBe(false);

    act(() => root.unmount());
    root = createRoot(document.createElement("div"));
    await render({ backend: {} as Backend, text: "teh boat" });
    await pause();
    expect(marked()).toEqual([]);
    expect(result.available).toBe(false);
  });

  it("asks again after a failure, at the next change", async () => {
    checkWords.mockRejectedValueOnce(new Error("busy"));
    await render({ backend: app, text: "teh boat" });
    await pause();
    expect(marked()).toEqual([]);
    await render({ backend: app, text: "teh boat." });
    await pause();
    expect(marked()).toEqual(["teh"]);
  });
});
