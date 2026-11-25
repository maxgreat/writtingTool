// @vitest-environment jsdom
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import type { GrammarProblem } from "../backend";
import { nameHighlight, plainMarkRange, plainReplaceWord } from "../editor/codemirror";
import { GRAMMAR_MARK_CLASS, grammarMarkAt, paragraphMarks } from "../editor/nameMarks";
import { markRangeIn, NameHighlight, replaceWordIn } from "../editor/prosemirror";
import { chapterExtensions } from "../markdown";
import { NameMatcher } from "../names";

const matcher = new NameMatcher([{ text: "Elena", sheetId: "e", kind: "characters", ignoreCase: false }]);
const problem = (from: number, to: number, fixes = ["has"]): GrammarProblem => ({
  from,
  to,
  message: "The verb must agree with its subject.",
  kind: "Agreement",
  fixes,
});

/** "She have a *small* boat." as it reads: "She have a small boat." */
const READS = "She have a small boat.";
const grammar = new Map([[READS, [problem(4, 8)]]]);

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

describe("grammar marks", () => {
  it("mark a paragraph's problems where they are in the formatted editor's text", () => {
    const [mark] = paragraphMarks(READS, matcher, { grammar });
    expect(READS.slice(mark.from, mark.to)).toBe("have");
    expect(mark.attributes.class).toBe(GRAMMAR_MARK_CLASS);
    expect(mark.attributes["data-fixes"]).toBe('["has"]');
  });

  it("map back into a line of Markdown in the plain editor", () => {
    const line = "She have a *small* boat.";
    const marks = paragraphMarks(line, matcher, { grammar: new Map([[READS, [problem(4, 8), problem(11, 16)]]]), markdown: true });
    expect(marks.map((m) => line.slice(m.from, m.to))).toEqual(["have", "small"]);
  });

  it("offer no fix for a problem across a Markdown marker, which a fix would take away", () => {
    const line = "He could *of* gone.";
    const reads = "He could of gone.";
    const [mark] = paragraphMarks(line, matcher, {
      grammar: new Map([[reads, [problem(3, 11, ["could have"])]]]),
      markdown: true,
    });
    expect(line.slice(mark.from, mark.to)).toBe("could *of");
    expect(mark.attributes["data-text"]).toBe("could of");
    expect(mark.attributes["data-fixes"]).toBe("[]");
  });

  it("leave names and misspelled words their own marks, and skip headings", () => {
    const text = "Elena have a bote.";
    const marks = paragraphMarks(text, matcher, {
      misspelled: new Set(["bote"]),
      grammar: new Map([[text, [problem(0, 10), problem(13, 17), problem(6, 10)]]]),
    });
    expect(marks.map((m) => [text.slice(m.from, m.to), m.attributes.class.split(" ")[0]])).toEqual([
      ["Elena", "name-mark"],
      ["have", GRAMMAR_MARK_CLASS],
      ["bote", "spelling-mark"],
    ]);
    expect(paragraphMarks("She have", matcher, { grammar: new Map([["She have", [problem(4, 8)]]]), heading: true })).toEqual([]);
  });

  it("let the formatted editor find a mark's text again and fix it", () => {
    const editor = new Editor({
      extensions: [...chapterExtensions(), NameHighlight.configure({ getMatcher: () => matcher, getGrammar: () => grammar })],
      content: "# One\n\nShe have a *small* boat.",
      contentType: "markdown",
      element: document.body.appendChild(document.createElement("div")),
    });
    cleanups.push(() => editor.destroy());
    const element = editor.view.dom.querySelector(`.${GRAMMAR_MARK_CLASS}`)!;
    expect(grammarMarkAt(element)).toMatchObject({ text: "have", fixes: ["has"] });
    const range = markRangeIn(editor.view, element)!;
    expect(range.word).toBe("have");
    expect(replaceWordIn(editor.view, range, "has")).toBe(true);
    expect(editor.getMarkdown()).toBe("# One\n\nShe has a *small* boat.");
  });

  it("let the plain editor find a mark's text again and fix it", () => {
    const doc = "# One\n\nShe have a *small* boat.";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdownLanguage(), nameHighlight(() => matcher, () => ({ grammar, markdown: true }))],
      }),
      parent: document.body,
    });
    cleanups.push(() => view.destroy());
    const element = view.contentDOM.querySelector(`.${GRAMMAR_MARK_CLASS}`)!;
    const range = plainMarkRange(view, element)!;
    expect(range.word).toBe("have");
    expect(plainReplaceWord(view, range, "has")).toBe(true);
    expect(view.state.doc.toString()).toBe("# One\n\nShe has a *small* boat.");
  });

  it("let the plain editor write a fix as Markdown, and refuse a range across markers", () => {
    const doc = "He could *of* gone. She have it.";
    const reads = "He could of gone. She have it.";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          markdownLanguage(),
          nameHighlight(
            () => matcher,
            () => ({ grammar: new Map([[reads, [problem(3, 11, ["could have"]), problem(22, 26, ["*has*"])]]]), markdown: true }),
          ),
        ],
      }),
      parent: document.body,
    });
    cleanups.push(() => view.destroy());
    const [across, have] = view.contentDOM.querySelectorAll(`.${GRAMMAR_MARK_CLASS}`);
    expect(plainMarkRange(view, across)).toBeNull();
    const range = plainMarkRange(view, have)!;
    expect(plainReplaceWord(view, range, "*has*")).toBe(true);
    expect(view.state.doc.toString()).toBe("He could *of* gone. She \\*has\\* it.");
  });
});
