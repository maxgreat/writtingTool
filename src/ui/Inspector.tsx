import { ChevronLeft, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChapterDetails as Details } from "../core/binder";
import type { NameIndex } from "../core/nameIndex";
import type { IgnoredName, NameMatcher } from "../core/names";
import type { Chapter, Project, Sheet } from "../core/project";
import type { SheetEdit } from "../core/sheetFile";
import type { NameSuggestions } from "../core/useNameSuggestions";
import type { AppearancesSource } from "./AppearsIn";
import { ChapterDetails } from "./ChapterDetails";
import { cx, errorMessage, focusLost, formatCount } from "./dom";
import type { IgnoreSource } from "./IgnoreHere";
import { PossibleNames } from "./PossibleNames";
import { SheetForm } from "./SheetForm";
import { SheetView } from "./SheetView";
import { groupByType, namesFromCounts, sheetNoun, sheetSummary } from "./sheets";
import { Versions, type VersionSource } from "./Versions";

export type InspectorView =
  | { kind: "chapter" }
  | { kind: "type"; folder: string }
  /**
   * `editing`: the sheet's form, in place of the sheet as it reads.
   * `created`: the sheet was just made (here or in the binder): its form
   * opens with the caret in its first field. Done drops it.
   * `occurrence`: the name in the text it was opened from, if it was, for
   * Ignore here. It belongs to that opening only.
   */
  | { kind: "sheet"; id: string; editing?: boolean; created?: boolean; occurrence?: IgnoredName };

export interface InspectorProps {
  project: Project;
  chapter: Chapter | null;
  matcher: NameMatcher;
  /** The project's name index: the names in this chapter, and the chapters a sheet appears in. */
  index: NameIndex;
  sheetsById: Map<string, Sheet>;
  view: InspectorView;
  onViewChange(view: InspectorView): void;
  onOpenSheet(id: string): void;
  /** Opens a chapter from a sheet's Appears in list; the inspector keeps showing the sheet. */
  onOpenChapter(id: string): void;
  /** Sets the open chapter's synopsis, status or point of view. Throws when project.json can't be written. */
  onChapterDetails(id: string, details: Details): void;
  /** useProject's createSheet: resolves to the new sheet's id, or rejects with a message for the writer. */
  onCreateSheet(kind: string, name: string): Promise<string>;
  /** useProject's updateSheet: saved like an edit. Throws, changing nothing, when the edit is refused. */
  onUpdateSheet(id: string, edit: SheetEdit): void;
  /** Ignore here, under a sheet opened from the text, and each sheet's ignored mentions. */
  ignoring: IgnoreSource;
  /** The book's possible names (useNameSuggestions): This chapter lists those found in the open chapter. */
  suggestions: NameSuggestions;
  /** useProject's markNotName, for possible names. Throws, changing nothing, when project.json can't be read. */
  onMarkNotName(word: string, notName: boolean): void;
  /** The project on disk is changing: the chapter's details, sheets and Appears in wait until it has. */
  busy: boolean;
  /** The open chapter's earlier versions, listed under This chapter. */
  versions: VersionSource;
  /** Whether the panel is on screen; versions are only read then. */
  visible: boolean;
}

/**
 * The right panel: a menu with This chapter and one entry per sheet type,
 * and the sheet of a clicked name, with the chapters it appears in and
 * Ignore here. A type's list makes new sheets; a sheet's Edit shows its
 * form, Done the sheet again. A chapter's details can be edited, its
 * possible names made into sheets, and its earlier versions restored.
 */
export function Inspector({
  project,
  chapter,
  matcher,
  index,
  sheetsById,
  view,
  onViewChange,
  onOpenSheet,
  onOpenChapter,
  onChapterDetails,
  onCreateSheet,
  onUpdateSheet,
  ignoring,
  suggestions,
  onMarkNotName,
  busy,
  versions,
  visible,
}: InspectorProps) {
  const sheet = view.kind === "sheet" ? (sheetsById.get(view.id) ?? null) : null;
  // A sheet that disappeared (another project was opened) falls back to the chapter.
  const shown: InspectorView = view.kind === "sheet" && !sheet ? { kind: "chapter" } : view;
  const activeTab = shown.kind === "chapter" ? "chapter" : shown.kind === "type" ? shown.folder : sheet!.kind;
  const sheetType = sheet ? project.sheetTypes.find((t) => t.folder === sheet.kind) : undefined;
  // A sheet whose header can't be read has no form: it says why instead.
  const editing = shown.kind === "sheet" && shown.editing === true && sheet !== null && sheet.editable;
  const headingId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** A sheet just made: its form opens with the caret in its first field. */
  const fillIn = editing && shown.created === true;

  // Focus follows the form as it opens. Edit becomes Done where it was, so
  // focus stays there; from elsewhere (the phone's preview) it goes to Done,
  // and a new sheet starts in its first field.
  const formKey = editing ? `${project.root}\n${sheet.id}` : null;
  useEffect(() => {
    if (formKey === null) return;
    const body = bodyRef.current;
    if (fillIn) body?.querySelector<HTMLElement>(".sheet-form .fields input, .sheet-form textarea")?.focus();
    else if (!body?.contains(document.activeElement)) toggleRef.current?.focus({ preventScroll: true });
  }, [formKey]);

  const sheetCreated = (id: string) => onViewChange({ kind: "sheet", id, editing: true, created: true });

  const appearances: AppearancesSource = {
    index,
    project,
    matcher,
    openChapterId: chapter?.id ?? null,
    onOpenChapter,
    busy,
  };

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

      <div ref={bodyRef} className="inspector-body">
        {shown.kind === "chapter" && (
          <ChapterInfo
            project={project}
            chapter={chapter}
            matcher={matcher}
            index={index}
            sheetsById={sheetsById}
            onOpenSheet={onOpenSheet}
            onChapterDetails={onChapterDetails}
            onCreateSheet={onCreateSheet}
            suggestions={suggestions}
            onMarkNotName={onMarkNotName}
            busy={busy}
            versions={versions}
            visible={visible}
          />
        )}
        {shown.kind === "type" && (
          // Keyed by project and type: a name being typed belongs to that list.
          <SheetList
            key={`${project.root}\n${shown.folder}`}
            project={project}
            folder={shown.folder}
            onOpenSheet={onOpenSheet}
            onCreate={onCreateSheet}
            onCreated={sheetCreated}
            busy={busy}
          />
        )}
        {shown.kind === "sheet" && sheet && (
          <>
            <div className="sheet-nav">
              <button
                type="button"
                className="btn btn--quiet back-link"
                onClick={() => onViewChange({ kind: "type", folder: sheet.kind })}
              >
                <ChevronLeft aria-hidden />
                <span className="back-link-label">{sheetType?.label ?? sheet.kind}</span>
              </button>
              {sheet.editable && (
                <button
                  ref={toggleRef}
                  type="button"
                  className={cx("btn edit-toggle", editing ? "btn--primary" : "btn--quiet")}
                  // The opening stays the same, so the name it came from is kept for Done.
                  // The sheet is only new once: Edit after Done goes back to Done.
                  onClick={() => {
                    const { created: _created, ...opening } = shown;
                    onViewChange({ ...opening, editing: !editing });
                  }}
                >
                  {editing ? "Done" : "Edit"}
                </button>
              )}
            </div>
            {editing ? (
              // Keyed by project and sheet: sheet ids are paths, so another project can reuse one.
              <SheetForm
                key={formKey}
                sheet={sheet}
                type={sheetType}
                onChange={onUpdateSheet}
                busy={busy}
              />
            ) : (
              <SheetView
                key={sheet.id}
                sheet={sheet}
                headingId={headingId}
                appearances={appearances}
                occurrence={shown.occurrence}
                ignoring={ignoring}
              />
            )}
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
  index,
  sheetsById,
  onOpenSheet,
  onChapterDetails,
  onCreateSheet,
  suggestions,
  onMarkNotName,
  busy,
  versions,
  visible,
}: Pick<
  InspectorProps,
  | "project"
  | "chapter"
  | "matcher"
  | "index"
  | "sheetsById"
  | "onOpenSheet"
  | "onChapterDetails"
  | "onCreateSheet"
  | "suggestions"
  | "onMarkNotName"
  | "busy"
  | "versions"
  | "visible"
>) {
  const id = chapter?.id ?? null;
  const text = chapter?.text ?? "";
  const found = useMemo(
    () => (id === null ? [] : namesFromCounts(index.counts({ id, text }, matcher), sheetsById)),
    [id, text, index, matcher, sheetsById],
  );

  /** Said to screen readers: what a possible name became. */
  const [note, setNote] = useState("");
  /** A sheet just made from a possible name: its row here takes focus once it shows. */
  const [focusSheet, setFocusSheet] = useState<string | null>(null);
  const nameRows = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (focusSheet === null) return;
    const row = nameRows.current.get(focusSheet);
    if (!row) return;
    setFocusSheet(null);
    if (focusLost()) row.focus();
  }, [focusSheet, found]);

  if (!chapter) return <p className="empty-note">No chapter is open.</p>;

  const groups = groupByType(found, project.sheetTypes, (item) => item.sheet.kind);

  return (
    <section className="chapter-info" aria-label="This chapter">
      <h2 className="inspector-heading">{chapter.title}</h2>
      {/* Keyed by project and chapter: chapter ids are paths, so another project can reuse one. */}
      <ChapterDetails
        key={`details\n${project.root}\n${chapter.id}`}
        project={project}
        chapter={chapter}
        onChange={onChapterDetails}
        busy={busy}
        onOpenSheet={onOpenSheet}
      />

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
                    <button
                      ref={(el) => {
                        if (el) nameRows.current.set(sheet.id, el);
                        else nameRows.current.delete(sheet.id);
                      }}
                      type="button"
                      className="list-row"
                      onClick={() => onOpenSheet(sheet.id)}
                    >
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

      {/* Keyed by project and chapter: what was marked here belongs to this chapter's list. */}
      <PossibleNames
        key={`possible\n${project.root}\n${chapter.id}`}
        project={project}
        chapterId={chapter.id}
        suggestions={suggestions}
        busy={busy}
        onCreateSheet={onCreateSheet}
        onMarkNotName={onMarkNotName}
        onCreated={setFocusSheet}
        announce={setNote}
      />
      <p className="visually-hidden" role="status">
        {note}
      </p>

      {/* Keyed by project and chapter: chapter ids are paths, so another project can reuse one. */}
      <Versions key={`${project.root}\n${chapter.id}`} chapterId={chapter.id} visible={visible} {...versions} />
    </section>
  );
}

interface SheetListProps {
  project: Project;
  folder: string;
  onOpenSheet(id: string): void;
  onCreate(kind: string, name: string): Promise<string>;
  /** A sheet was made: show its form. */
  onCreated(id: string): void;
  busy: boolean;
}

/**
 * A type's sheets, and New character (or place, note, sheet) at the top,
 * which asks for the name in place: Enter makes the sheet, Escape cancels,
 * and a refusal shows below the name, which stays as typed.
 */
function SheetList({ project, folder, onOpenSheet, onCreate, onCreated, busy }: SheetListProps) {
  const type = project.sheetTypes.find((t) => t.folder === folder);
  const sheets = project.sheets.filter((s) => s.kind === folder);
  const label = type?.label ?? folder;
  const noun = sheetNoun(folder);

  /** The new sheet's name being typed; null while New shows. */
  const [draft, setDraft] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const locked = busy || creating;
  const errorId = useId();
  const newRef = useRef<HTMLButtonElement>(null);

  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /** Set by Escape: focus goes back to New once it is on screen again. */
  const backToNew = useRef(false);
  useEffect(() => {
    if (draft !== null || !backToNew.current) return;
    backToNew.current = false;
    newRef.current?.focus();
  }, [draft]);

  const close = () => {
    setDraft(null);
    setFailure(null);
  };

  const create = async () => {
    if (draft === null || locked) return;
    setCreating(true);
    setFailure(null);
    try {
      const id = await onCreate(folder, draft);
      // The list may be gone by now (another tab, another project): the sheet is made all the same.
      if (live.current) onCreated(id);
    } catch (error) {
      if (live.current) setFailure(errorMessage(error));
    } finally {
      if (live.current) setCreating(false);
    }
  };

  return (
    <section className="sheet-list" aria-label={label} aria-busy={creating}>
      {draft === null ? (
        <button
          ref={newRef}
          type="button"
          className="btn btn--quiet add-button"
          disabled={busy}
          onClick={() => setDraft("")}
        >
          <Plus aria-hidden />
          New {noun}
        </button>
      ) : (
        <div className="new-sheet">
          <input
            className="input"
            value={draft}
            aria-label={`Name of the new ${noun}`}
            placeholder="Name"
            readOnly={locked}
            aria-busy={creating}
            aria-invalid={failure !== null}
            aria-describedby={failure !== null ? errorId : undefined}
            enterKeyHint="done"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setDraft(event.target.value);
              setFailure(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void create();
              } else if (event.key === "Escape") {
                // Handled here, so the phone layout doesn't also close the inspector.
                event.preventDefault();
                event.stopPropagation();
                if (creating) return;
                backToNew.current = true;
                close();
              }
            }}
            onBlur={() => {
              // Leaving an empty name drops it; a typed one waits for Enter.
              if (!creating && draft.trim() === "") close();
            }}
          />
          {failure !== null && (
            <p id={errorId} className="inline-error" role="alert">
              {failure}
            </p>
          )}
        </div>
      )}

      {sheets.length === 0 ? (
        draft === null && <p className="empty-note">No {label.toLowerCase()} yet.</p>
      ) : (
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
      )}
    </section>
  );
}
