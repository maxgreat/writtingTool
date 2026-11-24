import { useEffect, useId, useRef, useState } from "react";
import type { SuggestionHit } from "../core/editor/types";
import type { SheetType } from "../core/project";
import { errorMessage, focusLost } from "./dom";
import { MenuItem, Popover } from "./Popover";

/** What the menu on a possible name in the text acts with. */
export interface SuggestionSource {
  /** The sheet types that hold names: one Add to item each. */
  types: SheetType[];
  /** useProject's createSheet: resolves to the new sheet's id, or rejects with a message for the writer. */
  createSheet(kind: string, name: string): Promise<string>;
  /** useProject's markNotName. Throws, changing nothing, when project.json can't be read. */
  markNotName(word: string, notName: boolean): void;
  /** The project on disk is changing: nothing can be made or marked until it has. */
  busy: boolean;
}

export interface PossibleNameMenuProps {
  hit: SuggestionHit;
  source: SuggestionSource;
  /** Closes the menu and puts the caret back in the text: after Add to, Escape or a press outside. */
  onClose(): void;
  /** Says something to screen readers, from a live region that stays when the menu goes. */
  announce(message: string): void;
}

interface Failure {
  message: string;
  /** The item that was pressed, which takes focus back from the moment it was disabled; null to leave focus. */
  refocus: number | null;
}

/**
 * The menu on a word marked in the text as a possible name. Add to (one
 * item per type that holds names) makes the sheet: the word is highlighted
 * as a name at once, and the menu closes with the caret back in the text.
 * Not a name stops marking the word everywhere; the menu stays, offering
 * Undo in the same place. A refusal shows in the menu, which stays open.
 */
export function PossibleNameMenu({ hit, source, onClose, announce }: PossibleNameMenuProps) {
  const { word } = hit;
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [dismissed, setDismissed] = useState(false);
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
    if (failure?.refocus == null || !focusLost()) return;
    const items = document.getElementById(id)?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[failure.refocus]?.focus();
  }, [failure, id]);

  const add = async (type: SheetType, item: number) => {
    if (locked) return;
    setCreating(true);
    setFailure(null);
    try {
      await source.createSheet(type.folder, word);
      announce(`${word} added to ${type.label}.`);
      if (live.current) onClose();
    } catch (error) {
      // Closed meanwhile: the refusal is still said.
      if (live.current) setFailure({ message: errorMessage(error), refocus: item });
      else announce(errorMessage(error));
    } finally {
      if (live.current) setCreating(false);
    }
  };

  const toggleNotName = () => {
    if (locked) return;
    try {
      source.markNotName(word, !dismissed);
      setFailure(null);
      setDismissed(!dismissed);
      announce(dismissed ? `${word} is offered as a name again.` : `${word} won’t be offered as a name again.`);
    } catch (error) {
      setFailure({ message: errorMessage(error), refocus: null });
    }
  };

  const title = dismissed ? "Not a name" : "Possible name";

  return (
    <>
      <Popover
        id={id}
        anchor={hit.rect}
        role="menu"
        label={`${title}: ${word}`}
        autoFocus
        busy={creating}
        onClose={onClose}
      >
        <div className="popover-title" role="none">
          {title}
        </div>
        {!dismissed &&
          source.types.map((type, i) => (
            <MenuItem key={type.folder} noCheck disabled={locked} onSelect={() => void add(type, i)}>
              Add to {type.label}
            </MenuItem>
          ))}
        {!dismissed && source.types.length > 0 && <div className="popover-gap" role="none" />}
        {/* One item, so focus stays on it as Not a name becomes Undo. */}
        <MenuItem noCheck disabled={locked} onSelect={toggleNotName}>
          {dismissed ? "Undo" : "Not a name"}
        </MenuItem>
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
