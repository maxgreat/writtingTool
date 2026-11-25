import { useEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { NameMatcher } from "./names";
import { accepts, spellingKey, wordsToCheck } from "./spelling";

/** The spelling of a chapter is checked once typing has stopped this long, so a word half typed isn't marked. */
export const SPELLING_DELAY_MS = 400;

/** What the spelling check knows of the open chapter. */
export interface Spelling {
  /** Misspelled words of the chapter, as spelling keys; the same set while they don't change. */
  misspelled: ReadonlySet<string>;
  /** Whether a dictionary checks the project's language: null until the first answer. */
  available: boolean | null;
}

interface Answers {
  language: string;
  available: boolean | null;
  /** Spelling key → whether the dictionary spells it this way. */
  correct: Map<string, boolean>;
}

const NO_WORDS: ReadonlySet<string> = new Set();

/**
 * The spelling check of the open chapter (`text`, its Markdown; null when
 * none is open), in the project's `language`. Each new word is asked about
 * once, in the background, a moment after typing stops. A word is marked
 * when the dictionary doesn't spell it so and it isn't a name, a possible
 * name (`suggestions`: names are never marked as misspelled), or one of the
 * words the writer added (`accepted`: the project's and personal
 * dictionaries). Nothing is marked when no dictionary is bundled for the
 * language, or the backend has none (the browser preview without its dev
 * server).
 */
export function useSpelling(
  backend: Backend | null,
  language: string,
  text: string | null,
  matcher: NameMatcher,
  suggestions: ReadonlySet<string>,
  accepted: ReadonlySet<string>,
): Spelling {
  // The text as of the last pause in typing.
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), SPELLING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  /** The chapter's words to check, by spelling key, with one way each is written. */
  const words = useMemo(() => {
    const found = new Map<string, string>();
    if (settled === null) return found;
    for (const line of settled.split("\n")) {
      for (const w of wordsToCheck(line, matcher.find(line))) {
        const key = spellingKey(w.word);
        if (!found.has(key)) found.set(key, w.word);
      }
    }
    return found;
  }, [settled, matcher]);

  const [answers, setAnswers] = useState<Answers>(() => ({ language, available: null, correct: new Map() }));
  const current: Answers = answers.language === language ? answers : { language, available: null, correct: new Map() };
  /** Words already asked about, for this language: each is asked once. */
  const asked = useRef({ language, words: new Set<string>() });
  const languageNow = useRef(language);
  languageNow.current = language;
  const unavailable = current.available === false;

  useEffect(() => {
    if (asked.current.language !== language) asked.current = { language, words: new Set() };
    if (unavailable) return;
    if (!backend?.checkWords) {
      setAnswers({ language, available: false, correct: new Map() });
      return;
    }
    const missing = [...words.keys()].filter((key) => !asked.current.words.has(key));
    if (missing.length === 0) return;
    for (const key of missing) asked.current.words.add(key);
    backend.checkWords(language, missing).then(
      (result) =>
        setAnswers((a) => {
          if (languageNow.current !== language) return a;
          const base = a.language === language ? a : { language, available: null, correct: new Map<string, boolean>() };
          if (result === null) return { ...base, available: false };
          const correct = new Map(base.correct);
          missing.forEach((key, i) => correct.set(key, result[i] ?? true));
          return { language, available: true, correct };
        }),
      () => {
        // Asked again next time: a failure may not last.
        for (const key of missing) asked.current.words.delete(key);
      },
    );
  }, [backend, language, words, unavailable]);

  const list = useMemo(() => {
    const out: string[] = [];
    for (const [key, written] of words) {
      if (current.correct.get(key) !== false) continue;
      if (accepts(accepted, key) || matcher.knows(written)) continue;
      if (suggestions.has(written.normalize("NFC"))) continue;
      out.push(key);
    }
    return out.sort();
  }, [words, current, accepted, matcher, suggestions]);

  // The same set while the words don't change, so the editors don't mark the chapter again for nothing.
  const joined = list.join("\n");
  const misspelled = useMemo(() => (joined === "" ? NO_WORDS : new Set(joined.split("\n"))), [joined]);
  return useMemo(() => ({ misspelled, available: current.available }), [misspelled, current.available]);
}
