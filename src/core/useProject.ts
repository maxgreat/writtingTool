import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadBackend, type Backend, type DropboxProject, type Version } from "./backend";
import { planTrashSheet, withChapterDetails, type ChapterDetails, type Plan } from "./binder";
import { withFinalNewline } from "./markdown";
import { withIgnoredName, withNotName, type ProjectJsonWrite } from "./nameChoices";
import type { IgnoredName } from "./names";
import { buildNameMatcher, buildProject, withChapterText, withSheetText, type Project, type ProjectSnapshot } from "./project";
import { editSheetText, newSheetPath, newSheetText, type SheetEdit } from "./sheetFile";
import { withExportChoice, withExportPreset } from "./exportBook";
import type { ExportFormat, ExportSettings } from "./exportSettings";
import { withLanguage } from "./projectSettings";
import { spellingKey, withWordAdded } from "./spelling";
import { newProject, readRecentProjects, rememberRecentProject, type ProjectEntry } from "./projects";
import { changedAnything, followMoves, withUnsaved, type SyncOutcome } from "./syncApply";

export type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

export type SaveState =
  /** `warning`: the text was saved, but something that comes with a save (keeping the previous version) failed. */
  | { status: "saved"; warning?: string }
  | { status: "pending" }
  | { status: "saving" }
  | { status: "error"; message: string };

/** Autosave runs this long after typing stops. */
export const AUTOSAVE_DELAY_MS = 1000;

/** How the open project stands with Dropbox. */
export type SyncState =
  /** On this device only, or no Dropbox in this build: nothing to show. */
  | { status: "off" }
  /** The project is in Dropbox, but no account is connected on this device. */
  | { status: "signedOut" }
  /** `at`: when the last sync finished, if one has. */
  | { status: "syncing"; at: number | null }
  /**
   * `conflicts`: files changed in the same places on two devices, both
   * versions kept in the text (project.json keeps this device's choices),
   * gathered across syncs until dismissConflicts. `unsent`: the project
   * was changed here since, and with automatic syncs off nothing will send
   * it until the writer asks.
   */
  | { status: "synced"; at: number; conflicts: string[]; problems: string[]; unsent?: boolean }
  /** The last sync failed. Edits stay on this device and go with the next one. */
  | { status: "error"; message: string; at: number | null };

/** A project in Dropbox syncs this often while the app is in front. */
export const SYNC_INTERVAL_MS = 30_000;
/** After a sync that met a change made meanwhile, the next one comes this soon (with automatic syncs on). */
export const SYNC_AGAIN_MS = 3_000;
/**
 * Save to Dropbox syncs again at once while Dropbox changed under it, up to
 * this many syncs in all; still unfinished, the status says so.
 */
export const SAVE_TRIES = 3;

function syncedAt(state: SyncState): number | null {
  return state.status === "synced" ? state.at : state.status === "syncing" || state.status === "error" ? state.at : null;
}

/** A synced project, now with changes Dropbox hasn't got; any other state as it is. */
function withUnsent(state: SyncState): SyncState {
  return state.status === "synced" && !state.unsent ? { ...state, unsent: true } : state;
}

/** The project's own words for the spelling check (see spelling.ts). */
const DICTIONARY_FILE = "dictionary.txt";
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

export interface ProjectOptions {
  /**
   * A project in Dropbox syncs by itself: when it opens, when the app comes
   * back to the front, every SYNC_INTERVAL_MS, and on the first edit in a
   * chapter. Off, it syncs only when asked (syncNow, saveToDropbox). On by
   * default.
   */
  autoSync?: boolean;
}

/**
 * The open project, the open chapter and autosave. Chapter edits update the
 * project at once and are written about a second after typing stops; writes
 * are serialized, and pending ones are flushed when the chapter changes, the
 * window is hidden or the window closes.
 */
export function useProject({ autoSync = true }: ProjectOptions = {}) {
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
   * Autosave waits while this is set (the close dialog is open: the writer
   * is choosing whether to save). `due` records that a save was due
   * meanwhile, so it is started again when the hold ends.
   */
  const autosaveHold = useRef<{ due: boolean } | null>(null);
  /** Asked in place of `mayClose` when the window is about to close (see setCloseHandler). */
  const closeHandler = useRef<(() => Promise<boolean>) | null>(null);
  /**
   * The project on disk is about to change under the editors: another
   * project is being opened, or a chapter's version is being restored. Edits
   * are refused meanwhile (the editors are read-only then), as they would be
   * overwritten or belong to neither project.
   */
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);

  const [sync, setSync] = useState<SyncState>({ status: "off" });
  /** The sync under way: another asked for meanwhile shares it. */
  const syncRun = useRef<Promise<void> | null>(null);
  /** Puts text in the open chapter's editor as one undo step (see setEditorWriter); false when it takes no edits. */
  const editorWriter = useRef<((markdown: string) => boolean) | null>(null);
  /** The open chapter has been checked with Dropbox since it was opened, on its first edit. */
  const checkedOpen = useRef(false);
  /** `autoSync` as this render has it, for callbacks made earlier. */
  const autoSyncRef = useRef(autoSync);
  autoSyncRef.current = autoSync;
  /** The project was changed on this device since the last sync started: not all of it is in Dropbox. */
  const changedSinceSync = useRef(false);
  /** A sync is putting what it brought in into the open chapter's editor, which reports it as an edit. */
  const bringingIn = useRef(false);
  /** Files edited in the same places on two devices, gathered across syncs until the writer has seen them. */
  const conflicts = useRef<string[]>([]);

  /**
   * The writer changed the project on this device. With automatic syncs
   * off, a project that was synced says it has changes Dropbox hasn't got.
   */
  const noteChange = useCallback(() => {
    // The open editor echoing what a sync brought in is not a change made here.
    if (bringingIn.current) return;
    changedSinceSync.current = true;
    if (!autoSyncRef.current) setSync(withUnsent);
  }, []);

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
    if (openRef.current !== id) checkedOpen.current = false;
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
      if (projectRef.current?.root !== next.root) {
        conflicts.current = [];
        changedSinceSync.current = false;
        setSync({ status: "off" });
      }
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

  /**
   * Brings what a sync changed into the project as shown. Edits typed while
   * it ran are merged with what arrived, the open chapter's editor is given
   * its new text as one undo step, and the project is read again from disk
   * with the edits not saved yet laid over it. Runs while saves wait, so
   * nothing is written meanwhile. Resolves to the files where what was
   * typed meanwhile clashed with what arrived (both versions kept).
   */
  const takeIn = useCallback(
    async (target: Backend, root: string, outcome: SyncOutcome): Promise<string[]> => {
      const dropbox = target.dropbox;
      const clashed: string[] = [];
      if (!dropbox || !changedAnything(outcome)) return clashed;
      // Edits waiting to be saved follow their files' moves.
      for (const [path, text] of [...pending.current]) {
        const moved = followMoves(path, outcome.moved);
        if (moved !== path && !pending.current.has(moved)) {
          pending.current.delete(path);
          pending.current.set(moved, text);
        }
      }
      const open = openRef.current === null ? null : followMoves(openRef.current, outcome.moved);
      let remount = open !== openRef.current;
      for (const change of outcome.changed) {
        // Deleted in Dropbox: an edit here keeps the file.
        if (change.after === null) continue;
        let ours = pending.current.get(change.path);
        let text = change.after;
        while (ours !== undefined && ours !== change.before) {
          const merged = await dropbox.merge(change.path, change.before ?? "", ours, change.after);
          const now: string | undefined = pending.current.get(change.path);
          if (now === ours) {
            text = merged.text;
            if (merged.conflicts > 0) clashed.push(change.path);
            break;
          }
          ours = now;
        }
        if (projectRef.current?.root !== root) return clashed;
        if (ours !== undefined) pending.current.set(change.path, text);
        if (change.path === open && !remount) {
          bringingIn.current = true;
          let taken = false;
          try {
            taken = editorWriter.current?.(text) ?? false;
          } finally {
            bringingIn.current = false;
          }
          if (!taken) remount = true;
        }
      }
      const snapshot = await target.openProject(root);
      if (projectRef.current?.root !== root) return clashed;
      const next = buildProject(withUnsaved(snapshot, pending.current));
      projectRef.current = next;
      setProject(next);
      const keep = open !== null && next.chapters[open] ? open : null;
      showChapter(root, keep ?? next.chapterOrder[0] ?? null);
      if (remount || keep === null) setLoads((count) => count + 1);
      if (pending.current.size > 0) {
        setSave({ status: "pending" });
        if (timer.current === null && !autosaveHold.current) timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
      }
      return clashed;
    },
    [flush, showChapter],
  );

  /**
   * Runs `step` (a sync, or putting the project in Dropbox) on the open
   * project once its edits are saved, while saves wait, then takes in what
   * it changed. One at a time: asked again meanwhile, the run under way is
   * the answer. Nothing happens without Dropbox or while the project is
   * changing on disk. `shown`: "Syncing…" shows even for a project not in
   * Dropbox yet, as the writer asked for it.
   */
  const runSync = useCallback(
    (
      step: (dropbox: NonNullable<Backend["dropbox"]>, root: string) => Promise<SyncOutcome | "off" | "signedOut">,
      shown = false,
    ): Promise<void> => {
      const target = backendRef.current;
      const dropbox = target?.dropbox;
      if (!target || !dropbox) return Promise.resolve();
      if (syncRun.current) return syncRun.current;
      const run = (async () => {
        const root = projectRef.current?.root;
        if (!root || switchingRef.current) return;
        await flush();
        // A save failed: its error shows, and sync waits for it.
        if (pending.current.size > 0 || projectRef.current?.root !== root) return;
        while (writing.current) await writing.current;
        let release = () => {};
        writing.current = new Promise<void>((resolve) => {
          release = resolve;
        });
        // Everything on disk goes with this sync: what changes from now on is for the next one.
        changedSinceSync.current = false;
        // A project not in Dropbox (or not connected) is only checked: nothing to show meanwhile.
        setSync((state) =>
          !shown && (state.status === "off" || state.status === "signedOut")
            ? state
            : { status: "syncing", at: syncedAt(state) },
        );
        try {
          const result = await step(dropbox, root);
          if (projectRef.current?.root !== root) return;
          if (result === "off" || result === "signedOut") {
            setSync({ status: result });
            return;
          }
          const clashed = await takeIn(target, root, result);
          if (projectRef.current?.root !== root) return;
          conflicts.current = [...new Set([...conflicts.current, ...result.conflicts, ...clashed])];
          setSync({
            status: "synced",
            at: Date.now(),
            conflicts: conflicts.current,
            problems: result.problems,
            // `again`: Dropbox changed under the sync, so some of what changed here may not be there yet.
            unsent: (changedSinceSync.current || result.again) && !autoSyncRef.current,
          });
          // Off, nothing syncs unasked: Save to Dropbox tries again itself (SAVE_TRIES).
          if (result.again && autoSyncRef.current) setTimeout(() => void syncNowRef.current(), SYNC_AGAIN_MS);
        } catch (error) {
          setSync((state) => ({ status: "error", message: message(error), at: syncedAt(state) }));
        } finally {
          writing.current = null;
          release();
        }
      })().finally(() => {
        syncRun.current = null;
      });
      syncRun.current = run;
      return run;
    },
    [flush, takeIn],
  );

  /** Syncs the open project with Dropbox, if it is there. */
  const syncNow = useCallback(
    (): Promise<void> =>
      runSync(async (dropbox, root) => {
        const result = await dropbox.sync(root);
        return result.state === "done" ? result.outcome : result.state;
      }),
    [runSync],
  );
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;

  /**
   * Runs `step` as runSync does, for something the writer asked for: after
   * any sync under way, so edits made since go too. Rejects with the reason
   * when the step fails, or with `unsaved` when edits that couldn't be saved
   * kept it from running.
   */
  const runAsked = useCallback(
    async (
      step: (dropbox: NonNullable<Backend["dropbox"]>, root: string) => Promise<SyncOutcome | "off" | "signedOut">,
      unsaved: string,
      shown = false,
    ): Promise<void> => {
      while (syncRun.current) await syncRun.current;
      let ran = false;
      let failure: unknown = null;
      await runSync(async (dropbox, root) => {
        ran = true;
        try {
          return await step(dropbox, root);
        } catch (error) {
          failure = error;
          throw error;
        }
      }, shown);
      if (failure !== null) throw failure;
      if (!ran) throw new Error(unsaved);
    },
    [runSync],
  );

  /**
   * Puts the open project in Dropbox and sends it, after any sync under
   * way. Rejects with the reason when it can't.
   */
  const putInDropbox = useCallback(
    (): Promise<void> =>
      runAsked(
        (dropbox, root) => dropbox.putProject(root),
        "The project can’t be put in Dropbox until its changes are saved. Save them (Retry) first.",
      ),
    [runAsked],
  );

  /**
   * Save to Dropbox: syncs the open project now, after any sync under way,
   * putting it in Dropbox first if it is on this device only. "Syncing…"
   * shows meanwhile. While Dropbox changes under it, it syncs again at once,
   * up to SAVE_TRIES syncs. Rejects with the reason when it can't; a project in
   * Dropbox whose account isn't connected here ends signed out.
   */
  const saveToDropbox = useCallback(async (): Promise<void> => {
    for (let tries = 1; ; tries += 1) {
      let again = false;
      await runAsked(
        async (dropbox, root) => {
          const result = await dropbox.sync(root);
          const outcome = result.state === "off" ? await dropbox.putProject(root) : result.state === "done" ? result.outcome : result.state;
          again = typeof outcome === "object" && outcome.again;
          return outcome;
        },
        "The project can’t be saved to Dropbox until its changes are saved on this device. Save them (Retry) first.",
        true,
      );
      // Dropbox changed under the sync: the save isn't finished, so it goes again now, while the writer waits for it.
      if (!again || tries >= SAVE_TRIES) return;
    }
  }, [runAsked]);

  // A project in Dropbox syncs when it opens, when the app comes back to the
  // front, and every SYNC_INTERVAL_MS while it is in front, unless automatic
  // syncs are off. Turned on, they start with a sync at once.
  const openRoot = project?.root ?? null;
  useEffect(() => {
    if (!backend?.dropbox || openRoot === null || !autoSync) return;
    void syncNowRef.current();
    const inFront = () => {
      if (document.visibilityState === "visible") void syncNowRef.current();
    };
    const every = setInterval(inFront, SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", inFront);
    window.addEventListener("focus", inFront);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", inFront);
      window.removeEventListener("focus", inFront);
    };
  }, [backend, openRoot, autoSync]);

  // Turned off, changes made since the last sync wait for the writer, who is told.
  useEffect(() => {
    if (!autoSync && changedSinceSync.current) setSync(withUnsent);
  }, [autoSync]);

  /**
   * The writer has seen the files edited on two devices: they are no longer
   * reported, until a sync finds new ones.
   */
  const dismissConflicts = useCallback(() => {
    conflicts.current = [];
    setSync((state) => (state.status === "synced" && state.conflicts.length > 0 ? { ...state, conflicts: [] } : state));
  }, []);

  /**
   * Sets how a sync puts new text in the open chapter's editor (its
   * setMarkdown: one undo step, the caret kept); null when there is no
   * editor. Without it, the editor is remounted on the new text.
   */
  const setEditorWriter = useCallback((writer: ((markdown: string) => boolean) | null) => {
    editorWriter.current = writer;
  }, []);

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

  /**
   * Sets what decides whether the window may close, in place of `mayClose`
   * (the workspace's close dialog, in the desktop app); null goes back to
   * `mayClose`.
   */
  const setCloseHandler = useCallback((handler: (() => Promise<boolean>) | null) => {
    closeHandler.current = handler;
  }, []);

  // Finish pending saves before the window closes (see mayClose) or goes to the background.
  useEffect(() => {
    if (!backend) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    backend.onCloseRequested(() => (closeHandler.current ?? mayClose)()).then((stop) => {
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
    noteChange();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (autosaveHold.current) autosaveHold.current.due = true;
    else timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  }, [flush, noteChange]);

  /**
   * Stops autosave until the returned function is called, which starts it
   * again if a save was due meanwhile. For the close dialog: the edits wait
   * while the writer chooses whether to save them. A save already being
   * written finishes; `saveNow` still writes at once.
   */
  const holdAutosave = useCallback((): (() => void) => {
    const hold = { due: timer.current !== null };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    autosaveHold.current = hold;
    return () => {
      if (autosaveHold.current !== hold) return;
      autosaveHold.current = null;
      if (hold.due && pending.current.size > 0 && timer.current === null) {
        timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
      }
    };
  }, [flush]);

  /**
   * Drops the edits not written yet, for Close without saving: the window
   * closes next. They stay on screen, but are no longer waiting to be saved.
   */
  const discardPending = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current.clear();
  }, []);

  /** Whether some edits are not written yet: waiting, or kept after a failed save. */
  const hasUnsaved = useCallback(() => pending.current.size > 0, []);

  const updateChapter = useCallback((id: string, markdown: string) => {
    const current = projectRef.current;
    if (!current || switchingRef.current) return;
    const text = withFinalNewline(markdown);
    const next = withChapterText(current, id, text);
    if (next === current) return;
    changeLater(next, id, text);
    // The first edit after opening a chapter checks for changes from other devices, when syncs run by themselves.
    if (id === openRef.current && !checkedOpen.current && autoSyncRef.current) {
      checkedOpen.current = true;
      void syncNowRef.current();
    }
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
      noteChange();
    }
    return id;
  }, [noteChange]);

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

  /**
   * Sets the project's language, saved in project.json like an edit; the
   * spelling, grammar and typography follow at once. Throws, changing
   * nothing, when the code isn't one or project.json could not be read.
   */
  const setLanguage = useCallback((code: string) => changeJson((p) => withLanguage(p, code)), [changeJson]);

  /**
   * Saves export settings as the project's preset `name`, in project.json
   * like an edit. Throws, changing nothing, for an empty or built-in name,
   * or when project.json could not be read.
   */
  const saveExportPreset = useCallback(
    (name: string, settings: ExportSettings) => changeJson((p) => withExportPreset(p, name, settings)),
    [changeJson],
  );

  /** Remembers the last export's settings, format, preset and author in project.json, for the next one. */
  const rememberExport = useCallback(
    (choice: { format: ExportFormat; settings: ExportSettings; author: string }, presetName: string | null) =>
      changeJson((p) => withExportChoice(p, choice, presetName)),
    [changeJson],
  );

  /**
   * Adds a word to the project's dictionary.txt, which the spelling check
   * accepts, saved like an edit: the word is accepted at once. Does nothing
   * for a word already there. Throws, changing nothing, when dictionary.txt
   * couldn't be read: writing it would replace what it holds.
   */
  const addToDictionary = useCallback(
    (word: string) => {
      const current = projectRef.current;
      const key = spellingKey(word.trim());
      if (!current || switchingRef.current || key === "" || current.dictionary.includes(key)) return;
      if (current.dictionaryProblem) throw new Error(current.dictionaryProblem);
      const text = withWordAdded(current.dictionaryText, word.trim());
      changeLater({ ...current, dictionaryText: text, dictionary: [...current.dictionary, key] }, DICTIONARY_FILE, text);
    },
    [changeLater],
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
        if (snapshot) {
          applySnapshot(snapshot, target, { openId });
          noteChange();
        }
      }
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [flush, applySnapshot, noteChange]);

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

  /** The projects in the connected Dropbox; empty without Dropbox. */
  const listDropboxProjects = useCallback(async (): Promise<DropboxProject[]> => {
    const dropbox = backendRef.current?.dropbox;
    return dropbox ? dropbox.projects(readRecentProjects()) : [];
  }, []);

  /**
   * Opens a project from Dropbox (see `switchProject`): its copy on this
   * device, or else a copy downloaded first.
   */
  const openFromDropbox = useCallback(
    (folder: string): Promise<void> =>
      switchProject((t) => {
        if (!t.dropbox) throw new Error("This build of the app has no Dropbox connection.");
        return t.dropbox.openProject(folder, readRecentProjects());
      }),
    [switchProject],
  );

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
      noteChange();
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, [flush, noteChange]);

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
    setCloseHandler,
    holdAutosave,
    discardPending,
    hasUnsaved,
    openFolder,
    openProjectAt,
    createProject,
    listProjects,
    listDropboxProjects,
    openFromDropbox,
    updateChapterDetails,
    createSheet,
    updateSheet,
    ignoreName,
    markNotName,
    addToDictionary,
    setLanguage,
    saveExportPreset,
    rememberExport,
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
    /** How the open project stands with Dropbox. */
    sync,
    /** Syncs the open project with Dropbox now, if it is there. */
    syncNow,
    putInDropbox,
    /** Save to Dropbox, from the main menu: syncs now, putting the project there first if it isn't. */
    saveToDropbox,
    setEditorWriter,
    dismissConflicts,
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
