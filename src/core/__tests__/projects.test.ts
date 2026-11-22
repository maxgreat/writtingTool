// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { buildProject } from "../project";
import { defaultLanguage, newProject, readRecentProjects, rememberRecentProject } from "../projects";

describe("new projects", () => {
  it("picks the closest language the app supports", () => {
    expect(defaultLanguage(["en-US"])).toBe("en-US");
    expect(defaultLanguage(["fr-BE", "en-GB"])).toBe("fr-FR");
    expect(defaultLanguage(["de-DE", "es-AR"])).toBe("es-ES");
    expect(defaultLanguage(["ES-mx"])).toBe("es-MX");
    expect(defaultLanguage([])).toBe("en-GB");
  });

  it("holds project.json, a first chapter and the sheet folders", () => {
    const created = newProject("  Night   Ferry: A Novel ", "fr-CA");
    expect(created.name).toBe("Night Ferry A Novel");
    expect(created.folders).toEqual(["manuscript", "sheets", "sheets/characters", "sheets/places", "sheets/notes"]);
    const project = buildProject({
      root: "/p",
      folderName: created.name,
      projectJson: created.files.find((f) => f.path === "project.json")?.text ?? null,
      files: created.files.filter((f) => f.path.endsWith(".md")),
      folders: created.folders.filter((f) => f.startsWith("manuscript")),
      skipped: [],
    });
    expect(project.title).toBe("Night Ferry: A Novel");
    expect(project.language).toBe("fr-CA");
    expect(project.chapterOrder.map((id) => project.chapters[id].title)).toEqual(["Chapter one"]);
    expect(project.sheetTypes.map((t) => t.label)).toEqual(["Characters", "Places", "Notes"]);
    expect(project.problems).toEqual([]);
  });

  it("gives an empty title a name", () => {
    expect(newProject("   ", "en-GB").name).toBe("Untitled");
  });
});

describe("recent projects", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the ten most recent folders, newest first, each once", () => {
    for (let i = 0; i < 12; i += 1) rememberRecentProject(`/p/${i}`);
    rememberRecentProject("/p/5");
    const recent = readRecentProjects();
    expect(recent).toHaveLength(10);
    expect(recent.slice(0, 3)).toEqual(["/p/5", "/p/11", "/p/10"]);
    expect(recent.filter((p) => p === "/p/5")).toHaveLength(1);
  });

  it("ignores what it can't read", () => {
    localStorage.setItem("writingTool.recentProjects", "{broken");
    expect(readRecentProjects()).toEqual([]);
    localStorage.setItem("writingTool.recentProjects", JSON.stringify(["/a", 3, null]));
    expect(readRecentProjects()).toEqual(["/a"]);
  });
});
