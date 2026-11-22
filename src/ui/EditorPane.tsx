import { Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { TextPosition } from "../core/caret";
import { FormattedEditor } from "../core/editor/FormattedEditor";
import { nameMarkAt, NAME_MARK_CLASS } from "../core/editor/nameMarks";
import { PlainEditor } from "../core/editor/PlainEditor";
import type { EditorHandle, FormatState, NameHit } from "../core/editor/types";
import type { NameMatcher } from "../core/names";
import type { Chapter, Sheet } from "../core/project";
import type { EditorMode, ViewSettings } from "../core/settings";
import { tokenMs } from "./dom";
import { editorStyle } from "./layoutStyle";
import { NameCard, NameChoice } from "./NameCard";

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
  /** Opens a sheet for a clicked name; null in focus mode, where a click only places the caret. */
  onOpenSheet: ((id: string) => void) | null;
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
  sheetsById,
  hoverCards,
  empty,
}: EditorPaneProps) {
  const [hover, setHover] = useState<NameHit | null>(null);
  const [choice, setChoice] = useState<NameHit | null>(null);
  const hovered = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (hit.ambiguous) setChoice(hit);
    else onOpenSheet(hit.sheetIds[0]);
  };

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
          onClose={() => {
            setChoice(null);
            editorRef.current?.focus();
          }}
          onChoose={(id) => {
            setChoice(null);
            onOpenSheet?.(id);
          }}
        />
      )}
    </main>
  );
}
