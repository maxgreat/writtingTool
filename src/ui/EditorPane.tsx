import { Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { TextPosition } from "../core/caret";
import { FormattedEditor } from "../core/editor/FormattedEditor";
import { nameMarkAt, NAME_MARK_CLASS } from "../core/editor/nameMarks";
import { PlainEditor } from "../core/editor/PlainEditor";
import type { EditorHandle, FormatState, NameHit, SuggestionHit } from "../core/editor/types";
import type { IgnoredName, NameMatcher } from "../core/names";
import type { Chapter, Sheet } from "../core/project";
import type { EditorMode, ViewSettings } from "../core/settings";
import { tokenMs } from "./dom";
import type { IgnoreSource } from "./IgnoreHere";
import { editorStyle } from "./layoutStyle";
import { NameCard, NameChoice } from "./NameCard";
import { PossibleNameMenu, type SuggestionSource } from "./PossibleNameMenu";

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
   * Opens a sheet for a clicked name, with the occurrence clicked (for
   * Ignore here); null in focus mode, where a click only places the caret.
   */
  onOpenSheet: ((id: string, occurrence: IgnoredName) => void) | null;
  /** Ignore here, in the choice offered for a name shared by several sheets. */
  ignoring: IgnoreSource;
  /**
   * Possible names to mark in the text (useNameSuggestions' words): none in
   * focus mode. The same set while its words don't change.
   */
  suggestions: ReadonlySet<string>;
  /** Add to and Not a name, offered when a marked word is clicked; null in focus mode. */
  suggesting: SuggestionSource | null;
  sheetsById: Map<string, Sheet>;
  /** Hover summary cards, for devices with a real pointer. */
  hoverCards: boolean;
  /** What to show when there is no chapter to open. */
  empty: ReactNode;
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
  sheetsById,
  hoverCards,
  empty,
}: EditorPaneProps) {
  const [hover, setHover] = useState<NameHit | null>(null);
  const [choice, setChoice] = useState<NameHit | null>(null);
  /** The possible name whose menu is open, and a count of openings, so each click starts the menu afresh. */
  const [suggestion, setSuggestion] = useState<{ hit: SuggestionHit; opening: number } | null>(null);
  const openings = useRef(0);
  /** Said to screen readers: what a possible name became. Here, as the menu closes when a sheet is made. */
  const [note, setNote] = useState("");
  const hovered = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus mode takes the marks away, and the menu with them.
  if (!suggesting && suggestion) setSuggestion(null);

  const hideCard = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    hovered.current = null;
    setHover(null);
  }, []);

  useEffect(() => hideCard, [hideCard]);

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
    if (hit.ambiguous) setChoice(hit);
    else onOpenSheet(hit.sheetIds[0], hit.occurrence);
  };

  /** A word marked as a possible name: its menu, anchored to it, on desktop and phones alike. */
  const onSuggestionClick = (hit: SuggestionHit) => {
    hideCard();
    if (!suggesting) return;
    setChoice(null);
    openings.current += 1;
    setSuggestion({ hit, opening: openings.current });
  };

  const closeSuggestion = useCallback(() => {
    setSuggestion(null);
    editorRef.current?.focus();
  }, [editorRef]);

  // A press in the empty space around the text puts the caret back in it.
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target as Element;
    if (target === event.currentTarget || target.classList.contains("editor-column")) {
      event.preventDefault();
      editorRef.current?.focus();
    }
  };

  const sheetsFor = (hit: NameHit) => hit.sheetIds.map((id) => sheetsById.get(id)).filter((s): s is Sheet => !!s);

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
    readOnly,
    ariaLabel: "Chapter text",
  };

  return (
    <main
      className="editor-pane"
      style={editorStyle(settings)}
      onMouseOver={onMouseOver}
      onMouseLeave={hideCard}
      onMouseDown={onMouseDown}
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
      <p className="visually-hidden" role="status">
        {note}
      </p>
    </main>
  );
}
