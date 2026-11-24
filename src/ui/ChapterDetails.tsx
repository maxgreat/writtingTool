import { ArrowRight, ChevronDown } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ChapterDetails as Details } from "../core/binder";
import type { Chapter, Project } from "../core/project";
import { errorMessage } from "./dom";
import { useFitHeight } from "./hooks";
import { sheetNamed } from "./sheets";

type Field = "synopsis" | "status" | "pov";
type Values = Record<Field, string>;

export interface ChapterDetailsProps {
  project: Project;
  chapter: Chapter;
  /** useProject's updateChapterDetails: saved like an edit. Throws when project.json can't be written. */
  onChange(id: string, details: Details): void;
  /** The project on disk is changing: the fields wait until it has. */
  busy: boolean;
  onOpenSheet(id: string): void;
}

const valuesOf = (chapter: Chapter): Values => ({
  synopsis: chapter.synopsis,
  status: chapter.status,
  pov: chapter.pov,
});

/** Who can tell the chapter: every character sheet, plus the current value if it names none of them. */
export function povChoices(project: Project, current: string): string[] {
  const names = [...new Set(project.sheets.filter((s) => s.kind === "characters").map((s) => s.name))];
  return current !== "" && !names.includes(current) ? [...names, current] : names;
}

/** The statuses to choose from, plus the current value if the list leaves it out. */
export function statusChoices(project: Project, current: string): string[] {
  return current !== "" && !project.statuses.includes(current) ? [...project.statuses, current] : project.statuses;
}

/**
 * The open chapter's synopsis, status and point of view, saved as they
 * change. Mount one per chapter (key it by project and chapter). A value
 * the project refuses stays in its field, with the reason below it.
 */
export function ChapterDetails({ project, chapter, onChange, busy, onOpenSheet }: ChapterDetailsProps) {
  const [values, setValues] = useState<Values>(() => valuesOf(chapter));
  const [failure, setFailure] = useState<{ field: Field; message: string } | null>(null);

  // A field follows the chapter when the chapter's value changes (saved, or
  // read again from disk); a value that was refused leaves the chapter as it
  // was, so the field keeps what the writer chose.
  const [seen, setSeen] = useState<Values>(() => valuesOf(chapter));
  const current = valuesOf(chapter);
  const changed = (Object.keys(current) as Field[]).filter((field) => current[field] !== seen[field]);
  if (changed.length > 0) {
    setSeen(current);
    setValues((shown) => {
      const next = { ...shown };
      for (const field of changed) next[field] = current[field];
      return next;
    });
  }

  const set = (field: Field, value: string) => {
    setValues((shown) => ({ ...shown, [field]: value }));
    try {
      onChange(chapter.id, { [field]: value });
      setFailure((f) => (f?.field === field ? null : f));
    } catch (error) {
      setFailure({ field, message: errorMessage(error) });
    }
  };

  const synopsisRef = useRef<HTMLTextAreaElement>(null);
  useFitHeight(synopsisRef, values.synopsis);

  const ids = useId();
  const errorId = (field: Field) => `${ids}-${field}-error`;
  const error = (field: Field) =>
    failure?.field === field ? (
      <p id={errorId(field)} className="inline-error" role="alert">
        {failure.message}
      </p>
    ) : null;
  const invalid = (field: Field) =>
    failure?.field === field ? { "aria-invalid": true, "aria-describedby": errorId(field) } : {};

  const povSheet = sheetNamed(project.sheets, values.pov);

  return (
    <div className="chapter-details">
      <div className="synopsis-field">
        <textarea
          ref={synopsisRef}
          className="input synopsis-input"
          rows={2}
          value={values.synopsis}
          aria-label="Synopsis"
          placeholder="What happens in this chapter?"
          readOnly={busy}
          onChange={(event) => set("synopsis", event.target.value)}
          {...invalid("synopsis")}
        />
        {error("synopsis")}
      </div>

      <dl className="fields fields--edit">
        <div className="field">
          <dt>
            <label htmlFor={`${ids}-status`}>Status</label>
          </dt>
          <dd>
            <span className="select">
              <select
                id={`${ids}-status`}
                className="input"
                value={values.status}
                disabled={busy}
                onChange={(event) => set("status", event.target.value)}
                {...invalid("status")}
              >
                <option value="">Not set</option>
                {statusChoices(project, values.status).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <ChevronDown className="chevron" aria-hidden />
            </span>
            {error("status")}
          </dd>
        </div>
        <div className="field">
          <dt>
            <label htmlFor={`${ids}-pov`}>Point of view</label>
          </dt>
          <dd>
            <span className="pov-row">
              <span className="select">
                <select
                  id={`${ids}-pov`}
                  className="input"
                  value={values.pov}
                  disabled={busy}
                  onChange={(event) => set("pov", event.target.value)}
                  {...invalid("pov")}
                >
                  <option value="">Not set</option>
                  {povChoices(project, values.pov).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="chevron" aria-hidden />
              </span>
              {povSheet && (
                <button
                  type="button"
                  className="btn btn--icon btn--quiet"
                  aria-label={`Open ${povSheet.name}’s sheet`}
                  title={`Open ${povSheet.name}’s sheet`}
                  onClick={() => onOpenSheet(povSheet.id)}
                >
                  <ArrowRight aria-hidden />
                </button>
              )}
            </span>
            {error("pov")}
          </dd>
        </div>
      </dl>
    </div>
  );
}
