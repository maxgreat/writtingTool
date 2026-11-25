import { Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { TEXT_MENU_SEPARATOR, type Backend, type GrammarProblem, type TextMenuEntry } from "../core/backend";
import type { TextPosition } from "../core/caret";
import { FormattedEditor } from "../core/editor/FormattedEditor";
import { grammarMarkAt, nameMarkAt, NAME_MARK_CLASS, type GrammarHit } from "../core/editor/nameMarks";
import { PlainEditor } from "../core/editor/PlainEditor";
import type { EditorHandle, EditorWord, FormatState, NameHit, SuggestionHit } from "../core/editor/types";
import type { IgnoredName, NameMatcher } from "../core/names";
import type { Chapter, Sheet, SheetType } from "../core/project";
import type { EditorMode, ViewSettings } from "../core/settings";
import { spellingKey } from "../core/spelling";
import {
  AddNameButton,
  AddNameMenu,
  nameTargetAt,
  TextNote,
  textMenuItems,
  useSelectionOffer,
  type NameTarget,
} from "./AddName";
import { errorMessage, tokenMs, tokenPx } from "./dom";
import { grammarCopy, GrammarMenu, grammarTextMenuItems, type GrammarSource } from "./GrammarMenu";
import type { IgnoreSource } from "./IgnoreHere";
import { editorStyle } from "./layoutStyle";
import { NameCard, NameChoice } from "./NameCard";
import { PossibleNameMenu, type SuggestionSource } from "./PossibleNameMenu";
import {
  spellingCopy,
  SpellingMenu,
  spellingTextMenuItems,
  WORD_CHANGED,
  type Corrections,
  type SpellingSource,
} from "./SpellingMenu";

/** The note saying why a chapter is open in Plain; the mode switch points to it. */
export const PLAIN_ONLY_NOTE_ID = "plain-only-note";

export interface EditorPaneProps {
  chapter: Chapter | null;
  matcher: NameMatcher;
  settings: ViewSettings;
  /** The mode the chapter is shown in: the mode setting, or Plain for a plain-only chapter. */
  mode: EditorMode;
  /** The chapter uses Markdown the formatted editor can't keep, so it is shown in Plain. */
  plainOnly: boolean;
  /** The formatted editor found Markdown it can't keep in this chapter and went read-only. */
  onUnsupportedMarkdown(chapterId: string): void;
  /** Another project is opening: the text can't be edited until it has. */
  readOnly: boolean;
  editorRef: RefObject<EditorHandle | null>;
  /** Where the caret goes when the editor mounts, if anywhere. */
  initialCaret: TextPosition | null;
  onChange(chapterId: string, markdown: string): void;
  onFormatChange(state: FormatState): void;
  /**
   * Opens a sheet for a name clicked, or chosen in the text's menu, with the
   * occurrence clicked if there is one (for Ignore here); null in focus mode,
   * where a click only places the caret.
   */
  onOpenSheet: ((id: string, occurrence?: IgnoredName) => void) | null;
  /** Ignore here, in the choice offered for a name shared by several sheets. */
  ignoring: IgnoreSource;
  /**
   * Possible names to mark in the text (useNameSuggestions' words): none in
   * focus mode. The same set while its words don't change.
   */
  suggestions: ReadonlySet<string>;
  /**
   * Add to and Not a name, offered when a marked word is clicked, and Add to
   * for any word or selection chosen by hand; null in focus mode.
   */
  suggesting: SuggestionSource | null;
  /**
   * Misspelled words to mark in the text (useSpelling's words, as spelling
   * keys): none in focus mode. The same set while its words don't change.
   */
  misspelled: ReadonlySet<string>;
  /**
   * Corrections and Add to dictionary, offered for a misspelled word
   * right-clicked, or tapped on a touch screen; null in focus mode, and
   * where there is no dictionary for the project's language.
   */
  spelling: SpellingSource | null;
  /**
   * Grammar problems to mark in the text (useGrammar's, less those ignored),
   * by each paragraph's text as it reads: none in focus mode. The same map
   * while they don't change.
   */
  grammar: ReadonlyMap<string, readonly GrammarProblem[]>;
  /**
   * Fixes and Ignore, offered for a grammar problem right-clicked, or tapped
   * on a touch screen; null in focus mode.
   */
  grammarSource: GrammarSource | null;
  /**
   * The desktop app's native menu for the text (Backend.popupTextMenu),
   * which a right-click shows; absent in the browser preview and on phones.
   */
  popupTextMenu?: Backend["popupTextMenu"];
  /**
   * A touch screen with no real pointer: long-press menus stay the system's,
   * and a selection that could be a name offers Add as name.
   */
  touch: boolean;
  sheetsById: Map<string, Sheet>;
  /** Hover summary cards, for devices with a real pointer. */
  hoverCards: boolean;
  /** What to show when there is no chapter to open. */
  empty: ReactNode;
}

/**
 * Where a menu on a mark right-clicked at (x, y) hangs from: under the line
 * of the mark the pointer is on, at the pointer, so the text it is about
 * stays in sight. The point itself if the mark has no box there.
 */
function underMarkLine(mark: Element, x: number, y: number): DOMRect {
  const line = [...mark.getClientRects()].find((r) => y >= r.top && y <= r.bottom);
  return line ? new DOMRect(x, line.top, 0, line.height) : new DOMRect(x, y, 0, 0);
}

/** The open chapter as a centred column, in Formatted or Plain mode. */
export function EditorPane({
  chapter,
  matcher,
  settings,
  mode,
  plainOnly,
  onUnsupportedMarkdown,
  readOnly,
  editorRef,
  initialCaret,
  onChange,
  onFormatChange,
  onOpenSheet,
  ignoring,
  suggestions,
  suggesting,
  misspelled,
  spelling,
  grammar,
  grammarSource,
  popupTextMenu,
  touch,
  sheetsById,
  hoverCards,
  empty,
}: EditorPaneProps) {
  const [hover, setHover] = useState<NameHit | null>(null);
  const [choice, setChoice] = useState<NameHit | null>(null);
  /** The possible name whose menu is open, and a count of openings, so each click starts the menu afresh. */
  const [suggestion, setSuggestion] = useState<{ hit: SuggestionHit; opening: number } | null>(null);
  const openings = useRef(0);
  /** Text chosen by hand to add as a name, whose menu is open: a right-click, or Add as name on a touch screen. */
  const [naming, setNaming] = useState<{ target: NameTarget; anchor: DOMRect; opening: number } | null>(null);
  /**
   * The misspelled word whose menu is open: as written, and where it is in
   * the editor (null if it couldn't be found there, so it can't be corrected).
   */
  const [correcting, setCorrecting] = useState<{
    written: string;
    word: EditorWord | null;
    anchor: DOMRect;
    opening: number;
  } | null>(null);
  /**
   * The grammar problem whose menu is open: the mark, and where its text is
   * in the editor (null if it couldn't be found there, so it can't be fixed).
   */
  const [fixing, setFixing] = useState<{
    hit: GrammarHit;
    range: EditorWord | null;
    anchor: DOMRect;
    opening: number;
  } | null>(null);
  /** Counts right-clicks in the desktop app: a native menu waiting for its corrections gives way to a later one. */
  const textMenus = useRef(0);
  /** Why something chosen in the native text menu didn't happen, shown where the menu was. */
  const [refusal, setRefusal] = useState<{ title: string; message: string; at: DOMRect } | null>(null);
  /** A sheet chosen in the native text menu is being made: its items wait. */
  const adding = useRef(false);
  /** Said to screen readers: what a possible name or a misspelled word became. Here, as the menu closes when it is done. */
  const [note, setNote] = useState("");
  const hovered = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paneRef = useRef<HTMLElement>(null);

  // Touch screens: a selection that could be a name, for Add as name. Focus mode offers none.
  const offer = useSelectionOffer(touch && suggesting !== null, editorRef, paneRef, matcher);

  // Focus mode takes the marks away, and the menus with them.
  if (!suggesting && suggestion) setSuggestion(null);
  if (!suggesting && naming) setNaming(null);
  if (!spelling && correcting) setCorrecting(null);
  if (!grammarSource && fixing) setFixing(null);

  const hideCard = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    hovered.current = null;
    setHover(null);
  }, []);

  useEffect(() => hideCard, [hideCard]);

  // A refusal from the native menu goes at the next key, press or scroll, as the writer moves on.
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

  // Typing or scrolling puts the card away.
  useEffect(() => {
    if (!hover) return;
    window.addEventListener("keydown", hideCard, true);
    window.addEventListener("scroll", hideCard, true);
    return () => {
      window.removeEventListener("keydown", hideCard, true);
      window.removeEventListener("scroll", hideCard, true);
    };
  }, [hover, hideCard]);

  const onMouseOver = (event: MouseEvent) => {
    if (!hoverCards) return;
    const mark = event.target instanceof Element ? event.target.closest(`.${NAME_MARK_CLASS}`) : null;
    if (mark === hovered.current) return;
    hideCard();
    hovered.current = mark;
    if (!mark) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mark.isConnected) setHover(nameMarkAt(mark));
    }, tokenMs("--duration-hover-delay"));
  };

  const onNameClick = (hit: NameHit) => {
    hideCard();
    if (!onOpenSheet) return;
    setSuggestion(null);
    setNaming(null);
    setCorrecting(null);
    setFixing(null);
    if (hit.ambiguous) setChoice(hit);
    else onOpenSheet(hit.sheetIds[0], hit.occurrence);
  };

  /** A word marked as a possible name: its menu, anchored to it, on desktop and phones alike. */
  const onSuggestionClick = (hit: SuggestionHit) => {
    hideCard();
    if (!suggesting) return;
    setChoice(null);
    setNaming(null);
    setCorrecting(null);
    setFixing(null);
    openings.current += 1;
    setSuggestion({ hit, opening: openings.current });
  };

  const closeSuggestion = useCallback(() => {
    setSuggestion(null);
    editorRef.current?.focus();
  }, [editorRef]);

  const sheetsOf = (ids: string[]) => ids.map((id) => sheetsById.get(id)).filter((s): s is Sheet => !!s);

  /** The menu for text chosen by hand, hung from `anchor`, if it has something to offer. */
  const openNaming = (target: NameTarget, anchor: DOMRect) => {
    const offers = target.known ? sheetsOf(target.sheetIds).length : (suggesting?.types.length ?? 0);
    if (offers === 0) return false;
    hideCard();
    setSuggestion(null);
    setChoice(null);
    setCorrecting(null);
    setFixing(null);
    openings.current += 1;
    setNaming({ target, anchor, opening: openings.current });
    return true;
  };

  const closeNaming = useCallback(() => {
    setNaming(null);
    editorRef.current?.focus();
  }, [editorRef]);

  /** Add to, chosen in the native menu: the text keeps the caret; a refusal shows where the menu was. */
  const addFromTextMenu = async (source: SuggestionSource, name: string, type: SheetType, at: DOMRect) => {
    if (adding.current || source.busy) return;
    adding.current = true;
    try {
      await source.createSheet(type.folder, name);
      setNote(`${name} added to ${type.label}.`);
      editorRef.current?.focus();
    } catch (error) {
      setRefusal({ title: `Couldn’t add ${name} to ${type.label}`, message: errorMessage(error), at });
    } finally {
      adding.current = false;
    }
  };

  /* Spelling ------------------------------------------------------------- */

  /** The word at a point on screen, if the spelling check marks it and its menu can be offered (a dictionary, no focus mode). */
  const misspelledAt = (editor: EditorHandle, x: number, y: number): EditorWord | null => {
    if (!spelling) return null;
    const word = editor.spellingWordAt(x, y);
    return word && misspelled.has(spellingKey(word.word)) ? word : null;
  };

  /**
   * The misspelled word a right-click is on, whose corrections lead the
   * menu: none when the click is on a selection that could be a name and is
   * more than that word, which the menu acts on instead, as before.
   */
  const correctionTargetAt = (editor: EditorHandle, x: number, y: number): EditorWord | null => {
    const word = misspelledAt(editor, x, y);
    if (!word) return null;
    const selected = editor.selectionContains(x, y) ? editor.selectedName() : "";
    return selected === "" || spellingKey(selected) === spellingKey(word.word) ? word : null;
  };

  /**
   * A marked word tapped: where it is in the editor. Its middle first; a
   * word broken over two lines (sea-green) has its middle between them, so
   * then the ends of its box, on its first and last lines.
   */
  const markedWord = (editor: EditorHandle, hit: SuggestionHit): EditorWord | null => {
    const { left, right, top, bottom } = hit.rect;
    const inside = Math.min(tokenPx("--space-1"), (bottom - top) / 2);
    const points: [number, number][] = [
      [(left + right) / 2, (top + bottom) / 2],
      [right - inside, top + inside],
      [left + inside, bottom - inside],
    ];
    const key = spellingKey(hit.word);
    for (const [x, y] of points) {
      const word = editor.spellingWordAt(x, y);
      if (word && spellingKey(word.word) === key) return word;
    }
    return null;
  };

  /** The page's menu on a misspelled word, hung from `anchor`. */
  const openCorrecting = (written: string, word: EditorWord | null, anchor: DOMRect) => {
    hideCard();
    setSuggestion(null);
    setChoice(null);
    setNaming(null);
    setFixing(null);
    openings.current += 1;
    setCorrecting({ written, word, anchor, opening: openings.current });
  };

  const closeCorrecting = useCallback(() => {
    setCorrecting(null);
    editorRef.current?.focus();
  }, [editorRef]);

  /** Touch screens: a tap on a misspelled word opens its menu, as a tap on a possible name does; the caret is placed too. */
  const onSpellingClick = (hit: SuggestionHit) => {
    const editor = editorRef.current;
    if (!touch || !spelling || !editor) return;
    openCorrecting(hit.word, markedWord(editor, hit), hit.rect);
  };

  /** Puts a correction in place of the word, the caret after it; false when the text there has changed. */
  const replaceWord = (word: EditorWord | null, correction: string): boolean =>
    word !== null && (editorRef.current?.replaceWord(word, correction) ?? false);

  /** A correction chosen in the native menu: the word replaced, or a refusal where the menu was; the caret goes back to the text. */
  const correctFromTextMenu = (word: EditorWord, correction: string, at: DOMRect) => {
    if (replaceWord(word, correction)) setNote(spellingCopy.corrected(word.word, correction));
    else setRefusal({ title: spellingCopy.cantCorrect(word.word), message: WORD_CHANGED, at });
    editorRef.current?.focus();
  };

  /** Add to project or my dictionary, chosen in the native menu: the mark goes at once. */
  const addWordFromTextMenu = (source: SpellingSource, word: string, personal: boolean, at: DOMRect) => {
    try {
      if (personal) source.addToPersonal(word);
      else source.addToProject(word);
      setNote(personal ? spellingCopy.addedToPersonal(word) : spellingCopy.addedToProject(word));
    } catch (error) {
      const title = personal ? spellingCopy.cantAddToPersonal(word) : spellingCopy.cantAddToProject(word);
      setRefusal({ title, message: errorMessage(error), at });
    }
    editorRef.current?.focus();
  };

  /* Grammar -------------------------------------------------------------- */

  /**
   * The grammar problem a right-click is on, whose fixes lead the menu: none
   * when the click is on a selection that could be a name and is more than
   * the problem's text, which the menu acts on instead.
   */
  const grammarTargetAt = (editor: EditorHandle, target: EventTarget | null, x: number, y: number): GrammarHit | null => {
    if (!grammarSource) return null;
    const hit = grammarMarkAt(target);
    if (!hit) return null;
    const selected = editor.selectionContains(x, y) ? editor.selectedName().trim() : "";
    return selected === "" || selected === hit.text.trim() ? hit : null;
  };

  /** The page's menu on a grammar problem, hung from `anchor`. */
  const openFixing = (hit: GrammarHit, range: EditorWord | null, anchor: DOMRect) => {
    hideCard();
    setSuggestion(null);
    setChoice(null);
    setNaming(null);
    setCorrecting(null);
    openings.current += 1;
    setFixing({ hit, range, anchor, opening: openings.current });
  };

  const closeFixing = useCallback(() => {
    setFixing(null);
    editorRef.current?.focus();
  }, [editorRef]);

  /** Touch screens: a tap on a grammar mark opens its menu, as a tap on a misspelled word does; the caret is placed too. */
  const onGrammarClick = (hit: GrammarHit) => {
    const editor = editorRef.current;
    if (!touch || !grammarSource || !editor) return;
    openFixing(hit, editor.markRange(hit.element), hit.rect);
  };

  /** A fix chosen in the native menu: the text replaced, or a refusal where the menu was; the caret goes back to the text. */
  const fixFromTextMenu = (hit: GrammarHit, range: EditorWord | null, fix: string, at: DOMRect) => {
    if (replaceWord(range, fix)) setNote(grammarCopy.fixed(hit.text, fix));
    else setRefusal({ title: grammarCopy.cantFix(hit.text), message: WORD_CHANGED, at });
    editorRef.current?.focus();
  };

  /** Ignore, chosen in the native menu: the mark goes at once. */
  const ignoreFromTextMenu = (source: GrammarSource, hit: GrammarHit) => {
    source.ignore(hit);
    setNote(grammarCopy.ignored(hit.text));
    editorRef.current?.focus();
  };

  /* The native menu ------------------------------------------------------ */

  /**
   * The native menu for a right-click: for a misspelled word, its
   * corrections and the dictionaries first, looked up before the menu
   * shows (a quick local call; without them if they can't be had); for a
   * grammar problem, what is wrong, its fixes and Ignore; then `names`.
   * Shows nothing if another right-click came meanwhile.
   */
  const showNativeMenu = async (
    show: NonNullable<Backend["popupTextMenu"]>,
    word: EditorWord | null,
    problem: { hit: GrammarHit; range: EditorWord | null } | null,
    names: TextMenuEntry[],
    at: DOMRect,
  ) => {
    const request = ++textMenus.current;
    let entries = names;
    const source = spelling;
    const checking = grammarSource;
    if (problem && checking) {
      const { hit, range } = problem;
      const grammarItems = grammarTextMenuItems(hit, !readOnly, {
        fix: (fix) => fixFromTextMenu(hit, range, fix, at),
        ignore: () => ignoreFromTextMenu(checking, hit),
      });
      entries = [...grammarItems, TEXT_MENU_SEPARATOR, ...names];
    } else if (word && source) {
      let corrections: Corrections;
      try {
        corrections = (await source.suggest(word.word)) ?? [];
      } catch {
        corrections = "failed";
      }
      if (request !== textMenus.current) return;
      const spellingItems = spellingTextMenuItems(word.word, corrections, !readOnly, {
        replace: (correction) => correctFromTextMenu(word, correction, at),
        addToProject: () => addWordFromTextMenu(source, word.word, false, at),
        addToPersonal: () => addWordFromTextMenu(source, word.word, true, at),
      });
      entries = [...spellingItems, TEXT_MENU_SEPARATOR, ...names];
    }
    await show(entries, at.x, at.y);
  };

  /**
   * A right-click in the chapter text. The desktop app shows its native menu:
   * for a misspelled word, its corrections and Add to project or my
   * dictionary; for a grammar problem, what is wrong, its fixes and Ignore;
   * then Add to each type for the word or the selection (Open for a name);
   * then Cut, Copy and Paste. The browser preview, with a mouse, shows the
   * page's own menu over a word or a selection (the spelling or grammar
   * menu over their marks), and leaves its own menu elsewhere. Touch
   * screens keep the system's: a long-press selects, and the selection
   * offers Add as name; a tap on a misspelled word or a grammar problem
   * opens its menu. Focus mode offers no names, corrections or fixes.
   */
  const onContextMenu = (event: MouseEvent) => {
    const editor = editorRef.current;
    if (!editor || !(event.target instanceof Element) || !event.target.closest(".editor-surface")) return;
    const fromTouch = "pointerType" in event.nativeEvent && event.nativeEvent.pointerType === "touch";
    if (!popupTextMenu && (touch || fromTouch)) return;
    const source = suggesting && onOpenSheet ? suggesting : null;
    const target = source ? nameTargetAt(editor, matcher, event) : null;
    const { clientX: x, clientY: y } = event;
    const at = new DOMRect(x, y, 0, 0);
    const word = correctionTargetAt(editor, x, y);
    // Marks never overlap: a misspelled word is never part of a grammar problem.
    const hit = word ? null : grammarTargetAt(editor, event.target, x, y);
    const problem = hit && { hit, range: editor.markRange(hit.element) };

    if (!popupTextMenu) {
      if (word) {
        event.preventDefault();
        openCorrecting(word.word, word, at);
      } else if (problem) {
        event.preventDefault();
        openFixing(problem.hit, problem.range, underMarkLine(problem.hit.element, x, y));
      } else if (target && openNaming(target, at)) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    hideCard();
    const items =
      source && target
        ? textMenuItems(target, sheetsOf(target.sheetIds), source.types, !source.busy && !adding.current, {
            add: (type) => void addFromTextMenu(source, target.name, type, at),
            open: (id) => onOpenSheet?.(id, target.occurrence),
          })
        : [];
    showNativeMenu(popupTextMenu, word, problem, items, at).catch((error: unknown) =>
      setRefusal({ title: "Couldn’t show the menu", message: errorMessage(error), at }),
    );
  };

  /**
   * Add as name, tapped under a selection: the button makes way for the
   * menu, which hangs from the selection and the button together, so it
   * opens where the button was, or above the selection, never over it.
   */
  const onAddNamePress = (button: DOMRect) => {
    if (!offer) return;
    const top = Math.min(offer.top, button.top);
    const anchor = new DOMRect(button.left, top, button.width, Math.max(button.bottom, offer.bottom) - top);
    openNaming({ name: offer.name, known: false, sheetIds: [] }, anchor);
  };

  // A press in the empty space around the text puts the caret back in it.
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target as Element;
    if (target === event.currentTarget || target.classList.contains("editor-column")) {
      event.preventDefault();
      editorRef.current?.focus();
    }
  };

  const sheetsFor = (hit: NameHit) => sheetsOf(hit.sheetIds);

  const shared = chapter && {
    ref: editorRef,
    markdown: chapter.text,
    matcher,
    initialCaret,
    onChange: (markdown: string) => onChange(chapter.id, markdown),
    onFormatChange,
    onNameClick,
    suggestions,
    onSuggestionClick,
    misspelled,
    onSpellingClick,
    grammar,
    onGrammarClick,
    readOnly,
    ariaLabel: "Chapter text",
  };

  return (
    <main
      ref={paneRef}
      className="editor-pane"
      style={editorStyle(settings)}
      onMouseOver={onMouseOver}
      onMouseLeave={hideCard}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      {chapter && shared ? (
        <div className="editor-column">
          {/* Present before the note appears, so screen readers announce it. */}
          <div role="status">
            {plainOnly && (
              <p id={PLAIN_ONLY_NOTE_ID} className="editor-note">
                <Info aria-hidden />
                <span>
                  This chapter uses Markdown the Formatted view can’t keep, so it’s open in Plain. Your text is safe.
                </span>
              </p>
            )}
          </div>
          {mode === "formatted" ? (
            <FormattedEditor
              key={`${chapter.id}:formatted`}
              {...shared}
              onUnsupportedMarkdown={() => onUnsupportedMarkdown(chapter.id)}
              className="editor-surface"
            />
          ) : (
            <PlainEditor key={`${chapter.id}:plain`} {...shared} className="editor-surface" />
          )}
        </div>
      ) : (
        empty
      )}
      {hover && <NameCard hit={hover} sheets={sheetsFor(hover)} clickHint={onOpenSheet !== null} />}
      {choice && (
        <NameChoice
          hit={choice}
          sheets={sheetsFor(choice)}
          ignoring={ignoring}
          onClose={() => {
            setChoice(null);
            editorRef.current?.focus();
          }}
          onChoose={(id) => {
            setChoice(null);
            onOpenSheet?.(id, choice.occurrence);
          }}
        />
      )}
      {suggestion && suggesting && (
        <PossibleNameMenu
          key={suggestion.opening}
          hit={suggestion.hit}
          source={suggesting}
          onClose={closeSuggestion}
          announce={setNote}
        />
      )}
      {naming && suggesting && (
        <AddNameMenu
          key={naming.opening}
          target={naming.target}
          sheets={sheetsOf(naming.target.sheetIds)}
          anchor={naming.anchor}
          source={suggesting}
          onOpen={(id) => {
            setNaming(null);
            onOpenSheet?.(id, naming.target.occurrence);
          }}
          onClose={closeNaming}
          announce={setNote}
        />
      )}
      {correcting && spelling && (
        <SpellingMenu
          key={correcting.opening}
          word={correcting.written}
          anchor={correcting.anchor}
          source={spelling}
          replace={(correction) => replaceWord(correcting.word, correction)}
          naming={suggesting}
          busy={readOnly}
          onClose={closeCorrecting}
          announce={setNote}
        />
      )}
      {fixing && grammarSource && (
        <GrammarMenu
          key={fixing.opening}
          hit={fixing.hit}
          anchor={fixing.anchor}
          source={grammarSource}
          replace={(fix) => replaceWord(fixing.range, fix)}
          busy={readOnly}
          onClose={closeFixing}
          announce={setNote}
        />
      )}
      {offer && suggesting && !suggesting.busy && !naming && (
        <AddNameButton offer={offer} pane={paneRef} onPress={onAddNamePress} />
      )}
      {refusal && <TextNote at={refusal.at} title={refusal.title} message={refusal.message} />}
      <p className="visually-hidden" role="status">
        {note}
      </p>
      {/* Present before a refusal from the native menu, so screen readers announce it. */}
      <p className="visually-hidden" role="alert">
        {refusal ? `${refusal.title}. ${refusal.message}` : ""}
      </p>
    </main>
  );
}
