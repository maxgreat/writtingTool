import { ArrowRight, ChevronDown, Plus, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { PRIVACY_POLICY_URL } from "../core/about";
import { LANGUAGES } from "../core/projects";
import {
  MAX_REPLACEMENTS,
  type LanguageToolMode,
  type LanguageToolSettings,
  type Theme,
  type ViewSettings,
} from "../core/settings";
import { isReplacement, typographyFor, type Replacement } from "../core/typography";
import { BackLayer } from "./BackStack";
import { BottomSheet } from "./BottomSheet";
import { cx, errorMessage, focusLost, languageName } from "./dom";

export interface SettingsDialogProps {
  open: boolean;
  onClose(): void;
  isPhone: boolean;
  settings: ViewSettings;
  /** Validates and remembers on this device; applies at once. */
  update(patch: Partial<ViewSettings>): void;
  /** The open project's language (a code from LANGUAGES in src/core/projects.ts, or another one read from project.json). */
  language: string;
  /** Changes the project's language in project.json; throws with a reason (shown by the control) when it can't. */
  onLanguageChange(code: string): void;
  /** Opens a page in the system browser (the privacy policy, languagetool.org); absent in the browser preview, where a plain link opens a tab. */
  openUrl?(url: string): Promise<void>;
}

const SERVERS: { value: LanguageToolMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "public", label: "languagetool.org (free)" },
  { value: "premium", label: "LanguageTool Premium" },
  { value: "own", label: "Your own server" },
];

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** What can take focus in the dialog, for Tab to go round. */
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** "fr-CA" is French: the language without its region. */
function baseLanguage(code: string): string {
  const base = code.trim().split(/[-_]/u)[0];
  return base ? languageName(base) : code;
}

const isEnglish = (code: string) => code.trim().toLowerCase().split(/[-_]/u)[0] === "en";

/** The address of the writer's own server, as the backend takes it; null when it will do. */
export function serverAddressProblem(url: string): string | null {
  const text = url.trim();
  return text.startsWith("http://") || text.startsWith("https://")
    ? null
    : "The address must start with http:// or https://.";
}

/** Who checks grammar in the project's language, given the server chosen. */
export function grammarNote(language: string, server: LanguageToolSettings): string {
  const everywhere = "for every language, English included.";
  switch (server.mode) {
    case "public":
      return `Checked by languagetool.org, ${everywhere}`;
    case "premium":
      return server.username.trim() && server.apiKey.trim()
        ? `Checked by your LanguageTool Premium account, ${everywhere}`
        : "Add your user name and API key below.";
    case "own":
      return serverAddressProblem(server.url) === null
        ? `Checked by your own server, ${everywhere}`
        : "Add your server’s address below.";
    default:
      return isEnglish(language)
        ? "English is checked on this device, offline."
        : `${baseLanguage(language)} needs a grammar server: choose one below.`;
  }
}

/** What typography as you type does in the project's language. */
export function typographyExample(language: string): string {
  switch (typographyFor(language)) {
    case "en":
      return "In English: curly “quotes” and apostrophes, and — from two hyphens.";
    case "fr":
      return "In French: «\u00a0guillemets\u00a0», and a no-break space before ; : ! ?";
    case "es":
      return "In Spanish: «comillas», and the dialogue dash — from two hyphens.";
    default:
      return "Only in English, French and Spanish projects.";
  }
}

/**
 * The app's settings: the project's language, checking, typing and
 * appearance. Every change applies at once, so there is nothing to save:
 * switches, choices and Remove take effect when pressed, text fields when
 * the writer leaves them or presses Enter.
 *
 * Desktop: a modal dialog over a scrim, in a portal. Focus starts on the
 * dialog, Tab stays inside, and focus goes back where it was once it
 * closes. Escape, Back and a click on the scrim close it, keeping what was
 * typed if it can be kept; Done also waits for a field whose text can't be
 * kept (a server address without http://), and says why. Phones: the same
 * content in a full-height sheet from the bottom, its close button acting
 * as Done.
 */
export function SettingsDialog(props: SettingsDialogProps): JSX.Element | null {
  const { open, onClose, isPhone } = props;
  const titleId = useId();
  const sheetId = useId();
  const panel = useRef<HTMLDivElement>(null);
  /** A field whose text can't be kept, such as a server address without http://. */
  const blocked = useRef<HTMLInputElement | null>(null);
  /** Where focus was before the dialog opened. */
  const returnTo = useRef<Element | null>(null);
  /** A press that started on the scrim: only a click that also ends there closes the dialog. */
  const pressedScrim = useRef(false);

  // Each opening starts afresh from the settings: what was typed and not kept last time is gone.
  const [openings, setOpenings] = useState(0);
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) setOpenings((n) => n + 1);
  }

  const box = () => (isPhone ? document.getElementById(sheetId) : panel.current);

  /** Leaves the field being typed in, which keeps its text (as a click elsewhere would). */
  const settle = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && box()?.contains(active)) active.blur();
  };
  /** Escape, Back, the scrim. */
  const cancel = () => {
    settle();
    onClose();
  };
  /** Done, or the sheet's close button: stays open on a field whose text can't be kept. */
  const done = () => {
    settle();
    const field = blocked.current;
    if (field?.isConnected) {
      field.focus();
      return;
    }
    onClose();
  };
  const latest = useRef({ cancel, done });
  latest.current = { cancel, done };

  // Remembers where focus was, before the sheet moves it in, and puts it back
  // once the dialog closes, unless something else took it meanwhile.
  // StrictMode's second run finds focus already inside, and keeps the first
  // run's answer.
  useLayoutEffect(() => {
    if (!open) return;
    const node = isPhone ? document.getElementById(sheetId) : panel.current;
    const active = document.activeElement;
    if (active && !node?.contains(active)) returnTo.current = active;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected || node?.contains(now);
      const back = returnTo.current;
      if (lost && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [open, isPhone, sheetId]);

  // Desktop: focus starts on the dialog, so the next Tab reaches its first
  // control without changing it. Escape closes; Tab and Shift+Tab go round
  // the dialog. On the window, in the capture phase, so what is beneath
  // doesn't see them; left alone while focus is in something opened above
  // the dialog (the close dialog), which has its own keys.
  useEffect(() => {
    if (!open || isPhone) return;
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = panel.current;
      const active = document.activeElement;
      if (!dialog || !(focusLost() || dialog.contains(active))) return;
      if (event.key === "Escape") {
        if (event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        latest.current.cancel();
        return;
      }
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const at = items.indexOf(active as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      const next = at === -1 ? (event.shiftKey ? items.length - 1 : 0) : (at + step + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, isPhone]);

  const sections = <SettingsSections key={openings} {...props} blocked={blocked} />;
  // Keys pressed in the settings don't reach the app's shortcuts.
  const stopKeys = (event: ReactKeyboardEvent) => event.stopPropagation();

  if (isPhone) {
    if (openings === 0) return null;
    return (
      <BottomSheet
        id={sheetId}
        open={open}
        onClose={() => latest.current.cancel()}
        labelledBy={titleId}
        closeLabel="Close settings"
        className="settings-sheet"
        overPanels
      >
        <div className="settings-frame" onKeyDown={stopKeys}>
          <div className="settings-head">
            <h2 id={titleId} className="settings-title">
              Settings
            </h2>
            <button type="button" className="btn btn--icon" aria-label="Close" data-autofocus onClick={done}>
              <X aria-hidden />
            </button>
          </div>
          <div className="settings-body">{sections}</div>
        </div>
      </BottomSheet>
    );
  }

  if (!open) return null;

  const onScrimDown = (event: MouseEvent<HTMLDivElement>) => {
    pressedScrim.current = event.target === event.currentTarget;
    // Focus stays in the dialog, so the field being typed in keeps its text as the dialog closes.
    if (pressedScrim.current) event.preventDefault();
  };
  const onScrimClick = (event: MouseEvent<HTMLDivElement>) => {
    const onScrim = pressedScrim.current && event.target === event.currentTarget;
    pressedScrim.current = false;
    if (onScrim) latest.current.cancel();
  };

  return createPortal(
    <BackLayer open onBack={() => latest.current.cancel()}>
      <div className="settings-scrim" onMouseDown={onScrimDown} onClick={onScrimClick} onKeyDown={stopKeys}>
        <div
          ref={panel}
          className="settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="settings-head">
            <h2 id={titleId} className="settings-title">
              Settings
            </h2>
          </div>
          <div className="settings-body">{sections}</div>
          <div className="settings-foot">
            <button type="button" className="btn btn--primary" onClick={done}>
              Done
            </button>
          </div>
        </div>
      </div>
    </BackLayer>,
    document.body,
  );
}

interface SectionsProps extends SettingsDialogProps {
  blocked: RefObject<HTMLInputElement | null>;
}

/** The four groups of settings, the same on desktop and phones. */
function SettingsSections({ settings, update, language, onLanguageChange, openUrl, blocked }: SectionsProps) {
  const ids = useId();
  return (
    <>
      <section className="settings-section" aria-labelledby={`${ids}-project`}>
        <h3 id={`${ids}-project`} className="settings-section-title">
          This project
        </h3>
        <div className="settings-items">
          <LanguageField language={language} onLanguageChange={onLanguageChange} />
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${ids}-checking`}>
        <h3 id={`${ids}-checking`} className="settings-section-title">
          Checking
        </h3>
        <div className="settings-items">
          <Toggle label="Spelling" checked={settings.spelling} onChange={(spelling) => update({ spelling })} />
          <Toggle
            label="Grammar"
            checked={settings.grammar}
            onChange={(grammar) => update({ grammar })}
            note={settings.grammar ? grammarNote(language, settings.languageTool) : undefined}
          />
          {settings.grammar && (
            <GrammarServer
              server={settings.languageTool}
              onChange={(languageTool) => update({ languageTool })}
              openUrl={openUrl}
              blocked={blocked}
            />
          )}
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${ids}-typing`}>
        <h3 id={`${ids}-typing`} className="settings-section-title">
          Typing
        </h3>
        <div className="settings-items">
          <Toggle
            label="Typography as you type"
            checked={settings.typography}
            onChange={(typography) => update({ typography })}
            note={typographyExample(language)}
          />
          <Replacements saved={settings.replacements} onSave={(replacements) => update({ replacements })} />
        </div>
      </section>

      <section className="settings-section" aria-labelledby={`${ids}-appearance`}>
        <h3 id={`${ids}-appearance`} className="settings-section-title">
          Appearance
        </h3>
        <div className="settings-items">
          <ThemeChoice theme={settings.theme} onChange={(theme) => update({ theme })} />
          <Toggle
            label="Typewriter scrolling"
            checked={settings.typewriter}
            onChange={(typewriter) => update({ typewriter })}
            note="Keeps the line you’re typing in the middle of the screen."
          />
        </div>
      </section>
    </>
  );
}

/* Controls ---------------------------------------------------------------- */

const onEnter = (run: () => void) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  run();
};

/** A setting that is on or off: its label toggles it too. */
function Toggle({
  label,
  checked,
  onChange,
  note,
}: {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
  note?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="settings-item settings-item--switch">
      <div className="settings-row">
        <label id={`${id}-label`} htmlFor={id} className="settings-label">
          {label}
        </label>
        <button
          id={id}
          type="button"
          role="switch"
          className="switch"
          aria-checked={checked}
          aria-labelledby={`${id}-label`}
          aria-describedby={note ? `${id}-note` : undefined}
          onClick={() => onChange(!checked)}
        >
          <span className="switch-track" aria-hidden>
            <span className="switch-thumb" />
          </span>
        </button>
      </div>
      {note && (
        <p id={`${id}-note`} className="settings-note">
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * The project's language, saved in project.json at once. A refusal shows
 * under the list, which keeps the language the project has.
 */
function LanguageField({ language, onLanguageChange }: Pick<SettingsDialogProps, "language" | "onLanguageChange">) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);

  const known = LANGUAGES.some((l) => l.code === language);
  const change = (code: string) => {
    if (code === language) return;
    setError(null);
    try {
      onLanguageChange(code);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="settings-item">
      <label htmlFor={id} className="settings-label">
        Language
      </label>
      <span className="select">
        <select
          id={id}
          className="input"
          value={language}
          aria-invalid={error !== null || undefined}
          aria-describedby={cx(`${id}-note`, error !== null && `${id}-error`)}
          onChange={(event) => change(event.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
          {!known && <option value={language}>{language.trim() === "" ? "Not set" : languageName(language)}</option>}
        </select>
        <ChevronDown className="chevron" aria-hidden />
      </span>
      <p id={`${id}-note`} className="settings-note">
        Sets the spelling dictionary, grammar rules and typography.
      </p>
      {error !== null && (
        <p id={`${id}-error`} className="inline-error settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A line of text kept when the writer leaves it or presses Enter, trimmed.
 * Text `check` refuses isn't kept: the reason shows under the field, which
 * says so to `blocked` until the text will do.
 */
function TextField({
  label,
  value,
  onCommit,
  check,
  blocked,
  note,
  type = "text",
  inputMode,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit(value: string): void;
  check?: (text: string) => string | null;
  blocked?: RefObject<HTMLInputElement | null>;
  note?: string;
  type?: "text" | "password" | "url";
  inputMode?: "text" | "email" | "url";
  placeholder?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  // Gone (another server chosen, grammar turned off): nothing waits for it.
  useEffect(() => {
    const node = input.current;
    return () => {
      if (blocked?.current === node) blocked.current = null;
    };
  }, [blocked]);

  const problemOf = (text: string) => (text === "" ? null : (check?.(text) ?? null));
  const mark = (problem: string | null) => {
    setError(problem);
    if (!blocked) return;
    if (problem !== null) blocked.current = input.current;
    else if (blocked.current === input.current) blocked.current = null;
  };

  const commit = () => {
    const text = draft.trim();
    const problem = problemOf(text);
    mark(problem);
    if (problem !== null) return;
    if (text !== draft) setDraft(text);
    if (text !== value) onCommit(text);
  };

  return (
    <div className="settings-item">
      <label htmlFor={id} className="settings-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        className="input"
        type={type}
        inputMode={inputMode}
        value={draft}
        placeholder={placeholder}
        aria-invalid={error !== null || undefined}
        aria-describedby={cx(note && `${id}-note`, error !== null && `${id}-error`) || undefined}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          // Once a reason shows, it goes as soon as the text will do.
          if (error !== null) mark(problemOf(next.trim()));
        }}
        onBlur={commit}
        onKeyDown={onEnter(commit)}
      />
      {note && (
        <p id={`${id}-note`} className="settings-note">
          {note}
        </p>
      )}
      {error !== null && (
        <p id={`${id}-error`} className="inline-error settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Where grammar is checked besides this device, and what that server needs:
 * an account's user name and API key, or the address of the writer's own.
 * Text sent to LanguageTool is said so, with the privacy policy.
 */
function GrammarServer({
  server,
  onChange,
  openUrl,
  blocked,
}: {
  server: LanguageToolSettings;
  onChange(server: LanguageToolSettings): void;
  openUrl?: (url: string) => Promise<void>;
  blocked: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const set = (patch: Partial<LanguageToolSettings>) => onChange({ ...server, ...patch });
  const sendsToLanguageTool = server.mode === "public" || server.mode === "premium";

  return (
    <div className="settings-group">
      <div className="settings-item">
        <label htmlFor={id} className="settings-label">
          Grammar server
        </label>
        <span className="select">
          <select
            id={id}
            className="input"
            value={server.mode}
            onChange={(event) => set({ mode: event.target.value as LanguageToolMode })}
          >
            {SERVERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <ChevronDown className="chevron" aria-hidden />
        </span>
      </div>

      {server.mode === "premium" && (
        <>
          <TextField
            key="username"
            label="User name"
            value={server.username}
            inputMode="email"
            note="The email you sign in to LanguageTool with."
            onCommit={(username) => set({ username })}
          />
          <TextField key="apiKey" label="API key" type="password" value={server.apiKey} onCommit={(apiKey) => set({ apiKey })} />
        </>
      )}

      {server.mode === "own" && (
        <TextField
          key="url"
          label="Server address"
          type="url"
          inputMode="url"
          placeholder="http://localhost:8081"
          value={server.url}
          check={serverAddressProblem}
          blocked={blocked}
          onCommit={(url) => set({ url })}
        />
      )}

      {sendsToLanguageTool && (
        <div className="settings-privacy">
          <p>
            The paragraphs being checked are sent to LanguageTool.
            {server.mode === "public" && (
              <>
                {" "}
                The free server takes about <span className="num">20</span> checks a minute.
              </>
            )}
          </p>
          <PolicyLink openUrl={openUrl} />
        </div>
      )}
    </div>
  );
}

/** The privacy link: at rest, being opened in the system browser, or failed to open. */
type LinkState = "idle" | "opening" | "failed";

/**
 * The app's privacy policy. In the app it opens in the system browser
 * (openUrl); if that fails, the address shows so it can be typed there. In
 * the browser preview it is a plain link that opens a new tab.
 */
function PolicyLink({ openUrl }: { openUrl?: (url: string) => Promise<void> }) {
  const [link, setLink] = useState<LinkState>("idle");
  /** Set at once on a click, so a second click can't open the page twice. */
  const opening = useRef(false);
  const live = useRef(true);
  const errorId = useId();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!openUrl) return;
    event.preventDefault();
    if (opening.current) return;
    opening.current = true;
    setLink("opening");
    openUrl(PRIVACY_POLICY_URL)
      .then(
        () => live.current && setLink("idle"),
        (error: unknown) => {
          console.error("Cannot open the privacy policy", error);
          if (live.current) setLink("failed");
        },
      )
      .finally(() => {
        opening.current = false;
      });
  };

  return (
    <>
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
      {link === "failed" && (
        <div id={errorId} className="settings-link-error" role="alert">
          <p className="inline-error">Couldn’t open the browser. The privacy policy is at this address:</p>
          <p className="path">{PRIVACY_POLICY_URL}</p>
        </div>
      )}
    </>
  );
}

/** System, Light or Dark, as the editing mode is chosen in the formatting bar. */
function ThemeChoice({ theme, onChange }: { theme: Theme; onChange(theme: Theme): void }) {
  const id = useId();
  return (
    <div className="settings-row">
      <span id={id} className="settings-label">
        Theme
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {THEMES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            className="segmented-option"
            aria-checked={theme === t.value}
            onClick={() => theme !== t.value && onChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Replacements ------------------------------------------------------------ */

interface ReplacementRow extends Replacement {
  id: number;
}

let lastRowId = 0;
const rowId = () => ++lastRowId;

/**
 * What a list of rows keeps: rows with a word on both sides, trimmed, that
 * aren't the same word twice. Rows still being filled in stay on screen.
 */
export function keptReplacements(rows: readonly Replacement[]): Replacement[] {
  return rows
    .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
    .filter((r) => r.to !== "" && isReplacement(r));
}

const listKey = (list: readonly Replacement[]) => JSON.stringify(list.map((r) => [r.from, r.to]));

/**
 * Words replaced as they are typed, edited in place. A row is kept when the
 * writer leaves one of its fields or presses Enter; Remove takes effect at
 * once and puts focus on the next row's Remove (or the previous one's, or
 * Add a replacement).
 */
function Replacements({ saved, onSave }: { saved: Replacement[]; onSave(list: Replacement[]): void }) {
  const ids = useId();
  const [rows, setRows] = useState<ReplacementRow[]>(() => saved.map((r) => ({ ...r, id: rowId() })));
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const full = rows.length >= MAX_REPLACEMENTS;

  /** Run after the next render, once the rows it needs are on screen. */
  const afterRender = useRef<(() => void) | null>(null);
  useEffect(() => {
    const run = afterRender.current;
    afterRender.current = null;
    run?.();
  });

  const save = (next: readonly ReplacementRow[]) => {
    const list = keptReplacements(next);
    if (listKey(list) !== listKey(saved)) onSave(list);
  };

  const edit = (id: number, patch: Partial<Replacement>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const remove = (id: number) => {
    const at = rows.findIndex((r) => r.id === id);
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    save(next);
    const neighbour = next[at] ?? next[at - 1];
    afterRender.current = () => {
      const button = neighbour ? root.current?.querySelector<HTMLElement>(`[data-row="${neighbour.id}"] [data-remove]`) : null;
      (button ?? addButton.current)?.focus();
    };
  };

  const add = () => {
    if (full) return;
    const row: ReplacementRow = { id: rowId(), from: "", to: "" };
    setRows([...rows, row]);
    afterRender.current = () => root.current?.querySelector<HTMLInputElement>(`[data-row="${row.id}"] input`)?.focus();
  };

  return (
    <div ref={root} className="settings-item" role="group" aria-labelledby={`${ids}-title`}>
      <span id={`${ids}-title`} className="settings-label">
        Replacements
      </span>
      {rows.length === 0 ? (
        <p className="settings-note">No replacements.</p>
      ) : (
        <>
          <div className="replacement-row replacement-head" aria-hidden>
            <span id={`${ids}-from`}>You type</span>
            <span />
            <span id={`${ids}-to`}>It becomes</span>
          </div>
          <ul className="replacement-list" aria-labelledby={`${ids}-title`}>
            {rows.map((row) => {
              const name = row.from.trim() || "this replacement";
              const fieldProps = {
                className: "input",
                autoComplete: "off",
                autoCapitalize: "none",
                autoCorrect: "off",
                spellCheck: false,
                enterKeyHint: "done",
                onBlur: () => save(rows),
                onKeyDown: onEnter(() => save(rows)),
              } as const;
              return (
                <li key={row.id} className="replacement-row" data-row={row.id}>
                  <input
                    {...fieldProps}
                    value={row.from}
                    aria-labelledby={`${ids}-from`}
                    onChange={(event) => edit(row.id, { from: event.target.value })}
                  />
                  <ArrowRight className="replacement-arrow" aria-hidden />
                  <input
                    {...fieldProps}
                    value={row.to}
                    aria-labelledby={`${ids}-to`}
                    onChange={(event) => edit(row.id, { to: event.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn--icon btn--quiet replacement-remove"
                    data-remove
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    onClick={() => remove(row.id)}
                  >
                    <X aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <button ref={addButton} type="button" className="btn btn--quiet settings-add" disabled={full} onClick={add}>
        <Plus aria-hidden />
        Add a replacement
      </button>
      {full && (
        <p className="settings-note">
          The list holds up to <span className="num">{MAX_REPLACEMENTS}</span> replacements.
        </p>
      )}
    </div>
  );
}
