// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chapterExtensions, keepsChapterExactly, withFinalNewline } from "../markdown";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

function roundTrip(markdown: string): string {
  const editor = new Editor({
    extensions: chapterExtensions(),
    content: markdown,
    contentType: "markdown",
  });
  editors.push(editor);
  return withFinalNewline(editor.getMarkdown());
}

function chapterFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return chapterFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

describe("Markdown round trip", () => {
  const manuscript = join(__dirname, "../../../sample-project/MyNovel/manuscript");

  it.each(chapterFiles(manuscript))("keeps %s byte for byte", (path) => {
    const original = readFileSync(path, "utf8");
    expect(roundTrip(original)).toBe(original);
  });

  it.each([
    ["paragraph", "Plain text.\n"],
    ["chapter title", "# The arrival\n"],
    ["heading", "## A heading\n"],
    ["italic", "She was *soaked* through.\n"],
    ["bold", "**Three days** upstream.\n"],
    ["bold inside italic", "*very **wet** indeed*\n"],
    ["block quote", "> Every crossing has a price.\n"],
    ["scene break", "Before.\n\n***\n\nAfter.\n"],
    ["curly quotes and dashes", "“You’re late,” she said — twice.\n"],
    ["accented names", "Élodie met Zoë at the café.\n"],
  ])("keeps a %s", (_label, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it.each([
    ["ampersands", "Smith & Wesson, AT&T and R&D.\n"],
    ["angle brackets", "If a < b, then b > a.\n"],
  ])("keeps %s as typed", (_label, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("saves typed text that looks like an entity or a tag so it reads back the same", () => {
    const typed = "Use &amp; or &#38; and <em>, a \\ and *stars*.";
    const editor = new Editor({ extensions: chapterExtensions() });
    editors.push(editor);
    editor.commands.insertContent({ type: "paragraph", content: [{ type: "text", text: typed }] });
    const saved = editor.getMarkdown();
    const reloaded = new Editor({ extensions: chapterExtensions(), content: saved, contentType: "markdown" });
    editors.push(reloaded);
    expect(reloaded.getText()).toBe(typed);
    expect(roundTrip(saved)).toBe(withFinalNewline(saved));
  });
});

describe("typed text that looks like Markdown", () => {
  // What the formatted editor saves must read back as the same text, so the
  // chapter stays editable in formatted mode.
  function saveAndReload(block: JSONContent): { saved: string; text: string; exact: boolean } {
    const editor = new Editor({ extensions: chapterExtensions(), content: { type: "doc", content: [block] } });
    editors.push(editor);
    const saved = editor.getMarkdown();
    const reloaded = new Editor({ extensions: chapterExtensions(), content: saved, contentType: "markdown" });
    editors.push(reloaded);
    return { saved, text: reloaded.getText(), exact: keepsChapterExactly(reloaded, saved) };
  }
  const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });

  it.each([
    "- Bonjour, dit-elle.",
    "+ plus",
    "1984. The river froze.",
    "3) three",
    "> not a quote",
    ">no space",
    "# not a heading",
    "###### six",
    "---",
    "- - -",
    "    four spaces",
    "\ttab",
    "  two spaces",
    "Smith & Wesson <em> &amp;",
    "She left. ",
    "  both ends\t",
  ])("keeps a paragraph typed as %j", (typed) => {
    // Spaces and tabs at the edges are not written: Markdown drops them.
    const result = saveAndReload(paragraph(typed));
    expect(result.text).toBe(typed.trim());
    expect(result.exact).toBe(true);
  });

  it.each(["Learning C #", "Learning C#", "#", "The arrival ", " Leading space"])(
    "keeps a heading typed as %j",
    (typed) => {
      const result = saveAndReload({ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: typed }] });
      expect(result.text).toBe(typed.trim());
      expect(result.exact).toBe(true);
    },
  );

  const text = (value: string, mark?: string): JSONContent =>
    mark ? { type: "text", text: value, marks: [{ type: mark }] } : { type: "text", text: value };

  it.each([
    ["an italic space at the end", { type: "paragraph", content: [text("She whispered"), text(" ", "italic")] }, "She whispered"],
    ["a paragraph that is only a bold space", { type: "paragraph", content: [text(" ", "bold")] }, ""],
    ["spaces before italic text", { type: "paragraph", content: [text("  "), text("She", "italic"), text(" left. ")] }, "*She* left."],
    ["a bold space at the end of a heading", { type: "heading", attrs: { level: 1 }, content: [text("Title"), text(" ", "bold")] }, "# Title"],
  ])("writes no empty markers for %s", (_label, block, expected) => {
    const result = saveAndReload(block as JSONContent);
    expect(result.saved).toBe(expected);
    expect(result.exact).toBe(true);
  });

  it("does not escape the same characters inside a paragraph", () => {
    expect(saveAndReload(paragraph("She said - twice - and 3. no more.")).saved).toBe("She said - twice - and 3. no more.");
  });
});

describe("keepsChapterExactly", () => {
  function keeps(markdown: string): boolean {
    const editor = new Editor({ extensions: chapterExtensions(), content: markdown, contentType: "markdown" });
    editors.push(editor);
    return keepsChapterExactly(editor, markdown);
  }

  it("is true for chapters inside the subset", () => {
    expect(keeps("# One\n\nShe was *soaked*.\n\n> A quote.\n\n***\n\nSmith & Wesson.\n")).toBe(true);
  });

  // Each of these would be changed or lost by a save from the formatted editor.
  it.each([
    ["paragraph indented by four spaces", "Before.\n\n    Indented like a code block.\n"],
    ["paragraph indented by a tab", "Before.\n\n\tIndented with a tab.\n"],
    ["dialogue lines starting with a hyphen", "- Bonjour, dit-elle.\n- Bonsoir.\n"],
    ["paragraph starting with a year between others", "Before.\n\n1984. The river froze.\n\nAfter.\n"],
    ["fenced code", "```\nlet x = 1;\n```\n"],
    ["table", "| A | B |\n|---|---|\n| 1 | 2 |\n"],
    ["HTML comment on its own line", "<!-- note to self -->\n\nText.\n"],
    ["HTML inside a paragraph", "She left. <!-- check the date --> <u>Very</u> late.\n"],
    ["reference definition", "See [the map][m].\n\n[m]: https://example.com/map\n"],
    ["inline code", "Type `ls -la` and wait.\n"],
    ["link", "Read [the guide](https://example.com) first.\n"],
    ["image on its own line", "![A map](map.png)\n"],
    ["strikethrough", "It was ~~red~~ blue.\n"],
    ["line break", "First line  \nsecond line.\n"],
    ["entity", "A&nbsp;space and AT&amp;T.\n"],
    ["heading below level 3", "#### Deep\n"],
  ])("is false for a %s", (_label, markdown) => {
    expect(keeps(markdown)).toBe(false);
  });
});

describe("withFinalNewline", () => {
  it("adds a missing newline", () => {
    expect(withFinalNewline("Text")).toBe("Text\n");
  });
  it("collapses trailing blank lines", () => {
    expect(withFinalNewline("Text\n\n\n")).toBe("Text\n");
  });
});
