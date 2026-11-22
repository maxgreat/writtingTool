import { ChevronLeft } from "lucide-react";
import { useId, useMemo } from "react";
import type { NameMatcher } from "../core/names";
import type { Chapter, Project, Sheet } from "../core/project";
import { cx, formatCount } from "./dom";
import { SheetView } from "./SheetView";
import { groupByType, namesInText, sheetNamed, sheetSummary } from "./sheets";
import { Versions, type VersionSource } from "./Versions";

export type InspectorView = { kind: "chapter" } | { kind: "type"; folder: string } | { kind: "sheet"; id: string };

export interface InspectorProps {
  project: Project;
  chapter: Chapter | null;
  matcher: NameMatcher;
  sheetsById: Map<string, Sheet>;
  view: InspectorView;
  onViewChange(view: InspectorView): void;
  onOpenSheet(id: string): void;
  /** The open chapter's earlier versions, listed under This chapter. */
  versions: VersionSource;
  /** Whether the panel is on screen; versions are only read then. */
  visible: boolean;
}

/**
 * The right panel: a menu with This chapter and one entry per sheet type,
 * and the sheet of a clicked name. Sheets are read-only in this prototype;
 * a chapter's earlier versions can be restored.
 */
export function Inspector({
  project,
  chapter,
  matcher,
  sheetsById,
  view,
  onViewChange,
  onOpenSheet,
  versions,
  visible,
}: InspectorProps) {
  const sheet = view.kind === "sheet" ? (sheetsById.get(view.id) ?? null) : null;
  // A sheet that disappeared (another project was opened) falls back to the chapter.
  const shown: InspectorView = view.kind === "sheet" && !sheet ? { kind: "chapter" } : view;
  const activeTab = shown.kind === "chapter" ? "chapter" : shown.kind === "type" ? shown.folder : sheet!.kind;
  const headingId = useId();

  return (
    <aside className="inspector" aria-label="Inspector">
      <nav className="inspector-tabs" aria-label="Inspector sections">
        <button
          type="button"
          className="tab"
          aria-current={activeTab === "chapter" ? "true" : undefined}
          onClick={() => onViewChange({ kind: "chapter" })}
        >
          This chapter
        </button>
        {project.sheetTypes.map((type) => (
          <button
            key={type.folder}
            type="button"
            className="tab"
            aria-current={activeTab === type.folder ? "true" : undefined}
            onClick={() => onViewChange({ kind: "type", folder: type.folder })}
          >
            {type.label}
          </button>
        ))}
      </nav>

      <div className="inspector-body">
        {shown.kind === "chapter" && (
          <ChapterInfo
            project={project}
            chapter={chapter}
            matcher={matcher}
            sheetsById={sheetsById}
            onOpenSheet={onOpenSheet}
            versions={versions}
            visible={visible}
          />
        )}
        {shown.kind === "type" && <SheetList project={project} folder={shown.folder} onOpenSheet={onOpenSheet} />}
        {shown.kind === "sheet" && sheet && (
          <>
            <button
              type="button"
              className="btn btn--quiet back-link"
              onClick={() => onViewChange({ kind: "type", folder: sheet.kind })}
            >
              <ChevronLeft aria-hidden />
              {project.sheetTypes.find((t) => t.folder === sheet.kind)?.label ?? sheet.kind}
            </button>
            <SheetView key={sheet.id} sheet={sheet} headingId={headingId} />
          </>
        )}
      </div>
    </aside>
  );
}

function ChapterInfo({
  project,
  chapter,
  matcher,
  sheetsById,
  onOpenSheet,
  versions,
  visible,
}: Pick<InspectorProps, "project" | "chapter" | "matcher" | "sheetsById" | "onOpenSheet" | "versions" | "visible">) {
  const text = chapter?.text ?? "";
  const found = useMemo(() => namesInText(text, matcher, sheetsById), [text, matcher, sheetsById]);
  if (!chapter) return <p className="empty-note">No chapter is open.</p>;

  const groups = groupByType(found, project.sheetTypes, (item) => item.sheet.kind);
  const povSheet = sheetNamed(project.sheets, chapter.pov);

  return (
    <section className="chapter-info" aria-label="This chapter">
      <h2 className="inspector-heading">{chapter.title}</h2>
      {chapter.synopsis ? (
        <p className="synopsis">{chapter.synopsis}</p>
      ) : (
        <p className="empty-note">No synopsis.</p>
      )}

      <dl className="fields">
        <div className="field">
          <dt>Status</dt>
          <dd className={cx(!chapter.status && "muted")}>{chapter.status || "Not set"}</dd>
        </div>
        <div className="field">
          <dt>Point of view</dt>
          <dd className={cx(!chapter.pov && "muted")}>
            {povSheet ? (
              <button type="button" className="text-link" onClick={() => onOpenSheet(povSheet.id)}>
                {chapter.pov}
              </button>
            ) : (
              chapter.pov || "Not set"
            )}
          </dd>
        </div>
      </dl>

      <section className="names-found" aria-label="Names in this chapter">
        <h3 className="section-label">Names in this chapter</h3>
        {groups.length === 0 ? (
          <p className="empty-note">No names from your sheets appear in this chapter yet.</p>
        ) : (
          groups.map(({ type, items }) => (
            <div key={type.folder} className="name-group">
              <h4 className="group-label">{type.label}</h4>
              <ul>
                {items.map(({ sheet, count }) => (
                  <li key={sheet.id}>
                    <button type="button" className="list-row" onClick={() => onOpenSheet(sheet.id)}>
                      <span className="list-row-title">{sheet.name}</span>
                      <span className="num muted" aria-label={`${count} ${count === 1 ? "mention" : "mentions"}`}>
                        {formatCount(count)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {/* Keyed by project and chapter: chapter ids are paths, so another project can reuse one. */}
      <Versions key={`${project.root}\n${chapter.id}`} chapterId={chapter.id} visible={visible} {...versions} />
    </section>
  );
}

function SheetList({ project, folder, onOpenSheet }: { project: Project; folder: string; onOpenSheet(id: string): void }) {
  const type = project.sheetTypes.find((t) => t.folder === folder);
  const sheets = project.sheets.filter((s) => s.kind === folder);
  const label = type?.label ?? folder;
  if (sheets.length === 0) {
    return (
      <p className="empty-note">
        No {label.toLowerCase()} yet. Add a Markdown file to <code className="path">sheets/{folder}/</code> in the project folder.
      </p>
    );
  }
  return (
    <section aria-label={label}>
      <ul>
        {sheets.map((sheet) => {
          const { field } = sheetSummary(sheet);
          return (
            <li key={sheet.id}>
              <button type="button" className="list-row list-row--stacked" onClick={() => onOpenSheet(sheet.id)}>
                <span className="list-row-title">{sheet.name}</span>
                {field && <span className="muted">{field[1]}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
