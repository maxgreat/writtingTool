import type { NameMatch } from "./names";

/*
 * The spelling check's words. The Rust core checks them against the
 * bundled Hunspell dictionary of the project's language; this module picks
 * the words of a paragraph worth checking, and holds the words the writer
 * added: the project's dictionary.txt and the personal dictionary, which is
 * for every project on this device.
 */

/** A word of a paragraph to check, where it is in the paragraph. */
export interface WordToCheck {
  /** The word as written. */
  word: string;
  from: number;
  to: number;
}

/** Letters and digits, with apostrophes and hyphens inside: "don’t", "l'auberge" and "sea-green" are one word. */
const TOKEN = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
/** A character reference such as `&nbsp;` in a Markdown line (the formatted editor writes one for an empty paragraph). */
const ENTITY = /(?<!\\)&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/giu;

/**
 * The words of one paragraph to check: a line of a chapter's Markdown, or a
 * paragraph's text in the formatted editor. Left out: the highlighted
 * names (`names`, as `matcher.find(line)` gives them, so "Arwen's" or
 * "d'Arwen" isn't checked either), single letters, words with digits
 * ("3rd", "B12"), and words in capitals ("NASA", a shout), which
 * dictionaries rarely list.
 */
export function wordsToCheck(line: string, names: readonly NameMatch[] = []): WordToCheck[] {
  // References become spaces, so offsets stay those of the line.
  const text = line.includes("&") ? line.replace(ENTITY, (m) => " ".repeat(m.length)) : line;
  const found: WordToCheck[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const word = match[0];
    const from = match.index;
    const to = from + word.length;
    if ([...word].length < 2 || /\p{N}/u.test(word)) continue;
    if (!/\p{Ll}/u.test(word)) continue;
    if (names.some((n) => n.from < to && from < n.to)) continue;
    found.push({ word, from, to });
  }
  return found;
}

/**
 * The word to check at `offset` in a paragraph (a caret just after it
 * counts), as wordsToCheck finds it: where it is, or null between words.
 */
export function wordToCheckAt(line: string, offset: number): WordToCheck | null {
  for (const match of line.matchAll(TOKEN)) {
    const from = match.index;
    const to = from + match[0].length;
    if (from <= offset && offset <= to) return { word: match[0], from, to };
    if (from > offset) break;
  }
  return null;
}

/** The key a word is checked and remembered by: composed (NFC), with the typographic apostrophe, as written otherwise. */
export function spellingKey(word: string): string {
  return word.normalize("NFC").replace(/'/gu, "’");
}

/**
 * The words of a dictionary file: one per line, blank lines and lines
 * starting with "#" left out, as keys (see spellingKey).
 */
export function parseWordList(text: string | null | undefined): string[] {
  if (!text) return [];
  const words: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    words.push(spellingKey(line));
  }
  return words;
}

/**
 * A dictionary file's text with `word` added as its last line. The rest of
 * the file stays as it was, so comments and the writer's order are kept.
 */
export function withWordAdded(text: string | null | undefined, word: string): string {
  const before = text ?? "";
  const separator = before === "" || before.endsWith("\n") ? "" : "\n";
  return `${before}${separator}${word.normalize("NFC")}\n`;
}

/**
 * Whether `words` (keys) accept `word` as written. As the dictionaries do,
 * a word listed in lower case is also accepted with a capital ("Hello" for
 * "hello"), but a word listed with a capital is not accepted in lower case.
 */
export function accepts(words: ReadonlySet<string>, word: string): boolean {
  const key = spellingKey(word);
  if (words.has(key)) return true;
  const first = key.charAt(0);
  const lowerFirst = first.toLowerCase();
  return first !== lowerFirst && words.has(lowerFirst + key.slice(1));
}

/* The personal dictionary ------------------------------------------------------- */

const PERSONAL_KEY = "writingTool.personalDictionary.v1";

/** The personal dictionary: words added for every project, on this device. */
export function readPersonalDictionary(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PERSONAL_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string").map(spellingKey) : [];
  } catch {
    return [];
  }
}

/** Adds a word to the personal dictionary; resolves to the words now in it. Throws when it can't be remembered. */
export function addToPersonalDictionary(word: string): string[] {
  const words = readPersonalDictionary();
  const key = spellingKey(word);
  if (!words.includes(key)) words.push(key);
  localStorage.setItem(PERSONAL_KEY, JSON.stringify(words));
  return words;
}
