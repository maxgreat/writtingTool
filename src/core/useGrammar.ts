import { useEffect, useMemo, useRef, useState } from "react";
import type { Backend, GrammarProblem, GrammarServer } from "./backend";
import { readableLine } from "./readable";

/** The grammar of a chapter is checked once typing has stopped this long. */
export const GRAMMAR_DELAY_MS = 800;
/** LanguageTool's public server takes 20 checks a minute: at most one every few seconds. */
export const SERVER_DELAY_MS = 4000;
/**
 * At most this many bytes of UTF-8 go in one request to a LanguageTool
 * server (the public one takes 20 KB; the core refuses over 18 KB). A
 * longer paragraph isn't sent at all.
 */
export const MAX_BATCH_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

/** What the grammar check knows of the open chapter. */
export interface Grammar {
  /** Each paragraph's problems, by the paragraph's text as it reads; the same map while they don't change. */
  problems: ReadonlyMap<string, readonly GrammarProblem[]>;
  /** Why the last check failed, for the writer; null when it worked. */
  error: string | null;
}

const NONE: ReadonlyMap<string, readonly GrammarProblem[]> = new Map();

/**
 * The grammar check of the open chapter (`text`, its Markdown), paragraph
 * by paragraph, each paragraph checked once while its text doesn't change.
 * English is checked offline by Harper unless `server` says otherwise; with
 * a LanguageTool server (the writer's choice, off by default) any language
 * it knows is checked there, more slowly. Off (`enabled` false): nothing.
 */
export function useGrammar(
  backend: Backend | null,
  language: string,
  text: string | null,
  enabled: boolean,
  server: GrammarServer | null,
): Grammar {
  const delay = server ? SERVER_DELAY_MS : GRAMMAR_DELAY_MS;
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), delay);
    return () => clearTimeout(timer);
  }, [text, delay]);

  /** The chapter's paragraphs as they read, without their Markdown. */
  const paragraphs = useMemo(() => {
    if (settled === null) return [];
    const found = new Set<string>();
    for (const line of settled.split("\n")) {
      // Headings are titles, not sentences.
      if (/^\s*#/u.test(line)) continue;
      const readable = readableLine(line).text;
      if (readable.trim() !== "") found.add(readable);
    }
    return [...found];
  }, [settled]);

  const key = `${language}\n${server ? JSON.stringify(server) : "harper"}`;
  const [answers, setAnswers] = useState<{ key: string; problems: Map<string, readonly GrammarProblem[]>; error: string | null }>(
    () => ({ key, problems: new Map(), error: null }),
  );
  const current = answers.key === key ? answers : { key, problems: new Map(), error: null };
  const asked = useRef({ key, paragraphs: new Set<string>() });
  const keyNow = useRef(key);
  keyNow.current = key;

  useEffect(() => {
    if (asked.current.key !== key) asked.current = { key, paragraphs: new Set() };
    if (!enabled || !backend?.checkGrammar) return;
    let missing = paragraphs.filter((p) => !asked.current.paragraphs.has(p));
    if (server) {
      // Too long for any request: never sent, so it never holds the others back.
      const tooLong = missing.filter((p) => utf8Length(p) > MAX_BATCH_BYTES);
      for (const p of tooLong) asked.current.paragraphs.add(p);
      missing = missing.filter((p) => !tooLong.includes(p));
    }
    if (missing.length === 0) return;
    // Batches small enough for a server, joined by blank lines; Harper takes them all at once.
    const batches: string[][] = [];
    let size = 0;
    for (const p of missing) {
      const bytes = utf8Length(p) + 2;
      if (batches.length === 0 || (server && size + bytes > MAX_BATCH_BYTES)) {
        batches.push([]);
        size = 0;
      }
      batches[batches.length - 1].push(p);
      size += bytes;
    }
    let cancelled = false;
    (async () => {
      for (const batch of batches) {
        if (cancelled) return;
        for (const p of batch) asked.current.paragraphs.add(p);
        try {
          const result = await backend.checkGrammar!(language, batch, server);
          setAnswers((a) => {
            if (keyNow.current !== key) return a;
            const base = a.key === key ? a : { key, problems: new Map<string, readonly GrammarProblem[]>(), error: null };
            const problems = new Map(base.problems);
            batch.forEach((p, i) => problems.set(p, result?.[i] ?? []));
            return { key, problems, error: null };
          });
        } catch (error) {
          // Asked again at the next change: a server may be busy for a moment.
          for (const p of batch) asked.current.paragraphs.delete(p);
          setAnswers((a) => (keyNow.current !== key ? a : { ...a, key, error: error instanceof Error ? error.message : String(error) }));
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend, language, paragraphs, enabled, server, key]);

  // Only the paragraphs of this chapter, as they are now: the same map while their problems don't change.
  const shown = useMemo(() => {
    if (!enabled) return NONE;
    const out = new Map<string, readonly GrammarProblem[]>();
    for (const p of paragraphs) {
      const found = current.problems.get(p);
      if (found && found.length > 0) out.set(p, found);
    }
    return out;
  }, [enabled, paragraphs, current.problems]);
  // The same map while the problems don't change, so the editors don't mark the chapter again for nothing.
  const signature = JSON.stringify([...shown.entries()]);
  const stable = useRef({ signature, map: shown });
  if (stable.current.signature !== signature) stable.current = { signature, map: shown };
  const map = stable.current.map;
  const error = enabled ? current.error : null;
  return useMemo(() => ({ problems: map.size === 0 ? NONE : map, error }), [map, error]);
}
