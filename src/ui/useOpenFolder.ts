import { useCallback, useState } from "react";
import { errorMessage } from "./dom";

/** Runs "Open folder…" with a busy flag (to disable the button) and the error to show. */
export function useOpenFolder(openFolder: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await openFolder();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [openFolder]);
  return { busy, error, run };
}
