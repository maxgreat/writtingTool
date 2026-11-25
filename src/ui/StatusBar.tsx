import { Check, CloudAlert, CloudOff, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Backend } from "../core/backend";
import type { SaveState, SyncState } from "../core/useProject";
import { cx, formatCount, formatSigned, languageName, plural } from "./dom";
import { Popover } from "./Popover";
import { formatVersionTime } from "./versionTime";

/**
 * A sync that lasts longer than this shows "Syncing…". A quicker one, as
 * most are, leaves the bar as it was: a background sync runs every 30 s.
 */
export const SLOW_SYNC_MS = 1500;

export interface StatusBarProps {
  chapterWords: number | null;
  bookWords: number;
  wordsToday: number;
  language: string;
  save: SaveState;
  onRetry(): Promise<void>;
  /** Save was chosen and has finished, and nothing has changed since: the saved state shows a check. */
  confirmed?: boolean;
  backendKind: Backend["kind"];
  problems: string[];
  /** Why the last grammar check failed (a LanguageTool server out of reach, say); null when it worked. */
  grammarError?: string | null;
  /** Phones: the chapter and today's counts and the save state only. */
  compact: boolean;
  /** How the open project stands with Dropbox (useProject's `sync`); absent, or off, shows nothing. */
  sync?: SyncState;
  /** useProject's syncNow: Retry after a failed sync. */
  onSyncNow?: () => Promise<void>;
  /** useProject's dismissConflicts: the list of files edited on two devices was opened, then closed. */
  onDismissConflicts?: () => void;
  /** The title of a chapter or sheet of the project, by its path, for the files a sync found edited on two devices; null where it has none. */
  fileTitle?: (path: string) => string | null;
}

/** Word counts, the project language and whether grammar can be checked, problems reading files, and where the work is saved and synced. */
export function StatusBar({
  chapterWords,
  bookWords,
  wordsToday,
  language,
  save,
  onRetry,
  confirmed = false,
  backendKind,
  problems,
  grammarError = null,
  compact,
  sync,
  onSyncNow,
  onDismissConflicts,
  fileTitle,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-group status-group--counts">
        {chapterWords !== null && (
          <span className="status-item">
            <span className="muted">Chapter</span> <span className="num">{formatCount(chapterWords)}</span>
          </span>
        )}
        {!compact && (
          <span className="status-item">
            <span className="muted">Book</span> <span className="num">{formatCount(bookWords)}</span>
          </span>
        )}
        <span className="status-item" title="Words written today on this device">
          <span className="muted">Today</span> <span className="num">{formatSigned(wordsToday)}</span>
        </span>
        {!compact && (
          <span className="status-item" title={`Project language: ${language}`}>
            {languageName(language)}
          </span>
        )}
        {!compact && grammarError !== null && (
          // A quiet note: the marks already shown stay; the reason is on hover, and read after the note.
          <span className="status-item status-grammar" title={grammarError}>
            <span className="muted">Grammar check unavailable</span>
            <span className="visually-hidden">. {grammarError}</span>
          </span>
        )}
      </div>

      <div className="status-group status-group--end">
        {problems.length > 0 && <Problems problems={problems} compact={compact} />}
        {sync && (
          <SyncStatus
            sync={sync}
            onSyncNow={onSyncNow ?? (async () => undefined)}
            onDismissConflicts={onDismissConflicts ?? (() => undefined)}
            fileTitle={fileTitle ?? (() => null)}
            compact={compact}
          />
        )}
        <SaveStatus save={save} onRetry={onRetry} confirmed={confirmed} backendKind={backendKind} compact={compact} />
      </div>
    </footer>
  );
}

function SaveStatus({
  save,
  onRetry,
  confirmed,
  backendKind,
  compact,
}: Pick<StatusBarProps, "save" | "onRetry" | "confirmed" | "backendKind" | "compact">) {
  const [retrying, setRetrying] = useState(false);
  const browser = backendKind === "browser";

  if (save.status === "error") {
    return (
      <span className="status-item save-error" role="alert">
        <span className="save-error-text" title={save.message}>
          Couldn’t save{compact ? "" : `: ${save.message}`}
        </span>
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await onRetry();
            } finally {
              setRetrying(false);
            }
          }}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </span>
    );
  }

  const state = save.status === "saving" ? "Saving…" : save.status === "pending" ? "Unsaved" : null;
  // The text was saved, but its previous version wasn't kept: a warning, not an error.
  const warning = save.status === "saved" ? save.warning : undefined;
  // Workspace announces the confirmation itself, as it can show while this bar is hidden (focus mode).
  const checked = confirmed && save.status === "saved" && !warning;
  return (
    <span className={cx("status-item", warning && "save-warning")} title={warning}>
      {warning ? (
        <>
          <TriangleAlert aria-hidden />
          <span aria-hidden>Saved · previous version not kept</span>
        </>
      ) : checked ? (
        <>
          <Check aria-hidden />
          <span>{browser ? (compact ? "Saved in this tab" : "Browser preview · saved in this tab") : "Saved on this device"}</span>
        </>
      ) : browser ? (
        <span
          className="muted"
          title="This browser preview runs without the app. Edits are kept in memory and are lost when the tab is closed or reloaded."
        >
          {compact ? (state ?? "Edits stay in this tab") : `Browser preview · ${state ?? "edits stay in this tab only"}`}
        </span>
      ) : (
        <span className={state ? undefined : "muted"}>{state ?? "Saved on this device"}</span>
      )}
      {/* Present before a warning appears, so screen readers announce it, in full. */}
      <span className="visually-hidden" role="status">
        {warning}
      </span>
    </span>
  );
}

function Problems({ problems, compact }: { problems: string[]; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = plural(problems.length, "problem", "problems");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn--small status-problems"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title="Problems reading the project"
        onClick={() => setOpen(!open)}
      >
        <TriangleAlert aria-hidden />
        <span className="num">{compact ? formatCount(problems.length) : label}</span>
      </button>
      {open && (
        <Popover
          anchor={trigger}
          ignore={trigger}
          role="dialog"
          label="Problems reading the project"
          className="problems-popover"
          onClose={(reason) => {
            setOpen(false);
            if (reason === "escape") trigger.current?.focus();
          }}
        >
          <div className="popover-title">Problems reading the project</div>
          <ul className="problems-list">
            {problems.map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </Popover>
      )}
    </>
  );
}

/* Sync with Dropbox ------------------------------------------------------- */

type Settled = Exclude<SyncState, { status: "syncing" }>;
type Synced = Extract<SyncState, { status: "synced" }>;

/** Files a sync merges its own way, named for the writer. */
const PROJECT_JSON = "project.json";
const DICTIONARY = "dictionary.txt";

const SIGNED_OUT =
  "This project is in Dropbox, but no Dropbox account is connected on this device. Connect one in Settings to sync it.";
const SAFE = "Your edits are safe on this device and go to Dropbox with the next sync.";

/** A message ends with a full stop before another sentence follows it. */
function sentence(message: string): string {
  const text = message.trim();
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

/** A sync's report that needs a look: files edited on two devices, or things it couldn't do. */
function needsLook(report: Synced | null): report is Synced {
  return report !== null && (report.conflicts.length > 0 || report.problems.length > 0);
}

/** Whether the sync under way has lasted SLOW_SYNC_MS; each new sync counts afresh. */
function useSlowSync(sync: SyncState): boolean {
  const run = sync.status === "syncing" ? sync : null;
  const [slow, setSlow] = useState<SyncState | null>(null);
  useEffect(() => {
    if (!run) return;
    const timer = setTimeout(() => setSlow(run), SLOW_SYNC_MS);
    return () => clearTimeout(timer);
  }, [run]);
  return run !== null && slow === run;
}

interface SyncStatusProps {
  sync: SyncState;
  onSyncNow(): Promise<void>;
  onDismissConflicts(): void;
  fileTitle(path: string): string | null;
  compact: boolean;
}

/**
 * Where the open project stands with Dropbox. A sync runs every 30 s, and
 * most take well under a second: while one runs, the bar keeps what it
 * showed before (synced, or the last failure), and says "Syncing…" only
 * once the sync has lasted SLOW_SYNC_MS, or when there is nothing before
 * it to show. The files found edited on two devices (useProject gathers
 * them across syncs) wait behind a warning until their list has been
 * opened and closed; what the last sync couldn't do waits there until the
 * next one.
 */
function SyncStatus({ sync, onSyncNow, onDismissConflicts, fileTitle, compact }: SyncStatusProps) {
  // The last state a sync ended in, shown while the next one runs.
  const [held, setHeld] = useState<Settled | null>(sync.status === "syncing" ? null : sync);
  const settled = sync.status === "syncing" ? held : sync;
  if (settled !== held) setHeld(settled);
  // The last sync's report, kept while the next one runs or fails, as only a sync's end carries one; gone with the project.
  const [report, setReport] = useState<Synced | null>(sync.status === "synced" ? sync : null);
  const latest = sync.status === "synced" ? sync : sync.status === "off" || sync.status === "signedOut" ? null : report;
  /** Counts reports dropped with their project: an open list goes with them. */
  const [dropped, setDropped] = useState(0);
  if (latest !== report) {
    setReport(latest);
    if (latest === null) setDropped((n) => n + 1);
  }
  const slow = useSlowSync(sync);

  /** The writer has seen the files edited on two devices: they go now, even from the report kept while a sync runs. */
  const dismiss = () => {
    onDismissConflicts();
    setReport((kept) => (kept && kept.conflicts.length > 0 ? { ...kept, conflicts: [] } : kept));
  };

  let shown: SyncState;
  if (sync.status !== "syncing" || slow) shown = sync;
  else if (settled) shown = settled;
  else shown = sync.at !== null ? { status: "synced", at: sync.at, conflicts: [], problems: [] } : sync;

  // Announced once each: a failure (kept through the quick syncs that retry it), and files edited on two devices.
  const failure = settled?.status === "error" ? `Not synced. ${sentence(settled.message)}` : "";
  const twice = latest && latest.conflicts.length > 0 ? `${editedLabel(latest.conflicts.length)}.` : "";

  // Phones have room for one of the two: the warning says a sync happened.
  const line = compact && shown.status === "synced" && needsLook(latest) ? null : shown;

  return (
    <>
      <SyncReport
        key={dropped}
        report={needsLook(latest) ? latest : null}
        onSeen={dismiss}
        fileTitle={fileTitle}
        compact={compact}
      />
      {line && <SyncLine shown={line} onSyncNow={onSyncNow} compact={compact} />}
      <span className="visually-hidden" role="status">
        {[failure, twice].filter(Boolean).join(" ")}
      </span>
    </>
  );
}

function editedLabel(count: number): string {
  return plural(count, "file edited on two devices", "files edited on two devices");
}

/**
 * The sync state itself, quiet unless it failed. A failure says why on
 * hover, with Retry beside it; phones, which have neither the room nor
 * hover, show a button that opens the reason and Retry.
 */
function SyncLine({ shown, onSyncNow, compact }: { shown: SyncState; onSyncNow(): Promise<void>; compact: boolean }) {
  const [retrying, setRetrying] = useState(false);
  /** Phones: the failure's reason is open. */
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (open && shown.status !== "error") setOpen(false);

  /** Small in the bar; a full-size control in the phone's popover, to be tapped. */
  const retry = (small: boolean) => (
    <button
      type="button"
      className={cx("btn btn--quiet", small && "btn--small")}
      disabled={retrying}
      aria-busy={retrying || undefined}
      onClick={async () => {
        setRetrying(true);
        try {
          await onSyncNow();
        } finally {
          setRetrying(false);
        }
      }}
    >
      {retrying ? "Retrying…" : "Retry"}
    </button>
  );

  switch (shown.status) {
    case "off":
      return null;
    case "signedOut":
      return (
        <span className="status-item" title={SIGNED_OUT}>
          <span className="muted">{compact ? "Not syncing" : "Not syncing · connect Dropbox in Settings"}</span>
          <span className="visually-hidden">. {SIGNED_OUT}</span>
        </span>
      );
    case "syncing":
      return (
        <span className="status-item">
          <span className="muted">Syncing…</span>
        </span>
      );
    case "synced":
      return (
        <span className="status-item" title={`Last synced: ${formatVersionTime(shown.at, Date.now())}`}>
          <span className="muted">{compact ? "Synced" : "Synced with Dropbox"}</span>
          {compact && <span className="visually-hidden"> with Dropbox</span>}
        </span>
      );
    case "error": {
      const why = `${sentence(shown.message)} ${SAFE}`;
      if (!compact) {
        return (
          <span className="status-item sync-error">
            <CloudOff aria-hidden />
            <span title={why}>Not synced · edits go with the next sync</span>
            <span className="visually-hidden">. {why}</span>
            {retry(true)}
          </span>
        );
      }
      return (
        <>
          <button
            ref={trigger}
            type="button"
            className="btn btn--small sync-error"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label="Not synced"
            title="Not synced"
            onClick={() => setOpen(!open)}
          >
            <CloudOff aria-hidden />
          </button>
          {open && (
            <Popover
              anchor={trigger}
              ignore={trigger}
              role="dialog"
              label="Not synced"
              className="problems-popover"
              onClose={(reason) => {
                setOpen(false);
                if (reason === "escape") trigger.current?.focus();
              }}
            >
              <div className="popover-title">Not synced</div>
              <div className="sync-why">
                <p>{sentence(shown.message)}</p>
                <p className="muted">{SAFE}</p>
              </div>
              {retry(false)}
            </Popover>
          )}
        </>
      );
    }
  }
}

/**
 * The warning for the last sync's report, and the popover it opens: the
 * files edited in the same places on two devices, whose text now holds both
 * versions, and the things sync couldn't do. Open, it keeps what it shows
 * until it is closed, even if a newer sync reports nothing. Closing a list
 * of files (`onSeen`) takes them away; problems alone stay until the next
 * sync.
 */
function SyncReport({
  report,
  onSeen,
  fileTitle,
  compact,
}: {
  report: Synced | null;
  onSeen(): void;
  fileTitle(path: string): string | null;
  compact: boolean;
}) {
  /** What the open popover was opened on; null while it is closed. */
  const [opened, setOpened] = useState<Synced | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = report ?? opened;
  if (!shown) return null;

  const { conflicts, problems } = shown;
  const label = conflicts.length > 0 ? editedLabel(conflicts.length) : plural(problems.length, "sync problem", "sync problems");
  const heading = conflicts.length > 0 ? "Edited on two devices" : "Sync problems";
  const texts = conflicts.filter((path) => path !== PROJECT_JSON);
  const name = (path: string) => {
    if (path === DICTIONARY) return "The project’s dictionary";
    const title = fileTitle(path)?.trim();
    return title ? title : <span className="path">{path}</span>;
  };
  const close = () => {
    setOpened(null);
    if (conflicts.length > 0) onSeen();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn--small status-problems"
        aria-expanded={opened !== null}
        aria-haspopup="dialog"
        aria-label={label}
        title={heading}
        onClick={() => (opened ? close() : setOpened(shown))}
      >
        <CloudAlert aria-hidden />
        <span className="num">{compact ? formatCount(conflicts.length > 0 ? conflicts.length : problems.length) : label}</span>
      </button>
      {opened && (
        <Popover
          anchor={trigger}
          ignore={trigger}
          role="dialog"
          label={heading}
          className="problems-popover"
          onClose={(reason) => {
            // Back to the warning, if it stays (problems alone); else the workspace puts focus back in the text.
            if (reason === "escape") trigger.current?.focus();
            close();
          }}
        >
          {conflicts.length > 0 && (
            <>
              <div className="popover-title">Edited on two devices</div>
              {texts.length > 0 && (
                <>
                  <p className="popover-note">
                    These were edited in the same places on two devices. Both versions are in the text, one after the
                    other, this device’s first: keep the one you want.
                  </p>
                  <ul className="problems-list">
                    {texts.map((path) => (
                      <li key={path}>{name(path)}</li>
                    ))}
                  </ul>
                </>
              )}
              {conflicts.includes(PROJECT_JSON) && (
                <p className="popover-note sync-settings-note">
                  Binder and project settings: where both devices changed the same thing, this device’s choice was kept.
                </p>
              )}
            </>
          )}
          {problems.length > 0 && (
            <>
              <div className="popover-title">Sync problems</div>
              <ul className="problems-list">
                {problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
