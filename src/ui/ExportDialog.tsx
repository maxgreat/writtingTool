import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  BOOK_FONTS,
  FONT_SIZE_RANGE,
  LINE_SPACINGS,
  MARGIN_RANGE,
  PAGE_SIZES,
  PAPERBACK,
  type BookLayout,
  type ChapterHeading,
  type ChapterStart,
  type ExportFormat,
  type ExportSettings,
  type PageSize,
} from "../core/exportSettings";
import { BackLayer } from "./BackStack";
import { cx, errorMessage, focusLost, formatCount } from "./dom";
import { MenuButton, MenuItem, Popover, type CloseReason } from "./Popover";

export interface ExportChoice {
  format: ExportFormat;
  settings: ExportSettings;
  /** Chapter ids to include, in book order. */
  chapterIds: string[];
  author: string;
}

export interface ExportSource {
  /** The book's parts and chapters in binder order, for Include (a part null = chapters outside any part). */
  outline: { part: string | null; chapters: { id: string; title: string }[] }[];
  /** The project's title, shown on the title page. */
  title: string;
  /** The author's name as saved in the project ("" when none). */
  author: string;
  /** Built-in presets first, then the project's own. */
  presets: { name: string; settings: ExportSettings; builtIn: boolean }[];
  /** The settings to start from: the last ones used in this project, else the first preset. */
  initial: { presetName: string | null; settings: ExportSettings; format: ExportFormat };
  /** Lays out the pages for the preview; rejects with a reason (shown in the window). Absent where pages can't be drawn (the browser preview without its dev server): show that state. */
  layOut?(choice: ExportChoice): Promise<BookLayout>;
  /** One page of a layout, as SVG markup (trusted: it comes from Typst). Rejects if that layout is gone (a newer one replaced it). */
  page?(generation: number, index: number): Promise<string>;
  /** Writes the file: the system's save dialog asks where. Resolves to where it went (to show), "" when the system doesn't say (Android's save dialog gives no path), or null if the writer cancelled the save dialog. Rejects with a reason. */
  export(choice: ExportChoice): Promise<string | null>;
  /** Saves the current settings as a project preset under `name` (replacing one of that name). */
  savePreset(name: string, settings: ExportSettings): void;
  /** Remembers the last settings, format and preset used, and the author, in the project. */
  remember(choice: ExportChoice, presetName: string | null): void;
}

export interface ExportDialogProps {
  open: boolean;
  source: ExportSource;
  onClose(): void;
  isPhone: boolean;
}

/** How long the settings must rest before the pages are laid out again. */
export const LAYOUT_DELAY_MS = 300;

const FORMATS: { value: ExportFormat; label: string; noun: string; action: string }[] = [
  { value: "pdf", label: "PDF", noun: "PDF", action: "Export PDF" },
  { value: "epub", label: "EPUB", noun: "EPUB", action: "Export EPUB" },
  { value: "docx", label: "Word", noun: "Word document", action: "Export Word document" },
  { value: "markdown", label: "Markdown", noun: "Markdown file", action: "Export Markdown" },
];

const formatInfo = (format: ExportFormat) => FORMATS.find((f) => f.value === format) ?? FORMATS[0];

const ALL_FORMATS: readonly ExportFormat[] = ["pdf", "epub", "docx", "markdown"];
const PDF_ONLY: readonly ExportFormat[] = ["pdf"];
/** Formats that set their own type: Word keeps the font, size and spacing as its styles. */
const TYPESET: readonly ExportFormat[] = ["pdf", "docx"];
/** Formats with chapter headings, scene breaks and a title page of their own. */
const STRUCTURED: readonly ExportFormat[] = ["pdf", "epub", "docx"];

/**
 * Which formats use each setting, as src-tauri/src/export.rs writes them. A
 * setting the chosen format leaves out isn't shown for it.
 */
export const SETTING_FORMATS: Record<keyof ExportSettings, readonly ExportFormat[]> = {
  pageSize: PDF_ONLY,
  marginInside: PDF_ONLY,
  marginOutside: PDF_ONLY,
  marginTop: PDF_ONLY,
  marginBottom: PDF_ONLY,
  mirrored: PDF_ONLY,
  font: TYPESET,
  fontSize: TYPESET,
  lineSpacing: TYPESET,
  indent: TYPESET,
  justify: TYPESET,
  hyphenate: PDF_ONLY,
  chapterStart: PDF_ONLY,
  chapterHeading: STRUCTURED,
  partTitles: ALL_FORMATS,
  sceneBreak: STRUCTURED,
  titlePage: STRUCTURED,
  contents: PDF_ONLY,
  pageNumbers: PDF_ONLY,
  runningHeads: PDF_ONLY,
};

/** What the other formats leave out, said above their settings. */
const FORMAT_NOTES: Record<ExportFormat, string | null> = {
  pdf: null,
  epub: "An EPUB reflows to fit each reader’s screen, so page and text settings apply to PDF only.",
  docx: "Word lays out the pages itself, so page settings apply to PDF only.",
  markdown: "Markdown is plain text: the title, the author and the chapters, without any layout.",
};

/** Why the preview has no pages for the other formats. */
const PREVIEW_NOTES: Record<ExportFormat, string> = {
  pdf: "",
  epub: "An EPUB has no fixed pages to preview: each reader’s screen sets them.",
  docx: "Word lays out a document’s pages itself, so there is nothing to preview here.",
  markdown: "Markdown is plain text, with no pages to preview.",
};

const CHAPTER_STARTS: { value: ChapterStart; label: string }[] = [
  { value: "rightPage", label: "Right-hand page" },
  { value: "newPage", label: "Any new page" },
];

const CHAPTER_HEADINGS: { value: ChapterHeading; label: string }[] = [
  { value: "numberAndTitle", label: "Number and title" },
  { value: "title", label: "Title only" },
  { value: "number", label: "Number only" },
];

/** Each page size in millimetres: the shape of the placeholder before the first layout arrives. */
const PAGE_MM: Record<PageSize, readonly [number, number]> = {
  a5: [148, 210],
  trade: [152.4, 228.6],
  a4: [210, 297],
  letter: [215.9, 279.4],
};

const SETTING_KEYS = Object.keys(PAPERBACK) as (keyof ExportSettings)[];

export function sameSettings(a: ExportSettings, b: ExportSettings): boolean {
  return SETTING_KEYS.every((key) => a[key] === b[key]);
}

/** "1.0", "1.15", "2.0". */
function spacingLabel(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

/**
 * The pages one view of the preview shows, from 0: one page, or a spread as
 * a printed book has them (page 1 alone on the right, then 2–3, 4–5…, the
 * left one even). Null leaves that side empty.
 */
export function viewPages(spread: boolean, page: number, count: number): (number | null)[] {
  if (count <= 0) return [];
  const at = Math.min(Math.max(page, 0), count - 1);
  if (!spread) return [at];
  if (at === 0) return [null, 0];
  const left = at % 2 === 1 ? at : at - 1;
  return [left, left + 1 < count ? left + 1 : null];
}

/** The first page of the next view (step 1) or the previous one (step −1); the same view at either end. */
export function stepView(spread: boolean, page: number, count: number, step: 1 | -1): number {
  const shown = viewPages(spread, page, count).filter((p): p is number => p !== null);
  if (shown.length === 0) return 0;
  const first = shown[0];
  const target = step === 1 ? shown[shown.length - 1] + 1 : first - 1;
  if (target < 0 || target >= count) return first;
  return viewPages(spread, target, count).find((p): p is number => p !== null) ?? first;
}

/** "1 of 212", "2–3 of 212", with an en dash. */
export function viewLabel(pages: readonly (number | null)[], count: number): string {
  const shown = pages.filter((p): p is number => p !== null).map((p) => formatCount(p + 1));
  return `${shown.join("–")} of ${formatCount(count)}`;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/**
 * The export window: the format as tabs, the settings, a preview of the real
 * pages and Export. Each opening starts from the project's last settings.
 */
export function ExportDialog({ open, source, onClose, isPhone }: ExportDialogProps): JSX.Element | null {
  if (!open) return null;
  return createPortal(<ExportWindow source={source} onClose={onClose} isPhone={isPhone} />, document.body);
}

/* Layout and pages ------------------------------------------------------------ */

interface Shown {
  layout: BookLayout;
  /** The chapters it was laid out with, for the chapter menu. */
  chapterIds: string[];
}

/**
 * Lays out the pages for `choice` while `wanted`: at once the first time,
 * then once the settings have rested for LAYOUT_DELAY_MS. The last good
 * layout stays shown meanwhile; an answer to an older request is dropped.
 *
 * The core keeps only its newest layout, and draws pages from it alone, so
 * the layout shown is always that one once no answer is awaited. A layout
 * sent to the core replaces the one it holds even when its answer is
 * dropped: settings that come back while it is out are laid out again.
 */
function useBookLayout(source: RefObject<ExportSource>, wanted: boolean, choice: ExportChoice) {
  const canLayOut = source.current.layOut !== undefined;
  const key = JSON.stringify([choice.settings, choice.chapterIds, choice.author]);
  const [shown, setShown] = useState<Shown | null>(null);
  /** The answer to the latest request, by the settings it was for; null while one is out. */
  const [answer, setAnswer] = useState<{ key: string; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  /**
   * The settings of the last layout sent to the core, once it has answered:
   * the core holds their layout, or said why it couldn't make it. Null while
   * a layout is out, since it replaces the core's if it is made.
   */
  const answered = useRef<string | null>(null);
  /** The newest layout the core made, whether its answer was dropped or not: the one it holds. */
  const held = useRef<Shown | null>(null);
  /** Asked for, or about to be: the same settings aren't asked for twice. */
  const asking = useRef<string | null>(null);
  const lastKey = useRef<string | null>(null);
  const latest = useRef(choice);
  latest.current = choice;

  useEffect(() => {
    const changed = lastKey.current !== null && lastKey.current !== key;
    lastKey.current = key;
    if (!wanted || !canLayOut || answered.current === key) {
      // Whatever is on its way answers settings that are no longer wanted.
      request.current++;
      asking.current = null;
      return;
    }
    if (asking.current === key) return;
    const id = ++request.current;
    asking.current = key;
    let sent = false;
    const send = () => {
      sent = true;
      const layOut = source.current.layOut;
      if (!layOut) return;
      const asked: ExportChoice = { ...latest.current, format: "pdf" };
      if (answered.current !== null) {
        answered.current = null;
        setAnswer(null);
      }
      layOut(asked).then(
        (layout) => {
          if (held.current === null || layout.generation > held.current.layout.generation) {
            held.current = { layout, chapterIds: asked.chapterIds };
          }
          if (id === request.current) {
            answered.current = key;
            asking.current = null;
            setAnswer({ key, error: null });
          }
          // Too late to show while a newer request is awaited; else the core moved on to it.
          if (asking.current === null) setShown(held.current);
        },
        (error: unknown) => {
          if (id !== request.current) return;
          answered.current = key;
          asking.current = null;
          setAnswer({ key, error: errorMessage(error) });
          // A layout whose answer was dropped may have replaced the one shown.
          setShown(held.current);
        },
      );
    };
    // A change waits for the next; opening, switching back to PDF or Try again go at once.
    if (!changed) {
      send();
      return;
    }
    const timer = setTimeout(send, LAYOUT_DELAY_MS);
    return () => {
      if (sent) return;
      clearTimeout(timer);
      if (asking.current === key) asking.current = null;
    };
  }, [source, key, wanted, canLayOut, attempt]);

  const retry = useCallback(() => {
    answered.current = null;
    asking.current = null;
    setAnswer(null);
    setAttempt((n) => n + 1);
  }, []);

  const active = wanted && canLayOut;
  return {
    canLayOut,
    shown,
    laying: active && answer?.key !== key,
    error: active && answer?.key === key ? answer.error : null,
    retry,
  };
}

type PageEntry = { status: "ready"; src: string } | { status: "error"; message: string };
type Slot = { status: "loading" } | { status: "ready"; src: string; stale: boolean } | { status: "error"; message: string };

/**
 * The pages of the layout shown, asked for as they are wanted (the view and
 * its neighbours). Until a page of a new layout arrives, its place keeps the
 * page last drawn there.
 *
 * While a layout is `waiting` (out, or about to be asked for), the core may
 * already hold a newer one than the layout shown, and refuse its pages. A
 * page that fails meanwhile stays loading, and is asked for again once
 * nothing is waiting, from the layout shown then: only a failure then is
 * shown.
 */
function usePages(
  source: RefObject<ExportSource>,
  generation: number | null,
  wanted: readonly number[],
  waiting: boolean,
) {
  const [entries, setEntries] = useState<ReadonlyMap<string, PageEntry>>(() => new Map());
  /** The last page drawn at each place, whichever layout it came from. */
  const [drawn, setDrawn] = useState<ReadonlyMap<number, string>>(() => new Map());
  const [retries, setRetries] = useState(0);
  const asked = useRef(new Set<string>());
  /** Pages that failed while a layout was waiting: asked for again once none is. */
  const later = useRef(new Set<string>());
  const current = useRef(generation);
  current.current = generation;
  const stillWaiting = useRef(waiting);
  stillWaiting.current = waiting;
  const wantedKey = wanted.join(" ");

  // A new layout: the pages of the ones before it are no longer asked for.
  useEffect(() => {
    if (generation === null) return;
    const mine = (key: string) => key.startsWith(`${generation}:`);
    for (const key of asked.current) if (!mine(key)) asked.current.delete(key);
    for (const key of later.current) if (!mine(key)) later.current.delete(key);
    setEntries((all) => ([...all.keys()].every(mine) ? all : new Map([...all].filter(([key]) => mine(key)))));
  }, [generation]);

  useEffect(() => {
    if (!waiting) {
      for (const key of later.current) asked.current.delete(key);
      later.current.clear();
    }
    const page = source.current.page;
    if (generation === null || !page || wantedKey === "") return;
    for (const index of wantedKey.split(" ").map(Number)) {
      const key = `${generation}:${index}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      page(generation, index).then(
        (svg) => {
          if (!asked.current.has(key)) return;
          const src = svgUrl(svg);
          setEntries((all) => new Map(all).set(key, { status: "ready", src }));
          setDrawn((all) => new Map(all).set(index, src));
        },
        (error: unknown) => {
          // A newer layout replaced this one: its pages aren't wanted any more.
          if (!asked.current.has(key) || current.current !== generation) return;
          if (stillWaiting.current) {
            later.current.add(key);
            return;
          }
          setEntries((all) => new Map(all).set(key, { status: "error", message: errorMessage(error) }));
        },
      );
    }
  }, [source, generation, wantedKey, retries, waiting]);

  const retry = useCallback(
    (index: number) => {
      if (generation === null) return;
      const key = `${generation}:${index}`;
      asked.current.delete(key);
      setEntries((all) => {
        const next = new Map(all);
        next.delete(key);
        return next;
      });
      setRetries((n) => n + 1);
    },
    [generation],
  );

  const slot = (index: number): Slot => {
    const entry = generation === null ? undefined : entries.get(`${generation}:${index}`);
    if (entry?.status === "ready") return { status: "ready", src: entry.src, stale: false };
    if (entry?.status === "error") return entry;
    const last = drawn.get(index);
    return last === undefined ? { status: "loading" } : { status: "ready", src: last, stale: true };
  };

  return { slot, retry };
}

/* The window -------------------------------------------------------------------- */

type ExportState =
  | { status: "idle" }
  | { status: "running" }
  /** `path` is "" when the system doesn't say where; `noun` names the format exported, which the tabs may have changed since. */
  | { status: "saved"; path: string; noun: string }
  | { status: "error"; message: string };

type IncludeMode = "all" | "chosen";
type PhoneView = "settings" | "preview";

const FOCUSABLE =
  'a[href], button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
}

function ExportWindow({ source, onClose, isPhone }: Omit<ExportDialogProps, "open">) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const bodyId = `${ids}-body`;
  const statusId = `${ids}-status`;
  const settingsId = `${ids}-settings`;
  const previewId = `${ids}-preview`;
  const panel = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const latest = useRef(source);
  latest.current = source;
  const close = useRef(onClose);
  close.current = onClose;

  const { outline } = source;
  const [format, setFormat] = useState<ExportFormat>(source.initial.format);
  const [settings, setSettings] = useState<ExportSettings>(source.initial.settings);
  const [presetName, setPresetName] = useState<string | null>(source.initial.presetName);
  /** Presets saved from this window, shown before the project hands them back. */
  const [saved, setSaved] = useState<ReadonlyMap<string, ExportSettings>>(() => new Map());
  const allIds = useMemo(() => outline.flatMap((s) => s.chapters.map((c) => c.id)), [outline]);
  const [mode, setMode] = useState<IncludeMode>("all");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(allIds));
  const [author, setAuthor] = useState(source.author);
  const [phoneView, setPhoneView] = useState<PhoneView>("settings");
  const [spreadChosen, setSpreadChosen] = useState(true);
  const [page, setPage] = useState(0);
  const [chapterMenu, setChapterMenu] = useState(false);
  const [result, setResult] = useState<ExportState>({ status: "idle" });
  const [exported, setExported] = useState(false);
  const running = useRef(false);

  const chapterIds = useMemo(
    () => (mode === "all" ? allIds : allIds.filter((id) => chosen.has(id))),
    [mode, allIds, chosen],
  );
  const choice = useMemo<ExportChoice>(
    () => ({ format, settings, chapterIds, author }),
    [format, settings, chapterIds, author],
  );
  const titles = useMemo(() => new Map(outline.flatMap((s) => s.chapters.map((c) => [c.id, c.title] as const))), [
    outline,
  ]);

  const blocked =
    allIds.length === 0
      ? "The book has no chapters to export yet."
      : chapterIds.length === 0
        ? "Choose at least one chapter to export."
        : null;
  const isPdf = format === "pdf";
  const layout = useBookLayout(latest, isPdf && blocked === null, choice);
  const { shown } = layout;

  // The view: a spread or one page (always one on phones), and its neighbours, asked for ahead.
  const spread = spreadChosen && !isPhone;
  const count = shown?.layout.pages ?? 0;
  const at = count === 0 ? 0 : Math.min(page, count - 1);
  const slots = viewPages(spread, at, count);
  const previous = stepView(spread, at, count, -1);
  const next = stepView(spread, at, count, 1);
  const visible = slots.filter((p): p is number => p !== null);
  const wanted = isPdf
    ? [...new Set([...visible, ...viewPages(spread, next, count), ...viewPages(spread, previous, count)])].filter(
        (p): p is number => p !== null,
      )
    : [];
  const pages = usePages(latest, shown?.layout.generation ?? null, wanted, layout.laying);

  const chapters = shown
    ? shown.chapterIds
        .slice(0, shown.layout.chapterPages.length)
        .map((id, i) => ({ id, title: titles.get(id) ?? "", page: shown.layout.chapterPages[i] }))
    : [];
  const lastVisible = visible.length > 0 ? visible[visible.length - 1] : -1;
  let currentChapter = -1;
  chapters.forEach((c, i) => {
    if (c.page <= lastVisible) currentChapter = i;
  });

  const presets = useMemo(() => {
    const list = source.presets.map((p) => {
      const own = saved.get(p.name);
      return own && !p.builtIn ? { ...p, settings: own } : p;
    });
    for (const [name, own] of saved) if (!list.some((p) => p.name === name)) list.push({ name, settings: own, builtIn: false });
    return list;
  }, [source.presets, saved]);
  const preset = presets.find((p) => p.name === presetName);
  const changed = preset !== undefined && !sameSettings(preset.settings, settings);

  /** A change makes the last export's note out of date. */
  const forgetResult = () => setResult((r) => (r.status === "running" ? r : { status: "idle" }));
  const update = (patch: Partial<ExportSettings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    forgetResult();
  };

  const chooseFormat = (value: ExportFormat) => {
    setFormat(value);
    forgetResult();
  };

  const choosePreset = (name: string) => {
    const found = presets.find((p) => p.name === name);
    if (!found) return;
    setPresetName(name);
    setSettings(found.settings);
    forgetResult();
  };

  /** Saves the settings as a project preset; resolves to why it couldn't, or null. */
  const savePreset = (name: string): string | null => {
    try {
      latest.current.savePreset(name, settings);
    } catch (error) {
      return errorMessage(error);
    }
    setSaved((all) => new Map(all).set(name, settings));
    setPresetName(name);
    return null;
  };

  const runExport = async () => {
    if (running.current || blocked !== null) return;
    running.current = true;
    const asked = choice;
    setResult({ status: "running" });
    try {
      latest.current.remember(asked, preset ? preset.name : null);
    } catch (error) {
      console.error("Couldn’t remember the export settings", error);
    }
    try {
      const path = await latest.current.export(asked);
      if (path === null) {
        setResult({ status: "idle" });
      } else {
        setResult({ status: "saved", path, noun: formatInfo(asked.format).noun });
        setExported(true);
      }
    } catch (error) {
      setResult({ status: "error", message: errorMessage(error) });
    } finally {
      running.current = false;
    }
  };

  // Focus goes to the window, and back where it was once it closes, unless
  // something else took it meanwhile. StrictMode's second run finds focus in
  // the window already, and keeps the first run's answer.
  const returnTo = useRef<Element | null>(null);
  useEffect(() => {
    const node = panel.current;
    const active = document.activeElement;
    if (active && !node?.contains(active)) returnTo.current = active;
    node?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected || node?.contains(now);
      const back = returnTo.current;
      if (lost && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // Export waits while it runs, which takes focus from it: it gets it back once done.
  const wasRunning = useRef(false);
  useEffect(() => {
    const was = wasRunning.current;
    wasRunning.current = result.status === "running";
    if (was && result.status !== "running" && focusLost()) exportButton.current?.focus({ preventScroll: true });
  }, [result.status]);

  // Modal: focus that lands outside the window (and its menus) comes back to
  // it. A dialog opened above it, such as the close dialog, keeps its own.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const node = panel.current;
      const target = event.target;
      if (!node || !(target instanceof Element) || node.contains(target)) return;
      if (target.closest('.popover, [aria-modal="true"]')) return;
      node.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  /**
   * Escape closes the window; a menu open in it closes first, by itself.
   * Tab goes round the window, or round a small dialog opened from it; Tab
   * in a menu closes it and goes back to its button. No key goes on to the
   * app beneath.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close.current();
      return;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
    const node = panel.current;
    if (!node || !(event.target instanceof Element)) return;
    let box: HTMLElement = node;
    const popover = event.target.closest<HTMLElement>(".popover");
    if (popover && !node.contains(popover)) {
      if (popover.getAttribute("role") === "menu") {
        event.preventDefault();
        node.querySelector<HTMLElement>('[aria-expanded="true"]')?.focus();
        return;
      }
      box = popover;
    }
    const items = focusables(box);
    if (items.length === 0) return;
    const active = document.activeElement;
    const inside = active !== null && active !== box && box.contains(active);
    if (event.shiftKey && (!inside || active === items[0])) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (!event.shiftKey && (!inside || active === items[items.length - 1])) {
      event.preventDefault();
      items[0].focus();
    }
  };

  // A press on the scrim leaves focus where it is, in the window.
  const keepFocus = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) event.preventDefault();
  };

  const onStageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || count === 0) return;
    let target: number | null = null;
    if (["PageDown", "ArrowRight", "ArrowDown"].includes(event.key)) target = next;
    else if (["PageUp", "ArrowLeft", "ArrowUp"].includes(event.key)) target = previous;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = count - 1;
    if (target === null) return;
    event.preventDefault();
    setPage(target);
  };

  const info = formatInfo(format);

  // The status line: the export first, then why Export waits, then the pages.
  let status: ReactNode = "";
  let tone: "error" | "done" | null = null;
  if (result.status === "running") {
    status = `Exporting the ${info.noun}…`;
  } else if (result.status === "error") {
    status = `Couldn’t export: ${result.message}`;
    tone = "error";
  } else if (result.status === "saved") {
    // Without a path (Android), the writer has just chosen the place in the system's dialog.
    status =
      result.path === "" ? (
        `Saved the ${result.noun}.`
      ) : (
        <>
          Saved to <span className="path">{result.path}</span>
        </>
      );
    tone = "done";
  } else if (blocked !== null) {
    status = blocked;
  } else if (isPdf && layout.canLayOut) {
    // Without layOut, the preview itself says why it has no pages.
    if (layout.laying) status = "Laying out the pages…";
    else if (layout.error !== null) {
      status = `Couldn’t lay out the pages: ${layout.error}`;
      tone = "error";
    } else status = "The preview redraws after each change.";
  }

  const presetMenu = (
    <PresetMenu
      presets={presets}
      presetName={preset ? preset.name : null}
      changed={changed}
      onChoose={choosePreset}
      onSave={savePreset}
    />
  );

  const settingsPanel = (
    <div
      id={settingsId}
      className="export-settings"
      role={isPhone ? "tabpanel" : undefined}
      aria-labelledby={isPhone ? `${ids}-view-settings` : undefined}
      hidden={isPhone && phoneView !== "settings"}
    >
      {isPhone && <div className="export-preset-row">{presetMenu}</div>}
      <SettingsForm
        ids={ids}
        format={format}
        settings={settings}
        update={update}
        outline={outline}
        mode={mode}
        chosen={chosen}
        onModeChange={(value) => {
          setMode(value);
          forgetResult();
        }}
        onChosenChange={(value) => {
          setChosen(value);
          forgetResult();
        }}
        author={author}
        onAuthorChange={(value) => {
          setAuthor(value);
          forgetResult();
        }}
      />
    </div>
  );

  let previewContent: ReactNode;
  if (!isPdf) {
    previewContent = <PreviewNote>{PREVIEW_NOTES[format]}</PreviewNote>;
  } else if (blocked !== null) {
    // The status line says why Export waits; the preview only says what it lacks.
    previewContent = <PreviewNote>{allIds.length === 0 ? "No chapters yet." : "No chapters chosen."}</PreviewNote>;
  } else if (!layout.canLayOut) {
    previewContent = (
      <PreviewNote title="Pages can’t be drawn here">The app draws them as you change the settings.</PreviewNote>
    );
  } else if (shown === null && layout.error !== null) {
    previewContent = (
      <PreviewNote title="Couldn’t lay out the pages" error>
        <span className="export-reason">{layout.error}</span>
        <button type="button" className="btn btn--quiet" onClick={layout.retry}>
          Try again
        </button>
      </PreviewNote>
    );
  } else {
    // Until the first layout arrives, the controls wait in place, over a
    // placeholder of the chosen page size, so nothing moves once it is in.
    const label = shown === null ? "" : viewLabel(slots, count);
    const [placeholderWidth, placeholderHeight] = PAGE_MM[settings.pageSize];
    const stageContent =
      shown === null ? (
        <PageSpread width={placeholderWidth} height={placeholderHeight} slots={spread ? 2 : 1}>
          {spread && <div className="export-page is-empty" />}
          <div className="export-page is-loading" />
        </PageSpread>
      ) : (
        <PageSpread width={shown.layout.width} height={shown.layout.height} slots={slots.length}>
          {slots.map((p, i) =>
            p === null ? (
              <div key={`empty-${i}`} className="export-page is-empty" />
            ) : (
              <PageView key={p} index={p} slot={pages.slot(p)} onRetry={() => pages.retry(p)} />
            ),
          )}
        </PageSpread>
      );
    previewContent = (
      <>
        <div className="export-toolbar">
          {!isPhone && (
            <div className="segmented" role="radiogroup" aria-label="Pages shown">
              {[
                { value: true, label: "Spread" },
                { value: false, label: "Single" },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  className="segmented-option"
                  aria-checked={spreadChosen === option.value}
                  onClick={() => {
                    setSpreadChosen(option.value);
                    setPage(visible[0] ?? 0);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <div className="export-nav">
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Previous page"
              title="Previous page (Page Up)"
              disabled={previous === (visible[0] ?? 0)}
              onClick={() => setPage(previous)}
            >
              <ChevronLeft aria-hidden />
            </button>
            <span className="export-position num" aria-live="polite">
              {shown === null ? <span className="skeleton export-position-skeleton" aria-hidden /> : label}
            </span>
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Next page"
              title="Next page (Page Down)"
              disabled={next === (visible[0] ?? 0)}
              onClick={() => setPage(next)}
            >
              <ChevronRight aria-hidden />
            </button>
          </div>
          <MenuButton
            open={chapterMenu}
            onOpenChange={setChapterMenu}
            menuLabel="Go to chapter"
            className="export-chapter-trigger"
            popoverClassName="export-chapter-menu"
            disabled={chapters.length === 0}
            menu={chapters.map((c, i) => (
              <MenuItem
                key={c.id}
                checked={i === currentChapter}
                hint={formatCount(c.page + 1)}
                onSelect={() => {
                  setChapterMenu(false);
                  setPage(c.page);
                  stage.current?.focus({ preventScroll: true });
                }}
              >
                {c.title}
              </MenuItem>
            ))}
          >
            Chapters
          </MenuButton>
        </div>
        {layout.error !== null && (
          <div className="export-preview-error">
            <p className="inline-error">Couldn’t lay out the pages: {layout.error}</p>
            <button type="button" className="btn btn--quiet" onClick={layout.retry}>
              Try again
            </button>
          </div>
        )}
        <div
          ref={stage}
          className="export-stage"
          tabIndex={shown === null ? undefined : 0}
          role="group"
          aria-label="Page preview"
          aria-keyshortcuts={shown === null ? undefined : "PageUp PageDown ArrowLeft ArrowRight Home End"}
          aria-busy={layout.laying || undefined}
          onKeyDown={onStageKeyDown}
        >
          {stageContent}
        </div>
      </>
    );
  }

  const previewPanel = (
    <div
      id={previewId}
      className="export-preview"
      role={isPhone ? "tabpanel" : "region"}
      aria-label={isPhone ? undefined : "Preview"}
      aria-labelledby={isPhone ? `${ids}-view-preview` : undefined}
      aria-busy={(isPdf && layout.laying) || undefined}
      hidden={isPhone && phoneView !== "preview"}
    >
      {previewContent}
    </div>
  );

  return (
    <BackLayer open onBack={() => close.current()}>
      <div className={cx("export-scrim", isPhone && "is-phone")} onMouseDown={keepFocus} onKeyDown={onKeyDown}>
        <div
          ref={panel}
          className={cx("export-dialog", isPhone && "is-phone")}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="export-header">
            <h2 id={titleId} className="export-title">
              Export
            </h2>
            <TabList
              label="Format"
              idPrefix={`${ids}-format`}
              options={FORMATS}
              value={format}
              onChange={chooseFormat}
              controls={bodyId}
              className="export-formats"
              tabClassName="tab export-format"
            />
            <div className="export-header-end">
              {isPhone ? (
                <button
                  type="button"
                  className="btn btn--icon export-close"
                  aria-label="Close"
                  title="Close"
                  onClick={() => close.current()}
                >
                  <X aria-hidden />
                </button>
              ) : (
                presetMenu
              )}
            </div>
          </div>

          {isPhone && (
            <TabList<PhoneView>
              label="Show"
              idPrefix={`${ids}-view`}
              options={[
                { value: "settings", label: "Settings", controls: settingsId },
                { value: "preview", label: "Preview", controls: previewId },
              ]}
              value={phoneView}
              onChange={setPhoneView}
              className="segmented segmented--full export-views"
              tabClassName="segmented-option"
            />
          )}

          <div
            id={bodyId}
            className="export-body"
            role="tabpanel"
            aria-labelledby={`${ids}-format-${format}`}
          >
            {settingsPanel}
            {previewPanel}
          </div>

          <div className="export-footer">
            <p
              id={statusId}
              className={cx("export-status", tone === "error" && "is-error", tone === "done" && "is-done")}
              role="status"
            >
              {status}
            </p>
            <div className="export-actions">
              {!isPhone && (
                <button type="button" className="btn" onClick={() => close.current()}>
                  {exported ? "Close" : "Cancel"}
                </button>
              )}
              <button
                ref={exportButton}
                type="button"
                className="btn btn--primary export-button"
                disabled={blocked !== null || result.status === "running"}
                aria-busy={result.status === "running" || undefined}
                aria-describedby={blocked !== null ? statusId : undefined}
                onClick={() => void runExport()}
              >
                {result.status === "running" ? "Exporting…" : info.action}
              </button>
            </div>
          </div>
        </div>
      </div>
    </BackLayer>
  );
}

/* Preview parts ------------------------------------------------------------------ */

/** A row of one or two pages, as large as the stage allows (container units, in the stylesheet). */
function PageSpread({
  width,
  height,
  slots,
  children,
}: {
  width: number;
  height: number;
  slots: number;
  children: ReactNode;
}) {
  const style = {
    "--page-ratio": `${width} / ${height}`,
    "--spread-ratio": (width * slots) / height,
  } as CSSProperties;
  return (
    <div className="export-spread" style={style}>
      {children}
    </div>
  );
}

function PageView({ index, slot, onRetry }: { index: number; slot: Slot; onRetry(): void }) {
  const name = `Page ${formatCount(index + 1)}`;
  if (slot.status === "ready") {
    return (
      <div className="export-page">
        <img src={slot.src} alt={name} draggable={false} data-stale={slot.stale || undefined} />
      </div>
    );
  }
  if (slot.status === "error") {
    return (
      <div className="export-page is-error">
        <p className="inline-error">
          Couldn’t draw page <span className="num">{formatCount(index + 1)}</span>: {slot.message}
        </p>
        <button type="button" className="btn btn--quiet" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  return <div className="export-page is-loading" role="img" aria-label={`${name}, loading`} />;
}

function PreviewNote({ title, error, children }: { title?: string; error?: boolean; children: ReactNode }) {
  return (
    <div className={cx("export-preview-note", error && "is-error")}>
      {title && <p className="export-preview-note-title">{title}</p>}
      {typeof children === "string" ? <p>{children}</p> : children}
    </div>
  );
}

/* Tabs ---------------------------------------------------------------------------- */

interface TabOption<T extends string> {
  value: T;
  label: string;
  /** The panel this tab shows; else the list's `controls`. */
  controls?: string;
}

/** Tabs that choose as focus moves: arrows, Home and End. */
function TabList<T extends string>({
  label,
  idPrefix,
  options,
  value,
  onChange,
  controls,
  className,
  tabClassName,
}: {
  label: string;
  idPrefix: string;
  options: readonly TabOption<T>[];
  value: T;
  onChange(value: T): void;
  controls?: string;
  className?: string;
  tabClassName?: string;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const last = options.length - 1;
    let to = -1;
    if (event.key === "ArrowRight") to = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") to = index <= 0 ? last : index - 1;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = last;
    if (to === -1) return;
    event.preventDefault();
    onChange(options[to].value);
    tabs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(el) => {
            tabs.current[i] = el;
          }}
          id={`${idPrefix}-${option.value}`}
          type="button"
          role="tab"
          className={tabClassName}
          aria-selected={option.value === value}
          aria-controls={option.controls ?? controls}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* Presets ------------------------------------------------------------------------- */

interface PresetMenuProps {
  presets: ExportSource["presets"];
  /** The preset the settings came from; null when they match none. */
  presetName: string | null;
  /** The settings differ from that preset's. */
  changed: boolean;
  onChoose(name: string): void;
  /** Resolves to why the preset couldn't be saved, or null. */
  onSave(name: string): string | null;
}

/**
 * The preset menu: choosing one applies its settings. Settings that differ
 * from the chosen preset show as changed, and can be saved as a preset of
 * the project, under a name no built-in preset has.
 */
function PresetMenu({ presets, presetName, changed, onChoose, onSave }: PresetMenuProps) {
  const [menu, setMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const current = presets.find((p) => p.name === presetName);
  const label = current === undefined ? "Custom" : changed ? `${current.name} (changed)` : current.name;
  const builtIn = presets.filter((p) => p.builtIn);
  const own = presets.filter((p) => !p.builtIn);
  const canSave = current === undefined || changed;

  const typed = name.trim();
  const sameName = (p: { name: string }) => p.name.toLocaleLowerCase() === typed.toLocaleLowerCase();
  const replaces = typed !== "" && own.some(sameName) && !builtIn.some(sameName);

  const startSaving = () => {
    setMenu(false);
    setName(current && !current.builtIn ? current.name : "");
    setRefusal(null);
    setSaving(true);
  };

  const finishSaving = (reason: CloseReason | "done") => {
    setSaving(false);
    if (reason === "escape" || reason === "done") trigger.current?.focus({ preventScroll: true });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed === "") {
      setRefusal("Give the preset a name.");
      return;
    }
    const taken = builtIn.find(sameName);
    if (taken) {
      setRefusal(`“${taken.name}” is a built-in preset. Choose another name.`);
      return;
    }
    // A preset of the project with that name, whatever its case, is replaced under its own name.
    const replaced = own.find(sameName);
    const why = onSave(replaced ? replaced.name : typed);
    if (why !== null) {
      setRefusal(why);
      return;
    }
    finishSaving("done");
  };

  const noteId = `${ids}-note`;
  const note = refusal ?? (replaces ? "Replaces the preset of that name." : null);

  const item = (p: { name: string }) => (
    <MenuItem
      key={p.name}
      checked={p.name === presetName}
      onSelect={() => {
        setMenu(false);
        onChoose(p.name);
        trigger.current?.focus({ preventScroll: true });
      }}
    >
      {p.name}
    </MenuItem>
  );

  return (
    <>
      <MenuButton
        open={menu}
        onOpenChange={(open) => {
          setMenu(open);
          if (open) setSaving(false);
        }}
        triggerRef={trigger}
        menuLabel="Presets"
        ariaLabel={`Preset: ${label}`}
        className="export-preset"
        menu={
          <>
            {builtIn.map(item)}
            {own.length > 0 && (
              <>
                <div className="popover-gap" role="none" />
                <div className="popover-title" role="none">
                  This project
                </div>
                {own.map(item)}
              </>
            )}
            {canSave && (
              <>
                <div className="popover-gap" role="none" />
                <MenuItem onSelect={startSaving}>Save as preset…</MenuItem>
              </>
            )}
          </>
        }
      >
        <span className="muted">Preset</span>
        <span className="export-preset-name">{label}</span>
      </MenuButton>
      {saving && (
        <Popover
          anchor={trigger}
          ignore={trigger}
          role="dialog"
          label="Save as preset"
          className="export-save-popover"
          autoFocus
          onClose={finishSaving}
        >
          <form className="export-save" noValidate onSubmit={submit}>
            <label htmlFor={`${ids}-name`}>
              Preset name
            </label>
            <input
              id={`${ids}-name`}
              className="input"
              value={name}
              aria-invalid={refusal !== null}
              aria-describedby={note ? noteId : undefined}
              enterKeyHint="done"
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setRefusal(null);
              }}
            />
            <p id={noteId} className={cx("export-save-note", refusal !== null ? "inline-error" : "muted")} aria-live="polite">
              {note}
            </p>
            {/* Export stays the window's one filled button: Save is marked by the accent alone. */}
            <div className="export-save-actions">
              <button type="button" className="btn btn--quiet" onClick={() => finishSaving("escape")}>
                Cancel
              </button>
              <button type="submit" className="btn export-save-submit">
                Save preset
              </button>
            </div>
          </form>
        </Popover>
      )}
    </>
  );
}

/* Settings ------------------------------------------------------------------------ */

interface SettingsFormProps {
  ids: string;
  format: ExportFormat;
  settings: ExportSettings;
  update(patch: Partial<ExportSettings>): void;
  outline: ExportSource["outline"];
  mode: IncludeMode;
  chosen: ReadonlySet<string>;
  onModeChange(mode: IncludeMode): void;
  onChosenChange(chosen: ReadonlySet<string>): void;
  author: string;
  onAuthorChange(author: string): void;
}

/** The settings the chosen format uses, in groups: Content, Page, Text, Chapters, Extras. */
function SettingsForm(props: SettingsFormProps) {
  const { ids, format, settings, update, outline } = props;
  const has = (key: keyof ExportSettings) => SETTING_FORMATS[key].includes(format);
  const id = (name: string) => `${ids}-${name}`;
  const hasParts = outline.some((s) => s.part !== null && s.chapters.length > 0);
  const [inside, outside] = settings.mirrored ? ["Inside", "Outside"] : ["Left", "Right"];
  const spacings: number[] = LINE_SPACINGS.includes(settings.lineSpacing as (typeof LINE_SPACINGS)[number])
    ? [...LINE_SPACINGS]
    : [...LINE_SPACINGS, settings.lineSpacing].sort((a, b) => a - b);
  const extras = (["titlePage", "contents", "pageNumbers", "runningHeads"] as const).filter(has);
  const note = FORMAT_NOTES[format];

  /** Number fields holding something out of range, which isn't applied: the form says the range. */
  const [outOfRange, setOutOfRange] = useState<ReadonlySet<string>>(() => new Set());
  const validity = (key: string) => (valid: boolean) =>
    setOutOfRange((all) => {
      if (all.has(key) !== valid) return all;
      const next = new Set(all);
      if (valid) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {note && <p className="export-note">{note}</p>}

      <Group id={id("content")} title="Content">
        <label htmlFor={id("include")}>Include</label>
        <Select
          id={id("include")}
          value={props.mode}
          options={[
            { value: "all", label: "Whole book" },
            { value: "chosen", label: "Chosen chapters" },
          ]}
          onChange={props.onModeChange}
        />
        {props.mode === "chosen" && (
          <ChapterPicker
            ids={ids}
            outline={outline}
            chosen={props.chosen}
            onChange={props.onChosenChange}
          />
        )}
        {hasParts && (
          <Checkbox className="export-control" checked={settings.partTitles} onChange={(partTitles) => update({ partTitles })}>
            Part titles
          </Checkbox>
        )}
        {has("sceneBreak") && (
          <>
            <label htmlFor={id("scene")}>Scene break</label>
            <input
              id={id("scene")}
              className="input export-short"
              value={settings.sceneBreak}
              maxLength={20}
              autoComplete="off"
              onChange={(event) => update({ sceneBreak: event.target.value })}
            />
          </>
        )}
        <label htmlFor={id("author")}>Author</label>
        <input
          id={id("author")}
          className="input"
          value={props.author}
          autoComplete="off"
          onChange={(event) => props.onAuthorChange(event.target.value)}
        />
      </Group>

      {has("pageSize") && (
        <Group id={id("page")} title="Page">
          <label htmlFor={id("size")}>Size</label>
          <Select
            id={id("size")}
            value={settings.pageSize}
            options={PAGE_SIZES}
            onChange={(pageSize) => update({ pageSize })}
          />
          <span id={id("margins")} className="export-label-end">
            Margins (mm)
          </span>
          <div className="export-margins" role="group" aria-labelledby={id("margins")}>
            {(
              [
                ["marginInside", inside],
                ["marginOutside", outside],
                ["marginTop", "Top"],
                ["marginBottom", "Bottom"],
              ] as const
            ).map(([key, label]) => (
              <span key={key} className="export-margin">
                <label htmlFor={id(key)}>{label}</label>
                <NumberField
                  id={id(key)}
                  value={settings[key]}
                  range={MARGIN_RANGE}
                  step={1}
                  onChange={(value) => update({ [key]: value })}
                  describedBy={id("margins-range")}
                  onValidChange={validity(key)}
                />
              </span>
            ))}
          </div>
          {MARGIN_KEYS.some((key) => outOfRange.has(key)) && (
            <p id={id("margins-range")} className="export-range export-control">
              Margins go from {formatCount(MARGIN_RANGE.min)} to {formatCount(MARGIN_RANGE.max)} mm.
            </p>
          )}
          <Checkbox className="export-control" checked={settings.mirrored} onChange={(mirrored) => update({ mirrored })}>
            Mirrored for print
          </Checkbox>
        </Group>
      )}

      {has("font") && (
        <Group id={id("text")} title="Text">
          <label htmlFor={id("font")}>Font</label>
          <Select id={id("font")} value={settings.font} options={BOOK_FONTS} onChange={(font) => update({ font })} />
          <label htmlFor={id("fontSize")}>Text size</label>
          <NumberField
            id={id("fontSize")}
            unit="pt"
            value={settings.fontSize}
            range={FONT_SIZE_RANGE}
            step={0.5}
            onChange={(fontSize) => update({ fontSize })}
            describedBy={id("fontSize-range")}
            onValidChange={validity("fontSize")}
          />
          {outOfRange.has("fontSize") && (
            <p id={id("fontSize-range")} className="export-range export-control">
              Sizes go from {formatCount(FONT_SIZE_RANGE.min)} to {formatCount(FONT_SIZE_RANGE.max)} pt.
            </p>
          )}
          <label htmlFor={id("spacing")}>Line spacing</label>
          <Select
            id={id("spacing")}
            value={String(settings.lineSpacing)}
            options={spacings.map((value) => ({ value: String(value), label: spacingLabel(value) }))}
            onChange={(value) => update({ lineSpacing: Number(value) })}
          />
          <span id={id("paragraphs")} className="export-label-top">
            Paragraphs
          </span>
          <div className="export-checks" role="group" aria-labelledby={id("paragraphs")}>
            <Checkbox checked={settings.indent} onChange={(indent) => update({ indent })}>
              Indent first lines
            </Checkbox>
            <Checkbox checked={settings.justify} onChange={(justify) => update({ justify })}>
              Justify
            </Checkbox>
            {has("hyphenate") && (
              <Checkbox checked={settings.hyphenate} onChange={(hyphenate) => update({ hyphenate })}>
                Hyphenate
              </Checkbox>
            )}
          </div>
        </Group>
      )}

      {(has("chapterStart") || has("chapterHeading")) && (
        <Group id={id("chapters")} title="Chapters">
          {has("chapterStart") && (
            <>
              <label htmlFor={id("start")}>Start on</label>
              <Select
                id={id("start")}
                value={settings.chapterStart}
                options={CHAPTER_STARTS}
                onChange={(chapterStart) => update({ chapterStart })}
              />
            </>
          )}
          {has("chapterHeading") && (
            <>
              <label htmlFor={id("heading")}>Heading</label>
              <Select
                id={id("heading")}
                value={settings.chapterHeading}
                options={CHAPTER_HEADINGS}
                onChange={(chapterHeading) => update({ chapterHeading })}
              />
            </>
          )}
        </Group>
      )}

      {extras.length > 0 && (
        <Group id={id("extras")} title="Extras">
          <div className="export-checks export-checks--grid export-wide">
            {extras.map((key) => (
              <Checkbox key={key} checked={settings[key]} onChange={(value) => update({ [key]: value })}>
                {EXTRA_LABELS[key]}
              </Checkbox>
            ))}
          </div>
        </Group>
      )}
    </>
  );
}

const MARGIN_KEYS = ["marginInside", "marginOutside", "marginTop", "marginBottom"] as const;

const EXTRA_LABELS = {
  titlePage: "Title page",
  contents: "Contents",
  pageNumbers: "Page numbers",
  runningHeads: "Running heads",
} as const;

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="export-group" aria-labelledby={id}>
      <h3 id={id} className="section-label">
        {title}
      </h3>
      <div className="export-fields">{children}</div>
    </section>
  );
}

function Select<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <span className="select">
      <select id={id} className="input" value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="chevron" aria-hidden />
    </span>
  );
}

function Checkbox({
  checked,
  onChange,
  children,
  className,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("export-check", className)}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/**
 * A number within a range. What is typed is applied as soon as it is a
 * number in range; anything else isn't, is marked (`onValidChange`, so the
 * form can say the range), and goes back to the setting's value when the
 * field is left.
 */
function NumberField({
  id,
  unit,
  value,
  range,
  step,
  onChange,
  describedBy,
  onValidChange,
}: {
  id: string;
  /** Shown after the field. */
  unit?: string;
  value: number;
  range: { min: number; max: number };
  step: number;
  onChange(value: number): void;
  /** The note that gives the range, while what is typed is out of it. */
  describedBy: string;
  onValidChange(valid: boolean): void;
}) {
  const [draft, setDraft] = useState(String(value));
  // The setting changed from elsewhere (a preset): the field follows it.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (Number(draft) !== value) setDraft(String(value));
  }
  const parse = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
  const inRange = (n: number) => Number.isFinite(n) && n >= range.min && n <= range.max;
  const valid = inRange(parse(draft));

  const validChange = useRef(onValidChange);
  validChange.current = onValidChange;
  useEffect(() => {
    validChange.current(valid);
  }, [valid]);

  return (
    <span className="export-quantity">
      <input
        id={id}
        className="input export-number num"
        type="number"
        inputMode="decimal"
        min={range.min}
        max={range.max}
        step={step}
        value={draft}
        aria-invalid={!valid}
        aria-describedby={valid ? undefined : describedBy}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const n = parse(text);
          if (inRange(n)) onChange(n);
        }}
        onBlur={() => {
          if (!valid) setDraft(String(value));
        }}
      />
      {unit && <span className="muted">{unit}</span>}
    </span>
  );
}

/** The chapters to export, by part: each part's box chooses all or none of its chapters. */
function ChapterPicker({
  ids,
  outline,
  chosen,
  onChange,
}: {
  ids: string;
  outline: ExportSource["outline"];
  chosen: ReadonlySet<string>;
  onChange(chosen: ReadonlySet<string>): void;
}) {
  const sections = outline.filter((s) => s.chapters.length > 0);
  const total = sections.reduce((n, s) => n + s.chapters.length, 0);
  const count = sections.reduce((n, s) => n + s.chapters.filter((c) => chosen.has(c.id)).length, 0);
  const onlyOne = sections.length === 1;

  const toggle = (chapterIds: string[], on: boolean) => {
    const next = new Set(chosen);
    for (const chapterId of chapterIds) {
      if (on) next.add(chapterId);
      else next.delete(chapterId);
    }
    onChange(next);
  };

  return (
    <div className="export-chapters export-control">
      <p className="export-count num" aria-live="polite">
        {formatCount(count)} of {formatCount(total)} chapters
      </p>
      {sections.map((section, s) => {
        const sectionIds = section.chapters.map((c) => c.id);
        const inSection = sectionIds.filter((c) => chosen.has(c)).length;
        const all = inSection === sectionIds.length;
        const groupId = `${ids}-part-${s}`;
        const name = section.part ?? (onlyOne ? "All chapters" : "Not in a part");
        return (
          <div key={s} className="export-part" role="group" aria-labelledby={groupId}>
            <label className="export-check export-part-label">
              <input
                type="checkbox"
                checked={all}
                ref={(el) => {
                  if (el) el.indeterminate = inSection > 0 && !all;
                }}
                onChange={() => toggle(sectionIds, !all)}
              />
              <span id={groupId}>{name}</span>
            </label>
            <ul>
              {section.chapters.map((chapter) => (
                <li key={chapter.id}>
                  <Checkbox checked={chosen.has(chapter.id)} onChange={(on) => toggle([chapter.id], on)}>
                    {chapter.title}
                  </Checkbox>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
