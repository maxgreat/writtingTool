import { escapeChapterText } from "./markdown";
import type { Chapter, Project } from "./project";

/**
 * Changes to the binder, planned as file operations for the Rust core.
 *
 * The binder order is kept in project.json (`binder`, a list of paths), and
 * chapter files are renumbered to match it, so they also sort in reading
 * order in any file browser: "01 The arrival.md", "02 The ferryman.md"...
 * Numbers run through the whole book, across parts. A part is a folder under
 * manuscript/. The Trash is the trash/ folder; project.json remembers where
 * each item in it came from (`trash`).
 *
 * Chapter details (status, point of view, synopsis) are kept in project.json
 * under the chapter's path, so they follow every rename.
 */

export interface Move {
  from: string;
  to: string;
}

export interface FileWrite {
  path: string;
  text: string;
  /** The file must not exist yet: the core refuses to replace one. */
  mustBeNew?: boolean;
}

/**
 * One step, applied by the core as a whole or not at all: folders are
 * created, then every move is made (all at once, so names can be swapped),
 * then the files are written. No moved path may be inside another.
 */
export interface Change {
  folders: string[];
  moves: Move[];
  writes: FileWrite[];
}

export interface Plan {
  /** Applied one after the other. */
  changes: Change[];
  /** Where each chapter that moved ends up, by its path before the plan. */
  renamed: Map<string, string>;
  /** The chapter the plan creates, if any. */
  created: string | null;
}

/** Where a chapter goes: into a part (its folder path), or at the top level (null). */
export interface Place {
  partId: string | null;
  /** Position among the part's chapters, or among the top-level items. */
  index: number;
}

const MANUSCRIPT = "manuscript";
const TRASH = "trash";
const PROJECT_JSON = "project.json";
/** Stands for a chapter that does not exist yet while its place is planned. */
const NEW_CHAPTER = "\u0000new";

type Item = { type: "part"; path: string; chapters: string[] } | { type: "chapter"; path: string };

const dirName = (path: string) => path.slice(0, path.lastIndexOf("/"));
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isInside = (path: string, folder: string) => path.startsWith(`${folder}/`);

/** `path` with the folder or file `from` renamed to `to`. */
function rebase(path: string, from: string, to: string): string {
  if (path === from) return to;
  return isInside(path, from) ? to + path.slice(from.length) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Windows refuses these as file names, with or without an extension ("nul", "Aux.notes"). */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(?=\.|$)/iu;

/** Most file systems allow 255 bytes per name; this leaves room for a chapter number, " 2" and ".md". */
const NAME_BYTES = 200;

/**
 * A title made safe as a file or folder name on every platform the project
 * may sync to: no path separators or characters Windows refuses, no leading
 * dot (hidden), no trailing dot or space, at most 80 characters and
 * NAME_BYTES bytes.
 */
export function safeName(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[/\\:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[. ]+/u, "");
  const chars = Array.from(cleaned).slice(0, 80);
  const encoder = new TextEncoder();
  while (encoder.encode(chars.join("")).length > NAME_BYTES) chars.pop();
  // After shortening, so a cut can't leave a trailing dot or space.
  const short = chars.join("").replace(/[. ]+$/u, "");
  if (short === "") return "Untitled";
  return short.replace(RESERVED, "$1_");
}

/** `name`, or "name 2", "name 3"... (before the extension) if a path in `folder` already has it, ignoring case. */
function unique(folder: string, name: string, taken: Set<string>): string {
  const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : name.length;
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  for (let n = 1; ; n += 1) {
    const candidate = `${folder}/${n === 1 ? stem : `${stem} ${n}`}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** "07 Title.md": chapter number `n`, padded to `width` digits, then the title part and the extension. */
function withNumber(rest: string, ext: string, n: number, width: number): string {
  return `${String(n).padStart(width, "0")}${rest ? ` ${rest}` : ""}${ext}`;
}

/** A file name on disk with its leading chapter number replaced by `n`, padded to `width` digits. */
export function numberedName(name: string, n: number, width: number): string {
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  return withNumber(stem.replace(/^\d+[\s._-]*/u, ""), ext, n, width);
}

/** A Markdown heading line for a chapter title, with Markdown syntax escaped. */
function headingLine(title: string): string {
  const node = { type: "text", text: title.replace(/\s+/gu, " ").trim() };
  return `# ${escapeChapterText(node.text, node, { type: "heading", content: [node] })}`;
}

/** The chapter's text with its title heading replaced, or added at the top if it has none. */
export function withTitle(markdown: string, title: string): string {
  const line = headingLine(title);
  const heading = /^#[ \t]+.*$/mu;
  return heading.test(markdown) ? markdown.replace(heading, () => line) : `${line}\n\n${markdown}`;
}

/**
 * The binder and project.json as a plan unfolds. Each rename updates the
 * order, the chapter details and the Trash records, so later steps of the
 * plan see the paths as they will be.
 */
class Draft {
  items: Item[];
  json: Record<string, unknown>;
  /** Paths in use, lower-cased, to keep new names from clashing. */
  taken: Set<string>;
  /** Each original chapter path, and where it is now. */
  private where = new Map<string, string>();
  created: string | null = null;

  constructor(project: Project) {
    if (project.jsonProblem) {
      throw new Error(`${project.jsonProblem.replace(/; using defaults\.$/u, ".")} Fix or remove it, then open the project again.`);
    }
    this.items = project.binder.map((item) =>
      item.type === "part"
        ? { type: "part", path: item.id, chapters: [...item.chapterIds] }
        : { type: "chapter", path: item.id },
    );
    this.json = structuredClone(project.json);
    this.taken = new Set(project.entries.map((e) => e.toLowerCase()));
    for (const id of [...Object.keys(project.chapters), ...project.trash.flatMap((t) => [t.id, ...t.chapterIds])]) {
      this.where.set(id, id);
    }
  }

  part(path: string): Extract<Item, { type: "part" }> {
    const part = this.items.find((i): i is Extract<Item, { type: "part" }> => i.type === "part" && i.path === path);
    if (!part) throw new Error("That part is no longer in the binder.");
    return part;
  }

  /** Takes a chapter out of the binder; throws if it is not there. */
  removeChapter(id: string): void {
    for (const [index, item] of this.items.entries()) {
      if (item.type === "chapter" && item.path === id) {
        this.items.splice(index, 1);
        return;
      }
      if (item.type === "part" && item.chapters.includes(id)) {
        item.chapters.splice(item.chapters.indexOf(id), 1);
        return;
      }
    }
    throw new Error("That chapter is no longer in the binder.");
  }

  insertChapter(id: string, place: Place): void {
    const list = place.partId === null ? this.items : this.part(place.partId).chapters;
    const index = Math.max(0, Math.min(place.index, list.length));
    if (place.partId === null) this.items.splice(index, 0, { type: "chapter", path: id });
    else this.part(place.partId).chapters.splice(index, 0, id);
  }

  /** Records that `from` (a file or folder) is now at `to`. */
  rename(from: string, to: string): void {
    this.renameAll([{ from, to }]);
  }

  /**
   * Records moves made together, as the core makes them: each path moves
   * once, so two names can be swapped. No moved path is inside another.
   */
  renameAll(moves: Move[]): void {
    if (moves.length === 0) return;
    const move = (path: string) => {
      const m = moves.find((candidate) => path === candidate.from || isInside(path, candidate.from));
      return m ? rebase(path, m.from, m.to) : path;
    };
    const lower = moves.map((m) => ({ from: m.from.toLowerCase(), to: m.to.toLowerCase() }));
    this.taken = new Set(
      [...this.taken].map((path) => {
        const m = lower.find((candidate) => path === candidate.from || isInside(path, candidate.from));
        return m ? rebase(path, m.from, m.to) : path;
      }),
    );
    for (const item of this.items) {
      item.path = move(item.path);
      if (item.type === "part") item.chapters = item.chapters.map(move);
    }
    for (const [original, now] of this.where) this.where.set(original, move(now));
    for (const key of ["chapters", "trash"] as const) {
      const record = this.json[key];
      if (!isRecord(record)) continue;
      this.json[key] = Object.fromEntries(Object.entries(record).map(([path, value]) => [move(path), value]));
    }
    // Where a Trash item came from follows the folder it was in (a part
    // renamed or moved since), but not a file that later took its old name.
    const trash = this.json.trash;
    if (isRecord(trash)) {
      for (const [path, record] of Object.entries(trash)) {
        if (!isRecord(record) || typeof record.from !== "string") continue;
        const from = record.from;
        const m = moves.find((candidate) => isInside(from, candidate.from));
        if (m) trash[path] = { ...record, from: rebase(from, m.from, m.to) };
      }
    }
  }

  /**
   * Moves every chapter to its numbered name in reading order. A chapter
   * already inside its part's folder keeps its folder; any other goes
   * straight into its part's folder, or manuscript/ at the top level.
   * `retitled` gives some chapters a new title part for their name, taken
   * as it is (a title such as "1984" is not an old chapter number).
   */
  renumber(retitled = new Map<string, { title: string; ext: string }>()): Move[] {
    const order = this.items.flatMap((item) =>
      item.type === "part"
        ? item.chapters.map((path) => ({ path, folder: item.path }))
        : [{ path: item.path, folder: MANUSCRIPT }],
    );
    const width = Math.max(2, String(order.length).length);
    const moves: Move[] = [];
    order.forEach(({ path, folder }, index) => {
      // A chapter inside its part's folder (even a sub-folder) stays where it is; a
      // top-level chapter must be directly in manuscript/.
      const inPlace = path !== NEW_CHAPTER && (folder === MANUSCRIPT ? dirName(path) === MANUSCRIPT : isInside(path, folder));
      const dir = inPlace ? dirName(path) : folder;
      const title = retitled.get(path);
      const name = title ? withNumber(title.title, title.ext, index + 1, width) : numberedName(baseName(path), index + 1, width);
      const to = `${dir}/${name}`;
      if (path === NEW_CHAPTER) this.created = to;
      else if (to !== path) moves.push({ from: path, to });
    });
    this.renameAll(moves);
    // A new chapter's name may belong to a file the binder doesn't show
    // (left out as not UTF-8, or the same name in another case): add " 2"...
    const title = retitled.get(NEW_CHAPTER);
    if (this.created && title) {
      const dir = dirName(this.created);
      const number = baseName(this.created).slice(0, width);
      let created = this.created;
      for (let n = 2; this.taken.has(created.toLowerCase()); n += 1) {
        created = `${dir}/${number} ${title.title} ${n}${title.ext}`;
      }
      this.created = created;
    }
    if (this.created) this.rename(NEW_CHAPTER, this.created);
    return moves;
  }

  /** project.json with the binder order as it is now. */
  projectJson(): FileWrite {
    this.json.binder = this.items.flatMap((item) => (item.type === "part" ? [item.path, ...item.chapters] : [item.path]));
    return { path: PROJECT_JSON, text: `${JSON.stringify(this.json, null, 2)}\n` };
  }

  plan(changes: Change[]): Plan {
    const renamed = new Map([...this.where].filter(([original, now]) => original !== now));
    return { changes, renamed, created: this.created };
  }

  /** The folder to create so that a top-level folder (manuscript/, trash/) exists, if it doesn't. */
  ensureFolder(name: string): string[] {
    if (this.taken.has(name)) return [];
    this.taken.add(name);
    return [name];
  }

  trashRecords(): Record<string, unknown> {
    if (!isRecord(this.json.trash)) this.json.trash = {};
    return this.json.trash as Record<string, unknown>;
  }
}

/** Moves a chapter to another place in the binder, renumbering the chapters. */
export function planMoveChapter(project: Project, id: string, place: Place): Plan {
  const draft = new Draft(project);
  draft.removeChapter(id);
  draft.insertChapter(id, place);
  const moves = draft.renumber();
  return draft.plan([{ folders: [], moves, writes: [draft.projectJson()] }]);
}

/** Moves a part to another position among the top-level items, renumbering the chapters. */
export function planMovePart(project: Project, id: string, index: number): Plan {
  const draft = new Draft(project);
  const part = draft.part(id);
  draft.items.splice(draft.items.indexOf(part), 1);
  draft.items.splice(Math.max(0, Math.min(index, draft.items.length)), 0, part);
  const moves = draft.renumber();
  return draft.plan([{ folders: [], moves, writes: [draft.projectJson()] }]);
}

/** Creates a chapter holding just its title heading, at `place`. */
export function planNewChapter(project: Project, place: Place, title: string): Plan {
  const draft = new Draft(project);
  const folders = draft.ensureFolder(MANUSCRIPT);
  draft.insertChapter(NEW_CHAPTER, place);
  const moves = draft.renumber(new Map([[NEW_CHAPTER, { title: safeName(title), ext: ".md" }]]));
  const created = draft.created as string;
  return draft.plan([
    { folders, moves, writes: [{ path: created, text: `${headingLine(title)}\n`, mustBeNew: true }, draft.projectJson()] },
  ]);
}

/** Creates an empty part (a folder) at `index` among the top-level items. */
export function planNewPart(project: Project, index: number, name: string): Plan {
  const draft = new Draft(project);
  const folders = draft.ensureFolder(MANUSCRIPT);
  const path = unique(MANUSCRIPT, safeName(name), draft.taken);
  draft.taken.add(path.toLowerCase());
  draft.items.splice(Math.max(0, Math.min(index, draft.items.length)), 0, { type: "part", path, chapters: [] });
  return draft.plan([{ folders: [...folders, path], moves: [], writes: [draft.projectJson()] }]);
}

/** Renames a part's folder; its chapters keep their names. */
export function planRenamePart(project: Project, id: string, name: string): Plan | null {
  const draft = new Draft(project);
  draft.part(id);
  draft.taken.delete(id.toLowerCase());
  const to = unique(MANUSCRIPT, safeName(name), draft.taken);
  if (to === id) return null;
  draft.rename(id, to);
  return draft.plan([{ folders: [], moves: [{ from: id, to }], writes: [draft.projectJson()] }]);
}

/** Changes a chapter's title: its heading, and its file name after the number. */
export function planRenameChapter(project: Project, id: string, title: string): Plan | null {
  const chapter = project.chapters[id];
  if (!chapter) throw new Error("That chapter is no longer in the binder.");
  const draft = new Draft(project);
  const text = withTitle(chapter.text, title);
  const name = baseName(id);
  const ext = name.slice(name.lastIndexOf("."));
  const moves = draft.renumber(new Map([[id, { title: safeName(title), ext }]]));
  const now = draft.plan([]).renamed.get(id) ?? id;
  if (now === id && text === chapter.text) return null;
  const writes = [...(text === chapter.text ? [] : [{ path: now, text }]), draft.projectJson()];
  return draft.plan([{ folders: [], moves, writes }]);
}

/** Moves a chapter to the Trash and renumbers the others. */
export function planTrashChapter(project: Project, id: string): Plan {
  const draft = new Draft(project);
  draft.removeChapter(id);
  const folders = draft.ensureFolder(TRASH);
  const to = unique(TRASH, baseName(id), draft.taken);
  draft.rename(id, to);
  draft.trashRecords()[to] = { from: id };
  const moves = [{ from: id, to }, ...draft.renumber()];
  return draft.plan([{ folders, moves, writes: [draft.projectJson()] }]);
}

/** Moves a part, with its chapters, to the Trash and renumbers the others. */
export function planTrashPart(project: Project, id: string): Plan {
  const draft = new Draft(project);
  const part = draft.part(id);
  draft.items.splice(draft.items.indexOf(part), 1);
  const folders = draft.ensureFolder(TRASH);
  const to = unique(TRASH, baseName(id), draft.taken);
  draft.rename(id, to);
  draft.trashRecords()[to] = { from: id };
  const moves = [{ from: id, to }, ...draft.renumber()];
  return draft.plan([{ folders, moves, writes: [draft.projectJson()] }]);
}

/**
 * Puts an item from the Trash back. A chapter goes to the end of the part it
 * came from if that part still exists, otherwise to the end of the binder; a
 * part goes to the end of the binder. Chapters are then renumbered.
 */
export function planRestore(project: Project, trashId: string): Plan {
  const item = project.trash.find((t) => t.id === trashId);
  if (!item) throw new Error("That item is no longer in the Trash.");
  const draft = new Draft(project);
  const folders = draft.ensureFolder(MANUSCRIPT);
  delete draft.trashRecords()[trashId];

  if (item.type === "chapter") {
    const parent = item.from ? dirName(item.from) : MANUSCRIPT;
    const part = draft.items.find((i) => i.type === "part" && (parent === i.path || isInside(parent, i.path)));
    draft.insertChapter(trashId, part ? { partId: part.path, index: Infinity } : { partId: null, index: Infinity });
    const moves = draft.renumber();
    return draft.plan([{ folders, moves, writes: [draft.projectJson()] }]);
  }

  // A part: first its folder goes back, then its chapters are renumbered.
  // Two steps, because a moved folder can't also have files moved inside it.
  const name = item.from && dirName(item.from) === MANUSCRIPT ? baseName(item.from) : baseName(trashId);
  draft.taken.delete(trashId.toLowerCase());
  const to = unique(MANUSCRIPT, name, draft.taken);
  draft.rename(trashId, to);
  draft.items.push({ type: "part", path: to, chapters: item.chapterIds.map((c) => rebase(c, trashId, to)) });
  const back: Change = { folders, moves: [{ from: trashId, to }], writes: [draft.projectJson()] };
  const moves = draft.renumber();
  const changes = moves.length > 0 ? [back, { folders: [], moves, writes: [draft.projectJson()] }] : [back];
  return draft.plan(changes);
}

export type ChapterDetails = Partial<Pick<Chapter, "status" | "pov" | "synopsis">>;

/**
 * Sets a chapter's status, point of view or synopsis: in the project, and in
 * project.json, returned as the file to write. An empty value removes the
 * field, and a chapter with no details left is removed from the list.
 */
export function withChapterDetails(
  project: Project,
  id: string,
  details: ChapterDetails,
): { project: Project; write: FileWrite } {
  const chapter = project.chapters[id];
  if (!chapter) throw new Error("That chapter is no longer in the binder.");
  const draft = new Draft(project);
  const chapters = isRecord(draft.json.chapters) ? draft.json.chapters : {};
  const entry = isRecord(chapters[id]) ? { ...chapters[id] } : {};
  const updated = { ...chapter };
  for (const key of ["status", "pov", "synopsis"] as const) {
    const value = details[key];
    if (value === undefined) continue;
    updated[key] = value.trim() === "" ? "" : value;
    if (value.trim() === "") delete entry[key];
    else entry[key] = value;
  }
  if (Object.keys(entry).length === 0) delete chapters[id];
  else chapters[id] = entry;
  draft.json.chapters = chapters;
  return {
    project: { ...project, json: draft.json, chapters: { ...project.chapters, [id]: updated } },
    write: { path: PROJECT_JSON, text: `${JSON.stringify(draft.json, null, 2)}\n` },
  };
}
