import type { Place } from "../core/binder";
import type { BinderItem, Project, SheetType, TrashItem } from "../core/project";
import { plural } from "./dom";
import { sheetKindLabel } from "./sheets";

/**
 * What the binder needs to work out from the project before it asks the
 * core for a change: where an item is, where Move up / Move down / Move to
 * take it, and where a dragged row lands.
 */

type Part = Extract<BinderItem, { type: "part" }>;

/** Where a chapter is: its part (null at the top level), its position there, and how many items share that list. */
export interface ChapterPlace {
  partId: string | null;
  index: number;
  count: number;
}

export function chapterPlace(binder: BinderItem[], id: string): ChapterPlace | null {
  for (const [index, item] of binder.entries()) {
    if (item.type === "chapter" && item.id === id) return { partId: null, index, count: binder.length };
    if (item.type === "part") {
      const inPart = item.chapterIds.indexOf(id);
      if (inPart !== -1) return { partId: item.id, index: inPart, count: item.chapterIds.length };
    }
  }
  return null;
}

export function partIndex(binder: BinderItem[], id: string): number {
  return binder.findIndex((item) => item.type === "part" && item.id === id);
}

export function partsOf(binder: BinderItem[]): Part[] {
  return binder.filter((item): item is Part => item.type === "part");
}

/**
 * Move up (-1) or Move down (+1) within the chapter's own list (its part, or
 * the top level), as the place the core expects: the position once the
 * chapter is taken out. Null at either end of the list.
 */
export function chapterStep(binder: BinderItem[], id: string, delta: -1 | 1): Place | null {
  const at = chapterPlace(binder, id);
  if (!at) return null;
  const index = at.index + delta;
  if (index < 0 || index >= at.count) return null;
  return { partId: at.partId, index };
}

/** Move up or down among the top-level items, as the index the core expects. Null at either end. */
export function partStep(binder: BinderItem[], id: string, delta: -1 | 1): number | null {
  const from = partIndex(binder, id);
  if (from === -1) return null;
  const index = from + delta;
  return index < 0 || index >= binder.length ? null : index;
}

/**
 * Move to: the end of a part, or the end of the top level (`partId` null).
 * Null when the chapter is already there.
 */
export function chapterMoveTo(binder: BinderItem[], id: string, partId: string | null): Place | null {
  const at = chapterPlace(binder, id);
  if (!at || at.partId === partId) return null;
  if (partId === null) return { partId: null, index: binder.length };
  const part = partsOf(binder).find((p) => p.id === partId);
  return part ? { partId, index: part.chapterIds.length } : null;
}

export function partWords(project: Project, part: Part): number {
  return part.chapterIds.reduce((sum, id) => sum + (project.chapters[id]?.wordCount ?? 0), 0);
}

/** A count and its unit, kept on one line. */
const unit = (n: number, one: string, many: string) => plural(n, one, many).replace(" ", "\u00a0");

/**
 * "102 words" for a chapter; "2 chapters · 230 words" for a part; for a
 * sheet, what it is and the words in its notes: "Character · 40 words", or
 * "Character" when it has none (its fields may still hold something). Each
 * count stays on one line with its unit.
 */
export function trashSummary(item: TrashItem, types: SheetType[]): string {
  const words = unit(item.wordCount, "word", "words");
  if (item.type === "sheet") {
    const kind = sheetKindLabel(item.kind ?? "", types);
    return item.wordCount === 0 ? kind : `${kind} · ${words}`;
  }
  return item.type === "part" ? `${unit(item.chapterIds.length, "chapter", "chapters")} · ${words}` : words;
}

/* Dragging ------------------------------------------------------------------ */

export type DragItem = { type: "chapter" | "part"; id: string };

/** A row of the manuscript list as laid out on screen, top to bottom. */
export interface RowBox {
  /** "empty": the note shown in an open part that has no chapters. */
  type: "part" | "chapter" | "empty";
  /** The chapter, or the part for a part row and for its "empty" note. */
  id: string;
  /** The part a chapter row or "empty" note is in; null for top-level chapters and part rows. */
  partId: string | null;
  top: number;
  bottom: number;
  /** Part rows: whether the part's chapters are shown below it. */
  open?: boolean;
}

/** A gap a dragged item can land in, counted in the list as it is now (the dragged item still in it). */
export type Drop = { type: "chapter"; partId: string | null; index: number } | { type: "part"; index: number };

/** How the landing place is shown: an insertion line (at a row's edge, indented like a chapter in a part or not), or the part it goes into. */
export type DropMark = { kind: "line"; y: number; nested: boolean } | { kind: "into"; partId: string };

/**
 * Where a dragged item would land with the pointer at `y`, given the rows
 * (same coordinates). A chapter goes before or after the chapter row it is
 * over; over a part row, the upper half puts it before the part at the top
 * level and the lower half puts it into the part (first, if its chapters
 * show; last, if it is folded). Below every row is the end of the top level.
 * A part only goes between top-level items: before or after the item whose
 * rows (a part with its open chapters) the pointer is over.
 */
export function findDrop(
  binder: BinderItem[],
  rows: RowBox[],
  item: DragItem,
  y: number,
): { drop: Drop; mark: DropMark } | null {
  const last = rows.at(-1);
  if (!last) return null;
  const topIndex = (id: string) => binder.findIndex((i) => i.id === id);

  if (item.type === "part") {
    // Each top-level item with the rows it covers on screen.
    const blocks: { index: number; top: number; bottom: number }[] = [];
    for (const row of rows) {
      const index = topIndex(row.partId ?? row.id);
      if (index === -1) continue;
      const block = blocks.at(-1);
      if (block && block.index === index) block.bottom = row.bottom;
      else blocks.push({ index, top: row.top, bottom: row.bottom });
    }
    const block = blocks.find((b) => y < b.bottom);
    if (!block) return { drop: { type: "part", index: binder.length }, mark: { kind: "line", y: last.bottom, nested: false } };
    const before = y < (block.top + block.bottom) / 2;
    return {
      drop: { type: "part", index: before ? block.index : block.index + 1 },
      mark: { kind: "line", y: before ? block.top : block.bottom, nested: false },
    };
  }

  const row = rows.find((r) => y < r.bottom);
  if (!row) {
    return { drop: { type: "chapter", partId: null, index: binder.length }, mark: { kind: "line", y: last.bottom, nested: false } };
  }
  const before = y < (row.top + row.bottom) / 2;
  if (row.type === "empty") {
    const partId = row.partId ?? row.id;
    return { drop: { type: "chapter", partId, index: 0 }, mark: { kind: "into", partId } };
  }
  if (row.type === "part") {
    if (before) {
      return { drop: { type: "chapter", partId: null, index: topIndex(row.id) }, mark: { kind: "line", y: row.top, nested: false } };
    }
    if (row.open) {
      return { drop: { type: "chapter", partId: row.id, index: 0 }, mark: { kind: "line", y: row.bottom, nested: true } };
    }
    const part = partsOf(binder).find((p) => p.id === row.id);
    return { drop: { type: "chapter", partId: row.id, index: part?.chapterIds.length ?? 0 }, mark: { kind: "into", partId: row.id } };
  }
  const list = row.partId === null ? null : partsOf(binder).find((p) => p.id === row.partId);
  const index = list ? list.chapterIds.indexOf(row.id) : topIndex(row.id);
  return {
    drop: { type: "chapter", partId: row.partId, index: index + (before ? 0 : 1) },
    mark: { kind: "line", y: before ? row.top : row.bottom, nested: row.partId !== null },
  };
}

export type Move = { type: "chapter"; place: Place } | { type: "part"; index: number };

/**
 * The move a drop makes, as the core expects it (positions counted once the
 * item is taken out), or null when the item would end up where it is.
 */
export function dropMove(binder: BinderItem[], item: DragItem, drop: Drop): Move | null {
  if (item.type === "part") {
    if (drop.type !== "part") return null;
    const from = partIndex(binder, item.id);
    if (from === -1 || drop.index === from || drop.index === from + 1) return null;
    return { type: "part", index: drop.index > from ? drop.index - 1 : drop.index };
  }
  if (drop.type !== "chapter") return null;
  const at = chapterPlace(binder, item.id);
  if (!at) return null;
  if (at.partId !== drop.partId) return { type: "chapter", place: { partId: drop.partId, index: drop.index } };
  if (drop.index === at.index || drop.index === at.index + 1) return null;
  return { type: "chapter", place: { partId: drop.partId, index: drop.index > at.index ? drop.index - 1 : drop.index } };
}
