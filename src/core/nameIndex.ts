import type { NameMatcher } from "./names";

/** What the index needs of a chapter. */
export interface IndexedChapter {
  id: string;
  text: string;
}

/** A chapter where a sheet's names appear, and how often. */
export interface Appearance {
  chapterId: string;
  count: number;
}

/**
 * How often each sheet's names appear in a chapter's Markdown, by sheet id.
 * Each paragraph is one line, which is what the matcher expects. A name
 * shared by several sheets counts for each of them.
 */
export function countNames(text: string, matcher: NameMatcher): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    for (const match of matcher.find(line)) {
      for (const id of match.sheetIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The project-wide name index: how often each sheet's names appear in each
 * chapter. A chapter's counts are kept while its text and the matcher stay
 * the same, so after an edit only the edited chapter is scanned again, and
 * a new matcher (a sheet added, renamed or removed) starts the index afresh.
 * It holds nothing that can't be rebuilt from the chapters.
 */
export class NameIndex {
  private matcher: NameMatcher | null = null;
  private readonly byChapter = new Map<string, { text: string; counts: Map<string, number> }>();

  /** How often each sheet's names appear in this chapter, by sheet id. Don't change the map. */
  counts(chapter: IndexedChapter, matcher: NameMatcher): ReadonlyMap<string, number> {
    if (matcher !== this.matcher) {
      this.byChapter.clear();
      this.matcher = matcher;
    }
    const cached = this.byChapter.get(chapter.id);
    if (cached && cached.text === chapter.text) return cached.counts;
    const counts = countNames(chapter.text, matcher);
    this.byChapter.set(chapter.id, { text: chapter.text, counts });
    return counts;
  }

  /**
   * The chapters where a sheet's names appear, in the order given, with how
   * often. Pass every chapter of the book: chapters left out are dropped
   * from the index, so it doesn't keep the text of deleted or renamed ones.
   */
  appearances(sheetId: string, chapters: IndexedChapter[], matcher: NameMatcher): Appearance[] {
    const result: Appearance[] = [];
    for (const chapter of chapters) {
      const count = this.counts(chapter, matcher).get(sheetId) ?? 0;
      if (count > 0) result.push({ chapterId: chapter.id, count });
    }
    if (this.byChapter.size > chapters.length) {
      const ids = new Set(chapters.map((c) => c.id));
      for (const id of this.byChapter.keys()) if (!ids.has(id)) this.byChapter.delete(id);
    }
    return result;
  }
}
