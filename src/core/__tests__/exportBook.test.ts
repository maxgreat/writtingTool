import { describe, expect, it } from "vitest";
import { bookContent, bookOutline, exportFileName, readExportMemory, withExportChoice, withExportPreset } from "../exportBook";
import { PAPERBACK } from "../exportSettings";
import { buildProject } from "../project";

const project = buildProject({
  root: "/p",
  folderName: "P",
  projectJson: JSON.stringify({
    title: "The Debt",
    language: "en-GB",
    author: "A. Writer",
    binder: ["manuscript/00 Prologue.md", "manuscript/Part 1", "manuscript/99 Epilogue.md"],
    export: {
      presets: [{ name: "Mine", settings: { fontSize: 13 } }, { name: "Paperback A5", settings: {} }, { name: " " }],
      last: { preset: "Mine", settings: { pageSize: "a4" }, format: "epub" },
    },
  }),
  files: [
    { path: "manuscript/00 Prologue.md", text: "# Prologue\n\nBefore.\n" },
    { path: "manuscript/Part 1/01 One.md", text: "# One\n\nFirst.\n" },
    { path: "manuscript/Part 1/02 Two.md", text: "# Two\n\nSecond.\n" },
    { path: "manuscript/99 Epilogue.md", text: "# Epilogue\n\nAfter.\n" },
  ],
  folders: ["manuscript", "manuscript/Part 1"],
  skipped: [],
});

describe("the book for export", () => {
  it("lists parts and chapters in binder order, chapters outside parts on their own", () => {
    expect(bookOutline(project).map((s) => [s.part, s.chapters.map((c) => c.title)])).toEqual([
      [null, ["Prologue"]],
      ["Part 1", ["One", "Two"]],
      [null, ["Epilogue"]],
    ]);
  });

  it("takes the chosen chapters with their text, leaving out empty parts", () => {
    const book = bookContent(project, ["manuscript/Part 1/02 Two.md", "manuscript/99 Epilogue.md"], "Me");
    expect(book).toEqual({
      title: "The Debt",
      author: "Me",
      language: "en-GB",
      sections: [
        { part: "Part 1", chapters: [{ title: "Two", markdown: "# Two\n\nSecond.\n" }] },
        { part: null, chapters: [{ title: "Epilogue", markdown: "# Epilogue\n\nAfter.\n" }] },
      ],
    });
  });

  it("reads the project's presets and last choice, leaving out unnamed ones and built-in names", () => {
    const memory = readExportMemory(project.json);
    expect(memory.presets).toEqual([{ name: "Mine", settings: { ...PAPERBACK, fontSize: 13 } }]);
    expect(memory.last).toEqual({ presetName: "Mine", settings: { ...PAPERBACK, pageSize: "a4" }, format: "epub" });
    expect(memory.author).toBe("A. Writer");
    expect(readExportMemory({})).toEqual({ presets: [], last: null, author: "" });
  });

  it("names the file after the title, without characters file systems refuse", () => {
    expect(exportFileName("The Debt: Part 1/2?", "pdf")).toBe("The Debt Part 1 2.pdf");
    expect(exportFileName("  ", "epub")).toBe("Book.epub");
  });
});

describe("what project.json keeps of export", () => {
  it("saves a preset, replacing one of the same name, and refuses built-in names", () => {
    const first = withExportPreset(project, "Mine", { ...PAPERBACK, fontSize: 12 });
    const again = withExportPreset(first.project, " Mine ", { ...PAPERBACK, fontSize: 14 });
    expect(readExportMemory(again.project.json).presets).toEqual([{ name: "Mine", settings: { ...PAPERBACK, fontSize: 14 } }]);
    expect(JSON.parse(again.text).export.last).toEqual({ preset: "Mine", settings: { pageSize: "a4" }, format: "epub" });
    expect(() => withExportPreset(project, "Paperback A5", PAPERBACK)).toThrow("built-in");
    expect(() => withExportPreset(project, "  ", PAPERBACK)).toThrow("name");
  });

  it("remembers the last choice and the author, and nothing when they don't change", () => {
    const write = withExportChoice(project, { format: "pdf", settings: PAPERBACK, author: " B. Writer " }, "Paperback A5")!;
    const memory = readExportMemory(write.project.json);
    expect(memory.last).toEqual({ presetName: "Paperback A5", settings: PAPERBACK, format: "pdf" });
    expect(memory.author).toBe("B. Writer");
    expect(withExportChoice(write.project, { format: "pdf", settings: PAPERBACK, author: "B. Writer" }, "Paperback A5")).toBeNull();
    const cleared = withExportChoice(write.project, { format: "pdf", settings: PAPERBACK, author: "" }, "Paperback A5")!;
    expect("author" in cleared.project.json).toBe(false);
  });
});
