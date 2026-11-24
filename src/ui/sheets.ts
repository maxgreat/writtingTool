import type { Sheet, SheetType } from "../core/project";

/** "first_name" or "first-name" becomes "First name". */
export function fieldLabel(key: string): string {
  const words = key.replace(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value made of digits and separators (an age, a date, a time), shown with tabular figures. */
export function looksNumeric(value: string): boolean {
  return /^[\d\s.,:/+−-]+$/u.test(value);
}

const NOUNS = new Map([
  ["characters", "character"],
  ["places", "place"],
  ["notes", "note"],
]);

/** One sheet of a type, for "New character": the default types have their own word, others are sheets. */
export function sheetNoun(folder: string): string {
  return NOUNS.get(folder) ?? "sheet";
}

/**
 * The binder's action for a new sheet of a type: "New character". Types
 * without their own word name their group, so two of them in one menu
 * don't both read "New sheet".
 */
export function newSheetLabel(type: SheetType): string {
  const noun = sheetNoun(type.folder);
  return NOUNS.has(type.folder) ? `New ${noun}` : `New ${noun} in ${type.label}`;
}

/**
 * Removes Markdown markers from one line so it reads as plain text. As in
 * Notes, underscores only count at word edges, so "Smith_and_Sons" stays.
 */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:>\s?)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/u, "")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])__(.+?)__(?![\p{L}\p{N}])/gu, "$1")
    .replace(/\*(.+?)\*/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])_(.+?)_(?![\p{L}\p{N}])/gu, "$1")
    .trim();
}

/** The first line of a sheet's notes, without Markdown markers. */
export function firstNotesLine(body: string): string {
  for (const line of body.split("\n")) {
    if (/^\s*(?:\*\s*){3,}$/u.test(line)) continue;
    const text = plainLine(line);
    if (text !== "") return text;
  }
  return "";
}

/** What a summary card shows: the first field (such as role) and the first line of notes. */
export function sheetSummary(sheet: Sheet): { field: [string, string] | null; firstLine: string } {
  return { field: sheet.fields[0] ?? null, firstLine: firstNotesLine(sheet.body) };
}

export interface NameCount {
  sheet: Sheet;
  count: number;
}

/** The sheets in a chapter's name counts, most mentioned first. Counts for sheets that are gone are left out. */
export function namesFromCounts(counts: ReadonlyMap<string, number>, sheetsById: Map<string, Sheet>): NameCount[] {
  const found: NameCount[] = [];
  for (const [id, count] of counts) {
    const sheet = sheetsById.get(id);
    if (sheet) found.push({ sheet, count });
  }
  return found.sort((a, b) => b.count - a.count || a.sheet.name.localeCompare(b.sheet.name));
}

/** Groups items by sheet type, in the project's order of types, leaving out empty groups. */
export function groupByType<T>(items: T[], types: SheetType[], kindOf: (item: T) => string) {
  return types
    .map((type) => ({ type, items: items.filter((item) => kindOf(item) === type.folder) }))
    .filter((group) => group.items.length > 0);
}

/** The sheet called exactly this, by name or alias, if there is one and only one. */
export function sheetNamed(sheets: Sheet[], name: string): Sheet | null {
  const wanted = name.trim().normalize("NFC");
  if (wanted === "") return null;
  const hits = sheets.filter(
    (s) => s.name.normalize("NFC") === wanted || s.aliases.some((a) => a.text.normalize("NFC") === wanted),
  );
  return hits.length === 1 ? hits[0] : null;
}
