import type { ReactNode } from "react";
import type { Sheet } from "../core/project";
import { Notes } from "./Notes";
import { fieldLabel } from "./sheets";

const NUMERIC = /^[\d\s.,:/+−-]+$/u;

/** A sheet, read-only: name, aliases, typed fields and notes. */
export function SheetView({ sheet, actions, headingId }: { sheet: Sheet; actions?: ReactNode; headingId?: string }) {
  return (
    <article className="sheet" aria-labelledby={headingId}>
      <header className="sheet-header">
        <h2 id={headingId} className="sheet-name">
          {sheet.name}
        </h2>
        {actions}
      </header>

      {sheet.aliases.length > 0 && (
        <p className="sheet-aliases">
          <span className="muted">Also called </span>
          {sheet.aliases.map((alias) => alias.text).join(", ")}
        </p>
      )}

      {sheet.fields.length > 0 && (
        <dl className="fields">
          {sheet.fields.map(([key, value]) => (
            <div key={key} className="field">
              <dt>{fieldLabel(key)}</dt>
              <dd className={NUMERIC.test(value) ? "num" : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <section className="sheet-notes" aria-label="Notes">
        <h3 className="section-label">Notes</h3>
        {sheet.body.trim() === "" ? <p className="empty-note">No notes yet.</p> : <Notes markdown={sheet.body} />}
      </section>
    </article>
  );
}
