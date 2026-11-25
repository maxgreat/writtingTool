import { editableJson, toText, type ProjectJsonWrite } from "./nameChoices";
import type { Project } from "./project";

/*
 * Settings that belong to the project, not the device, kept in
 * project.json so they travel with it.
 */

/**
 * Sets the project's language (a code such as "fr-CA"), which picks the
 * spelling dictionary, the grammar check and the typography. Returns null
 * when nothing changes. Throws when the code is empty, or project.json
 * could not be read (writing it would lose what is there).
 */
export function withLanguage(project: Project, code: string): ProjectJsonWrite | null {
  const language = code.trim();
  if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u.test(language)) {
    throw new Error(`“${code}” is not a language code, such as en-GB or fr-FR.`);
  }
  if (language === project.language) return null;
  const json = editableJson(project);
  json.language = language;
  return { project: { ...project, json, language }, text: toText(json) };
}
