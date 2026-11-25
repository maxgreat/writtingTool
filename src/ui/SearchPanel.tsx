import { CaseSensitive, ChevronRight, Replace, WholeWord, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from "react";
import type { SearchMatch, SearchOptions } from "../core/search";
import { useBackLayer } from "./BackStack";
import { cx, errorMessage, focusLost, formatCount, plural, revealIn } from "./dom";

/** What Find in book needs from the workspace: the book's text in memory, and the editor to show a match in. */
export interface SearchSource {
  /** Chapters in reading order, with their titles (for the result groups). */
  chapters: { id: string; title: string }[];
  /** Every match across the book, in reading order (fast, synchronous: it runs on the text in memory). */
  find(query: string, options: SearchOptions): SearchMatch[];
  /** Opens the match's chapter and selects the match in the text. */
  open(match: SearchMatch): void;
  /**
   * Replaces the given matches (all from find, still current) with `replacement`; returns how many
   * were replaced (matches across formatting are skipped, and so is one whose replacing would change
   * the formatting around it: its italics or bold, or the paragraphs and headings on either side).
   * Throws with a reason when it can't.
   */
  replace(matches: SearchMatch[], replacement: string): number;
  /** The text is being changed elsewhere (another project opening): replacing waits. */
  busy: boolean;
}

export interface SearchPanelProps {
  source: SearchSource;
  /** Bumps when the panel is opened again from a shortcut or the menu: focus goes to the Find field, its text selected. */
  focusRequest: number;
  /** "find" or "replace": Replace shows the replacement field (Ctrl+H); the writer can switch. */
  initialMode: "find" | "replace";
  /** The selection in the text when it was opened, to fill Find with (empty for none). */
  initialQuery: string;
  /**
   * What is being searched for, once typing pauses, and each time it or an option changes (an
   * empty query: nothing), so the workspace can mark the matches in the text.
   */
  onSearchChange?(query: string, options: SearchOptions): void;
  onClose(): void;
}

/** The pause after the last key in Find before the book is searched. */
export const SEARCH_DELAY_MS = 150;
/** Results listed at most; past this, the list asks for a narrower search (Replace all still covers them all). */
export const RESULT_LIMIT = 1000;
/** Characters kept before a match in its row, so the match shows in the narrowest panel. */
const LEAD_CHARS = 12;
/** findInChapter's context: at most this many characters each side of a match. */
const CONTEXT_CHARS = 40;

/** A selection fills Find only when it is on one line: a paragraph break can't be searched for. */
function oneLine(text: string): string {
  return /[\r\n]/u.test(text) ? "" : text;
}

/**
 * A result's line: a few words before the match, the match, and what follows, with an ellipsis
 * where the paragraph goes on past what is shown. The row clips the end to its width.
 */
export function resultLine(match: SearchMatch): { lead: string; text: string; trail: string } {
  let lead = match.before;
  if (lead.length > LEAD_CHARS) {
    const start = lead.length - LEAD_CHARS;
    const tail = lead.slice(start);
    // Start at a word: drop the part of one the cut went through.
    const cut = /\s/u.test(lead[start - 1]) ? tail : tail.replace(/^\S*\s+/u, "");
    lead = `…${(cut === "" ? tail : cut).trimStart()}`;
  }
  const trail = match.after.length >= CONTEXT_CHARS ? `${match.after}…` : match.after;
  return { lead, text: match.text, trail };
}

interface Group {
  chapterId: string;
  title: string;
  /** All of the chapter's results, listed or not. */
  count: number;
  /** The results listed, with their place in the book's list. */
  rows: { match: SearchMatch; index: number }[];
}

/** The results by chapter, in reading order (find's order). */
function groupResults(matches: readonly SearchMatch[], chapters: readonly { id: string; title: string }[]): Group[] {
  const titles = new Map(chapters.map((c) => [c.id, c.title]));
  const groups: Group[] = [];
  matches.forEach((match, index) => {
    let group = groups.at(-1);
    if (!group || group.chapterId !== match.chapterId) {
      const title = titles.get(match.chapterId) ?? match.chapterId;
      group = { chapterId: match.chapterId, title, count: 0, rows: [] };
      groups.push(group);
    }
    group.count += 1;
    if (index < RESULT_LIMIT) group.rows.push({ match, index });
  });
  return groups;
}

const samePlace = (a: SearchMatch, b: SearchMatch) =>
  a.chapterId === b.chapterId && a.line === b.line && a.from === b.from;

/**
 * What Replace all, or a row's Replace, says it did: of the `wanted` it was given, how many were
 * replaced, and why the rest were left (their text can't be written with the formatting around
 * them kept: italics or bold, paragraphs or headings); then the `skipped` ones partly italic or
 * bold, never given to it.
 */
function replacedNote(replaced: number, wanted: number, skipped: number): string {
  const left = wanted - replaced;
  const crossing =
    skipped === 0 ? "" : ` Left ${formatCount(skipped)} that ${skipped === 1 ? "is" : "are"} partly italic or bold.`;
  if (left <= 0) return `Replaced ${formatCount(replaced)}.${crossing}`;
  const one = left === 1;
  let which: string;
  if (replaced > 0) which = `the other ${one ? "one" : formatCount(left)}`;
  else which = one ? "that one" : `all ${formatCount(left)}`;
  const why = `Replacing ${which} would change the formatting around ${one ? "it: change it" : "them: change those"} in the text.`;
  // None replaced: the sentence alone says so.
  const done = replaced > 0 ? `Replaced ${formatCount(replaced)} of ${formatCount(wanted)}. ` : "";
  return `${done}${why}${crossing}`;
}

/**
 * Find in book: searches every chapter as the writer types, lists the results by chapter, and
 * opens one in the editor on a click or Enter. Replace adds the replacement, a Replace on each
 * row, and Replace all, which asks once more first, as Undo only reaches the open chapter.
 * Shown in the inspector's place on desktop, as its overlay on phones.
 */
export function SearchPanel({
  source,
  focusRequest,
  initialMode,
  initialQuery,
  onSearchChange,
  onClose,
}: SearchPanelProps): JSX.Element {
  const { busy } = source;
  /** Find as typed, and as last searched for, a short pause behind it. */
  const [query, setQuery] = useState(() => oneLine(initialQuery));
  const [searched, setSearched] = useState(query);
  const [options, setOptions] = useState<SearchOptions>({ matchCase: false, wholeWord: false });
  const [replacing, setReplacing] = useState(initialMode === "replace");
  const [replacement, setReplacement] = useState("");
  /** The result last opened in the editor: Enter goes on from there. */
  const [active, setActive] = useState<SearchMatch | null>(null);
  /** The row Tab lands on in the list; the arrow keys move it. */
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  /** What the last replace did, and why the last one failed. */
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const ids = useId();
  const headingId = `${ids}-heading`;
  const replaceRegionId = `${ids}-replace`;
  const questionId = `${ids}-question`;
  const crossingId = `${ids}-crossing`;

  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const allRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Opened again: the selection, if any, fills Find, and Ctrl+H opens Replace. Ctrl+F leaves it as it is.
  const [request, setRequest] = useState(focusRequest);
  if (request !== focusRequest) {
    setRequest(focusRequest);
    const seeded = oneLine(initialQuery);
    if (seeded !== "") {
      if (seeded !== query) {
        setActive(null);
        setCursor(0);
      }
      setQuery(seeded);
      setSearched(seeded);
    }
    if (initialMode === "replace") setReplacing(true);
    setConfirming(false);
    setNote("");
    setFailure(null);
  }

  useEffect(() => {
    const input = findRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusRequest]);

  useEffect(() => {
    if (query === searched) return;
    const timer = setTimeout(() => setSearched(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, searched]);

  // Said when the search itself changes, whatever the callback's identity.
  const searchChanged = useRef(onSearchChange);
  searchChanged.current = onSearchChange;
  useEffect(() => {
    searchChanged.current?.(searched, options);
  }, [searched, options]);

  // Run again whenever the book's text changes (a new source), as well as the search.
  const found = useMemo((): { matches: SearchMatch[]; error: string | null } => {
    if (searched === "") return { matches: [], error: null };
    try {
      return { matches: source.find(searched, options), error: null };
    } catch (error) {
      return { matches: [], error: errorMessage(error) };
    }
  }, [source, searched, options]);
  const { matches } = found;

  const groups = useMemo(() => groupResults(matches, source.chapters), [matches, source.chapters]);
  const order = useMemo(() => new Map(source.chapters.map((c, i) => [c.id, i])), [source.chapters]);
  const replaceable = useMemo(() => matches.filter((m) => !m.acrossFormatting), [matches]);
  const crossing = matches.length - replaceable.length;
  const listed = Math.min(matches.length, RESULT_LIMIT);
  const tabStop = Math.max(0, Math.min(cursor, listed - 1));
  const asking = confirming && replaceable.length > 0;

  /** Where a match is in the book, to find the one after or before the active result. */
  const compare = (a: SearchMatch, b: SearchMatch) =>
    (order.get(a.chapterId) ?? -1) - (order.get(b.chapterId) ?? -1) || a.line - b.line || a.from - b.from;

  /* Focus and scrolling, once what they need is on screen ------------------- */

  /** Run after the next render: focus moving to a control that only shows then. */
  const afterRender = useRef<(() => void) | null>(null);
  /** A result to scroll into view in the list once it renders. */
  const reveal = useRef<number | null>(null);
  const revealRow = (index: number) => {
    const box = resultsRef.current;
    const item = box?.querySelectorAll<HTMLElement>(".search-item")[index];
    if (box && item) revealIn(box, item);
  };
  useEffect(() => {
    const run = afterRender.current;
    afterRender.current = null;
    run?.();
    const at = reveal.current;
    reveal.current = null;
    if (at !== null) revealRow(at);
  });

  /**
   * After a row's Replace, once the results have been found again: focus goes on to the next
   * result's Replace (the one after any the replacement itself made), the last one at the end,
   * or Find when none are left.
   */
  const landing = useRef<{ matches: SearchMatch[]; index: number; from: Element | null } | null>(null);
  useEffect(() => {
    const land = landing.current;
    if (!land || land.matches === matches) return;
    landing.current = null;
    // Only from where the writer pressed (gone with its row, or still there): never from elsewhere.
    if (!focusLost() && document.activeElement !== land.from) return;
    if (listed === 0) {
      findRef.current?.focus();
      return;
    }
    const at = Math.max(0, Math.min(listed - 1, land.index + 1 + matches.length - land.matches.length));
    setCursor(at);
    const item = resultsRef.current?.querySelectorAll<HTMLElement>(".search-item")[at];
    const target =
      item?.querySelector<HTMLElement>(".search-replace-one:not(:disabled)") ??
      item?.querySelector<HTMLElement>(".search-result");
    target?.focus();
  }, [matches, listed]);

  /* Finding ------------------------------------------------------------------- */

  const clearOutcome = () => {
    setConfirming(false);
    setNote("");
    setFailure(null);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    // Emptied: the list empties at once, with no pause.
    if (value === "") setSearched("");
    setActive(null);
    setCursor(0);
    clearOutcome();
    landing.current = null;
  };

  const toggleOption = (key: keyof SearchOptions) => {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
    clearOutcome();
    landing.current = null;
  };

  const openAt = (index: number, list: SearchMatch[]) => {
    const match = list[index];
    if (!match) return;
    setActive(match);
    if (index < RESULT_LIMIT) {
      setCursor(index);
      // Now if the row is listed already, else once it is (Enter before the pause ended).
      revealRow(index);
      reveal.current = index;
    }
    source.open(match);
  };

  /** Enter in Find: the result after the active one (the first if none), Shift+Enter the one before. */
  const step = (forward: boolean) => {
    let list = matches;
    if (query !== searched) {
      // Enter came before the pause ended: search now.
      setSearched(query);
      try {
        list = source.find(query, options);
      } catch {
        return;
      }
    }
    if (list.length === 0) return;
    let index = -1;
    if (active === null) index = forward ? 0 : list.length - 1;
    else if (forward) index = list.findIndex((m) => compare(m, active) > 0);
    else {
      for (let i = list.length - 1; i >= 0 && index < 0; i--) if (compare(list[i], active) < 0) index = i;
    }
    if (index < 0) index = forward ? 0 : list.length - 1;
    openAt(index, list);
  };

  const onFindKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(!event.shiftKey);
    } else if (event.key === "Escape") {
      // Handled here, so the phone layout doesn't also close the panel.
      event.preventDefault();
      event.stopPropagation();
      if (query === "") onClose();
      else changeQuery("");
    } else if (event.key === "ArrowDown" && listed > 0) {
      event.preventDefault();
      focusRow(tabStop);
    }
  };

  const focusRow = (index: number) => {
    const box = resultsRef.current;
    const item = box?.querySelectorAll<HTMLElement>(".search-item")[index];
    const row = item?.querySelector<HTMLElement>(".search-result");
    if (!box || !item || !row) return;
    row.focus({ preventScroll: true });
    revealIn(box, item);
  };

  /** Up and down move between results, from a row or its Replace; up from the first goes back to Find. */
  const onResultsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest(".search-item");
    const items = [...(resultsRef.current?.querySelectorAll(".search-item") ?? [])];
    const at = item ? items.indexOf(item) : -1;
    if (at < 0) return;
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(at + 1, items.length - 1);
    else if (event.key === "ArrowUp") next = at - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    if (next < 0) findRef.current?.focus();
    else focusRow(next);
  };

  /* Replacing ----------------------------------------------------------------- */

  const toggleReplace = () => {
    setReplacing((open) => !open);
    clearOutcome();
  };

  const askReplaceAll = () => {
    if (busy || replaceable.length === 0) return;
    // Pressed before the pause ended: the question counts what Find holds now.
    if (query !== searched) setSearched(query);
    setNote("");
    setFailure(null);
    setConfirming(true);
    afterRender.current = () => confirmRef.current?.focus();
  };

  const cancelConfirm = () => {
    setConfirming(false);
    setFailure(null);
    afterRender.current = () => allRef.current?.focus();
  };

  // A phone's Back closes the question, as Escape does.
  useBackLayer(asking, cancelConfirm);

  const replaceAll = () => {
    if (busy || replaceable.length === 0) return;
    setFailure(null);
    try {
      const replaced = source.replace(replaceable, replacement);
      setConfirming(false);
      setNote(replacedNote(replaced, replaceable.length, crossing));
      // The question has gone with focus: back to Replace all, or the replacement once nothing is left.
      afterRender.current = () => {
        if (!focusLost()) return;
        const all = allRef.current;
        (all && !all.disabled ? all : replaceRef.current)?.focus();
      };
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  const replaceOne = (match: SearchMatch, index: number) => {
    if (busy) return;
    clearOutcome();
    try {
      const replaced = source.replace([match], replacement);
      setNote(replacedNote(replaced, 1, 0));
      if (replaced > 0) landing.current = { matches, index, from: document.activeElement };
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  /* What it says -------------------------------------------------------------- */

  let summary: string;
  if (searched === "") summary = "Type a word or phrase to find it in every chapter.";
  else if (found.error !== null) summary = "";
  else if (matches.length === 0) {
    // Said when they are on, as they may be why nothing was found.
    const on = [options.matchCase && "Match case", options.wholeWord && "Whole word"].filter(Boolean);
    const narrowed = on.length === 0 ? "" : ` ${on.join(" and ")} ${on.length === 1 ? "is" : "are"} on.`;
    summary = `No results for “${searched}”.${narrowed}`;
  } else summary = `${plural(matches.length, "result", "results")} in ${plural(groups.length, "chapter", "chapters")}`;

  const replaceChapters = new Set(replaceable.map((m) => m.chapterId)).size;
  const where = replaceChapters === 1 ? "in 1 chapter" : `across ${formatCount(replaceChapters)} chapters`;
  const deleting = replacement === "";
  const question = deleting
    ? `Delete ${formatCount(replaceable.length)} “${searched}” ${where}?`
    : `Replace ${formatCount(replaceable.length)} “${searched}” with “${replacement}” ${where}?`;
  const rowAction = deleting ? "Delete" : `Replace with “${replacement}”`;

  return (
    <section
      className="search-panel"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        // Escape anywhere else in the panel closes it, once what is open in it has had the key.
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="search-top">
        <div className="search-head">
          <h2 id={headingId} className="search-title">
            Find in book
          </h2>
          <button
            type="button"
            className="btn btn--icon btn--quiet search-close"
            aria-label="Close Find in book"
            title="Close"
            onClick={onClose}
          >
            <X aria-hidden />
          </button>
        </div>

        <div className="search-find">
          <input
            ref={findRef}
            className="input search-input"
            role="searchbox"
            aria-label="Find"
            placeholder="Find"
            value={query}
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={onFindKeyDown}
          />
          <div className="search-options">
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Match case"
              title="Match case"
              aria-pressed={options.matchCase}
              onClick={() => toggleOption("matchCase")}
            >
              <CaseSensitive aria-hidden />
            </button>
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Whole word"
              title="Whole word"
              aria-pressed={options.wholeWord}
              onClick={() => toggleOption("wholeWord")}
            >
              <WholeWord aria-hidden />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="btn btn--quiet search-replace-toggle"
          aria-expanded={replacing}
          aria-controls={replacing ? replaceRegionId : undefined}
          onClick={toggleReplace}
        >
          <ChevronRight className="search-disclosure" aria-hidden />
          Replace
        </button>

        {replacing && (
          <div id={replaceRegionId} className="search-replace">
            <div className="search-replace-row">
              <input
                ref={replaceRef}
                className="input search-replace-input"
                aria-label="Replace with"
                placeholder="Replace with"
                value={replacement}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => {
                  setReplacement(event.target.value);
                  clearOutcome();
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.key !== "Enter") return;
                  event.preventDefault();
                  askReplaceAll();
                }}
              />
              {!asking && (
                <button
                  ref={allRef}
                  type="button"
                  className="btn btn--primary search-replace-all num"
                  aria-describedby={crossing > 0 ? crossingId : undefined}
                  disabled={busy || replaceable.length === 0}
                  onClick={askReplaceAll}
                >
                  {replaceable.length === 0 ? "Replace all" : `Replace all ${formatCount(replaceable.length)}`}
                </button>
              )}
            </div>

            {asking && (
              <div
                className="search-confirm"
                role="group"
                aria-labelledby={questionId}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  // Handled here: Escape takes the question back, and leaves the panel open.
                  event.preventDefault();
                  event.stopPropagation();
                  cancelConfirm();
                }}
              >
                <p id={questionId} className="num">
                  {question} Undo only works in the chapter that’s open.
                </p>
                <div className="search-confirm-actions">
                  <button
                    ref={confirmRef}
                    type="button"
                    className="btn btn--primary num"
                    disabled={busy}
                    onClick={replaceAll}
                  >
                    {`${deleting ? "Delete" : "Replace"} ${formatCount(replaceable.length)}`}
                  </button>
                  <button type="button" className="btn btn--quiet" onClick={cancelConfirm}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {crossing > 0 && (
              <p id={crossingId} className="search-hint num">
                {crossing === 1
                  ? "1 result is partly italic or bold: change it in the text."
                  : `${formatCount(crossing)} results are partly italic or bold: change those in the text.`}
              </p>
            )}
            {/* Present before the note appears, so screen readers announce it. */}
            <p className="search-replace-status num" role="status">
              {note}
            </p>
            {failure !== null && (
              <p className="inline-error" role="alert">
                {failure}
              </p>
            )}
          </div>
        )}

        <p className="search-summary num" role="status">
          {summary}
        </p>
        {found.error !== null && (
          <p className="inline-error" role="alert">
            Couldn’t search: {found.error}
          </p>
        )}
      </div>

      <div ref={resultsRef} className="search-results" onKeyDown={onResultsKeyDown}>
        {groups.map((group) => {
          if (group.rows.length === 0) return null;
          const groupId = `${ids}-group-${group.rows[0].index}`;
          return (
            <section key={group.chapterId} className="search-group" aria-labelledby={groupId}>
              <h3 id={groupId} className="search-group-title">
                <span className="search-group-name">{group.title}</span>
                <span className="search-group-count num">
                  {formatCount(group.count)}
                  <span className="visually-hidden">{group.count === 1 ? " result" : " results"}</span>
                </span>
              </h3>
              <ul>
                {group.rows.map(({ match, index }) => {
                  const { lead, text, trail } = resultLine(match);
                  const rowId = `${ids}-row-${index}`;
                  const noteId = `${ids}-note-${index}`;
                  const crosses = replacing && match.acrossFormatting;
                  return (
                    <li key={`${match.line}:${match.from}`} className="search-item">
                      <button
                        id={rowId}
                        type="button"
                        className={cx(
                          "search-result",
                          replacing && !match.acrossFormatting && "search-result--with-action",
                        )}
                        aria-current={active !== null && samePlace(match, active) ? "true" : undefined}
                        aria-describedby={crosses ? noteId : undefined}
                        tabIndex={index === tabStop ? 0 : -1}
                        onFocus={() => setCursor(index)}
                        onClick={() => openAt(index, matches)}
                      >
                        <span className="search-excerpt">
                          {lead}
                          <mark className="search-match">{text}</mark>
                          {trail}
                        </span>
                      </button>
                      {replacing &&
                        (match.acrossFormatting ? (
                          <p id={noteId} className="search-note">
                            Partly italic or bold: change it in the text.
                          </p>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--icon btn--quiet search-replace-one"
                            aria-label={rowAction}
                            title={rowAction}
                            aria-describedby={rowId}
                            tabIndex={index === tabStop ? 0 : -1}
                            disabled={busy}
                            onFocus={() => setCursor(index)}
                            onClick={() => replaceOne(match, index)}
                          >
                            <Replace aria-hidden />
                          </button>
                        ))}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {matches.length > RESULT_LIMIT && (
          <p className="empty-note search-more num">
            Showing the first {formatCount(RESULT_LIMIT)} results. Type more to narrow the search.
          </p>
        )}
      </div>
    </section>
  );
}
