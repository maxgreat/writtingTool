import { parse as parseYaml } from "yaml";
import { NameMatcher, type NamePattern } from "./names";
import { countWords } from "./words";

/** What the Rust core returns when it opens a project folder. */
export interface ProjectSnapshot {
  root: string;
  folderName: string;
  projectJson: string | null;
  /** Every Markdown file under manuscript/, sheets/ and trash/, paths relative to the root with `/`. */
  files: { path: string; text: string }[];
  /** Every folder under manuscript/ and trash/, so empty parts show too. */
  folders?: string[];
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

/** A chapter or a whole part in the Trash, which is the trash/ folder of the project. */
export interface TrashItem {
  /** Path in trash/, relative to the project root. */
  id: string;
  type: "chapter" | "part";
  title: string;
  wordCount: number;
  /** For a part: its chapter files, in path order. */
  chapterIds: string[];
  /** Where it was before it went to the Trash, if project.json remembers. */
  from: string | null;
}

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
  /** Chapter statuses to choose from, in order. */
  statuses: string[];
  trash: TrashItem[];
  /** Every file and folder path under manuscript/ and trash/, including files left out, so new names never clash. */
  entries: string[];
  /** project.json as read, to be written back with changes; unknown fields are kept. */
  json: Record<string, unknown>;
  /** Set when project.json exists but could not be read: it must not be overwritten then. */
  jsonProblem: string | null;
  /** Problems found while reading, for the interface to report. */
  problems: string[];
}

const MANUSCRIPT = "manuscript/";
const SHEETS = "sheets/";
const TRASH = "trash/";

export const DEFAULT_STATUSES = ["Idea", "Draft", "Revised", "Final"];

/** Sheet types that are notes, not names, and are never highlighted. */
const UNMATCHED_KINDS = new Set(["notes"]);

export const DEFAULT_SHEET_TYPES: SheetType[] = [
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
  /** Statuses to choose from. */
  statuses?: unknown;
  /** Paths of parts and chapters in binder order. Items missing from it follow, in path order. */
  binder?: unknown;
  /** Where each item in trash/ came from: { "<trash path>": { "from": "<path>" } }. */
  trash?: unknown;
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

function parseProjectJson(text: string | null): { json: ProjectJson; problem: string | null } {
  if (text === null) return { json: {}, problem: null };
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { json: parsed as ProjectJson, problem: null };
    return { json: {}, problem: "project.json does not hold an object; using defaults." };
  } catch (error) {
    return { json: {}, problem: `project.json could not be read (${(error as Error).message}); using defaults.` };
  }
}

function parseStatuses(value: unknown, chapters: Chapter[]): string[] {
  const listed = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  const statuses = listed.length > 0 ? [...new Set(listed)] : [...DEFAULT_STATUSES];
  // A status a chapter already has stays choosable, even if the list left it out.
  for (const chapter of chapters) {
    if (chapter.status && !statuses.includes(chapter.status)) statuses.push(chapter.status);
  }
  return statuses;
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

/** The top-level folder or file below `prefix` that holds `path`. */
function topLevel(path: string, prefix: string): string {
  const slash = path.indexOf("/", prefix.length);
  return slash === -1 ? path : path.slice(0, slash);
}

export function buildProject(snapshot: ProjectSnapshot): Project {
  const { json, problem: jsonProblem } = parseProjectJson(snapshot.projectJson);
  const problems = [
    ...(snapshot.problems ?? []),
    ...snapshot.skipped.map((path) => `${path} is not UTF-8 text and was left out.`),
    ...(jsonProblem ? [jsonProblem] : []),
  ];
  const meta = isRecord(json.chapters) ? json.chapters : {};
  const folders = snapshot.folders ?? [];

  // Binder order: the position in project.json's list, then the path.
  const listed = Array.isArray(json.binder) ? json.binder.filter((v): v is string => typeof v === "string") : [];
  const rank = new Map(listed.map((id, index) => [id, index] as const));
  const byOrder = (a: string, b: string) =>
    (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || byPath(a, b);

  const chapterFiles = snapshot.files.filter((f) => f.path.startsWith(MANUSCRIPT));
  const sheetFiles = snapshot.files
    .filter((f) => f.path.startsWith(SHEETS) && f.path.slice(SHEETS.length).includes("/"))
    .sort((a, b) => byPath(a.path, b.path));

  const chapters: Record<string, Chapter> = {};
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
  }

  // Every chapter below a top-level folder belongs to that folder's part;
  // a top-level folder with no chapters is an empty part.
  const parts = new Map<string, Extract<BinderItem, { type: "part" }>>();
  const loose: BinderItem[] = [];
  const partFor = (id: string) => {
    let part = parts.get(id);
    if (!part) {
      part = { type: "part", id, title: id.slice(MANUSCRIPT.length), chapterIds: [] };
      parts.set(id, part);
    }
    return part;
  };
  for (const folder of folders) {
    if (folder.startsWith(MANUSCRIPT)) partFor(topLevel(folder, MANUSCRIPT));
  }
  for (const id of Object.keys(chapters).sort(byOrder)) {
    const top = topLevel(id, MANUSCRIPT);
    if (top === id) loose.push({ type: "chapter", id });
    else partFor(top).chapterIds.push(id);
  }
  const binder = [...loose, ...parts.values()].sort((a, b) => byOrder(a.id, b.id));

  const trashMeta = isRecord(json.trash) ? json.trash : {};
  const trash = new Map<string, TrashItem>();
  const trashItem = (id: string, type: TrashItem["type"]) => {
    let item = trash.get(id);
    if (!item) {
      const record = trashMeta[id];
      const from = isRecord(record) && typeof record.from === "string" ? record.from : null;
      const name = id.slice(TRASH.length);
      item = { id, type, title: type === "part" ? name : stem(name), wordCount: 0, chapterIds: [], from };
      trash.set(id, item);
    }
    return item;
  };
  for (const folder of folders) {
    if (folder.startsWith(TRASH)) trashItem(topLevel(folder, TRASH), "part");
  }
  for (const file of snapshot.files
    .filter((f) => f.path.startsWith(TRASH))
    .sort((a, b) => byPath(a.path, b.path))) {
    const top = topLevel(file.path, TRASH);
    if (top === file.path) {
      const item = trashItem(top, "chapter");
      item.title = chapterTitle(file.path, file.text);
      item.wordCount = countWords(file.text);
    } else {
      const item = trashItem(top, "part");
      item.chapterIds.push(file.path);
      item.wordCount += countWords(file.text);
    }
  }

  const sheets = sheetFiles.map((f) => parseSheet(f.path, f.text, problems));
  const entries = [
    ...folders,
    ...snapshot.files.filter((f) => f.path.startsWith(MANUSCRIPT) || f.path.startsWith(TRASH)).map((f) => f.path),
    ...snapshot.skipped,
  ];

  return {
    root: snapshot.root,
    title: asString(json.title) || snapshot.folderName,
    language: asString(json.language) || "en",
    binder,
    chapters,
    chapterOrder: binder.flatMap((item) => (item.type === "part" ? item.chapterIds : [item.id])),
    sheets,
    sheetTypes: parseSheetTypes(json.sheetTypes, sheets),
    statuses: parseStatuses(json.statuses, Object.values(chapters)),
    trash: [...trash.values()].sort((a, b) => byPath(a.id, b.id)),
    entries,
    json: json as Record<string, unknown>,
    jsonProblem,
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
