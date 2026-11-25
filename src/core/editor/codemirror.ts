import { HighlightStyle, syntaxTree } from "@codemirror/language";
import { EditorSelection, RangeSetBuilder, StateEffect, type EditorState, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { NameMatcher } from "../names";
import { nameFromSelection, wordAround } from "../possibleNames";
import { wordToCheckAt } from "../spelling";
import { paragraphMarks, type MarkSources } from "./nameMarks";
import type { BlockStyle, EditorWord, FormatState } from "./types";

/**
 * CSS classes for the plain mode's Markdown: `md-mark` is every marker (`#`,
 * `>`, `*`), so it can be dimmed; the others style the text inside.
 */
export const markdownClasses = HighlightStyle.define([
  { tag: tags.processingInstruction, class: "md-mark" },
  { tag: tags.heading, class: "md-heading" },
  { tag: tags.emphasis, class: "md-italic" },
  { tag: tags.strong, class: "md-bold" },
  { tag: tags.quote, class: "md-quote" },
  { tag: tags.contentSeparator, class: "md-scene-break" },
]);

/** Dispatch this effect to re-scan names after the matcher, the possible names or the misspelled words changed. */
export const refreshNames = StateEffect.define<null>();

function decorateVisible(view: EditorView, matcher: NameMatcher, sources: MarkSources): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.number > lastLine) {
        lastLine = line.number;
        for (const m of paragraphMarks(line.text, matcher, sources)) {
          builder.add(line.from + m.from, line.from + m.to, Decoration.mark({ attributes: m.attributes }));
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const NO_MARKS: MarkSources = {};

/**
 * Highlights names, and marks possible names and misspelled words
 * (`getSources`, see ChapterEditorProps.suggestions and misspelled), in the
 * lines on screen; each line is one paragraph.
 */
export function nameHighlight(getMatcher: () => NameMatcher, getSources: () => MarkSources = () => NO_MARKS) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorateVisible(view, getMatcher(), getSources());
      }
      update(update: ViewUpdate) {
        const refresh = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshNames)));
        if (refresh || update.docChanged || update.viewportChanged) {
          this.decorations = decorateVisible(update.view, getMatcher(), getSources());
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function starsBefore(doc: Text, pos: number): number {
  let n = 0;
  while (pos - n > 0 && doc.sliceString(pos - n - 1, pos - n) === "*") n++;
  return n;
}

function starsAfter(doc: Text, pos: number): number {
  let n = 0;
  while (pos + n < doc.length && doc.sliceString(pos + n, pos + n + 1) === "*") n++;
  return n;
}

/** Star counts around a selection that mean italic (1) or bold (2) is on; 3 is both. */
const ACTIVE_STARS: Record<1 | 2, number[]> = { 1: [1, 3], 2: [2, 3] };

/**
 * Bold (`size` 2) or italic (`size` 1) in plain mode: removes the stars
 * around each selection if that style is on there, otherwise adds them.
 */
export function toggleMarker(view: EditorView, size: 1 | 2): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const marker = "*".repeat(size);
  const spec = state.changeByRange((range) => {
    const stars = Math.min(starsBefore(state.doc, range.from), starsAfter(state.doc, range.to));
    if (ACTIVE_STARS[size].includes(stars)) {
      return {
        changes: [
          { from: range.from - size, to: range.from },
          { from: range.to, to: range.to + size },
        ],
        range: EditorSelection.range(range.anchor - size, range.head - size),
      };
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.anchor + size, range.head + size),
    };
  });
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input.format" }));
  return true;
}

const BLOCK_PREFIX = /^\s*(?:>\s?)*(?:#{1,6}\s+)?/u;
const QUOTE_PREFIX = /^\s*(?:>\s?)*/u;
const QUOTE_SEPARATOR = /^\s*(?:>\s?)+\s*$/u;
const HEADING_LINE = /^\s*(?:>\s?)*#{1,6}(?:\s|$)/u;
const SCENE_BREAK_LINE = /^\s*(?:>\s?)*(?:\*\s*){3,}$/u;

interface StyledBlock {
  first: number;
  last: number;
  quoted: boolean;
  changed: boolean;
  insert: string;
}

/**
 * Sets the style of every block the main selection touches, with the result
 * the formatted editor's commands would write (FormattedEditor.setBlockStyle).
 *
 * Blocks: in Markdown a paragraph is a run of lines with no blank line
 * between them; it ends at a bare `>` separator, at a heading or scene break
 * (one-line blocks), and where a line is quoted more deeply than the one
 * above (a `>` starts a new block; a less quoted line continues the paragraph
 * lazily).
 *
 * Styles: Heading does nothing when every selected block is already a
 * heading, and Quote nothing when every selected block is already quoted.
 * Otherwise every selected block is first cleared (taken out of its quote,
 * headings made paragraphs; a scene break stays a scene break), then:
 * - Body leaves them so.
 * - Heading makes each paragraph a level-2 heading; a heading is one line, so
 *   a paragraph's lines are joined with spaces, as Markdown shows them.
 * - Quote puts all of them, scene breaks included, in one quote, with a bare
 *   `>` line between blocks.
 *
 * Separation: between selected blocks that are not in one quote, separators
 * become a blank line, and a blank line goes between blocks that touch. Next
 * to the selection, separators of the quote the blocks were taken out of
 * become a blank line, and a blank line goes between the blocks and text
 * right above or below.
 */
export function setLineStyle(view: EditorView, style: BlockStyle): void {
  const { state } = view;
  if (state.readOnly) return;
  const { doc } = state;
  const { from, to } = state.selection.main;
  const text = (n: number) => doc.line(n).text;
  const exists = (n: number) => n >= 1 && n <= doc.lines;
  const isText = (n: number) => exists(n) && text(n).trim() !== "" && !QUOTE_SEPARATOR.test(text(n));
  const isSeparator = (n: number) => exists(n) && QUOTE_SEPARATOR.test(text(n));
  const isSingle = (n: number) => HEADING_LINE.test(text(n)) || SCENE_BREAK_LINE.test(text(n));
  const inParagraph = (n: number) => isText(n) && !isSingle(n);
  const depth = (n: number) => (QUOTE_PREFIX.exec(text(n))![0].match(/>/gu) ?? []).length;
  /** Line n carries on the paragraph of line n - 1. */
  const continues = (n: number) => inParagraph(n) && inParagraph(n - 1) && depth(n) <= depth(n - 1);

  const found: { first: number; last: number; heading: boolean; sceneBreak: boolean; quoted: boolean }[] = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; ) {
    if (!isText(n)) {
      n++;
      continue;
    }
    let first = n;
    let last = n;
    if (inParagraph(n)) {
      while (continues(first)) first--;
      while (continues(last + 1)) last++;
    }
    found.push({
      first,
      last,
      heading: HEADING_LINE.test(text(n)),
      sceneBreak: SCENE_BREAK_LINE.test(text(n)),
      quoted: depth(first) > 0,
    });
    n = last + 1;
  }
  const active =
    (style === "heading" && found.every((b) => b.heading)) || (style === "quote" && found.every((b) => b.quoted));
  if (found.length === 0 || active) {
    view.focus();
    return;
  }

  const blocks: StyledBlock[] = found.map((b) => {
    const lines = Array.from({ length: b.last - b.first + 1 }, (_, i) => text(b.first + i));
    // Cleared: no quote marker, no heading marker.
    const plainLines = lines.map((line) => line.slice(BLOCK_PREFIX.exec(line)![0].length));
    let out: string[];
    if (b.sceneBreak) out = [style === "quote" ? `> ${plainLines[0]}` : plainLines[0]];
    else if (style === "heading") out = [`## ${plainLines.map((line) => line.trim()).join(" ")}`];
    else if (style === "quote") out = plainLines.map((line) => `> ${line}`);
    else out = plainLines;
    const insert = out.join("\n");
    return { first: b.first, last: b.last, quoted: b.quoted, changed: insert !== lines.join("\n"), insert };
  });
  if (!blocks.some((b) => b.changed)) {
    view.focus();
    return;
  }

  const changes: { from: number; to: number; insert: string }[] = [];
  for (const block of blocks) {
    if (block.changed) changes.push({ from: doc.line(block.first).from, to: doc.line(block.last).to, insert: block.insert });
  }
  // Between two selected blocks: one quote, or plain separation.
  for (let i = 0; i + 1 < blocks.length; i++) {
    const [a, b] = [blocks[i], blocks[i + 1]];
    const between = Array.from({ length: b.first - a.last - 1 }, (_, k) => a.last + 1 + k);
    const gap = { from: doc.line(a.last).to, to: doc.line(b.first).from };
    if (style === "quote") {
      // Keep an existing bare ">" line; anything else (blank lines, "> >" from a
      // nested quote the blocks were taken out of) becomes one.
      if (!(between.length === 1 && text(between[0]).trim() === ">")) changes.push({ ...gap, insert: "\n>\n" });
    } else if (between.length === 0 || between.some(isSeparator)) {
      changes.push({ ...gap, insert: "\n\n" });
    }
  }
  // Next to the selection: the blocks are out of their old quote and stand alone.
  const blankSeparators = (start: number, step: 1 | -1) => {
    let end = start;
    while (isSeparator(end)) end += step;
    const [lo, hi] = step === 1 ? [start, end - 1] : [end + 1, start];
    changes.push({ from: doc.line(lo).from, to: doc.line(hi).to, insert: "" });
  };
  const head = blocks[0];
  const tail = blocks[blocks.length - 1];
  if (isSeparator(head.first - 1)) {
    if (head.quoted) blankSeparators(head.first - 1, -1);
  } else if (isText(head.first - 1)) {
    changes.push({ from: doc.line(head.first - 1).to, to: doc.line(head.first - 1).to, insert: "\n" });
  }
  if (isSeparator(tail.last + 1)) {
    if (tail.quoted) blankSeparators(tail.last + 1, 1);
  } else if (isText(tail.last + 1)) {
    changes.push({ from: doc.line(tail.last + 1).from, to: doc.line(tail.last + 1).from, insert: "\n" });
  }
  changes.sort((a, b) => a.from - b.from);
  view.dispatch({ changes, userEvent: "input.format" });
  view.focus();
}

/** Adds a scene break after the caret's paragraph and puts the caret after it. */
export function insertSceneBreak(view: EditorView): void {
  if (view.state.readOnly) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const insert = "\n\n***";
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
}

export function plainFormat(state: EditorState): FormatState {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head).text;
  const block: BlockStyle = /^\s*>/u.test(line) ? "quote" : /^\s*#{1,6}\s/u.test(line) ? "heading" : "body";
  let bold = false;
  let italic = false;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(head, -1);
  while (node) {
    if (node.name === "StrongEmphasis") bold = true;
    else if (node.name === "Emphasis") italic = true;
    node = node.parent;
  }
  return { bold, italic, block };
}

/** The word at a point on screen (client coordinates), as a name would be written; null if none. */
export function plainWordAt(view: EditorView, x: number, y: number): string | null {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  return wordAround(line.text, pos - line.from);
}

/** The word the spelling check reads at a point on screen, with its offsets in the Markdown; null if none. */
export function plainSpellingWordAt(view: EditorView, x: number, y: number): EditorWord | null {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  const found = wordToCheckAt(line.text, pos - line.from);
  return found ? { word: found.word, from: line.from + found.from, to: line.from + found.to } : null;
}

/** Replaces a word found by plainSpellingWordAt, if the text there is still that word. */
export function plainReplaceWord(view: EditorView, word: EditorWord, text: string): boolean {
  const { doc } = view.state;
  if (word.to > doc.length || doc.sliceString(word.from, word.to) !== word.word) return false;
  view.dispatch({
    changes: { from: word.from, to: word.to, insert: text },
    selection: { anchor: word.from + text.length },
    userEvent: "input.replace",
    scrollIntoView: true,
  });
  return true;
}

/** The main selection as a name to add; empty when nothing is selected or it spans lines (paragraphs). */
export function plainSelectedName(state: EditorState): string {
  const { from, to, empty } = state.selection.main;
  if (empty || state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return "";
  return nameFromSelection(state.sliceDoc(from, to));
}

/** Whether a point on screen (client coordinates) is on the main selection. */
export function plainSelectionContains(view: EditorView, x: number, y: number): boolean {
  const { from, to, empty } = view.state.selection.main;
  if (empty) return false;
  const pos = view.posAtCoords({ x, y });
  return pos != null && pos >= from && pos <= to;
}
