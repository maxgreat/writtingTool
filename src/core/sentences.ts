/**
 * Sentences inside one paragraph. "Ignore here" remembers a name's
 * occurrence by its sentence, and the possible-names list skips the first
 * word of each sentence, so both need the same cuts whichever editor shows
 * the paragraph: the plain one, which holds Markdown markers (`*soaked*`,
 * `> `), or the formatted one, which holds the text alone. The rules are
 * simple and the same on every platform, rather than the system's own
 * sentence breaking, so a sentence remembered on one device is the same
 * sentence on another.
 */

export interface Range {
  from: number;
  to: number;
}

/**
 * Where a sentence can end: end punctuation, closing quotes, brackets or
 * Markdown emphasis markers, then a space. "Mr." and the like don't end one.
 * Each mark may be escaped with a backslash, as the plain text of a chapter
 * writes a literal `]`, `*` or `_` (`\]`), so it ends a sentence as it does
 * in the formatted editor.
 */
const END = /(?:\\?[.!?…])+(?:\\?[”’"'»)\]*_])*\s+/gu;

/** Words that end with a full stop without ending the sentence ("Mr. Kell"). */
export const ABBREVIATIONS = new Set([
  "Mr", "Mrs", "Ms", "Mx", "Dr", "Prof", "St", "Jr", "Sr", "Sra", "Srta", "Mme", "Mlle", "Mgr", "Me", "Pr", "Dra",
]);

const WORD_BEFORE = /[\p{L}\p{M}]+$/u;

/** The sentences of a paragraph, as ranges with no space around them. */
export function sentenceRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  const push = (from: number, to: number) => {
    while (from < to && /\s/u.test(text[from])) from++;
    while (to > from && /\s/u.test(text[to - 1])) to--;
    if (to > from) ranges.push({ from, to });
  };
  for (const match of text.matchAll(END)) {
    const before = WORD_BEFORE.exec(text.slice(start, match.index))?.[0];
    const marks = match[0].replace(/\\/gu, "");
    if (before && marks.startsWith(".") && !marks.startsWith("..") && ABBREVIATIONS.has(before)) continue;
    const end = match.index + match[0].length;
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return ranges;
}

/** The sentence that holds `offset`, or the paragraph's last one when it is past them all. */
export function sentenceAt(text: string, offset: number): Range {
  const ranges = sentenceRanges(text);
  return ranges.find((r) => offset < r.to) ?? ranges.at(-1) ?? { from: 0, to: text.length };
}

/**
 * A sentence as "Ignore here" remembers it: without Markdown markers
 * (backslash escapes, block quote or heading marks at its start, `*` and
 * `_`), with straight apostrophes, single spaces and composed accents, so
 * the same sentence gives the same key in either editor. Backslashes go
 * first: a literal "> Mara said." is written "\> Mara said.", and keys as
 * the formatted editor's text does.
 */
export function sentenceKey(sentence: string): string {
  return sentence
    .normalize("NFC")
    .replace(/[’ʼ]/gu, "'")
    .replace(/\\/gu, "")
    .replace(/^(?:\s*(?:#{1,6}(?=\s)|>))+/u, "")
    .replace(/[*_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * For one paragraph: the key of the sentence that holds an offset. The
 * sentences are found once, for every offset asked about.
 */
export function sentenceKeyFinder(text: string): (offset: number) => string {
  const ranges = sentenceRanges(text);
  const keys = new Map<number, string>();
  return (offset) => {
    if (ranges.length === 0) return sentenceKey(text);
    // As sentenceAt: the sentence the offset is in, or the last one when it is past them all.
    const found = ranges.findIndex((r) => offset < r.to);
    const index = found === -1 ? ranges.length - 1 : found;
    let key = keys.get(index);
    if (key === undefined) {
      key = sentenceKey(text.slice(ranges[index].from, ranges[index].to));
      keys.set(index, key);
    }
    return key;
  };
}
