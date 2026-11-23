import { Check, ChevronDown, FolderOpen, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { APP_VERSION, PRIVACY_POLICY_URL } from "../core/about";
import { defaultLanguage, LANGUAGES, type ProjectEntry } from "../core/projects";
import { BottomSheet } from "./BottomSheet";
import { cx, errorMessage } from "./dom";
import { Popover, type CloseReason } from "./Popover";

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

/**
 * The project title at the top of the binder. It keeps the heading's look
 * and opens the Projects view: a dialog under it on desktop (Escape or a
 * click outside closes it), a sheet from the bottom on phones. The view
 * closes once a project has been opened from it, and stays open while that
 * is under way.
 */
export function ProjectsButton({ title, source }: { title: string; source: ProjectsSource }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const viewId = useId();
  const headingId = useId();
  /** `loads` when the view opened; null while it is closed. */
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  /** Counts openings: each one mounts a fresh view, which lists the projects again. */
  const [openings, setOpenings] = useState(0);
  /** An open or a create is under way: the view can't be closed until it ends. */
  const pending = useRef(false);
  const open = openedAt !== null;
  const { loads, phone } = source;

  const focusTitle = () => trigger.current?.focus({ preventScroll: true });

  const close = () => {
    if (pending.current) return;
    setOpenedAt(null);
    focusTitle();
  };

  // A project was opened from the view: it has done its job.
  useEffect(() => {
    if (openedAt === null || loads === openedAt) return;
    setOpenedAt(null);
    trigger.current?.focus({ preventScroll: true });
  }, [loads, openedAt]);

  // The window crossed the phone breakpoint: the dialog and the sheet aren't
  // interchangeable, so the view closes rather than jump between them.
  const [layout, setLayout] = useState(phone);
  if (layout !== phone) {
    setLayout(phone);
    setOpenedAt(null);
  }

  const onPopoverClose = (reason: CloseReason) => {
    if (pending.current) return;
    setOpenedAt(null);
    if (reason === "escape") {
      focusTitle();
    } else {
      // A click outside: focus goes where it was put, or back to the title if it went nowhere.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) focusTitle();
      });
    }
  };

  const view = (
    <ProjectsView
      key={openings}
      source={source}
      headingId={headingId}
      onClose={phone ? close : undefined}
      onPendingChange={(busy) => {
        pending.current = busy;
      }}
    />
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="binder-title-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? viewId : undefined}
        title="Projects"
        onClick={() => {
          if (open) {
            close();
            return;
          }
          setOpenings((n) => n + 1);
          setOpenedAt(loads);
        }}
      >
        {title}
        <ChevronDown className="chevron" aria-hidden />
      </button>
      {phone ? (
        <BottomSheet
          id={viewId}
          open={open}
          onClose={close}
          labelledBy={headingId}
          closeLabel="Close projects"
          className="bottom-sheet--fit"
          overPanels
        >
          {openings > 0 && view}
        </BottomSheet>
      ) : (
        open && (
          <Popover
            anchor={trigger}
            ignore={trigger}
            id={viewId}
            role="dialog"
            label="Projects"
            className="projects-popover"
            onClose={onPopoverClose}
          >
            {view}
          </Popover>
        )
      )}
    </>
  );
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; projects: ProjectEntry[] }
  | { status: "error"; message: string };

/** The action under way, shown on the control that started it. */
type Pending = { kind: "open"; path: string } | { kind: "folder" } | { kind: "create" };

/**
 * Where a failure shows: under a project's row ("project:" and its path), under Open folder
 * ("folder"), or under the form: a project that couldn't be created
 * ("create"), or a missing title ("title", which marks the field).
 */
interface Failure {
  at: string;
  message: string;
}

const SKELETON_ROWS = ["medium", "short", "long"] as const;

const FOLDER = "folder";
const CREATE = "create";
const TITLE = "title";
const rowKey = (path: string) => `project:${path}`;

interface ProjectsViewProps {
  source: ProjectsSource;
  headingId: string;
  /** Phones: the sheet's close button. The desktop dialog has none: Escape or a click outside close it. */
  onClose?: () => void;
  onPendingChange(busy: boolean): void;
}

/** True when focus went nowhere, for example with a button that was disabled. */
const focusLost = () => document.activeElement === null || document.activeElement === document.body;

/**
 * The projects on this device, the open one marked; Open folder… where
 * there is a folder picker; and a new project's title and language, with
 * Create as the view's one primary action. A failure shows by the control
 * that failed, and what was typed stays.
 */
function ProjectsView({ source, headingId, onClose, onPendingChange }: ProjectsViewProps) {
  const { list, current, canCreate, openFolder } = source;
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState(() => defaultLanguage(navigator.languages));
  const root = useRef<HTMLDivElement>(null);
  const ids = useId();
  const locked = source.busy || pending !== null;
  const desktop = onClose === undefined;

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

  // Desktop: focus starts on the view, and moves to the first project that
  // can be opened once the list is in, unless it has been moved meanwhile.
  // Phones focus the sheet's close button instead (BottomSheet), so no
  // keyboard pops up.
  useEffect(() => {
    if (desktop) root.current?.focus({ preventScroll: true });
  }, [desktop]);

  useEffect(() => {
    if (!desktop || state.status !== "ready" || document.activeElement !== root.current) return;
    root.current?.querySelector<HTMLElement>(".projects-list button:not(:disabled)")?.focus({ preventScroll: true });
  }, [desktop, state]);

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

  const errorId = (at: string) => `${ids}-error-${at.startsWith("project:") ? "row" : at}`;
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
              {pending?.kind === "open" && pending.path === entry.path && (
                <span className="project-state">Opening…</span>
              )}
            </>
          );
          return (
            <li key={entry.path}>
              {isOpen ? (
                <div className="project-row is-open">
                  {content}
                  <span className="visually-hidden">, open now</span>
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
              {failureAt(key, "project-error")}
            </li>
          );
        })}
      </ul>
    );
  }

  const status =
    pending?.kind === "create" ? "Creating the project…" : pending ? "Opening the project…" : "";

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
            data-autofocus
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

      {canCreate ? (
        <form className="new-project" aria-labelledby={`${ids}-new`} noValidate onSubmit={onCreate}>
          <h3 id={`${ids}-new`} className="section-label">
            New project
          </h3>
          <div className="new-project-fields">
            <label htmlFor={`${ids}-title`}>Title</label>
            <input
              id={`${ids}-title`}
              className="input"
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
