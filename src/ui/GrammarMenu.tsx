import { useId, useState } from "react";
import { TEXT_MENU_SEPARATOR, type TextMenuEntry, type TextMenuItem } from "../core/backend";
import type { GrammarHit } from "../core/editor/nameMarks";
import { MenuItem, Popover } from "./Popover";
import { MenuNote, WORD_CHANGED } from "./SpellingMenu";

/*
 * The menu on a grammar problem marked in the text: what is wrong, the
 * fixes, best first, then Ignore, which stops marking it. The desktop app
 * puts the same items in its native menu (grammarTextMenuItems); the
 * browser preview with a mouse, and touch screens, show the page's own
 * (GrammarMenu): a right-click on the mark, or a tap on it.
 */

/** What the menu on a grammar problem acts with. */
export interface GrammarSource {
  /** Stops marking this text with this message, until the app closes. */
  ignore(hit: GrammarHit): void;
}

/* Copy, shared by the page's menu and the native one ------------------------------- */

/** Quoted text is cut to this many characters: a long problem would make a long line. */
const QUOTE_MAX = 40;
/** A native menu item is one line, as wide as its text: longer messages and fixes are cut. */
const NATIVE_MAX = 64;

/** `text` on one line, cut at the end of a word with "…" when it has more than `max` characters. */
export function shortened(text: string, max: number): string {
  const line = [...text.replace(/\s+/gu, " ").trim()];
  if (line.length <= max) return line.join("");
  const cut = line.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  // Cut at the end of a word, unless the room ends there; a word much longer than the room is cut where it ends.
  const kept = line[max - 1] === " " || space <= cut.length / 2 ? cut : cut.slice(0, space);
  return `${kept.replace(/[\s,;:.]+$/u, "")}…`;
}

/** The text a problem covers, as the menus say it: quoted, or what it is when it is only spaces. */
function quote(text: string): string {
  const shown = shortened(text, QUOTE_MAX);
  if (shown !== "") return `“${shown}”`;
  return text.length === 1 ? "the space" : "the spaces";
}

/** A fix as an item says it: the new text, or what it does when it would read as nothing. */
export function fixLabel(fix: string, text: string): string {
  if (fix === "") return `Remove ${quote(text)}`;
  if (fix.trim() === "") return fix.length === 1 ? "Replace with one space" : "Replace with spaces";
  return fix;
}

/** What the grammar menus say, to screen readers and in refusals. */
export const grammarCopy = {
  /** The menu's name: the text it is about. */
  label: (text: string) => `Grammar: ${quote(text)}`,
  fixed: (text: string, fix: string) =>
    fix === ""
      ? `Removed ${quote(text)}.`
      : `Changed ${quote(text)} to ${fix.trim() === "" ? "one space" : `“${shortened(fix, QUOTE_MAX)}”`}.`,
  ignored: (text: string) => `Ignored ${quote(text)}.`,
  cantFix: (text: string) => `Couldn’t change ${quote(text)}`,
};

const IGNORE = "Ignore";

/**
 * The grammar items of the desktop's native text menu: what is wrong, as a
 * greyed line (cut short if long), each fix under it, then Ignore. `canEdit`
 * is false while the text takes no edits (another project opening): the
 * fixes wait; Ignore changes only what is marked.
 */
export function grammarTextMenuItems(
  hit: Pick<GrammarHit, "message" | "fixes" | "text">,
  canEdit: boolean,
  act: { fix(fix: string): void; ignore(): void },
): TextMenuEntry[] {
  const message: TextMenuItem[] =
    hit.message.trim() === "" ? [] : [{ text: shortened(hit.message, NATIVE_MAX), enabled: false, action: () => undefined }];
  const fixes = hit.fixes.map(
    (fix): TextMenuItem => ({ text: shortened(fixLabel(fix, hit.text), NATIVE_MAX), enabled: canEdit, action: () => act.fix(fix) }),
  );
  return [...message, ...fixes, TEXT_MENU_SEPARATOR, { text: IGNORE, action: act.ignore }];
}

/* The page's menu ---------------------------------------------------------------- */

export interface GrammarMenuProps {
  hit: GrammarHit;
  /** Where the menu hangs from: under the mark right-clicked, at the pointer, or under the mark tapped. */
  anchor: DOMRect;
  source: GrammarSource;
  /** Puts a fix in place of the problem's text, the caret after it; false, changing nothing, when the text there has changed. */
  replace(fix: string): boolean;
  /** Another project is opening: the text takes no fixes until it has. */
  busy: boolean;
  /** Closes the menu and puts the caret back in the text: after an action, Escape or a press outside. */
  onClose(): void;
  /** Says something to screen readers, from a live region that stays when the menu goes. */
  announce(message: string): void;
}

/**
 * The menu on a grammar problem: what is wrong, then its fixes, then
 * Ignore. A fix replaces the text; Ignore stops marking it. Either closes
 * the menu with the caret back in the text. A refusal shows in the menu,
 * which stays open.
 */
export function GrammarMenu({ hit, anchor, source, replace, busy, onClose, announce }: GrammarMenuProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const messageId = useId();
  const hasMessage = hit.message.trim() !== "";

  const applyFix = (fix: string) => {
    if (busy) return;
    if (!replace(fix)) {
      setFailure(grammarCopy.cantFix(hit.text));
      return;
    }
    announce(grammarCopy.fixed(hit.text, fix));
    onClose();
  };

  const ignore = () => {
    source.ignore(hit);
    announce(grammarCopy.ignored(hit.text));
    onClose();
  };

  return (
    <>
      <Popover
        anchor={anchor}
        role="menu"
        label={grammarCopy.label(hit.text)}
        describedBy={hasMessage ? messageId : undefined}
        autoFocus
        onClose={onClose}
      >
        {hasMessage && (
          <p id={messageId} className="grammar-message" role="none">
            {hit.message}
          </p>
        )}
        {hit.fixes.map((fix, index) => (
          <MenuItem key={`${index}:${fix}`} noCheck disabled={busy} className="grammar-fix" onSelect={() => applyFix(fix)}>
            {fixLabel(fix, hit.text)}
          </MenuItem>
        ))}
        {hit.fixes.length > 0 && <div className="popover-gap" role="none" />}
        <MenuItem noCheck onSelect={ignore}>
          {IGNORE}
        </MenuItem>
        {failure !== null && <MenuNote title={failure} message={WORD_CHANGED} />}
      </Popover>
      {/* Outside the menu, which holds only its items, so the refusal is announced. */}
      <p className="visually-hidden" role="alert">
        {failure === null ? "" : `${failure}. ${WORD_CHANGED}`}
      </p>
    </>
  );
}
