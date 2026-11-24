import { Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { safeName } from "./binder";
import {
  headerKey,
  isEmptyHeader,
  isFieldValue,
  RESERVED_KEYS,
  sharedHeaderKeys,
  splitFrontMatter,
  type Alias,
  type Project,
  type Sheet,
  type SheetType,
} from "./project";

/**
 * Sheet files: a YAML header with the name, aliases and typed fields, then
 * free notes in Markdown. Edits change the header in place, so comments,
 * key order and fields the form doesn't show (lists, nested values) are
 * kept as the writer left them.
 */

/** What the sheet form changes. Parts left out stay as they are. */
export interface SheetEdit {
  name?: string;
  aliases?: Alias[];
  /**
   * Every typed field the form shows, in order: a key left out is removed
   * from the header, and a field with an empty value is not written.
   */
  fields?: [string, string][];
  /** The notes, as Markdown. */
  body?: string;
}

const STRING_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

/**
 * A changed field's value as YAML, of the same kind as before: text stays
 * text (`year: "1990"` keeps its quotes), a number stays a number while it
 * reads as one, true/false stays so. A new field is a number when it reads
 * back as the same number, otherwise text.
 */
function fieldValue(value: string, previous: unknown): string | number | boolean {
  const text = value.trim();
  const numeric = /^-?\d+(?:\.\d+)?$/u.test(text) && String(Number(text)) === text;
  if (typeof previous === "string") return text;
  if (typeof previous === "boolean" && (text === "true" || text === "false")) return text === "true";
  if (numeric && (typeof previous === "number" || previous === undefined || previous === null)) return Number(text);
  return text;
}

/**
 * Whether the file's other names are all ones the form shows (names, or
 * entries with a text and ignoreCase only), so the form may write the list
 * again without losing anything.
 */
function aliasesEditable(node: unknown): boolean {
  if (node === undefined || node === null || (isScalar(node) && node.value == null)) return true;
  if (!isSeq(node)) return false;
  return node.items.every((item) => {
    if (isScalar(item)) return item.value == null || typeof item.value === "string" || typeof item.value === "number";
    if (!isMap(item)) return false;
    const plain = item.items.every((pair) => {
      if (!isScalar(pair.key) || !isScalar(pair.value)) return false;
      if (pair.key.value === "text") return typeof pair.value.value === "string";
      return pair.key.value === "ignoreCase" && typeof pair.value.value === "boolean";
    });
    return plain && item.has("text");
  });
}

function aliasesNode(doc: Document, aliases: Alias[]) {
  const values = aliases.map((a) => (a.ignoreCase ? { text: a.text.trim(), ignoreCase: true } : a.text.trim()));
  const node = doc.createNode(values);
  // A short list of plain names reads best on one line, as in "[Elena, Voss]".
  node.flow = aliases.every((a) => !a.ignoreCase);
  return node;
}

/**
 * The sheet file's text after an edit. Throws when the header can't be
 * read as a list of fields, since rewriting it could lose what is there.
 */
export function editSheetText(text: string, edit: SheetEdit): string {
  const { header, body } = splitFrontMatter(text);
  const rest = header === null ? text : body;
  // The header block exactly as written, delimiters included, unless the
  // header changes; and the file's own line ends.
  let head = header === null ? "" : text.slice(0, text.length - body.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";

  if (edit.name !== undefined || edit.aliases !== undefined || edit.fields !== undefined) {
    const doc = header === null ? new Document({}) : parseDocument(header);
    if (doc.errors.length > 0) throw new Error("This sheet's header could not be read. Fix it in the file first.");
    if (isEmptyHeader(doc.contents)) doc.contents = doc.createNode({});
    if (!isMap(doc.contents)) throw new Error("This sheet's header is not a list of fields. Fix it in the file first.");

    if (edit.name !== undefined) {
      const name = edit.name.trim();
      if (name === "") throw new Error("A sheet needs a name.");
      doc.set("name", name);
    }

    if (edit.aliases !== undefined) {
      const previous = doc.get("aliases", true);
      if (!aliasesEditable(previous)) {
        throw new Error("The other names in this file hold more than names, so change them in the file.");
      }
      const aliases = edit.aliases.filter((a) => a.text.trim() !== "");
      const node =
        aliases.length > 0 ? aliasesNode(doc, aliases) : previous !== undefined ? doc.createNode([], { flow: true }) : null;
      if (node) {
        // The list's own comments stay; comments between its names go with them.
        if (isSeq(previous) || isScalar(previous)) {
          node.commentBefore = previous.commentBefore;
          node.comment = previous.comment;
        }
        doc.set("aliases", node);
      }
    }

    if (edit.fields !== undefined) {
      const map = doc.contents;
      // Keys are used exactly as given, as headerFields reads them, so two
      // rows never stand for the same key.
      const wanted = new Map<string, string>();
      for (const [key, value] of edit.fields) {
        if (key.trim() !== "" && !RESERVED_KEYS.has(key)) wanted.set(key, value);
      }
      // Pairs are found by their key as the form shows it (headerKey), so
      // `1990:`, a number to YAML, is the field "1990"; doc.get would miss
      // it. Entries whose key the form can't show are never touched.
      // A key more than one entry stands for (`1:` and `"1":`) is not shown
      // and not changed.
      const shared = sharedHeaderKeys(map);
      const pairOf = (key: string) => map.items.find((pair) => headerKey(pair) === key);
      const remove = (pair: (typeof map.items)[number]) => map.items.splice(map.items.indexOf(pair), 1);

      // The form shows text, number and true/false values (headerFields):
      // only those can be removed. Empty keys and anything else stay.
      for (const pair of [...map.items]) {
        const key = headerKey(pair);
        if (key === null || RESERVED_KEYS.has(key) || shared.has(key) || !isFieldValue(pair.value)) continue;
        if (pair.value.value == null) continue;
        if (!wanted.has(key)) remove(pair);
      }
      for (const [key, value] of wanted) {
        if (shared.has(key)) {
          if (value.trim() === "") continue;
          throw new Error(`The file has more than one entry called ${key}, so change it in the file.`);
        }
        const pair = pairOf(key);
        const node = pair?.value ?? null;
        if (node !== null && !isFieldValue(node)) {
          if (value.trim() === "") continue;
          throw new Error(`The file keeps ${key} in a form this sheet can't show, so change it in the file.`);
        }
        // A field the writer didn't change is left exactly as written. The
        // form sends every row; a text box drops line breaks and the value
        // shown may carry spaces, so values are compared without them.
        // An empty key (`role:`) shows as an empty field.
        if (pair && value.trim() === String(node?.value ?? "").trim()) continue;
        if (value.trim() === "") {
          if (pair) remove(pair);
          continue;
        }
        const next = fieldValue(value, node?.value);
        if (!pair) doc.set(key, next);
        // Kept as the same node, so its comment and quoting stay.
        else if (node) node.value = next;
        else pair.value = doc.createNode(next);
      }
    }
    head = `---\n${doc.toString(STRING_OPTIONS)}---\n`.replace(/\n/gu, eol);
  }

  let notes = rest;
  if (edit.body !== undefined) {
    const lead = /^\s*/u.exec(rest)?.[0] ?? "";
    const trimmed = edit.body.replace(/\s+$/u, "").replace(/\r?\n/gu, eol);
    notes = trimmed === "" ? "" : `${lead}${trimmed}${eol}`;
  }
  // A header that ends the file without a line end needs one before notes.
  if (head !== "" && notes !== "" && !head.endsWith("\n")) head += eol;
  return head + notes;
}

/** The text of a new sheet: its name, and nothing else until the writer adds it. */
export function newSheetText(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("A sheet needs a name.");
  return editSheetText("", { name: trimmed });
}

/** Where a new sheet named `name` goes: sheets/<type>/<name>.md, numbered if the name is taken. */
export function newSheetPath(project: Project, kind: string, name: string): string {
  const taken = new Set(project.sheets.map((s) => s.id.toLowerCase()));
  const stem = `sheets/${kind}/${safeName(name)}`;
  for (let n = 1; ; n += 1) {
    const candidate = `${n === 1 ? stem : `${stem} ${n}`}.md`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The fields the form shows: the sheet's own, then its type's template fields it doesn't have yet, empty. */
export function formFields(sheet: Sheet, type: SheetType | undefined): [string, string][] {
  const fields: [string, string][] = sheet.fields.map(([k, v]) => [k, v]);
  for (const raw of type?.fields ?? []) {
    const key = raw.trim();
    if (key !== "" && !RESERVED_KEYS.has(key) && !fields.some(([k]) => k === key)) fields.push([key, ""]);
  }
  return fields;
}
