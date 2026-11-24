import { normalizeName, type IgnoredName } from "../core/names";

/**
 * Helpers for showing one occurrence of a name: whether the writer ignored
 * it ("Ignore here"), and the part of its sentence to show around it.
 */

/** Whether this occurrence is one the writer chose not to highlight. */
export function isIgnored(ignored: IgnoredName[], occurrence: IgnoredName): boolean {
  const name = normalizeName(occurrence.name);
  return ignored.some((e) => e.name === name && e.sentence === occurrence.sentence);
}

export function sameOccurrence(a: IgnoredName, b: IgnoredName): boolean {
  return normalizeName(a.name) === normalizeName(b.name) && a.sentence === b.sentence;
}

/** A key for lists and React keys: the name and its sentence. */
export const occurrenceKey = (o: IgnoredName) => `${normalizeName(o.name)}\n${o.sentence}`;

export interface ExcerptParts {
  /** The words before the name, with "…" in front when some were left out. */
  before: string;
  /** The name as written; empty when the sentence doesn't hold it. */
  name: string;
  after: string;
}

const WORD_EDGE = "[\\p{L}\\p{M}\\p{N}]";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Where the name first stands as a whole word in the sentence, or -1. */
function findName(sentence: string, name: string): number {
  if (name === "") return -1;
  const pattern = new RegExp(`(?<!${WORD_EDGE})${escapeRegExp(name)}(?!${WORD_EDGE})`, "u");
  return pattern.exec(sentence)?.index ?? -1;
}

/**
 * The sentence around a name, at most `maxWords` words with the name: the
 * whole sentence when it is short enough, else the words nearest the name,
 * a few more after it than before, with "…" where words were left out.
 */
export function excerpt(sentence: string, name: string, maxWords: number): ExcerptParts {
  const at = findName(sentence, name);
  if (at === -1) {
    const words = sentence.match(/\S+\s*/gu) ?? [];
    const cut = words.length > maxWords;
    return { before: `${words.slice(0, maxWords).join("").trimEnd()}${cut ? "…" : ""}`, name: "", after: "" };
  }
  // Words keep their spaces, so the kept ones join back as they were written.
  const before = sentence.slice(0, at).match(/\S*\s+|\S+/gu) ?? [];
  const after = sentence.slice(at + name.length).match(/\s*\S+|\s+/gu) ?? [];
  const room = Math.max(0, maxWords - 1);
  let keepBefore = Math.min(before.length, Math.floor(room * 0.4));
  const keepAfter = Math.min(after.length, room - keepBefore);
  keepBefore = Math.min(before.length, room - keepAfter);
  const shownBefore = before.slice(before.length - keepBefore).join("");
  const shownAfter = after.slice(0, keepAfter).join("");
  return {
    before: keepBefore < before.length ? `…${shownBefore.trimStart()}` : shownBefore,
    name: sentence.slice(at, at + name.length),
    after: keepAfter < after.length ? `${shownAfter.trimEnd()}…` : shownAfter,
  };
}
