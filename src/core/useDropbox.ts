import { useCallback, useEffect, useRef, useState } from "react";
import { DROPBOX_SIGN_IN_CANCELLED, type DropboxAccount, type DropboxBackend, type DropboxStatus } from "./backend";

/** Where the connection stands, for the interface to show. */
export type DropboxView =
  /** The connection is being read on this device. */
  | { step: "loading" }
  | { step: "disconnected" }
  /** Dropbox's page is being opened in the browser. */
  | { step: "starting" }
  /**
   * Waiting for the writer to finish on Dropbox's page. With `manual`,
   * Dropbox shows a code to paste here; `submitting` while a pasted code is
   * being checked.
   */
  | { step: "waiting"; manual: boolean; submitting: boolean }
  /** `disconnecting` while signing out. */
  | { step: "connected"; account: DropboxAccount; tokenInFile: boolean; disconnecting: boolean };

export interface DropboxConnection {
  view: DropboxView;
  /** Why the last step failed, as a sentence for the writer; null after the next step starts. */
  error: string | null;
  /** Something to know after signing out (Dropbox couldn't be told); null otherwise. */
  note: string | null;
  /** Opens Dropbox's page and waits for the writer to allow access there. */
  connect(): Promise<void>;
  /** Finishes with the code Dropbox showed, when it shows one (`manual`). */
  submitCode(code: string): Promise<void>;
  /** Stops waiting for Dropbox. */
  cancel(): Promise<void>;
  /** Signs out on this device. */
  disconnect(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function viewOf(status: DropboxStatus): DropboxView {
  return status.account
    ? { step: "connected", account: status.account, tokenInFile: status.tokenInFile, disconnecting: false }
    : { step: "disconnected" };
}

/**
 * The Dropbox connection, for the settings. Null where this build or the
 * browser preview has no Dropbox. A sign-in still waiting when the
 * component goes away is cancelled.
 */
export function useDropbox(dropbox: DropboxBackend | undefined): DropboxConnection | null {
  const [view, setView] = useState<DropboxView>({ step: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Counts sign-ins and sign-outs: an answer is only shown if no newer step started since. */
  const turn = useRef(0);
  const waiting = useRef(false);

  useEffect(() => {
    if (!dropbox) return;
    const mine = ++turn.current;
    setView({ step: "loading" });
    dropbox.status().then(
      (status) => {
        if (turn.current === mine) setView(viewOf(status));
      },
      (failure: unknown) => {
        if (turn.current !== mine) return;
        setView({ step: "disconnected" });
        setError(message(failure));
      },
    );
    return () => {
      turn.current += 1;
      if (waiting.current) {
        waiting.current = false;
        dropbox.signInCancel().catch((failure: unknown) => console.error("Cannot stop waiting for Dropbox", failure));
      }
    };
  }, [dropbox]);

  const connect = useCallback(async () => {
    if (!dropbox) return;
    const mine = ++turn.current;
    setError(null);
    setNote(null);
    setView({ step: "starting" });
    let manual: boolean;
    try {
      ({ manual } = await dropbox.signInStart());
    } catch (failure) {
      if (turn.current !== mine) return;
      setView({ step: "disconnected" });
      setError(message(failure));
      return;
    }
    if (turn.current !== mine) return;
    waiting.current = true;
    setView({ step: "waiting", manual, submitting: false });
    if (manual) return;
    try {
      const status = await dropbox.signInFinish();
      if (turn.current !== mine) return;
      waiting.current = false;
      setView(viewOf(status));
    } catch (failure) {
      if (turn.current !== mine) return;
      waiting.current = false;
      setView({ step: "disconnected" });
      const reason = message(failure);
      if (reason !== DROPBOX_SIGN_IN_CANCELLED) setError(reason);
    }
  }, [dropbox]);

  const submitCode = useCallback(
    async (code: string) => {
      if (!dropbox) return;
      const mine = turn.current;
      setError(null);
      setView({ step: "waiting", manual: true, submitting: true });
      try {
        const status = await dropbox.signInFinish(code.trim());
        if (turn.current !== mine) return;
        waiting.current = false;
        setView(viewOf(status));
      } catch (failure) {
        if (turn.current !== mine) return;
        // The code can be corrected and tried again.
        setView({ step: "waiting", manual: true, submitting: false });
        setError(message(failure));
      }
    },
    [dropbox],
  );

  const cancel = useCallback(async () => {
    if (!dropbox) return;
    const mine = ++turn.current;
    waiting.current = false;
    setError(null);
    setView({ step: "disconnected" });
    try {
      await dropbox.signInCancel();
      // A sign-in that kept its access just before Cancel shows as connected.
      const status = await dropbox.status();
      if (turn.current === mine) setView(viewOf(status));
    } catch (failure) {
      if (turn.current === mine) setError(message(failure));
    }
  }, [dropbox]);

  const disconnect = useCallback(async () => {
    if (!dropbox || view.step !== "connected") return;
    const mine = ++turn.current;
    setError(null);
    setNote(null);
    setView({ ...view, disconnecting: true });
    try {
      const told = await dropbox.signOut();
      if (turn.current !== mine) return;
      setView({ step: "disconnected" });
      setNote(told);
    } catch (failure) {
      if (turn.current !== mine) return;
      setView({ ...view, disconnecting: false });
      setError(message(failure));
    }
  }, [dropbox, view]);

  return dropbox ? { view, error, note, connect, submitCode, cancel, disconnect } : null;
}
