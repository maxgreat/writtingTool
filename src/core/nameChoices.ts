import { normalizeName, type IgnoredName } from "./names";
import type { Project } from "./project";

/**
 * The writer's choices about names, kept in project.json so they travel
 * with the project and the chapter files stay clean: occurrences not to
 * highlight ("Ignore here", by sentence) and words that are not names.
 */

export interface ProjectJsonWrite {
  project: Project;
  /** project.json's new text. */
  text: string;
}

function editableJson(project: Project): Record<string, unknown> {
  if (project.jsonProblem) {
    throw new Error(`${project.jsonProblem.replace(/; using defaults\.$/u, ".")} Fix or remove it, then open the project again.`);
  }
  return structuredClone(project.json);
}

const toText = (json: Record<string, unknown>) => `${JSON.stringify(json, null, 2)}\n`;

const same = (a: IgnoredName, b: IgnoredName) => a.name === b.name && a.sentence === b.sentence;

/**
 * Ignores one occurrence of a name (`ignore`), or highlights it again.
 * Returns null when nothing changes. Throws when project.json could not be
 * read, since writing it would lose what is there.
 */
export function withIgnoredName(project: Project, entry: IgnoredName, ignore: boolean): ProjectJsonWrite | null {
  const target = { name: normalizeName(entry.name), sentence: entry.sentence };
  const has = project.ignoredNames.some((e) => same(e, target));
  if (has === ignore) return null;
  const json = editableJson(project);
  const listed = Array.isArray(json.ignoredNames) ? json.ignoredNames : [];
  const ignoredNames = ignore
    ? [...project.ignoredNames, target]
    : project.ignoredNames.filter((e) => !same(e, target));
  // Entries project.json holds that aren't this one stay as they are written.
  const isTarget = (item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    "name" in item &&
    "sentence" in item &&
    typeof item.name === "string" &&
    normalizeName(item.name) === target.name &&
    item.sentence === target.sentence;
  json.ignoredNames = ignore ? [...listed, target] : listed.filter((item: unknown) => !isTarget(item));
  if ((json.ignoredNames as unknown[]).length === 0) delete json.ignoredNames;
  return { project: { ...project, json, ignoredNames }, text: toText(json) };
}

/**
 * Marks a word as not a name (`notName`), so it is never offered as a
 * possible name, or takes the mark away. Returns null when nothing changes.
 * Throws when project.json could not be read.
 */
export function withNotName(project: Project, word: string, notName: boolean): ProjectJsonWrite | null {
  const target = normalizeName(word.trim());
  if (target === "" || project.notNames.includes(target) === notName) return null;
  const json = editableJson(project);
  const notNames = notName ? [...project.notNames, target] : project.notNames.filter((w) => w !== target);
  const listed = Array.isArray(json.notNames) ? json.notNames : [];
  json.notNames = notName
    ? [...listed, target]
    : listed.filter((w: unknown) => typeof w !== "string" || normalizeName(w) !== target);
  if ((json.notNames as unknown[]).length === 0) delete json.notNames;
  return { project: { ...project, json, notNames }, text: toText(json) };
}

/** The ignored occurrences of a sheet's name and other names, in the order they were ignored. */
export function ignoredFor(names: { text: string; ignoreCase: boolean }[], ignored: IgnoredName[]): IgnoredName[] {
  const exact = new Set(names.filter((n) => !n.ignoreCase).map((n) => normalizeName(n.text)));
  const anyCase = new Set(names.filter((n) => n.ignoreCase).map((n) => normalizeName(n.text).toLowerCase()));
  return ignored.filter((e) => exact.has(e.name) || anyCase.has(e.name.toLowerCase()));
}
