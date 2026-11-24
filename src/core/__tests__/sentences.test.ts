import { describe, expect, it } from "vitest";
import { escapeChapterText } from "../markdown";
import { sentenceAt, sentenceKey, sentenceRanges } from "../sentences";

const texts = (text: string) => sentenceRanges(text).map((r) => text.slice(r.from, r.to));

describe("sentenceRanges", () => {
  it("cuts after end punctuation, closing quotes and brackets", () => {
    expect(texts("Elena slept. Arno didn’t! “Why?” she asked… (Later.) Done")).toEqual([
      "Elena slept.",
      "Arno didn’t!",
      "“Why?”",
      "she asked…",
      "(Later.)",
      "Done",
    ]);
  });

  it("makes the same cuts with or without Markdown emphasis", () => {
    expect(texts("She was *soaked to the bone*. **Stop!** he said.")).toEqual([
      "She was *soaked to the bone*.",
      "**Stop!**",
      "he said.",
    ]);
    expect(texts("She was soaked to the bone. Stop! he said.")).toEqual([
      "She was soaked to the bone.",
      "Stop!",
      "he said.",
    ]);
  });

  it("doesn't end a sentence after a title such as Mr.", () => {
    expect(texts("They met Mr. Kell at noon. Then Mme. Roux.")).toEqual(["They met Mr. Kell at noon.", "Then Mme. Roux."]);
  });

  it("needs a space after the punctuation", () => {
    expect(texts("It cost 3.50 at St.Ives, she said")).toEqual(["It cost 3.50 at St.Ives, she said"]);
    expect(texts("   ")).toEqual([]);
  });
});

describe("sentenceAt", () => {
  it("finds the sentence that holds an offset", () => {
    const text = "Rose left. She smelled the rose. Then slept.";
    const at = (word: string) => {
      const r = sentenceAt(text, text.lastIndexOf(word));
      return text.slice(r.from, r.to);
    };
    expect(at("Rose")).toBe("Rose left.");
    expect(at("rose")).toBe("She smelled the rose.");
    expect(at("slept")).toBe("Then slept.");
  });
});

describe("sentenceKey", () => {
  it("gives the same key in both editors", () => {
    expect(sentenceKey("> She was *soaked*, d’Arwen’s   __coat__ wet.")).toBe("She was soaked, d'Arwen's coat wet.");
    expect(sentenceKey("She was soaked, d'Arwen's coat wet.")).toBe("She was soaked, d'Arwen's coat wet.");
    expect(sentenceKey("## The \\*arrival")).toBe("The arrival");
    expect(sentenceKey("Eléna")).toBe("Eléna");
  });
});

describe("escaped Markdown", () => {
  const keys = (text: string) => sentenceRanges(text).map((r) => sentenceKey(text.slice(r.from, r.to)));

  it("cuts and keys a paragraph's plain text as the formatted editor's text", () => {
    const paragraphs = [
      "[He left.] Mara stayed.",
      "> Mara said. Then *Ida* came.",
      "# Not a heading. Mara!",
      "She said “Stop!” _Mara_ ran.",
      "Price: 3.50 [sic]. Mara? Yes.",
      "A back\\slash. Mara came.",
      "1. Mara first. Then Mr. Kell.",
      "Wow!] Mara <b>x</b> & co.",
    ];
    for (const text of paragraphs) {
      const node = { type: "text", text };
      const written = escapeChapterText(text, node, { type: "paragraph", content: [node] });
      expect(keys(written), written).toEqual(keys(text));
    }
  });

  it("keys a literal quote mark at the start as the formatted editor does", () => {
    expect(sentenceKey("\\> Mara said.")).toBe(sentenceKey("> Mara said."));
    expect(sentenceKey("\\> Mara said.")).toBe("Mara said.");
  });
});
