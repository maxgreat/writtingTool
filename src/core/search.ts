import { decodeHtmlEntities, type JSONContent } from "@tiptap/core";
import { chapterMarkdown, withFinalNewline } from "./markdown";
import { escapeParagraphStart, markdownText, readableLine } from "./readable";

/*
 * Search and replace across the book. Chapters are searched as their text
 * reads, without Markdown's markers: "soaked to" is found in "*soaked* to".
 * Each match keeps where it is in the chapter's Markdown, so it can be
 * shown, selected and replaced there.
 */

export interface SearchOptions {
  /** Match upper and lower case as typed. */
  matchCase: boolean;
  /** Only whole words: "art" doesn't find "party". */
  wholeWord: boolean;
}

/** One place a search found, in a chapter's Markdown. */
export interface SearchMatch {
  chapterId: string;
  /** The paragraph's line in the chapter's Markdown, from 0. */
  line: number;
  /** Where the match is in that line of Markdown. */
  from: number;
  to: number;
  /** The paragraph's text around the match, for the list of results. */
  before: string;
  text: string;
  after: string;
  /**
   * The match runs across formatting (it starts in italics and ends
   * outside, say): it is shown, but not replaced, as replacing it would
   * break the formatting.
   */
  acrossFormatting: boolean;
}

/** A formatting marker in Markdown. */
const MARKER = /[*_]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The pattern for a search, or null when there is nothing to search for. */
export function searchPattern(query: string, options: SearchOptions): RegExp | null {
  if (query === "") return null;
  // Apostrophes and quotes match whichever way they are typed.
  const body = [...query.normalize("NFC")]
    .map((c) => {
      if (c === "'" || c === "’" || c === "‘") return "['’‘]";
      if (c === '"' || c === "“" || c === "”") return '["“”]';
      return escapeRegExp(c);
    })
    .join("");
  const word = options.wholeWord ? `(?<![\\p{L}\\p{M}\\p{N}])${body}(?![\\p{L}\\p{M}\\p{N}])` : body;
  return new RegExp(word, options.matchCase ? "gu" : "giu");
}

const CONTEXT = 40;

/** Every match of `query` in a chapter's Markdown, in text order. */
export function findInChapter(chapterId: string, markdown: string, query: string, options: SearchOptions): SearchMatch[] {
  const pattern = searchPattern(query, options);
  if (!pattern) return [];
  const found: SearchMatch[] = [];
  markdown.split("\n").forEach((line, index) => {
    const { text, at, starts } = readableLine(line);
    for (const match of text.matchAll(pattern)) {
      if (match[0] === "") continue;
      const start = match.index;
      const end = start + match[0].length;
      // From the backslash of an escaped first character, so a replacement takes the escape away too.
      const from = starts[start];
      const to = at[end - 1] + 1;
      const span = line.slice(from, to);
      const plain = text.slice(start, end);
      found.push({
        chapterId,
        line: index,
        from,
        to,
        before: text.slice(Math.max(0, start - CONTEXT), start),
        text: plain,
        after: text.slice(end, end + CONTEXT),
        acrossFormatting: span !== plain && !isEscapedOnly(span, plain),
      });
    }
  });
  return found;
}

/** Whether `span` is `plain` with only backslash escapes added. */
function isEscapedOnly(span: string, plain: string): boolean {
  return !MARKER.test(span.replace(/\\[*_]/gu, "")) && span.replace(/\\(.)/gu, "$1") === plain;
}

/** Every match across the book, chapter by chapter in reading order. */
export function findInBook(
  chapters: readonly { id: string; text: string }[],
  query: string,
  options: SearchOptions,
): SearchMatch[] {
  return chapters.flatMap((c) => findInChapter(c.id, c.text, query, options));
}

/**
 * A chapter's Markdown with `matches` (from findInChapter on this same
 * text) replaced by `replacement`, and how many were replaced. A match is
 * replaced only where the chapter then reads as expected: the same blocks,
 * the same text with the match replaced, and the same italics and bold
 * (the new text taking the match's). That is checked for the line on its
 * own, then for a paragraph written on several lines as a whole, then for
 * the whole chapter (in a list or a quote, a line can read otherwise than
 * on its own). Matches across formatting, and any that can't be replaced
 * that way, are left as they are; when the whole chapter doesn't read as
 * expected, none is replaced. A paragraph whose text is all replaced by
 * nothing goes, with the blank line that set it apart.
 */
export function replaceInChapter(markdown: string, matches: readonly SearchMatch[], replacement: string): { text: string; replaced: number } {
  const before = markdown.split("\n");
  const lines = [...before];
  const byLine = new Map<number, SearchMatch[]>();
  for (const m of matches) {
    if (m.acrossFormatting || lines[m.line] === undefined || m.to > lines[m.line].length) continue;
    byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  }
  let replaced = 0;
  const done = new Map<number, SearchMatch[]>();
  const emptied = new Set<number>();
  for (const [index, found] of byLine) {
    // From the end of the line, so the earlier matches' offsets stay right.
    const result = replaceInLine(lines[index], [...found].sort((a, b) => b.from - a.from), replacement);
    if (result.line.trim() === "" && !SEPARATOR.test(before[index])) emptied.add(index);
    lines[index] = result.line;
    done.set(index, result.done);
    replaced += result.done.length;
  }
  // Italics and bold can run from one line of a paragraph to the next, which reading each line alone doesn't
  // show: a paragraph written on several lines is read again as a whole, and left as it was if it doesn't
  // read as expected.
  for (const [start, end] of runsOf(before)) {
    const run = Array.from({ length: end - start }, (_, k) => start + k);
    if (run.length < 2 || run.every((i) => !done.get(i)?.length) || run.every((i) => emptied.has(i))) continue;
    if (runReadsAs(before, lines, start, end, emptied, done, replacement)) continue;
    for (const i of run) {
      replaced -= done.get(i)?.length ?? 0;
      done.delete(i);
      emptied.delete(i);
      lines[i] = before[i];
    }
  }
  if (replaced === 0) return { text: markdown, replaced };
  // The chapter's blocks stay as they were, but for those whose text is all gone, which go. Which those are
  // is read from the chapter with the emptied lines' matches marked in place of their replacement: marked
  // so, it must read as the chapter does (a heading's "===" line, marked, would read as text).
  const blocks = blocksOf(markdown);
  const markedBlocks = blocksOf(before.map((line, i) => (emptied.has(i) ? markMatches(line, byLine.get(i) ?? []) : line)).join("\n"));
  const gone = removedLines(before, emptied);
  let text = lines.filter((_, i) => !gone.has(i)).join("\n");
  const kept = outline(markedBlocks, true) === outline(blocks, true) && outline(blocksOf(text)) === outline(withoutMarked(markedBlocks));
  if (!kept) {
    // Taking the emptied lines out would change the blocks around them: they are left as they were.
    for (const i of emptied) {
      lines[i] = before[i];
      replaced -= done.get(i)?.length ?? 0;
      done.delete(i);
    }
    text = lines.join("\n");
    // A replacement that changes the chapter's blocks even so (a line read with the one before it): none is made.
    if (outline(blocksOf(text)) !== outline(blocks)) return { text: markdown, replaced: 0 };
  }
  // Last, the whole chapter as it reads, each line in its place (in a list or a quote, a line can read otherwise
  // than on its own): its text and formatting must be the chapter's with the matches replaced, or none is.
  if (!readsReplaced(markdown, text, inChapter(before, 0, before.length, done), replacement)) return { text: markdown, replaced: 0 };
  // A chapter the formatted editor writes exactly as it is stays that way, or it could no longer be edited there.
  if (replaced > 0 && chapterAsIs(markdown) && !chapterAsIs(text)) return { text: markdown, replaced: 0 };
  return { text, replaced };
}

/** A line with no text: blank, or only quote markers (a ">" line sets paragraphs apart inside a quote). */
const SEPARATOR = /^(?:[ \t]*>)*[ \t]*$/u;
const quoteDepth = (line: string) => (/^(?:[ \t]*>)*/u.exec(line)?.[0].match(/>/gu) ?? []).length;

/** The runs of lines with text, [start, end), with only separators between them. */
function runsOf(lines: readonly string[]): [number, number][] {
  const runs: [number, number][] = [];
  for (let start = 0; start < lines.length; ) {
    if (SEPARATOR.test(lines[start])) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < lines.length && !SEPARATOR.test(lines[end])) end += 1;
    runs.push([start, end]);
    start = end;
  }
  return runs;
}

/** The matches replaced on lines `start`–`end` (`done`, by line), placed in those lines joined. */
function inChapter(lines: readonly string[], start: number, end: number, done: ReadonlyMap<number, readonly SearchMatch[]>): SearchMatch[] {
  const placed: SearchMatch[] = [];
  let offset = 0;
  for (let i = start; i < end; i++) {
    for (const m of done.get(i) ?? []) placed.push({ ...m, from: offset + m.from, to: offset + m.to });
    offset += lines[i].length + 1;
  }
  return placed;
}

/** Whether the run of lines `start`–`end`, after replacing (`after`, without the emptied lines), reads as before with the matches replaced. */
function runReadsAs(
  before: readonly string[],
  after: readonly string[],
  start: number,
  end: number,
  emptied: ReadonlySet<number>,
  done: ReadonlyMap<number, readonly SearchMatch[]>,
  replacement: string,
): boolean {
  const result = after.slice(start, end).filter((_, k) => !emptied.has(start + k)).join("\n");
  return readsReplaced(before.slice(start, end).join("\n"), result, inChapter(before, start, end, done), replacement);
}

/**
 * Whether `after` reads as `before` with `matches` (placed in `before`)
 * replaced by `replacement`: the same text and formatting, block by
 * block, a run of spaces and line ends counting as one space. A match not
 * read as written in `before` makes it false.
 */
function readsReplaced(before: string, after: string, matches: readonly SearchMatch[], replacement: string): boolean {
  const reading = readMarkdownLine(before);
  const targets: Target[] = [];
  for (const m of matches) {
    const target = matchChars(reading, m);
    if (!target) return false;
    targets.push(target);
  }
  return words(readMarkdownLine(after).chars) === words(withReplacements(reading.chars, targets, replacement));
}

/**
 * A reading's text and formatting, as compared: spaces and line ends count
 * as one space; nothing counts at a block's edges, and an emptied block
 * not at all (replaceInChapter checks the blocks themselves).
 */
function words(chars: readonly Char[]): string {
  const out: string[] = [];
  for (const ch of chars) {
    const last = out[out.length - 1];
    if (ch.c === BLOCK_BREAK) {
      while (out[out.length - 1] === " ") out.pop();
      if (out.length > 0 && out[out.length - 1] !== BLOCK_BREAK) out.push(BLOCK_BREAK);
    } else if (SPACE.test(ch.c)) {
      if (last !== undefined && last !== " " && last !== BLOCK_BREAK) out.push(" ");
    } else out.push(`${ch.c}${ch.marks}`);
  }
  while (out[out.length - 1] === " " || out[out.length - 1] === BLOCK_BREAK) out.pop();
  return out.join("\u0000");
}

/**
 * The lines that go with the emptied ones (`emptied`, by index in
 * `before`, the chapter's lines): those lines, and for a run of lines all
 * emptied (nothing left between two separators), the line that set it
 * apart: the one inside the same quote if there is one, else the one after
 * it. replaceInChapter checks that the blocks around them stay as they
 * were, and leaves the emptied lines as they were when they don't.
 */
function removedLines(before: readonly string[], emptied: ReadonlySet<number>): Set<number> {
  const gone = new Set<number>();
  const separator = (i: number) => i >= 0 && i < before.length && !gone.has(i) && SEPARATOR.test(before[i]);
  for (const [start, end] of runsOf(before)) {
    const run = Array.from({ length: end - start }, (_, k) => start + k);
    for (const i of run) if (emptied.has(i)) gone.add(i);
    if (run.every((i) => emptied.has(i))) {
      // The lines on either side once those already gone are left out.
      let above = start - 1;
      while (gone.has(above)) above -= 1;
      const next = separator(end) ? quoteDepth(before[end]) : -1;
      const previous = separator(above) ? quoteDepth(before[above]) : -1;
      if (previous > next) gone.add(above);
      else if (next >= 0) gone.add(end);
    }
  }
  return gone;
}

/**
 * Marks where a match was in a line it emptied: a private-use character,
 * which a chapter's text doesn't use. (In a chapter that did, a block of
 * only that character would count as gone: the check fails, and the
 * emptied lines are left as they were.)
 */
const MARK = "\uE000";
/** A block's text that is only marks, with the formatting markers and spaces around them: text all gone. */
const ONLY_MARKS = /^[\s*_\\\uE000]*$/u;

/** `line` with each of its matches (from findInChapter on it) in MARK's place, from the end so the offsets stay right. */
function markMatches(line: string, matches: readonly SearchMatch[]): string {
  let out = line;
  for (const m of [...matches].sort((a, b) => b.from - a.from)) out = out.slice(0, m.from) + MARK + out.slice(m.to);
  return out;
}

/** A block of a chapter as the parser reads it ("paragraph", "heading2", "blockquote"...). */
interface Block {
  kind: string;
  /** The text of a block of text, as written; "" for a quote or a list. */
  text: string;
  /** What a quote or a list holds; null for a block of text. */
  children: Block[] | null;
}

/** A chapter's blocks, read with the parser the formatted editor uses. */
function blocksOf(markdown: string): Block[] {
  const read = (tokens: readonly Token[]): Block[] =>
    tokens.flatMap((token) => {
      if (token.type === "space") return [];
      const inner = token.type === "list" ? token.items : token.type === "blockquote" || token.type === "list_item" ? token.tokens : null;
      const kind = token.type === "heading" ? `heading${token.depth}` : token.type === "list" && token.ordered ? "ordered_list" : token.type;
      // Without the line ends a block's raw text keeps after it.
      return [{ kind, text: inner ? "" : (token.text ?? token.raw).replace(/\n+$/u, ""), children: inner ? read(inner) : null }];
    });
  return read(chapterMarkdown().instance.lexer(markdown) as unknown as Token[]);
}

/** Blocks without those whose text is only marks (all gone), and without quotes and lists left with nothing in them. */
function withoutMarked(blocks: readonly Block[]): Block[] {
  return blocks.flatMap((block) => {
    if (block.children) {
      const children = withoutMarked(block.children);
      return children.length > 0 ? [{ ...block, children }] : [];
    }
    return block.text.includes(MARK) && ONLY_MARKS.test(block.text) ? [] : [block];
  });
}

/**
 * Blocks' kinds and how many lines of text each holds (lines of only
 * marks left out, unless `everyLine`), nested: what two chapters' blocks
 * are compared by, so that a line read into another block ("===" under a
 * heading that went) shows.
 */
function outline(blocks: readonly Block[], everyLine = false): string {
  const lines = (text: string) =>
    text.split("\n").filter((line) => everyLine || !(line.includes(MARK) && ONLY_MARKS.test(line))).length;
  return blocks
    .map((block) => (block.children ? `${block.kind}(${outline(block.children, everyLine)})` : `${block.kind}:${lines(block.text)}`))
    .join(",");
}

/** Whether the formatted editor, reading a chapter, writes it back as it is (keepsChapterExactly, without an editor). */
function chapterAsIs(markdown: string): boolean {
  const manager = chapterMarkdown();
  return withFinalNewline(manager.serialize(manager.parse(markdown))) === withFinalNewline(markdown);
}

/** One line's matches (from its end) replaced, and those that were. */
function replaceInLine(line: string, matches: readonly SearchMatch[], replacement: string): { line: string; done: SearchMatch[] } {
  const written = markdownText(replacement);
  let text = line;
  const done: SearchMatch[] = [];
  matches.forEach((m, i) => {
    // What comes before this match stays as it is: the earlier matches are replaced next, where they are.
    const next = replaceMatch(text, m, replacement, written, matches[i + 1]?.to ?? 0);
    if (next !== null) {
      text = next;
      done.push(m);
    }
  });
  if (done.length < matches.length) {
    // The line as the formatted editor would write it, with every match replaced.
    const rewritten = rewriteLine(line, matches, replacement);
    if (rewritten !== null) return { line: rewritten, done: [...matches] };
  }
  return { line: text, done };
}

/** `line` with the match replaced, keeping its first `keep` characters, or null when no way of writing it reads as expected. */
function replaceMatch(line: string, m: SearchMatch, replacement: string, written: string, keep: number): string | null {
  const reading = readMarkdownLine(line);
  const target = matchChars(reading, m);
  if (!target) return null;
  const expected = withReplacements(reading.chars, [target], replacement);
  // A line the formatted editor writes exactly as it is stays that way, or the chapter could no longer be edited there.
  const exact = writtenAsIs(line);
  const ways = new Set<string>();
  // Spaces a replacement leaves at the end of a line go: before a line end, two would read as a line break.
  const tidy = (way: string) => (/[ \t]$/u.test(line) ? way : way.replace(/[ \t]+$/u, ""));
  // The text swapped in place; then with the markers of a span the match fills kept around the new text.
  for (const way of [line.slice(0, m.from) + written + line.slice(m.to), withinEmphasis(line, m.from, m.to, written)].map(tidy)) {
    ways.add(way);
    // At a paragraph's start, text that now starts like a list or a heading is escaped, as the formatted editor writes it;
    // and so is a heading's text that now ends in "#", which would read as a closing mark.
    ways.add(keepParagraph(line, way));
    ways.add(keepHeadingEnd(line, way));
  }
  // A paragraph whose text is all gone is an empty line.
  if (trimmed(expected).length === 0) ways.add("");
  for (const way of ways) {
    if (way.slice(0, keep) !== line.slice(0, keep) || !readsAs(readMarkdownLine(way), reading.blocks, expected)) continue;
    if (!exact || writtenAsIs(way)) return way;
  }
  return null;
}

/**
 * The line written anew, as the formatted editor writes it, with every
 * match replaced; null if it holds more than quotes, paragraphs,
 * headings, italics and bold (the editor would lose the rest), or if even
 * this doesn't read as expected.
 */
function rewriteLine(line: string, matches: readonly SearchMatch[], replacement: string): string | null {
  const reading = readMarkdownLine(line);
  if (!reading.simple) return null;
  const targets: Target[] = [];
  for (const m of matches) {
    const target = matchChars(reading, m);
    if (!target) return null;
    targets.push(target);
  }
  const expected = withReplacements(reading.chars, targets, replacement);
  const written = trimmed(expected).length === 0 ? "" : chapterMarkdown().serialize(lineDocument(reading.blocks, expected));
  if (written.includes("\n") || (writtenAsIs(line) && !writtenAsIs(written))) return null;
  return readsAs(readMarkdownLine(written), reading.blocks, expected) ? written : null;
}

/** Whether the formatted editor, reading `line`, writes it back exactly as it is. */
function writtenAsIs(line: string): boolean {
  const manager = chapterMarkdown();
  return manager.serialize(manager.parse(line)) === line;
}

/** Emphasis markers opening right before a match: at the end of what comes before it, after no letter or digit. */
const OPENING = /(?:^|(?<=[^\p{L}\p{M}\p{N}\\]))[*_]+$/u;
/** Emphasis markers closing right after a match: at the start of what follows it, before no letter or digit. */
const CLOSING = /^[*_]+(?=$|[^\p{L}\p{M}\p{N}])/u;

/**
 * One way to write `line` with `written` in place of the match at
 * `from`–`to` (replaceMatch checks how it reads): markers that seem to
 * open or close on the match stay around the new text, with any space at
 * the edge of what is inside them moved outside (Markdown takes no space
 * just inside a marker), and they go when nothing is left inside them.
 */
function withinEmphasis(line: string, from: number, to: number, written: string): string {
  const before = line.slice(0, from);
  const after = line.slice(to);
  const open = OPENING.exec(before)?.[0] ?? "";
  const close = CLOSING.exec(after)?.[0] ?? "";
  const outside = before.slice(0, before.length - open.length);
  const beyond = after.slice(close.length);
  if (open && close && written.trim() === "") return outside + written + beyond;
  const lead = open ? (/^\s*/u.exec(written)?.[0] ?? "") : "";
  const trail = close ? (/\s*$/u.exec(written.slice(lead.length))?.[0] ?? "") : "";
  const core = written.slice(lead.length, written.length - trail.length);
  if (open && !close && core === "") {
    // "*very tired*" without "very": the space after it moves out too.
    const space = /^\s*/u.exec(beyond)?.[0] ?? "";
    return outside + lead + space + open + beyond.slice(space.length);
  }
  if (close && !open && core === "") {
    const space = /\s*$/u.exec(outside)?.[0] ?? "";
    return outside.slice(0, outside.length - space.length) + close + space + trail + beyond;
  }
  return outside + lead + open + core + close + trail + beyond;
}

/** Quote markers at the start of a line, before its paragraph's text. */
const QUOTE_PREFIX = /^(?:[ \t]*>)*[ \t]*/u;
const HEADING = /^#{1,6}(?:[ \t]|$)/u;

/** Where a line's paragraph text starts: after its quote markers. */
const paragraphStart = (line: string) => QUOTE_PREFIX.exec(line)?.[0].length ?? 0;

/**
 * A line whose paragraph start a replacement changed, still a paragraph:
 * text that now starts like a list, heading, quote or rule ("- Salut",
 * "1985. The") is escaped as the formatted editor writes it. A heading
 * stays a heading.
 */
function keepParagraph(before: string, after: string): string {
  const prefix = after.slice(0, paragraphStart(after));
  if (HEADING.test(before.slice(paragraphStart(before)))) return after;
  return prefix + escapeParagraphStart(after.slice(prefix.length));
}

/** A heading whose text a replacement made end in "#" ("Chapter #"), with that "#" escaped as the formatted editor writes it. */
function keepHeadingEnd(before: string, after: string): string {
  if (!HEADING.test(before.slice(paragraphStart(before)))) return after;
  return after.replace(/(^|[ \t])(#+)$/u, "$1\\$2");
}

/* How a line reads ------------------------------------------------------- */

/** One character of a line as Markdown reads it. */
interface Char {
  c: string;
  /** Its formatting ("em", "strong", "em strong"; "" for none). */
  marks: string;
  /** Where it is written in the line; -1 where that isn't known (an entity, say). */
  at: number;
}

/** A line as Markdown reads it: as the formatted editor shows it, and as the export reads it. */
interface Reading {
  /** Its blocks, outside in: "paragraph", "blockquote paragraph", "heading2", "list list_item text"... */
  blocks: string;
  chars: Char[];
  /** For each offset in the text read, the character written there (its index in `chars`), or -1. */
  index: Int32Array;
  /** Only quotes, paragraphs and headings with italics and bold, which the formatted editor writes itself. */
  simple: boolean;
}

/** The part of a marked token this reads. */
interface Token {
  type: string;
  raw: string;
  text?: string;
  tokens?: Token[];
  items?: Token[];
  depth?: number;
  ordered?: boolean;
}

const SIMPLE_BLOCKS = /^(?:blockquote )*(?:paragraph|heading[1-3])$/u;
/** Where one block ends and the next begins, in a reading: a private-use character. */
const BLOCK_BREAK = "\uE002";
/** How a line break within a paragraph reads: a private-use character, not a space. */
const LINE_BREAK = "\uE001";
/** The quote markers at the start of a line of a quote: "> ", "> > "... */
const QUOTE_MARKS = /(?:[ \t]{0,3}>[ \t]?)*/uy;
/** The entities the formatted editor decodes in text (decodeHtmlEntities in @tiptap/core). */
const ENTITY = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|lt|gt|quot|amp);/gu;
const SPACE = /\s/u;
const markKey = (marks: readonly string[]) => [...new Set(marks)].sort().join(" ");

/** How `line` reads, with the parser the formatted editor uses. */
function readMarkdownLine(line: string): Reading {
  const blocks: string[] = [];
  const chars: Char[] = [];
  let simple = true;
  /**
   * Where in the line the text `count` characters after `pos` is: text
   * read on past a line end leaves out the quote markers that start the
   * next line ("> "), as a quote's text does. -1 stays -1.
   */
  const ahead = (pos: number, count: number) => {
    for (let k = 0; k < count && pos >= 0; k++) {
      pos += 1;
      if (line[pos - 1] === "\n") {
        QUOTE_MARKS.lastIndex = pos;
        pos += QUOTE_MARKS.exec(line)?.[0].length ?? 0;
      }
    }
    return pos;
  };
  /** How far into the line the characters placed so far reach: the next block is after it. */
  let reach = 0;
  const push = (text: string, at: number, marks: readonly string[]) => {
    let pos = at;
    for (let i = 0; i < text.length; i++) {
      // A character not where it was thought to be is placed nowhere, and so is the rest of the text.
      const where = pos >= 0 && line[pos] === text[i] ? pos : -1;
      chars.push({ c: text[i], marks: markKey(marks), at: where });
      if (where >= 0) reach = Math.max(reach, where + 1);
      pos = where < 0 ? -1 : ahead(pos, 1);
    }
  };
  /**
   * Where each of `children` starts in the line, and how many of its first
   * characters are in `parent`'s first `lead` characters (spaces written
   * otherwise, such as a tab in a list), which are placed nowhere: the
   * children are one after another inside `parent`, whose text after its
   * lead starts at `at`.
   */
  const starts = (parent: Token, at: number, children: readonly Token[], lead = 0): [number, number][] => {
    let offset = at < 0 ? -1 : parent.raw.indexOf(children.map((c) => c.raw).join(""));
    return children.map((child): [number, number] => {
      if (offset < 0) return [-1, 0];
      const start = offset;
      offset += child.raw.length;
      if (offset <= lead) return [-1, 0];
      return start >= lead ? [ahead(at, start - lead), 0] : [at, lead - start];
    });
  };
  /**
   * Text, with the entities the formatted editor decodes ("&amp;" reads
   * "&") read as it reads them, and placed nowhere: such a line is only
   * changed where it is written as itself.
   */
  const entities = (text: string, at: number, marks: readonly string[]) => {
    let done = 0;
    for (const entity of text.matchAll(ENTITY)) {
      push(text.slice(done, entity.index), ahead(at, done), marks);
      push(decodeHtmlEntities(entity[0]), -1, marks);
      simple = false;
      done = entity.index + entity[0].length;
    }
    push(text.slice(done), ahead(at, done), marks);
  };
  const inline = (token: Token, at: number, marks: readonly string[], skip = 0) => {
    const inner = (children: readonly Token[], more: readonly string[]) => {
      const where = starts(token, skip > 0 ? -1 : at, children);
      children.forEach((child, i) => inline(child, where[i][0], more, where[i][1]));
    };
    if (token.type === "text" && token.tokens) return inner(token.tokens, marks);
    if (token.type === "text") {
      // Its first `skip` characters are spaces written otherwise.
      const text = token.text ?? "";
      push(text.slice(0, skip), -1, marks);
      return entities(text.slice(skip), token.text === token.raw ? at : -1, marks);
    }
    if (skip > 0) at = -1;
    if (token.type === "escape") {
      const text = token.text ?? "";
      return push(text, ahead(at, token.raw.length - text.length), marks);
    }
    if (token.type === "em" || token.type === "strong") return inner(token.tokens ?? [], [...marks, token.type]);
    // Links, code, strikethrough, HTML...: none in a chapter the formatted editor writes.
    simple = false;
    // A line break (two spaces before a line end) reads as one, not as a space.
    if (token.type === "br") return push(LINE_BREAK, -1, marks);
    if (token.tokens) return inner(token.tokens, [...marks, token.type]);
    const text = token.text ?? token.raw;
    const offset = at < 0 ? -1 : token.raw.indexOf(text);
    push(text, offset < 0 ? -1 : ahead(at, offset), [...marks, token.type]);
  };
  // Each block of text is found from where the one before it ended, by its first line.
  let cursor = 0;
  const block = (token: Token) => {
    if (token.type === "space") return;
    blocks.push(token.type === "heading" ? `heading${token.depth}` : token.type === "list" && token.ordered ? "ordered_list" : token.type);
    const children = (token.type === "list" ? token.items : token.tokens) ?? [];
    if (token.type === "blockquote" || token.type === "list" || token.type === "list_item") {
      children.forEach(block);
      return;
    }
    // Blocks are set apart in the reading, so text from one doesn't run into the next.
    if (chars.length > 0) chars.push({ c: BLOCK_BREAK, marks: "", at: -1 });
    // By its first line's text: the spaces before it can be written otherwise (a tab, inside a list).
    const lead = /^[ \t]*/u.exec(token.raw)?.[0].length ?? 0;
    const first = token.raw.split("\n")[0].slice(lead);
    const at = first === "" ? -1 : line.indexOf(first, cursor);
    if (at >= 0) cursor = at + first.length;
    if (token.type === "paragraph" || token.type === "heading" || token.type === "text") {
      const where = starts(token, at, children, lead);
      children.forEach((child, i) => inline(child, where[i][0], [], where[i][1]));
    } else {
      // Code, a rule, HTML...: as written.
      const text = token.text ?? "";
      const offset = at < 0 ? -1 : token.raw.indexOf(text) - lead;
      push(text, offset < 0 ? -1 : ahead(at, offset), [token.type]);
    }
    cursor = Math.max(cursor, reach);
  };
  (chapterMarkdown().instance.lexer(line) as unknown as Token[]).forEach(block);
  const kinds = blocks.join(" ");
  const index = new Int32Array(line.length).fill(-1);
  chars.forEach((ch, i) => {
    if (ch.at >= 0) index[ch.at] = i;
  });
  return { blocks: kinds, chars, index, simple: simple && SIMPLE_BLOCKS.test(kinds) };
}

/** Where a match's text is in a reading. */
interface Target {
  start: number;
  end: number;
  marks: string;
}

/** The characters of a match in a reading of its line: one run of text, all formatted alike; null otherwise. */
function matchChars(reading: Reading, m: SearchMatch): Target | null {
  const inside: number[] = [];
  for (let at = Math.max(0, m.from); at < m.to && at < reading.index.length; at++) {
    if (reading.index[at] >= 0) inside.push(reading.index[at]);
  }
  if (inside.length === 0) return null;
  const start = inside[0];
  const end = inside[inside.length - 1] + 1;
  const run = reading.chars.slice(start, end);
  if (end - start !== inside.length || run.map((ch) => ch.c).join("") !== m.text) return null;
  const marks = new Set(run.filter((ch) => !SPACE.test(ch.c)).map((ch) => ch.marks));
  if (marks.size > 1) return null;
  return { start, end, marks: marks.values().next().value ?? run[0].marks };
}

/** A reading's characters with each target replaced by `replacement`, formatted as the text it replaces. */
function withReplacements(chars: readonly Char[], targets: readonly Target[], replacement: string): Char[] {
  const out = [...chars];
  for (const t of [...targets].sort((a, b) => b.start - a.start)) {
    const added = Array.from({ length: replacement.length }, (_, i) => ({ c: replacement[i], marks: t.marks, at: -1 }));
    out.splice(t.start, t.end - t.start, ...added);
  }
  return out;
}

/** Characters without the spaces at their ends, which Markdown drops at a block's edges. */
function trimmed(chars: readonly Char[]): Char[] {
  let start = 0;
  let end = chars.length;
  while (start < end && SPACE.test(chars[start].c)) start++;
  while (end > start && SPACE.test(chars[end - 1].c)) end--;
  return chars.slice(start, end);
}

/**
 * Whether a reading is `blocks` with `expected`: the same text, and the
 * same formatting on everything but spaces (a space just outside italics
 * reads the same as one just inside). Text that is all gone reads as an
 * empty line.
 */
function readsAs(reading: Reading, blocks: string, expected: readonly Char[]): boolean {
  const want = trimmed(expected);
  const got = trimmed(reading.chars);
  if (want.length === 0) return reading.blocks === "" && got.length === 0;
  if (reading.blocks !== blocks || got.length !== want.length) return false;
  return want.every((w, i) => w.c === got[i].c && (w.marks === got[i].marks || SPACE.test(w.c)));
}

const MARK_TYPES: Record<string, string> = { strong: "bold", em: "italic" };

/** A simple line's blocks holding `chars`, as the formatted editor's document (which writes spaces at the edge of italics outside them). */
function lineDocument(blocks: string, chars: readonly Char[]): JSONContent {
  const runs: { text: string; marks: string }[] = [];
  for (const ch of chars) {
    const last = runs[runs.length - 1];
    if (last && last.marks === ch.marks) last.text += ch.c;
    else runs.push({ text: ch.c, marks: ch.marks });
  }
  const content = runs.map(({ text, marks }): JSONContent => {
    const types = ["strong", "em"].filter((mark) => marks.split(" ").includes(mark)).map((mark) => ({ type: MARK_TYPES[mark] }));
    return types.length > 0 ? { type: "text", text, marks: types } : { type: "text", text };
  });
  const names = blocks.split(" ");
  const leaf = names[names.length - 1];
  let node: JSONContent = leaf.startsWith("heading")
    ? { type: "heading", attrs: { level: Number(leaf.slice("heading".length)) }, content }
    : { type: "paragraph", content };
  for (let i = names.length - 2; i >= 0; i--) node = { type: "blockquote", content: [node] };
  return { type: "doc", content: [node] };
}

/** Where a match (from findInChapter on this text) is in the chapter's whole Markdown: offsets, for EditorHandle.selectMarkdown. */
export function matchOffsets(markdown: string, match: SearchMatch): { from: number; to: number } {
  const lines = markdown.split("\n");
  let start = 0;
  for (let i = 0; i < match.line && i < lines.length; i++) start += lines[i].length + 1;
  return { from: start + match.from, to: start + match.to };
}
