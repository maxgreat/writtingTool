import { ChevronRight, Ellipsis, Folder, FolderOpen, Plus, Trash2 } from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  planMoveChapter,
  planMovePart,
  planNewChapter,
  planNewPart,
  planRenameChapter,
  planRenamePart,
  planRestore,
  planTrashChapter,
  planTrashPart,
  type ChapterDetails,
  type Place,
  type Plan,
} from "../core/binder";
import type { BinderItem, Project } from "../core/project";
import {
  chapterMoveTo,
  chapterPlace,
  chapterStep,
  partIndex,
  partStep,
  partsOf,
  partWords,
  trashSummary,
  type DragItem,
  type Move,
} from "./binderModel";
import { cx, errorMessage, formatCount, plural } from "./dom";
import { MenuButton, MenuItem, Popover } from "./Popover";
import { ProjectsButton, type ProjectsSource } from "./Projects";
import { SheetTypeIcon } from "./SheetTypeIcon";
import { useBinderDrag } from "./useBinderDrag";

type Part = Extract<BinderItem, { type: "part" }>;

export interface BinderProps {
  project: Project;
  openChapterId: string | null;
  onOpenChapter(id: string): void;
  onOpenSheet(id: string): void;
  /** The projects on this device, opened from the project title (see Projects.tsx). */
  projects: ProjectsSource;
  /**
   * Makes a change to the binder: useProject's changeBinder. Rejects with a
   * message for the writer; the binder shows it and keeps what was typed.
   */
  onChange(makePlan: (project: Project) => Plan | null): Promise<void>;
  /** Sets a chapter's status (useProject's updateChapterDetails). Throws when project.json can't be written. */
  onChapterDetails(id: string, details: ChapterDetails): void;
  /** The project on disk is changing (a binder change, a restore, another project): binder actions wait. */
  busy: boolean;
  /** A chapter was created and opened. */
  onChapterCreated?(): void;
  /** Goes up each time something outside the binder asks for a new chapter (the empty project's button). */
  newChapterRequest?: number;
}

/** What is being named in the binder: a new item at its place, or an item being renamed. */
type Naming =
  | { kind: "new-chapter"; place: Place }
  | { kind: "new-part"; index: number }
  | { kind: "rename-chapter"; id: string }
  | { kind: "rename-part"; id: string };

/** Also where focus goes back if the title is dropped. */
type Editing = Naming & { returnTo(): void };

interface MenuState {
  item: DragItem;
  /** Where the menu hangs: the pointer for a right-click or long-press, else the row's More button. */
  anchor: DOMRect | RefObject<HTMLElement | null>;
  /** The More button when the menu was opened with it: pressing it again closes the menu. */
  trigger: RefObject<HTMLElement | null> | undefined;
  /** Where focus goes back when the menu closes with Escape. */
  returnTo: HTMLElement | null;
}

/** Which row a failure belongs to: "chapter:<id>", "part:<id>", "trash:<id>", "edit" (the title input) or "manuscript". */
interface Failure {
  at: string;
  message: string;
}

/** The Trash folds like a part; its key in `collapsed` can't be a part's or a sheet type's. */
const TRASH_GROUP = "trash";

/**
 * The left panel: the project title (which opens the Projects view), parts
 * as folders with their chapters, each sheet type with its sheets, then the
 * Trash. Chapters and parts have a menu (right-click, long-press, or the
 * More button) to rename, set a status, move, add and trash; a mouse or pen
 * can also drag them.
 */
export function Binder({
  project,
  openChapterId,
  onOpenChapter,
  onOpenSheet,
  projects,
  onChange,
  onChapterDetails,
  busy: projectBusy,
  onChapterCreated,
  newChapterRequest = 0,
}: BinderProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set([TRASH_GROUP]));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  /** The row whose change is under way. */
  const [working, setWorking] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const busy = projectBusy || working !== null;

  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const editErrorId = `${baseId}-edit-error`;
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  /** Run after the next render, once the rows it needs are on screen. */
  const afterRender = useRef<(() => void) | null>(null);

  useEffect(() => {
    const run = afterRender.current;
    afterRender.current = null;
    run?.();
  });

  // Another project: nothing in progress here belongs to it.
  const [root, setRoot] = useState(project.root);
  if (root !== project.root) {
    setRoot(project.root);
    setMenu(null);
    setEditing(null);
    setFailure(null);
  }

  const expand = (id: string) =>
    setCollapsed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const startEditing = (next: Naming, initial: string, returnTo: () => void) => {
    setMenu(null);
    setAddOpen(false);
    setFailure(null);
    setEditing({ ...next, returnTo });
    setDraft(initial);
    if (next.kind === "new-chapter" && next.place.partId) expand(next.place.partId);
  };

  const addButton = () => addRef.current?.querySelector<HTMLElement>("button") ?? null;

  const focusRow = (type: DragItem["type"], id: string) => () => {
    const rows = navRef.current?.querySelectorAll<HTMLElement>(`[data-drag-row="${type}"]`) ?? [];
    const row = [...rows].find((r) => r.dataset.dragId === id);
    row?.querySelector<HTMLElement>(".binder-row")?.focus();
  };

  // The empty project's "New chapter" button: a new chapter at the end of the binder.
  const [seenRequest, setSeenRequest] = useState(newChapterRequest);
  if (seenRequest !== newChapterRequest) {
    setSeenRequest(newChapterRequest);
    if (!busy) {
      startEditing({ kind: "new-chapter", place: { partId: null, index: project.binder.length } }, "", () =>
        addButton()?.focus(),
      );
    }
  }

  /**
   * Asks the core for a change. Resolves true once it is made, false if it
   * failed (the message shows by the row `at`) or another change was under
   * way and this one never started.
   */
  const change = async (at: string, makePlan: (current: Project) => Plan | null): Promise<boolean> => {
    if (busy) return false;
    setMenu(null);
    setFailure(null);
    setWorking(at);
    const result: { ran: boolean; plan: Plan | null } = { ran: false, plan: null };
    try {
      await onChange((current) => {
        result.ran = true;
        result.plan = makePlan(current);
        return result.plan;
      });
    } catch (error) {
      setFailure({ at, message: errorMessage(error) });
      return false;
    } finally {
      setWorking(null);
    }
    if (result.plan?.created) onChapterCreated?.();
    return result.ran;
  };

  /** A menu action: the menu closes, focus goes back where the menu came from, and comes back there if it fails. */
  const menuAction = (at: string, makePlan: (current: Project) => Plan | null) => {
    const returnTo = menu?.returnTo ?? null;
    returnTo?.focus();
    void change(at, makePlan).then((done) => {
      if (!done && returnTo?.isConnected && document.activeElement === document.body) returnTo.focus();
    });
  };

  const setStatus = (id: string, status: string) => {
    const returnTo = menu?.returnTo ?? null;
    setMenu(null);
    setFailure(null);
    returnTo?.focus();
    try {
      onChapterDetails(id, { status });
    } catch (error) {
      setFailure({ at: `chapter:${id}`, message: errorMessage(error) });
    }
  };

  /* Titles typed in the binder ------------------------------------------- */

  const cancelEditing = () => {
    afterRender.current = editing?.returnTo ?? null;
    setEditing(null);
    setFailure(null);
  };

  const submit = async (viaBlur: boolean) => {
    if (!editing || busy) return;
    const title = draft.trim();
    const isPart = editing.kind === "new-part" || editing.kind === "rename-part";
    if (title === "") {
      // Leaving an empty field drops it; Enter asks for a title.
      if (viaBlur) cancelEditing();
      else setFailure({ at: "edit", message: isPart ? "Give the part a name." : "Give the chapter a title." });
      return;
    }
    // Leaving a field that just failed keeps it, with its message, for Enter to try again.
    if (viaBlur && failure?.at === "edit") return;
    let makePlan: (current: Project) => Plan | null;
    switch (editing.kind) {
      case "new-chapter": {
        const { place } = editing;
        makePlan = (current) => planNewChapter(current, place, title);
        break;
      }
      case "new-part": {
        const { index } = editing;
        makePlan = (current) => planNewPart(current, index, title);
        break;
      }
      case "rename-chapter": {
        const { id } = editing;
        if (title === project.chapters[id]?.title) {
          cancelEditing();
          return;
        }
        makePlan = (current) => planRenameChapter(current, id, title);
        break;
      }
      case "rename-part": {
        const { id } = editing;
        const part = partsOf(project.binder).find((p) => p.id === id);
        if (title === part?.title) {
          cancelEditing();
          return;
        }
        makePlan = (current) => planRenamePart(current, id, title);
        break;
      }
    }
    if (await change("edit", makePlan)) setEditing(null);
  };

  /** The title input and its message, in the list item of the row it stands for. */
  const editField = (options: { part: boolean; nested: boolean; label: string; placeholder: string }) => (
    <>
      <TitleInput
        value={draft}
        onChange={(value) => {
          setDraft(value);
          if (failure?.at === "edit") setFailure(null);
        }}
        onSubmit={(viaBlur) => void submit(viaBlur)}
        onCancel={cancelEditing}
        busy={busy}
        errorId={failure?.at === "edit" ? editErrorId : undefined}
        {...options}
      />
      {failure?.at === "edit" && (
        <p id={editErrorId} className={cx("inline-error", options.nested && "binder-error--nested")} role="alert">
          {failure.message}
        </p>
      )}
    </>
  );

  /**
   * The input for a new chapter or part, if one is being named at this
   * place. The call at the end of a list also takes places past its end.
   */
  const newAt = (partId: string | null, index: number, end = false) => {
    const here = (at: number) => at === index || (end && at > index);
    if (editing?.kind === "new-chapter" && editing.place.partId === partId && here(editing.place.index)) {
      return (
        <li key="new">
          {editField({ part: false, nested: partId !== null, label: "Title of the new chapter", placeholder: "Chapter title" })}
        </li>
      );
    }
    if (editing?.kind === "new-part" && partId === null && here(editing.index)) {
      return (
        <li key="new">
          {editField({ part: true, nested: false, label: "Name of the new part", placeholder: "Part name" })}
        </li>
      );
    }
    return null;
  };

  /* Menus ------------------------------------------------------------------ */

  const openMenu = (item: DragItem, anchor: MenuState["anchor"], trigger: MenuState["trigger"], returnTo: HTMLElement | null) => {
    if (busy) return;
    setAddOpen(false);
    setMenu({ item, anchor, trigger, returnTo });
  };

  /** Right-click, long-press on touch, or the keyboard's menu key. */
  const onContextMenu = (event: MouseEvent<HTMLElement>, item: DragItem) => {
    event.preventDefault();
    const row = event.currentTarget;
    const box = row.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    // The menu key reports no pointer position inside the row: hang the menu below the row instead.
    const atPointer = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    openMenu(item, atPointer ? new DOMRect(x, y, 0, 0) : box, undefined, row.querySelector<HTMLElement>(".binder-row"));
  };

  const moreButton = (item: DragItem, title: string) => {
    const open = menu !== null && menu.item.type === item.type && menu.item.id === item.id && menu.trigger !== undefined;
    return (
      <button
        type="button"
        className="btn btn--icon binder-more"
        aria-label={`Actions for ${title}`}
        title={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        data-no-drag
        onClick={(event) => {
          if (open) {
            setMenu(null);
            return;
          }
          const el = event.currentTarget;
          const ref = { current: el };
          openMenu(item, ref, ref, el);
        }}
      >
        <Ellipsis aria-hidden />
      </button>
    );
  };

  const chapterMenu = (id: string) => {
    const chapter = project.chapters[id];
    const at = chapterPlace(project.binder, id);
    if (!chapter || !at) return null;
    const parts = partsOf(project.binder);
    const up = chapterStep(project.binder, id, -1);
    const down = chapterStep(project.binder, id, 1);
    const key = `chapter:${id}`;
    const moveTo = (partId: string | null) => {
      const place = chapterMoveTo(project.binder, id, partId);
      if (!place) {
        setMenu(null);
        menu?.returnTo?.focus();
        return;
      }
      menuAction(key, (current) => planMoveChapter(current, id, place));
    };
    return (
      <>
        <MenuItem
          onSelect={() =>
            startEditing({ kind: "rename-chapter", id }, chapter.title, focusRow("chapter", id))
          }
        >
          Rename
        </MenuItem>
        <MenuGroup label="Status">
          <MenuItem checked={chapter.status === ""} onSelect={() => setStatus(id, "")}>
            No status
          </MenuItem>
          {project.statuses.map((status) => (
            <MenuItem key={status} checked={chapter.status === status} onSelect={() => setStatus(id, status)}>
              {status}
            </MenuItem>
          ))}
        </MenuGroup>
        <div className="popover-gap" role="none" />
        <MenuItem disabled={!up} onSelect={() => up && menuAction(key, (current) => planMoveChapter(current, id, up))}>
          Move up
        </MenuItem>
        <MenuItem
          disabled={!down}
          onSelect={() => down && menuAction(key, (current) => planMoveChapter(current, id, down))}
        >
          Move down
        </MenuItem>
        {parts.length > 0 && (
          <MenuGroup label="Move to">
            {parts.map((part) => (
              <MenuItem key={part.id} checked={at.partId === part.id} onSelect={() => moveTo(part.id)}>
                {part.title}
              </MenuItem>
            ))}
            <MenuItem checked={at.partId === null} onSelect={() => moveTo(null)}>
              Top level
            </MenuItem>
          </MenuGroup>
        )}
        <div className="popover-gap" role="none" />
        <MenuItem
          onSelect={() =>
            startEditing(
              { kind: "new-chapter", place: { partId: at.partId, index: at.index + 1 } },
              "",
              focusRow("chapter", id),
            )
          }
        >
          New chapter below
        </MenuItem>
        <div className="popover-gap" role="none" />
        <MenuItem onSelect={() => menuAction(key, (current) => planTrashChapter(current, id))}>Move to Trash</MenuItem>
      </>
    );
  };

  const partMenu = (id: string) => {
    const part = partsOf(project.binder).find((p) => p.id === id);
    if (!part) return null;
    const up = partStep(project.binder, id, -1);
    const down = partStep(project.binder, id, 1);
    const key = `part:${id}`;
    const count = part.chapterIds.length;
    return (
      <>
        <MenuItem onSelect={() => startEditing({ kind: "rename-part", id }, part.title, focusRow("part", id))}>
          Rename
        </MenuItem>
        <MenuItem
          onSelect={() =>
            startEditing({ kind: "new-chapter", place: { partId: id, index: count } }, "", focusRow("part", id))
          }
        >
          New chapter in this part
        </MenuItem>
        <MenuItem
          onSelect={() =>
            startEditing({ kind: "new-part", index: partIndex(project.binder, id) + 1 }, "", focusRow("part", id))
          }
        >
          New part below
        </MenuItem>
        <div className="popover-gap" role="none" />
        <MenuItem
          disabled={up === null}
          onSelect={() => up !== null && menuAction(key, (current) => planMovePart(current, id, up))}
        >
          Move up
        </MenuItem>
        <MenuItem
          disabled={down === null}
          onSelect={() => down !== null && menuAction(key, (current) => planMovePart(current, id, down))}
        >
          Move down
        </MenuItem>
        <div className="popover-gap" role="none" />
        <MenuItem onSelect={() => menuAction(key, (current) => planTrashPart(current, id))}>
          {count === 0 ? "Move to Trash" : `Move to Trash with its ${plural(count, "chapter", "chapters")}`}
        </MenuItem>
      </>
    );
  };

  /* Dragging --------------------------------------------------------------- */

  const onDrop = (item: DragItem, move: Move) => {
    if (move.type === "part") {
      void change(`part:${item.id}`, (current) => planMovePart(current, item.id, move.index));
      return;
    }
    const { place } = move;
    // Show where it went, even into a folded part.
    if (place.partId) expand(place.partId);
    void change(`chapter:${item.id}`, (current) => planMoveChapter(current, item.id, place));
  };

  const { drag, onPointerDown } = useBinderDrag({
    binder: project.binder,
    enabled: !busy && editing === null,
    container: listRef,
    onDrop,
  });

  /* Rows ------------------------------------------------------------------- */

  const exists = (at: string): boolean => {
    const [type, ...rest] = at.split(":");
    const id = rest.join(":");
    if (type === "chapter") return chapterPlace(project.binder, id) !== null;
    if (type === "part") return partIndex(project.binder, id) !== -1;
    if (type === "trash") return project.trash.some((t) => t.id === id);
    return false;
  };
  // A failure whose row is gone (or the title input's) shows at the top of the manuscript.
  const failureHome = failure && failure.at !== "edit" ? (exists(failure.at) ? failure.at : "manuscript") : null;
  const failureAt = (at: string, nested = false) =>
    failureHome === at && failure ? (
      <p className={cx("inline-error", nested && "binder-error--nested")} role="alert">
        {failure.message}
      </p>
    ) : null;

  const menuFor = (type: DragItem["type"], id: string) => menu?.item.type === type && menu.item.id === id;
  const dragged = (type: DragItem["type"], id: string) => drag?.item.type === type && drag.item.id === id;

  const chapterRow = (id: string, partId: string | null) => {
    const chapter = project.chapters[id];
    if (!chapter) return null;
    if (editing?.kind === "rename-chapter" && editing.id === id) {
      return (
        <li key={id}>
          {editField({ part: false, nested: partId !== null, label: "Chapter title", placeholder: "Chapter title" })}
        </li>
      );
    }
    const item: DragItem = { type: "chapter", id };
    return (
      <li key={id}>
        <div
          className={cx(
            "binder-item",
            id === openChapterId && "is-current",
            menuFor("chapter", id) && "is-menu-open",
            dragged("chapter", id) && "is-drag-source",
          )}
          data-drag-row="chapter"
          data-drag-id={id}
          data-drag-part={partId ?? ""}
          onContextMenu={(event) => onContextMenu(event, item)}
          onPointerDown={(event) => onPointerDown(event, item)}
        >
          <button
            type="button"
            className={cx("binder-row binder-row--chapter", partId !== null && "binder-row--nested")}
            aria-current={id === openChapterId ? "page" : undefined}
            onClick={() => onOpenChapter(id)}
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
          {moreButton(item, chapter.title)}
        </div>
        {failureAt(`chapter:${id}`, partId !== null)}
      </li>
    );
  };

  const partRow = (part: Part, index: number) => {
    const open = !collapsed.has(part.id);
    const contentId = `${baseId}-part-${index}`;
    const item: DragItem = { type: "part", id: part.id };
    const renaming = editing?.kind === "rename-part" && editing.id === part.id;
    const naming = editing?.kind === "new-chapter" && editing.place.partId === part.id;
    const words = partWords(project, part);
    return (
      <li key={part.id}>
        {renaming ? (
          editField({ part: true, nested: false, label: "Part name", placeholder: "Part name" })
        ) : (
          <div
            className={cx(
              "binder-item",
              menuFor("part", part.id) && "is-menu-open",
              dragged("part", part.id) && "is-drag-source",
              drag?.mark?.kind === "into" && drag.mark.partId === part.id && "is-drop-target",
            )}
            data-drag-row="part"
            data-drag-id={part.id}
            data-drag-open={open}
            onContextMenu={(event) => onContextMenu(event, item)}
            onPointerDown={(event) => onPointerDown(event, item)}
          >
            <button
              type="button"
              className="binder-row binder-row--group"
              aria-expanded={open}
              aria-controls={contentId}
              onClick={() => toggle(part.id)}
            >
              <ChevronRight className="disclosure" aria-hidden />
              {open ? <FolderOpen aria-hidden /> : <Folder aria-hidden />}
              <span className="binder-row-title">{part.title}</span>
              <span className="binder-row-count num">
                {formatCount(words)}
                <span className="visually-hidden"> words</span>
              </span>
            </button>
            {moreButton(item, part.title)}
          </div>
        )}
        {failureAt(`part:${part.id}`)}
        <div id={contentId} hidden={!open}>
          {part.chapterIds.length === 0 && !naming ? (
            <p
              className="empty-note empty-note--nested"
              data-drag-row="empty"
              data-drag-id={part.id}
              data-drag-part={part.id}
            >
              No chapters in this part.
            </p>
          ) : (
            <ul className="binder-list">
              {part.chapterIds.map((id, at) => (
                <Fragment key={id}>
                  {newAt(part.id, at)}
                  {chapterRow(id, part.id)}
                </Fragment>
              ))}
              {newAt(part.id, part.chapterIds.length, true)}
            </ul>
          )}
        </div>
      </li>
    );
  };

  const mark = drag?.mark?.kind === "line" ? drag.mark : null;
  const menuItemExists = menu !== null && exists(`${menu.item.type}:${menu.item.id}`);
  const menuTitle =
    menu?.item.type === "chapter"
      ? project.chapters[menu.item.id]?.title
      : partsOf(project.binder).find((p) => p.id === menu?.item.id)?.title;

  return (
    <nav
      ref={navRef}
      className={cx("binder", drag && "is-dragging")}
      aria-label="Binder"
      aria-busy={busy}
    >
      <div className="binder-head">
        <h1 className="binder-title">
          <ProjectsButton title={project.title} source={projects} />
        </h1>
        <div ref={addRef} className="binder-add">
          <MenuButton
            open={addOpen}
            onOpenChange={setAddOpen}
            menuLabel="Add to the manuscript"
            ariaLabel="New chapter or part"
            title="New chapter or part"
            disabled={busy}
            menu={
              <>
                <MenuItem
                  noCheck
                  onSelect={() =>
                    startEditing(
                      { kind: "new-chapter", place: { partId: null, index: project.binder.length } },
                      "",
                      () => addButton()?.focus(),
                    )
                  }
                >
                  New chapter
                </MenuItem>
                <MenuItem
                  noCheck
                  onSelect={() =>
                    startEditing({ kind: "new-part", index: project.binder.length }, "", () => addButton()?.focus())
                  }
                >
                  New part
                </MenuItem>
              </>
            }
          >
            <Plus aria-hidden />
          </MenuButton>
        </div>
      </div>

      <section ref={listRef} className="binder-manuscript" aria-label="Manuscript">
        {failureAt("manuscript")}
        {project.binder.length === 0 && editing === null ? (
          <p className="empty-note">No chapters yet.</p>
        ) : (
          <ul className="binder-list">
            {project.binder.map((item, index) => (
              <Fragment key={item.id}>
                {newAt(null, index)}
                {item.type === "chapter" ? chapterRow(item.id, null) : partRow(item, index)}
              </Fragment>
            ))}
            {newAt(null, project.binder.length, true)}
          </ul>
        )}
        {mark && (
          <div
            className={cx("drop-line", mark.nested && "drop-line--nested")}
            style={{ top: mark.y }}
            aria-hidden
          />
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

      <section aria-label="Trash">
        <Group
          label="Trash"
          icon={<Trash2 aria-hidden />}
          open={!collapsed.has(TRASH_GROUP)}
          onToggle={() => toggle(TRASH_GROUP)}
        >
          {project.trash.length === 0 ? (
            <p className="empty-note empty-note--nested">Trash is empty.</p>
          ) : (
            <ul className="binder-list">
              {project.trash.map((item) => {
                const key = `trash:${item.id}`;
                return (
                  <li key={item.id}>
                    <div className="trash-row">
                      <span className="trash-text">
                        <span className="binder-row-title">{item.title}</span>
                        <span className="binder-row-meta num">{trashSummary(item)}</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn--quiet trash-restore"
                        aria-label={`Restore ${item.title}`}
                        disabled={busy}
                        onClick={() => void change(key, (current) => planRestore(current, item.id))}
                      >
                        {working === key ? "Restoring…" : "Restore"}
                      </button>
                    </div>
                    {failureAt(key, true)}
                  </li>
                );
              })}
            </ul>
          )}
        </Group>
      </section>

      {menu && menuItemExists && (
        <Popover
          anchor={menu.anchor}
          ignore={menu.trigger}
          id={menuId}
          role="menu"
          label={menuTitle ?? "Actions"}
          className="binder-menu"
          autoFocus
          onClose={(reason) => {
            const { returnTo } = menu;
            setMenu(null);
            if (reason === "escape") returnTo?.focus();
          }}
        >
          {menu.item.type === "chapter" ? chapterMenu(menu.item.id) : partMenu(menu.item.id)}
        </Popover>
      )}
    </nav>
  );
}

/** A labelled group of menu items, such as the statuses. */
function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div className="popover-gap" role="none" />
      <div id={id} className="popover-title" aria-hidden>
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * A title typed in the binder, where the item is or will be. Enter saves,
 * Escape cancels, and leaving the field saves too (or drops it if empty).
 */
function TitleInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  part,
  nested,
  label,
  placeholder,
  errorId,
}: {
  value: string;
  onChange(value: string): void;
  onSubmit(viaBlur: boolean): void;
  onCancel(): void;
  busy: boolean;
  part: boolean;
  nested: boolean;
  label: string;
  placeholder: string;
  errorId: string | undefined;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit(false);
    } else if (event.key === "Escape") {
      // Handled here, so the phone layout doesn't also close the binder.
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
    }
  };

  return (
    <div className={cx("binder-edit", nested && "binder-edit--nested", part && "binder-edit--part")}>
      {part && (
        <>
          <ChevronRight className="disclosure" aria-hidden />
          <Folder aria-hidden />
        </>
      )}
      <input
        ref={ref}
        className="input binder-input"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        readOnly={busy}
        aria-busy={busy}
        aria-invalid={errorId !== undefined}
        aria-describedby={errorId}
        enterKeyHint="done"
        autoComplete="off"
        spellCheck={false}
        data-no-drag
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Switching to another window is not leaving the field.
          if (document.hasFocus()) onSubmit(true);
        }}
      />
    </div>
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
