import { useEffect, useId, useRef, useState } from "react";
import { TEXT_MENU_SEPARATOR, type TextMenuEntry, type TextMenuItem } from "../core/backend";
import type { SheetType } from "../core/project";
import { errorMessage, focusLost } from "./dom";
import { MenuItem, Popover } from "./Popover";
import type { SuggestionSource } from "./PossibleNameMenu";

/*
 * The menu on a word the spelling check marks: its corrections, best
 * first, then Add to project dictionary and Add to my dictionary, which
 * stop marking it. The desktop app puts the same items in its native menu
 * (spellingTextMenuItems); the browser preview with a mouse, and touch
 * screens, show the page's own (SpellingMenu): a right-click on the word,
 * or a tap on it.
 */

/** What the menu on a misspelled word acts with. */
export interface SpellingSource {
  /** Corrections for a misspelled word, best first (at most six); null when the language has no dictionary. Rejects when they can't be had. */
  suggest(word: string): Promise<string[] | null>;
  /** Adds the word to the project's dictionary.txt; it is accepted at once (saved like an edit). */
  addToProject(word: string): void;
  /** Adds the word to this device's personal dictionary, for every project. Throws when it can't be remembered (storage blocked). */
  addToPersonal(word: string): void;
}

/* Copy, shared by the page's menu and the native one ------------------------------- */

const NO_SUGGESTIONS = "No suggestions";
const SUGGESTIONS_FAILED = "Couldn’t get suggestions";
/** Why a correction wasn't made: the word was edited, or moved, since the menu opened. */
export const WORD_CHANGED = "The text there has changed since the menu opened.";

/** What the spelling menus say, to screen readers and in refusals. */
export const spellingCopy = {
  corrected: (word: string, correction: string) => `${word} changed to ${correction}.`,
  addedToProject: (word: string) => `${word} added to the project dictionary.`,
  addedToPersonal: (word: string) => `${word} added to your dictionary, for every project on this device.`,
  cantCorrect: (word: string) => `Couldn’t change ${word}`,
  cantAddToProject: (word: string) => `Couldn’t add ${word} to the project dictionary`,
  cantAddToPersonal: (word: string) => `Couldn’t add ${word} to your dictionary`,
};

/** A misspelled word's corrections: none (null from the source, or an empty list), or "failed" when they couldn't be had. */
export type Corrections = readonly string[] | "failed";

/**
 * The spelling items of the desktop's native text menu, for a misspelled
 * word: each correction (or a greyed line saying there are none), then the
 * two dictionaries. The menu shows nothing else of the word, so the
 * dictionary items say it. `canEdit` is false while the text takes no
 * edits (another project opening): corrections and the project's
 * dictionary wait; the personal dictionary is this device's.
 */
export function spellingTextMenuItems(
  word: string,
  corrections: Corrections,
  canEdit: boolean,
  act: { replace(correction: string): void; addToProject(): void; addToPersonal(): void },
): TextMenuEntry[] {
  const fixes: TextMenuItem[] =
    corrections === "failed" || corrections.length === 0
      ? [{ text: corrections === "failed" ? SUGGESTIONS_FAILED : NO_SUGGESTIONS, enabled: false, action: () => undefined }]
      : corrections.map((correction) => ({ text: correction, enabled: canEdit, action: () => act.replace(correction) }));
  return [
    ...fixes,
    TEXT_MENU_SEPARATOR,
    { text: `Add “${word}” to project dictionary`, enabled: canEdit, action: act.addToProject },
    { text: `Add “${word}” to my dictionary`, action: act.addToPersonal },
  ];
}

/* The page's menu ---------------------------------------------------------------- */

export interface SpellingMenuProps {
  /** The misspelled word, as written. */
  word: string;
  /** Where the menu hangs from: the pointer, or the word tapped. */
  anchor: DOMRect;
  source: SpellingSource;
  /** Puts a correction in the word's place, the caret after it; false, changing nothing, when the text there has changed. */
  replace(correction: string): boolean;
  /** Add to for each type that holds names, as for any word (a misspelled word may be a name); null offers none. */
  naming: SuggestionSource | null;
  /** Another project is opening: the text and its dictionary take nothing until it has. */
  busy: boolean;
  /** Closes the menu and puts the caret back in the text: after an action, Escape or a press outside. */
  onClose(): void;
  /** Says something to screen readers, from a live region that stays when the menu goes. */
  announce(message: string): void;
}

type Suggestions = { status: "loading" } | { status: "ready"; words: string[] } | { status: "failed"; message: string };

interface Failure {
  title: string;
  message: string;
  /** The label of the item pressed, which takes focus back if it lost it while disabled. */
  refocus?: string;
}

/** The two lines of a refusal in the menu: what didn't happen, then why. */
export function MenuNote({ title, message }: { title: string; message: string }) {
  return (
    <div className="popover-note" role="none">
      <span className="inline-error">{title}.</span> <span className="muted">{message}</span>
    </div>
  );
}

/** Placeholder rows where the corrections will be, while they are looked up. */
function LoadingRows() {
  return (
    <div className="spelling-loading" role="none" aria-hidden>
      <span className="spelling-loading-row">
        <span className="skeleton spelling-loading-bar" />
      </span>
      <span className="spelling-loading-row">
        <span className="skeleton spelling-loading-bar spelling-loading-bar--short" />
      </span>
    </div>
  );
}

/**
 * The menu on a misspelled word, under the word as a title. Its
 * corrections are looked up as it opens. A correction replaces the word;
 * Add to project dictionary or Add to my dictionary stops marking it at
 * once. Either closes the menu with the caret back in the text. Add to
 * Characters (or another type that holds names) makes the word a name.
 * A refusal shows in the menu, which stays open.
 */
export function SpellingMenu({ word, anchor, source, replace, naming, busy, onClose, announce }: SpellingMenuProps) {
  const [suggestions, setSuggestions] = useState<Suggestions>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const locked = busy || creating || (naming?.busy ?? false);
  const id = useId();

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    Promise.resolve()
      .then(() => source.suggest(word))
      .then(
        (words) => current && setSuggestions({ status: "ready", words: words ?? [] }),
        (error: unknown) => current && setSuggestions({ status: "failed", message: errorMessage(error) }),
      );
    return () => {
      current = false;
    };
  }, [source, word]);

  // The menu took focus as it opened, before the corrections came: the first of them takes it, unless it has moved on.
  const opened = useRef<Element | null>(null);
  useEffect(() => {
    opened.current = document.activeElement;
  }, []);
  useEffect(() => {
    if (suggestions.status !== "ready" || document.activeElement !== opened.current) return;
    const first = document.getElementById(id)?.querySelector<HTMLElement>(".spelling-correction:not(:disabled)");
    first?.focus({ preventScroll: true });
  }, [suggestions, id]);

  // A sheet that couldn't be made: the item pressed takes focus back, as it lost it while disabled.
  useEffect(() => {
    if (failure?.refocus === undefined || !focusLost()) return;
    const items = document.getElementById(id)?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [];
    [...items].find((item) => item.textContent === failure.refocus)?.focus();
  }, [failure, id]);

  const correct = (correction: string) => {
    if (locked) return;
    if (!replace(correction)) {
      setFailure({ title: spellingCopy.cantCorrect(word), message: WORD_CHANGED });
      return;
    }
    announce(spellingCopy.corrected(word, correction));
    onClose();
  };

  const addToDictionary = (personal: boolean) => {
    // The personal dictionary is this device's: it doesn't wait for the project, only for a sheet being made.
    if (personal ? creating : locked) return;
    try {
      if (personal) source.addToPersonal(word);
      else source.addToProject(word);
    } catch (error) {
      const title = personal ? spellingCopy.cantAddToPersonal(word) : spellingCopy.cantAddToProject(word);
      setFailure({ title, message: errorMessage(error) });
      return;
    }
    announce(personal ? spellingCopy.addedToPersonal(word) : spellingCopy.addedToProject(word));
    onClose();
  };

  const addAsName = async (type: SheetType) => {
    if (locked || !naming) return;
    setCreating(true);
    setFailure(null);
    const label = `Add to ${type.label}`;
    try {
      await naming.createSheet(type.folder, word);
      announce(`${word} added to ${type.label}.`);
      if (live.current) onClose();
    } catch (error) {
      // Closed meanwhile: the refusal is still said.
      const title = `Couldn’t add ${word} to ${type.label}`;
      if (live.current) setFailure({ title, message: errorMessage(error), refocus: label });
      else announce(errorMessage(error));
    } finally {
      if (live.current) setCreating(false);
    }
  };

  const types = naming?.types ?? [];
  const alert = failure
    ? `${failure.title}. ${failure.message}`
    : suggestions.status === "failed"
      ? `${SUGGESTIONS_FAILED}. ${suggestions.message}`
      : "";

  return (
    <>
      <Popover
        id={id}
        anchor={anchor}
        role="menu"
        label={`Spelling: ${word}`}
        autoFocus
        busy={creating || suggestions.status === "loading"}
        onClose={onClose}
      >
        <div className="popover-title spelling-title" role="none">
          “{word}”
        </div>
        {suggestions.status === "loading" && <LoadingRows />}
        {suggestions.status === "failed" && <MenuNote title={SUGGESTIONS_FAILED} message={suggestions.message} />}
        {suggestions.status === "ready" && suggestions.words.length === 0 && (
          <MenuItem noCheck disabled onSelect={() => undefined}>
            {NO_SUGGESTIONS}
          </MenuItem>
        )}
        {suggestions.status === "ready" &&
          suggestions.words.map((correction) => (
            <MenuItem
              key={correction}
              noCheck
              disabled={locked}
              className="spelling-correction"
              onSelect={() => correct(correction)}
            >
              {correction}
            </MenuItem>
          ))}
        <div className="popover-gap" role="none" />
        <MenuItem noCheck disabled={locked} onSelect={() => addToDictionary(false)}>
          Add to project dictionary
        </MenuItem>
        <MenuItem noCheck disabled={creating} onSelect={() => addToDictionary(true)}>
          Add to my dictionary
        </MenuItem>
        {types.length > 0 && <div className="popover-gap" role="none" />}
        {types.map((type) => (
          <MenuItem key={type.folder} noCheck disabled={locked} onSelect={() => void addAsName(type)}>
            Add to {type.label}
          </MenuItem>
        ))}
        {failure !== null && <MenuNote title={failure.title} message={failure.message} />}
      </Popover>
      {/* Outside the menu, which holds only its items, so the refusal is announced. */}
      <p className="visually-hidden" role="alert">
        {alert}
      </p>
    </>
  );
}
