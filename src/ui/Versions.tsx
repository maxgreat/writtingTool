import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Version } from "../core/backend";
import type { SaveState } from "../core/useProject";
import { countWords } from "../core/words";
import { useBackLayer } from "./BackStack";
import { errorMessage, plural } from "./dom";
import { formatVersionTime } from "./versionTime";

/** What the inspector needs from useProject to list and restore the open chapter's earlier versions. */
export interface VersionSource {
  list(chapterId: string): Promise<Version[]>;
  restore(chapterId: string, savedAt: number): Promise<void>;
  /** The list is read again each time a save finishes, as the save may have kept a version. */
  saveStatus: SaveState["status"];
  /** useProject's `loads`: goes up after a restore, and when the project is read again. */
  loads: number;
  /** Edits are refused (a version is being restored, or another project opens): no restore can start. */
  busy: boolean;
}

export interface VersionsProps extends VersionSource {
  chapterId: string;
  /** Whether the inspector is on screen. A hidden one reads nothing, and catches up when shown. */
  visible: boolean;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; versions: Version[] }
  | { status: "error"; message: string };

const SKELETON_ROWS = 3;

/**
 * The open chapter's earlier versions, newest first, each with a Restore
 * action that asks first. Mount one per chapter (key it by project and
 * chapter), so nothing from another chapter is ever shown.
 */
export const Versions = memo(function Versions({
  chapterId,
  list,
  restore,
  saveStatus,
  loads,
  busy,
  visible,
}: VersionsProps) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ savedAt: number; message: string } | null>(null);
  const [restored, setRestored] = useState(false);

  // Count finished saves, to read the list again after each one. Typing after
  // a restore also retires the note about undoing it.
  const [saves, setSaves] = useState(0);
  const [lastStatus, setLastStatus] = useState(saveStatus);
  if (lastStatus !== saveStatus) {
    setLastStatus(saveStatus);
    if (saveStatus === "saved") setSaves((n) => n + 1);
    if (saveStatus === "pending") setRestored(false);
  }

  // `loads`, `saves` and `attempt` only say when to read again. A newer read,
  // or another chapter, makes the answer to an older one arrive too late.
  useEffect(() => {
    if (!visible) return;
    let current = true;
    list(chapterId).then(
      (versions) => current && setState({ status: "ready", versions }),
      (error: unknown) => current && setState({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [chapterId, list, visible, loads, saves, attempt]);

  const rows = useMemo(
    () =>
      state.status === "ready" ? state.versions.map((v) => ({ savedAt: v.savedAt, words: countWords(v.text) })) : [],
    [state],
  );

  const triggers = useRef(new Map<number, HTMLButtonElement>());
  const confirmButton = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLParagraphElement>(null);
  const confirmId = useId();
  const confirmTextId = useId();
  const locked = busy || restoring !== null;

  /** Focus left with a button that went away or was disabled: true when nothing has it now. */
  const focusLost = () => document.activeElement === null || document.activeElement === document.body;

  // After a restore the editor takes focus on desktop; elsewhere focus would
  // be lost with the confirmation, so it goes to the note, which says how to undo.
  useEffect(() => {
    if (restored && focusLost()) note.current?.focus();
  }, [restored]);

  useEffect(() => {
    if (failure && focusLost()) confirmButton.current?.focus();
  }, [failure]);

  const closeConfirm = (savedAt: number) => {
    setConfirming(null);
    setFailure(null);
    triggers.current.get(savedAt)?.focus();
  };

  const run = async (savedAt: number) => {
    setRestoring(savedAt);
    setFailure(null);
    setRestored(false);
    try {
      await restore(chapterId, savedAt);
      setConfirming(null);
      setRestored(true);
    } catch (error) {
      setFailure({ savedAt, message: errorMessage(error) });
    } finally {
      setRestoring(null);
    }
  };

  const onConfirmKeyDown = (event: KeyboardEvent<HTMLDivElement>, savedAt: number) => {
    if (event.key !== "Escape" || restoring !== null) return;
    // Handled here, so the phone layout doesn't also close the inspector.
    event.preventDefault();
    event.stopPropagation();
    closeConfirm(savedAt);
  };

  // A phone's Back closes the question as Escape does, which leaves it alone while the restore runs.
  useBackLayer(confirming !== null && restoring === null, () => {
    if (confirming !== null) closeConfirm(confirming);
  });

  let content;
  if (state.status === "loading") {
    content = (
      <ul className="version-list" aria-hidden>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <li key={i} className="version-row">
            <span className="version-meta">
              <span className="version-skeleton-line">
                <span className="skeleton skeleton--short" />
              </span>
              <span className="version-skeleton-line version-words">
                <span className="skeleton skeleton--tiny" />
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  } else if (state.status === "error") {
    content = (
      <div className="version-error">
        <p className="inline-error" role="alert">
          Couldn’t load earlier versions: {state.message}
        </p>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            setState({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    content = (
      <p className="empty-note">
        None yet. A version is kept when you start changing this chapter, then every ten minutes while you write. The
        last 20 are kept.
      </p>
    );
  } else {
    const now = Date.now();
    content = (
      <ul className="version-list">
        {rows.map(({ savedAt, words }) => {
          const label = formatVersionTime(savedAt, now);
          const open = confirming === savedAt;
          return (
            <li key={savedAt}>
              <div className="version-row">
                <span className="version-meta">
                  <time className="version-time num" dateTime={new Date(savedAt).toISOString()}>
                    {label}
                  </time>
                  <span className="version-words num">{plural(words, "word", "words")}</span>
                </span>
                <button
                  ref={(el) => {
                    if (el) triggers.current.set(savedAt, el);
                    else triggers.current.delete(savedAt);
                  }}
                  type="button"
                  className="btn btn--quiet version-restore"
                  aria-label={`Restore the version from ${label}`}
                  aria-expanded={open}
                  aria-controls={open ? confirmId : undefined}
                  disabled={locked}
                  onClick={() => {
                    setFailure(null);
                    setConfirming(open ? null : savedAt);
                  }}
                >
                  Restore
                </button>
              </div>
              {open && (
                <div id={confirmId} className="version-confirm" onKeyDown={(event) => onConfirmKeyDown(event, savedAt)}>
                  <p id={confirmTextId}>
                    Replace the chapter with this version? Its current text is kept as a version too, so nothing is
                    lost.
                  </p>
                  <div className="version-confirm-actions">
                    <button
                      ref={confirmButton}
                      type="button"
                      className="btn btn--primary"
                      aria-describedby={confirmTextId}
                      disabled={locked}
                      onClick={() => void run(savedAt)}
                    >
                      {restoring === savedAt ? "Restoring…" : "Restore"}
                    </button>
                    <button type="button" className="btn btn--quiet" disabled={locked} onClick={() => closeConfirm(savedAt)}>
                      Cancel
                    </button>
                  </div>
                  {failure?.savedAt === savedAt && (
                    <p className="inline-error" role="alert">
                      {failure.message}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="versions" aria-label="Earlier versions" aria-busy={state.status === "loading"}>
      <h3 className="section-label">Earlier versions</h3>
      {/* Present before the note appears, so screen readers announce it. */}
      <div className="version-status" role="status">
        {restored && (
          <p ref={note} className="version-note" tabIndex={-1}>
            Restored. To undo, restore the newest version.
          </p>
        )}
      </div>
      {content}
    </section>
  );
});
