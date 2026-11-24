import type { NameMatch, NameMatcher } from "./names";
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

/**
 * How many times a word must be found before it is offered when there is no
 * dictionary to tell ordinary words from names (see useNameSuggestions.ts).
 */
export const MIN_POSSIBLE_NAME_COUNT = 3;

/** A capitalized word of a paragraph that may be a name, where it is in the paragraph. */
export interface CapitalizedWord {
  /** The word, composed (NFC). */
  word: string;
  from: number;
  to: number;
}

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
 * The capitalized words of one paragraph that may be names: not the first
 * word of a sentence, not in a heading, not already highlighted as a name,
 * with at least one lower-case letter (so "I", "OK" and shouted words are
 * left out), and not a title like "Mr". `line` is a line of a chapter's
 * Markdown or a paragraph's text in the formatted editor (`heading` tells
 * it a heading there, which has no "#"); `names` are the matcher's names in
 * it, as `matcher.find(line)` gives them.
 */
export function capitalizedInLine(line: string, names: NameMatch[], heading = false): CapitalizedWord[] {
  if (heading || /^\s*#/u.test(line) || SCENE_BREAK.test(line)) return [];
  // Block quote marks become spaces, so offsets stay those of the line.
  const text = line.replace(/^(?:\s*>)+/u, (m) => " ".repeat(m.length));
  const sentences = sentenceRanges(text);
  const found: CapitalizedWord[] = [];
  let s = 0;
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const from = match.index;
    const to = from + word.length;
    if (!/^\p{Lu}/u.test(word) || !/\p{Ll}/u.test(word) || ABBREVIATIONS.has(word)) continue;
    if (names.some((n) => n.from < to && from < n.to)) continue;
    while (s < sentences.length - 1 && from >= sentences[s].to) s++;
    if (isSentenceStart(text, sentences[s]?.from ?? 0, from)) continue;
    found.push({ word: word.normalize("NFC"), from, to });
  }
  return found;
}

/** The capitalized words of a chapter's Markdown that may be names (see capitalizedInLine), with how often each is found. */
export function capitalizedWords(text: string, matcher: NameMatcher): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    for (const { word } of capitalizedInLine(line, matcher.find(line))) counts.set(word, (counts.get(word) ?? 0) + 1);
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
