/*
 * Typing aids: each language's typography applied as a character is typed,
 * and the writer's auto-replacements ("teh" becomes "the"). Both editors
 * ask `typedText` what a typed character becomes, given the text before the
 * caret in its paragraph, so they apply the same rules.
 */

/** The typography rules for a language. */
export type Typography = "en" | "fr" | "es" | "none";

/** Each project language's rules: English, French and Spanish have their own; others get none. */
export function typographyFor(language: string): Typography {
  const lang = language.trim().toLowerCase().split(/[-_]/u)[0];
  return lang === "en" || lang === "fr" || lang === "es" ? lang : "none";
}

/** No-break space: French puts it inside « » and before a colon. */
export const NBSP = " ";
/** Narrow no-break space: French puts it before ; ! and ?. */
export const NNBSP = " ";

/** A word typed wrong, and what it becomes. */
export interface Replacement {
  from: string;
  to: string;
}

/** The replacements a new device starts with; the writer can change them. */
export const DEFAULT_REPLACEMENTS: Replacement[] = [
  { from: "teh", to: "the" },
  { from: "adn", to: "and" },
  { from: "taht", to: "that" },
  { from: "recieve", to: "receive" },
  { from: "wich", to: "which" },
];

/** What a typed character does: delete `replace` characters before the caret, then insert `insert` there. */
export interface TypedText {
  replace: number;
  insert: string;
  /**
   * The end of `insert` that stands for the typed character itself (“ for
   * ", " ?" for ? in French, © for the ")" of "(c)"): it takes that
   * character's formatting, the rest of `insert` the formatting of the
   * text it replaces.
   */
  typed: string;
}

/** After one of these, a quote opens rather than closes. */
const OPENS_BEFORE = /(?:^|[\s([{—–«“‘¿¡/])$/u;
const WORD_END = /[\p{L}\p{M}\p{N}]$/u;
/** Characters that end a word, so the word before them can be replaced. */
const ENDS_WORD = /^[\s.,;:!?)\]}"”»…]$/u;
/** A character inside a word: a word replacement only starts after one of these is absent. */
const IN_WORD = /[\p{L}\p{M}\p{N}'’-]/u;

/**
 * What typing `typed` (one character) does after `before`, the text before
 * the caret in its paragraph, under `rules`, with the writer's
 * `replacements`. Null when it is typed as it is.
 *
 * - Quotes: " opens or closes, as “ ” in English and « » in French and
 *   Spanish (French with a no-break space inside); ' is an apostrophe (’),
 *   or in English an opening ‘ at the start of a word.
 * - Two hyphens become an em dash (—): the Spanish dialogue dash, and a
 *   dash in English and French.
 * - French puts a narrow no-break space before ; ! ? and a no-break space
 *   before :, replacing a space typed there, but not between digits
 *   (12:30) or after another of them (?!).
 * - A replacement of words ("teh", "i'm", "teh boat") applies when they
 *   are ended by a space or punctuation, keeping a capital typed at their
 *   start; one ending in a symbol ("(c)", "->", "...") applies as soon as
 *   it is typed, before the language's typography. Apostrophes match
 *   either way, and the replacement's are curled with the typography.
 */
export function typedText(
  before: string,
  typed: string,
  rules: Typography,
  replacements: readonly Replacement[] = [],
): TypedText | null {
  const written = (to: string) => (rules === "none" ? to : to.replace(/'/gu, "’"));
  const symbol = symbolReplacement(before, typed, replacements);
  if (symbol) return { replace: symbol.replace, insert: symbol.prefix + written(symbol.to), typed: written(symbol.to) };
  const typography = rules === "none" ? null : typographyOf(before, typed, rules);
  if (replacements.length === 0 || !ENDS_WORD.test(typed)) return typography;
  // The words end where the typography's text starts (after any space it takes back),
  // before any emphasis markers that close on them ("*teh*").
  const { replace, insert } = typography ?? { replace: 0, insert: typed, typed };
  const kept = before.slice(0, before.length - replace);
  const markers = MARKERS_AT_END.exec(kept)?.[0] ?? "";
  const found = wordReplacement(kept.slice(0, kept.length - markers.length), replacements);
  if (!found) return typography;
  return {
    replace: replace + markers.length + found.replace,
    insert: found.prefix + written(found.to) + markers + insert,
    typed: insert,
  };
}

/** Markdown's emphasis markers at the end of a text: what is typed after them follows the text before them. */
const MARKERS_AT_END = /[*_]+$/u;

/** A piece of text as it is, and as it was typed before the typography changed it. */
interface Unit {
  text: string;
  typed: string;
}

/**
 * A text as it was typed: what the typography made of each key read back
 * (’ ‘ as ', “ ” « » as ", — as --, French no-break spaces as nothing), so
 * a replacement matches whatever the typography did to its keys.
 */
function asTyped(text: string): Unit[] {
  const chars = [...text];
  const out: Unit[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (c === "«" && next === NBSP) {
      out.push({ text: c + next, typed: '"' });
      i++;
    } else if ((c === NBSP || c === NNBSP) && (next === "»" || (next !== undefined && ";:!?".includes(next)))) {
      if (next === "»") {
        out.push({ text: c + next, typed: '"' });
        i++;
      } else {
        out.push({ text: c, typed: "" });
      }
    } else if (c === "‘" || c === "’") out.push({ text: c, typed: "'" });
    else if (c === "“" || c === "”" || c === "«" || c === "»") out.push({ text: c, typed: '"' });
    else if (c === "—") out.push({ text: c, typed: "--" });
    else out.push({ text: c, typed: c });
  }
  return out;
}

const typedForm = (text: string) =>
  asTyped(text)
    .map((u) => u.typed)
    .join("");

/**
 * Whether `units` end with `from` as typed. If so: how many characters of
 * the text it covers, what of the first piece it covers isn't part of it
 * (half of an em dash, say, to put back), and the character before it,
 * for word starts.
 */
function matchEnd(units: Unit[], from: string): { replace: number; prefix: string; before: string } | null {
  let typed = "";
  let replace = 0;
  let k = units.length;
  while (k > 0 && typed.length < from.length) {
    k--;
    typed = units[k].typed + typed;
    replace += units[k].text.length;
  }
  if (typed.length < from.length || !typed.endsWith(from)) return null;
  const prefix = typed.slice(0, typed.length - from.length);
  // For word starts, the character before as it is in the text: "—teh" starts a word, "sea-teh" doesn't.
  const earlier = prefix !== "" ? prefix : k > 0 ? units[k - 1].text : "";
  return { replace, prefix, before: [...earlier].at(-1) ?? "" };
}

/** Whether a replacement's text ends in a word ("teh", "i'm") rather than a symbol ("(c)", "->"). */
const endsInWord = (from: string) => WORD_END.test(from);

/**
 * A replacement ending in a symbol that `typed` completes (the longest),
 * with how many characters before the caret it takes and what of them it
 * puts back.
 */
function symbolReplacement(
  before: string,
  typed: string,
  replacements: readonly Replacement[],
): { to: string; replace: number; prefix: string } | null {
  const units = [...asTyped(before), { text: "", typed }];
  let best: { to: string; replace: number; prefix: string; length: number } | null = null;
  for (const r of replacements) {
    const from = typedForm(r.from);
    if (endsInWord(r.from) || from === "") continue;
    const match = matchEnd(units, from);
    if (match && (!best || from.length > best.length)) best = { to: r.to, replace: match.replace, prefix: match.prefix, length: from.length };
  }
  return best;
}

/**
 * The replacement of words that `text` ends with, starting at a word's
 * start (the longest, if several), with how many characters it takes and
 * what of them it puts back: as written, or with a capital at its start
 * ("Teh" gives "The").
 */
function wordReplacement(
  text: string,
  replacements: readonly Replacement[],
): { to: string; replace: number; prefix: string } | null {
  const units = asTyped(text);
  let best: { to: string; replace: number; prefix: string; length: number } | null = null;
  for (const r of replacements) {
    if (!endsInWord(r.from)) continue;
    const from = typedForm(r.from);
    const variants: [string, string][] = [[from, r.to]];
    if (capitalized(from) !== from) variants.push([capitalized(from), capitalized(r.to)]);
    for (const [form, to] of variants) {
      const match = matchEnd(units, form);
      if (!match) continue;
      if (match.before !== "" && IN_WORD.test(match.before) && IN_WORD.test(form[0])) continue;
      if (!best || form.length > best.length) best = { to, replace: match.replace, prefix: match.prefix, length: form.length };
      break;
    }
  }
  return best;
}

/** The language's typography for a typed character: all of what it writes stands for that character. */
function typographyOf(before: string, typed: string, rules: Exclude<Typography, "none">): TypedText | null {
  const change = typographyChange(before, typed, rules);
  return change && { ...change, typed: change.insert };
}

function typographyChange(
  before: string,
  typed: string,
  rules: Exclude<Typography, "none">,
): { replace: number; insert: string } | null {
  // An emphasis marker opening italics or bold ("*" in plain mode, or before the formatted editor turns it
  // into italics) doesn't decide whether a quote opens: what comes before it does.
  const opensAfter = OPENS_BEFORE.test(before.replace(MARKERS_AT_END, ""));
  if (typed === '"') {
    // A quote opened earlier in the paragraph closes now; otherwise it opens after a space or an opening mark.
    const [open, close] = rules === "en" ? ["“", "”"] : ["«", "»"];
    const opening = count(before, open) <= count(before, close) && opensAfter;
    if (rules === "en") return { replace: 0, insert: opening ? "“" : "”" };
    if (rules === "es") return { replace: 0, insert: opening ? "«" : "»" };
    if (opening) return { replace: 0, insert: `«${NBSP}` };
    // A space typed before the closing quote becomes the no-break one.
    return before.endsWith(" ") ? { replace: 1, insert: `${NBSP}»` } : { replace: 0, insert: `${NBSP}»` };
  }
  if (typed === "'") {
    if (rules === "en" && opensAfter) return { replace: 0, insert: "‘" };
    return { replace: 0, insert: "’" };
  }
  if (typed === "-" && before.endsWith("-") && !before.endsWith("--")) {
    return { replace: 1, insert: "—" };
  }
  if (rules === "fr" && (typed === ";" || typed === "!" || typed === "?" || typed === ":")) {
    const space = typed === ":" ? NBSP : NNBSP;
    // Markers closing italics or bold ("*Quoi*?") are looked through: the space goes after them,
    // outside the emphasis, as in the formatted editor once they have become italics.
    const markers = MARKERS_AT_END.exec(before)?.[0] ?? "";
    const core = before.slice(0, before.length - markers.length);
    const last = core.at(-1) ?? "";
    if (core === "" || last === NBSP || last === NNBSP) return null;
    // Two in a row (?! or !!) share the space before the first.
    if ("?!;:".includes(last)) return null;
    // A time or a ratio (12:30) keeps its colon tight.
    if (typed === ":" && /\d$/u.test(core)) return null;
    if (last === " ") return markers === "" ? { replace: 1, insert: `${space}${typed}` } : null;
    if (WORD_END.test(core) || /[»)\]’”…]$/u.test(core)) return { replace: 0, insert: `${space}${typed}` };
  }
  return null;
}

function count(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/* The writer's settings ------------------------------------------------------------ */

/** Whether a replacement list entry is usable: a word to replace that isn't empty, and something else to put. */
export function isReplacement(value: unknown): value is Replacement {
  if (typeof value !== "object" || value === null) return false;
  const { from, to } = value as Record<string, unknown>;
  return typeof from === "string" && typeof to === "string" && from.trim() !== "" && from.trim() !== to.trim();
}
