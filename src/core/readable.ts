/*
 * A line of a chapter's Markdown as it reads: without its markers and
 * escapes, as the formatted editor shows the paragraph. Search and the
 * grammar check read lines this way, and map what they find back into the
 * line.
 */

const BLOCK_PREFIX = /^(?:\s*>)*\s*(?:#{1,6}\s+)?/u;
const SCENE_BREAK = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u;
const ENTITY = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/iu;
const MARKER = /[*_]/u;
const ESCAPABLE = /[\\`*_[\]~&<#>!+\-.(){}|]/u;

/** A line of Markdown as it reads: its text, and where each character of it is in the line. */
export interface Projection {
  text: string;
  /** For each character of `text`, its offset in the line; one more entry for the end. */
  at: number[];
}

/**
 * The text of one line of a chapter's Markdown as it reads, without its
 * markers and escapes, mapped back to the line: the paragraph's text in
 * the formatted editor. A scene break reads as nothing.
 */
export function readableLine(line: string): Projection {
  const text: string[] = [];
  const at: number[] = [];
  if (SCENE_BREAK.test(line)) return { text: "", at: [line.length] };
  const start = BLOCK_PREFIX.exec(line)?.[0].length ?? 0;
  for (let i = start; i < line.length; ) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length && ESCAPABLE.test(line[i + 1])) {
      text.push(line[i + 1]);
      at.push(i + 1);
      i += 2;
    } else if (MARKER.test(c)) {
      i += 1;
    } else if (c === "&" && ENTITY.test(line.slice(i))) {
      // `&nbsp;` and the like read as a space.
      const length = ENTITY.exec(line.slice(i))![0].length;
      text.push(" ");
      at.push(i);
      i += length;
    } else {
      text.push(c);
      at.push(i);
      i += 1;
    }
  }
  at.push(line.length);
  return { text: text.join(""), at };
}

/** Text as it reads (a replacement, a fix), as it must be written in a Markdown line: its markers escaped. */
export function markdownText(text: string): string {
  return text.replace(/([\\`*_[\]~])/gu, "\\$1").replace(/&(?=#?[A-Za-z0-9]+;)/gu, "\\&").replace(/<(?=[A-Za-z/!?])/gu, "\\<");
}
