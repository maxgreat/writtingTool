import { describe, expect, it } from "vitest";
import type { BinderItem, TrashItem } from "../../core/project";
import {
  chapterMoveTo,
  chapterPlace,
  chapterStep,
  dropMove,
  findDrop,
  partStep,
  trashSummary,
  type RowBox,
} from "../binderModel";

const P1 = "manuscript/Part 1";
const P2 = "manuscript/Part 2";
const A = `${P1}/01 A.md`;
const B = `${P1}/02 B.md`;
const C = `${P2}/03 C.md`;
const LOOSE = "manuscript/04 Loose.md";

/** Part 1 (A, B), Part 2 (C), then a loose chapter. */
const binder: BinderItem[] = [
  { type: "part", id: P1, title: "Part 1", chapterIds: [A, B] },
  { type: "part", id: P2, title: "Part 2", chapterIds: [C] },
  { type: "chapter", id: LOOSE },
];

/** The rows of that binder on screen, every part open, each row 20 px tall with no gaps. */
function rows(open = { [P1]: true, [P2]: true }): RowBox[] {
  const list: Omit<RowBox, "top" | "bottom">[] = [
    { type: "part", id: P1, partId: null, open: open[P1] },
    ...(open[P1] ? [A, B].map((id) => ({ type: "chapter" as const, id, partId: P1 })) : []),
    { type: "part", id: P2, partId: null, open: open[P2] },
    ...(open[P2] ? [{ type: "chapter" as const, id: C, partId: P2 }] : []),
    { type: "chapter", id: LOOSE, partId: null },
  ];
  return list.map((row, i) => ({ ...row, top: i * 20, bottom: i * 20 + 20 }));
}

describe("where a chapter is and where the menu moves it", () => {
  it("finds a chapter in a part or at the top level", () => {
    expect(chapterPlace(binder, B)).toEqual({ partId: P1, index: 1, count: 2 });
    expect(chapterPlace(binder, LOOSE)).toEqual({ partId: null, index: 2, count: 3 });
    expect(chapterPlace(binder, "manuscript/missing.md")).toBeNull();
  });

  it("moves a chapter up or down within its own list, and not past either end", () => {
    expect(chapterStep(binder, A, 1)).toEqual({ partId: P1, index: 1 });
    expect(chapterStep(binder, B, -1)).toEqual({ partId: P1, index: 0 });
    expect(chapterStep(binder, A, -1)).toBeNull();
    expect(chapterStep(binder, B, 1)).toBeNull();
    expect(chapterStep(binder, C, 1)).toBeNull();
    expect(chapterStep(binder, LOOSE, -1)).toEqual({ partId: null, index: 1 });
  });

  it("moves a part among the top-level items", () => {
    expect(partStep(binder, P1, -1)).toBeNull();
    expect(partStep(binder, P1, 1)).toBe(1);
    expect(partStep(binder, P2, 1)).toBe(2);
    expect(partStep(binder, "manuscript/nope", 1)).toBeNull();
  });

  it("moves a chapter to the end of another part or of the top level, and nowhere if it is there", () => {
    expect(chapterMoveTo(binder, A, P2)).toEqual({ partId: P2, index: 1 });
    expect(chapterMoveTo(binder, A, null)).toEqual({ partId: null, index: 3 });
    expect(chapterMoveTo(binder, A, P1)).toBeNull();
    expect(chapterMoveTo(binder, LOOSE, null)).toBeNull();
  });
});

describe("dropping a dragged chapter", () => {
  const chapter = (id: string) => ({ type: "chapter" as const, id });

  it("goes before or after the chapter row under the pointer", () => {
    // Row 1 is A (20-40), row 2 is B (40-60).
    expect(findDrop(binder, rows(), chapter(C), 25)).toEqual({
      drop: { type: "chapter", partId: P1, index: 0 },
      mark: { kind: "line", y: 20, nested: true },
    });
    expect(findDrop(binder, rows(), chapter(C), 55)).toEqual({
      drop: { type: "chapter", partId: P1, index: 2 },
      mark: { kind: "line", y: 60, nested: true },
    });
  });

  it("goes before a part at the top level from the upper half of its row, into it from the lower half", () => {
    // Row 3 is Part 2 (60-80).
    expect(findDrop(binder, rows(), chapter(A), 62)).toEqual({
      drop: { type: "chapter", partId: null, index: 1 },
      mark: { kind: "line", y: 60, nested: false },
    });
    expect(findDrop(binder, rows(), chapter(A), 75)).toEqual({
      drop: { type: "chapter", partId: P2, index: 0 },
      mark: { kind: "line", y: 80, nested: true },
    });
  });

  it("goes to the end of a folded part, which is highlighted", () => {
    const folded = rows({ [P1]: true, [P2]: false });
    // Row 3 is Part 2 (60-80), folded.
    expect(findDrop(binder, folded, chapter(A), 75)).toEqual({
      drop: { type: "chapter", partId: P2, index: 1 },
      mark: { kind: "into", partId: P2 },
    });
  });

  it("goes into an empty part from its note", () => {
    const empty: BinderItem[] = [{ type: "part", id: P1, title: "Part 1", chapterIds: [] }, { type: "chapter", id: LOOSE }];
    const boxes: RowBox[] = [
      { type: "part", id: P1, partId: null, open: true, top: 0, bottom: 20 },
      { type: "empty", id: P1, partId: P1, top: 20, bottom: 40 },
      { type: "chapter", id: LOOSE, partId: null, top: 40, bottom: 60 },
    ];
    expect(findDrop(empty, boxes, chapter(LOOSE), 30)).toEqual({
      drop: { type: "chapter", partId: P1, index: 0 },
      mark: { kind: "into", partId: P1 },
    });
  });

  it("goes to the end of the top level below every row", () => {
    expect(findDrop(binder, rows(), chapter(A), 500)).toEqual({
      drop: { type: "chapter", partId: null, index: 3 },
      mark: { kind: "line", y: 120, nested: false },
    });
  });

  it("turns into the move the core expects, counted once the chapter is taken out", () => {
    // A after B in Part 1: gap 2, which is 1 once A is out.
    expect(dropMove(binder, chapter(A), { type: "chapter", partId: P1, index: 2 })).toEqual({
      type: "chapter",
      place: { partId: P1, index: 1 },
    });
    // B before A: gap 0 stays 0.
    expect(dropMove(binder, chapter(B), { type: "chapter", partId: P1, index: 0 })).toEqual({
      type: "chapter",
      place: { partId: P1, index: 0 },
    });
    // Into another list: the gap as it is.
    expect(dropMove(binder, chapter(LOOSE), { type: "chapter", partId: P1, index: 1 })).toEqual({
      type: "chapter",
      place: { partId: P1, index: 1 },
    });
    expect(dropMove(binder, chapter(A), { type: "chapter", partId: null, index: 0 })).toEqual({
      type: "chapter",
      place: { partId: null, index: 0 },
    });
  });

  it("is no move when the chapter lands where it is", () => {
    expect(dropMove(binder, chapter(A), { type: "chapter", partId: P1, index: 0 })).toBeNull();
    expect(dropMove(binder, chapter(A), { type: "chapter", partId: P1, index: 1 })).toBeNull();
    expect(dropMove(binder, chapter(LOOSE), { type: "chapter", partId: null, index: 3 })).toBeNull();
    expect(dropMove(binder, chapter(A), { type: "part", index: 0 })).toBeNull();
  });
});

describe("dropping a dragged part", () => {
  const part = (id: string) => ({ type: "part" as const, id });

  it("goes before or after the top-level item whose rows are under the pointer", () => {
    // Part 1 with its chapters covers 0-60; its middle is 30.
    expect(findDrop(binder, rows(), part(P2), 10)).toEqual({
      drop: { type: "part", index: 0 },
      mark: { kind: "line", y: 0, nested: false },
    });
    expect(findDrop(binder, rows(), part(P2), 45)).toEqual({
      drop: { type: "part", index: 1 },
      mark: { kind: "line", y: 60, nested: false },
    });
    // The loose chapter (100-120), lower half: the end.
    expect(findDrop(binder, rows(), part(P1), 115)).toEqual({
      drop: { type: "part", index: 3 },
      mark: { kind: "line", y: 120, nested: false },
    });
  });

  it("turns into the index the core expects, or nothing where it is", () => {
    expect(dropMove(binder, part(P1), { type: "part", index: 3 })).toEqual({ type: "part", index: 2 });
    expect(dropMove(binder, part(P2), { type: "part", index: 0 })).toEqual({ type: "part", index: 0 });
    expect(dropMove(binder, part(P1), { type: "part", index: 0 })).toBeNull();
    expect(dropMove(binder, part(P1), { type: "part", index: 1 })).toBeNull();
    expect(dropMove(binder, part(P1), { type: "chapter", partId: null, index: 0 })).toBeNull();
  });
});

describe("Trash rows", () => {
  const item = (patch: Partial<TrashItem>): TrashItem => ({
    id: "trash/x",
    type: "chapter",
    title: "X",
    wordCount: 0,
    chapterIds: [],
    from: null,
    ...patch,
  });

  it("give a chapter's words, and a part's chapters and words, each count on one line with its unit", () => {
    expect(trashSummary(item({ wordCount: 1 }))).toBe("1 word");
    expect(trashSummary(item({ type: "part", wordCount: 230, chapterIds: ["a", "b"] }))).toBe(
      "2 chapters · 230 words",
    );
  });
});
