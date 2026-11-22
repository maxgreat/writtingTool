import { parse as parseYaml } from "yaml";
import { NameMatcher, type NamePattern } from "./names";
import { countWords } from "./words";

/** What the Rust core returns when it opens a project folder. */
export interface ProjectSnapshot {
  root: string;
  folderName: string;
  projectJson: string | null;
  /** Every Markdown file under manuscript/ and sheets/, paths relative to the root with `/`. */
  files: { path: string; text: string }[];
  /** Files that could not be read as UTF-8 and were left out. */
  skipped: string[];
  /** Other things the Rust core left out, as sentences (for example a linked manuscript folder). */
  problems?: string[];
}

export interface Alias {
  text: string;
  ignoreCase: boolean;
}

export interface Sheet {
  /** Path of the sheet file, relative to the project root. */
  id: string;
  /** Folder under sheets/: "characters", "places", "notes" or a user-defined type. */
  kind: string;
  name: string;
  aliases: Alias[];
  /** Other typed fields from the YAML header, in file order. */
  fields: [string, string][];
  /** Free notes after the header, as Markdown. */
  body: string;
}

export interface SheetType {
  folder: string;
  label: string;
}

export interface Chapter {
  /** Path of the chapter file, relative to the project root. */
  id: string;
  title: string;
  text: string;
  wordCount: number;
  status: string;
  pov: string;
  synopsis: string;
}

export type BinderItem =
  | { type: "part"; id: string; title: string; chapterIds: string[] }
  | { type: "chapter"; id: string };

export interface Project {
  root: string;
  title: string;
  language: string;
  binder: BinderItem[];
  chapters: Record<string, Chapter>;
  /** Chapter ids in reading order. */
  chapterOrder: string[];
  sheets: Sheet[];
  sheetTypes: SheetType[];
  /** Problems found while reading, for the interface to report. */
  problems: string[];
}

const MANUSCRIPT = "manuscript/";
const SHEETS = "sheets/";

/** Sheet types that are notes, not names, and are never highlighted. */
const UNMATCHED_KINDS = new Set(["notes"]);

const DEFAULT_SHEET_TYPES: SheetType[] = [
  { folder: "characters", label: "Characters" },
  { folder: "places", label: "Places" },
  { folder: "notes", label: "Notes" },
];

interface ChapterMeta {
  status?: unknown;
  pov?: unknown;
  synopsis?: unknown;
}

interface ProjectJson {
  title?: unknown;
  language?: unknown;
  sheetTypes?: unknown;
  chapters?: Record<string, ChapterMeta>;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stem(path: string): string {
  return baseName(path).replace(/\.md$/iu, "");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The text of the first `# ` heading, or the file name without its number. */
export function chapterTitle(path: string, text: string): string {
  // A closing run of # is markup only after a space ("# Learning C#" keeps its #),
  // and backslash escapes written by the formatted editor are not part of the title.
  const heading = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/mu.exec(text);
  if (heading) return heading[1].replace(/\\([!-/:-@[-`{-~])/gu, "$1");
  return stem(path).replace(/^\d+[\s._-]*/u, "") || stem(path);
}

/**
 * Splits a sheet file into its YAML header and body. The header is the block
 * between a first line `---` and the next line `---` or `...`.
 */
export function splitFrontMatter(text: string): { header: string | null; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return { header: null, body: text };
  return { header: match[1], body: text.slice(match[0].length) };
}

function parseAliases(value: unknown): Alias[] {
  if (!Array.isArray(value)) return [];
  const aliases: Alias[] = [];
  for (const item of value) {
    if (typeof item === "string" || typeof item === "number") {
      aliases.push({ text: String(item), ignoreCase: false });
    } else if (isRecord(item) && typeof item.text === "string") {
      aliases.push({ text: item.text, ignoreCase: item.ignoreCase === true });
    }
  }
  return aliases.filter((a) => a.text.trim() !== "");
}

export function parseSheet(path: string, text: string, problems: string[]): Sheet {
  const kind = path.slice(SHEETS.length).split("/")[0];
  const { header, body } = splitFrontMatter(text);
  let data: Record<string, unknown> = {};
  if (header !== null) {
    try {
      const parsed: unknown = parseYaml(header);
      if (isRecord(parsed)) data = parsed;
      else if (parsed != null) problems.push(`${path}: the header is not a list of fields.`);
    } catch (error) {
      problems.push(`${path}: the header could not be read (${(error as Error).message}).`);
    }
  }
  const fields: [string, string][] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "name" || key === "aliases") continue;
    if (["string", "number", "boolean"].includes(typeof value)) fields.push([key, String(value)]);
  }
  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : stem(path);
  return { id: path, kind, name, aliases: parseAliases(data.aliases), fields, body: body.replace(/^\s+/u, "") };
}

function parseProjectJson(text: string | null, problems: string[]): ProjectJson {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed as ProjectJson;
    problems.push("project.json does not hold an object; using defaults.");
  } catch (error) {
    problems.push(`project.json could not be read (${(error as Error).message}); using defaults.`);
  }
  return {};
}

function parseSheetTypes(value: unknown, sheets: Sheet[]): SheetType[] {
  const types: SheetType[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item) && typeof item.folder === "string" && item.folder !== "") {
        types.push({ folder: item.folder, label: asString(item.label) || capitalize(item.folder) });
      }
    }
  }
  if (types.length === 0) types.push(...DEFAULT_SHEET_TYPES);
  for (const sheet of sheets) {
    if (!types.some((t) => t.folder === sheet.kind)) {
      types.push({ folder: sheet.kind, label: capitalize(sheet.kind) });
    }
  }
  return types;
}

const byPath = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function buildProject(snapshot: ProjectSnapshot): Project {
  const problems = [
    ...(snapshot.problems ?? []),
    ...snapshot.skipped.map((path) => `${path} is not UTF-8 text and was left out.`),
  ];
  const json = parseProjectJson(snapshot.projectJson, problems);
  const meta = isRecord(json.chapters) ? json.chapters : {};

  const chapterFiles = snapshot.files
    .filter((f) => f.path.startsWith(MANUSCRIPT))
    .sort((a, b) => byPath(a.path, b.path));
  const sheetFiles = snapshot.files
    .filter((f) => f.path.startsWith(SHEETS) && f.path.slice(SHEETS.length).includes("/"))
    .sort((a, b) => byPath(a.path, b.path));

  const chapters: Record<string, Chapter> = {};
  const binder: BinderItem[] = [];
  const parts = new Map<string, Extract<BinderItem, { type: "part" }>>();
  for (const file of chapterFiles) {
    const m = isRecord(meta[file.path]) ? meta[file.path] : {};
    chapters[file.path] = {
      id: file.path,
      title: chapterTitle(file.path, file.text),
      text: file.text,
      wordCount: countWords(file.text),
      status: asString(m.status),
      pov: asString(m.pov),
      synopsis: asString(m.synopsis),
    };
    const relative = file.path.slice(MANUSCRIPT.length);
    const slash = relative.indexOf("/");
    if (slash === -1) {
      binder.push({ type: "chapter", id: file.path });
      continue;
    }
    // Every chapter below a top-level folder belongs to that folder's part.
    const partName = relative.slice(0, slash);
    let part = parts.get(partName);
    if (!part) {
      part = { type: "part", id: MANUSCRIPT + partName, title: partName, chapterIds: [] };
      parts.set(partName, part);
      binder.push(part);
    }
    part.chapterIds.push(file.path);
  }

  const sheets = sheetFiles.map((f) => parseSheet(f.path, f.text, problems));

  return {
    root: snapshot.root,
    title: asString(json.title) || snapshot.folderName,
    language: asString(json.language) || "en",
    binder,
    chapters,
    chapterOrder: binder.flatMap((item) => (item.type === "part" ? item.chapterIds : [item.id])),
    sheets,
    sheetTypes: parseSheetTypes(json.sheetTypes, sheets),
    problems,
  };
}

/** One matcher from every name and alias of the sheets that hold names. */
export function buildNameMatcher(sheets: Sheet[]): NameMatcher {
  const patterns: NamePattern[] = [];
  for (const sheet of sheets) {
    if (UNMATCHED_KINDS.has(sheet.kind)) continue;
    patterns.push({ text: sheet.name, sheetId: sheet.id, kind: sheet.kind, ignoreCase: false });
    for (const alias of sheet.aliases) {
      patterns.push({ text: alias.text, sheetId: sheet.id, kind: sheet.kind, ignoreCase: alias.ignoreCase });
    }
  }
  return new NameMatcher(patterns);
}

/** Returns a copy of the project with one chapter's text replaced. */
export function withChapterText(project: Project, id: string, text: string): Project {
  const chapter = project.chapters[id];
  if (!chapter || chapter.text === text) return project;
  return {
    ...project,
    chapters: {
      ...project.chapters,
      [id]: { ...chapter, text, title: chapterTitle(id, text), wordCount: countWords(text) },
    },
  };
}
