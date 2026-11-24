import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { TextPosition } from "../caret";
import { NameMatcher } from "../names";
import { nameFromSelection, wordAround } from "../possibleNames";
import { paragraphMarks } from "./nameMarks";

export const nameHighlightKey = new PluginKey<DecorationSet>("nameHighlight");
/** Transaction meta that makes the plugin re-scan the whole chapter (new matcher or possible names). */
export const REFRESH_NAMES = "refresh";

const EMPTY_MATCHER = new NameMatcher([]);
const NO_WORDS: ReadonlySet<string> = new Set();

/** What the highlights come from, read at each scan. */
interface Sources {
  getMatcher: () => NameMatcher;
  /** Possible names to mark (see ChapterEditorProps.suggestions). */
  getSuggestions: () => ReadonlySet<string>;
}
/** Leaf inline nodes count as one character, as they take one position. */
const LEAF_TEXT = "￼";

/** A text block's text, one character per position, so offsets into it are offsets into the block. */
export function blockText(block: PMNode): string {
  return block.textBetween(0, block.content.size, undefined, LEAF_TEXT);
}

function decorateBlock(sources: Sources, block: PMNode, pos: number): Decoration[] {
  const text = blockText(block);
  const heading = block.type.name === "heading";
  return paragraphMarks(text, sources.getMatcher(), sources.getSuggestions(), heading).map((m) =>
    Decoration.inline(pos + 1 + m.from, pos + 1 + m.to, m.attributes),
  );
}

function decorateAll(sources: Sources, doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decorations.push(...decorateBlock(sources, node, pos));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Highlights names, and marks possible names, in the formatted editor.
 * After an edit only the paragraphs the edit touched are scanned again; the
 * rest of the marks are mapped through the change.
 */
function nameHighlightPlugin(sources: Sources): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: nameHighlightKey,
    state: {
      init: (_config, state) => decorateAll(sources, state.doc),
      apply(tr, previous) {
        if (tr.getMeta(nameHighlightKey) === REFRESH_NAMES) return decorateAll(sources, tr.doc);
        if (!tr.docChanged) return previous;

        const doc = tr.doc;
        let set = previous.map(tr.mapping, doc);
        const changed: [number, number][] = [];
        tr.mapping.maps.forEach((map, index) => {
          const rest = tr.mapping.slice(index + 1);
          map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
            changed.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
          });
        });

        const done = new Set<number>();
        for (const [from, to] of changed) {
          // One position of slack so an edit at a paragraph edge still
          // reaches that paragraph.
          const start = Math.max(0, from - 1);
          const end = Math.min(doc.content.size, to + 1);
          doc.nodesBetween(start, end, (node, pos) => {
            if (!node.isTextblock) return true;
            if (!done.has(pos)) {
              done.add(pos);
              set = set.remove(set.find(pos, pos + node.nodeSize));
              set = set.add(doc, decorateBlock(sources, node, pos));
            }
            return false;
          });
        }
        return set;
      },
    },
    props: {
      decorations: (state) => nameHighlightKey.getState(state),
    },
  });
}

export const NameHighlight = Extension.create<Sources>({
  name: "nameHighlight",
  addOptions() {
    return { getMatcher: () => EMPTY_MATCHER, getSuggestions: () => NO_WORDS };
  },
  addProseMirrorPlugins() {
    return [nameHighlightPlugin(this.options)];
  },
});

/** Text blocks and scene breaks in document order: the blocks of a TextPosition. */
function blocks(doc: PMNode): { pos: number; node: PMNode }[] {
  const list: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock || node.type.name === "horizontalRule") {
      list.push({ pos, node });
      return false;
    }
    return true;
  });
  return list;
}

export function pmPositionToText(doc: PMNode, pos: number): TextPosition {
  const list = blocks(doc);
  let index = -1;
  for (let i = 0; i < list.length && list[i].pos <= pos; i++) index = i;
  if (index < 0) return { block: 0, offset: 0 };
  const { pos: blockPos, node } = list[index];
  if (!node.isTextblock) return { block: index, offset: 0 };
  const start = blockPos + 1;
  const end = start + node.content.size;
  const clamped = Math.max(start, Math.min(pos, end));
  return { block: index, offset: doc.textBetween(start, clamped, undefined, LEAF_TEXT).length };
}

/** A document position for a TextPosition; pass it through Selection.near. */
export function textToPmPosition(doc: PMNode, position: TextPosition): number {
  const list = blocks(doc);
  if (list.length === 0) return 0;
  const { pos, node } = list[Math.max(0, Math.min(position.block, list.length - 1))];
  if (!node.isTextblock) return pos;
  return pos + 1 + Math.max(0, Math.min(position.offset, node.content.size));
}

/** The word at a point on screen (client coordinates), as a name would be written; null if none. */
export function wordAtPoint(view: EditorView, x: number, y: number): string | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.pos);
  if (!$pos.parent.isTextblock) return null;
  return wordAround(blockText($pos.parent), $pos.parentOffset);
}

/** The selection as a name to add; empty when nothing is selected or it spans blocks. */
export function selectedNameIn(state: EditorState): string {
  const { from, to, $from, $to } = state.selection;
  if (from === to || !$from.sameParent($to)) return "";
  return nameFromSelection(state.doc.textBetween(from, to, " "));
}

/** Whether a point on screen (client coordinates) is on the selected text. */
export function selectionContainsPoint(view: EditorView, x: number, y: number): boolean {
  const { from, to, empty } = view.state.selection;
  if (empty) return false;
  const hit = view.posAtCoords({ left: x, top: y });
  return hit !== null && hit.pos >= from && hit.pos <= to;
}
