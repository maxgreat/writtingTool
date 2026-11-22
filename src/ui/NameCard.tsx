import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { NameHit } from "../core/editor/types";
import type { Sheet } from "../core/project";
import { placeNear } from "./dom";
import { MenuItem, Popover } from "./Popover";
import { fieldLabel, sheetSummary } from "./sheets";

/**
 * The summary card shown while the pointer rests on a name (desktop only):
 * the name, its first field such as role, and the first line of its notes.
 */
export function NameCard({ hit, sheets, clickHint }: { hit: NameHit; sheets: Sheet[]; clickHint: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) placeNear(ref.current, hit.rect);
  }, [hit]);

  if (sheets.length === 0) return null;
  const single = sheets.length === 1 ? sheets[0] : null;
  const summary = single ? sheetSummary(single) : null;

  return createPortal(
    <div ref={ref} className="name-card" role="tooltip">
      {single && summary ? (
        <>
          <p className="name-card-name">{single.name}</p>
          {summary.field && (
            <p className="name-card-field">
              <span className="muted">{fieldLabel(summary.field[0])}</span> {summary.field[1]}
            </p>
          )}
          {summary.firstLine && <p className="name-card-notes">{summary.firstLine}</p>}
        </>
      ) : (
        <>
          <p className="name-card-field muted">Shared by {sheets.length} sheets</p>
          <ul className="name-card-list">
            {sheets.map((sheet) => {
              const { field } = sheetSummary(sheet);
              return (
                <li key={sheet.id}>
                  <span className="name-card-name">{sheet.name}</span>
                  {field && <span className="muted"> {field[1]}</span>}
                </li>
              );
            })}
          </ul>
          {clickHint && <p className="name-card-hint muted">Click to choose one</p>}
        </>
      )}
    </div>,
    document.body,
  );
}

/** The choice offered when a clicked name belongs to several sheets. */
export function NameChoice({
  hit,
  sheets,
  onChoose,
  onClose,
}: {
  hit: NameHit;
  sheets: Sheet[];
  onChoose(id: string): void;
  onClose(): void;
}) {
  return (
    <Popover anchor={hit.rect} role="menu" label="Open which sheet?" autoFocus onClose={onClose}>
      <div className="popover-title" role="none">
        Open which sheet?
      </div>
      {sheets.map((sheet) => {
        const { field } = sheetSummary(sheet);
        return (
          <MenuItem key={sheet.id} noCheck onSelect={() => onChoose(sheet.id)} hint={field?.[1]}>
            {sheet.name}
          </MenuItem>
        );
      })}
    </Popover>
  );
}
