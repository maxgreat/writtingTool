import type { ReactNode } from "react";
import type { IgnoredName } from "../core/names";
import { holdsNames, type Sheet } from "../core/project";
import { AppearsIn, type AppearancesSource } from "./AppearsIn";
import { Notes } from "./Notes";
import { IgnoredMentions, TextOccurrence, type IgnoreSource } from "./IgnoreHere";
import { occurrenceKey } from "./occurrence";
import { fieldLabel, looksNumeric } from "./sheets";

export interface SheetViewProps {
  sheet: Sheet;
  actions?: ReactNode;
  headingId?: string;
  /** Where the chapters it appears in come from; without it, the sheet has no Appears in list. */
  appearances?: AppearancesSource;
  /**
   * The name in the text the sheet was opened from, if it was: shown under
   * the name with Ignore here. Only for that opening; a sheet opened from a
   * list has none.
   */
  occurrence?: IgnoredName;
  /** For Ignore here and the sheet's ignored mentions; without it, neither shows. */
  ignoring?: IgnoreSource;
}

/**
 * A sheet, read-only: name, aliases, the name in the text it was opened
 * from, typed fields, the chapters it appears in, the mentions left
 * unhighlighted, and notes. A sheet whose header can't be read says why it
 * can't be edited in the app.
 */
export function SheetView({ sheet, actions, headingId, appearances, occurrence, ignoring }: SheetViewProps) {
  const named = holdsNames(sheet.kind);
  return (
    <article className="sheet" aria-labelledby={headingId}>
      <header className="sheet-header">
        <h2 id={headingId} className="sheet-name">
          {sheet.name}
        </h2>
        {actions}
      </header>

      {!sheet.editable && (
        <p className="sheet-locked muted">
          The header of <span className="path">{sheet.id}</span> can’t be read, so this sheet can’t be edited here. Fix
          the header in the file.
        </p>
      )}

      {sheet.aliases.length > 0 && (
        <p className="sheet-aliases">
          <span className="muted">Also called </span>
          {sheet.aliases.map((alias) => alias.text).join(", ")}
        </p>
      )}

      {occurrence && ignoring && named && (
        <TextOccurrence key={occurrenceKey(occurrence)} occurrence={occurrence} kind={sheet.kind} source={ignoring} />
      )}

      {sheet.fields.length > 0 && (
        <dl className="fields">
          {sheet.fields.map(([key, value]) => (
            <div key={key} className="field">
              <dt>{fieldLabel(key)}</dt>
              <dd className={looksNumeric(value) ? "num" : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {appearances && <AppearsIn sheet={sheet} source={appearances} />}

      {ignoring && named && <IgnoredMentions sheet={sheet} source={ignoring} opened={occurrence} />}

      <section className="sheet-notes" aria-label="Notes">
        <h3 className="section-label">Notes</h3>
        {sheet.body.trim() === "" ? <p className="empty-note">No notes yet.</p> : <Notes markdown={sheet.body} />}
      </section>
    </article>
  );
}
