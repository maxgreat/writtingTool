import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadBackend, type Backend, type Version } from "./backend";
import { planTrashSheet, withChapterDetails, type ChapterDetails, type Plan } from "./binder";
import { withFinalNewline } from "./markdown";
import { withIgnoredName, withNotName, type ProjectJsonWrite } from "./nameChoices";
import type { IgnoredName } from "./names";
import { buildNameMatcher, buildProject, withChapterText, withSheetText, type Project, type ProjectSnapshot } from "./project";
import { editSheetText, newSheetPath, newSheetText, type SheetEdit } from "./sheetFile";
import { newProject, readRecentProjects, rememberRecentProject, type ProjectEntry } from "./projects";

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
  const openRef = useRef<string | null>(null);
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

  const showChapter = useCallback((root: string, id: string | null) => {
    openRef.current = id;
    setOpenChapterId(id);
    if (id) writeStorage(lastChapterKey(root), id);
  }, []);

  /**
   * Shows a project read from disk. `fallbackFor` is set when the remembered
   * project could not be reopened and this is the sample instead: the reason
   * is listed with the project's problems, and the remembered path is kept so
   * the next launch tries it again (for example once a drive is mounted).
   * `openId` is the chapter to open, if it exists; otherwise the chapter open
   * last time in this project, or the first one.
   */
  const applySnapshot = useCallback(
    (snapshot: ProjectSnapshot, target: Backend, options: { fallbackFor?: string; openId?: string | null } = {}) => {
      const { fallbackFor, openId } = options;
      const built = buildProject(snapshot);
      const next = fallbackFor ? { ...built, problems: [fallbackFor, ...built.problems] } : built;
      pending.current.clear();
      projectRef.current = next;
      setProject(next);
      setLoads((count) => count + 1);
      const remembered = openId ?? readStorage(lastChapterKey(next.root));
      showChapter(next.root, remembered && next.chapters[remembered] ? remembered : (next.chapterOrder[0] ?? null));
      setSave({ status: "saved" });
      setLoad({ status: "ready" });
      if (target.kind === "app" && !fallbackFor) {
        writeStorage(LAST_PROJECT_KEY, next.root);
        rememberRecentProject(next.root);
      }
    },
    [showChapter],
  );

  // Open the last project on this device, or the sample project.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const target = await loadBackend();
        if (cancelled) return;
        // Known before a project opens, for the screens shown meanwhile (Back, on phones).
        backendRef.current = target;
        setBackend(target);
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
        applySnapshot(snapshot, target, { fallbackFor });
      } catch (error) {
        if (!cancelled) setLoad({ status: "error", message: message(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySnapshot]);

  /** The answer to a close being decided, which a close asked for meanwhile shares. */
  const closeDecision = useRef<Promise<boolean> | null>(null);

  /**
   * Whether the window may close: pending saves are finished first. If they
   * can't be saved, the first close is refused so the error shows; closing
   * again quits without them. A close asked for while one is being decided
   * gets the same answer, so a second press can't count as "again". The
   * window's close button, Quit and a phone's Back all ask. `again` ends
   * the error: how to leave without the edits.
   */
  const mayClose = useCallback((again = "Close the window again to quit without them."): Promise<boolean> => {
    closeDecision.current ??= (async () => {
      await flush();
      if (pending.current.size === 0 || closeRefused.current) return true;
      closeRefused.current = true;
      setSave((current) => ({
        status: "error",
        message: `${current.status === "error" ? current.message : "Some changes are not saved."} ${again}`,
      }));
      return false;
    })().finally(() => {
      closeDecision.current = null;
    });
    return closeDecision.current;
  }, [flush]);

  // Finish pending saves before the window closes (see mayClose) or goes to the background.
  useEffect(() => {
    if (!backend) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    backend.onCloseRequested(mayClose).then((stop) => {
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
  }, [backend, flush, mayClose]);

  /** Shows a changed project at once and writes `path` about a second after the last change. */
  const changeLater = useCallback((next: Project, path: string, text: string) => {
    projectRef.current = next;
    setProject(next);
    pending.current.set(path, text);
    setSave({ status: "pending" });
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  }, [flush]);

  const updateChapter = useCallback((id: string, markdown: string) => {
    const current = projectRef.current;
    if (!current || switchingRef.current) return;
    const text = withFinalNewline(markdown);
    const next = withChapterText(current, id, text);
    if (next === current) return;
    changeLater(next, id, text);
  }, [changeLater]);

  /**
   * Sets a chapter's status, point of view or synopsis, saved in
   * project.json like an edit. Throws, changing nothing, when project.json
   * could not be read (it must not be overwritten then).
   */
  const updateChapterDetails = useCallback((id: string, details: ChapterDetails) => {
    const current = projectRef.current;
    if (!current || switchingRef.current) return;
    const { project: next, write } = withChapterDetails(current, id, details);
    changeLater(next, write.path, write.text);
  }, [changeLater]);

  /**
   * Changes a sheet from the inspector's form, saved like an edit. Throws,
   * changing nothing, when the sheet's header can't be read (rewriting it
   * could lose what is there) or the edit is refused (an empty name).
   */
  const updateSheet = useCallback((id: string, edit: SheetEdit) => {
    const current = projectRef.current;
    if (!current || switchingRef.current) return;
    const sheet = current.sheets.find((s) => s.id === id);
    if (!sheet) throw new Error("That sheet is no longer in the project.");
    if (!sheet.editable) throw new Error("This sheet's header could not be read. Fix it in the file first.");
    const text = editSheetText(sheet.text, edit);
    const next = withSheetText(current, id, text);
    if (next === current) return;
    changeLater(next, id, text);
  }, [changeLater]);

  /**
   * Creates a sheet of type `kind` named `name`, as sheets/<kind>/<name>.md,
   * and resolves to its id. The core makes the type's folder if it is
   * missing and never replaces a file. The sheet joins the project as it is
   * in memory, so the open chapter and its caret stay as they are. Rejects
   * with a message for the writer if the file can't be made.
   */
  const createSheet = useCallback(async (kind: string, name: string): Promise<string> => {
    const target = backendRef.current;
    const current = projectRef.current;
    if (!target || !current) throw new Error("No project is open.");
    if (switchingRef.current) throw new Error("The project is changing on disk. Try again in a moment.");
    const text = newSheetText(name);
    const id = newSheetPath(current, kind, name);
    await target.applyChanges(current.root, {
      folders: [],
      sheetFolders: ["sheets", `sheets/${kind}`],
      moves: [],
      writes: [{ path: id, text, mustBeNew: true }],
    });
    // Typing may have changed the project meanwhile; another project may be open now.
    const latest = projectRef.current;
    if (latest?.root === current.root) {
      const next = withSheetText(latest, id, text);
      projectRef.current = next;
      setProject(next);
    }
    return id;
  }, []);

  /** Saves a change to project.json like an edit; nothing when there is no change. */
  const changeJson = useCallback(
    (make: (project: Project) => ProjectJsonWrite | null) => {
      const current = projectRef.current;
      if (!current || switchingRef.current) return;
      const change = make(current);
      if (change) changeLater(change.project, "project.json", change.text);
    },
    [changeLater],
  );

  /**
   * "Ignore here": stops highlighting one occurrence of a name, remembered
   * in project.json by its sentence; with `ignore` false, highlights it
   * again. Throws, changing nothing, when project.json could not be read.
   */
  const ignoreName = useCallback(
    (entry: IgnoredName, ignore = true) => changeJson((p) => withIgnoredName(p, entry, ignore)),
    [changeJson],
  );

  /**
   * Marks a word as not a name, so it is no longer offered as a possible
   * name; with `notName` false, takes the mark away. Throws, changing
   * nothing, when project.json could not be read.
   */
  const markNotName = useCallback(
    (word: string, notName = true) => changeJson((p) => withNotName(p, word, notName)),
    [changeJson],
  );

  const openChapter = useCallback((id: string) => {
    const current = projectRef.current;
    if (!current?.chapters[id]) return;
    void flush();
    showChapter(current.root, id);
  }, [flush, showChapter]);

  /**
   * Changes the binder: saves pending edits, plans the change on the project
   * as saved (`makePlan`, from src/core/binder.ts; null means nothing to
   * do), has the core make each step, then shows the project as it is on
   * disk. The open chapter follows its file through renames; a chapter the
   * plan creates is opened. Edits are refused meanwhile (`switching`).
   * Rejects with a message for the writer if a step fails; earlier steps of
   * the plan stay made and are shown.
   */
  const changeBinder = useCallback(async (makePlan: (project: Project) => Plan | null): Promise<void> => {
    const target = backendRef.current;
    if (!target || !projectRef.current || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      await flush();
      if (pending.current.size > 0) {
        throw new Error("Some changes could not be saved. Save them (Retry) before changing the binder.");
      }
      const current = projectRef.current;
      const plan = makePlan(current);
      if (!plan) return;
      const open = openRef.current;
      let snapshot: ProjectSnapshot | null = null;
      let made = 0;
      try {
        for (const change of plan.changes) {
          snapshot = await target.applyChanges(current.root, change);
          made += 1;
        }
      } finally {
        // Paths in `plan` are where things end up once every step is made;
        // after a failed step, the open chapter is still where it was.
        const complete = made === plan.changes.length;
        const openId = complete ? (plan.created ?? (open ? (plan.renamed.get(open) ?? open) : null)) : open;
        if (snapshot) applySnapshot(snapshot, target, { openId });
      }
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [flush, applySnapshot]);

  /**
   * Moves a sheet to the Trash, from where the binder can restore it. Pending
   * edits, the sheet's own included, are saved first (see changeBinder).
   * Rejects with a message for the writer if it can't be moved.
   */
  const trashSheet = useCallback(
    (id: string): Promise<void> => changeBinder((current) => planTrashSheet(current, id)),
    [changeBinder],
  );

  /**
   * Opens another project: saves pending edits to the current one first, and
   * refuses edits while the core switches (`switching`). Rejects with the
   * reason if the project can't be opened, or if edits can't be saved.
   */
  const switchProject = useCallback(async (open: (target: Backend) => Promise<ProjectSnapshot>): Promise<void> => {
    const target = backendRef.current;
    if (!target || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    try {
      await flush();
      if (pending.current.size > 0) {
        throw new Error("Some changes in this project could not be saved. Save them (Retry) before opening another project.");
      }
      applySnapshot(await open(target), target);
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [flush, applySnapshot]);

  /** Shows a folder picker, then opens the chosen folder (see `switchProject`). */
  const openFolder = useCallback(async (): Promise<void> => {
    const target = backendRef.current;
    if (!target?.canOpenFolders || switchingRef.current) return;
    const path = await target.pickProjectFolder();
    if (!path) return;
    await switchProject((t) => t.openProject(path));
  }, [switchProject]);

  /** Opens a project from the projects list (see `switchProject`). */
  const openProjectAt = useCallback(
    (path: string): Promise<void> => switchProject((t) => t.openProject(path)),
    [switchProject],
  );

  /** Creates a project in the app's own folder and opens it (see `switchProject`). */
  const createProject = useCallback(
    (title: string, language: string): Promise<void> => switchProject((t) => t.createProject(newProject(title, language))),
    [switchProject],
  );

  /** The projects on this device, with the folders opened recently from elsewhere. */
  const listProjects = useCallback(async (): Promise<ProjectEntry[]> => {
    const target = backendRef.current;
    return target ? target.listProjects(readRecentProjects()) : [];
  }, []);

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

  // The matcher only depends on each sheet's id, type, name and aliases, so
  // editing a sheet's fields or notes doesn't rebuild it (and with it the
  // name index and every highlight).
  const sheets = project?.sheets;
  const namesKey = useMemo(
    () => JSON.stringify((sheets ?? []).map((s) => [s.id, s.kind, s.name, s.aliases])),
    [sheets],
  );
  // Runs in the render where namesKey or the ignored occurrences changed,
  // so `sheets` is that render's.
  const ignoredNames = project?.ignoredNames;
  const matcher = useMemo(() => buildNameMatcher(sheets ?? [], ignoredNames), [namesKey, ignoredNames]);

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
    mayClose,
    openFolder,
    openProjectAt,
    createProject,
    listProjects,
    updateChapterDetails,
    createSheet,
    updateSheet,
    ignoreName,
    markNotName,
    changeBinder,
    trashSheet,
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
