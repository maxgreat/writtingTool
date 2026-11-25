/*
 * The book as the Rust core's export takes it, made from the project: its
 * parts and chapters in binder order, with each chapter's text as it is in
 * the editor; and what project.json keeps of export.
 */
import { editableJson, toText, type ProjectJsonWrite } from "./nameChoices";
import type { Project } from "./project";
import { BUILT_IN_PRESETS, sanitizeExportSettings, type ExportFormat, type ExportSettings } from "./exportSettings";

/** The book as the core's export module takes it (src-tauri/src/export.rs: Book). */
export interface BookContent {
  title: string;
  author: string;
  language: string;
  sections: { part: string | null; chapters: { title: string; markdown: string }[] }[];
}

/** The book's parts and chapters in binder order; chapters outside parts are grouped as they come. */
export function bookOutline(project: Project): { part: string | null; chapters: { id: string; title: string }[] }[] {
  const out: { part: string | null; chapters: { id: string; title: string }[] }[] = [];
  for (const item of project.binder) {
    if (item.type === "part") {
      out.push({ part: item.title, chapters: item.chapterIds.flatMap((id) => (project.chapters[id] ? [{ id, title: project.chapters[id].title }] : [])) });
    } else if (project.chapters[item.id]) {
      const last = out.at(-1);
      const chapter = { id: item.id, title: project.chapters[item.id].title };
      if (last && last.part === null) last.chapters.push(chapter);
      else out.push({ part: null, chapters: [chapter] });
    }
  }
  return out;
}

/** The chosen chapters as the core takes them, with their text as it is in the editor now. */
export function bookContent(project: Project, chapterIds: readonly string[], author: string): BookContent {
  const chosen = new Set(chapterIds);
  const sections = bookOutline(project)
    .map((s) => ({
      part: s.part,
      chapters: s.chapters
        .filter((c) => chosen.has(c.id))
        .map((c) => ({ title: c.title, markdown: project.chapters[c.id]?.text ?? "" })),
    }))
    .filter((s) => s.chapters.length > 0);
  return { title: project.title, author, language: project.language, sections };
}

/** What project.json keeps of export: the presets the writer saved and the last choice. */
export interface ExportMemory {
  presets: { name: string; settings: ExportSettings }[];
  last: { presetName: string | null; settings: ExportSettings; format: ExportFormat } | null;
  author: string;
}

const FORMATS: ExportFormat[] = ["pdf", "epub", "docx", "markdown"];

export function readExportMemory(json: Record<string, unknown>): ExportMemory {
  const raw = (typeof json.export === "object" && json.export !== null ? json.export : {}) as Record<string, unknown>;
  const builtIn = new Set(BUILT_IN_PRESETS.map((p) => p.name));
  const presets = Array.isArray(raw.presets)
    ? raw.presets.flatMap((p: unknown) => {
        const r = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
        const name = typeof r.name === "string" ? r.name.trim() : "";
        return name && !builtIn.has(name) ? [{ name, settings: sanitizeExportSettings(r.settings) }] : [];
      })
    : [];
  const last = typeof raw.last === "object" && raw.last !== null ? (raw.last as Record<string, unknown>) : null;
  return {
    presets,
    last: last
      ? {
          presetName: typeof last.preset === "string" ? last.preset : null,
          settings: sanitizeExportSettings(last.settings),
          format: FORMATS.includes(last.format as ExportFormat) ? (last.format as ExportFormat) : "pdf",
        }
      : null,
    author: typeof json.author === "string" ? json.author : "",
  };
}

/** A file name for the book: its title, without characters file systems refuse. */
export function exportFileName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ").replace(/\s+/gu, " ").trim() || "Book";
  return `${base}.${extension}`;
}

/** The export part of project.json, as written. */
function exportJson(json: Record<string, unknown>): Record<string, unknown> {
  return typeof json.export === "object" && json.export !== null && !Array.isArray(json.export)
    ? { ...(json.export as Record<string, unknown>) }
    : {};
}

/**
 * Saves `settings` as the project's preset `name`, replacing one of that
 * name. Throws for an empty name or a built-in preset's, and when
 * project.json could not be read.
 */
export function withExportPreset(project: Project, name: string, settings: ExportSettings): ProjectJsonWrite {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("Give the preset a name.");
  if (BUILT_IN_PRESETS.some((p) => p.name === trimmed)) throw new Error(`“${trimmed}” is a built-in preset. Choose another name.`);
  const json = editableJson(project);
  const section = exportJson(json);
  const presets = Array.isArray(section.presets) ? section.presets : [];
  const others = presets.filter((p: unknown) => !(typeof p === "object" && p !== null && (p as { name?: unknown }).name === trimmed));
  section.presets = [...others, { name: trimmed, settings }];
  json.export = section;
  return { project: { ...project, json }, text: toText(json) };
}

/**
 * Remembers the last export's settings, format and preset, and the author,
 * so the next export starts from them. Null when nothing changes. Throws
 * when project.json could not be read.
 */
export function withExportChoice(
  project: Project,
  choice: { format: ExportFormat; settings: ExportSettings; author: string },
  presetName: string | null,
): ProjectJsonWrite | null {
  const json = editableJson(project);
  const section = exportJson(json);
  const last = { preset: presetName, settings: choice.settings, format: choice.format };
  const author = choice.author.trim();
  const sameLast = JSON.stringify(section.last ?? null) === JSON.stringify(last);
  const sameAuthor = (typeof json.author === "string" ? json.author : "") === author;
  if (sameLast && sameAuthor) return null;
  section.last = last;
  json.export = section;
  if (author === "") delete json.author;
  else json.author = author;
  return { project: { ...project, json }, text: toText(json) };
}
