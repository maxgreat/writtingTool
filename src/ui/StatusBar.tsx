import { Check, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import type { Backend } from "../core/backend";
import type { SaveState } from "../core/useProject";
import { cx, formatCount, formatSigned, languageName, plural } from "./dom";
import { Popover } from "./Popover";

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
  /** Phones: the chapter and today's counts and the save state only. */
  compact: boolean;
}

/** Word counts, the project language, problems reading files, and where the work is saved. */
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
  compact,
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
      </div>

      <div className="status-group status-group--end">
        {problems.length > 0 && <Problems problems={problems} compact={compact} />}
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
