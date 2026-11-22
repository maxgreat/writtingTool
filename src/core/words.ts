const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const CHAPTER_TITLE = /^#\s/u;
/** A character reference such as `&nbsp;` (the formatted editor writes one for an empty paragraph), unless escaped. */
const ENTITY = /(?<!\\)&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/giu;

/**
 * Counts the words of a chapter's prose. Markdown markers and character
 * references are not words, so they never count; the chapter title (the `# `
 * line) is left out as well. "Jean-Luc" and "don’t" count as one word each.
 */
export function countWords(markdown: string): number {
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (CHAPTER_TITLE.test(line)) continue;
    count += line.replace(ENTITY, " ").match(WORD)?.length ?? 0;
  }
  return count;
}
