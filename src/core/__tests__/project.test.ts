import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNameMatcher,
  buildProject,
  chapterTitle,
  parseSheet,
  splitFrontMatter,
  withChapterText,
  withSheetText,
  type ProjectSnapshot,
} from "../project";
import { countWords } from "../words";

const sampleRoot = join(__dirname, "../../../sample-project/MyNovel");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function sampleSnapshot(): ProjectSnapshot {
  const files = ["manuscript", "sheets"].flatMap((dir) =>
    walk(join(sampleRoot, dir))
      .filter((p) => p.endsWith(".md"))
      .map((p) => ({ path: relative(sampleRoot, p).split(sep).join("/"), text: readFileSync(p, "utf8") })),
  );
  return {
    root: sampleRoot,
    folderName: "MyNovel",
    projectJson: readFileSync(join(sampleRoot, "project.json"), "utf8"),
    files,
    skipped: [],
  };
}

describe("buildProject", () => {
  const project = buildProject(sampleSnapshot());

  it("reads the binder: parts as folders, chapters in file-name order", () => {
    expect(project.title).toBe("The Ferryman’s Debt");
    expect(project.binder.map((b) => (b.type === "part" ? b.title : b.id))).toEqual([
      "Part 1 - Arrival",
      "Part 2 - The river",
    ]);
    expect(project.chapterOrder.map((id) => project.chapters[id].title)).toEqual([
      "The arrival",
      "The ferryman",
      "Upstream",
    ]);
    expect(project.problems).toEqual([]);
  });

  it("takes status, point of view and synopsis from project.json", () => {
    const first = project.chapters["manuscript/Part 1 - Arrival/01 The arrival.md"];
    expect(first.status).toBe("Revised");
    expect(first.pov).toBe("Elena Voss");
    expect(first.wordCount).toBeGreaterThan(50);
  });

  it("reads sheets with their aliases and fields", () => {
    const kell = project.sheets.find((s) => s.name === "Arno Kell")!;
    expect(kell.kind).toBe("characters");
    expect(kell.aliases).toEqual([
      { text: "Arno", ignoreCase: false },
      { text: "Kell", ignoreCase: false },
      { text: "the ferryman", ignoreCase: true },
    ]);
    expect(kell.fields).toEqual([
      ["role", "Ferryman"],
      ["age", "61"],
    ]);
    expect(project.sheetTypes.map((t) => t.folder)).toEqual(["characters", "places", "notes"]);
  });

  it("highlights characters and places but not notes", () => {
    const matcher = buildNameMatcher(project.sheets);
    const text = "The ferryman took Elena up the Sel past the Magic system.";
    expect(matcher.find(text).map((m) => text.slice(m.from, m.to))).toEqual(["The ferryman", "Elena", "Sel"]);
  });

  it("orders chapters numerically and keeps loose chapters at the top level", () => {
    const p = buildProject({
      root: "/x",
      folderName: "Loose",
      projectJson: null,
      files: [
        { path: "manuscript/10 Ten.md", text: "# Ten\n" },
        { path: "manuscript/2 Two.md", text: "No heading here.\n" },
      ],
      skipped: ["manuscript/bad.md"],
    });
    expect(p.title).toBe("Loose");
    expect(p.chapterOrder).toEqual(["manuscript/2 Two.md", "manuscript/10 Ten.md"]);
    expect(p.chapters["manuscript/2 Two.md"].title).toBe("Two");
    expect(p.problems).toHaveLength(1);
    expect(p.sheetTypes.map((t) => t.folder)).toEqual(["characters", "places", "notes"]);
  });

  it("reports a broken project.json and falls back to defaults", () => {
    const p = buildProject({ root: "/x", folderName: "F", projectJson: "{oops", files: [], skipped: [] });
    expect(p.title).toBe("F");
    expect(p.problems[0]).toMatch(/project\.json could not be read/u);
  });

  it("updates text, title and word count of one chapter", () => {
    const id = project.chapterOrder[0];
    const next = withChapterText(project, id, "# New title\n\nThree small words.\n");
    expect(next.chapters[id].title).toBe("New title");
    expect(next.chapters[id].wordCount).toBe(3);
    expect(next.sheets).toBe(project.sheets);
    expect(withChapterText(project, id, project.chapters[id].text)).toBe(project);
  });
});

describe("sheets", () => {
  it("splits a YAML header from the body", () => {
    expect(splitFrontMatter("---\nname: A\n---\nBody\n")).toEqual({ header: "name: A", body: "Body\n" });
    expect(splitFrontMatter("No header")).toEqual({ header: null, body: "No header" });
  });

  it("falls back to the file name and reports a broken header", () => {
    const problems: string[] = [];
    const sheet = parseSheet("sheets/places/Old Mill.md", "---\nname: [unclosed\n---\nNotes", problems);
    expect(sheet.name).toBe("Old Mill");
    expect(sheet.kind).toBe("places");
    expect(problems).toHaveLength(1);
  });
});

describe("chapterTitle and countWords", () => {
  it("uses the first heading, or the file name without its number", () => {
    expect(chapterTitle("manuscript/01 The arrival.md", "# Arrival #\n")).toBe("Arrival");
    expect(chapterTitle("manuscript/01 The arrival.md", "Text\n")).toBe("The arrival");
  });

  it("keeps a # that is part of the title and drops backslash escapes", () => {
    expect(chapterTitle("manuscript/01 x.md", "# Learning C#\n")).toBe("Learning C#");
    expect(chapterTitle("manuscript/01 x.md", "# Learning C \\#\n")).toBe("Learning C #");
    expect(chapterTitle("manuscript/01 x.md", "# My\\_Title\n")).toBe("My_Title");
  });

  it("lists what the Rust core left out first among the problems", () => {
    const project = buildProject({
      root: "/p",
      folderName: "p",
      projectJson: null,
      files: [],
      skipped: ["manuscript/bad.md"],
      problems: ["The manuscript folder is a link to another place, so it was left out."],
    });
    expect(project.problems[0]).toContain("manuscript folder is a link");
    expect(project.problems[1]).toContain("manuscript/bad.md");
  });

  it("counts prose words and leaves markers and the title out", () => {
    expect(countWords("# Title words\n\n*Soaked* to the **bone**.\n\n***\n\nJean-Luc didn’t.\n")).toBe(6);
  });

  it("does not count character references such as the &nbsp; of an empty paragraph", () => {
    expect(countWords("A\n\n\n\n&nbsp;\n\nB&#32;C\n")).toBe(3);
  });
});

describe("sheet templates and edits", () => {
  const base = {
    root: "/p",
    folderName: "P",
    files: [{ path: "sheets/creatures/Wyrm.md", text: "---\nname: Wyrm\n---\n" }],
    skipped: [],
  };

  it("gives the default types their templates, and reads templates from project.json", () => {
    const defaults = buildProject({ ...base, projectJson: null });
    expect(defaults.sheetTypes.map((t) => [t.folder, t.fields])).toEqual([
      ["characters", ["role", "age"]],
      ["places", ["type"]],
      ["notes", []],
      ["creatures", []],
    ]);
    const json = JSON.stringify({
      sheetTypes: [
        { folder: "characters", label: "People" },
        { folder: "creatures", label: "Creatures", fields: ["habitat", " habitat ", 3, "name", " aliases", "", "diet "] },
      ],
    });
    const custom = buildProject({ ...base, projectJson: json });
    expect(custom.sheetTypes.map((t) => [t.folder, t.fields])).toEqual([
      ["characters", ["role", "age"]],
      ["creatures", ["habitat", "diet"]],
    ]);
  });

  it("keeps each sheet's file text, and marks a header it can't read", () => {
    const project = buildProject({
      ...base,
      projectJson: null,
      files: [...base.files, { path: "sheets/places/Bad.md", text: "---\nname: [x\n---\n" }],
    });
    expect(project.sheets.map((s) => [s.name, s.editable, s.text])).toEqual([
      ["Wyrm", true, "---\nname: Wyrm\n---\n"],
      ["Bad", false, "---\nname: [x\n---\n"],
    ]);
  });

  it("replaces or adds a sheet, in path order, with a type for a new folder", () => {
    const project = buildProject({ ...base, projectJson: null });
    expect(withSheetText(project, "sheets/creatures/Wyrm.md", "---\nname: Wyrm\n---\n")).toBe(project);
    const renamed = withSheetText(project, "sheets/creatures/Wyrm.md", "---\nname: Great Wyrm\n---\n");
    expect(renamed.sheets.map((s) => s.name)).toEqual(["Great Wyrm"]);
    const added = withSheetText(renamed, "sheets/beasts/Ox.md", "---\nname: Ox\n---\n");
    expect(added.sheets.map((s) => s.id)).toEqual(["sheets/beasts/Ox.md", "sheets/creatures/Wyrm.md"]);
    expect(added.sheetTypes.at(-1)).toEqual({ folder: "beasts", label: "Beasts", fields: [] });
    expect(added.chapters).toBe(project.chapters);
  });
});
