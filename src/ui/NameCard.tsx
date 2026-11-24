import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NameHit } from "../core/editor/types";
import type { Sheet } from "../core/project";
import { errorMessage, placeNear } from "./dom";
import type { IgnoreSource } from "./IgnoreHere";
import { isIgnored } from "./occurrence";
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

/**
 * The choice offered when a clicked name belongs to several sheets, and
 * Ignore here, for when it means none of them. After Ignore here the menu
 * stays open, offering Highlight again in the same place.
 */
export function NameChoice({
  hit,
  sheets,
  onChoose,
  onClose,
  ignoring,
}: {
  hit: NameHit;
  sheets: Sheet[];
  onChoose(id: string): void;
  onClose(): void;
  ignoring: IgnoreSource;
}) {
  const ignored = isIgnored(ignoring.ignored, hit.occurrence);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const name = hit.occurrence.name;

  const toggle = () => {
    try {
      ignoring.setIgnored(hit.occurrence, !ignored);
      setFailure(null);
      setNote(ignored ? `${name} is highlighted again here.` : `${name} is no longer highlighted here.`);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  return (
    <>
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
        <div className="popover-gap" role="none" />
        <MenuItem noCheck disabled={ignoring.busy} onSelect={toggle}>
          {ignored ? "Highlight again" : "Ignore here"}
        </MenuItem>
        {failure !== null && (
          <div className="popover-note inline-error" role="none">
            {failure}
          </div>
        )}
      </Popover>
      {/* Outside the menu, which holds only its items, so these are announced. */}
      <p className="visually-hidden" role="status">
        {note}
      </p>
      <p className="visually-hidden" role="alert">
        {failure ?? ""}
      </p>
    </>
  );
}
