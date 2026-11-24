import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { TextPosition } from "../caret";
import { NameMatcher } from "../names";
import { sentenceKeyFinder } from "../sentences";
import { nameMarkAttributes } from "./nameMarks";

export const nameHighlightKey = new PluginKey<DecorationSet>("nameHighlight");
/** Transaction meta that makes the plugin re-scan the whole chapter (new matcher). */
export const REFRESH_NAMES = "refresh";

const EMPTY_MATCHER = new NameMatcher([]);
/** Leaf inline nodes count as one character, as they take one position. */
const LEAF_TEXT = "￼";

function decorateBlock(matcher: NameMatcher, block: PMNode, pos: number): Decoration[] {
  const text = block.textBetween(0, block.content.size, undefined, LEAF_TEXT);
  const matches = matcher.find(text);
  if (matches.length === 0) return [];
  const sentenceAt = sentenceKeyFinder(text);
  return matches.map((m) =>
    Decoration.inline(pos + 1 + m.from, pos + 1 + m.to, nameMarkAttributes(m, sentenceAt(m.from))),
  );
}

function decorateAll(matcher: NameMatcher, doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    decorations.push(...decorateBlock(matcher, node, pos));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Highlights names in the formatted editor. After an edit only the
 * paragraphs the edit touched are scanned again; the rest of the highlights
 * are mapped through the change.
 */
function nameHighlightPlugin(getMatcher: () => NameMatcher): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: nameHighlightKey,
    state: {
      init: (_config, state) => decorateAll(getMatcher(), state.doc),
      apply(tr, previous) {
        if (tr.getMeta(nameHighlightKey) === REFRESH_NAMES) return decorateAll(getMatcher(), tr.doc);
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

        const matcher = getMatcher();
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
              set = set.add(doc, decorateBlock(matcher, node, pos));
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

export const NameHighlight = Extension.create<{ getMatcher: () => NameMatcher }>({
  name: "nameHighlight",
  addOptions() {
    return { getMatcher: () => EMPTY_MATCHER };
  },
  addProseMirrorPlugins() {
    return [nameHighlightPlugin(this.options.getMatcher)];
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
