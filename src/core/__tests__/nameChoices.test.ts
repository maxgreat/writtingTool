import { describe, expect, it } from "vitest";
import { ignoredFor, withIgnoredName, withNotName } from "../nameChoices";
import { buildProject, type Project } from "../project";

function project(json: unknown): Project {
  return buildProject({
    root: "/p",
    folderName: "P",
    projectJson: json === null ? null : JSON.stringify(json),
    files: [],
    skipped: [],
  });
}

describe("withIgnoredName", () => {
  it("adds and removes an occurrence in project.json, keeping everything else", () => {
    const start = project({ title: "T", ignoredNames: [{ name: "Ada", sentence: "Ada ran." }, "junk"] });
    expect(start.ignoredNames).toEqual([{ name: "Ada", sentence: "Ada ran." }]);
    const added = withIgnoredName(start, { name: "Rose", sentence: "She smelled the Rose." }, true)!;
    expect(added.project.ignoredNames).toHaveLength(2);
    expect(JSON.parse(added.text)).toEqual({
      title: "T",
      ignoredNames: [{ name: "Ada", sentence: "Ada ran." }, "junk", { name: "Rose", sentence: "She smelled the Rose." }],
    });
    const removed = withIgnoredName(added.project, { name: "Ada", sentence: "Ada ran." }, false)!;
    expect(removed.project.ignoredNames).toEqual([{ name: "Rose", sentence: "She smelled the Rose." }]);
    expect(JSON.parse(removed.text).ignoredNames).toEqual(["junk", { name: "Rose", sentence: "She smelled the Rose." }]);
  });

  it("changes nothing when there is nothing to change, and drops the list when it empties", () => {
    const start = project(null);
    expect(withIgnoredName(start, { name: "Ada", sentence: "x" }, false)).toBeNull();
    const added = withIgnoredName(start, { name: "Ada", sentence: "x" }, true)!;
    expect(withIgnoredName(added.project, { name: "Ada", sentence: "x" }, true)).toBeNull();
    expect(JSON.parse(withIgnoredName(added.project, { name: "Ada", sentence: "x" }, false)!.text)).toEqual({});
  });

  it("stores the name composed, with straight apostrophes", () => {
    const added = withIgnoredName(project(null), { name: "d’Arwen", sentence: "x" }, true)!;
    expect(added.project.ignoredNames).toEqual([{ name: "d'Arwen", sentence: "x" }]);
  });

  it("refuses to write a project.json it could not read", () => {
    const broken = buildProject({ root: "/p", folderName: "P", projectJson: "{oops", files: [], skipped: [] });
    expect(() => withIgnoredName(broken, { name: "Ada", sentence: "x" }, true)).toThrow(/project\.json could not be read/u);
  });
});

describe("withNotName", () => {
  it("marks and unmarks words, keeping what else project.json holds", () => {
    const start = project({ notNames: ["Monday", 3] });
    expect(start.notNames).toEqual(["Monday"]);
    const marked = withNotName(start, " God ", true)!;
    expect(marked.project.notNames).toEqual(["Monday", "God"]);
    expect(JSON.parse(marked.text).notNames).toEqual(["Monday", 3, "God"]);
    expect(withNotName(marked.project, "God", true)).toBeNull();
    const unmarked = withNotName(marked.project, "Monday", false)!;
    expect(JSON.parse(unmarked.text).notNames).toEqual([3, "God"]);
    expect(withNotName(unmarked.project, "  ", true)).toBeNull();
  });
});

describe("ignoredFor", () => {
  it("finds a sheet's ignored occurrences by its names and their case rules", () => {
    const ignored = [
      { name: "Rose", sentence: "a" },
      { name: "rose", sentence: "b" },
      { name: "ROSE", sentence: "c" },
      { name: "Tomas", sentence: "d" },
    ];
    expect(ignoredFor([{ text: "Rose", ignoreCase: false }], ignored).map((e) => e.sentence)).toEqual(["a"]);
    expect(ignoredFor([{ text: "rose", ignoreCase: true }], ignored).map((e) => e.sentence)).toEqual(["a", "b", "c"]);
  });
});
