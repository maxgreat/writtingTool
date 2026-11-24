import type { IgnoredName } from "../names";
import type { Ref } from "react";
import type { TextPosition } from "../caret";
import type { NameMatcher } from "../names";

/** Paragraph styles from the style menu that are saved in the Markdown. */
export type BlockStyle = "body" | "heading" | "quote";

/** What the formatting bar shows as active at the caret. */
export interface FormatState {
  bold: boolean;
  italic: boolean;
  block: BlockStyle;
}

/** A click or hover on a highlighted name. */
export interface NameHit {
  sheetIds: string[];
  /** The alias belongs to more than one sheet: offer a choice. */
  ambiguous: boolean;
  /** Where the name is on screen, to anchor a card or menu. */
  rect: DOMRect;
  /** This occurrence, as "Ignore here" remembers it: the name as written and its sentence's key. */
  occurrence: IgnoredName;
}

/** Commands the formatting bar and the mode switch use; both editors implement them. */
export interface EditorHandle {
  focus(): void;
  toggleBold(): void;
  toggleItalic(): void;
  setBlockStyle(style: BlockStyle): void;
  insertSceneBreak(): void;
  /** The caret as a position the other editor can restore. */
  getCaret(): TextPosition;
}

/**
 * Both editors take the chapter's Markdown once, when they mount; remount
 * them (with a React `key`) to load another chapter or switch mode.
 */
export interface ChapterEditorProps {
  ref?: Ref<EditorHandle>;
  markdown: string;
  matcher: NameMatcher;
  /** Where to put the caret on mount, for example the caret of the other mode. */
  initialCaret?: TextPosition | null;
  onChange(markdown: string): void;
  onFormatChange?(state: FormatState): void;
  /** A highlighted name was clicked; the caret is still placed as usual. */
  onNameClick?(hit: NameHit): void;
  /**
   * Formatted editor only: the chapter uses Markdown outside the chapter
   * subset, which this editor cannot save without losing it. The editor is
   * then read-only and never calls `onChange`; edit the chapter in plain mode.
   */
  onUnsupportedMarkdown?(): void;
  /** Refuse edits for now, for example while another project opens. Can change while mounted. */
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * Editors take focus when they mount, except on touch-first devices, where
 * focusing would pop up the on-screen keyboard every time a chapter opens.
 */
export function shouldFocusOnMount(): boolean {
  return typeof matchMedia !== "function" || !matchMedia("(pointer: coarse)").matches;
}

export const sameFormat =(a: FormatState | null, b: FormatState): boolean =>
  a !== null && a.bold === b.bold && a.italic === b.italic && a.block === b.block;
