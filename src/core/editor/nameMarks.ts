import type { NameMatch } from "../names";
import type { NameHit } from "./types";

/**
 * Both editors render a highlighted name as an element with these classes:
 *
 *   name-mark                 every highlighted name
 *   name-mark--<kind>         the sheet type: characters, places, or a user type
 *   name-mark--ambiguous      an alias shared by two or more sheets
 *
 * a `data-sheets` attribute holding the sheet ids as a JSON array, and
 * `data-name` and `data-sentence`: the occurrence as "Ignore here"
 * remembers it (the name as written, and its sentence's key).
 */
export const NAME_MARK_CLASS = "name-mark";

export function nameMarkAttributes(match: NameMatch, sentence: string): Record<string, string> {
  const kind = match.kind.toLowerCase().replace(/[^a-z0-9-]/gu, "-");
  const classes = [NAME_MARK_CLASS, `${NAME_MARK_CLASS}--${kind}`];
  if (match.ambiguous) classes.push(`${NAME_MARK_CLASS}--ambiguous`);
  return {
    class: classes.join(" "),
    "data-sheets": JSON.stringify(match.sheetIds),
    "data-name": match.text,
    "data-sentence": sentence,
  };
}

/** The highlighted name an event happened on, if any. Use it for clicks and hovers. */
export function nameMarkAt(target: EventTarget | null): NameHit | null {
  const element = target instanceof Element ? target.closest(`.${NAME_MARK_CLASS}`) : null;
  if (!element) return null;
  let ids: unknown;
  try {
    ids = JSON.parse(element.getAttribute("data-sheets") ?? "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) return null;
  return {
    sheetIds: ids,
    ambiguous: ids.length > 1,
    rect: element.getBoundingClientRect(),
    occurrence: { name: element.getAttribute("data-name") ?? "", sentence: element.getAttribute("data-sentence") ?? "" },
  };
}
