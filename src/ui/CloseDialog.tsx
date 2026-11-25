import { useEffect, useId, useRef, useState, type JSX, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { SaveState } from "../core/useProject";
import { BackLayer } from "./BackStack";

export interface CloseDialogProps {
  open: boolean;
  save: SaveState;
  /** Save and close (or Try again) was pressed and the save is being written: the buttons wait. */
  closing: boolean;
  /** Stay open. */
  onCancel(): void;
  /** Close: only offered when everything is saved. */
  onClose(): void;
  /** Close without saving the pending edits. */
  onDiscard(): void;
  /** Write the pending edits, then close (also the retry after an error). */
  onSaveAndClose(): void;
}

/** What the dialog shows: the save state, with a write under way (autosave's, or Save and close's) as one. */
type View = "saved" | "pending" | "saving" | "error";

const TITLES: Record<View, string> = {
  saved: "Close Writing Tool?",
  pending: "Save changes before closing?",
  saving: "Save changes before closing?",
  error: "Couldn’t save your changes",
};

/**
 * Desktop: asked before the window closes (its close button, or Quit).
 * Autosave has usually written everything already, so it says so; when
 * something isn't written yet it offers to save it first, and after a failed
 * save, to try again or to close without it.
 *
 * A decision, so the scrim does nothing when pressed; Escape (and a phone's
 * Back) cancels. It sits in a portal above everything, popovers included.
 * Focus starts on the primary button (on Cancel while that waits), Tab stays
 * inside, and focus goes back where it was once the dialog closes. Keys
 * pressed in it don't bubble on to the app.
 */
export function CloseDialog({
  open,
  save,
  closing,
  onCancel,
  onClose,
  onDiscard,
  onSaveAndClose,
}: CloseDialogProps): JSX.Element | null {
  const titleId = useId();
  const textId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  /** Where focus was before the dialog opened. */
  const returnTo = useRef<Element | null>(null);
  /** Where the dialog last put focus: focus left there follows the primary button as the view changes. */
  const placed = useRef<HTMLElement | null>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  const view: View = closing || save.status === "saving" ? "saving" : save.status;
  const waiting = view === "saving";

  // Try again keeps its label while the retry waits, so the button pressed doesn't change size.
  const [retrying, setRetrying] = useState(false);
  const retry = open && (view === "error" || (waiting && retrying));
  if (retry !== retrying) setRetrying(retry);

  // Remembers where focus was, and puts it back once the dialog closes: unless
  // something else took it meanwhile. StrictMode's second run finds focus
  // already in the dialog, and keeps the first run's answer.
  useEffect(() => {
    if (!open) return;
    const node = panel.current;
    const active = document.activeElement;
    if (active && !node?.contains(active)) returnTo.current = active;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected || node?.contains(now);
      const back = returnTo.current;
      if (lost && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);

  // Focus starts on the primary button, or on Cancel while the primary waits.
  // Left where the dialog put it, it follows the primary as the view changes;
  // moved by the user, it stays, unless its button is turned off.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const chosen =
      active instanceof HTMLButtonElement && !active.disabled && active !== placed.current && panel.current?.contains(active);
    if (chosen) return;
    const target = waiting ? cancelButton.current : primary.current;
    target?.focus({ preventScroll: true });
    placed.current = target;
  }, [open, view, waiting]);

  // Escape cancels; Tab and Shift+Tab go round the dialog's buttons. On the
  // window, in the capture phase, so menus and sheets beneath don't see them.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel.current();
        return;
      }
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (buttons.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.shiftKey ? -1 : 1;
      const next =
        at === -1 ? (event.shiftKey ? buttons.length - 1 : 0) : (at + step + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!open) return null;

  const saved = view === "saved";
  let text: JSX.Element;
  if (view === "error") {
    text = (
      <>
        <p>{save.status === "error" ? save.message : ""}</p>
        <p>Close without saving to quit without them.</p>
      </>
    );
  } else {
    text = (
      <p>
        {saved ? "All your changes are saved." : waiting ? "Saving…" : "Your latest changes aren’t saved yet."}
      </p>
    );
  }

  // A press on the scrim leaves focus where it is, in the dialog.
  const keepFocus = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) event.preventDefault();
  };

  return createPortal(
    <BackLayer open onBack={() => cancel.current()}>
      <div className="close-dialog-scrim" onMouseDown={keepFocus} onKeyDown={(event) => event.stopPropagation()}>
        <div
          ref={panel}
          className="close-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={textId}
          tabIndex={-1}
        >
          <h2 id={titleId} className="close-dialog-title">
            {TITLES[view]}
          </h2>
          {/* Announced as it changes: Saving…, then why a save failed. */}
          <div id={textId} className="close-dialog-text" aria-live="polite">
            {text}
          </div>
          <div className="close-dialog-actions">
            {!saved && (
              <button type="button" className="btn btn--quiet close-dialog-discard" disabled={waiting} onClick={onDiscard}>
                Close without saving
              </button>
            )}
            <div className="close-dialog-choices">
              <button ref={cancelButton} type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <button
                ref={primary}
                type="button"
                className="btn btn--primary"
                disabled={waiting}
                aria-busy={waiting || undefined}
                onClick={saved ? onClose : onSaveAndClose}
              >
                {saved ? "Close" : retry ? "Try again" : "Save and close"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </BackLayer>,
    document.body,
  );
}
