import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import type { Backend, GrammarProblem, GrammarServer } from "../core/backend";
import type { TextPosition } from "../core/caret";
import type { BlockStyle, EditorHandle, FormatState } from "../core/editor/types";
import { bookContent, bookOutline, exportFileName, readExportMemory } from "../core/exportBook";
import { BUILT_IN_PRESETS, EXTENSIONS } from "../core/exportSettings";
import { NameIndex } from "../core/nameIndex";
import type { IgnoredName } from "../core/names";
import { holdsNames, type Project } from "../core/project";
import { findInChapter, matchOffsets, replaceInChapter, searchPattern, type SearchMatch, type SearchOptions } from "../core/search";
import type { EditorMode, ViewSettings } from "../core/settings";
import { addToPersonalDictionary, readPersonalDictionary } from "../core/spelling";
import { useDropbox } from "../core/useDropbox";
import { useNameSuggestions } from "../core/useNameSuggestions";
import type { useProject } from "../core/useProject";
import type { TypingAids } from "../core/editor/typingAids";
import { typographyFor } from "../core/typography";
import { useGrammar } from "../core/useGrammar";
import { useSpelling } from "../core/useSpelling";
import { TextNote } from "./AddName";
import { BACK_AGAIN, BackLayer, useBackLayer, useLeaveOnBack, type Leave } from "./BackStack";
import { Binder } from "./Binder";
import { SheetPreview } from "./BottomSheet";
import { CloseDialog } from "./CloseDialog";
import { cx, errorMessage, focusLost, hasMod, isMac, shortcut } from "./dom";
import { EditorPane } from "./EditorPane";
import { ExportDialog, type ExportChoice, type ExportSource } from "./ExportDialog";
import { FormatBar } from "./FormatBar";
import type { GrammarSource } from "./GrammarMenu";
import { HOVER_QUERY, useMediaQuery } from "./hooks";
import type { IgnoreSource } from "./IgnoreHere";
import { Inspector, type InspectorView } from "./Inspector";
import { panelStyle } from "./layoutStyle";
import type { MainMenuCommands, SaveToDropbox } from "./MainMenu";
import type { SuggestionSource } from "./PossibleNameMenu";
import {
  ProjectsDialog,
  useProjectsDialog,
  type ProjectsDropbox,
  type ProjectsIntent,
  type ProjectsSource,
} from "./Projects";
import { ResizeHandle } from "./ResizeHandle";
import { SearchPanel, type SearchSource } from "./SearchPanel";
import { SettingsDialog } from "./SettingsDialog";
import type { SpellingSource } from "./SpellingMenu";
import { StatusBar } from "./StatusBar";
import type { SwipeIntent } from "./swipe";
import { useEdgeSwipe } from "./useEdgeSwipe";
import { useOnScreenKeyboard } from "./useOnScreenKeyboard";

type ProjectApi = ReturnType<typeof useProject>;

export interface WorkspaceProps {
  api: ProjectApi;
  project: Project;
  backend: Backend;
  settings: ViewSettings;
  update(patch: Partial<ViewSettings>): void;
  isPhone: boolean;
}

const NO_FORMAT: FormatState = { bold: false, italic: false, block: "body" };

/** Focus mode marks no possible names. */
const NO_WORDS: ReadonlySet<string> = new Set();
const NO_PROBLEMS: ReadonlyMap<string, readonly GrammarProblem[]> = new Map();

const ignoredKey = (text: string, message: string) => `${text}\u0000${message}`;

/** The grammar problems without those ignored: the same map when none is. */
function withoutIgnored(
  problems: ReadonlyMap<string, readonly GrammarProblem[]>,
  ignored: ReadonlySet<string>,
): ReadonlyMap<string, readonly GrammarProblem[]> {
  if (ignored.size === 0 || problems.size === 0) return problems;
  const out = new Map<string, readonly GrammarProblem[]>();
  for (const [paragraph, found] of problems) {
    const kept = found.filter((p) => !ignored.has(ignoredKey(paragraph.slice(p.from, p.to), p.message)));
    if (kept.length > 0) out.set(paragraph, kept);
  }
  return out;
}

/**
 * The phone's name preview: which sheet, whether it is up, the name tapped
 * in the text, and a count of taps, so each one starts the preview afresh.
 */
interface Preview {
  id: string | null;
  open: boolean;
  occurrence?: IgnoredName;
  opening: number;
}

/** A sheet in the inspector, as it reads or in its form, with the name in the text it was opened from, if any. */
function sheetView(id: string, editing: boolean, occurrence: IgnoredName | undefined): InspectorView {
  return { kind: "sheet", id, ...(editing && { editing: true }), ...(occurrence && { occurrence }) };
}

/** Where focus must be for the on-screen keyboard to dock the formatting bar: the chapter text. */
const KEYBOARD_SCOPE = ".editor-pane";

/**
 * The letter of a shortcut's key, whatever the case (Caps Lock). On a
 * layout without Latin letters (Cyrillic, Greek) it is the key's place on
 * a QWERTY keyboard, as browsers do for their own shortcuts.
 */
function letter(event: KeyboardEvent): string {
  if (/^[a-z]$/iu.test(event.key)) return event.key.toLowerCase();
  return /^Key[A-Z]$/u.test(event.code) ? event.code.slice(3).toLowerCase() : "";
}

/** mod and a letter, with no other modifier: Save, Open project and Quit. */
function isModLetter(event: KeyboardEvent, key: string): boolean {
  return hasMod(event) && !event.altKey && !event.shiftKey && !event.getModifierState("AltGraph") && letter(event) === key;
}

/** Find in book: Ctrl+Shift+F, ⌘⇧F on a Mac. */
function isFindKey(event: KeyboardEvent): boolean {
  return hasMod(event) && event.shiftKey && !event.altKey && !event.getModifierState("AltGraph") && letter(event) === "f";
}

/** Find in book with the replacement showing: Ctrl+H, or ⌘⌥F on a Mac, where ⌘H hides the app (see REPLACE_KEYS). */
function isReplaceKey(event: KeyboardEvent): boolean {
  if (!isMac) return isModLetter(event, "h");
  return hasMod(event) && event.altKey && !event.shiftKey && letter(event) === "f";
}

/** mod and a key that isn't a letter, with no other modifier: "," for Settings. */
function isModKey(event: KeyboardEvent, key: string): boolean {
  return hasMod(event) && !event.altKey && !event.shiftKey && !event.getModifierState("AltGraph") && event.key === key;
}

/** Keys pressed on their way to a shortcut. */
const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph"]);

/** What focus can go to when a field left for Save or Quit is gone. */
const CONTROLS = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)";

/** Resolves once React has shown what was waiting: after the next frame. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * The main window: formatting bar on top, binder, chapter and inspector,
 * status bar at the bottom. Phones get the editor alone, with the panels as
 * overlays; focus mode hides everything but the text.
 */
export function Workspace({ api, project, backend, settings, update, isPhone }: WorkspaceProps) {
  const { openChapterId, matcher } = api;
  const chapter = openChapterId ? (project.chapters[openChapterId] ?? null) : null;
  const sheetsById = useMemo(() => new Map(project.sheets.map((s) => [s.id, s])), [project.sheets]);
  const canHover = useMediaQuery(HOVER_QUERY);
  // How often each sheet's names appear in each chapter, for the inspector and the sheet
  // preview. Kept as long as the workspace is: a new matcher (a sheet added, renamed or
  // removed, another project) starts it afresh.
  const [nameIndex] = useState(() => new NameIndex());
  // Possible names across the book, read in the background: marked in the text and listed
  // under This chapter in the inspector.
  const suggestions = useNameSuggestions(backend, project, matcher);
  // The words the spelling check accepts besides the dictionary's: the project's and this device's.
  const [personalWords, setPersonalWords] = useState(readPersonalDictionary);
  const accepted = useMemo(() => new Set([...project.dictionary, ...personalWords]), [project.dictionary, personalWords]);
  // The open chapter's misspelled words, checked a moment after typing stops.
  const spelling = useSpelling(
    backend,
    project.language,
    chapter?.text ?? null,
    matcher,
    suggestions.words,
    accepted,
    settings.spelling,
  );
  // As characters are typed: the project language's typography, and the writer's replacements.
  const { typography, replacements } = settings;
  const typingAids = useMemo<TypingAids | null>(
    () =>
      typography || replacements.length > 0
        ? { rules: typography ? typographyFor(project.language) : "none", replacements }
        : null,
    [typography, replacements, project.language],
  );
  /** Corrections and Add to dictionary, for the misspelled words' menus; null without a dictionary. */
  const { addToDictionary } = api;
  const spellingSource = useMemo<SpellingSource | null>(() => {
    const suggestWords = backend.suggestWords?.bind(backend);
    if (!suggestWords || spelling.available !== true) return null;
    return {
      suggest: (word) => suggestWords(project.language, word),
      addToProject: addToDictionary,
      addToPersonal: (word) => setPersonalWords(addToPersonalDictionary(word)),
    };
  }, [backend, project.language, spelling.available, addToDictionary]);

  // The open chapter's grammar problems: English on this device, or every language on the writer's LanguageTool server.
  const { mode: toolMode, url: toolUrl, username: toolUser, apiKey: toolKey } = settings.languageTool;
  const grammarServer = useMemo<GrammarServer | null>(() => {
    if (toolMode === "public") return { mode: "public" };
    if (toolMode === "premium") return { mode: "premium", username: toolUser, apiKey: toolKey };
    if (toolMode === "own") return { mode: "own", url: toolUrl };
    return null;
  }, [toolMode, toolUrl, toolUser, toolKey]);
  const grammar = useGrammar(backend, project.language, chapter?.text ?? null, settings.grammar, grammarServer);
  /** Problems the writer chose to ignore, as the text they cover and the message: until the app closes. */
  const [ignoredProblems, setIgnoredProblems] = useState<ReadonlySet<string>>(() => new Set());
  const problems = useMemo(() => withoutIgnored(grammar.problems, ignoredProblems), [grammar.problems, ignoredProblems]);
  const grammarSource = useMemo<GrammarSource>(
    () => ({ ignore: (hit) => setIgnoredProblems((ignored) => new Set(ignored).add(ignoredKey(hit.text, hit.message))) }),
    [],
  );

  const editorRef = useRef<EditorHandle>(null);
  const [format, setFormat] = useState<FormatState>(NO_FORMAT);
  const [inspectorView, setInspectorView] = useState<InspectorView>({ kind: "chapter" });
  const [focusMode, setFocusMode] = useState(false);
  const [barRevealed, setBarRevealed] = useState(false);
  const [phonePanel, setPhonePanel] = useState<"binder" | "inspector" | null>(null);
  const [preview, setPreview] = useState<Preview>({ id: null, open: false, opening: 0 });
  const [drag, setDrag] = useState<{ binder?: number; inspector?: number }>({});
  /** Goes up when the empty project's button asks the binder for a new chapter. */
  const [newChapterRequest, setNewChapterRequest] = useState(0);
  /** A sheet being moved to the Trash from the inspector, and its type: see the reset below. */
  const [trashedSheet, setTrashedSheet] = useState<{ id: string; folder: string } | null>(null);
  /** Save was chosen and has finished, with nothing changed since: the status bar shows a check. */
  const [saveConfirmed, setSaveConfirmed] = useState(false);

  /**
   * Find in book, in the inspector's place: closed, shown, or kept out of
   * sight with all it holds while the inspector shows a sheet (a name
   * clicked in the text, say), until Find is asked for again.
   */
  const [searchState, setSearchState] = useState<"closed" | "shown" | "kept">("closed");
  /** How Find was last asked for: Replace shows the replacement. */
  const [searchMode, setSearchMode] = useState<"find" | "replace">("find");
  /** The text's selection when Find was asked for, which it searches for. */
  const [searchSeed, setSearchSeed] = useState("");
  /** Goes up each time Find is asked for: focus goes to its field. */
  const [searchRequest, setSearchRequest] = useState(0);
  /** What Find searches for, marked in the text while it shows; null for nothing. */
  const [searchMarks, setSearchMarks] = useState<RegExp | null>(null);
  /** The inspector was hidden when Find showed it: closing Find hides it again. */
  const hideInspectorAfterSearch = useRef(false);
  /** Where Find is, to tell whether it is asked for again from inside it. */
  const searchSlotRef = useRef<HTMLDivElement>(null);

  /** The Export window, from the main menu: full screen on phones. */
  const [exportOpen, setExportOpen] = useState(false);

  // A chapter with Markdown the formatted editor can't keep is shown in Plain
  // until another chapter is opened. The mode setting itself doesn't change.
  const [plainOnlyId, setPlainOnlyId] = useState<string | null>(null);

  // The caret to restore when an editor mounts: after a mode switch, or when
  // coming back to a chapter opened earlier in this read of the project.
  // Saved carets are keyed by load, so carets from an older read never match.
  const [mountCaret, setMountCaret] = useState<{ key: string; caret: TextPosition } | null>(null);
  const carets = useRef(new Map<string, TextPosition>());
  const caretKey = (id: string) => `${api.loads}:${id}`;
  // A search result opened in another chapter: selected when its editor mounts,
  // in place of the caret, focus left in the search panel.
  const [mountSelection, setMountSelection] = useState<{ key: string; from: number; to: number } | null>(null);

  // A project read from disk, another one or the same folder again: the mount
  // caret, the plain-only flag and the inspector's place belong to the old
  // read. They are reset during render (React's pattern for state that follows
  // a prop), so the editors, remounted for the new read, never start from them.
  // A sheet moved to the Trash from the inspector, from its page or its type's
  // list, leaves the inspector on that list, which the project still has.
  const [seenLoads, setSeenLoads] = useState(api.loads);
  if (seenLoads !== api.loads) {
    setSeenLoads(api.loads);
    setMountCaret(null);
    setMountSelection(null);
    setPlainOnlyId(null);
    const back =
      trashedSheet !== null &&
      !project.sheets.some((s) => s.id === trashedSheet.id) &&
      project.sheetTypes.some((t) => t.folder === trashedSheet.folder)
        ? trashedSheet
        : null;
    setInspectorView((view) =>
      back !== null && ((view.kind === "sheet" && view.id === back.id) || (view.kind === "type" && view.folder === back.folder))
        ? { kind: "type", folder: back.folder }
        : { kind: "chapter" },
    );
    setTrashedSheet(null);
    setPreview((p) => ({ id: null, open: false, opening: p.opening }));
    setSaveConfirmed(false);
  }

  // Another project: Find, and the inspector it showed, belonged to the last one.
  const [seenRoot, setSeenRoot] = useState(project.root);
  if (seenRoot !== project.root) {
    setSeenRoot(project.root);
    setSearchState("closed");
    setSearchMarks(null);
    hideInspectorAfterSearch.current = false;
    setExportOpen(false);
  }

  // The check goes as soon as there is something to save again, or the save failed.
  if (saveConfirmed && api.save.status !== "saved") setSaveConfirmed(false);

  const plainOnly = chapter !== null && plainOnlyId === chapter.id;
  const mode: EditorMode = plainOnly ? "plain" : settings.mode;
  const editorKey = chapter ? `${chapter.id}:${mode}` : "";
  const initialCaret = mountCaret?.key === editorKey ? mountCaret.caret : null;
  const initialSelection = mountSelection?.key === editorKey ? mountSelection : null;

  const binderVisible = !focusMode && (isPhone ? phonePanel === "binder" : settings.binderOpen);
  const inspectorVisible = !focusMode && (isPhone ? phonePanel === "inspector" : settings.inspectorOpen);

  /* Phones: edge swipes and the on-screen keyboard -------------------------- */

  const mainRef = useRef<HTMLDivElement>(null);

  /** A swipe from an edge slides its panel in; one towards an open panel's edge sends it back. */
  const onSwipe = useCallback((intent: SwipeIntent) => {
    if (intent.action === "close") {
      setPhonePanel(null);
      return;
    }
    // The panel covers the text: the on-screen keyboard goes away with the caret, as when its button is pressed.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(KEYBOARD_SCOPE)) active.blur();
    setPhonePanel(intent.panel);
  }, []);

  useEdgeSwipe({ area: mainRef, enabled: isPhone && !focusMode, open: phonePanel, onSwipe });

  /**
   * While the on-screen keyboard is up for the chapter, the formatting bar
   * docks just above it and the status bar makes room, unless it has a save
   * error to show. Only the app's shell can say the keyboard is up (see the
   * hook): where nothing says so, as on desktop or in the browser preview,
   * the bars stay where they are, however the window is resized.
   */
  const keyboardUp = useOnScreenKeyboard(isPhone && !focusMode, KEYBOARD_SCOPE);
  // A save error, or the check after Save, shows even in focus mode: the writer asked, or must know.
  const statusShown = api.save.status === "error" || saveConfirmed || (!focusMode && !keyboardUp);

  // Leaving phone layout closes the overlays.
  useEffect(() => {
    if (!isPhone) {
      setPhonePanel(null);
      setPreview((p) => ({ ...p, open: false }));
    }
  }, [isPhone]);

  /* Panels ----------------------------------------------------------------- */

  const togglePanel = useCallback(
    (panel: "binder" | "inspector") => {
      if (focusMode) {
        // From focus mode, the shortcut brings that panel back.
        setFocusMode(false);
        if (!isPhone) update(panel === "binder" ? { binderOpen: true } : { inspectorOpen: true });
        return;
      }
      if (isPhone) setPhonePanel((current) => (current === panel ? null : panel));
      else if (panel === "binder") update({ binderOpen: !settings.binderOpen });
      else update({ inspectorOpen: !settings.inspectorOpen });
    },
    [focusMode, isPhone, settings.binderOpen, settings.inspectorOpen, update],
  );

  /**
   * Shows the inspector if it is hidden; on a phone it slides in, in place of
   * the binder. Find, if it is in the inspector's place, makes way, kept as
   * it is until it is asked for again.
   */
  const revealInspector = useCallback(() => {
    setSearchState((state) => (state === "shown" ? "kept" : state));
    hideInspectorAfterSearch.current = false;
    if (isPhone) setPhonePanel("inspector");
    else if (!settings.inspectorOpen) update({ inspectorOpen: true });
  }, [isPhone, settings.inspectorOpen, update]);

  /**
   * Opens a sheet in the inspector, showing the inspector if it is hidden:
   * as it reads, or in its form with `editing`. A sheet already open in its
   * form stays there. `occurrence` is the name in the text it was opened
   * from; opened from anywhere else, it has none.
   */
  const showSheet = useCallback(
    (id: string, editing: boolean, occurrence?: IgnoredName) => {
      setInspectorView((view) =>
        sheetView(id, editing || (view.kind === "sheet" && view.id === id && view.editing === true), occurrence),
      );
      revealInspector();
    },
    [revealInspector],
  );

  const openSheet = useCallback((id: string) => showSheet(id, false), [showSheet]);

  /** A sheet's Edit in the binder's menu: its form, in the inspector. */
  const editSheet = useCallback((id: string) => showSheet(id, true), [showSheet]);

  /**
   * A sheet opened from one of the inspector's own pages (This chapter, a
   * type's list): it keeps that page, which a phone's Back goes back to.
   */
  const openSheetFromInspector = useCallback((id: string) => {
    setInspectorView((view) => {
      const from = view.kind === "sheet" ? view.from : view;
      const editing = view.kind === "sheet" && view.id === id && view.editing === true;
      return { ...sheetView(id, editing, undefined), ...(from && { from }) };
    });
  }, []);

  /**
   * The inspector's own moves: its tabs, the way back to a list, Edit and
   * Done, and a sheet made or edited from a list, which keeps that list.
   */
  const changeInspectorView = useCallback((next: InspectorView) => {
    setInspectorView((view) => (next.kind === "sheet" && view.kind !== "sheet" ? { ...next, from: view } : next));
  }, []);

  /**
   * Moves a sheet to the Trash from the inspector. The project is read
   * again, and the inspector goes back to the sheet's type's list (see the
   * reset above). Rejects with a message for the writer.
   */
  const { trashSheet: trashSheetInCore } = api;
  const trashSheet = useCallback(
    async (id: string) => {
      const folder = sheetsById.get(id)?.kind;
      if (folder !== undefined) setTrashedSheet({ id, folder });
      try {
        await trashSheetInCore(id);
      } catch (error) {
        setTrashedSheet(null);
        throw error;
      }
    },
    [trashSheetInCore, sheetsById],
  );

  /** A sheet made in the binder: its form opens in the inspector, with the caret in its first field. */
  const sheetCreated = useCallback(
    (id: string) => {
      setInspectorView({ kind: "sheet", id, editing: true, created: true });
      revealInspector();
    },
    [revealInspector],
  );

  /**
   * A clicked name, or one chosen in the text's menu: the inspector on
   * desktop, with the caret kept in the text; a half-height preview on
   * phones, which takes focus itself. Either shows where the name was
   * clicked, with Ignore here, when there is such a place.
   */
  const openSheetFromText = useCallback(
    (id: string, occurrence?: IgnoredName) => {
      if (isPhone) {
        setPreview((p) => ({ id, open: true, occurrence, opening: p.opening + 1 }));
        return;
      }
      showSheet(id, false, occurrence);
      editorRef.current?.focus();
    },
    [isPhone, showSheet],
  );

  const closePreview = useCallback(() => setPreview((p) => ({ ...p, open: false })), []);

  /**
   * The phone preview's Edit: the preview makes way for the inspector, with
   * the sheet's form. It is the same opening, so Done shows where the name
   * was tapped.
   */
  const previewOccurrence = preview.occurrence;
  const editFromPreview = useCallback(
    (id: string) => {
      closePreview();
      showSheet(id, true, previewOccurrence);
    },
    [closePreview, showSheet, previewOccurrence],
  );

  /** Ignore here, wherever a name opened from the text offers it. */
  const ignoring = useMemo<IgnoreSource>(
    () => ({ ignored: project.ignoredNames, setIgnored: api.ignoreName, busy: api.switching }),
    [project.ignoredNames, api.ignoreName, api.switching],
  );

  /** The desktop app's native menu for the text, with the backend it belongs to. */
  const popupTextMenu = useMemo(() => backend.popupTextMenu?.bind(backend), [backend]);

  /** Add to and Not a name, on a possible name clicked in the text; Add to, on any text chosen by hand. */
  const suggesting = useMemo<SuggestionSource>(
    () => ({
      types: project.sheetTypes.filter((type) => holdsNames(type.folder)),
      createSheet: api.createSheet,
      markNotName: api.markNotName,
      busy: api.switching,
    }),
    [project.sheetTypes, api.createSheet, api.markNotName, api.switching],
  );

  /* Chapters and modes ----------------------------------------------------- */

  const openChapter = (id: string) => {
    if (isPhone) setPhonePanel(null);
    if (id === openChapterId) {
      editorRef.current?.focus();
      return;
    }
    if (openChapterId && editorRef.current) carets.current.set(caretKey(openChapterId), editorRef.current.getCaret());
    const caret = carets.current.get(caretKey(id));
    setMountCaret(caret ? { key: `${id}:${settings.mode}`, caret } : null);
    setMountSelection(null);
    setPlainOnlyId(null);
    setFormat(NO_FORMAT);
    api.openChapter(id);
  };

  const changeMode = (next: EditorMode) => {
    // A plain-only chapter is already in Plain, and Formatted can't show it.
    if (next === mode || plainOnly) return;
    const caret = editorRef.current?.getCaret();
    setMountCaret(chapter && caret ? { key: `${chapter.id}:${next}`, caret } : null);
    setMountSelection(null);
    update({ mode: next });
  };

  /**
   * The formatted editor can't keep this chapter's Markdown and went
   * read-only: show the chapter in Plain, with the caret it was given.
   */
  const showInPlain = useCallback((id: string) => {
    setPlainOnlyId(id);
    setMountCaret((m) => (m?.key === `${id}:formatted` ? { key: `${id}:plain`, caret: m.caret } : m));
    setMountSelection((m) => (m?.key === `${id}:formatted` ? { ...m, key: `${id}:plain` } : m));
  }, []);

  /** The binder created a chapter and opened it: on a phone, the panel makes way for it. */
  const chapterCreated = useCallback(() => {
    if (isPhone) setPhonePanel(null);
  }, [isPhone]);

  /** The empty project's button: show the binder, where the new chapter's title is typed. */
  const startFirstChapter = () => {
    setFocusMode(false);
    if (isPhone) setPhonePanel("binder");
    else if (!settings.binderOpen) update({ binderOpen: true });
    setNewChapterRequest((n) => n + 1);
  };

  /* Focus mode ------------------------------------------------------------- */

  const pointerInBar = useRef(false);
  const menuOpen = useRef(false);
  const barRef = useRef<HTMLElement>(null);

  const leaveFocus = useCallback(() => {
    setFocusMode(false);
    setBarRevealed(false);
  }, []);

  // Focus mode is for writing: the caret goes back to the text, out of the hidden bar.
  const enterFocus = useCallback(() => {
    setFocusMode(true);
    setBarRevealed(false);
    editorRef.current?.focus();
  }, []);

  const maybeHideBar = useCallback(() => {
    const focusInBar = barRef.current?.contains(document.activeElement) ?? false;
    if (!pointerInBar.current && !menuOpen.current && !focusInBar) setBarRevealed(false);
  }, []);

  const onMenuOpenChange = useCallback(
    (open: boolean) => {
      menuOpen.current = open;
      if (!open) maybeHideBar();
    },
    [maybeHideBar],
  );

  const onBarBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && barRef.current?.contains(next)) return;
    if (!pointerInBar.current && !menuOpen.current) setBarRevealed(false);
  };

  /* Find in book ------------------------------------------------------------ */

  /**
   * Find, from the main menu or its shortcuts: the panel takes the
   * inspector's place, showing the inspector's column if it is hidden (on a
   * phone, as its overlay), with focus in Find. The text's selection, if it
   * is on one line, is searched for; asked for again from the panel itself,
   * Find keeps what it holds.
   */
  const openSearch = (mode: "find" | "replace") => {
    const active = document.activeElement;
    const inPanel = searchSlotRef.current?.contains(active) ?? false;
    // A field in the inspector is left first, as a click elsewhere would leave it, so its edit is taken.
    if (!inPanel && active instanceof HTMLElement && active.closest("#inspector")) active.blur();
    setSearchSeed(inPanel ? "" : (editorRef.current?.selectedName() ?? ""));
    setSearchMode(mode);
    setSearchRequest((n) => n + 1);
    if (searchState === "closed") hideInspectorAfterSearch.current = false;
    setSearchState("shown");
    if (focusMode) leaveFocus();
    if (isPhone) setPhonePanel("inspector");
    else if (!settings.inspectorOpen) {
      hideInspectorAfterSearch.current = true;
      update({ inspectorOpen: true });
    }
  };

  /**
   * The panel's close button, or Escape: the inspector comes back, or hides
   * again if Find showed it, and the caret goes back to the text, where the
   * last result opened is selected. On a phone the overlay slides away, and
   * focus isn't put in the text, which would bring the on-screen keyboard up.
   */
  const closeSearch = () => {
    setSearchState("closed");
    setSearchMarks(null);
    if (isPhone) {
      setPhonePanel((panel) => (panel === "inspector" ? null : panel));
      return;
    }
    if (hideInspectorAfterSearch.current) update({ inspectorOpen: false });
    hideInspectorAfterSearch.current = false;
    editorRef.current?.focus();
  };

  /** What the panel searches for, marked in the text. */
  const markSearch = useCallback((query: string, options: SearchOptions) => {
    let pattern: RegExp | null = null;
    try {
      pattern = searchPattern(query, options);
    } catch {
      // The panel says why it couldn't search.
    }
    setSearchMarks(pattern);
  }, []);

  /**
   * A result chosen in the panel: selected in the text and scrolled into
   * view, marked, focus left in the panel, so Enter goes on to the next one.
   * In another chapter, that chapter opens with the result selected. On a
   * phone the panel slides away to show it; the inspector's button, or a
   * swipe, brings it back.
   */
  const openSearchResult = (match: SearchMatch) => {
    const target = project.chapters[match.chapterId];
    if (!target) return;
    const { from, to } = matchOffsets(target.text, match);
    if (isPhone) setPhonePanel(null);
    if (match.chapterId === openChapterId && editorRef.current) {
      editorRef.current.selectMarkdown(from, to);
      return;
    }
    if (openChapterId && editorRef.current) carets.current.set(caretKey(openChapterId), editorRef.current.getCaret());
    setMountCaret(null);
    setMountSelection({ key: `${match.chapterId}:${settings.mode}`, from, to });
    setPlainOnlyId(null);
    setFormat(NO_FORMAT);
    api.openChapter(match.chapterId);
  };

  /**
   * Replace and Replace all: each chapter's results replaced in its text,
   * the open chapter's through its editor, as one step Undo takes back, the
   * others saved as an edit is. `searched` is each chapter's text when it
   * was searched: one that has changed since is refused, as are edits while
   * the open chapter takes none, changing nothing. Returns how many were
   * replaced: results partly in italics or bold never are, nor the rare ones
   * whose new text would change the formatting around them, their italics or
   * bold or the paragraphs and headings on either side (see
   * replaceInChapter).
   */
  const replaceSearchResults = (
    matches: SearchMatch[],
    replacement: string,
    searched: ReadonlyMap<string, string>,
  ): number => {
    if (api.switching) throw new Error("The project is changing on disk. Try again in a moment.");
    const byChapter = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const found = byChapter.get(match.chapterId);
      if (found) found.push(match);
      else byChapter.set(match.chapterId, [match]);
    }
    const changes: { id: string; text: string; replaced: number }[] = [];
    for (const [id, found] of byChapter) {
      const text = project.chapters[id]?.text;
      if (text === undefined || text !== searched.get(id)) {
        throw new Error("The text has changed since this search. Check the results and try again.");
      }
      const result = replaceInChapter(text, found, replacement);
      if (result.replaced > 0) changes.push({ id, ...result });
    }
    // The open chapter first: if its editor takes no edits, no chapter changes.
    const inEditor = changes.find((c) => c.id === openChapterId);
    if (inEditor && !editorRef.current?.setMarkdown(inEditor.text)) {
      throw new Error("The open chapter can’t be changed right now.");
    }
    for (const change of changes) if (change !== inEditor) api.updateChapter(change.id, change.text);
    return changes.reduce((total, change) => total + change.replaced, 0);
  };

  /** Find's results per chapter, so typing in one chapter only searches that one again. */
  const searchCache = useRef(new Map<string, { text: string; key: string; matches: SearchMatch[] }>());
  /** The panel's actions as this render has them, so its source only changes with the book's text. */
  const searchActions = useRef({ open: openSearchResult, replace: replaceSearchResults });
  searchActions.current = { open: openSearchResult, replace: replaceSearchResults };

  /** The book as Find reads it: a new one whenever a chapter's text, title or place changes, and it searches again. */
  const { chapters: chaptersById, chapterOrder } = project;
  const { switching } = api;
  const searchSource = useMemo<SearchSource>(() => {
    const book = chapterOrder.flatMap((id) => (chaptersById[id] ? [chaptersById[id]] : []));
    const searched = new Map(book.map((c) => [c.id, c.text]));
    const cache = searchCache.current;
    return {
      chapters: book.map(({ id, title }) => ({ id, title })),
      find: (query, options) => {
        const key = `${Number(options.matchCase)}${Number(options.wholeWord)}${query}`;
        return book.flatMap(({ id, text }) => {
          const kept = cache.get(id);
          if (kept && kept.text === text && kept.key === key) return kept.matches;
          const matches = findInChapter(id, text, query, options);
          cache.set(id, { text, key, matches });
          return matches;
        });
      },
      open: (match) => searchActions.current.open(match),
      replace: (matches, replacement) => searchActions.current.replace(matches, replacement, searched),
      busy: switching,
    };
  }, [chaptersById, chapterOrder, switching]);

  /* Back (phones) ---------------------------------------------------------- */

  // Back leaves focus mode as Escape does, once whatever is open over it is closed.
  useBackLayer(focusMode, leaveFocus);

  /** A field in a panel that Back moves away from is left first, as a tap outside would leave it, so its edit is taken. */
  const leavePanelField = () => {
    const field = document.activeElement;
    if (field instanceof HTMLElement && field.closest(".panel")) field.blur();
  };

  const backFromBinder = () => {
    leavePanelField();
    setPhonePanel(null);
  };

  /**
   * Back in the inspector: Find in its place closes; a sheet opened from one
   * of its pages goes back to that page; else the panel closes.
   */
  const backFromInspector = () => {
    leavePanelField();
    if (searchState === "shown") {
      closeSearch();
      return;
    }
    const view = inspectorView;
    if (view.kind === "sheet" && view.from && sheetsById.has(view.id)) setInspectorView(view.from);
    else setPhonePanel(null);
  };

  /* Fields taken when left ------------------------------------------------ */

  /**
   * Quit was stopped for a field that refused its edit: the Quit right after
   * leaves without it. Anything else pressed meanwhile, or an edit taken,
   * starts over.
   */
  const quitStopped = useRef(false);
  /** A field being left for Save or Quit (see commitField): whether it refused what was typed. */
  const fieldCommit = useRef<{ refused: boolean } | null>(null);
  /** Binder changes being made, each resolving to whether it was. */
  const binderChanges = useRef(new Set<Promise<boolean>>());

  const { updateSheet: updateSheetInCore, changeBinder: changeBinderInCore } = api;
  /** useProject's updateSheet, for the inspector's form; a refusal is noted for commitField. */
  const updateSheet = useCallback<ProjectApi["updateSheet"]>(
    (id, edit) => {
      try {
        updateSheetInCore(id, edit);
      } catch (error) {
        if (fieldCommit.current) fieldCommit.current.refused = true;
        throw error;
      }
    },
    [updateSheetInCore],
  );
  /** useProject's changeBinder, for the binder; commitField waits for the changes under way, and needs them made. */
  const changeBinder = useCallback<ProjectApi["changeBinder"]>(
    (makePlan) => {
      const change = changeBinderInCore(makePlan);
      const made = change.then(
        () => true,
        () => false,
      );
      binderChanges.current.add(made);
      void made.then(() => binderChanges.current.delete(made));
      return change;
    },
    [changeBinderInCore],
  );

  // While the project on disk changes (api.switching) fields take nothing: commitField waits.
  const switchingNow = useRef(api.switching);
  const settled = useRef<(() => void)[]>([]);
  useEffect(() => {
    switchingNow.current = api.switching;
    if (!api.switching) for (const resolve of settled.current.splice(0)) resolve();
  }, [api.switching]);

  /**
   * Hands what is typed in the focused field to the project, as leaving it
   * would: a sheet's name and other names, and a title in the binder, are
   * only taken on Enter or when the field is left, and the Save and Quit
   * shortcuts leave focus where it is. The field loses focus for a moment
   * and gets it straight back, its caret or selection as it was. The
   * chapter's text is left alone: its edits are pending as they are typed.
   * The sheet's form hands its edit over at once; the binder's title starts
   * a binder change, which is waited for, as is any other under way (a
   * title left with Enter or for the menu, say). Resolves to false if the
   * field refused what was typed, or a binder change failed: each says why.
   *
   * A field can go once its edit is shown (a new field's name becomes the
   * field, a binder title its row). Focus then goes to what took its place
   * in the part of the page it was in, else to that part's first control.
   */
  const commitField = useCallback(async (): Promise<boolean> => {
    // Before waiting: each change leaves the set once it is made, or has failed.
    const changes = [...binderChanges.current];
    if (switchingNow.current) await new Promise<void>((resolve) => settled.current.push(resolve));
    const field = document.activeElement;
    let refused = false;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && !field.closest(KEYBOARD_SCOPE)) {
      const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = field;
      const part = field.closest("section, nav, [role='dialog']");
      const before = new Set(part?.querySelectorAll(CONTROLS));
      const commit = { refused: false };
      fieldCommit.current = commit;
      try {
        field.blur();
      } finally {
        fieldCommit.current = null;
      }
      refused = commit.refused;
      // At once, before anything renders, so keys typed meanwhile still go to the field.
      if (field.isConnected) {
        field.focus({ preventScroll: true });
        if (start !== null && end !== null) field.setSelectionRange(start, end, direction ?? undefined);
      }
      changes.push(...binderChanges.current);
      void Promise.all(changes)
        .then(nextFrame)
        .then(() => {
          if (field.isConnected || !focusLost()) return;
          const controls = part?.isConnected ? [...part.querySelectorAll<HTMLElement>(CONTROLS)] : [];
          const next = controls.find((c) => !before.has(c)) ?? controls[0];
          if (next) next.focus({ preventScroll: true });
          else editorRef.current?.focus();
        });
    }
    const made = await Promise.all(changes);
    const taken = !refused && made.every(Boolean);
    if (taken) quitStopped.current = false;
    return taken;
  }, []);

  /* Main menu -------------------------------------------------------------- */

  /** The menu's button: the Projects view hangs from it when opened from the menu or its shortcut. */
  const mainMenuRef = useRef<HTMLButtonElement>(null);

  /* Dropbox ---------------------------------------------------------------- */

  /** The writer's Dropbox, for Settings and the Projects view. Kept here, so a sign-in under way goes on while Settings is closed. */
  const dropbox = useDropbox(backend.dropbox);

  // Sync puts another device's edits in the open chapter through its editor: one step Undo takes back, the caret kept.
  const { setEditorWriter } = api;
  useEffect(() => {
    // Only sync writes there, and there is none without Dropbox.
    if (!backend.dropbox) return;
    setEditorWriter((markdown) => editorRef.current?.setMarkdown(markdown) ?? false);
    return () => setEditorWriter(null);
  }, [backend, setEditorWriter]);

  /** What the Projects view does with Dropbox, where the build has it. */
  const projectsDropbox: ProjectsDropbox | undefined = dropbox
    ? {
        connection:
          dropbox.view.step === "connected" ? "connected" : dropbox.view.step === "loading" ? "checking" : "none",
        put: api.putInDropbox,
        list: api.listDropboxProjects,
        open: api.openFromDropbox,
      }
    : undefined;

  /** A chapter's or a sheet's title, for the files a sync found edited on two devices. */
  const fileTitle = (path: string): string | null => project.chapters[path]?.title ?? sheetsById.get(path)?.name ?? null;

  /**
   * The list of files edited on two devices was opened, then closed: they
   * are no longer reported, and the warning goes. On desktop the caret goes
   * back to the text if focus went with the warning; phones leave it, so the
   * on-screen keyboard doesn't come up.
   */
  const { dismissConflicts: dismissConflictsInCore } = api;
  const dismissConflicts = useCallback(() => {
    dismissConflictsInCore();
    if (isPhone) return;
    void nextFrame().then(() => {
      if (focusLost()) editorRef.current?.focus();
    });
  }, [dismissConflictsInCore, isPhone]);

  const projects: ProjectsSource = {
    current: project.root,
    loads: api.loads,
    list: api.listProjects,
    open: api.openProjectAt,
    create: api.createProject,
    openFolder: backend.canOpenFolders ? api.openFolder : undefined,
    canCreate: backend.canCreateProjects,
    openUrl: backend.openUrl,
    busy: api.switching,
    phone: isPhone,
    dropbox: projectsDropbox,
  };
  /** The Projects view, opened from the binder's title, the main menu or its shortcut. */
  const projectsDialog = useProjectsDialog(projects);

  // In focus mode the bar stays in view while the Projects view hangs from its menu button.
  const barHeld = focusMode && projectsDialog.opened !== null;

  /** The Projects view, from the main menu: focus goes back to the menu's button when it closes, unless `returnFocus` says otherwise. */
  const showProjects = (intent: ProjectsIntent, returnFocus?: () => void) => {
    projectsDialog.show(intent, { anchor: mainMenuRef, returnFocus });
  };

  /**
   * Something chosen in the main menu, or its shortcut, couldn't be done: a
   * note under the menu's button says why, until the next key, press or
   * scroll.
   */
  const [refusal, setRefusal] = useState<{ title: string; message: string; at: DOMRect } | null>(null);
  const refuse = useCallback((title: string, error: unknown) => {
    const at = mainMenuRef.current?.getBoundingClientRect() ?? new DOMRect();
    setRefusal({ title, message: errorMessage(error), at });
  }, []);

  useEffect(() => {
    if (!refusal) return;
    const dismiss = () => setRefusal(null);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [refusal]);

  /**
   * Save, from the menu or its shortcut: takes the focused field's edit,
   * then writes pending edits now. The status bar shows "Saving…", then a
   * check by "Saved on this device", or why it failed, with Retry. A field
   * that refused its edit gets no check: it says why itself.
   */
  const { saveNow } = api;
  const save = useCallback(async () => {
    setSaveConfirmed(false);
    const taken = await commitField();
    await saveNow();
    if (taken) setSaveConfirmed(true);
  }, [commitField, saveNow]);

  // The check goes at the next key or press, as the writer moves on.
  useEffect(() => {
    if (!saveConfirmed) return;
    const dismiss = () => setSaveConfirmed(false);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("pointerdown", dismiss, true);
    return () => {
      window.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("pointerdown", dismiss, true);
    };
  }, [saveConfirmed]);

  /**
   * Save to Dropbox, from the main menu: once the focused field's edit and
   * any binder change under way are in, syncs the open project now, putting
   * it in Dropbox first if it is on this device only. The status bar says
   * "Syncing…" meanwhile; if it can't be done, a note under the menu's
   * button says why (a failed sync shows in the status bar too, with Retry).
   */
  const { saveToDropbox: saveToDropboxInCore } = api;
  const saveToDropbox = useCallback(async () => {
    await commitField();
    try {
      await saveToDropboxInCore();
    } catch (error) {
      refuse("Couldn’t save to Dropbox", error);
    }
  }, [commitField, saveToDropboxInCore, refuse]);

  /** Open folder…: the system's folder picker, then the folder chosen, as in the Projects view. */
  const [openingFolder, setOpeningFolder] = useState(false);
  const { openFolder } = api;
  const openFolderFromMenu = useCallback(async () => {
    setOpeningFolder(true);
    try {
      await openFolder();
    } catch (error) {
      refuse("Couldn’t open the folder", error);
    } finally {
      setOpeningFolder(false);
    }
  }, [openFolder, refuse]);

  /**
   * A Quit (or a phone's Back on the main screen) is under way, from its
   * start until it stops or the app closes: another one meanwhile is
   * ignored, as it would take the first one's refusal for its own and close
   * the app. A ref, so no render can let one through; `quitting` shows it in
   * the menu.
   */
  const quitRunning = useRef(false);
  const [quitting, setQuitting] = useState(false);
  const { mayClose } = api;

  /**
   * Closes the app with `close`, for Quit and a phone's Back: takes the
   * focused field's edit, then saves, and stays open once if the edits
   * can't be saved, so the error shows (`again` ends it: how to leave
   * anyway). A field that refused its edit stops the first try too, so its
   * reason shows. If `close` fails, a note titled `failed` says why.
   */
  const leaveApp = useCallback(
    async (close: () => Promise<void>, failed: string, again?: string) => {
      if (quitRunning.current) return;
      quitRunning.current = true;
      setQuitting(true);
      try {
        const taken = await commitField();
        if (!taken && !quitStopped.current) {
          quitStopped.current = true;
          return;
        }
        quitStopped.current = false;
        if (!(await mayClose(again))) return;
        await close();
      } catch (error) {
        refuse(failed, error);
      } finally {
        quitRunning.current = false;
        setQuitting(false);
      }
    },
    [commitField, mayClose, refuse],
  );

  /**
   * The close dialog, in the desktop app: open while the writer chooses,
   * with what answers the close it was opened for (true closes the window).
   */
  const [closeAsk, setCloseAsk] = useState<{ answer(close: boolean): void } | null>(null);
  /** Save and close was chosen and the save is being written. */
  const [savingToClose, setSavingToClose] = useState(false);
  const { holdAutosave, setCloseHandler } = api;

  /**
   * Whether the window may close, asked when its close button, Quit or
   * Ctrl+Q closes it: takes the focused field's edit, then asks in the close
   * dialog, autosave waiting meanwhile. A field that refused its edit stops
   * the first close, so its reason shows; the next goes on without it. A
   * close asked for while one is being decided is refused: that one goes on.
   */
  const confirmClose = useCallback(async (): Promise<boolean> => {
    if (quitRunning.current) return false;
    quitRunning.current = true;
    setQuitting(true);
    let resume: (() => void) | null = null;
    let close = false;
    try {
      const taken = await commitField();
      if (!taken && !quitStopped.current) {
        quitStopped.current = true;
        return false;
      }
      quitStopped.current = false;
      resume = holdAutosave();
      close = await new Promise<boolean>((answer) => setCloseAsk({ answer }));
      return close;
    } finally {
      setCloseAsk(null);
      setSavingToClose(false);
      if (!close) {
        resume?.();
        // Quit's menu item is gone: back to the text, unless the dialog put focus back where it was.
        void nextFrame().then(() => {
          if (focusLost()) editorRef.current?.focus();
        });
      }
      quitRunning.current = false;
      setQuitting(false);
    }
  }, [commitField, holdAutosave]);

  // The desktop app asks before its window closes; elsewhere useProject's own check runs.
  const closeAskRef = useRef(closeAsk);
  closeAskRef.current = closeAsk;
  useEffect(() => {
    if (!backend.closeWindow) return;
    setCloseHandler(confirmClose);
    return () => {
      setCloseHandler(null);
      // Gone with the workspace: the window stays, as if Cancel had been chosen.
      closeAskRef.current?.answer(false);
    };
  }, [backend, confirmClose, setCloseHandler]);

  const { hasUnsaved, discardPending } = api;
  const closeDialog = {
    cancel: () => closeAsk?.answer(false),
    close: () => closeAsk?.answer(true),
    discard: () => {
      discardPending();
      closeAsk?.answer(true);
    },
    /** Writes the pending edits, then closes; if they can't be written the dialog says why and stays. */
    saveAndClose: async () => {
      const ask = closeAsk;
      if (!ask || savingToClose) return;
      setSavingToClose(true);
      try {
        await saveNow();
      } finally {
        setSavingToClose(false);
      }
      if (!hasUnsaved()) ask.answer(true);
    },
  };

  /** Quit, in the desktop app: closes the window as its own close button does, so the close dialog asks first. */
  const quit = useMemo(
    () =>
      backend.closeWindow
        ? async () => {
            try {
              await backend.closeWindow?.();
            } catch (error) {
              refuse("Couldn’t quit", error);
            }
          }
        : undefined,
    [backend, refuse],
  );

  /** A phone's Back with nothing open on top: Quit's checks, then the app closes, unless something opened meanwhile. */
  const leaveOnBack = useCallback<Leave>(
    (nothingOpen) =>
      leaveApp(
        async () => {
          if (nothingOpen()) await backend.exitApp?.();
        },
        "Couldn’t close the app",
        BACK_AGAIN,
      ),
    [backend, leaveApp],
  );
  useLeaveOnBack(leaveOnBack);

  // Only the Quit right after a stopped one leaves without the field's edit:
  // any other key or press starts over, Ctrl on its way to Ctrl+Q aside.
  useEffect(() => {
    const startOver = (event: Event) => {
      if (event instanceof KeyboardEvent && (MODIFIER_KEYS.has(event.key) || isModLetter(event, "q"))) return;
      quitStopped.current = false;
    };
    window.addEventListener("keydown", startOver, true);
    window.addEventListener("pointerdown", startOver, true);
    return () => {
      window.removeEventListener("keydown", startOver, true);
      window.removeEventListener("pointerdown", startOver, true);
    };
  }, []);

  /** The Settings dialog, from the main menu or its shortcut: a sheet on phones. */
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * The dialog puts focus back where it was when it opened. Opened from the
   * main menu, that was the menu's item, gone with the menu: on desktop the
   * caret goes back to the text instead. Phones leave it, as their other
   * sheets do, so the on-screen keyboard doesn't come up.
   */
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (isPhone) return;
    void nextFrame().then(() => {
      if (focusLost()) editorRef.current?.focus();
    });
  }, [isPhone]);

  /** The Export window closes as Settings does: back to the text on desktop, focus left alone on phones. */
  const closeExport = useCallback(() => {
    setExportOpen(false);
    if (isPhone) return;
    void nextFrame().then(() => {
      if (focusLost()) editorRef.current?.focus();
    });
  }, [isPhone]);

  /** The project as this render has it, for the Export window to read when it lays out pages or writes the file. */
  const projectNow = useRef(project);
  projectNow.current = project;

  /**
   * What the Export window works from, while it is open: the book's parts
   * and chapters, the built-in presets and the project's own, the last
   * export's settings, and the core's layout, pages and export. Made again
   * only when one of those changes, not on every render, so the window isn't
   * handed a new source while it is open. The chapters' text is read when
   * the pages are laid out or the file is written, so the latest edits are in.
   */
  const { binder, title: projectTitle, json: projectJson } = project;
  const { saveExportPreset, rememberExport } = api;
  const exportSource = useMemo<ExportSource | null>(() => {
    if (!exportOpen) return null;
    const memory = readExportMemory(projectJson);
    const first = BUILT_IN_PRESETS[0];
    const book = (choice: ExportChoice) => bookContent(projectNow.current, choice.chapterIds, choice.author);
    const layOutBook = backend.layOutBook?.bind(backend);
    const bookPage = backend.bookPage?.bind(backend);
    const exportBook = backend.exportBook?.bind(backend);
    const source: ExportSource = {
      // Reads only the binder and the chapters' titles, which the memo follows.
      outline: bookOutline(project),
      title: projectTitle,
      author: memory.author,
      presets: [
        ...BUILT_IN_PRESETS.map((p) => ({ ...p, builtIn: true })),
        ...memory.presets.map((p) => ({ ...p, builtIn: false })),
      ],
      initial: memory.last ?? { presetName: first.name, settings: first.settings, format: "pdf" },
      export: async (choice) => {
        if (!exportBook) throw new Error("The browser preview can’t save files. Use the desktop or Android app.");
        const fileName = exportFileName(projectNow.current.title, EXTENSIONS[choice.format]);
        return exportBook(book(choice), choice.settings, choice.format, fileName);
      },
      savePreset: (name, settings) => {
        // useProject would leave project.json as it is meanwhile, and the window would show the preset as saved.
        if (switching) throw new Error("The project is changing on disk. Try again in a moment.");
        saveExportPreset(name, settings);
      },
      remember: rememberExport,
    };
    if (layOutBook) source.layOut = async (choice) => layOutBook(book(choice), choice.settings);
    if (bookPage) source.page = bookPage;
    return source;
  }, [exportOpen, binder, chaptersById, projectTitle, projectJson, backend, switching, saveExportPreset, rememberExport]);

  /** Save to Dropbox in the main menu: none in app builds without Dropbox, and waiting for the app in the browser preview. */
  let dropboxSave: SaveToDropbox | undefined;
  if (!dropbox) dropboxSave = backend.kind === "browser" ? "needsApp" : undefined;
  else if (dropbox.view.step === "loading" || api.sync.status === "syncing") dropboxSave = "waiting";
  else dropboxSave = dropbox.view.step === "connected" ? "ready" : "connect";

  const mainMenu: MainMenuCommands = {
    canCreateProjects: backend.canCreateProjects,
    onNewProject: () => showProjects("new"),
    onOpenProject: () => showProjects("open"),
    onOpenFolder: backend.canOpenFolders
      ? () => {
          // Back in the text if no folder is chosen; a project that opens puts its own text there.
          editorRef.current?.focus();
          void openFolderFromMenu();
        }
      : undefined,
    onSave: () => {
      editorRef.current?.focus();
      void save();
    },
    saving: api.save.status === "saving",
    saveToDropbox: dropboxSave,
    onSaveToDropbox: () => {
      if (dropboxSave === "ready") {
        editorRef.current?.focus();
        void saveToDropbox();
      } else if (dropboxSave === "connect") {
        // Not connected, or a sign-in under way: Settings, where Dropbox is connected.
        setSettingsOpen(true);
      }
    },
    onExport: () => setExportOpen(true),
    onFind: () => openSearch("find"),
    onReplace: () => openSearch("replace"),
    onSettings: () => setSettingsOpen(true),
    // The bar comes back with the pointer at the top edge, which touch screens don't have.
    onToggleFocus:
      canHover || focusMode
        ? () => {
            if (!focusMode) {
              enterFocus();
              return;
            }
            leaveFocus();
            editorRef.current?.focus();
          }
        : undefined,
    onQuit: quit,
    quitting,
    busy: api.switching || openingFolder,
    showShortcuts: canHover,
  };

  /* Keyboard --------------------------------------------------------------- */

  /** A shortcut's Projects view: focus goes back where it was, the text if it was there or nowhere. */
  const showProjectsFromKeys = (intent: ProjectsIntent) => {
    const previous = document.activeElement;
    showProjects(intent, () => {
      if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body && !previous.closest(KEYBOARD_SCOPE)) {
        previous.focus({ preventScroll: true });
      } else {
        editorRef.current?.focus();
      }
    });
  };

  const asking = closeAsk !== null;
  const keys = useRef({ togglePanel, enterFocus, leaveFocus, settings, update, focusMode, phonePanel, save, showProjectsFromKeys, quit, asking, settingsOpen, exportOpen, openSearch });
  keys.current = { togglePanel, enterFocus, leaveFocus, settings, update, focusMode, phonePanel, save, showProjectsFromKeys, quit, asking, settingsOpen, exportOpen, openSearch };

  useEffect(() => {
    // Capture phase, so these work whichever editor has focus.
    const onShortcut = (event: KeyboardEvent) => {
      const k = keys.current;
      // The close dialog is a decision, and Settings and Export have their own keys (Escape, Tab): nothing changes behind them.
      if (k.asking || k.settingsOpen || k.exportOpen) return;
      if (event.key === "F11") {
        event.preventDefault();
        if (k.focusMode) k.leaveFocus();
        else k.enterFocus();
        return;
      }
      if (!hasMod(event) || event.getModifierState("AltGraph")) return;
      if (isModLetter(event, "s")) {
        // Never the browser's Save page.
        event.preventDefault();
        void k.save();
      } else if (isModLetter(event, "o")) {
        event.preventDefault();
        if (!event.repeat) k.showProjectsFromKeys("open");
      } else if (isModLetter(event, "q") && k.quit) {
        event.preventDefault();
        if (!event.repeat) void k.quit();
      } else if (isModKey(event, ",")) {
        event.preventDefault();
        if (!event.repeat) setSettingsOpen(true);
      } else if (isFindKey(event)) {
        // Never the browser's own find.
        event.preventDefault();
        if (!event.repeat) k.openSearch("find");
      } else if (isReplaceKey(event)) {
        // Never the browser's history (Ctrl+H).
        event.preventDefault();
        if (!event.repeat) k.openSearch("replace");
      } else if (event.altKey && event.code === "KeyB") {
        event.preventDefault();
        k.togglePanel("binder");
      } else if (event.altKey && event.code === "KeyI") {
        event.preventDefault();
        k.togglePanel("inspector");
      } else if (!event.altKey && (event.key === "+" || event.key === "=" || event.code === "NumpadAdd")) {
        event.preventDefault();
        k.update({ fontSize: k.settings.fontSize + 1 });
      } else if (!event.altKey && (event.key === "-" || event.code === "NumpadSubtract")) {
        event.preventDefault();
        k.update({ fontSize: k.settings.fontSize - 1 });
      }
    };
    // Bubble phase: an open menu or sheet handles Escape first and stops it.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const k = keys.current;
      if (k.asking || k.settingsOpen || k.exportOpen) return;
      if (k.phonePanel) setPhonePanel(null);
      else if (k.focusMode) k.leaveFocus();
    };
    window.addEventListener("keydown", onShortcut, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onShortcut, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, []);

  /* Editor commands -------------------------------------------------------- */

  const run = (command: (handle: EditorHandle) => void) => {
    if (editorRef.current) command(editorRef.current);
  };

  const empty = (
    <div className="editor-empty">
      <h2>{project.title} has no chapters yet</h2>
      <p className="muted">
        Each chapter is a Markdown file in the project’s <code className="path">manuscript/</code> folder. Name the
        first one in the binder.
      </p>
      <div className="editor-empty-actions">
        <button type="button" className="btn btn--primary" onClick={startFirstChapter} disabled={api.switching}>
          New chapter
        </button>
      </div>
    </div>
  );

  return (
    <div
      className={cx(
        "workspace",
        isPhone ? "is-phone" : "is-desktop",
        focusMode && "is-focus",
        keyboardUp && "is-keyboard",
        (drag.binder !== undefined || drag.inspector !== undefined) && "is-resizing",
      )}
      style={panelStyle(settings, drag)}
    >
      {focusMode && <div className="reveal-zone" aria-hidden onPointerEnter={() => setBarRevealed(true)} />}

      <header
        ref={barRef}
        className={cx("bar-slot", (barRevealed || barHeld) && "is-revealed")}
        onPointerEnter={() => {
          pointerInBar.current = true;
        }}
        onPointerLeave={() => {
          pointerInBar.current = false;
          maybeHideBar();
        }}
        onFocus={() => focusMode && setBarRevealed(true)}
        onBlur={onBarBlur}
      >
        <FormatBar
          settings={settings}
          update={update}
          format={format}
          hasChapter={chapter !== null}
          onBold={() => run((h) => h.toggleBold())}
          onItalic={() => run((h) => h.toggleItalic())}
          onBlockStyle={(style: BlockStyle) => run((h) => h.setBlockStyle(style))}
          onSceneBreak={() => run((h) => h.insertSceneBreak())}
          mode={mode}
          formattedUnavailable={plainOnly}
          onModeChange={changeMode}
          binderOpen={binderVisible}
          inspectorOpen={inspectorVisible}
          onToggleBinder={() => togglePanel("binder")}
          onToggleInspector={() => togglePanel("inspector")}
          focusMode={focusMode}
          onLeaveFocus={leaveFocus}
          mainMenu={mainMenu}
          mainMenuRef={mainMenuRef}
          onMenuOpenChange={onMenuOpenChange}
          onRefocus={() => editorRef.current?.focus()}
        />
      </header>

      <div ref={mainRef} className="workspace-main">
        {/*
          A phone's panel is something Back closes, after what is open in it.
          A hidden panel holds nothing Back can close; a desktop's is part of the screen.
        */}
        <BackLayer open={isPhone && binderVisible} hidden={!binderVisible} onBack={backFromBinder}>
          <div id="binder" className={cx("panel panel--binder", binderVisible && "is-open")} inert={!binderVisible}>
            <div className="panel-inner">
              <Binder
                project={project}
                openChapterId={openChapterId}
                onOpenChapter={openChapter}
                onOpenSheet={openSheet}
                onEditSheet={editSheet}
                projects={projectsDialog}
                onChange={changeBinder}
                onChapterDetails={api.updateChapterDetails}
                onCreateSheet={api.createSheet}
                onSheetCreated={sheetCreated}
                busy={api.switching}
                onChapterCreated={chapterCreated}
                newChapterRequest={newChapterRequest}
              />
            </div>
            {!isPhone && (
              <ResizeHandle
                panel="binder"
                width={drag.binder ?? settings.binderWidth}
                label="Binder width"
                onDrag={(width) => setDrag((d) => ({ ...d, binder: width ?? undefined }))}
                onCommit={(binderWidth) => update({ binderWidth })}
              />
            )}
          </div>
        </BackLayer>

        <EditorPane
          // The editors read their text on mount. Chapter ids are paths inside
          // the project, so a newly read project (another one, or the same
          // folder after outside edits) can open the same id: remount on every
          // load, never reuse an editor holding the old text.
          key={api.loads}
          chapter={chapter}
          matcher={matcher}
          settings={settings}
          mode={mode}
          plainOnly={plainOnly}
          onUnsupportedMarkdown={showInPlain}
          readOnly={api.switching}
          editorRef={editorRef}
          initialCaret={initialCaret}
          initialSelection={initialSelection}
          onChange={api.updateChapter}
          onFormatChange={setFormat}
          onOpenSheet={focusMode ? null : openSheetFromText}
          ignoring={ignoring}
          // Focus mode is for writing without distractions: no marks, no menu.
          suggestions={focusMode ? NO_WORDS : suggestions.words}
          suggesting={focusMode ? null : suggesting}
          misspelled={focusMode ? NO_WORDS : spelling.misspelled}
          spelling={focusMode ? null : spellingSource}
          grammar={focusMode ? NO_PROBLEMS : problems}
          grammarSource={focusMode ? null : grammarSource}
          typingAids={typingAids}
          typewriter={settings.typewriter}
          // Find's matches, while it is in the inspector's place; focus mode hides them with the panel.
          search={searchState === "shown" && !focusMode ? searchMarks : null}
          popupTextMenu={popupTextMenu}
          touch={!canHover}
          sheetsById={sheetsById}
          hoverCards={canHover && !isPhone}
          empty={empty}
        />

        <BackLayer open={isPhone && inspectorVisible} hidden={!inspectorVisible} onBack={backFromInspector}>
          <div
            id="inspector"
            className={cx("panel panel--inspector", inspectorVisible && "is-open")}
            inert={!inspectorVisible}
          >
            {!isPhone && (
              <ResizeHandle
                panel="inspector"
                width={drag.inspector ?? settings.inspectorWidth}
                label="Inspector width"
                onDrag={(width) => setDrag((d) => ({ ...d, inspector: width ?? undefined }))}
                onCommit={(inspectorWidth) => update({ inspectorWidth })}
              />
            )}
            <div className="panel-inner">
              {searchState !== "closed" && (
                // Kept out of sight, nothing in it is for Back to close.
                <BackLayer open={false} hidden={searchState === "kept"} onBack={closeSearch}>
                  <div ref={searchSlotRef} className="search-slot" hidden={searchState === "kept"}>
                    <SearchPanel
                      source={searchSource}
                      focusRequest={searchRequest}
                      initialMode={searchMode}
                      initialQuery={searchSeed}
                      onSearchChange={markSearch}
                      onClose={closeSearch}
                    />
                  </div>
                </BackLayer>
              )}
              {searchState !== "shown" && (
                <Inspector
                  project={project}
                  chapter={chapter}
                  matcher={matcher}
                  index={nameIndex}
                  sheetsById={sheetsById}
                  view={inspectorView}
                  onViewChange={changeInspectorView}
                  onOpenSheet={openSheetFromInspector}
                  onOpenChapter={openChapter}
                  onChapterDetails={api.updateChapterDetails}
                  onCreateSheet={api.createSheet}
                  onUpdateSheet={updateSheet}
                  onTrashSheet={trashSheet}
                  ignoring={ignoring}
                  suggestions={suggestions}
                  onMarkNotName={api.markNotName}
                  busy={api.switching}
                  versions={{
                    list: api.listVersions,
                    restore: api.restoreVersion,
                    saveStatus: api.save.status,
                    loads: api.loads,
                    busy: api.switching,
                  }}
                  visible={inspectorVisible}
                />
              )}
            </div>
          </div>
        </BackLayer>

        {isPhone && (
          <button
            type="button"
            className={cx("scrim", phonePanel && "is-open")}
            aria-label={
              phonePanel === "binder" ? "Close binder" : searchState === "shown" ? "Hide Find in book" : "Close inspector"
            }
            tabIndex={-1}
            inert={!phonePanel}
            onClick={() => setPhonePanel(null)}
          />
        )}
      </div>

      {statusShown && (
        <StatusBar
          chapterWords={chapter?.wordCount ?? null}
          bookWords={api.bookWords}
          wordsToday={api.wordsToday}
          language={project.language}
          save={api.save}
          onRetry={api.saveNow}
          confirmed={saveConfirmed}
          backendKind={backend.kind}
          problems={project.problems}
          grammarError={grammar.error}
          compact={isPhone}
          sync={api.sync}
          onSyncNow={api.syncNow}
          onDismissConflicts={dismissConflicts}
          fileTitle={fileTitle}
        />
      )}

      {isPhone && (
        <SheetPreview
          sheet={preview.id ? (sheetsById.get(preview.id) ?? null) : null}
          open={preview.open}
          onClose={closePreview}
          onEdit={editFromPreview}
          occurrence={preview.occurrence}
          ignoring={ignoring}
          opening={preview.opening}
          appearances={{
            index: nameIndex,
            project,
            matcher,
            openChapterId,
            onOpenChapter: openChapter,
            busy: api.switching,
          }}
        />
      )}

      <ProjectsDialog dialog={projectsDialog} />

      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        isPhone={isPhone}
        settings={settings}
        update={update}
        language={project.language}
        onLanguageChange={api.setLanguage}
        openUrl={backend.openUrl}
        dropbox={dropbox}
      />

      {exportSource && <ExportDialog open source={exportSource} onClose={closeExport} isPhone={isPhone} />}

      <CloseDialog
        open={closeAsk !== null}
        save={api.save}
        closing={savingToClose}
        onCancel={closeDialog.cancel}
        onClose={closeDialog.close}
        onDiscard={closeDialog.discard}
        onSaveAndClose={() => void closeDialog.saveAndClose()}
      />

      {refusal && <TextNote at={refusal.at} title={refusal.title} message={refusal.message} />}

      {focusMode && (
        <p className="visually-hidden" role="status">
          Focus mode. Press Escape or {shortcut("F11")} to leave.
        </p>
      )}
      {/* Here rather than in the status bar, which focus mode only shows once the save is done. */}
      <p className="visually-hidden" role="status">
        {saveConfirmed ? (backend.kind === "browser" ? "Saved in this tab." : "Saved on this device.") : ""}
      </p>
      {/* Present before a refusal from the main menu, so screen readers announce it. */}
      <p className="visually-hidden" role="alert">
        {refusal ? `${refusal.title}. ${refusal.message}` : ""}
      </p>
    </div>
  );
}
