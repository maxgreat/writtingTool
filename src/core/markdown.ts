import type { Editor, Extensions, JSONContent } from "@tiptap/core";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * Scene breaks are stored as `***`, the separator the chapter file rules use.
 * Tiptap's own horizontal rule would write `---`.
 */
const SceneBreak = HorizontalRule.extend({
  renderMarkdown: () => "***",
});

/**
 * How chapter text is written to Markdown, so that it reads back exactly as
 * typed. @tiptap/markdown encodes `&`, `<` and `>` as HTML entities ("Smith &
 * Wesson" would be saved as "Smith &amp; Wesson"); this writes text as typed
 * and backslash-escapes only Markdown syntax: the inline delimiters, `&` and
 * `<` where they would start an entity or a tag, block syntax at the start
 * of a paragraph, and a closing `#` run at the end of a heading. (Edge
 * spaces are removed before this runs; see `trimBlockEdges`.)
 */
export function escapeChapterText(text: string, node?: JSONContent, parent?: JSONContent): string {
  const out = text
    .replace(/([\\`*_[\]~])/g, "\\$1")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<");
  const siblings = parent?.content ?? [];
  if (parent?.type === "paragraph" && siblings[0] === node) return escapeParagraphStart(out);
  if (parent?.type === "heading" && siblings[siblings.length - 1] === node) {
    return out.replace(/(^|[ \t])(#+)$/u, "$1\\$2");
  }
  return out;
}

/**
 * Spaces and tabs at the start and end of a paragraph or heading are not
 * written: Markdown drops them on reading (and reads four leading spaces as
 * code). They are removed from the document before it is written, dropping
 * text nodes that end up empty, so no bold or italic markers are written
 * around nothing.
 */
export function trimBlockEdges(node: JSONContent): JSONContent {
  if (node.type !== "paragraph" && node.type !== "heading") {
    return node.content ? { ...node, content: node.content.map(trimBlockEdges) } : node;
  }
  const content = [...(node.content ?? [])];
  while (content[0]?.type === "text") {
    const text = (content[0].text ?? "").replace(/^[ \t]+/u, "");
    if (text) {
      content[0] = { ...content[0], text };
      break;
    }
    content.shift();
  }
  while (content.at(-1)?.type === "text") {
    const last = content.length - 1;
    const text = (content[last].text ?? "").replace(/[ \t]+$/u, "");
    if (text) {
      content[last] = { ...content[last], text };
      break;
    }
    content.pop();
  }
  return { ...node, content };
}

/**
 * A paragraph typed to start like a heading, list, quote or rule
 * ("- Bonjour", "1984. The river froze.", "> ") would read back as that block.
 */
function escapeParagraphStart(text: string): string {
  return text
    .replace(/^(?=#{1,6}(?:[ \t]|$))/u, "\\")
    .replace(/^(?=[-+](?:[ \t]|$))/u, "\\")
    .replace(/^(?=-[ \t]*-[ \t]*-[- \t]*$)/u, "\\")
    .replace(/^(\d{1,9})(?=[.)](?:[ \t]|$))/u, "$1\\")
    .replace(/^(?=>)/u, "\\");
}

const ChapterMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    type Encoder = (text: string, node?: JSONContent, parent?: JSONContent) => string;
    type Serializer = (doc: JSONContent | JSONContent[]) => string;
    const manager = this.editor.markdown as { encodeTextForMarkdown: Encoder; serialize: Serializer } | undefined;
    if (!manager) return;
    manager.encodeTextForMarkdown = escapeChapterText;
    // editor.getMarkdown() calls manager.serialize, so every save is trimmed.
    const serialize = manager.serialize.bind(manager);
    manager.serialize = (doc) => serialize(Array.isArray(doc) ? doc.map(trimBlockEdges) : trimBlockEdges(doc));
  },
});

/**
 * The editor schema for a chapter: the small Markdown subset fiction needs
 * (paragraphs, headings, italics, bold, block quotes, scene breaks) and
 * nothing else. Markdown outside it (lists, code, links, HTML, entities...)
 * is not kept by this schema; see `keepsChapterExactly`.
 */
export function chapterExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      horizontalRule: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,
      link: false,
      hardBreak: false,
    }),
    SceneBreak,
    ChapterMarkdown,
  ];
}

/** Chapter files end with exactly one newline. */
export function withFinalNewline(markdown: string): string {
  return markdown.replace(/\s+$/u, "") + "\n";
}

/**
 * Whether an editor that loaded `markdown` would save it back unchanged.
 * When it would not (the chapter uses Markdown outside the subset, such as a
 * paragraph indented by four spaces or dialogue lines starting with "- "),
 * the formatted editor must not save, or that text would be lost.
 */
export function keepsChapterExactly(editor: Editor, markdown: string): boolean {
  return withFinalNewline(editor.getMarkdown()) === withFinalNewline(markdown);
}
