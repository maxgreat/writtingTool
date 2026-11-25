import type { GrammarProblem } from "../backend";
import type { IgnoredName } from "../names";
import type { GrammarHit } from "./nameMarks";
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

/** A word marked in the text as a possible name, clicked. */
export interface SuggestionHit {
  word: string;
  /** Where the word is on screen, to anchor a menu. */
  rect: DOMRect;
}

/**
 * A word in an editor, as the spelling check reads it, with where it is:
 * positions of that editor, valid until its text changes.
 */
export interface EditorWord {
  word: string;
  from: number;
  to: number;
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
  /** The word at a point on screen (client coordinates), as a name would be written (see wordAround); null if none. */
  wordAt(x: number, y: number): string | null;
  /** The selection as a name to add (see nameFromSelection): empty when nothing is selected, it spans paragraphs, or it is too long. */
  selectedName(): string;
  /** Whether a point on screen (client coordinates) is on the selected text; false when nothing is selected. */
  selectionContains(x: number, y: number): boolean;
  /** The word the spelling check reads at a point on screen (client coordinates); null between words. */
  spellingWordAt(x: number, y: number): EditorWord | null;
  /**
   * Replaces a word found by spellingWordAt with `text`, as typing would
   * (one undo step, the word's formatting kept). False, changing nothing,
   * when the word is no longer there or the editor takes no edits.
   */
  replaceWord(word: EditorWord, text: string): boolean;
  /**
   * Where a grammar mark (see grammarMarkAt) is in the editor, with the
   * text it covers there, for replaceWord; null when it isn't this
   * editor's.
   */
  markRange(mark: Element): EditorWord | null;
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
   * Possible names to mark in the text (dotted underline), as composed
   * words; see useNameSuggestions.ts. Give the same set while its words
   * don't change: a new one marks the whole chapter again.
   */
  suggestions?: ReadonlySet<string>;
  /** A word marked as a possible name was clicked; the caret is still placed as usual. */
  onSuggestionClick?(hit: SuggestionHit): void;
  /**
   * Misspelled words to mark in the text (wavy underline), as spelling
   * keys; see useSpelling.ts. Give the same set while its words don't
   * change: a new one marks the whole chapter again.
   */
  misspelled?: ReadonlySet<string>;
  /** A word marked as misspelled was clicked; the caret is still placed as usual. */
  onSpellingClick?(hit: SuggestionHit): void;
  /**
   * Grammar problems to mark, by each paragraph's text as it reads (see
   * useGrammar.ts). Give the same map while they don't change.
   */
  grammar?: ReadonlyMap<string, readonly GrammarProblem[]>;
  /** A grammar mark was clicked; the caret is still placed as usual. */
  onGrammarClick?(hit: GrammarHit): void;
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
