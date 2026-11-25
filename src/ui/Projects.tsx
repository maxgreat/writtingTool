import { Check, ChevronDown, CloudDownload, CloudUpload, FolderOpen, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent, type RefObject } from "react";
import { APP_VERSION, PRIVACY_POLICY_URL } from "../core/about";
import type { DropboxProject } from "../core/backend";
import { defaultLanguage, LANGUAGES, type ProjectEntry } from "../core/projects";
import { BottomSheet } from "./BottomSheet";
import { cx, errorMessage, focusLost, revealIn } from "./dom";
import { Popover, type CloseReason } from "./Popover";

/** What the Projects view needs for Dropbox, where the build has it. */
export interface ProjectsDropbox {
  /** Whether an account is connected on this device (useDropbox's view); "checking" while that is read. */
  connection: "checking" | "connected" | "none";
  /** useProject's putInDropbox: puts the open project in Dropbox. Rejects with the reason. */
  put(): Promise<void>;
  /** useProject's listDropboxProjects. */
  list(): Promise<DropboxProject[]>;
  /** useProject's openFromDropbox: downloads a project not on this device, then opens it. */
  open(folder: string): Promise<void>;
}

/** What the Projects view needs from useProject and the backend. */
export interface ProjectsSource {
  /** The open project's folder (its `root`), to mark it in the list. */
  current: string;
  /** useProject's `loads`: it goes up once a project has been opened, which closes the view. */
  loads: number;
  /** useProject's listProjects. */
  list(): Promise<ProjectEntry[]>;
  /** useProject's openProjectAt. */
  open(path: string): Promise<void>;
  /** useProject's createProject. */
  create(title: string, language: string): Promise<void>;
  /** useProject's openFolder; absent where there is no folder picker (phones, the browser preview). */
  openFolder?: () => Promise<void>;
  /** False in the browser preview, which only has the sample project. */
  canCreate: boolean;
  /** The backend's openUrl, for the privacy policy; absent in the browser preview, where the link opens a new tab. */
  openUrl?: (url: string) => Promise<void>;
  /** The project on disk is changing (useProject's `switching`): nothing can be opened until it has. */
  busy: boolean;
  /** Phones get a sheet from the bottom instead of a dialog under the title. */
  phone: boolean;
  /** Dropbox; absent where the build has none, and in the browser preview. */
  dropbox?: ProjectsDropbox;
}

/** The last part of a folder path, whichever separator it uses. */
export function folderName(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? path;
}

/**
 * The quiet line under a project's title, or null: the folder of a project
 * opened from elsewhere, and the folder name of one in the app's folder whose
 * title another project has too, so the two can be told apart.
 */
export function projectDetail(entry: ProjectEntry, all: readonly ProjectEntry[]): string | null {
  if (!entry.inAppFolder) return entry.path;
  return all.some((other) => other !== entry && other.title === entry.title) ? folderName(entry.path) : null;
}

/** Why the Projects view opens: to open a project (its list first), or to make one (its form, ready for a title). */
export type ProjectsIntent = "open" | "new";

/** Where the Projects view was opened from. */
export interface ProjectsOrigin {
  /** The control the desktop dialog hangs from; focus goes back to it when the view closes. */
  anchor: RefObject<HTMLElement | null>;
  /** Where focus goes instead when the view closes: back to the text after a shortcut, say. */
  returnFocus?: () => void;
}

interface Opened extends ProjectsOrigin {
  /** `loads` when the view opened: once it goes up, a project has been opened and the view closes. */
  loads: number;
}

/**
 * The one Projects view of the window, and what opens it: the project
 * title in the binder, the main menu and its shortcut. Made by
 * useProjectsDialog; ProjectsDialog shows it.
 */
export interface ProjectsDialogControl {
  source: ProjectsSource;
  /** The view's id, for its triggers' aria-controls. */
  id: string;
  /** Where the open view came from; null while it is closed. */
  opened: Opened | null;
  /**
   * Opens the view. While it is open it stays as it is, unless it was
   * opened for the other intent, which it then opens afresh for. Nothing
   * happens while an open or a create is under way.
   */
  show(intent: ProjectsIntent, origin: ProjectsOrigin): void;
  /** Closes the view, unless an open or a create is under way, and gives focus back. */
  close(): void;
  /** For ProjectsDialog: what this opening is for, and its count, so each opening mounts a fresh view. */
  view: { intent: ProjectsIntent; openings: number };
  /** For ProjectsDialog: an open or a create started or ended in the view. */
  setPending(pending: boolean): void;
  /** For ProjectsDialog: the desktop dialog closed by itself (Escape, a press outside). */
  dismiss(reason: CloseReason): void;
}

/**
 * The Projects view's state: open or closed, why, and from where. The view
 * closes once a project has been opened from it, stays open while that is
 * under way, and closes when the window crosses the phone breakpoint.
 */
export function useProjectsDialog(source: ProjectsSource): ProjectsDialogControl {
  const id = useId();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [view, setView] = useState<{ intent: ProjectsIntent; openings: number }>({ intent: "open", openings: 0 });
  /** An open or a create is under way: the view can't be closed until it ends. */
  const pending = useRef(false);
  const { loads, phone } = source;

  const giveFocusBack = (from: Opened) => {
    if (from.returnFocus) from.returnFocus();
    else from.anchor.current?.focus({ preventScroll: true });
  };

  const close = () => {
    if (pending.current || opened === null) return;
    setOpened(null);
    giveFocusBack(opened);
  };

  const show = (intent: ProjectsIntent, origin: ProjectsOrigin) => {
    if (pending.current || (opened !== null && view.intent === intent)) return;
    setView((v) => ({ intent, openings: v.openings + 1 }));
    setOpened({ ...origin, loads });
  };

  // A project was opened from the view: it has done its job.
  useEffect(() => {
    if (opened === null || loads === opened.loads) return;
    setOpened(null);
    giveFocusBack(opened);
  }, [loads, opened]);

  // The window crossed the phone breakpoint: the dialog and the sheet aren't
  // interchangeable, so the view closes rather than jump between them.
  const [layout, setLayout] = useState(phone);
  if (layout !== phone) {
    setLayout(phone);
    setOpened(null);
  }

  const dismiss = (reason: CloseReason) => {
    if (pending.current || opened === null) return;
    setOpened(null);
    if (reason === "escape") {
      giveFocusBack(opened);
    } else {
      // A click outside: focus goes where it was put, or back where the view came from if it went nowhere.
      requestAnimationFrame(() => {
        if (focusLost()) giveFocusBack(opened);
      });
    }
  };

  const setPending = (busy: boolean) => {
    pending.current = busy;
  };

  return { source, id, opened, show, close, view, setPending, dismiss };
}

/**
 * The project title at the top of the binder. It keeps the heading's look
 * and opens the Projects view at its list.
 */
export function ProjectsButton({ title, dialog }: { title: string; dialog: ProjectsDialogControl }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const open = dialog.opened?.anchor === trigger;
  return (
    <button
      ref={trigger}
      type="button"
      className="binder-title-button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? dialog.id : undefined}
      title="Projects"
      onClick={() => (open ? dialog.close() : dialog.show("open", { anchor: trigger }))}
    >
      {title}
      <ChevronDown className="chevron" aria-hidden />
    </button>
  );
}

/**
 * The Projects view: a dialog under the control that opened it on desktop
 * (Escape or a click outside closes it), a sheet from the bottom on phones.
 */
export function ProjectsDialog({ dialog }: { dialog: ProjectsDialogControl }) {
  const headingId = useId();
  const { source, opened, view: current } = dialog;
  const { phone } = source;

  const view = (
    <ProjectsView
      key={current.openings}
      source={source}
      intent={current.intent}
      headingId={headingId}
      onClose={phone ? dialog.close : undefined}
      onPendingChange={dialog.setPending}
    />
  );

  if (phone) {
    return (
      <BottomSheet
        id={dialog.id}
        open={opened !== null}
        onClose={dialog.close}
        labelledBy={headingId}
        closeLabel="Close projects"
        className="bottom-sheet--fit"
        overPanels
      >
        {current.openings > 0 && view}
      </BottomSheet>
    );
  }
  return (
    opened && (
      <Popover
        anchor={opened.anchor}
        ignore={opened.anchor}
        id={dialog.id}
        role="dialog"
        label="Projects"
        className="projects-popover"
        onClose={dialog.dismiss}
      >
        {view}
      </Popover>
    )
  );
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; projects: ProjectEntry[] }
  | { status: "error"; message: string };

/** The projects in Dropbox that aren't on this device. */
type CloudState =
  | { status: "loading" }
  | { status: "ready"; projects: DropboxProject[] }
  | { status: "error"; message: string };

/** The action under way, shown on the control that started it. */
type Pending =
  | { kind: "open"; path: string }
  | { kind: "folder" }
  | { kind: "create" }
  | { kind: "put" }
  | { kind: "download"; folder: string };

/**
 * Where a failure shows: under a project's row ("project:" and its path), under Open folder
 * ("folder"), under the open project's Put in Dropbox ("put"), under a
 * project in Dropbox ("dropbox:" and its folder), or under the form: a
 * project that couldn't be created ("create"), or a missing title
 * ("title", which marks the field).
 */
interface Failure {
  at: string;
  message: string;
}

const SKELETON_ROWS = ["medium", "short", "long"] as const;
const CLOUD_SKELETON_ROWS = ["medium", "short"] as const;

const FOLDER = "folder";
const CREATE = "create";
const TITLE = "title";
const PUT = "put";
const rowKey = (path: string) => `project:${path}`;
const cloudKey = (folder: string) => `dropbox:${folder}`;

/** A project in Dropbox whose title another one there has too gets its folder's name, so the two can be told apart. */
function cloudDetail(entry: DropboxProject, all: readonly DropboxProject[]): string | null {
  return all.some((other) => other !== entry && other.title === entry.title) ? folderName(entry.folder) : null;
}

interface ProjectsViewProps {
  source: ProjectsSource;
  /** "new" starts in the new project's title field, where projects can be created. */
  intent: ProjectsIntent;
  headingId: string;
  /** Phones: the sheet's close button. The desktop dialog has none: Escape or a click outside close it. */
  onClose?: () => void;
  onPendingChange(busy: boolean): void;
}

/**
 * The projects on this device, the open one marked; Open folder… where
 * there is a folder picker; and a new project's title and language, with
 * Create as the view's one primary action. A failure shows by the control
 * that failed, and what was typed stays.
 *
 * With Dropbox connected, projects there are marked, the open project can
 * be put there, and the projects there that aren't on this device are
 * listed, to download and open. Not connected, one line says where to
 * connect it.
 */
function ProjectsView({ source, intent, headingId, onClose, onPendingChange }: ProjectsViewProps) {
  const { list, current, canCreate, openFolder, dropbox } = source;
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [cloud, setCloud] = useState<CloudState>({ status: "loading" });
  const [cloudAttempt, setCloudAttempt] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** What an action that went through left to say, for screen readers: the open project is in Dropbox now. */
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState(() => defaultLanguage(navigator.languages));
  const root = useRef<HTMLDivElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const ids = useId();
  const locked = source.busy || pending !== null;
  const desktop = onClose === undefined;
  /** Opened for a new project, where one can be made: focus starts in its title field. */
  const startInForm = intent === "new" && canCreate;

  useEffect(() => {
    let live = true;
    list().then(
      (projects) => live && setState({ status: "ready", projects }),
      (error: unknown) => live && setState({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [list, attempt]);

  // The projects in Dropbox, once an account is connected: those not on this device are offered.
  const connection = dropbox?.connection;
  const listCloud = dropbox?.list;
  useEffect(() => {
    if (connection !== "connected" || !listCloud) return;
    let live = true;
    listCloud().then(
      (projects) => live && setCloud({ status: "ready", projects: projects.filter((p) => p.local === null) }),
      (error: unknown) => live && setCloud({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [connection, listCloud, cloudAttempt]);

  // Desktop: focus starts on the view, and moves to the first project that
  // can be opened once the list is in, unless it has been moved meanwhile.
  // Phones focus the sheet's close button instead (BottomSheet), so no
  // keyboard pops up. Opened for a new project, focus starts in its title
  // field on both (the sheet focuses what is marked data-autofocus).
  useEffect(() => {
    if (!desktop) return;
    const field = titleField.current;
    if (startInForm && field) {
      field.focus({ preventScroll: true });
      // The dialog scrolls when the window is short: the field comes into view.
      const box = root.current?.parentElement;
      if (box) revealIn(box, field);
    } else {
      root.current?.focus({ preventScroll: true });
    }
  }, [desktop, startInForm]);

  // Only as the list comes in, not when it is read again in place (after Put in Dropbox).
  const listed = useRef(false);
  useEffect(() => {
    if (state.status !== "ready") {
      listed.current = false;
      return;
    }
    if (listed.current) return;
    listed.current = true;
    if (!desktop || document.activeElement !== root.current) return;
    root.current?.querySelector<HTMLElement>(".projects-list button.project-row:not(:disabled)")?.focus({ preventScroll: true });
  }, [desktop, state]);

  // Put in Dropbox went through and its button is gone: focus rests on the view.
  useEffect(() => {
    if (notice !== "" && focusLost()) root.current?.focus({ preventScroll: true });
  }, [notice]);

  // A failed action: focus goes back to its control if it went nowhere while that was disabled.
  useEffect(() => {
    if (!failure || !focusLost()) return;
    const controls = root.current?.querySelectorAll<HTMLElement>("[data-action]") ?? [];
    [...controls].find((el) => el.dataset.action === failure.at)?.focus({ preventScroll: true });
  }, [failure]);

  const run = async (next: Pending, at: string, action: () => Promise<void>) => {
    if (locked) return;
    setPending(next);
    setFailure(null);
    setNotice("");
    onPendingChange(true);
    try {
      await action();
    } catch (error) {
      setFailure({ at, message: errorMessage(error) });
    } finally {
      setPending(null);
      onPendingChange(false);
    }
  };

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    if (title.trim() === "") {
      setFailure({ at: TITLE, message: "Give the project a title." });
      return;
    }
    void run({ kind: "create" }, CREATE, () => source.create(title, language));
  };

  /**
   * Put in Dropbox: the open project goes there and its first sync runs.
   * Once it has, the project is marked at once and the list is read again
   * in place.
   */
  const putInDropbox = (put: () => Promise<void>, projectTitle: string) =>
    run({ kind: "put" }, PUT, async () => {
      await put();
      setState((s) =>
        s.status === "ready"
          ? { ...s, projects: s.projects.map((p) => (p.path === current ? { ...p, inDropbox: true } : p)) }
          : s,
      );
      setAttempt((n) => n + 1);
      setNotice(`${projectTitle} is in Dropbox now.`);
    });

  const errorId = (at: string) => `${ids}-error-${at.startsWith("project:") || at.startsWith("dropbox:") ? "row" : at}`;
  const failureAt = (at: string, className?: string) =>
    failure?.at === at ? (
      <p id={errorId(at)} className={cx("inline-error", className)} role="alert">
        {failure.message}
      </p>
    ) : null;
  const describedBy = (at: string) => (failure?.at === at ? errorId(at) : undefined);

  let projects;
  if (state.status === "loading") {
    projects = (
      <ul className="projects-list" aria-hidden>
        {SKELETON_ROWS.map((width, i) => (
          <li key={i} className="project-row">
            <span className="check-slot" />
            <span className={`skeleton skeleton--${width}`} />
          </li>
        ))}
      </ul>
    );
  } else if (state.status === "error") {
    projects = (
      <div className="projects-error">
        <p className="inline-error" role="alert">
          {state.message}
        </p>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            // The button goes with the message: focus waits on the view for the list.
            root.current?.focus({ preventScroll: true });
            setState({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  } else if (state.projects.length === 0) {
    projects = <p className="empty-note">No projects on this device yet.</p>;
  } else {
    projects = (
      <ul className="projects-list">
        {state.projects.map((entry) => {
          const isOpen = entry.path === current;
          const key = rowKey(entry.path);
          const detail = projectDetail(entry, state.projects);
          const opening = pending?.kind === "open" && pending.path === entry.path;
          const inDropbox = dropbox !== undefined && entry.inDropbox === true;
          const content = (
            <>
              <span className="check-slot" aria-hidden>
                {isOpen && <Check className="check" />}
              </span>
              <span className="project-text">
                <span className="project-title">{entry.title}</span>
                {detail && (
                  <span className="project-detail" title={detail}>
                    <span className="path">{detail}</span>
                  </span>
                )}
              </span>
              {opening ? (
                <span className="project-state">Opening…</span>
              ) : (
                inDropbox && (
                  <>
                    <span className="project-state" aria-hidden>
                      Dropbox
                    </span>
                    <span className="visually-hidden">, in Dropbox</span>
                  </>
                )
              )}
            </>
          );
          // The open project, not in Dropbox yet, can be put there once an account is connected.
          const put = isOpen && !inDropbox && connection === "connected" ? dropbox?.put : undefined;
          return (
            <li key={entry.path}>
              {isOpen ? (
                <div className="project-row is-open">
                  {content}
                  <span className="visually-hidden">, open now</span>
                  {put && (
                    <button
                      type="button"
                      className="btn project-put"
                      data-action={PUT}
                      disabled={locked}
                      aria-busy={pending?.kind === "put" || undefined}
                      aria-describedby={describedBy(PUT)}
                      onClick={() => void putInDropbox(put, entry.title)}
                    >
                      <CloudUpload aria-hidden />
                      {pending?.kind === "put" ? "Putting in Dropbox…" : "Put in Dropbox"}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="project-row"
                  data-action={key}
                  disabled={locked}
                  aria-describedby={describedBy(key)}
                  onClick={() => void run({ kind: "open", path: entry.path }, key, () => source.open(entry.path))}
                >
                  {content}
                </button>
              )}
              {failureAt(isOpen ? PUT : key, "project-error")}
            </li>
          );
        })}
      </ul>
    );
  }

  let inCloud = null;
  if (dropbox && connection === "connected") {
    let content;
    if (cloud.status === "loading") {
      content = (
        <ul className="projects-list" aria-hidden>
          {CLOUD_SKELETON_ROWS.map((width, i) => (
            <li key={i} className="project-row">
              <span className="check-slot" />
              <span className={`skeleton skeleton--${width}`} />
            </li>
          ))}
        </ul>
      );
    } else if (cloud.status === "error") {
      content = (
        <div className="projects-error">
          <p id={`${ids}-cloud-error`} className="inline-error" role="alert">
            {cloud.message}
          </p>
          <button
            type="button"
            className="btn btn--quiet"
            aria-describedby={`${ids}-cloud-error`}
            onClick={() => {
              // The button goes with the message: focus waits on the view for the list.
              root.current?.focus({ preventScroll: true });
              setCloud({ status: "loading" });
              setCloudAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      );
    } else if (cloud.projects.length === 0) {
      content = <p className="empty-note">No other projects in your Dropbox.</p>;
    } else {
      content = (
        <ul className="projects-list projects-list--cloud">
          {cloud.projects.map((entry) => {
            const key = cloudKey(entry.folder);
            const detail = cloudDetail(entry, cloud.projects);
            return (
              <li key={entry.folder}>
                <button
                  type="button"
                  className="project-row"
                  data-action={key}
                  disabled={locked}
                  aria-describedby={describedBy(key)}
                  onClick={() =>
                    void run({ kind: "download", folder: entry.folder }, key, () => dropbox.open(entry.folder))
                  }
                >
                  <span className="check-slot" aria-hidden>
                    <CloudDownload />
                  </span>
                  <span className="project-text">
                    <span className="project-title">{entry.title}</span>
                    {detail && (
                      <span className="project-detail" title={detail}>
                        <span className="path">{detail}</span>
                      </span>
                    )}
                  </span>
                  {pending?.kind === "download" && pending.folder === entry.folder && (
                    <span className="project-state">Downloading…</span>
                  )}
                </button>
                {failureAt(key, "project-error")}
              </li>
            );
          })}
        </ul>
      );
    }
    inCloud = (
      <div className="projects-cloud" role="group" aria-labelledby={`${ids}-cloud`} aria-busy={cloud.status === "loading"}>
        <h3 id={`${ids}-cloud`} className="section-label">
          In your Dropbox
        </h3>
        {content}
      </div>
    );
  } else if (dropbox && connection === "none") {
    inCloud = (
      <p className="projects-note muted">
        To keep projects in Dropbox and open them on your other devices, connect Dropbox in Settings.
      </p>
    );
  }

  const status =
    pending?.kind === "create"
      ? "Creating the project…"
      : pending?.kind === "put"
        ? "Putting the project in Dropbox…"
        : pending?.kind === "download"
          ? "Downloading the project…"
          : pending
            ? "Opening the project…"
            : notice;

  return (
    <div
      ref={root}
      className={cx("projects", !desktop && "projects--sheet")}
      tabIndex={-1}
      aria-busy={state.status === "loading" || pending !== null}
    >
      {desktop ? (
        <h2 id={headingId} className="popover-title">
          Projects
        </h2>
      ) : (
        <div className="projects-head">
          <h2 id={headingId} className="projects-heading">
            Projects
          </h2>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Close"
            data-autofocus={startInForm ? undefined : true}
            disabled={pending !== null}
            onClick={onClose}
          >
            <X aria-hidden />
          </button>
        </div>
      )}

      <div className="projects-choices">
        {projects}
        {openFolder && (
          <>
            <button
              type="button"
              className="project-row project-row--action"
              data-action={FOLDER}
              disabled={locked}
              aria-describedby={describedBy(FOLDER)}
              onClick={() => void run({ kind: "folder" }, FOLDER, openFolder)}
            >
              <span className="check-slot" aria-hidden>
                <FolderOpen />
              </span>
              <span className="project-text">{pending?.kind === "folder" ? "Opening…" : "Open folder…"}</span>
            </button>
            {failureAt(FOLDER, "project-error")}
          </>
        )}
      </div>

      {inCloud}

      {canCreate ? (
        <form className="new-project" aria-labelledby={`${ids}-new`} noValidate onSubmit={onCreate}>
          <h3 id={`${ids}-new`} className="section-label">
            New project
          </h3>
          <div className="new-project-fields">
            <label htmlFor={`${ids}-title`}>Title</label>
            <input
              ref={titleField}
              id={`${ids}-title`}
              className="input"
              data-autofocus={startInForm || undefined}
              value={title}
              readOnly={locked}
              aria-invalid={failure?.at === TITLE}
              aria-describedby={describedBy(TITLE)}
              enterKeyHint="done"
              autoComplete="off"
              onChange={(event) => {
                setTitle(event.target.value);
                if (failure?.at === TITLE || failure?.at === CREATE) setFailure(null);
              }}
            />
            <label htmlFor={`${ids}-language`}>Language</label>
            <span className="select">
              <select
                id={`${ids}-language`}
                className="input"
                value={language}
                disabled={locked}
                onChange={(event) => setLanguage(event.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="chevron" aria-hidden />
            </span>
          </div>
          <div className="new-project-actions">
            <button
              type="submit"
              className="btn btn--primary"
              data-action={CREATE}
              disabled={locked}
              aria-describedby={describedBy(CREATE)}
            >
              {pending?.kind === "create" ? "Creating…" : "Create"}
            </button>
          </div>
          {failureAt(TITLE)}
          {failureAt(CREATE)}
        </form>
      ) : (
        <p className="projects-note muted">The browser preview only has the sample project.</p>
      )}

      <AboutLine openUrl={source.openUrl} />

      {/* Present before an action starts, so screen readers announce it. */}
      <p className="visually-hidden" role="status">
        {status}
      </p>
    </div>
  );
}

/** The privacy link: at rest, being opened in the system browser, or failed to open. */
type LinkState = "idle" | "opening" | "failed";

/**
 * The view's last line, quiet: the app's version and its privacy policy,
 * which belong to the app rather than to a project. In the app the link
 * opens in the system browser (openUrl); if that fails, the address shows so
 * it can be typed there. In the browser preview it is a plain link that
 * opens a new tab.
 */
function AboutLine({ openUrl }: { openUrl?: (url: string) => Promise<void> }) {
  const [link, setLink] = useState<LinkState>("idle");
  /** Set at once on a click, so a second click can't open the page twice. */
  const opening = useRef(false);
  const errorId = useId();

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // The browser preview: the link opens a new tab by itself.
    if (!openUrl) return;
    // The app: the page opens through openUrl only. A prevented click is also
    // left alone by the opener plugin's own script for links.
    event.preventDefault();
    if (opening.current) return;
    opening.current = true;
    setLink("opening");
    openUrl(PRIVACY_POLICY_URL)
      .then(
        () => setLink("idle"),
        (error: unknown) => {
          console.error("Cannot open the privacy policy", error);
          setLink("failed");
        },
      )
      .finally(() => {
        opening.current = false;
      });
  };

  return (
    <div className="projects-about">
      <p className="projects-about-line">
        <span>
          Version <span className="num">{APP_VERSION}</span>
        </span>
        <span aria-hidden>·</span>
        <a
          className="text-link"
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noreferrer"
          aria-disabled={link === "opening" || undefined}
          aria-describedby={link === "failed" ? errorId : undefined}
          onClick={onClick}
        >
          Privacy policy
        </a>
      </p>
      {link === "failed" && (
        <div id={errorId} className="projects-about-error" role="alert">
          <p className="inline-error">Couldn’t open the browser. The privacy policy is at this address:</p>
          <p className="path">{PRIVACY_POLICY_URL}</p>
        </div>
      )}
    </div>
  );
}
