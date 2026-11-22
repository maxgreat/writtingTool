import type { NameMatcher } from "../core/names";
import type { Sheet, SheetType } from "../core/project";

/** "first_name" or "first-name" becomes "First name". */
export function fieldLabel(key: string): string {
  const words = key.replace(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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

/**
 * Every sheet whose name or alias appears in the text, with how often. Each
 * paragraph is one line, which is what the matcher expects. An alias shared
 * by several sheets counts for each of them.
 */
export function namesInText(text: string, matcher: NameMatcher, sheetsById: Map<string, Sheet>): NameCount[] {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    for (const match of matcher.find(line)) {
      for (const id of match.sheetIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
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
