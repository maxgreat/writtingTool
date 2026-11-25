// @vitest-environment jsdom
import { history as cmHistory, undo as cmUndo } from "@codemirror/commands";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Editor, Extension } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { typingAidsHandler, typingAidsPlugin, type TypingAids } from "../editor/typingAids";
import { chapterExtensions } from "../markdown";
import { DEFAULT_REPLACEMENTS } from "../typography";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

let aids: TypingAids | null = { rules: "en", replacements: DEFAULT_REPLACEMENTS };

/* The formatted editor ----------------------------------------------------------------- */

const Aids = Extension.create({
  name: "typingAidsTest",
  addProseMirrorPlugins: () => [typingAidsPlugin(() => aids)],
});

function formatted(markdown: string): Editor {
  const editor = new Editor({ extensions: [...chapterExtensions(), Aids], content: markdown, contentType: "markdown" });
  cleanups.push(() => editor.destroy());
  editor.commands.focus("end");
  return editor;
}

/** Types each character as the keyboard does: the view's handlers first, else the text goes in as typed. */
function typeFormatted(editor: Editor, keys: string) {
  for (const key of keys) {
    const { view } = editor;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, key, () => view.state.tr));
    if (!handled) view.dispatch(view.state.tr.insertText(key, from, to));
  }
}

/* The plain editor ----------------------------------------------------------------------- */

function plain(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [markdownLanguage(), cmHistory(), typingAidsHandler(() => aids)],
    }),
    parent: document.body,
  });
  cleanups.push(() => view.destroy());
  return view;
}

function typePlain(view: EditorView, keys: string) {
  for (const key of keys) {
    const { from, to } = view.state.selection.main;
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view, from, to, key, () => view.state.update({ changes: { from, to, insert: key } })));
    if (!handled) view.dispatch({ changes: { from, to, insert: key }, selection: { anchor: from + key.length } });
  }
}

describe("typing aids", () => {
  it("curl quotes and make dashes in the formatted editor, each undone on its own", () => {
    aids = { rules: "en", replacements: DEFAULT_REPLACEMENTS };
    const editor = formatted("# One\n\nShe said");
    typeFormatted(editor, ` "Wait--teh boat."`);
    expect(editor.getMarkdown()).toBe("# One\n\nShe said “Wait—the boat.”");
    editor.commands.undo();
    expect(editor.getMarkdown()).toBe(`# One\n\nShe said “Wait—the boat."`);
  });

  it("do the same in the plain editor", () => {
    aids = { rules: "fr", replacements: [] };
    const view = plain("# Un\n\nIl dit");
    typePlain(view, ` "Quoi?"`);
    expect(view.state.doc.toString()).toBe("# Un\n\nIl dit «\u00a0Quoi\u202f?\u00a0»");
    cmUndo(view);
    expect(view.state.doc.toString()).toBe(`# Un\n\nIl dit «\u00a0Quoi\u202f?"`);
  });

  it("keep the replaced word's formatting, and the typed character's own", () => {
    aids = { rules: "en", replacements: DEFAULT_REPLACEMENTS };
    /** The paragraph's runs, as text and whether each is in italics. */
    type Json = { content?: { content?: { text?: string; marks?: { type: string }[] }[] }[] };
    const runs = (editor: Editor) =>
      ((editor.getJSON() as Json).content?.[0]?.content ?? []).map((n) => [
        n.text,
        (n.marks ?? []).some((m) => m.type === "italic"),
      ]);

    // "teh" in italics, italics turned off, then a space: the space stays plain.
    const plainAfter = formatted("*teh*");
    plainAfter.commands.unsetItalic();
    typeFormatted(plainAfter, " ");
    expect(runs(plainAfter)).toEqual([
      ["the", true],
      [" ", false],
    ]);

    // "I told " plain, then "u" in italics becoming "you": the added letters are in italics too.
    aids = { rules: "en", replacements: [{ from: "u", to: "you" }] };
    const added = formatted("I told *u*");
    added.commands.unsetItalic();
    typeFormatted(added, " ");
    expect(runs(added)).toEqual([
      ["I told ", false],
      ["you", true],
      [" ", false],
    ]);
    aids = { rules: "en", replacements: DEFAULT_REPLACEMENTS };

    // A plain "teh", italics turned on, then a closing quote: the word stays plain, the quote is in italics.
    const italicAfter = formatted('"teh');
    italicAfter.commands.setItalic();
    typeFormatted(italicAfter, '"');
    expect(runs(italicAfter)).toEqual([
      ['"the', false],
      ["”", true],
    ]);
  });

  it("do nothing when they are off", () => {
    aids = null;
    const editor = formatted("Text");
    typeFormatted(editor, ` "teh"`);
    expect(editor.getMarkdown()).toBe(`Text "teh"`);
    const view = plain("Text");
    typePlain(view, ` "teh"`);
    expect(view.state.doc.toString()).toBe(`Text "teh"`);
  });
});
