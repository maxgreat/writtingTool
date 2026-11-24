// @vitest-environment jsdom
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { markdownOffsetToPosition, positionToMarkdownOffset } from "../caret";
import { insertSceneBreak, nameHighlight, plainFormat, setLineStyle, toggleMarker } from "../editor/codemirror";
import { nameMarkAt, nameMarkAttributes, suggestionMarkAt, suggestionMarkAttributes } from "../editor/nameMarks";
import { NameHighlight, REFRESH_NAMES, nameHighlightKey, pmPositionToText, textToPmPosition } from "../editor/prosemirror";
import { chapterExtensions } from "../markdown";
import { NameMatcher } from "../names";

const matcher = new NameMatcher([
  { text: "Elena", sheetId: "elena", kind: "characters", ignoreCase: false },
  { text: "Harbor Inn", sheetId: "inn", kind: "places", ignoreCase: false },
]);

const chapter = "# The arrival\n\nElena reached the *Harbor Inn* at dusk.\n\n> A quote.\n\n***\n\nMorning came **grey** for Elena.\n";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function formatted(markdown: string, getMatcher = () => matcher): Editor {
  const editor = new Editor({
    extensions: [...chapterExtensions(), NameHighlight.configure({ getMatcher })],
    content: markdown,
    contentType: "markdown",
  });
  cleanups.push(() => editor.destroy());
  return editor;
}

function highlighted(editor: Editor): string[] {
  const set = nameHighlightKey.getState(editor.state)!;
  return set.find().map((d) => editor.state.doc.textBetween(d.from, d.to));
}

function plain(doc: string, anchor = 0, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor, head }, extensions: [markdownLanguage()] }),
    parent: document.body,
  });
  cleanups.push(() => view.destroy());
  return view;
}

describe("formatted editor name highlights", () => {
  it("highlights every name when the chapter loads", () => {
    expect(highlighted(formatted(chapter))).toEqual(["Elena", "Harbor Inn", "Elena"]);
  });

  it("re-scans the edited paragraph", () => {
    const editor = formatted(chapter);
    const end = editor.state.doc.child(1).nodeSize + editor.state.doc.child(0).nodeSize - 1;
    editor.commands.insertContentAt(end, " Then Elena slept.");
    expect(highlighted(editor)).toEqual(["Elena", "Harbor Inn", "Elena", "Elena"]);
  });

  it("drops a highlight when the name is broken", () => {
    const editor = formatted("Elena waits.\n");
    editor.commands.insertContentAt(3, "x");
    expect(highlighted(editor)).toEqual([]);
  });

  it("re-scans everything when told the matcher changed", () => {
    let current = new NameMatcher([]);
    const editor = formatted(chapter, () => current);
    expect(highlighted(editor)).toEqual([]);
    current = matcher;
    editor.view.dispatch(editor.state.tr.setMeta(nameHighlightKey, REFRESH_NAMES));
    expect(highlighted(editor)).toHaveLength(3);
  });
});

describe("ignored occurrences", () => {
  const ignoring = new NameMatcher(
    [
      { text: "Elena", sheetId: "elena", kind: "characters", ignoreCase: false },
      { text: "Harbor Inn", sheetId: "inn", kind: "places", ignoreCase: false },
    ],
    [{ name: "Elena", sentence: "Morning came grey for Elena." }],
  );

  function plainMarks(doc: string, m: NameMatcher) {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdownLanguage(), nameHighlight(() => m)] }),
      parent: document.body,
    });
    cleanups.push(() => view.destroy());
    return [...view.dom.querySelectorAll<HTMLElement>(".name-mark")].map((el) => nameMarkAt(el)!.occurrence);
  }

  function formattedMarks(editor: Editor) {
    const set = nameHighlightKey.getState(editor.state)!;
    return set.find().map((d) => {
      const attrs = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
      return { name: attrs["data-name"], sentence: attrs["data-sentence"] };
    });
  }

  it("gives each highlight the same occurrence in both editors, Markdown or not", () => {
    const expected = [
      { name: "Elena", sentence: "Elena reached the Harbor Inn at dusk." },
      { name: "Harbor Inn", sentence: "Elena reached the Harbor Inn at dusk." },
      { name: "Elena", sentence: "Morning came grey for Elena." },
    ];
    expect(formattedMarks(formatted(chapter))).toEqual(expected);
    expect(plainMarks(chapter, matcher)).toEqual(expected);
  });

  it("leaves out an ignored occurrence in both editors, and only that one", () => {
    expect(highlighted(formatted(chapter, () => ignoring))).toEqual(["Elena", "Harbor Inn"]);
    expect(plainMarks(chapter, ignoring).map((o) => o.name)).toEqual(["Elena", "Harbor Inn"]);
  });
});

describe("caret across modes", () => {
  it("lands on the same character in both editors", () => {
    const editor = formatted(chapter);
    for (const word of ["arrival", "Harbor", "dusk", "quote", "grey", "Elena."]) {
      const offset = chapter.lastIndexOf(word);
      const position = markdownOffsetToPosition(chapter, offset);
      const pm = textToPmPosition(editor.state.doc, position);
      expect(editor.state.doc.textBetween(pm, pm + word.length)).toBe(word);
      expect(positionToMarkdownOffset(chapter, pmPositionToText(editor.state.doc, pm))).toBe(offset);
    }
  });

  it.each([
    ["an empty paragraph from extra blank lines", "Elena arrived.\n\n\n\nThe ferryman waited.\n\nMorning came.\n"],
    ["two empty paragraphs", "Elena arrived.\n\n\n\n\n\nThe ferryman waited.\n\nMorning came.\n"],
    ["empty paragraphs written with &nbsp;", "Elena arrived.\n\n\n\n&nbsp;\n\nThe ferryman waited.\n\nMorning came.\n"],
    ["blank lines before the first paragraph", "\n\n\nThe ferryman waited.\n\nMorning came.\n"],
  ])("counts %s like the formatted editor", (_label, markdown) => {
    const editor = formatted(markdown);
    for (const word of ["ferryman", "Morning"]) {
      const offset = markdown.indexOf(word);
      const pm = textToPmPosition(editor.state.doc, markdownOffsetToPosition(markdown, offset));
      expect(editor.state.doc.textBetween(pm, pm + word.length)).toBe(word);
      expect(positionToMarkdownOffset(markdown, pmPositionToText(editor.state.doc, pm))).toBe(offset);
    }
  });

  it("maps the scene break as a block of its own", () => {
    const editor = formatted(chapter);
    const position = markdownOffsetToPosition(chapter, chapter.indexOf("***"));
    expect(position).toEqual({ block: 3, offset: 0 });
    const pm = textToPmPosition(editor.state.doc, position);
    expect(editor.state.doc.nodeAt(pm)?.type.name).toBe("horizontalRule");
  });
});

describe("plain editor commands", () => {
  it("adds and removes bold around a selection", () => {
    const view = plain("one two three", 4, 7);
    toggleMarker(view, 2);
    expect(view.state.doc.toString()).toBe("one **two** three");
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("two");
    toggleMarker(view, 2);
    expect(view.state.doc.toString()).toBe("one two three");
  });

  it("keeps bold when italic is added and removed", () => {
    const view = plain("**two**", 2, 5);
    toggleMarker(view, 1);
    expect(view.state.doc.toString()).toBe("***two***");
    toggleMarker(view, 1);
    expect(view.state.doc.toString()).toBe("**two**");
  });

  it("sets and clears line styles", () => {
    const view = plain("A line", 2);
    setLineStyle(view, "heading");
    expect(view.state.doc.toString()).toBe("## A line");
    setLineStyle(view, "quote");
    expect(view.state.doc.toString()).toBe("> A line");
    setLineStyle(view, "body");
    expect(view.state.doc.toString()).toBe("A line");
  });

  it.each([
    ["a whole two-paragraph quote to headings", 0, 9, "heading", "## A\n\n## B"],
    ["a whole two-paragraph quote to body text", 0, 9, "body", "A\n\nB"],
    ["the second paragraph of a quote to a heading", 8, 8, "heading", "> A\n\n## B"],
    ["the first paragraph of a quote to body text", 1, 1, "body", "A\n\n> B"],
  ] as const)("turns %s without leaving bare > lines", (_label, anchor, head, style, expected) => {
    const view = plain("> A\n>\n> B", anchor, head);
    setLineStyle(view, style);
    expect(view.state.doc.toString()).toBe(expected);
  });

  it.each([
    ["a heading already inside a quote", "> ## A\n>\n> B", 3],
    ["the bare > line itself", "> A\n>\n> B", 4],
  ])("leaves the quote whole when choosing Heading on %s", (_label, doc, caret) => {
    const view = plain(doc, caret);
    setLineStyle(view, "heading");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("turns a run of bare > lines next to a line that leaves the quote into one blank line", () => {
    const view = plain("> A\n>\n>\n> B", 1);
    setLineStyle(view, "body");
    expect(view.state.doc.toString()).toBe("A\n\n> B");
  });

  it.each([
    ["the second line of a quoted paragraph to body text", "> A\n> B", 6, "body", "A\nB"],
    ["the first line of a paragraph to a quote", "A\nB", 0, "quote", "> A\n> B"],
    ["a paragraph of two lines to a heading", "A\nB", 0, "heading", "## A B"],
    ["a quoted paragraph of two lines to a heading", "> A\n> B", 0, "heading", "## A B"],
    ["a line after a heading, which is not part of its paragraph", "## H\nA", 6, "quote", "## H\n\n> A"],
    ["a line right above a quote, to its own style", "She said:\n> Come with me.", 0, "body", "She said:\n> Come with me."],
    ["a line right above a quote, to a heading", "She said:\n> Come with me.", 0, "heading", "## She said:\n\n> Come with me."],
    ["a line right above a quote, to a quote", "She said:\n> Come with me.", 0, "quote", "> She said:\n\n> Come with me."],
    ["a quote right below a line, to body text", "A\n> B", 4, "body", "A\n\nB"],
    ["a quote line above a deeper quote, to body text", "> A\n> > B", 2, "body", "A\n\n> > B"],
    ["a lazily continued quoted paragraph, to body text", "> A\nB", 0, "body", "A\nB"],
    ["a scene break with the caret on it, to a heading", "Before.\n\n***", 12, "heading", "Before.\n\n***"],
    ["a quoted scene break, to body text, which lifts it out", "> ***", 3, "body", "***"],
  ] as const)("styles whole paragraphs: %s", (_label, doc, caret, style, expected) => {
    const view = plain(doc, caret);
    setLineStyle(view, style);
    expect(view.state.doc.toString()).toBe(expected);
  });

  it.each([
    ["two paragraphs into one quote", "A\n\nB", "quote", "> A\n>\n> B"],
    ["a quote and a paragraph into one quote", "> A\n\nB", "quote", "> A\n>\n> B"],
    ["paragraphs and a scene break into one quote", "A\n\n***\n\nB", "quote", "> A\n>\n> ***\n>\n> B"],
    ["a quoted passage with a scene break to body text", "> A\n>\n> ***\n>\n> B", "body", "A\n\n***\n\nB"],
    ["a quoted passage with a scene break to headings", "> A\n>\n> ***\n>\n> B", "heading", "## A\n\n***\n\n## B"],
    ["a heading and the line below it to body text", "## H\nA", "body", "H\n\nA"],
    ["a level-1 title and a paragraph to headings, both level 2", "# Title\n\nA", "heading", "## Title\n\n## A"],
    ["headings only, to a heading, which changes nothing", "# T\n\n## A", "heading", "# T\n\n## A"],
    ["a quoted heading and a quoted paragraph to headings", "> ## A\n>\n> B", "heading", "## A\n\n## B"],
    ["a quoted heading and a quoted paragraph to a quote, which changes nothing", "> ## A\n>\n> B", "quote", "> ## A\n>\n> B"],
    ["a quoted heading and a paragraph to a quote", "> ## A\n\nB", "quote", "> A\n>\n> B"],
    ["a nested quote and a paragraph to one quote", "> > a\n> >\n> > b\n\nc", "quote", "> a\n>\n> b\n>\n> c"],
  ] as const)("styles a selection of %s like the formatted editor", (_label, doc, style, expected) => {
    const view = plain(doc, 0, doc.length);
    setLineStyle(view, style);
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("takes quoted blocks out of their old quote before quoting them with others", () => {
    const doc = "> X\n>\n> A\n\nB";
    const view = plain(doc, doc.indexOf("A"), doc.length);
    setLineStyle(view, "quote");
    expect(view.state.doc.toString()).toBe("> X\n\n> A\n>\n> B");
  });

  it("styles the paragraphs around a scene break but not the break", () => {
    const doc = "A\n\n***\n\nB";
    const view = plain(doc, 0, doc.length);
    setLineStyle(view, "heading");
    expect(view.state.doc.toString()).toBe("## A\n\n***\n\n## B");
  });

  it("changes nothing in a read-only editor", () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "A line", extensions: [EditorState.readOnly.of(true)] }),
    });
    cleanups.push(() => view.destroy());
    expect(toggleMarker(view, 2)).toBe(false);
    setLineStyle(view, "heading");
    insertSceneBreak(view);
    expect(view.state.doc.toString()).toBe("A line");
  });

  it("inserts a scene break after the paragraph", () => {
    const view = plain("Before.", 3);
    insertSceneBreak(view);
    expect(view.state.doc.toString()).toBe("Before.\n\n***");
  });

  it("reports bold, italic and the line style at the caret", () => {
    const doc = "> Some **bold** and *it* here";
    expect(plainFormat(plain(doc, doc.indexOf("old")).state)).toEqual({ bold: true, italic: false, block: "quote" });
    expect(plainFormat(plain(doc, doc.indexOf("t* ")).state)).toEqual({ bold: false, italic: true, block: "quote" });
  });
});

describe("name marks", () => {
  it("round-trips sheet ids through the element", () => {
    const [match] = new NameMatcher([
      { text: "Marie", sheetId: "a|b.md", kind: "characters", ignoreCase: false },
      { text: "Marie", sheetId: "c.md", kind: "characters", ignoreCase: false },
    ]).find("Marie");
    const span = document.createElement("span");
    for (const [k, v] of Object.entries(nameMarkAttributes(match, "Marie came."))) span.setAttribute(k, v);
    expect(span.className).toBe("name-mark name-mark--characters name-mark--ambiguous");
    const hit = nameMarkAt(span.appendChild(document.createTextNode("Marie")).parentElement);
    expect(hit?.sheetIds).toEqual(["a|b.md", "c.md"]);
    expect(hit?.ambiguous).toBe(true);
    expect(hit?.occurrence).toEqual({ name: "Marie", sentence: "Marie came." });
  });

  it("ignores elements that are not names", () => {
    expect(nameMarkAt(document.createElement("p"))).toBeNull();
    expect(nameMarkAt(null)).toBeNull();
  });
});

describe("possible names in the text", () => {
  const suggestions = new Set(["Mara"]);
  const text = "# Mara Falls\n\nThen Mara met Elena. Mara left.\n";

  function plainSuggestions(doc: string) {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [markdownLanguage(), nameHighlight(() => matcher, () => suggestions)] }),
      parent: document.body,
    });
    cleanups.push(() => view.destroy());
    return [...view.dom.querySelectorAll<HTMLElement>(".possible-name")].map((el) => suggestionMarkAt(el)!.word);
  }

  it("marks the same words in both editors: not in headings, not at a sentence start", () => {
    const editor = new Editor({
      extensions: [...chapterExtensions(), NameHighlight.configure({ getMatcher: () => matcher, getSuggestions: () => suggestions })],
      content: text,
      contentType: "markdown",
    });
    cleanups.push(() => editor.destroy());
    const marked = nameHighlightKey
      .getState(editor.state)!
      .find()
      .filter((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs.class === "possible-name")
      .map((d) => editor.state.doc.textBetween(d.from, d.to));
    expect(marked).toEqual(["Mara"]);
    expect(plainSuggestions(text)).toEqual(["Mara"]);
  });

  it("round-trips the word through the element", () => {
    const span = document.createElement("span");
    for (const [k, v] of Object.entries(suggestionMarkAttributes("Mara"))) span.setAttribute(k, v);
    expect(suggestionMarkAt(span.appendChild(document.createTextNode("Mara")).parentElement)?.word).toBe("Mara");
    expect(suggestionMarkAt(document.createElement("p"))).toBeNull();
  });
});
