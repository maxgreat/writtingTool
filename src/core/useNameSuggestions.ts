import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "./backend";
import { NameIndex } from "./nameIndex";
import { normalizeName, type NameMatcher } from "./names";
import { MIN_POSSIBLE_NAME_COUNT, type PossibleName } from "./possibleNames";
import type { Project } from "./project";

/**
 * Possible names across the book, offered in the text (marked words) and in
 * the inspector: capitalized words that are not at the start of a sentence,
 * not a sheet's name or alias, and not marked as not names (see
 * possibleNames.ts).
 *
 * With a dictionary for the project's language, every such word that isn't
 * an ordinary word written with a capital ("River", "Monday") is offered,
 * from its first use. Without one (another language, or the browser
 * preview), a word is offered once it is found MIN_POSSIBLE_NAME_COUNT
 * times.
 */
export interface NameSuggestions {
  /** Most found first. */
  list: PossibleName[];
  /** The same words, for marking them in the text; the same set while they don't change. */
  words: ReadonlySet<string>;
  /**
   * How words are chosen: "dictionary" (any word that isn't an ordinary
   * word, from its first use), "count" (no dictionary: found
   * MIN_POSSIBLE_NAME_COUNT times or more), or null until that is known.
   */
  rule: "dictionary" | "count" | null;
}

interface Answers {
  language: string;
  /** Whether a dictionary answered: null until the first answer. */
  available: boolean | null;
  /** Word → whether it is an ordinary word. */
  ordinary: Map<string, boolean>;
}

const NO_WORDS: ReadonlySet<string> = new Set();

/**
 * The book is read in the background (useDeferredValue), never in the
 * render that shows the project or a change: the first render offers
 * nothing, then the whole book is read (about 200 ms for a long novel),
 * then only the chapter being typed in. A new matcher (a sheet added or
 * renamed) is taken in the background too, and reads the book again there.
 * The words are kept in an index of this hook's own, so its scans never
 * clear the counts the inspector keeps in the workspace's. The dictionary
 * is asked once per new word.
 */
export function useNameSuggestions(backend: Backend | null, project: Project, matcher: NameMatcher): NameSuggestions {
  const { chapterOrder, chapters, notNames, language } = project;
  const [index] = useState(() => new NameIndex());
  const book = useMemo(() => chapterOrder.flatMap((id) => chapters[id] ?? []), [chapterOrder, chapters]);
  const scanned = useDeferredValue(book, null);
  const scanMatcher = useDeferredValue(matcher);
  const settled = useMemo(() => new Set(notNames), [notNames]);

  // Every candidate found once or more, as of the deferred book and matcher.
  // It depends on nothing else, so a render with only urgent changes (a
  // word marked as not a name) never reads the book again. The list below
  // checks each word against the current sheets and choices.
  const candidates = useMemo(
    () => (scanned === null ? [] : index.possibleNames(scanned, scanMatcher, (word) => scanMatcher.knows(word), 1)),
    [scanned, index, scanMatcher],
  );

  const [answers, setAnswers] = useState<Answers>(() => ({ language, available: null, ordinary: new Map() }));
  const current: Answers = answers.language === language ? answers : { language, available: null, ordinary: new Map() };
  /** Words already asked about, for this language: each word is asked once. */
  const asked = useRef({ language, words: new Set<string>() });
  const noDictionary = current.available === false;
  /** The project's language now, so an answer for one it had before is dropped. */
  const languageNow = useRef(language);
  languageNow.current = language;

  // Ask the dictionary about new words. An answer for another language (the
  // project's changed meanwhile) is dropped; a request in flight is never
  // cancelled, so typing fast can't keep words from being answered.
  useEffect(() => {
    if (asked.current.language !== language) asked.current = { language, words: new Set() };
    if (noDictionary) return;
    if (!backend?.ordinaryWords) {
      setAnswers({ language, available: false, ordinary: new Map() });
      return;
    }
    const missing = candidates.map((c) => c.word).filter((word) => !asked.current.words.has(word));
    if (missing.length === 0) return;
    for (const word of missing) asked.current.words.add(word);
    backend.ordinaryWords(language, missing).then(
      (result) =>
        setAnswers((a) => {
          if (languageNow.current !== language) return a;
          const base = a.language === language ? a : { language, available: null, ordinary: new Map<string, boolean>() };
          if (result === null) return { ...base, available: false };
          const ordinary = new Map(base.ordinary);
          missing.forEach((word, i) => ordinary.set(word, result[i] ?? false));
          return { language, available: true, ordinary };
        }),
      () => {
        // Without answers, the rule for books without a dictionary applies.
        setAnswers((a) =>
          languageNow.current !== language ? a : { language, available: false, ordinary: a.language === language ? a.ordinary : new Map() },
        );
      },
    );
  }, [backend, language, candidates, noDictionary]);

  // Checked against the matcher and choices of this render, not the deferred
  // ones: a word made a sheet or marked as not a name leaves the list at once.
  const list = useMemo(() => {
    if (current.available === null) return [];
    const open = candidates.filter((c) => !matcher.knows(c.word) && !settled.has(normalizeName(c.word)));
    if (!current.available) return open.filter((c) => c.count >= MIN_POSSIBLE_NAME_COUNT);
    return open.filter((c) => current.ordinary.get(c.word) === false);
  }, [candidates, current, matcher, settled]);

  // The same set while the words don't change, so the editors don't mark the chapter again for nothing.
  const key = list
    .map((p) => p.word)
    .sort()
    .join("\n");
  const words = useMemo(() => new Set(key === "" ? [] : key.split("\n")), [key]);
  const rule = current.available === null ? null : current.available ? "dictionary" : "count";
  return useMemo(() => ({ list, words: list.length === 0 ? NO_WORDS : words, rule }), [list, words, rule]);
}
