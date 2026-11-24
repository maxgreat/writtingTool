import { useId, useMemo, useState } from "react";
import { ignoredFor } from "../core/nameChoices";
import type { IgnoredName } from "../core/names";
import type { Sheet } from "../core/project";
import { cx, errorMessage } from "./dom";
import { excerpt, isIgnored, occurrenceKey, sameOccurrence } from "./occurrence";

/** What "Ignore here" and its undo need from the workspace. */
export interface IgnoreSource {
  /** The project's ignored occurrences (`project.ignoredNames`). */
  ignored: IgnoredName[];
  /**
   * useProject's ignoreName: `ignore` false highlights the occurrence again.
   * Throws, changing nothing, when project.json can't be read.
   */
  setIgnored(occurrence: IgnoredName, ignore: boolean): void;
  /** The project on disk is changing: nothing is ignored or highlighted again until it has. */
  busy: boolean;
}

/** Words of the sentence shown under a sheet's name, and in its list of ignored mentions. */
const OPENED_WORDS = 24;
const LISTED_WORDS = 14;

/** The highlight style of a sheet type, as the editor draws it. */
function kindClass(kind: string): string {
  return kind === "characters" || kind === "places" ? kind : "other";
}

/**
 * Part of the sentence an occurrence is in, the name marked: highlighted
 * as the text shows it, or plain where it is ignored.
 */
export function Excerpt({
  occurrence,
  kind,
  highlighted,
  maxWords,
}: {
  occurrence: IgnoredName;
  kind: string;
  highlighted: boolean;
  maxWords: number;
}) {
  const { before, name, after } = excerpt(occurrence.sentence, occurrence.name, maxWords);
  return (
    <>
      {before}
      {name !== "" && (
        <mark className={cx("excerpt-name", highlighted && `is-highlighted excerpt-name--${kindClass(kind)}`)}>
          {name}
        </mark>
      )}
      {after}
    </>
  );
}

/**
 * Under the name of a sheet opened from a name in the text: that sentence,
 * and Ignore here, which stops highlighting the name there. The same button
 * then offers Highlight again. Key it by the occurrence.
 */
export function TextOccurrence({
  occurrence,
  kind,
  source,
}: {
  occurrence: IgnoredName;
  kind: string;
  source: IgnoreSource;
}) {
  const ignored = isIgnored(source.ignored, occurrence);
  const [failure, setFailure] = useState<string | null>(null);
  const ids = useId();
  const textId = `${ids}-text`;
  const errorId = `${ids}-error`;

  const toggle = () => {
    try {
      source.setIgnored(occurrence, !ignored);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  return (
    <section className="sheet-occurrence" aria-label="Opened from the text">
      {/* A live region: the change to "Not highlighted here" is announced. */}
      <p className="section-label" role="status">
        {ignored ? "Not highlighted here" : "Opened from the text"}
      </p>
      <div className="mention-row">
        <p id={textId} className="excerpt">
          <Excerpt occurrence={occurrence} kind={kind} highlighted={!ignored} maxWords={OPENED_WORDS} />
        </p>
        <button
          type="button"
          className="btn btn--quiet mention-action"
          aria-describedby={failure !== null ? `${textId} ${errorId}` : textId}
          disabled={source.busy}
          onClick={toggle}
        >
          {ignored ? "Highlight again" : "Ignore here"}
        </button>
        {failure !== null && (
          <p id={errorId} className="inline-error mention-error" role="alert">
            {failure}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The sentences where the writer chose not to highlight one of the sheet's
 * names, each with Highlight again. Shown only when there are some. A
 * mention highlighted again stays in its place, offering Ignore here, until
 * the sheet is closed, so a slip is undone where it was made. `opened`, the
 * occurrence the sheet was opened from, is left out: it has its own button
 * above.
 */
export function IgnoredMentions({
  sheet,
  source,
  opened,
}: {
  sheet: Sheet;
  source: IgnoreSource;
  opened?: IgnoredName;
}) {
  const { name, aliases } = sheet;
  const current = useMemo(
    () => ignoredFor([{ text: name, ignoreCase: false }, ...aliases], source.ignored),
    [name, aliases, source.ignored],
  );

  // Every mention shown so far, in the order they came: newly ignored ones join at the end.
  const [shown, setShown] = useState<IgnoredName[]>(current);
  const added = current.filter((entry) => !shown.some((s) => sameOccurrence(s, entry)));
  const all = added.length > 0 ? [...shown, ...added] : shown;
  if (added.length > 0) setShown(all);

  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [note, setNote] = useState("");
  const ids = useId();

  const rows = opened ? all.filter((entry) => !sameOccurrence(entry, opened)) : all;
  if (rows.length === 0) return null;

  const toggle = (entry: IgnoredName, ignored: boolean) => {
    try {
      source.setIgnored(entry, !ignored);
      setFailure(null);
      setNote(
        ignored
          ? `${entry.name} is highlighted again in that sentence.`
          : `${entry.name} is no longer highlighted in that sentence.`,
      );
    } catch (error) {
      setFailure({ key: occurrenceKey(entry), message: errorMessage(error) });
    }
  };

  return (
    <section className="sheet-ignored" aria-label="Ignored mentions">
      <h3 className="section-label">Ignored mentions</h3>
      <p className="visually-hidden" role="status">
        {note}
      </p>
      <ul className="mention-list">
        {rows.map((entry, i) => {
          const key = occurrenceKey(entry);
          const ignored = isIgnored(source.ignored, entry);
          const failed = failure?.key === key;
          const textId = `${ids}-${i}`;
          return (
            <li key={key} className="mention-row">
              <p id={textId} className="excerpt">
                <Excerpt occurrence={entry} kind={sheet.kind} highlighted={!ignored} maxWords={LISTED_WORDS} />
              </p>
              <button
                type="button"
                className="btn btn--quiet mention-action"
                aria-describedby={failed ? `${textId} ${textId}-error` : textId}
                disabled={source.busy}
                onClick={() => toggle(entry, ignored)}
              >
                {ignored ? "Highlight again" : "Ignore here"}
              </button>
              {failed && (
                <p id={`${textId}-error`} className="inline-error mention-error" role="alert">
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
