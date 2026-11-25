// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, GrammarProblem, GrammarServer } from "../backend";
import { GRAMMAR_DELAY_MS, MAX_BATCH_BYTES, SERVER_DELAY_MS, useGrammar, type Grammar } from "../useGrammar";

/** Flags "have" after "She" in each paragraph. */
const checkGrammar = vi.fn(async (_language: string, paragraphs: string[], _server: GrammarServer | null) =>
  paragraphs.map((p): GrammarProblem[] => {
    const at = p.indexOf("She have");
    return at === -1 ? [] : [{ from: at + 4, to: at + 8, message: "Agreement", kind: "Agreement", fixes: ["has"] }];
  }),
);
const app = { checkGrammar } as unknown as Backend;

let root: Root;
let result: Grammar;

interface Props {
  backend?: Backend | null;
  text: string | null;
  enabled?: boolean;
  server?: GrammarServer | null;
}

function Probe({ backend = app, text, enabled = true, server = null }: Props) {
  result = useGrammar(backend, "en-GB", text, enabled, server);
  return null;
}

async function render(props: Props) {
  await act(async () => root.render(createElement(Probe, props)));
}

async function pause(ms = GRAMMAR_DELAY_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  checkGrammar.mockClear();
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const CHAPTER = "# She have a title\n\nShe have a *small* boat.\n\nAll is well.\n";

describe("useGrammar", () => {
  it("checks each paragraph as it reads, headings left out, and keys problems by it", async () => {
    await render({ text: CHAPTER });
    await act(async () => {});
    expect(checkGrammar).toHaveBeenCalledWith("en-GB", ["She have a small boat.", "All is well."], null);
    expect([...result.problems.keys()]).toEqual(["She have a small boat."]);
    expect(result.problems.get("She have a small boat.")?.[0].fixes).toEqual(["has"]);
  });

  it("asks about a changed paragraph once typing has stopped, and only about it", async () => {
    await render({ text: CHAPTER });
    await act(async () => {});
    await render({ text: CHAPTER.replace("All is well.", "All is well. She have it.") });
    await act(async () => {});
    expect(checkGrammar).toHaveBeenCalledTimes(1);
    await pause();
    expect(checkGrammar).toHaveBeenCalledTimes(2);
    expect(checkGrammar.mock.calls[1][1]).toEqual(["All is well. She have it."]);
    expect(result.problems.size).toBe(2);
  });

  it("keeps the same map while the problems don't change", async () => {
    await render({ text: CHAPTER });
    await act(async () => {});
    const first = result.problems;
    await render({ text: `${CHAPTER}\nFine.\n` });
    await pause();
    expect(result.problems).toBe(first);
  });

  it("waits longer for a server, and says why it failed", async () => {
    const server: GrammarServer = { mode: "public" };
    checkGrammar.mockRejectedValueOnce(new Error("LanguageTool asks to slow down."));
    await render({ text: "Hello.", server });
    await act(async () => {});
    expect(result.error).toBe("LanguageTool asks to slow down.");
    await render({ text: "Hello there.", server });
    await pause(GRAMMAR_DELAY_MS);
    expect(checkGrammar).toHaveBeenCalledTimes(1);
    await pause(SERVER_DELAY_MS);
    expect(checkGrammar).toHaveBeenCalledTimes(2);
    expect(result.error).toBeNull();
  });

  it("batches by UTF-8 size for a server, and never sends a paragraph too long for one", async () => {
    const server: GrammarServer = { mode: "public" };
    // Cyrillic takes two bytes a letter: 5000 letters are 10 KB, so two paragraphs can't share a request.
    const one = "Я".repeat(5000);
    const two = "Ж".repeat(5000);
    const huge = "Щ".repeat(9000);
    await render({ text: `${one}\n\n${huge}\n\n${two}\n`, server });
    await act(async () => {});
    await act(async () => {});
    expect(checkGrammar.mock.calls.map(([, paragraphs]) => paragraphs.map((p) => p[0]))).toEqual([["Я"], ["Ж"]]);
    for (const [, paragraphs] of checkGrammar.mock.calls) {
      expect(new TextEncoder().encode(paragraphs.join("\n\n")).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  it("marks nothing when off, or without the core", async () => {
    await render({ text: CHAPTER, enabled: false });
    await act(async () => {});
    expect(checkGrammar).not.toHaveBeenCalled();
    expect(result.problems.size).toBe(0);
    await render({ backend: {} as Backend, text: CHAPTER });
    await act(async () => {});
    expect(result.problems.size).toBe(0);
  });
});
