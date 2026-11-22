/**
 * A caret position both editors understand: which text block it is in and how
 * many visible characters into that block. Blocks are paragraphs, headings and
 * scene breaks, in document order; Markdown markers are not visible
 * characters. Switching modes maps the caret through this position.
 */
export interface TextPosition {
  block: number;
  offset: number;
}

interface LineBlock {
  /** Offset of the line start in the Markdown text. */
  start: number;
  line: string;
}

const QUOTE_SEPARATOR = /^\s*(?:>\s?)+\s*$/u;
const BLOCK_PREFIX = /^\s*(?:>\s?)*(?:#{1,6}\s+)?/u;
const SCENE_BREAK = /^\s*(?:\*\s*){3,}$/u;
/** How the formatted editor writes an empty paragraph that follows another one. */
const EMPTY_PARAGRAPH = /^\s*&nbsp;\s*$/u;

/**
 * The blocks as the formatted editor sees them: lines that are not blank and
 * not a bare `>` between quoted paragraphs, plus the empty paragraphs it
 * makes from extra blank lines. It reads a run of b blank lines as
 * ⌊(b − 1) / 2⌋ empty paragraphs between two blocks, or ⌊b / 2⌋ before the
 * first block, and a `&nbsp;` line as one. An empty paragraph made from blank
 * lines maps to the start of the line that follows it.
 */
function markdownBlocks(markdown: string): LineBlock[] {
  const blocks: LineBlock[] = [];
  let start = 0;
  let blank = 0;
  for (const line of markdown.split("\n")) {
    if (line.trim() === "") {
      blank++;
    } else if (!QUOTE_SEPARATOR.test(line)) {
      const empties = blocks.length === 0 ? Math.floor(blank / 2) : Math.max(0, Math.floor((blank - 1) / 2));
      for (let i = 0; i < empties; i++) blocks.push({ start, line: "" });
      blocks.push({ start, line: EMPTY_PARAGRAPH.test(line) ? "" : line });
      blank = 0;
    }
    start += line.length + 1;
  }
  return blocks;
}

/**
 * Walks a line and returns pairs of [source offset, visible offset] for every
 * position where a visible character starts, plus the end of the line.
 */
function visibleStops(line: string): [number, number][] {
  if (SCENE_BREAK.test(line)) return [[line.length, 0]];
  const stops: [number, number][] = [];
  let i = BLOCK_PREFIX.exec(line)![0].length;
  let visible = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "*" || ch === "_") {
      i++;
      continue;
    }
    stops.push([i, visible]);
    i += ch === "\\" && i + 1 < line.length ? 2 : 1;
    visible++;
  }
  stops.push([line.length, visible]);
  return stops;
}

export function markdownOffsetToPosition(markdown: string, offset: number): TextPosition {
  const blocks = markdownBlocks(markdown);
  if (blocks.length === 0) return { block: 0, offset: 0 };
  let index = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].start <= offset) index = i;
  }
  const { start, line } = blocks[index];
  const inLine = Math.max(0, Math.min(offset - start, line.length));
  let visible = 0;
  for (const [source, vis] of visibleStops(line)) {
    if (source > inLine) break;
    visible = vis;
  }
  return { block: index, offset: visible };
}

export function positionToMarkdownOffset(markdown: string, position: TextPosition): number {
  const blocks = markdownBlocks(markdown);
  if (blocks.length === 0) return 0;
  const { start, line } = blocks[Math.max(0, Math.min(position.block, blocks.length - 1))];
  const stops = visibleStops(line);
  for (const [source, vis] of stops) {
    if (vis >= position.offset) return start + source;
  }
  return start + stops[stops.length - 1][0];
}
