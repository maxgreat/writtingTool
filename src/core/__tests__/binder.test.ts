import { describe, expect, it } from "vitest";
import {
  numberedName,
  planMoveChapter,
  planMovePart,
  planNewChapter,
  planNewPart,
  planRenameChapter,
  planRenamePart,
  planRestore,
  planTrashChapter,
  planTrashPart,
  planTrashSheet,
  safeName,
  withChapterDetails,
  withTitle,
  type Plan,
} from "../binder";
import { applyChange, type MemoryTree } from "../memoryFiles";
import { buildProject, type Project } from "../project";

const P1 = "manuscript/Part 1 - Arrival";
const P2 = "manuscript/Part 2 - The river";
const ARRIVAL = `${P1}/01 The arrival.md`;
const FERRYMAN = `${P1}/02 The ferryman.md`;
const UPSTREAM = `${P2}/03 Upstream.md`;

function sample(): MemoryTree {
  const json = {
    version: 1,
    title: "The Ferryman’s Debt",
    chapters: { [ARRIVAL]: { status: "Revised", pov: "Elena" }, [UPSTREAM]: { status: "Idea" } },
    custom: "kept",
  };
  return {
    files: new Map([
      ["project.json", JSON.stringify(json)],
      [ARRIVAL, "# The arrival\n\nElena reached the inn.\n"],
      [FERRYMAN, "# The ferryman\n\nHe waited.\n"],
      [UPSTREAM, "# Upstream\n\nThe river.\n"],
      ["sheets/characters/Elena.md", "---\nname: Elena\n---\n"],
    ]),
    folders: new Set(["manuscript", P1, P2, "sheets", "sheets/characters"]),
  };
}

function read(tree: MemoryTree): Project {
  const inProject = (p: string) => ["manuscript", "trash"].some((top) => p === top || p.startsWith(`${top}/`));
  return buildProject({
    root: "/p",
    folderName: "P",
    projectJson: tree.files.get("project.json") ?? null,
    files: [...tree.files]
      .filter(([path]) => path.endsWith(".md"))
      .map(([path, text]) => ({ path, text })),
    folders: [...tree.folders].filter(inProject),
    skipped: [],
  });
}

function apply(tree: MemoryTree, plan: Plan | null): Project {
  if (!plan) throw new Error("expected a plan");
  for (const change of plan.changes) applyChange(tree, change);
  return read(tree);
}

const paths = (project: Project) => project.chapterOrder;
const json = (tree: MemoryTree) => JSON.parse(tree.files.get("project.json") ?? "{}") as Record<string, unknown>;

describe("moving", () => {
  it("moves a chapter into another part and renumbers the book", () => {
    const tree = sample();
    const plan = planMoveChapter(read(tree), ARRIVAL, { partId: P2, index: 1 });
    const project = apply(tree, plan);
    expect(paths(project)).toEqual([`${P1}/01 The ferryman.md`, `${P2}/02 Upstream.md`, `${P2}/03 The arrival.md`]);
    expect(project.chapters[`${P2}/03 The arrival.md`].status).toBe("Revised");
    expect(project.chapters[`${P2}/02 Upstream.md`].status).toBe("Idea");
    expect(plan.renamed.get(ARRIVAL)).toBe(`${P2}/03 The arrival.md`);
    expect(json(tree).custom).toBe("kept");
  });

  it("swaps two chapters", () => {
    const tree = sample();
    const project = apply(tree, planMoveChapter(read(tree), FERRYMAN, { partId: P1, index: 0 }));
    expect(paths(project)).toEqual([`${P1}/01 The ferryman.md`, `${P1}/02 The arrival.md`, UPSTREAM]);
    expect(project.chapters[`${P1}/01 The ferryman.md`].text).toContain("He waited.");
  });

  it("moves a chapter to the top level, before the parts", () => {
    const tree = sample();
    const project = apply(tree, planMoveChapter(read(tree), UPSTREAM, { partId: null, index: 0 }));
    expect(project.binder.map((b) => b.id)).toEqual(["manuscript/01 Upstream.md", P1, P2]);
    expect(paths(project)).toEqual(["manuscript/01 Upstream.md", `${P1}/02 The arrival.md`, `${P1}/03 The ferryman.md`]);
  });

  it("moves a part and keeps the order on the next read", () => {
    const tree = sample();
    const project = apply(tree, planMovePart(read(tree), P2, 0));
    expect(project.binder.map((b) => b.id)).toEqual([P2, P1]);
    expect(paths(project)).toEqual([`${P2}/01 Upstream.md`, `${P1}/02 The arrival.md`, `${P1}/03 The ferryman.md`]);
  });

  it("pads numbers to the size of the book", () => {
    expect(numberedName("7 Seven.md", 7, 3)).toBe("007 Seven.md");
    expect(numberedName("Prologue.md", 1, 2)).toBe("01 Prologue.md");
    expect(numberedName("12.md", 3, 2)).toBe("03.md");
    expect(numberedName("04 - The end.MD", 5, 2)).toBe("05 The end.MD");
  });

  it("puts chapters added outside the app after the listed ones", () => {
    const tree = sample();
    apply(tree, planMovePart(read(tree), P2, 0));
    tree.files.set(`${P1}/00 Found.md`, "# Found\n");
    expect(paths(read(tree))).toEqual([`${P2}/01 Upstream.md`, `${P1}/02 The arrival.md`, `${P1}/03 The ferryman.md`, `${P1}/00 Found.md`]);
  });
});

describe("adding and renaming", () => {
  it("creates a chapter in a part, with its title as heading", () => {
    const tree = sample();
    const plan = planNewChapter(read(tree), { partId: P1, index: 1 }, "The storm");
    const project = apply(tree, plan);
    expect(plan.created).toBe(`${P1}/02 The storm.md`);
    expect(tree.files.get(`${P1}/02 The storm.md`)).toBe("# The storm\n");
    expect(project.chapters[`${P1}/02 The storm.md`].title).toBe("The storm");
    expect(paths(project)).toEqual([ARRIVAL, `${P1}/02 The storm.md`, `${P1}/03 The ferryman.md`, `${P2}/04 Upstream.md`]);
  });

  it("never gives a new chapter the name of a file the binder doesn't show", () => {
    const tree = sample();
    const project = read(tree);
    const hidden = { ...project, entries: [...project.entries, `${P2}/04 Ending.md`] };
    const plan = planNewChapter(hidden, { partId: P2, index: 1 }, "Ending");
    expect(plan.created).toBe(`${P2}/04 Ending 2.md`);
    expect(plan.changes[0].writes[0]).toMatchObject({ path: `${P2}/04 Ending 2.md`, mustBeNew: true });
    tree.files.set(`${P2}/04 Ending.md`, "kept");
    apply(tree, plan);
    expect(tree.files.get(`${P2}/04 Ending.md`)).toBe("kept");
  });

  it("creates the manuscript folder for a project that has none", () => {
    const tree: MemoryTree = { files: new Map([["project.json", "{}"]]), folders: new Set() };
    const plan = planNewChapter(read(tree), { partId: null, index: 0 }, "Prologue");
    const project = apply(tree, plan);
    expect(paths(project)).toEqual(["manuscript/01 Prologue.md"]);
  });

  it("creates an empty part with a name no other part has", () => {
    const tree = sample();
    let project = apply(tree, planNewPart(read(tree), 2, "Part 3"));
    expect(project.binder.map((b) => b.id)).toEqual([P1, P2, "manuscript/Part 3"]);
    project = apply(tree, planNewPart(project, 0, "part 3"));
    expect(project.binder.map((b) => b.id)).toEqual(["manuscript/part 3 2", P1, P2, "manuscript/Part 3"]);
  });

  it("renames a part's folder; its chapters keep their details", () => {
    const tree = sample();
    const plan = planRenamePart(read(tree), P1, "Part 1 - Departure");
    const project = apply(tree, plan);
    expect(paths(project)[0]).toBe("manuscript/Part 1 - Departure/01 The arrival.md");
    expect(project.chapters["manuscript/Part 1 - Departure/01 The arrival.md"].pov).toBe("Elena");
    expect(planRenamePart(project, "manuscript/Part 1 - Departure", "Part 1 - Departure")).toBeNull();
  });

  it("keeps a title that starts with digits in the file name", () => {
    const tree = sample();
    let plan = planNewChapter(read(tree), { partId: P1, index: 0 }, "1984");
    let project = apply(tree, plan);
    expect(plan.created).toBe(`${P1}/01 1984.md`);
    plan = planRenameChapter(project, FERRYMAN.replace("02", "03"), "3 AM") as Plan;
    project = apply(tree, plan);
    expect(paths(project)).toContain(`${P1}/03 3 AM.md`);
    project = apply(tree, planMoveChapter(project, `${P1}/03 3 AM.md`, { partId: P1, index: 0 }));
    expect(paths(project)[0]).toBe(`${P1}/01 3 AM.md`);
  });

  it("renames a chapter: its heading and its file name", () => {
    const tree = sample();
    const plan = planRenameChapter(read(tree), ARRIVAL, "Day 1: *Arrival* $1");
    const project = apply(tree, plan);
    const id = `${P1}/01 Day 1 Arrival $1.md`;
    expect(plan?.renamed.get(ARRIVAL)).toBe(id);
    expect(project.chapters[id].title).toBe("Day 1: *Arrival* $1");
    expect(project.chapters[id].text).toBe("# Day 1: \\*Arrival\\* $1\n\nElena reached the inn.\n");
    expect(project.chapters[id].status).toBe("Revised");
    expect(planRenameChapter(project, id, "Day 1: *Arrival* $1")).toBeNull();
  });
});

describe("the Trash", () => {
  it("trashes a chapter and puts it back at the end of its part", () => {
    const tree = sample();
    let project = apply(tree, planTrashChapter(read(tree), ARRIVAL));
    expect(paths(project)).toEqual([`${P1}/01 The ferryman.md`, `${P2}/02 Upstream.md`]);
    expect(project.trash).toEqual([
      expect.objectContaining({ id: "trash/01 The arrival.md", type: "chapter", title: "The arrival", from: ARRIVAL }),
    ]);

    project = apply(tree, planRestore(project, "trash/01 The arrival.md"));
    expect(paths(project)).toEqual([`${P1}/01 The ferryman.md`, `${P1}/02 The arrival.md`, `${P2}/03 Upstream.md`]);
    expect(project.chapters[`${P1}/02 The arrival.md`].status).toBe("Revised");
    expect(project.trash).toEqual([]);
    expect(json(tree).trash).toEqual({});
  });

  it("puts a chapter back in its part after the part was renamed", () => {
    const tree = sample();
    let project = apply(tree, planTrashChapter(read(tree), FERRYMAN));
    project = apply(tree, planRenamePart(project, P1, "Prologue"));
    expect(project.trash[0].from).toBe("manuscript/Prologue/02 The ferryman.md");
    project = apply(tree, planNewChapter(project, { partId: "manuscript/Prologue", index: 1 }, "The ferryman"));
    project = apply(tree, planMoveChapter(project, "manuscript/Prologue/02 The ferryman.md", { partId: P2, index: 0 }));
    expect(project.trash[0].from).toBe("manuscript/Prologue/02 The ferryman.md");
    project = apply(tree, planRestore(project, "trash/02 The ferryman.md"));
    expect(project.binder.find((b) => b.id === "manuscript/Prologue")).toMatchObject({
      chapterIds: ["manuscript/Prologue/01 The arrival.md", "manuscript/Prologue/02 The ferryman.md"],
    });
    expect(paths(project).slice(2)).toEqual([`${P2}/03 The ferryman.md`, `${P2}/04 Upstream.md`]);
  });

  it("keeps names unique in the Trash", () => {
    const tree = sample();
    tree.files.set(`${P2}/04 The arrival.md`, "# The arrival\n");
    let project = apply(tree, planTrashChapter(read(tree), ARRIVAL));
    project = apply(tree, planMoveChapter(project, `${P2}/03 The arrival.md`, { partId: P1, index: 0 }));
    expect(project.chapterOrder[0]).toBe(`${P1}/01 The arrival.md`);
    project = apply(tree, planTrashChapter(project, `${P1}/01 The arrival.md`));
    expect(new Set(project.trash.map((t) => t.id))).toEqual(new Set(["trash/01 The arrival.md", "trash/01 The arrival 2.md"]));
  });

  it("puts a chapter whose part is gone back at the top level", () => {
    const tree = sample();
    let project = apply(tree, planTrashChapter(read(tree), UPSTREAM));
    project = apply(tree, planTrashPart(project, P2));
    project = apply(tree, planRestore(project, "trash/03 Upstream.md"));
    expect(project.binder.map((b) => b.id)).toEqual([P1, "manuscript/03 Upstream.md"]);
  });

  it("trashes a whole part and puts it back at the end", () => {
    const tree = sample();
    let project = apply(tree, planTrashPart(read(tree), P1));
    expect(paths(project)).toEqual([`${P2}/01 Upstream.md`]);
    expect(project.trash).toEqual([
      expect.objectContaining({ id: "trash/Part 1 - Arrival", type: "part", chapterIds: ["trash/Part 1 - Arrival/01 The arrival.md", "trash/Part 1 - Arrival/02 The ferryman.md"] }),
    ]);
    expect(project.trash[0].wordCount).toBe(6);

    const plan = planRestore(project, "trash/Part 1 - Arrival");
    expect(plan.changes).toHaveLength(2);
    project = apply(tree, plan);
    expect(paths(project)).toEqual([`${P2}/01 Upstream.md`, `${P1}/02 The arrival.md`, `${P1}/03 The ferryman.md`]);
    expect(project.chapters[`${P1}/02 The arrival.md`].pov).toBe("Elena");
  });

  it("refuses to change the binder when project.json can't be read", () => {
    const tree = sample();
    tree.files.set("project.json", "{oops");
    expect(() => planTrashChapter(read(tree), ARRIVAL)).toThrow(/project\.json could not be read/u);
    expect(() => planTrashSheet(read(tree), ELENA)).toThrow(/project\.json could not be read/u);
  });
});

const ELENA = "sheets/characters/Elena.md";

describe("sheets in the Trash", () => {
  it("trashes a sheet and puts it back in its type", () => {
    const tree = sample();
    tree.files.set(ELENA, "---\nname: Elena Voss\nrole: Lead\n---\n\nShe keeps the inn.\n");
    let project = apply(tree, planTrashSheet(read(tree), ELENA));
    expect(project.sheets).toEqual([]);
    expect(project.chapterOrder).toEqual([ARRIVAL, FERRYMAN, UPSTREAM]);
    expect(project.trash).toEqual([
      expect.objectContaining({ id: "trash/Elena.md", type: "sheet", title: "Elena Voss", kind: "characters", from: ELENA, wordCount: 4 }),
    ]);
    expect(json(tree).trash).toEqual({ "trash/Elena.md": { from: ELENA } });

    project = apply(tree, planRestore(project, "trash/Elena.md"));
    expect(project.sheets.map((s) => [s.id, s.name])).toEqual([[ELENA, "Elena Voss"]]);
    expect(project.trash).toEqual([]);
    expect(json(tree).trash).toEqual({});
    expect(json(tree).custom).toBe("kept");
  });

  it("keeps a trashed sheet's name apart from a chapter's in the Trash", () => {
    const tree = sample();
    tree.files.set(`${P2}/04 Elena.md`, "# Elena\n");
    let project = apply(tree, planTrashChapter(read(tree), `${P2}/04 Elena.md`));
    tree.files.set("sheets/characters/04 Elena.md", "---\nname: Elena\n---\n");
    project = apply(tree, planTrashSheet(read(tree), "sheets/characters/04 Elena.md"));
    expect(project.trash.map((t) => [t.id, t.type])).toEqual([
      ["trash/04 Elena 2.md", "sheet"],
      ["trash/04 Elena.md", "chapter"],
    ]);
  });

  it("puts a sheet back under a free name when its old one was taken meanwhile", () => {
    const tree = sample();
    let project = apply(tree, planTrashSheet(read(tree), ELENA));
    tree.files.set(ELENA, "---\nname: Elena\n---\n");
    project = apply(tree, planRestore(read(tree), "trash/Elena.md"));
    expect(project.sheets.map((s) => s.id)).toEqual(["sheets/characters/Elena 2.md", ELENA]);
  });

  it("makes its type's folder again if it is gone", () => {
    const tree = sample();
    apply(tree, planTrashSheet(read(tree), ELENA));
    tree.folders.delete("sheets/characters");
    tree.folders.delete("sheets");
    const project = apply(tree, planRestore(read(tree), "trash/Elena.md"));
    expect(project.sheets.map((s) => s.id)).toEqual([ELENA]);
  });

  it("puts a sheet from a folder inside its type back there, making the folder again", () => {
    const tree = sample();
    const bob = "sheets/characters/minor/Bob.md";
    tree.folders.add("sheets/characters/minor");
    tree.files.set(bob, "---\nname: Bob\n---\n");
    let project = apply(tree, planTrashSheet(read(tree), bob));
    expect(project.trash).toEqual([expect.objectContaining({ id: "trash/Bob.md", type: "sheet", kind: "characters", from: bob })]);
    tree.folders.delete("sheets/characters/minor");
    project = apply(tree, planRestore(read(tree), "trash/Bob.md"));
    expect(project.sheets.map((s) => s.id)).toContain(bob);
  });

  it("only moves a sheet to the top of the Trash, or back", () => {
    const tree = sample();
    tree.folders.add("trash");
    tree.folders.add("trash/Part");
    for (const to of ["sheets/places/Elena.md", "sheets/characters/Elena 2.md", "trash/Part/Elena.md", "manuscript/Elena.md", "trash/Elena.txt"]) {
      expect(() => applyChange(tree, { folders: [], moves: [{ from: ELENA, to }], writes: [] }), to).toThrow();
    }
    expect(tree.files.has(ELENA)).toBe(true);
  });

  it("refuses a sheet that is no longer in the project", () => {
    expect(() => planTrashSheet(read(sample()), "sheets/characters/Nobody.md")).toThrow(/no longer in the project/u);
  });

  it("reads a file in the Trash with no record of a sheet as a chapter", () => {
    const tree = sample();
    tree.folders.add("trash");
    tree.files.set("trash/Loose.md", "---\nname: Loose\n---\n");
    expect(read(tree).trash).toEqual([expect.objectContaining({ id: "trash/Loose.md", type: "chapter" })]);
  });
});

describe("chapter details", () => {
  it("sets and clears details in the project and in project.json", () => {
    const tree = sample();
    const before = read(tree);
    const { project, write } = withChapterDetails(before, FERRYMAN, { status: "Draft", synopsis: "He names a price." });
    expect(project.chapters[FERRYMAN]).toMatchObject({ status: "Draft", synopsis: "He names a price." });
    expect(before.chapters[FERRYMAN].status).toBe("");
    const saved = JSON.parse(write.text) as Record<string, Record<string, unknown>>;
    expect(saved.chapters[FERRYMAN]).toEqual({ status: "Draft", synopsis: "He names a price." });
    expect(saved.custom).toBe("kept");

    const cleared = withChapterDetails(project, FERRYMAN, { status: "", synopsis: " " });
    expect(cleared.project.chapters[FERRYMAN].status).toBe("");
    expect((JSON.parse(cleared.write.text) as { chapters: object }).chapters).not.toHaveProperty(FERRYMAN);
  });
});

describe("names", () => {
  it("makes titles safe as file names", () => {
    expect(safeName("Day 1: Arrival?")).toBe("Day 1 Arrival");
    expect(safeName("  ..hidden. ")).toBe("hidden");
    expect(safeName("a/b\\c")).toBe("a b c");
    expect(safeName("CON")).toBe("CON_");
    expect(safeName("Aux.Notes")).toBe("Aux_.Notes");
    expect(safeName("nul.md")).toBe("nul_.md");
    expect(safeName("Auxiliary")).toBe("Auxiliary");
    expect(safeName(`${"a".repeat(79)}.more`)).toBe("a".repeat(79));
    expect(safeName(`${"章".repeat(66)}.章章章`)).toBe("章".repeat(66));
    expect(safeName("***")).toBe("Untitled");
    expect(Array.from(safeName("é".repeat(100)))).toHaveLength(80);
    expect(new TextEncoder().encode(safeName("章".repeat(80))).length).toBeLessThanOrEqual(200);
    expect(safeName("章".repeat(80))).toBe("章".repeat(66));
  });

  it("replaces the title heading, or adds one", () => {
    expect(withTitle("# Old\n\nText.\n", "New")).toBe("# New\n\nText.\n");
    expect(withTitle("Text.\n", "New")).toBe("# New\n\nText.\n");
    expect(withTitle("# Old\n", "Costs $& and $1")).toBe("# Costs $& and $1\n");
  });
});
