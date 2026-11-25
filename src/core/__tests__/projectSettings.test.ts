import { describe, expect, it } from "vitest";
import { buildProject } from "../project";
import { withLanguage } from "../projectSettings";

const project = buildProject({
  root: "/p",
  folderName: "P",
  projectJson: JSON.stringify({ title: "T", language: "en-GB", custom: 1 }),
  files: [],
  skipped: [],
});

describe("the project's language", () => {
  it("is written to project.json, keeping what else it holds", () => {
    const write = withLanguage(project, " fr-CA ")!;
    expect(write.project.language).toBe("fr-CA");
    expect(JSON.parse(write.text)).toEqual({ title: "T", language: "fr-CA", custom: 1 });
  });

  it("changes nothing when it is the same, and refuses what isn't a language code", () => {
    expect(withLanguage(project, "en-GB")).toBeNull();
    expect(() => withLanguage(project, "")).toThrow("not a language code");
    expect(() => withLanguage(project, "français")).toThrow("not a language code");
  });

  it("refuses to write a project.json that couldn't be read", () => {
    const broken = buildProject({ root: "/p", folderName: "P", projectJson: "{oops", files: [], skipped: [] });
    expect(() => withLanguage(broken, "fr")).toThrow();
  });
});
