// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FormattedEditor } from "../editor/FormattedEditor";
import { paragraphMarks, SEARCH_CURRENT_CLASS, SEARCH_MARK_CLASS } from "../editor/nameMarks";
import { PlainEditor } from "../editor/PlainEditor";
import type { ChapterEditorProps, EditorHandle } from "../editor/types";
import { NameMatcher } from "../names";
import { searchPattern } from "../search";

const matcher = new NameMatcher([{ text: "Elena", sheetId: "e", kind: "characters", ignoreCase: false }]);
const CHAPTER = "# One\n\nElena saw the *harbor* lights. The harbor slept.\n";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(
  kind: "formatted" | "plain",
  search: RegExp | null,
  onChange = vi.fn(),
  props: Partial<ChapterEditorProps> = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  const ref = createRef<EditorHandle>();
  const Editor = kind === "formatted" ? FormattedEditor : PlainEditor;
  await act(async () => created.render(createElement(Editor, { ref, markdown: CHAPTER, matcher, onChange, search, ...props })));
  await act(async () => {});
  return { ref, onChange };
}

const marked = () => [...(host?.querySelectorAll(`.${SEARCH_MARK_CLASS}`) ?? [])].map((el) => el.textContent);
const current = () => [...(host?.querySelectorAll(`.${SEARCH_CURRENT_CLASS}`) ?? [])].map((el) => el.textContent);

describe("search marks", () => {
  const pattern = searchPattern("harbor", { matchCase: false, wholeWord: false })!;

  it("mark every match of a paragraph, over names, as it reads in Markdown", () => {
    const line = "Elena saw the *harbor* lights. The harbor slept.";
    const marks = paragraphMarks(line, matcher, { search: pattern, markdown: true }).filter(
      (m) => m.attributes.class === SEARCH_MARK_CLASS,
    );
    expect(marks.map((m) => line.slice(m.from, m.to))).toEqual(["harbor", "harbor"]);
    const elena = paragraphMarks(line, matcher, { search: searchPattern("Elena saw", { matchCase: true, wholeWord: false }) });
    expect(elena.map((m) => line.slice(m.from, m.to))).toEqual(["Elena", "Elena saw"]);
  });

  it.each(["formatted", "plain"] as const)("show in the %s editor", async (kind) => {
    await mount(kind, pattern);
    expect(marked()).toEqual(["harbor", "harbor"]);
  });
});

describe("the shown result's mark", () => {
  it.each(["formatted", "plain"] as const)("goes when the search is turned off, in the %s editor", async (kind) => {
    const pattern = searchPattern("harbor", { matchCase: false, wholeWord: false })!;
    const { ref } = await mount(kind, pattern);
    const from = CHAPTER.lastIndexOf("harbor");
    await act(async () => ref.current!.selectMarkdown(from, from + "harbor".length));
    expect(host?.querySelectorAll(`.${SEARCH_CURRENT_CLASS}`).length).toBe(1);
    const Editor = kind === "formatted" ? FormattedEditor : PlainEditor;
    await act(async () => root?.render(createElement(Editor, { ref, markdown: CHAPTER, matcher, onChange: vi.fn(), search: null })));
    await act(async () => {});
    expect(host?.querySelectorAll(`.${SEARCH_CURRENT_CLASS}`).length).toBe(0);
    expect(marked()).toEqual([]);
  });
});

describe("the editors' search commands", () => {
  it.each(["formatted", "plain"] as const)("replace the whole text as one step in the %s editor", async (kind) => {
    const { ref, onChange } = await mount(kind, null);
    let done = false;
    await act(async () => {
      done = ref.current!.setMarkdown(CHAPTER.replaceAll("harbor", "port"));
    });
    expect(done).toBe(true);
    // The formatted editor hands its Markdown over without the final newline, which the project adds.
    expect(onChange.mock.lastCall?.[0].trimEnd()).toBe("# One\n\nElena saw the *port* lights. The port slept.");
  });

  // The plain editor selects Markdown offsets as they are; the formatted one maps them to its text.
  it("select a whole result in italics in the formatted editor", async () => {
    const { ref } = await mount("formatted", null);
    const from = CHAPTER.indexOf("harbor");
    await act(async () => ref.current!.selectMarkdown(from, from + "harbor".length));
    expect(ref.current!.getCaret()).toEqual({ block: 1, offset: "Elena saw the harbor".length });
  });

  it.each(["formatted", "plain"] as const)("select a range of the Markdown in the %s editor", async (kind) => {
    const { ref } = await mount(kind, null);
    const from = CHAPTER.lastIndexOf("harbor");
    await act(async () => ref.current!.selectMarkdown(from, from + "harbor".length));
    // The caret is where the match ends, in the paragraph after the title.
    const caret = ref.current!.getCaret();
    expect(caret).toEqual({ block: 1, offset: "Elena saw the harbor lights. The harbor".length });
  });

  it.each(["formatted", "plain"] as const)(
    "mark the result selected until the text changes in the %s editor",
    async (kind) => {
      const { ref } = await mount(kind, null);
      const from = CHAPTER.lastIndexOf("harbor");
      await act(async () => ref.current!.selectMarkdown(from, from + "harbor".length));
      expect(current()).toEqual(["harbor"]);
      await act(async () => {
        ref.current!.setMarkdown(CHAPTER.replace("slept", "woke"));
      });
      expect(current()).toEqual([]);
    },
  );

  it.each(["formatted", "plain"] as const)(
    "select a result given at mount in the %s editor, marked, without taking focus",
    async (kind) => {
      const from = CHAPTER.lastIndexOf("harbor");
      const { ref } = await mount(kind, null, vi.fn(), { initialSelection: { from, to: from + "harbor".length } });
      expect(current()).toEqual(["harbor"]);
      expect(ref.current!.getCaret()).toEqual({ block: 1, offset: "Elena saw the harbor lights. The harbor".length });
      expect(host!.contains(document.activeElement)).toBe(false);
    },
  );
});
