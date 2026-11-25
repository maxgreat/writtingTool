import { describe, expect, it } from "vitest";
import { chapterMarkdown } from "../markdown";
import { markdownText } from "../readable";
import { findInBook, findInChapter, matchOffsets, replaceInChapter, type SearchOptions } from "../search";

const PLAIN: SearchOptions = { matchCase: false, wholeWord: false };
const CHAPTER = [
  "# The arrival",
  "",
  "Elena reached the Harbor Inn at dusk, *soaked to the bone*.",
  "",
  "“You’re late,” said **Arno**. The harbor was quiet.",
  "",
  "***",
  "",
  "> A quote about the harbor\\* star",
].join("\n");

const texts = (query: string, options = PLAIN) => findInChapter("c", CHAPTER, query, options).map((m) => m.text);

describe("finding text in a chapter", () => {
  it("finds text as it reads, without Markdown's markers", () => {
    const [match] = findInChapter("c", CHAPTER, "soaked to the", PLAIN);
    expect(match).toMatchObject({ line: 2, text: "soaked to the", acrossFormatting: false });
    expect(CHAPTER.split("\n")[2].slice(match.from, match.to)).toBe("soaked to the");
    expect(match.before).toBe("Elena reached the Harbor Inn at dusk, ");
    expect(match.after).toBe(" bone.");
  });

  it("follows the options: case and whole words", () => {
    expect(texts("harbor")).toEqual(["Harbor", "harbor", "harbor"]);
    expect(texts("harbor", { matchCase: true, wholeWord: false })).toEqual(["harbor", "harbor"]);
    expect(texts("arr", { matchCase: false, wholeWord: true })).toEqual([]);
    expect(texts("arrival", { matchCase: false, wholeWord: true })).toEqual(["arrival"]);
  });

  it("matches apostrophes and quotes whichever way they are typed", () => {
    expect(texts("you're late,\"")).toEqual(["You’re late,”"]);
  });

  it("marks a match that runs across formatting, and reads escapes as text", () => {
    const [across] = findInChapter("c", CHAPTER, "dusk, soaked", PLAIN);
    expect(across.acrossFormatting).toBe(true);
    const [escaped] = findInChapter("c", CHAPTER, "harbor* star", PLAIN);
    expect(escaped).toMatchObject({ line: 8, text: "harbor* star", acrossFormatting: false });
  });

  it("finds nothing for an empty search, and nothing in scene breaks", () => {
    expect(texts("")).toEqual([]);
    expect(texts("*")).toEqual(["*"]);
  });

  it("searches the whole book in reading order", () => {
    const found = findInBook(
      [
        { id: "one", text: "# One\n\nThe river.\n" },
        { id: "two", text: "# Two\n\nRiver and river.\n" },
      ],
      "river",
      PLAIN,
    );
    expect(found.map((m) => [m.chapterId, m.text])).toEqual([
      ["one", "river"],
      ["two", "River"],
      ["two", "river"],
    ]);
  });
});

describe("replacing", () => {
  it("replaces each match in the Markdown, keeping the formatting around it", () => {
    const matches = findInChapter("c", CHAPTER, "harbor", PLAIN);
    const { text, replaced } = replaceInChapter(CHAPTER, matches, "port");
    expect(replaced).toBe(3);
    expect(text.split("\n")[2]).toBe("Elena reached the port Inn at dusk, *soaked to the bone*.");
    expect(text.split("\n")[4]).toBe("“You’re late,” said **Arno**. The port was quiet.");
    expect(text.split("\n")[8]).toBe("> A quote about the port\\* star");
  });

  it("leaves matches across formatting as they are", () => {
    const matches = findInChapter("c", CHAPTER, "dusk, soaked", PLAIN);
    expect(replaceInChapter(CHAPTER, matches, "x")).toEqual({ text: CHAPTER, replaced: 0 });
  });

  it("takes an escape away with the escaped character it starts with", () => {
    const deleted = replaceInChapter(CHAPTER, findInChapter("c", CHAPTER, "* star", PLAIN), "");
    expect(deleted.text.split("\n")[8]).toBe("> A quote about the harbor");
    const sic = "He said \\[sic\\] twice.";
    expect(replaceInChapter(sic, findInChapter("c", sic, "[sic]", PLAIN), "sic").text).toBe("He said sic twice.");
    const starred = replaceInChapter(CHAPTER, findInChapter("c", CHAPTER, "* star", PLAIN), "*x");
    expect(starred.text.split("\n")[8]).toBe("> A quote about the harbor\\*x");
  });

  it("keeps italics and bold readable when the whole of one is replaced or deleted", () => {
    const replace = (text: string, query: string, replacement: string) =>
      replaceInChapter(text, findInChapter("c", text, query, PLAIN), replacement).text;
    expect(replace("He was *very* tired.", "very", "")).toBe("He was  tired.");
    expect(replace("**Arno** left.", "Arno", "")).toBe("left.");
    expect(replace("Say *hello* now.", "hello", " hi")).toBe("Say  *hi* now.");
    expect(replace("Say *hello* now.", "hello", "hi ")).toBe("Say *hi*  now.");
    expect(replace("Say *hello* now.", "hello", "hi")).toBe("Say *hi* now.");
    // Markers that belong to the word before stay where they are.
    expect(replace("*a*b and more", "b", " c")).toBe("*a* c and more");
    expect(replace("Say *hello world* now.", "hello", " hi")).toBe("Say  *hi world* now.");
  });

  it("keeps italics and bold readable when a match opens or closes one without filling it", () => {
    const replace = (text: string, query: string, replacement: string) =>
      replaceInChapter(text, findInChapter("c", text, query, PLAIN), replacement).text;
    expect(replace("She was *very tired* today.", "very", "")).toBe("She was  *tired* today.");
    expect(replace("*tired very* now", "very", "")).toBe("*tired*  now");
    expect(replace("*Very well,* she said.", "Very", "")).toBe("*well,* she said.");
    expect(replace("> *Very well,* she said.", "Very", "")).toBe("> *well,* she said.");
    expect(replace("**Arno**, he said", ", he", " he")).toBe("**Arno** he said");
    expect(replace("*very* good", "very", " so")).toBe("*so* good");
    // Text written as in plain mode keeps its own markers.
    expect(replace("_tired very_ now", "very", "")).toBe("_tired_  now");
  });

  it("removes a paragraph whose text is all deleted, with the blank line that set it apart", () => {
    const remove = (text: string, query: string) => replaceInChapter(text, findInChapter("c", text, query, PLAIN), "");
    expect(remove("A\n\n*very*\n\nB", "very")).toEqual({ text: "A\n\nB", replaced: 1 });
    expect(remove("Intro.\n\nTK\n\nTK\n\nEnd.\n", "TK")).toEqual({ text: "Intro.\n\nEnd.\n", replaced: 2 });
    expect(remove("Intro.\n\n> TK", "TK")).toEqual({ text: "Intro.", replaced: 1 });
    expect(remove("TK\n\nEnd.", "TK")).toEqual({ text: "End.", replaced: 1 });
    expect(remove("Intro.\n\nTK\nTK\n\nEnd.", "TK")).toEqual({ text: "Intro.\n\nEnd.", replaced: 2 });
  });

  it("removes only the emptied line of a paragraph that goes on, so the paragraphs around it stay apart", () => {
    const remove = (text: string, query: string) => replaceInChapter(text, findInChapter("c", text, query, PLAIN), "").text;
    expect(remove("She left.\nTK\n\nThe next day.", "TK")).toBe("She left.\n\nThe next day.");
    expect(remove("Intro.\n\nTK\nShe left.", "TK")).toBe("Intro.\n\nShe left.");
    expect(remove("> A\n> TK\n\nEnd.", "TK")).toBe("> A\n\nEnd.");
  });

  it("leaves emptied lines whose going would change the blocks around them", () => {
    const remove = (text: string) => replaceInChapter(text, findInChapter("c", text, "TK", PLAIN), "");
    // A heading between two paragraphs, with no blank lines: without it, they would read as one.
    const unchanged = (text: string) => expect(remove(text)).toEqual({ text, replaced: 0 });
    unchanged("End of part one.\n## TK\nStart of part two.");
    unchanged("> A\n> # TK\n> B");
    // A heading underlined with "===" or "---": the line under it would be left on its own.
    unchanged("TK\n===\n\nNext.");
    unchanged("TK\n---\n\nNext.");
    // The "===" under a heading, emptied: the heading would read as text.
    const underline = (text: string) => replaceInChapter(text, findInChapter("c", text, "===", PLAIN), "");
    expect(underline("Title\n===\n\nText.")).toEqual({ text: "Title\n===\n\nText.", replaced: 0 });
    expect(underline("Part One\n===\nIt began.")).toEqual({ text: "Part One\n===\nIt began.", replaced: 0 });
    // Indented text after it would become code.
    unchanged("TK\n    indented");
    // Other replacements in the chapter are still made.
    expect(remove("Arno TK left.\n\nEnd.\n## TK\nStart.")).toEqual({ text: "Arno  left.\n\nEnd.\n## TK\nStart.", replaced: 1 });
  });

  it("reads a paragraph written on several lines as a whole", () => {
    const replace = (text: string, query: string, replacement: string) =>
      replaceInChapter(text, findInChapter("c", text, query, PLAIN), replacement);
    // Italics from one line to the next stay whole, or nothing changes.
    expect(replace("She whispered, _I never\nwanted this._", "I never", "")).toEqual({ text: "She whispered, _I never\nwanted this._", replaced: 0 });
    expect(replace("_She\nleft._", "left.", "")).toEqual({ text: "_She\nleft._", replaced: 0 });
    expect(replace("She whispered, _I never\nwanted this._", "never", "always")).toEqual({
      text: "She whispered, _I always\nwanted this._",
      replaced: 1,
    });
    expect(replace("> She said *yes\n> TK* and went.", "TK", "no")).toEqual({ text: "> She said *yes\n> no* and went.", replaced: 1 });
    // Two spaces left before a line end would read as a line break: spaces a replacement leaves at a line's end go,
    // unless the line already ended with one.
    expect(replace("Arno TK TK\nleft.", "TK", "")).toEqual({ text: "Arno\nleft.", replaced: 2 });
    expect(replace("_Arno_ TK TK\nleft.", "TK", "")).toEqual({ text: "_Arno_\nleft.", replaced: 2 });
    expect(replace("_Arno_ TK \nleft.", "TK", "")).toEqual({ text: "_Arno_ TK \nleft.", replaced: 0 });
    expect(replace("Arno TK\nleft.", "TK", "")).toEqual({ text: "Arno\nleft.", replaced: 1 });
    // Each paragraph is read where it is, after the one before it.
    expect(replace("_TK\n*TK*\n\nTK", "TK", "")).toEqual({ text: "_", replaced: 3 });
  });

  it("reads each line where it is: in a list, an indented line is the item's", () => {
    const replace = (text: string, query: string, replacement: string) =>
      replaceInChapter(text, findInChapter("c", text, query, PLAIN), replacement);
    const chapter = "- Bonjour, dit-il.\n\n\t*Vraiment* ? Elle sourit.";
    expect(replace(chapter, "Vraiment", "")).toEqual({ text: chapter, replaced: 0 });
    expect(replace(chapter, "Vraiment", " so")).toEqual({ text: chapter, replaced: 0 });
    expect(replace(chapter, "sourit", "rit")).toEqual({ text: "- Bonjour, dit-il.\n\n\t*Vraiment* ? Elle rit.", replaced: 1 });
    // A paragraph written with spaces before it is read from its text.
    expect(replace("  Elle sourit.", "sourit", "rit")).toEqual({ text: "  Elle rit.", replaced: 1 });
    expect(replace(">   Elle sourit.", "Elle", "Il")).toEqual({ text: ">   Il sourit.", replaced: 1 });
    expect(replace("  Elle sourit.\nEt partit.", "partit", "resta")).toEqual({ text: "  Elle sourit.\nEt resta.", replaced: 1 });
    expect(replace("- Bonjour.\n\n\tElle sourit.", "Elle", "Il")).toEqual({ text: "- Bonjour.\n\n\tIl sourit.", replaced: 1 });
  });

  it("removes an emptied paragraph of a quote with the \">\" line that set it apart", () => {
    const remove = (text: string) => replaceInChapter(text, findInChapter("c", text, "TK", PLAIN), "");
    expect(remove("> She said:\n>\n> TK\n\nEnd.")).toEqual({ text: "> She said:\n\nEnd.", replaced: 1 });
    expect(remove("> TK\n>\n> B\n\nEnd.")).toEqual({ text: "> B\n\nEnd.", replaced: 1 });
    expect(remove("> A\n>\n> TK\n>\n> B")).toEqual({ text: "> A\n>\n> B", replaced: 1 });
    expect(remove("P\n\n> TK\n>\n> TK\n\nEnd.")).toEqual({ text: "P\n\nEnd.", replaced: 2 });
    expect(remove("> > A\n> >\n> > TK\n>\n> B")).toEqual({ text: "> > A\n>\n> B", replaced: 1 });
  });

  it("reads entities as the formatted editor does", () => {
    const replace = (text: string, query: string, replacement: string) =>
      replaceInChapter(text, findInChapter("c", text, query, PLAIN), replacement);
    // "&amp;" reads "&": the line is changed only where it is written as itself, and never written anew.
    expect(replace("Fish &amp; chips", "chips", "peas")).toEqual({ text: "Fish &amp; peas", replaced: 1 });
    expect(replace("# Fish &amp; chips", "chips", "chips #")).toEqual({ text: "# Fish &amp; chips \\#", replaced: 1 });
    // Text that would become an entity is escaped, so it still reads as typed.
    expect(replace("&amp x;", " x", "").text).toBe("\\&amp;");
  });

  it("leaves a match whose line doesn't read as the match says", () => {
    const stale = findInChapter("c", "He was *very* tired.", "very", PLAIN);
    expect(replaceInChapter("He was a very tired.", stale, "so")).toEqual({ text: "He was a very tired.", replaced: 0 });
  });

  it("keeps a line the formatted editor writes as it is written that way", () => {
    const manager = chapterMarkdown();
    const lines = ["*Very well,* she said.", "**Arno** left.", "Say *hello there* now.", "> ***Both*** of *them*.", "## A *very* long night"];
    for (const line of lines) {
      expect(manager.serialize(manager.parse(line))).toBe(line);
      for (const query of ["very", "Arno", "hello", "Both", "them", "long", "night", "well"]) {
        for (const replacement of ["", " so", "so ", "x"]) {
          const result = replaceInChapter(line, findInChapter("c", line, query, PLAIN), replacement).text;
          expect(manager.serialize(manager.parse(result)), `${line} / ${query} → ${JSON.stringify(replacement)}`).toBe(result);
        }
      }
    }
  });

  it("keeps a paragraph a paragraph when its start is replaced", () => {
    const replace = (text: string, query: string, replacement: string) =>
      replaceInChapter(text, findInChapter("c", text, query, PLAIN), replacement).text;
    expect(replace("\\- Bonjour, dit-elle.", "- Bonjour", "- Salut")).toBe("\\- Salut, dit-elle.");
    expect(replace("1984\\. The river froze.", "1984. The", "1985. The")).toBe("1985\\. The river froze.");
    expect(replace("Chapter one ends.", "Chapter", "# Chapter")).toBe("\\# Chapter one ends.");
    expect(replace("> \\- Non.", "- Non", "- Si")).toBe("> \\- Si.");
    // A heading stays a heading, and a start the replacement doesn't touch is left alone.
    expect(replace("# The arrival", "The", "A")).toBe("# A arrival");
    expect(replace("Then - so it goes.", "so", "- so")).toBe("Then - - so it goes.");
  });

  it("writes a replacement's Markdown markers as text", () => {
    expect(markdownText("*really* _so_")).toBe("\\*really\\* \\_so\\_");
    const matches = findInChapter("c", CHAPTER, "Arno", PLAIN);
    expect(replaceInChapter(CHAPTER, matches, "A*").text.split("\n")[4]).toContain("**A\\***");
  });
});

describe("where a match is", () => {
  it("is found in the chapter's whole Markdown", () => {
    for (const match of findInChapter("c", CHAPTER, "harbor", PLAIN)) {
      const { from, to } = matchOffsets(CHAPTER, match);
      expect(CHAPTER.slice(from, to).toLowerCase().replace("\\", "")).toBe("harbor");
    }
  });
});
