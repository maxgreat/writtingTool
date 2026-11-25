import { safeName, type FileWrite } from "./binder";
import { DEFAULT_SHEET_TYPES } from "./project";

/** A project on this device, as the core lists it. */
export interface ProjectEntry {
  /** The project's folder, as its snapshot's root reports it. */
  path: string;
  title: string;
  /** In the app's own projects folder, rather than a folder opened from elsewhere. */
  inAppFolder: boolean;
  /** Synced with Dropbox. Absent where there is no Dropbox (the browser preview). */
  inDropbox?: boolean;
}

/** What a new project holds, for the core to create. */
export interface NewProject {
  /** Folder name; the core adds " 2", " 3"... if it is taken. */
  name: string;
  /** Parents first. */
  folders: string[];
  files: FileWrite[];
}

/** The languages a project can be written in at launch, with their variants. */
export const LANGUAGES = [
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "en-US", label: "English (United States)" },
  { code: "fr-FR", label: "French (France)" },
  { code: "fr-CA", label: "French (Canada)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "es-MX", label: "Spanish (Mexico)" },
] as const;

/** The best match for the device's preferred languages, or British English. */
export function defaultLanguage(preferred: readonly string[]): string {
  for (const wanted of preferred) {
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact.code;
    const base = wanted.split("-")[0].toLowerCase();
    const sameLanguage = LANGUAGES.find((l) => l.code.startsWith(`${base}-`));
    if (sameLanguage) return sameLanguage.code;
  }
  return "en-GB";
}

const FIRST_CHAPTER = "manuscript/01 Chapter one.md";

/** A new project: project.json, a first chapter, and the default sheet folders. */
export function newProject(title: string, language: string): NewProject {
  const cleanTitle = title.replace(/\s+/gu, " ").trim() || "Untitled";
  const json = {
    version: 1,
    title: cleanTitle,
    language,
    sheetTypes: DEFAULT_SHEET_TYPES,
    binder: [FIRST_CHAPTER],
  };
  return {
    name: safeName(cleanTitle),
    folders: ["manuscript", "sheets", ...DEFAULT_SHEET_TYPES.map((t) => `sheets/${t.folder}`)],
    files: [
      { path: "project.json", text: `${JSON.stringify(json, null, 2)}\n` },
      { path: FIRST_CHAPTER, text: "# Chapter one\n" },
    ],
  };
}

const RECENT_KEY = "writingTool.recentProjects";
const RECENT_KEPT = 10;

/** Folders of projects opened on this device, most recent first. */
export function readRecentProjects(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string").slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
}

/** Puts a project's folder first in the recent list. */
export function rememberRecentProject(path: string): void {
  const next = [path, ...readRecentProjects().filter((p) => p !== path)].slice(0, RECENT_KEPT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; the project still opens.
  }
}
