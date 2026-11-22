import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { Chapter, Project } from "../core/project";
import { formatCount } from "./dom";
import { SheetTypeIcon } from "./SheetTypeIcon";
import { useOpenFolder } from "./useOpenFolder";

export interface BinderProps {
  project: Project;
  openChapterId: string | null;
  onOpenChapter(id: string): void;
  onOpenSheet(id: string): void;
  /** Present only when this device can show a folder picker. */
  onOpenFolder?: () => Promise<void>;
}

/**
 * The left panel: the project title, parts as folders with their chapters,
 * then each sheet type with its sheets.
 */
export function Binder({ project, openChapterId, onOpenChapter, onOpenSheet, onOpenFolder }: BinderProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chapterRow = (id: string, nested: boolean) => {
    const chapter = project.chapters[id];
    if (!chapter) return null;
    return (
      <li key={id}>
        <ChapterRow
          chapter={chapter}
          nested={nested}
          current={id === openChapterId}
          onOpen={() => onOpenChapter(id)}
        />
      </li>
    );
  };

  return (
    <nav className="binder" aria-label="Binder">
      <h1 className="binder-title">{project.title}</h1>

      <section aria-label="Manuscript">
        {project.chapterOrder.length === 0 ? (
          <p className="empty-note">No chapters yet.</p>
        ) : (
          <ul className="binder-list">
            {project.binder.map((item) =>
              item.type === "chapter" ? (
                chapterRow(item.id, false)
              ) : (
                <li key={item.id}>
                  <Group
                    label={item.title}
                    icon={collapsed.has(item.id) ? <Folder aria-hidden /> : <FolderOpen aria-hidden />}
                    open={!collapsed.has(item.id)}
                    onToggle={() => toggle(item.id)}
                  >
                    {item.chapterIds.length === 0 ? (
                      <p className="empty-note empty-note--nested">No chapters in this part.</p>
                    ) : (
                      <ul className="binder-list">{item.chapterIds.map((id) => chapterRow(id, true))}</ul>
                    )}
                  </Group>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <section aria-label="Sheets">
        <ul className="binder-list">
          {project.sheetTypes.map((type) => {
            const sheets = project.sheets.filter((s) => s.kind === type.folder);
            const id = `sheets/${type.folder}`;
            return (
              <li key={type.folder}>
                <Group
                  label={type.label}
                  icon={<SheetTypeIcon folder={type.folder} />}
                  open={!collapsed.has(id)}
                  onToggle={() => toggle(id)}
                >
                  {sheets.length === 0 ? (
                    <p className="empty-note empty-note--nested">No sheets yet.</p>
                  ) : (
                    <ul className="binder-list">
                      {sheets.map((sheet) => (
                        <li key={sheet.id}>
                          <button type="button" className="binder-row binder-row--nested" onClick={() => onOpenSheet(sheet.id)}>
                            <span className="binder-row-title">{sheet.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Group>
              </li>
            );
          })}
        </ul>
      </section>

      {onOpenFolder && <OpenFolder onOpenFolder={onOpenFolder} />}
    </nav>
  );
}

function ChapterRow({
  chapter,
  nested,
  current,
  onOpen,
}: {
  chapter: Chapter;
  nested: boolean;
  current: boolean;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className={nested ? "binder-row binder-row--chapter binder-row--nested" : "binder-row binder-row--chapter"}
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
    >
      <span className="binder-row-title">{chapter.title}</span>
      <span className="binder-row-meta">
        <span>{chapter.status}</span>
        <span className="num">
          {formatCount(chapter.wordCount)}
          <span className="visually-hidden"> words</span>
        </span>
      </span>
    </button>
  );
}

function Group({
  label,
  icon,
  open,
  onToggle,
  children,
}: {
  label: string;
  icon: ReactNode;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  // Unique per group, whatever characters its folder name has.
  const contentId = useId();
  return (
    <>
      <button
        type="button"
        className="binder-row binder-row--group"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <ChevronRight className="disclosure" aria-hidden />
        {icon}
        <span className="binder-row-title">{label}</span>
      </button>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </>
  );
}

function OpenFolder({ onOpenFolder }: { onOpenFolder(): Promise<void> }) {
  const { busy, error, run } = useOpenFolder(onOpenFolder);
  return (
    <div className="binder-footer">
      <button type="button" className="btn btn--quiet" onClick={run} disabled={busy}>
        <FolderOpen aria-hidden />
        {busy ? "Opening…" : "Open folder…"}
      </button>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
