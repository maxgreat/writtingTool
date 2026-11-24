import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { NameIndex } from "../core/nameIndex";
import { normalizeName, type NameMatcher } from "../core/names";
import { MIN_POSSIBLE_NAME_COUNT, type PossibleName } from "../core/possibleNames";
import { holdsNames, type Project, type SheetType } from "../core/project";
import { cx, errorMessage, focusLost, formatCount, plural } from "./dom";
import { MenuButton, MenuItem } from "./Popover";

export interface PossibleNamesProps {
  project: Project;
  /** The open chapter: only the words found in it are listed. */
  chapterId: string;
  matcher: NameMatcher;
  /** The project's name index, which keeps each chapter's words so only an edited chapter is read again. */
  index: NameIndex;
  /** Whether the inspector is on screen: the book is only read then. */
  visible: boolean;
  /** The project on disk is changing: nothing can be made or marked until it has. */
  busy: boolean;
  /** useProject's createSheet: resolves to the new sheet's id, or rejects with a message for the writer. */
  onCreateSheet(kind: string, name: string): Promise<string>;
  /** useProject's markNotName. Throws, changing nothing, when project.json can't be read. */
  onMarkNotName(word: string, notName: boolean): void;
  /** A sheet was made from a word, which is a name now: it shows under Names in this chapter. */
  onCreated(sheetId: string): void;
  /** Says something to screen readers, from a live region that stays when this list goes. */
  announce(message: string): void;
}

/** As the core orders them: most found first, then by word. */
const byCount = (a: PossibleName, b: PossibleName) => b.count - a.count || a.word.localeCompare(b.word);

/**
 * Possible names: capitalized words of the open chapter that no sheet
 * names, found often enough across the book (not at the start of a
 * sentence) to be names. Each can be added as a sheet of a type that holds
 * names, and becomes a name at once, or marked as not a name, which stays
 * in its place with Undo until another chapter is opened. Shown only when
 * there are some. Mount one per chapter (key it by project and chapter).
 */
export function PossibleNames({
  project,
  chapterId,
  matcher,
  index,
  visible,
  busy,
  onCreateSheet,
  onMarkNotName,
  onCreated,
  announce,
}: PossibleNamesProps) {
  const { chapterOrder, chapters, notNames, sheetTypes } = project;
  const book = useMemo(() => chapterOrder.flatMap((id) => chapters[id] ?? []), [chapterOrder, chapters]);
  // The whole book is read the first time (about 200 ms for a long novel), then only the
  // chapter being typed in: both happen in the background, so typing and opening the panel
  // never wait for it. Nothing is read while the inspector is hidden.
  const scanned = useDeferredValue(visible ? book : null, null);
  const settled = useMemo(() => new Set(notNames), [notNames]);
  const found = useMemo(
    () =>
      scanned === null
        ? []
        : index.possibleNames(scanned, matcher, (word) => matcher.knows(word) || settled.has(normalizeName(word))),
    [scanned, index, matcher, settled],
  );

  const types = sheetTypes.filter((type) => holdsNames(type.folder));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ word: string; message: string; refocus: boolean } | null>(null);
  /** Words marked as not names from here: they stay listed, with Undo. */
  const [dismissed, setDismissed] = useState<PossibleName[]>([]);
  const locked = busy || creating !== null;
  const ids = useId();
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A sheet that couldn't be made: its row's Add takes focus back from the menu that went away.
  useEffect(() => {
    if (!failure?.refocus || !focusLost()) return;
    rowRefs.current.get(failure.word)?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [failure]);

  const here = found.filter((p) => p.chapterIds.includes(chapterId));
  const kept = dismissed.filter((d) => settled.has(normalizeName(d.word)) && !here.some((p) => p.word === d.word));
  const rows = kept.length > 0 ? [...here, ...kept].sort(byCount) : here;
  if (rows.length === 0) return null;

  const create = async (word: string, type: SheetType) => {
    setMenuFor(null);
    if (locked) return;
    setCreating(word);
    setFailure(null);
    try {
      const id = await onCreateSheet(type.folder, word);
      if (!live.current) return;
      announce(`${word} added to ${type.label}.`);
      onCreated(id);
    } catch (error) {
      if (live.current) setFailure({ word, message: errorMessage(error), refocus: true });
    } finally {
      if (live.current) setCreating(null);
    }
  };

  const setNotName = (entry: PossibleName, notName: boolean) => {
    if (locked) return;
    try {
      onMarkNotName(entry.word, notName);
      setFailure(null);
      setDismissed((list) => [...list.filter((d) => d.word !== entry.word), ...(notName ? [entry] : [])]);
      announce(notName ? `${entry.word} won’t be offered as a name again.` : `${entry.word} is offered as a name again.`);
    } catch (error) {
      setFailure({ word: entry.word, message: errorMessage(error), refocus: false });
    }
  };

  const addControl = (word: string, describedBy: string) => {
    if (types.length === 0) return null;
    if (types.length === 1) {
      const [type] = types;
      return (
        <button
          type="button"
          className="btn btn--quiet"
          aria-describedby={describedBy}
          disabled={locked}
          onClick={() => void create(word, type)}
        >
          Add to {type.label}
        </button>
      );
    }
    return (
      <MenuButton
        open={menuFor === word}
        onOpenChange={(open) => setMenuFor(open ? word : null)}
        menuLabel={`Add ${word} to`}
        describedBy={describedBy}
        disabled={locked}
        className="btn--quiet"
        menu={
          <>
            <div className="popover-title" role="none">
              Add {word} to
            </div>
            {types.map((type) => (
              <MenuItem key={type.folder} noCheck onSelect={() => void create(word, type)}>
                {type.label}
              </MenuItem>
            ))}
          </>
        }
      >
        Add to
      </MenuButton>
    );
  };

  return (
    <section className="possible-names" aria-label="Possible names" aria-busy={creating !== null}>
      <h3 className="section-label">Possible names</h3>
      <p className="section-intro">
        Found {MIN_POSSIBLE_NAME_COUNT} or more times in the book, with no sheet yet.
      </p>
      <ul className="possible-list">
        {rows.map((entry, i) => {
          const { word, count } = entry;
          const isDismissed = !here.includes(entry);
          const wordId = `${ids}-${i}`;
          const failed = failure !== null && failure.word === word;
          return (
            <li
              key={word}
              ref={(el) => {
                if (el) rowRefs.current.set(word, el);
                else rowRefs.current.delete(word);
              }}
              className={cx("possible-row", isDismissed && "is-dismissed")}
              aria-busy={creating === word}
            >
              <span id={wordId} className="possible-word">
                <span className="possible-word-text">{word}</span>
                <span className="num muted" aria-hidden>
                  {formatCount(count)}
                </span>
                <span className="visually-hidden">, {plural(count, "time", "times")} in the book</span>
              </span>
              <span className="possible-actions">
                {isDismissed ? <span className="possible-note">Not a name</span> : addControl(word, wordId)}
                {/* One button, so focus stays on it as Not a name becomes Undo. */}
                <button
                  type="button"
                  className="btn btn--quiet"
                  aria-describedby={failed ? `${wordId} ${wordId}-error` : wordId}
                  disabled={locked}
                  onClick={() => setNotName(entry, !isDismissed)}
                >
                  {isDismissed ? "Undo" : "Not a name"}
                </button>
              </span>
              {failed && (
                <p id={`${wordId}-error`} className="inline-error possible-error" role="alert">
                  {failure.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
