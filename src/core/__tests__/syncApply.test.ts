import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../project";
import { changedAnything, followMoves, withUnsaved } from "../syncApply";

const snapshot: ProjectSnapshot = {
  root: "/p",
  folderName: "p",
  projectJson: '{"title":"Disk"}',
  dictionary: "Arno\n",
  files: [
    { path: "manuscript/01 One.md", text: "# One\n" },
    { path: "sheets/characters/Elena.md", text: "---\nname: Elena\n---\n" },
  ],
  skipped: [],
};

describe("syncApply", () => {
  it("follows files through moves, parts taking their chapters along", () => {
    const moved: [string, string][] = [
      ["manuscript/Part 1", "trash/Part 1"],
      ["manuscript/03 Three.md", "manuscript/02 Three.md"],
    ];
    expect(followMoves("manuscript/Part 1/01 One.md", moved)).toBe("trash/Part 1/01 One.md");
    expect(followMoves("manuscript/03 Three.md", moved)).toBe("manuscript/02 Three.md");
    expect(followMoves("manuscript/Part 10/01 Ten.md", moved)).toBe("manuscript/Part 10/01 Ten.md");
  });

  it("lays edits not saved yet over the project read from disk", () => {
    const unsaved = new Map([
      ["manuscript/01 One.md", "# One, edited\n"],
      ["project.json", '{"title":"Edited"}'],
      ["dictionary.txt", "Arno\nVarn\n"],
      ["manuscript/09 Gone.md", "# Kept\n"],
    ]);
    const shown = withUnsaved(snapshot, unsaved);
    expect(shown.projectJson).toBe('{"title":"Edited"}');
    expect(shown.dictionary).toBe("Arno\nVarn\n");
    expect(shown.files).toEqual([
      { path: "manuscript/01 One.md", text: "# One, edited\n" },
      { path: "sheets/characters/Elena.md", text: "---\nname: Elena\n---\n" },
      { path: "manuscript/09 Gone.md", text: "# Kept\n" },
    ]);
    expect(withUnsaved(snapshot, new Map())).toBe(snapshot);
  });

  it("tells a sync that changed something from one that didn't", () => {
    const nothing = { changed: [], moved: [], reshaped: false, conflicts: [], problems: [], again: false };
    expect(changedAnything(nothing)).toBe(false);
    expect(changedAnything({ ...nothing, reshaped: true })).toBe(true);
    expect(changedAnything({ ...nothing, changed: [{ path: "a.md", before: "", after: "b" }] })).toBe(true);
  });
});
