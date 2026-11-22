import { describe, expect, it } from "vitest";
import { markdownOffsetToPosition, positionToMarkdownOffset } from "../caret";

const chapter = [
  "# The arrival",
  "",
  "Elena reached the *Harbor Inn* at dusk.",
  "",
  "> Every crossing has a price.",
  ">",
  "> Mine is a story.",
  "",
  "***",
  "",
  "Morning came **grey**.",
  "",
].join("\n");

describe("caret mapping", () => {
  it("counts blocks, skipping blank lines and bare quote separators", () => {
    const at = (text: string) => markdownOffsetToPosition(chapter, chapter.indexOf(text));
    expect(at("The arrival")).toEqual({ block: 0, offset: 0 });
    expect(at("Elena")).toEqual({ block: 1, offset: 0 });
    expect(at("Every")).toEqual({ block: 2, offset: 0 });
    expect(at("Mine")).toEqual({ block: 3, offset: 0 });
    expect(at("***")).toEqual({ block: 4, offset: 0 });
    expect(at("Morning")).toEqual({ block: 5, offset: 0 });
  });

  it("does not count Markdown markers as visible characters", () => {
    const offset = chapter.indexOf("Inn*");
    // "Elena reached the Harbor " is 25 visible characters.
    expect(markdownOffsetToPosition(chapter, offset)).toEqual({ block: 1, offset: 25 });
    expect(markdownOffsetToPosition(chapter, chapter.indexOf("grey"))).toEqual({ block: 5, offset: 13 });
  });

  it("maps a position back to the same Markdown offset", () => {
    for (const word of ["arrival", "Harbor", "dusk", "price", "story", "grey"]) {
      const offset = chapter.indexOf(word);
      const position = markdownOffsetToPosition(chapter, offset);
      expect(positionToMarkdownOffset(chapter, position)).toBe(offset);
    }
  });

  it("clamps positions past the end", () => {
    const last = chapter.indexOf("Morning came **grey**.") + "Morning came **grey**.".length;
    expect(positionToMarkdownOffset(chapter, { block: 99, offset: 999 })).toBe(last);
    expect(positionToMarkdownOffset("", { block: 3, offset: 3 })).toBe(0);
    expect(markdownOffsetToPosition("", 10)).toEqual({ block: 0, offset: 0 });
  });

  it("counts an escaped character once", () => {
    const text = "A \\*star\\* here";
    expect(markdownOffsetToPosition(text, text.indexOf("here"))).toEqual({ block: 0, offset: 9 });
  });
});
