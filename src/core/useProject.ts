import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadBackend, type Backend, type Version } from "./backend";
import { withFinalNewline } from "./markdown";
import { buildNameMatcher, buildProject, withChapterText, type Project, type ProjectSnapshot } from "./project";

export type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

export type SaveState =
  /** `warning`: the text was saved, but something that comes with a save (keeping the previous version) failed. */
  | { status: "saved"; warning?: string }
  | { status: "pending" }
  | { status: "saving" }
  | { status: "error"; message: string };

/** Autosave runs this long after typing stops. */
export const AUTOSAVE_DELAY_MS = 1000;

const LAST_PROJECT_KEY = "writingTool.lastProject";
const lastChapterKey = (root: string) => `writingTool.lastChapter.${root}`;
const wordsTodayKey = (root: string) => `writingTool.wordsToday.${root}`;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience; nothing breaks without it.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The open project, the open chapter and autosave. Chapter edits update the
 * project at once and are written about a second after typing stops; writes
 * are serialized, and pending ones are flushed when the chapter changes, the
 * window is hidden or the window closes.
 */
export function useProject() {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [project, setProject] = useState<Project | null>(null);
  const [openChapterId, setOpenChapterId] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ status: "saved" });
  /** Counts project loads, so the interface can tell a fresh read, even of the same folder, from an edit. */
  const [loads, setLoads] = useState(0);

  const backendRef = useRef<Backend | null>(null);
  const projectRef = useRef<Project | null>(null);
  const pending = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writing = useRef<Promise<void> | null>(null);
  /** A close was refused because of unsaved changes; the next close goes through. */
  const closeRefused = useRef(false);
  /**
   * The project on disk is about to change under the editors: another
   * project is being opened, or a chapter's version is being restored. Edits
   * are refused meanwhile (the editors are read-only then), as they would be
   * overwritten or belong to neither project.
   */
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    while (writing.current) await writing.current;
    const target = backendRef.current;
    // Pending edits belong to the project open now; the core refuses a save
    // addressed to a project that is no longer open.
    const root = projectRef.current?.root;
    if (!target || !root || pending.current.size === 0) return;

    const batch = [...pending.current];
    pending.current.clear();
    setSave({ status: "saving" });
    let failure: unknown = null;
    let warning: string | null = null;
    const run = (async () => {
      for (const [path, text] of batch) {
        try {
          warning = (await target.writeFile(root, path, text)) ?? warning;
        } catch (error) {
          failure = error;
          // Keep it for the next attempt, unless a newer version is waiting.
          if (!pending.current.has(path)) pending.current.set(path, text);
        }
      }
    })();
    writing.current = run;
    try {
      await run;
    } finally {
      writing.current = null;
    }
    if (failure !== null) {
      setSave({ status: "error", message: message(failure) });
    } else {
      closeRefused.current = false;
      if (pending.current.size > 0) setSave({ status: "pending" });
      else setSave(warning ? { status: "saved", warning } : { status: "saved" });
    }
  }, []);

  /**
   * Shows a freshly opened project. `fallbackFor` is set when the remembered
   * project could not be reopened and this is the sample instead: the reason
   * is listed with the project's problems, and the remembered path is kept so
   * the next launch tries it again (for example once a drive is mounted).
   */
  const applySnapshot = useCallback((snapshot: ProjectSnapshot, target: Backend, fallbackFor?: string) => {
    const built = buildProject(snapshot);
    const next = fallbackFor ? { ...built, problems: [fallbackFor, ...built.problems] } : built;
    pending.current.clear();
    projectRef.current = next;
    setProject(next);
    setLoads((count) => count + 1);
    const remembered = readStorage(lastChapterKey(next.root));
    setOpenChapterId(remembered && next.chapters[remembered] ? remembered : (next.chapterOrder[0] ?? null));
    setSave({ status: "saved" });
    setLoad({ status: "ready" });
    if (target.kind === "app" && !fallbackFor) writeStorage(LAST_PROJECT_KEY, next.root);
  }, []);

  // Open the last project on this device, or the sample project.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const target = await loadBackend();
        const last = target.kind === "app" ? readStorage(LAST_PROJECT_KEY) : null;
        let snapshot: ProjectSnapshot | null = null;
        let fallbackFor: string | undefined;
        if (last) {
          snapshot = await target.openProject(last).catch((error: unknown) => {
            fallbackFor = `Could not reopen your project, so the sample project is open instead. ${message(error)}`;
            return null;
          });
        }
        snapshot ??= await target.openSampleProject();
        if (cancelled) return;
        backendRef.current = target;
        setBackend(target);
        applySnapshot(snapshot, target, fallbackFor);
      } catch (error) {
        if (!cancelled) setLoad({ status: "error", message: message(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySnapshot]);

  // Finish pending saves before the window closes or goes to the background.
  // If they can't be saved, the first close is refused so the error shows;
  // closing again quits without them.
  useEffect(() => {
    if (!backend) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const beforeClose = async (): Promise<boolean> => {
      await flush();
      if (pending.current.size === 0 || closeRefused.current) return true;
      closeRefused.current = true;
      setSave((current) => ({
        status: "error",
        message: `${current.status === "error" ? current.message : "Some changes are not saved."} Close the window again to quit without them.`,
      }));
      return false;
    };
    backend.onCloseRequested(beforeClose).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      disposed = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [backend, flush]);

  const updateChapter = useCallback((id: string, markdown: string) => {
    const current = projectRef.current;
    if (!current || switchingRef.current) return;
    const text = withFinalNewline(markdown);
    const next = withChapterText(current, id, text);
    if (next === current) return;
    projectRef.current = next;
    setProject(next);
    pending.current.set(id, text);
    setSave({ status: "pending" });
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  }, [flush]);

  const openChapter = useCallback((id: string) => {
    const current = projectRef.current;
    if (!current?.chapters[id]) return;
    void flush();
    setOpenChapterId(id);
    writeStorage(lastChapterKey(current.root), id);
  }, [flush]);

  /**
   * Shows a folder picker, then opens the chosen folder. Rejects with the
   * reason if it can't be opened. Edits are saved to the current project
   * before the core switches, and refused while it switches (`switching`).
   */
  const openFolder = useCallback(async (): Promise<void> => {
    const target = backendRef.current;
    if (!target?.canOpenFolders || switchingRef.current) return;
    const path = await target.pickProjectFolder();
    if (!path) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      await flush();
      if (pending.current.size > 0) {
        throw new Error("Some changes in this project could not be saved. Save them (Retry) before opening another project.");
      }
      applySnapshot(await target.openProject(path), target);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [flush, applySnapshot]);

  /** The kept versions of a chapter of the open project, newest first. */
  const listVersions = useCallback(async (id: string): Promise<Version[]> => {
    const target = backendRef.current;
    const root = projectRef.current?.root;
    if (!target || !root) return [];
    return target.listVersions(root, id);
  }, []);

  /**
   * Puts a kept version back as a chapter's text. Pending edits are saved
   * first, so the text being replaced is kept as a version too; edits are
   * refused while the version is written (`switching`). The editors are then
   * remounted on the restored text, as after a fresh read (`loads`).
   */
  const restoreVersion = useCallback(async (id: string, savedAt: number): Promise<void> => {
    const target = backendRef.current;
    const current = projectRef.current;
    if (!target || !current?.chapters[id] || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      await flush();
      if (pending.current.has(id)) {
        throw new Error("This chapter has changes that could not be saved. Save them (Retry) before restoring a version.");
      }
      const text = await target.restoreVersion(current.root, id, savedAt);
      const latest = projectRef.current;
      if (latest?.root !== current.root || !latest.chapters[id]) return;
      // The file holds exactly this text now, so nothing is left to save.
      const next = withChapterText(latest, id, text);
      projectRef.current = next;
      setProject(next);
      setLoads((count) => count + 1);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [flush]);

  const sheets = project?.sheets;
  const matcher = useMemo(() => buildNameMatcher(sheets ?? []), [sheets]);

  const chapters = project?.chapters;
  const bookWords = useMemo(
    () => Object.values(chapters ?? {}).reduce((sum, c) => sum + c.wordCount, 0),
    [chapters],
  );
  const wordsToday = useWordsToday(project?.root ?? null, bookWords, load.status === "ready");

  return {
    backend,
    load,
    project,
    matcher,
    openChapterId,
    openChapter,
    updateChapter,
    save,
    /** Writes pending changes now; also the retry after a failed save. */
    saveNow: flush,
    openFolder,
    listVersions,
    restoreVersion,
    /** The project on disk is about to change (another project opens, a version is restored): show the editors read-only. */
    switching,
    /**
     * Goes up each time a project is read from disk, including the same folder
     * again (its chapters may have changed outside the app), and when a
     * chapter's version is restored: editors, which read their text on mount,
     * must be remounted then.
     */
    loads,
    bookWords,
    wordsToday,
  };
}

interface Baseline {
  key: string;
  date: string;
  words: number;
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readBaseline(key: string): { date: string; words: number } | null {
  try {
    const parsed: unknown = JSON.parse(readStorage(key) ?? "null");
    if (typeof parsed === "object" && parsed !== null) {
      const { date, words } = parsed as Record<string, unknown>;
      if (typeof date === "string" && typeof words === "number") return { date, words };
    }
  } catch {
    // Unreadable baseline: start counting from now.
  }
  return null;
}

/**
 * Net words written today on this device: the book's word count now, minus
 * what it was the first time the project was open today.
 */
function useWordsToday(root: string | null, bookWords: number, ready: boolean): number {
  const date = localDate();
  const key = root ? wordsTodayKey(root) : null;
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const current = baseline !== null && baseline.key === key && baseline.date === date;

  useEffect(() => {
    if (!key || !ready || current) return;
    const stored = readBaseline(key);
    const next = stored && stored.date === date ? { key, ...stored } : { key, date, words: bookWords };
    writeStorage(key, JSON.stringify({ date: next.date, words: next.words }));
    setBaseline(next);
  }, [key, date, ready, current, bookWords]);

  return current ? bookWords - baseline.words : 0;
}
