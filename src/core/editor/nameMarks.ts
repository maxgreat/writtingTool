import type { NameMatch, NameMatcher } from "../names";
import { capitalizedInLine } from "../possibleNames";
import { sentenceKeyFinder } from "../sentences";
import { spellingKey, wordsToCheck } from "../spelling";
import type { NameHit, SuggestionHit } from "./types";

/**
 * Both editors render a highlighted name as an element with these classes:
 *
 *   name-mark                 every highlighted name
 *   name-mark--<kind>         the sheet type: characters, places, or a user type
 *   name-mark--ambiguous      an alias shared by two or more sheets
 *
 * a `data-sheets` attribute holding the sheet ids as a JSON array, and
 * `data-name` and `data-sentence`: the occurrence as "Ignore here"
 * remembers it (the name as written, and its sentence's key).
 */
export const NAME_MARK_CLASS = "name-mark";

export function nameMarkAttributes(match: NameMatch, sentence: string): Record<string, string> {
  const kind = match.kind.toLowerCase().replace(/[^a-z0-9-]/gu, "-");
  const classes = [NAME_MARK_CLASS, `${NAME_MARK_CLASS}--${kind}`];
  if (match.ambiguous) classes.push(`${NAME_MARK_CLASS}--ambiguous`);
  return {
    class: classes.join(" "),
    "data-sheets": JSON.stringify(match.sheetIds),
    "data-name": match.text,
    "data-sentence": sentence,
  };
}

/** The highlighted name an event happened on, if any. Use it for clicks and hovers. */
export function nameMarkAt(target: EventTarget | null): NameHit | null {
  const element = target instanceof Element ? target.closest(`.${NAME_MARK_CLASS}`) : null;
  if (!element) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(element.getAttribute("data-sheets") ?? "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) return null;
  return {
    sheetIds: ids,
    ambiguous: ids.length > 1,
    rect: element.getBoundingClientRect(),
    occurrence: { name: element.getAttribute("data-name") ?? "", sentence: element.getAttribute("data-sentence") ?? "" },
  };
}

/** Words marked as possible names: an element with this class and `data-word`. */
export const SUGGESTION_MARK_CLASS = "possible-name";

export function suggestionMarkAttributes(word: string): Record<string, string> {
  return { class: SUGGESTION_MARK_CLASS, "data-word": word };
}

/** The possible name an event happened on, if any. */
export function suggestionMarkAt(target: EventTarget | null): SuggestionHit | null {
  const element = target instanceof Element ? target.closest(`.${SUGGESTION_MARK_CLASS}`) : null;
  const word = element?.getAttribute("data-word");
  if (!element || !word) return null;
  return { word, rect: element.getBoundingClientRect() };
}

/** Misspelled words: an element with this class and `data-word`, the word as written. */
export const SPELLING_MARK_CLASS = "spelling-mark";

export function spellingMarkAttributes(word: string): Record<string, string> {
  return { class: SPELLING_MARK_CLASS, "data-word": word };
}

/** The misspelled word an event happened on, if any. */
export function spellingMarkAt(target: EventTarget | null): SuggestionHit | null {
  const element = target instanceof Element ? target.closest(`.${SPELLING_MARK_CLASS}`) : null;
  const word = element?.getAttribute("data-word");
  if (!element || !word) return null;
  return { word, rect: element.getBoundingClientRect() };
}

/** What to mark besides names. */
export interface MarkSources {
  /** Possible names, as composed words (see useNameSuggestions). */
  suggestions?: ReadonlySet<string>;
  /** Misspelled words, as spelling keys (see useSpelling). */
  misspelled?: ReadonlySet<string>;
  /** The formatted editor's heading, whose text has no "#". */
  heading?: boolean;
}

const NO_WORDS: ReadonlySet<string> = new Set();

/** A mark to put on a paragraph's text: offsets into it, and the element's attributes. */
export interface ParagraphMark {
  from: number;
  to: number;
  attributes: Record<string, string>;
}

/**
 * Every mark of one paragraph, in text order: its names (see
 * nameMarkAttributes), the words among `suggestions` written where they
 * may be names (see capitalizedInLine and suggestionMarkAttributes), and
 * the words among `misspelled` (see wordsToCheck and
 * spellingMarkAttributes). Both editors mark a paragraph with this, so they
 * mark the same words. Marks never overlap: names aren't checked, and the
 * spelling check leaves possible names out.
 */
export function paragraphMarks(text: string, matcher: NameMatcher, sources: MarkSources = {}): ParagraphMark[] {
  const { suggestions = NO_WORDS, misspelled = NO_WORDS, heading = false } = sources;
  const matches = matcher.find(text);
  const marks: ParagraphMark[] = [];
  if (matches.length > 0) {
    const sentenceAt = sentenceKeyFinder(text);
    for (const m of matches) marks.push({ from: m.from, to: m.to, attributes: nameMarkAttributes(m, sentenceAt(m.from)) });
  }
  if (suggestions.size > 0) {
    for (const w of capitalizedInLine(text, matches, heading)) {
      if (suggestions.has(w.word)) marks.push({ from: w.from, to: w.to, attributes: suggestionMarkAttributes(w.word) });
    }
  }
  if (misspelled.size > 0) {
    const taken = marks.slice();
    for (const w of wordsToCheck(text, matches)) {
      if (!misspelled.has(spellingKey(w.word))) continue;
      if (taken.some((m) => m.from < w.to && w.from < m.to)) continue;
      marks.push({ from: w.from, to: w.to, attributes: spellingMarkAttributes(w.word) });
    }
  }
  if (marks.length > matches.length) marks.sort((a, b) => a.from - b.from);
  return marks;
}
