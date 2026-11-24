import type { NameMatcher } from "./names";
import { ABBREVIATIONS, sentenceRanges } from "./sentences";

/**
 * Possible names: capitalized words that no sheet names yet, found where
 * capitals mean a name rather than the start of a sentence. A word seen
 * this way often enough across the book is offered as a new character,
 * place or other sheet.
 */

export interface PossibleName {
  word: string;
  /** Times it was found, not counting sentence starts. */
  count: number;
  /** Chapters it was found in, in the order given. */
  chapterIds: string[];
}

/** How many times a word must be found before it is offered. */
export const MIN_POSSIBLE_NAME_COUNT = 3;

const WORD = /[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*/gu;
/** Marks that open a line of dialogue or an aside: the word after one starts a sentence. */
const OPENERS = new Set(["“", "«", "‘", '"', "(", "[", "—", "–", "¿", "¡"]);
const SCENE_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

function isSentenceStart(line: string, sentenceFrom: number, wordFrom: number): boolean {
  const before = line.slice(sentenceFrom, wordFrom);
  if (!/[\p{L}\p{N}]/u.test(before)) return true;
  const trimmed = before.replace(/[\s*_]+$/u, "");
  const last = trimmed.at(-1) ?? "";
  if (OPENERS.has(last)) return true;
  // A straight single quote opens dialogue only after a space ("said 'Come'"), not in "d'Arwen".
  return last === "'" && /(?:^|\s)'$/u.test(trimmed);
}

/**
 * The capitalized words of a chapter's Markdown that may be names, with how
 * often each is found: not the first word of a sentence, not in a heading,
 * not already highlighted as a name, with at least one lower-case letter
 * (so "I", "OK" and shouted words are left out), and not a title like "Mr".
 */
export function capitalizedWords(text: string, matcher: NameMatcher): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    if (/^\s*#/u.test(raw) || SCENE_BREAK.test(raw)) continue;
    const line = raw.replace(/^(?:\s*>)+/u, (m) => " ".repeat(m.length));
    const names = matcher.find(line);
    const sentences = sentenceRanges(line);
    let s = 0;
    for (const match of line.matchAll(WORD)) {
      const word = match[0];
      const from = match.index;
      const to = from + word.length;
      if (!/^\p{Lu}/u.test(word) || !/\p{Ll}/u.test(word) || ABBREVIATIONS.has(word)) continue;
      if (names.some((n) => n.from < to && from < n.to)) continue;
      while (s < sentences.length - 1 && from >= sentences[s].to) s++;
      if (isSentenceStart(line, sentences[s]?.from ?? 0, from)) continue;
      const key = word.normalize("NFC");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The words found at least `min` times across the chapters given, most
 * often first. `isTaken` leaves out words already settled: a sheet's name
 * or alias (even where it is ignored), or a word marked as not a name.
 */
export function possibleNames(
  perChapter: { chapterId: string; words: ReadonlyMap<string, number> }[],
  isTaken: (word: string) => boolean,
  min = MIN_POSSIBLE_NAME_COUNT,
): PossibleName[] {
  const found = new Map<string, PossibleName>();
  for (const { chapterId, words } of perChapter) {
    for (const [word, count] of words) {
      let entry = found.get(word);
      if (!entry) {
        entry = { word, count: 0, chapterIds: [] };
        found.set(word, entry);
      }
      entry.count += count;
      entry.chapterIds.push(chapterId);
    }
  }
  return [...found.values()]
    .filter((p) => p.count >= min && !isTaken(p.word))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}
