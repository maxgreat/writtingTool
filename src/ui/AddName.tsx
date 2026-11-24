import { Plus } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { TextMenuItem } from "../core/backend";
import { nameMarkAt } from "../core/editor/nameMarks";
import type { EditorHandle } from "../core/editor/types";
import type { IgnoredName, NameMatcher } from "../core/names";
import type { Sheet, SheetType } from "../core/project";
import { errorMessage, focusLost, placeNear, tokenPx } from "./dom";
import { MenuItem, Popover } from "./Popover";
import type { SuggestionSource } from "./PossibleNameMenu";

/*
 * Any word or phrase in the chapter, added as a name by hand: names that are
 * also ordinary words ("Rose", "Will") are never offered as possible names.
 * Right-click a word or a selection (desktop), or select it with a long-press
 * and tap Add as name (touch screens).
 */

/** Text in the chapter to add as a name, or to open as one. */
export interface NameTarget {
  /** As a sheet would be named: see EditorHandle.wordAt and selectedName. */
  name: string;
  /** Already a name: its sheets are offered to open, instead of Add to. */
  known: boolean;
  /** The sheets it names, when known. */
  sheetIds: string[];
  /** A highlighted name right-clicked: its sheet opens as a click on it would, with Ignore here. */
  occurrence?: IgnoredName;
}

/** Text that may be a name, with its sheets when the matcher already knows it. */
export function nameTarget(matcher: NameMatcher, name: string): NameTarget {
  if (!matcher.knows(name)) return { name, known: false, sheetIds: [] };
  // A name the matcher knows is found over the whole of it.
  const whole = matcher.find(name).find((m) => m.from === 0 && m.to === name.length);
  return { name, known: true, sheetIds: whole?.sheetIds ?? [] };
}

/**
 * What a right-click in the chapter text acts on: the selection when the
 * click is on it and it can be a name, else the highlighted name under the
 * pointer, else the word there. Null between words.
 */
export function nameTargetAt(
  editor: EditorHandle,
  matcher: NameMatcher,
  event: { target: EventTarget | null; clientX: number; clientY: number },
): NameTarget | null {
  // A right-click elsewhere may leave the selection as it was: it is only meant when clicked.
  const selected = editor.selectionContains(event.clientX, event.clientY) ? editor.selectedName() : "";
  if (selected !== "") return nameTarget(matcher, selected);
  const mark = nameMarkAt(event.target);
  if (mark) return { name: mark.occurrence.name, known: true, sheetIds: mark.sheetIds, occurrence: mark.occurrence };
  const word = editor.wordAt(event.clientX, event.clientY);
  return word ? nameTarget(matcher, word) : null;
}

/**
 * The app's own items in the desktop's native text menu, above Cut, Copy and
 * Paste. A menu item can't show the word on its own, so each says it.
 */
export function textMenuItems(
  target: NameTarget,
  sheets: Sheet[],
  types: SheetType[],
  enabled: boolean,
  act: { add(type: SheetType): void; open(id: string): void },
): TextMenuItem[] {
  if (target.known) return sheets.map((sheet) => ({ text: `Open ${sheet.name}`, enabled, action: () => act.open(sheet.id) }));
  return types.map((type) => ({ text: `Add “${target.name}” to ${type.label}`, enabled, action: () => act.add(type) }));
}

/* The menu --------------------------------------------------------------- */

export interface AddNameMenuProps {
  target: NameTarget;
  /** The target's sheets, when it is already a name. */
  sheets: Sheet[];
  /** Where the menu hangs from: the pointer, or the Add as name button. */
  anchor: DOMRect;
  source: SuggestionSource;
  /** Opens one of a name's sheets; the menu is closed first. */
  onOpen(id: string): void;
  /** Closes the menu and puts the caret back in the text: after Add to, Escape or a press outside. */
  onClose(): void;
  /** Says something to screen readers, from a live region that stays when the menu goes. */
  announce(message: string): void;
}

interface Failure {
  message: string;
  /** The item that was pressed, which takes focus back from the moment it was disabled. */
  refocus: number;
}

/**
 * The menu for text chosen by hand, under its own words as a title: Add to
 * (one item per type that holds names) makes the sheet, the text is
 * highlighted at once, and the menu closes with the caret back in the text.
 * Text that is already a name offers its sheets instead. A refusal shows in
 * the menu, which stays open.
 */
export function AddNameMenu({ target, sheets, anchor, source, onOpen, onClose, announce }: AddNameMenuProps) {
  const { name } = target;
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const locked = source.busy || creating;
  const id = useId();

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A sheet that couldn't be made: the item pressed takes focus back, as it lost it while disabled.
  useEffect(() => {
    if (failure === null || !focusLost()) return;
    const items = document.getElementById(id)?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[failure.refocus]?.focus();
  }, [failure, id]);

  const add = async (type: SheetType, item: number) => {
    if (locked) return;
    setCreating(true);
    setFailure(null);
    try {
      await source.createSheet(type.folder, name);
      announce(`${name} added to ${type.label}.`);
      if (live.current) onClose();
    } catch (error) {
      // Closed meanwhile: the refusal is still said.
      if (live.current) setFailure({ message: errorMessage(error), refocus: item });
      else announce(errorMessage(error));
    } finally {
      if (live.current) setCreating(false);
    }
  };

  return (
    <>
      <Popover
        id={id}
        anchor={anchor}
        role="menu"
        label={target.known ? `Name: ${name}` : `Add as name: ${name}`}
        autoFocus
        busy={creating}
        onClose={onClose}
      >
        <div className="popover-title add-name-title" role="none">
          “{name}”
        </div>
        {target.known
          ? sheets.map((sheet) => (
              <MenuItem key={sheet.id} noCheck disabled={locked} onSelect={() => onOpen(sheet.id)}>
                Open {sheet.name}
              </MenuItem>
            ))
          : source.types.map((type, i) => (
              <MenuItem key={type.folder} noCheck disabled={locked} onSelect={() => void add(type, i)}>
                Add to {type.label}
              </MenuItem>
            ))}
        {failure !== null && (
          <div className="popover-note inline-error" role="none">
            {failure.message}
          </div>
        )}
      </Popover>
      {/* Outside the menu, which holds only its items, so the refusal is announced. */}
      <p className="visually-hidden" role="alert">
        {failure?.message ?? ""}
      </p>
    </>
  );
}

/* Touch screens: Add as name under a selection ----------------------------- */

/** A selection in the chapter text that could be a name and isn't one yet. */
export interface SelectionOffer {
  name: string;
  /** The selection's last line on screen, which the button is centred under. */
  line: DOMRect;
  /** The top and bottom of the whole selection on screen. */
  top: number;
  bottom: number;
}

interface Area {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The part of the text pane on screen: inside the window, above the on-screen keyboard. */
function visibleArea(pane: HTMLElement): Area {
  const box = pane.getBoundingClientRect();
  const view = window.visualViewport;
  const top = view?.offsetTop ?? 0;
  const left = view?.offsetLeft ?? 0;
  return {
    top: Math.max(box.top, top),
    bottom: Math.min(box.bottom, top + (view?.height ?? window.innerHeight)),
    left: Math.max(box.left, left),
    right: Math.min(box.right, left + (view?.width ?? window.innerWidth)),
  };
}

const sameRect = (a: DOMRect, b: DOMRect) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

const sameOffer = (a: SelectionOffer | null, b: SelectionOffer | null) =>
  a === b ||
  (a !== null && b !== null && a.name === b.name && a.top === b.top && a.bottom === b.bottom && sameRect(a.line, b.line));

/**
 * The chapter text's selection, while it could be a name that isn't one yet
 * and is on screen; null otherwise, and always when `enabled` is off. It is
 * read a frame after the page's selection changes (the editors take it into
 * their own first), and again on scroll and resize, so it follows the text.
 */
export function useSelectionOffer(
  enabled: boolean,
  editorRef: RefObject<EditorHandle | null>,
  paneRef: RefObject<HTMLElement | null>,
  matcher: NameMatcher,
): SelectionOffer | null {
  const [offer, setOffer] = useState<SelectionOffer | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOffer(null);
      return;
    }
    const read = (): SelectionOffer | null => {
      const editor = editorRef.current;
      const pane = paneRef.current;
      const selection = document.getSelection();
      if (!editor || !pane || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0);
      if (!pane.querySelector(".editor-surface")?.contains(range.commonAncestorContainer)) return null;
      const name = editor.selectedName();
      if (name === "" || matcher.knows(name)) return null;
      const box = range.getBoundingClientRect();
      const area = visibleArea(pane);
      // Scrolled out of sight: there is nothing to point at.
      if (box.bottom <= area.top || box.top >= area.bottom) return null;
      const lines = [...range.getClientRects()].filter((r) => r.width > 0);
      return { name, line: lines.at(-1) ?? box, top: box.top, bottom: box.bottom };
    };
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = read();
        setOffer((current) => (sameOffer(current, next) ? current : next));
      });
    };
    update();
    const viewport = window.visualViewport;
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [enabled, editorRef, paneRef, matcher]);

  return enabled ? offer : null;
}

/**
 * Puts the button under the selection, past the system's selection handles,
 * centred on its last line. The system's own toolbar (Cut, Copy, Paste) is
 * above the selection, so the two don't meet. It stays inside the visible
 * text, so above the on-screen keyboard and the bars: near the bottom edge
 * it sits just above that edge.
 */
function placeUnder(el: HTMLElement, offer: SelectionOffer, area: Area): void {
  const edge = tokenPx("--space-2");
  const { width, height } = el.getBoundingClientRect();
  const top = Math.min(offer.bottom + tokenPx("--size-selection-handle"), area.bottom - edge - height);
  const left = offer.line.left + offer.line.width / 2 - width / 2;
  el.style.top = `${Math.max(area.top + edge, top)}px`;
  el.style.left = `${Math.max(area.left + edge, Math.min(left, area.right - edge - width))}px`;
}

export interface AddNameButtonProps {
  offer: SelectionOffer;
  /** The text pane, whose part on screen the button stays inside. */
  pane: RefObject<HTMLElement | null>;
  /** Opens the add menu: given the button's place on screen. */
  onPress(rect: DOMRect): void;
}

/** Touch screens: a small floating button under a selection that could be a name. */
export function AddNameButton({ offer, pane, onPress }: AddNameButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const area = pane.current;
    if (el && area) placeUnder(el, offer, visibleArea(area));
  }, [offer, pane]);

  return createPortal(
    <button
      ref={ref}
      type="button"
      className="add-name-button"
      aria-label={`Add as name: ${offer.name}`}
      aria-haspopup="menu"
      // The selection and the caret stay in the text, as with the formatting bar's buttons.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onPress(event.currentTarget.getBoundingClientRect())}
    >
      <Plus aria-hidden />
      Add as name
    </button>,
    document.body,
  );
}

/* A refusal from the native menu ------------------------------------------ */

export interface TextNoteProps {
  /** Where the menu was opened: the note hangs from there. */
  at: DOMRect;
  title: string;
  message: string;
}

/**
 * Why something chosen in the native text menu didn't happen, shown where
 * the menu was, since nothing can show inside it. Screen readers hear it
 * from the editor pane's alert; the pane takes it away at the next key,
 * press or scroll.
 */
export function TextNote({ at, title, message }: TextNoteProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) placeNear(ref.current, at);
  }, [at]);
  return createPortal(
    <div ref={ref} className="text-note" aria-hidden>
      <p className="text-note-title inline-error">{title}</p>
      <p className="text-note-message muted">{message}</p>
    </div>,
    document.body,
  );
}
