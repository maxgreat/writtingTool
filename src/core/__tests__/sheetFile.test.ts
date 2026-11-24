import { describe, expect, it } from "vitest";
import { buildProject, parseSheet, type Project } from "../project";
import { editSheetText, formFields, newSheetPath, newSheetText } from "../sheetFile";

const ELENA = `---
name: Elena Voss
# Her family name comes from her mother.
aliases: [Elena, Voss]
role: Protagonist
age: 34
family:
  - Mara Voss
---
A surveyor from the coast.

She counts things when she is afraid.
`;

describe("editSheetText", () => {
  it("changes only the name, keeping comments, order and fields the form doesn't show", () => {
    expect(editSheetText(ELENA, { name: "Elena Kell" })).toBe(ELENA.replace("name: Elena Voss", "name: Elena Kell"));
  });

  it("writes plain aliases on one line, and those that ignore case as entries", () => {
    const plain = editSheetText(ELENA, { aliases: [{ text: "Lena", ignoreCase: false }] });
    expect(plain).toContain("aliases: [Lena]\n");
    const mixed = editSheetText(ELENA, {
      aliases: [
        { text: "Elena", ignoreCase: false },
        { text: "the surveyor", ignoreCase: true },
      ],
    });
    expect(parseSheet("sheets/characters/Elena Voss.md", mixed, []).aliases).toEqual([
      { text: "Elena", ignoreCase: false },
      { text: "the surveyor", ignoreCase: true },
    ]);
  });

  it("drops empty aliases and keeps an empty list where there was one", () => {
    const text = editSheetText(ELENA, { aliases: [{ text: "  ", ignoreCase: false }] });
    expect(text).toContain("aliases: []\n");
    expect(editSheetText("---\nname: Ada\n---\n", { aliases: [] })).toBe("---\nname: Ada\n---\n");
  });

  it("sets, adds and removes fields, writing numbers as numbers and leaving lists alone", () => {
    const text = editSheetText(ELENA, {
      fields: [
        ["role", "Narrator"],
        ["age", "35"],
        ["eyes", "grey"],
      ],
    });
    const sheet = parseSheet("sheets/characters/Elena Voss.md", text, []);
    expect(sheet.fields).toEqual([
      ["role", "Narrator"],
      ["age", "35"],
      ["eyes", "grey"],
    ]);
    expect(text).toContain("age: 35\n");
    expect(text).toContain("family:\n  - Mara Voss\n");
    expect(text).toContain("# Her family name comes from her mother.\n");
  });

  it("removes a field left out or left empty, and keeps text that only looks like a number", () => {
    const text = editSheetText(ELENA, { fields: [["role", ""], ["code", "007"]] });
    expect(text).not.toContain("role:");
    expect(text).not.toContain("age:");
    expect(text).toContain('code: "007"');
    expect(parseSheet("sheets/characters/x.md", text, []).fields).toEqual([["code", "007"]]);
  });

  it("never treats name or aliases as fields", () => {
    const text = editSheetText(ELENA, { fields: [["name", "Someone"], ["aliases", "x"]] });
    expect(parseSheet("sheets/characters/x.md", text, []).name).toBe("Elena Voss");
    expect(text).toContain("aliases: [Elena, Voss]");
  });

  it("refuses a value for a key that holds a list, and leaves the list alone otherwise", () => {
    expect(() => editSheetText(ELENA, { fields: [["family", "Mara"]] })).toThrow("keeps family in a form this sheet can't show");
    expect(editSheetText(ELENA, { fields: [["role", "Protagonist"], ["age", "34"], ["family", ""]] })).toBe(ELENA);
  });

  it("edits and removes fields whose keys YAML reads as numbers or true/false, in place", () => {
    const text = "---\nname: Ada\n1990: Born in Lyon\ntrue: yes\n---\n";
    const sheet = parseSheet("sheets/characters/Ada.md", text, []);
    expect(sheet.fields).toEqual([["1990", "Born in Lyon"], ["true", "yes"]]);
    expect(editSheetText(text, { fields: [["1990", "Born in Lyon, France"], ["true", "yes"]] })).toBe(
      "---\nname: Ada\n1990: Born in Lyon, France\ntrue: yes\n---\n",
    );
    expect(editSheetText(text, { fields: [["true", "yes"]] })).toBe("---\nname: Ada\ntrue: yes\n---\n");
    expect(editSheetText(text, { fields: [["1990", ""], ["true", "yes"]] })).toBe("---\nname: Ada\ntrue: yes\n---\n");
  });

  it("keeps a key left empty while another field changes", () => {
    expect(editSheetText("---\nname: Ada\nrole:\nage: 3\n---\n", { fields: [["role", ""], ["age", "4"]] })).toBe(
      "---\nname: Ada\nrole:\nage: 4\n---\n",
    );
  });

  it("fills in a key left empty, keeping its place", () => {
    expect(editSheetText("---\nname: Ada\nrole:\nage: 3\n---\n", { fields: [["role", "Lead"], ["age", "3"]] })).toBe(
      "---\nname: Ada\nrole: Lead\nage: 3\n---\n",
    );
  });

  it("leaves fields the writer didn't change exactly as written", () => {
    const text = '---\nname: Ada\nyear: "1990"\ntitle: " Dr "\nmotto: |\n  Never twice.\nnick: ""\nrole: Lead\n---\n';
    const fields = parseSheet("sheets/characters/Ada.md", text, []).fields;
    // A text box can't hold the line break at the end of the motto.
    const shown = fields.map(([k, v]): [string, string] => [k, k === "role" ? "Hero" : v.replace(/\n/gu, "")]);
    expect(editSheetText(text, { fields: shown })).toBe(text.replace("role: Lead", "role: Hero"));
  });

  it("keeps text as text and numbers as numbers when they change", () => {
    const text = '---\nname: Ada\nyear: "1990"\nage: 34\n---\n';
    expect(editSheetText(text, { fields: [["year", "1991"], ["age", "35"]] })).toBe('---\nname: Ada\nyear: "1991"\nage: 35\n---\n');
    expect(editSheetText(text, { fields: [["year", "1990"], ["age", "about 35"]] })).toBe(
      '---\nname: Ada\nyear: "1990"\nage: about 35\n---\n',
    );
  });

  it("uses keys exactly as given, so a key with spaces in the file is its own field", () => {
    const text = '---\nname: Ada\n" role": old\nrole: Lead\n---\n';
    expect(parseSheet("sheets/characters/Ada.md", text, []).fields).toEqual([[" role", "old"], ["role", "Lead"]]);
    expect(editSheetText(text, { fields: [[" role", "old"], ["role", "Hero"]] })).toBe(text.replace("Lead", "Hero"));
    expect(editSheetText(text, { fields: [["role", "Lead"]] })).toBe("---\nname: Ada\nrole: Lead\n---\n");
  });

  it("never shows or touches entries whose key is missing or blank", () => {
    for (const odd of [": likes rain", "~: likes rain", "null: likes rain"]) {
      const text = `---\nname: Ada\n${odd}\n"": x\n" ": y\nrole: Lead\n---\n`;
      const sheet = parseSheet("sheets/characters/Ada.md", text, []);
      expect(sheet.editable).toBe(true);
      expect(sheet.fields).toEqual([["role", "Lead"]]);
      expect(editSheetText(text, { fields: [["role", "Hero"]] })).toBe(text.replace("Lead", "Hero"));
      expect(editSheetText(text, { fields: [["", "q"], [" ", "q"], ["role", "Lead"]] })).toBe(text);
    }
  });

  it("never shows or touches entries that read as the same field", () => {
    for (const [a, b] of [["1", '"1"'], ["true", '"true"']]) {
      const text = `---\nname: Ada\n${a}: x\n${b}: y\nrole: Lead\n---\n`;
      const key = a;
      const sheet = parseSheet("sheets/characters/Ada.md", text, []);
      expect(sheet.editable).toBe(true);
      expect(sheet.fields).toEqual([["role", "Lead"]]);
      expect(editSheetText(text, { fields: [["role", "Hero"]] })).toBe(text.replace("Lead", "Hero"));
      expect(editSheetText(text, { fields: [["role", "Lead"], [key, ""]] })).toBe(text);
      expect(() => editSheetText(text, { fields: [["role", "Lead"], [key, "z"]] })).toThrow(
        `more than one entry called ${key}`,
      );
    }
  });

  it("refuses to change other names the form can't show, and keeps the list's comment", () => {
    for (const odd of ["aliases: Elena", "aliases: [Elena, [x, y]]", "aliases:\n  - text: Elena\n    note: mother's name", "aliases:\n  - ignoreCase: true"]) {
      const text = `---\nname: Ada\n${odd}\n---\n`;
      expect(() => editSheetText(text, { aliases: [{ text: "Lena", ignoreCase: false }] })).toThrow("more than names");
      // Other parts of the sheet can still change.
      expect(editSheetText(text, { body: "Notes." })).toBe(`${text}Notes.\n`);
    }
    const commented = "---\nname: Ada\n# What people call her.\naliases: [Ada, 42, ~] # short ones\n---\n";
    const out = editSheetText(commented, { aliases: [{ text: "Lena", ignoreCase: false }] });
    expect(out).toContain("# What people call her.");
    expect(out).toContain("# short ones");
    expect(parseSheet("sheets/characters/Ada.md", out, []).aliases).toEqual([{ text: "Lena", ignoreCase: false }]);
  });

  it("keeps the header block exactly as written when only the notes change", () => {
    expect(editSheetText("---\nname: Ada\n...\nOld\n", { body: "New" })).toBe("---\nname: Ada\n...\nNew\n");
    expect(editSheetText("---  \nname: Ada\n---", { body: "New" })).toBe("---  \nname: Ada\n---\nNew\n");
  });

  it("keeps Windows line ends", () => {
    const text = "---\r\nname: Ada\r\nrole: Lead\r\n---\r\nOld\r\n";
    expect(editSheetText(text, { fields: [["role", "Hero"]] })).toBe(text.replace("Lead", "Hero"));
    expect(editSheetText(text, { body: "One\nTwo" })).toBe("---\r\nname: Ada\r\nrole: Lead\r\n---\r\nOne\r\nTwo\r\n");
  });

  it("treats an empty header as no fields", () => {
    expect(parseSheet("sheets/characters/Ada.md", "---\n~\n---\n", []).editable).toBe(true);
    expect(editSheetText("---\n~\n---\n", { name: "Ada" })).toBe("---\nname: Ada\n---\n");
  });

  it("never shows or touches values tagged as dates or binary data", () => {
    const text = "---\nname: Ada\nage: !!timestamp 2001-12-14\nseal: !!binary aGk=\nrole: Lead\n---\n";
    const sheet = parseSheet("sheets/characters/Ada.md", text, []);
    expect(sheet.fields).toEqual([["role", "Lead"]]);
    // As the form sends it: the template's age row, empty, beside the changed role.
    expect(editSheetText(text, { fields: [["role", "Hero"], ["age", ""]] })).toBe(text.replace("Lead", "Hero"));
    expect(() => editSheetText(text, { fields: [["role", "Lead"], ["age", "34"]] })).toThrow("keeps age in a form");
  });

  it("keeps empty keys the form doesn't show", () => {
    const text = editSheetText("---\nname: Ada\nlater:\n---\n", { fields: [] });
    expect(text).toBe("---\nname: Ada\nlater:\n---\n");
  });

  it("replaces the notes and keeps the header as written", () => {
    const text = editSheetText(ELENA, { body: "New notes.\n\n\n" });
    expect(text).toBe(`${ELENA.slice(0, ELENA.indexOf("A surveyor"))}New notes.\n`);
    expect(editSheetText(ELENA, { body: "" })).toBe(ELENA.slice(0, ELENA.indexOf("A surveyor")));
  });

  it("gives a file without a header one, keeping its text as the notes", () => {
    const text = editSheetText("Just notes.\n", { name: "Ada" });
    expect(text).toBe("---\nname: Ada\n---\nJust notes.\n");
  });

  it("refuses an empty name and a header it can't read", () => {
    expect(() => editSheetText(ELENA, { name: "  " })).toThrow("A sheet needs a name.");
    expect(() => editSheetText("---\nname: [unclosed\n---\n", { name: "Ada" })).toThrow("could not be read");
    expect(() => editSheetText("---\n- a list\n---\n", { name: "Ada" })).toThrow("not a list of fields");
    // The notes can still change: the header is kept as it is.
    expect(editSheetText("---\nname: [unclosed\n---\nOld\n", { body: "New" })).toBe("---\nname: [unclosed\n---\nNew\n");
  });
});

describe("new sheets", () => {
  const project: Project = buildProject({
    root: "/p",
    folderName: "P",
    projectJson: null,
    files: [{ path: "sheets/characters/Ada.md", text: "---\nname: Ada\n---\n" }],
    skipped: [],
  });

  it("start with their name only", () => {
    expect(newSheetText(" Tomas ")).toBe("---\nname: Tomas\n---\n");
    expect(() => newSheetText("")).toThrow();
  });

  it("go in their type's folder under a free, safe file name", () => {
    expect(newSheetPath(project, "places", "Old Mill")).toBe("sheets/places/Old Mill.md");
    expect(newSheetPath(project, "characters", "ada")).toBe("sheets/characters/ada 2.md");
    expect(newSheetPath(project, "characters", "A/B: C?")).toBe("sheets/characters/A B C.md");
  });
});

describe("formFields", () => {
  it("lists the sheet's fields, then its template's missing ones, empty", () => {
    const sheet = parseSheet("sheets/characters/x.md", "---\nname: X\nage: 3\neyes: grey\n---\n", []);
    expect(formFields(sheet, { folder: "characters", label: "Characters", fields: ["role", "age"] })).toEqual([
      ["age", "3"],
      ["eyes", "grey"],
      ["role", ""],
    ]);
    expect(formFields(sheet, { folder: "characters", label: "Characters", fields: ["name", " aliases", "age ", " "] })).toEqual([
      ["age", "3"],
      ["eyes", "grey"],
    ]);
    expect(formFields(sheet, undefined)).toEqual([
      ["age", "3"],
      ["eyes", "grey"],
    ]);
  });
});
