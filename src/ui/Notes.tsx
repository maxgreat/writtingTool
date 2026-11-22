import type { ReactNode } from "react";

/**
 * Renders a sheet's notes: paragraphs, headings, quotes, lists, scene breaks,
 * bold and italic. React elements only, never HTML strings, so whatever is in
 * a sheet file is shown as text.
 */
export function Notes({ markdown }: { markdown: string }) {
  const blocks = markdown.split(/\n\s*\n/u).map((block) => block.trim()).filter(Boolean);
  return <div className="notes">{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

function renderBlock(block: string, key: number): ReactNode {
  const lines = block.split("\n");
  if (/^(?:\*\s*){3,}$/u.test(block)) return <hr key={key} />;
  const heading = /^#{1,6}\s+(.*)$/u.exec(block);
  if (heading && lines.length === 1) return <h4 key={key}>{inline(heading[1])}</h4>;
  if (lines.every((line) => /^\s*>/u.test(line))) {
    return <blockquote key={key}>{inline(lines.map((l) => l.replace(/^\s*>\s?/u, "")).join(" "))}</blockquote>;
  }
  if (lines.every((line) => /^\s*[-*+]\s+/u.test(line))) {
    return (
      <ul key={key}>
        {lines.map((line, i) => (
          <li key={i}>{inline(line.replace(/^\s*[-*+]\s+/u, ""))}</li>
        ))}
      </ul>
    );
  }
  return <p key={key}>{inline(lines.join(" "))}</p>;
}

/**
 * Bold (`**` or `__`) and italic (`*` or `_`) runs; everything else is text.
 * Underscores only count at word edges, so snake_case stays as it is.
 */
const INLINE = /\*\*(.+?)\*\*|(?<![\p{L}\p{N}])__(.+?)__(?![\p{L}\p{N}])|\*(.+?)\*|(?<![\p{L}\p{N}])_(.+?)_(?![\p{L}\p{N}])/gu;

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const bold = match[1] ?? match[2];
    if (bold !== undefined) parts.push(<strong key={index}>{inline(bold)}</strong>);
    else parts.push(<em key={index}>{inline(match[3] ?? match[4])}</em>);
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
