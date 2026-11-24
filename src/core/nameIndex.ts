import type { NameMatcher } from "./names";
import { capitalizedWords, possibleNames, type PossibleName } from "./possibleNames";

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
 * chapter, and each chapter's capitalized words that may be names. What a
 * chapter gives is kept while its text and the matcher stay the same, so
 * after an edit only the edited chapter is scanned again, and a new matcher
 * (a sheet added, renamed or removed, an occurrence ignored) starts the
 * index afresh. It holds nothing that can't be rebuilt from the chapters.
 */
export class NameIndex {
  private matcher: NameMatcher | null = null;
  private readonly byChapter = new Map<string, { text: string; counts: Map<string, number> }>();
  private readonly wordsByChapter = new Map<string, { text: string; words: Map<string, number> }>();

  private use(matcher: NameMatcher): void {
    if (matcher === this.matcher) return;
    this.byChapter.clear();
    this.wordsByChapter.clear();
    this.matcher = matcher;
  }

  /** Drops what is kept for chapters that are no longer in the book. */
  private forgetOthers(chapters: IndexedChapter[]): void {
    for (const cache of [this.byChapter, this.wordsByChapter]) {
      if (cache.size <= chapters.length) continue;
      const ids = new Set(chapters.map((c) => c.id));
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    }
  }

  /** How often each sheet's names appear in this chapter, by sheet id. Don't change the map. */
  counts(chapter: IndexedChapter, matcher: NameMatcher): ReadonlyMap<string, number> {
    this.use(matcher);
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
    this.forgetOthers(chapters);
    return result;
  }

  /** The capitalized words of this chapter that may be names, with how often each is found. Don't change the map. */
  words(chapter: IndexedChapter, matcher: NameMatcher): ReadonlyMap<string, number> {
    this.use(matcher);
    const cached = this.wordsByChapter.get(chapter.id);
    if (cached && cached.text === chapter.text) return cached.words;
    const words = capitalizedWords(chapter.text, matcher);
    this.wordsByChapter.set(chapter.id, { text: chapter.text, words });
    return words;
  }

  /**
   * The possible names across the book, most often found first (see
   * possibleNames.ts). Pass every chapter of the book, as for appearances.
   * `isTaken` leaves out words already settled: names the matcher knows,
   * and words marked as not names. `min`: how many times a word must be
   * found (MIN_POSSIBLE_NAME_COUNT unless given).
   */
  possibleNames(
    chapters: IndexedChapter[],
    matcher: NameMatcher,
    isTaken: (word: string) => boolean,
    min?: number,
  ): PossibleName[] {
    const perChapter = chapters.map((chapter) => ({ chapterId: chapter.id, words: this.words(chapter, matcher) }));
    this.forgetOthers(chapters);
    return possibleNames(perChapter, isTaken, min);
  }
}
