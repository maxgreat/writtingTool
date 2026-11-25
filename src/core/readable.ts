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
  /**
   * For each character of `text`, where what writes it starts in the line:
   * its offset, or its backslash's for an escaped character ("\*"). A
   * range of the text starts here in the line, so replacing it takes the
   * escape away too.
   */
  starts: number[];
}

/**
 * The text of one line of a chapter's Markdown as it reads, without its
 * markers and escapes, mapped back to the line: the paragraph's text in
 * the formatted editor. A scene break reads as nothing.
 */
export function readableLine(line: string): Projection {
  const text: string[] = [];
  const at: number[] = [];
  const starts: number[] = [];
  if (SCENE_BREAK.test(line)) return { text: "", at: [line.length], starts: [] };
  const start = BLOCK_PREFIX.exec(line)?.[0].length ?? 0;
  for (let i = start; i < line.length; ) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length && ESCAPABLE.test(line[i + 1])) {
      text.push(line[i + 1]);
      at.push(i + 1);
      starts.push(i);
      i += 2;
    } else if (MARKER.test(c)) {
      i += 1;
    } else if (c === "&" && ENTITY.test(line.slice(i))) {
      // `&nbsp;` and the like read as a space.
      const length = ENTITY.exec(line.slice(i))![0].length;
      text.push(" ");
      at.push(i);
      starts.push(i);
      i += length;
    } else {
      text.push(c);
      at.push(i);
      starts.push(i);
      i += 1;
    }
  }
  at.push(line.length);
  return { text: text.join(""), at, starts };
}

/** Text as it reads (a replacement, a fix), as it must be written in a Markdown line: its markers escaped. */
export function markdownText(text: string): string {
  return text.replace(/([\\`*_[\]~])/gu, "\\$1").replace(/&(?=#?[A-Za-z0-9]+;)/gu, "\\&").replace(/<(?=[A-Za-z/!?])/gu, "\\<");
}

/**
 * A paragraph typed to start like a heading, list, quote or rule
 * ("- Bonjour", "1984. The river froze.", "> ") would read back as that block.
 */
export function escapeParagraphStart(text: string): string {
  return text
    .replace(/^(?=#{1,6}(?:[ \t]|$))/u, "\\")
    .replace(/^(?=[-+](?:[ \t]|$))/u, "\\")
    .replace(/^(?=-[ \t]*-[ \t]*-[- \t]*$)/u, "\\")
    .replace(/^(\d{1,9})(?=[.)](?:[ \t]|$))/u, "$1\\")
    .replace(/^(?=>)/u, "\\");
}
