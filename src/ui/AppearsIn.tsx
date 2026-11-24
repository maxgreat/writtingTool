import { useMemo } from "react";
import type { Appearance, NameIndex } from "../core/nameIndex";
import type { NameMatcher } from "../core/names";
import { holdsNames, type BinderItem, type Chapter, type Project, type Sheet } from "../core/project";
import { formatCount, plural } from "./dom";

/** What a sheet's Appears in list needs from the workspace. */
export interface AppearancesSource {
  /** The project's name index, kept by the workspace so only an edited chapter is scanned again. */
  index: NameIndex;
  project: Project;
  matcher: NameMatcher;
  /** The chapter open in the editor, marked in the list. */
  openChapterId: string | null;
  onOpenChapter(id: string): void;
  /** The project on disk is changing: the rows open nothing until it has. */
  busy: boolean;
}

interface Group {
  key: string;
  /** The part's title; null for chapters outside any part. */
  title: string | null;
  rows: { chapter: Chapter; count: number }[];
}

/**
 * The chapters found, grouped as the binder shows them: chapters outside
 * any part without a label, a part's chapters under its title. The binder
 * is in reading order, so the groups and their rows are too.
 */
function groupByPart(binder: BinderItem[], chapters: Record<string, Chapter>, found: Appearance[]): Group[] {
  const counts = new Map(found.map((a) => [a.chapterId, a.count]));
  const rowsFor = (ids: string[]) =>
    ids.flatMap((id) => {
      const chapter = chapters[id];
      const count = counts.get(id);
      return chapter && count ? [{ chapter, count }] : [];
    });
  const groups: Group[] = [];
  for (const item of binder) {
    const rows = rowsFor(item.type === "part" ? item.chapterIds : [item.id]);
    if (rows.length === 0) continue;
    const last = groups.at(-1);
    if (item.type === "part") groups.push({ key: item.id, title: item.title, rows });
    else if (last && last.title === null) last.rows.push(...rows);
    else groups.push({ key: item.id, title: null, rows });
  }
  return groups;
}

/**
 * Appears in: the chapters where a sheet's name or aliases appear, in
 * reading order, with how often. A row opens its chapter. Sheets of a type
 * that holds no names (notes) have no such list.
 */
export function AppearsIn({ sheet, source }: { sheet: Sheet; source: AppearancesSource }) {
  const { index, project, matcher, openChapterId, onOpenChapter, busy } = source;
  const { chapters, chapterOrder, binder } = project;
  const named = holdsNames(sheet.kind);

  // Every chapter of the book goes to the index, which drops what it holds for any other.
  const found = useMemo(
    () =>
      named
        ? index.appearances(sheet.id, chapterOrder.flatMap((id) => chapters[id] ?? []), matcher)
        : [],
    [named, index, sheet.id, chapters, chapterOrder, matcher],
  );
  const groups = useMemo(() => groupByPart(binder, chapters, found), [binder, chapters, found]);

  if (!named) return null;

  return (
    <section className="sheet-appearances" aria-label="Appears in">
      <h3 className="section-label">Appears in</h3>
      {groups.length === 0 ? (
        <p className="empty-note">Not mentioned in any chapter yet.</p>
      ) : (
        groups.map(({ key, title, rows }) => (
          <div key={key} className="chapter-group">
            {title !== null && <h4 className="group-label">{title}</h4>}
            <ul>
              {rows.map(({ chapter, count }) => (
                <li key={chapter.id}>
                  <button
                    type="button"
                    className="list-row"
                    aria-current={chapter.id === openChapterId ? "page" : undefined}
                    disabled={busy}
                    onClick={() => onOpenChapter(chapter.id)}
                  >
                    <span className="list-row-title">{chapter.title}</span>
                    <span className="num muted" aria-label={plural(count, "mention", "mentions")}>
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
  );
}
