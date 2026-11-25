import { Plus, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Alias, Sheet, SheetType } from "../core/project";
import { formFields, type SheetEdit } from "../core/sheetFile";
import { useBackLayer } from "./BackStack";
import { cx, errorMessage } from "./dom";
import { useFitHeight } from "./hooks";
import { fieldLabel, looksNumeric } from "./sheets";

export interface SheetFormProps {
  sheet: Sheet;
  /** The sheet's type: its template fields are offered, empty, until they are filled in. */
  type: SheetType | undefined;
  /**
   * useProject's updateSheet: saved like an edit. Throws, changing nothing,
   * when the edit is refused (an empty name); the form shows the reason.
   */
  onChange(id: string, edit: SheetEdit): void;
  /** The project on disk is changing: the form waits until it has. */
  busy: boolean;
}

type Part = "name" | "aliases" | "fields" | "new-field" | "notes";

interface AliasRow {
  id: number;
  text: string;
  ignoreCase: boolean;
}

interface FieldRow {
  id: number;
  key: string;
  value: string;
}

/** Row ids, so a row keeps its input (and the caret) while rows around it come and go. */
let lastRowId = 0;
const rowId = () => ++lastRowId;

/** The other names as the file keeps them: without empty ones or spaces around. */
function aliasesOf(rows: { text: string; ignoreCase: boolean }[]): Alias[] {
  return rows.filter((r) => r.text.trim() !== "").map((r) => ({ text: r.text.trim(), ignoreCase: r.ignoreCase }));
}

const aliasesKey = (rows: { text: string; ignoreCase: boolean }[]) =>
  JSON.stringify(aliasesOf(rows).map((a) => [a.text, a.ignoreCase]));

/**
 * The fields as the file keeps them: empty ones are left out, and order
 * doesn't count (a field the form adds goes to the end of the file,
 * wherever the form shows it).
 */
function fieldsKey(fields: [string, string][]): string {
  const kept = fields.filter(([k, v]) => k.trim() !== "" && v.trim() !== "").map(([k, v]) => [k.trim(), v.trim()]);
  return JSON.stringify(kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const rowsKey = (rows: FieldRow[]) => fieldsKey(rows.map((r) => [r.key, r.value]));

/**
 * Form state that follows the sheet, as ChapterDetails does: when the
 * sheet's value changes (`key`, its value as the file keeps it, is not the
 * one seen last) and the form's value doesn't save as it, the form shows the
 * sheet's. The form's own saves come back as what it shows, so what is being
 * typed (a space at the end, a row just added) stays as it is.
 */
function useFollowed<T>(key: string, fromSheet: () => T, keyOf: (shown: T) => string): [T, Dispatch<SetStateAction<T>>] {
  const [shown, setShown] = useState(fromSheet);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    if (keyOf(shown) !== key) setShown(fromSheet());
  }
  return [shown, setShown];
}

/** Why a new field can't be called `key`, if it can't. Labels are compared, as the form shows labels. */
function fieldRefusal(key: string, rows: FieldRow[]): string | null {
  const label = fieldLabel(key).toLowerCase();
  if (label === "") return "Give the field a name.";
  if (label === "name") return "The sheet’s name is already at the top.";
  if (label === "aliases") return "Other names go under Also called.";
  const same = rows.find((r) => fieldLabel(r.key).toLowerCase() === label);
  return same ? `There is already a ${fieldLabel(same.key)} field.` : null;
}

const onEnter = (run: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  run();
};

/**
 * A sheet's form: its name, other names, fields and notes. Names are saved
 * when the writer leaves the field or presses Enter (each new name rebuilds
 * the highlights); fields and notes as they are typed. Mount one per sheet
 * (key it by project and sheet), for a sheet whose header can be read.
 */
export function SheetForm({ sheet, type, onChange, busy }: SheetFormProps) {
  const [name, setName] = useFollowed(sheet.name, () => sheet.name, (shown) => shown.trim());
  const [aliases, setAliases] = useFollowed<AliasRow[]>(
    aliasesKey(sheet.aliases),
    () => sheet.aliases.map((a) => ({ id: rowId(), text: a.text, ignoreCase: a.ignoreCase })),
    aliasesKey,
  );
  const [fields, setFields] = useFollowed<FieldRow[]>(
    fieldsKey(sheet.fields),
    () => formFields(sheet, type).map(([key, value]) => ({ id: rowId(), key, value })),
    rowsKey,
  );
  const [notes, setNotes] = useFollowed(sheet.body.trim(), () => sheet.body.trim(), (shown) => shown.trim());
  /** The name of a field being added; null while the Add a field button shows. */
  const [newField, setNewField] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ at: Part; message: string } | null>(null);

  const ids = useId();
  const rootRef = useRef<HTMLElement>(null);
  const addAliasRef = useRef<HTMLButtonElement>(null);
  const addFieldRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useFitHeight(notesRef, notes);

  /** Run after the next render, once the rows it needs are on screen. */
  const afterRender = useRef<(() => void) | null>(null);
  useEffect(() => {
    const run = afterRender.current;
    afterRender.current = null;
    run?.();
  });

  const clear = (at: Part) => setFailure((f) => (f?.at === at ? null : f));

  /** Saves one part of the sheet. A refusal shows by that part, and what the writer typed stays. */
  const save = (at: Part, edit: SheetEdit): boolean => {
    try {
      onChange(sheet.id, edit);
    } catch (error) {
      setFailure({ at, message: errorMessage(error) });
      return false;
    }
    clear(at);
    return true;
  };

  /** After a row's Remove: the next row's Remove, else the previous one's, else the list's Add button. */
  const focusAfterRemove = (removable: number[], at: number, add: RefObject<HTMLButtonElement | null>) => {
    const next = removable[at] ?? removable[at - 1];
    afterRender.current = () => {
      const button = next === undefined ? null : rootRef.current?.querySelector<HTMLElement>(`[data-remove="${next}"]`);
      (button ?? add.current)?.focus();
    };
  };

  /* Name ------------------------------------------------------------------ */

  const saveName = (leaving: boolean) => {
    if (busy) return;
    const value = name.trim();
    if (value === sheet.name) {
      if (leaving) setName(value);
      clear("name");
      return;
    }
    // An empty name is refused: the reason shows, and leaving the field puts the saved name back.
    const saved = save("name", { name: value });
    if (leaving) setName(saved ? value : sheet.name);
  };

  /* Other names ----------------------------------------------------------- */

  const saveAliases = (rows: AliasRow[]) => {
    if (busy) return;
    if (aliasesKey(rows) === aliasesKey(sheet.aliases)) clear("aliases");
    else save("aliases", { aliases: aliasesOf(rows) });
  };

  const typeAlias = (id: number, text: string) =>
    setAliases((rows) => rows.map((r) => (r.id === id ? { ...r, text } : r)));

  const toggleCase = (id: number) => {
    const rows = aliases.map((r) => (r.id === id ? { ...r, ignoreCase: !r.ignoreCase } : r));
    setAliases(rows);
    saveAliases(rows);
  };

  const removeAlias = (id: number) => {
    const at = aliases.findIndex((r) => r.id === id);
    const rows = aliases.filter((r) => r.id !== id);
    setAliases(rows);
    saveAliases(rows);
    focusAfterRemove(
      rows.map((r) => r.id),
      at,
      addAliasRef,
    );
  };

  const addAlias = () => {
    const row: AliasRow = { id: rowId(), text: "", ignoreCase: false };
    setAliases([...aliases, row]);
    afterRender.current = () => rootRef.current?.querySelector<HTMLElement>(`[data-row="${row.id}"] input`)?.focus();
  };

  /* Fields ---------------------------------------------------------------- */

  const template = new Set(type?.fields ?? []);
  const removable = (row: FieldRow) => !template.has(row.key);
  const anyRemovable = fields.some(removable);

  const saveFields = (rows: FieldRow[]) => {
    if (!busy) save("fields", { fields: rows.map((r): [string, string] => [r.key, r.value]) });
  };

  const typeField = (id: number, value: string) => {
    const rows = fields.map((r) => (r.id === id ? { ...r, value } : r));
    setFields(rows);
    saveFields(rows);
  };

  const removeField = (id: number) => {
    const at = fields.filter(removable).findIndex((r) => r.id === id);
    const rows = fields.filter((r) => r.id !== id);
    setFields(rows);
    saveFields(rows);
    focusAfterRemove(
      rows.filter(removable).map((r) => r.id),
      at,
      addFieldRef,
    );
  };

  /** Adds the field being named. An empty name left behind drops it; Enter asks for one. */
  const addField = (leaving: boolean) => {
    if (newField === null || busy) return;
    const key = newField.trim();
    if (key === "" && leaving) {
      setNewField(null);
      clear("new-field");
      return;
    }
    const refusal = fieldRefusal(key, fields);
    if (refusal !== null) {
      setFailure({ at: "new-field", message: refusal });
      return;
    }
    // Empty, it isn't written to the file yet: it is once it has a value.
    const row: FieldRow = { id: rowId(), key, value: "" };
    setFields([...fields, row]);
    setNewField(null);
    clear("new-field");
    if (!leaving) afterRender.current = () => document.getElementById(`${ids}-field-${row.id}`)?.focus();
  };

  /** Escape, or a phone's Back: the field being named is dropped. */
  const dropNewField = () => {
    setNewField(null);
    clear("new-field");
    afterRender.current = () => addFieldRef.current?.focus();
  };

  const cancelNewField = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    // Handled here, so the phone layout doesn't also close the inspector.
    event.preventDefault();
    event.stopPropagation();
    dropNewField();
  };

  useBackLayer(newField !== null, dropNewField);

  /* Notes ----------------------------------------------------------------- */

  const typeNotes = (value: string) => {
    setNotes(value);
    if (!busy) save("notes", { body: value });
  };

  /* Messages -------------------------------------------------------------- */

  const errorId = (at: Part) => `${ids}-${at}-error`;
  const error = (at: Part) =>
    failure?.at === at ? (
      <p id={errorId(at)} className="inline-error" role="alert">
        {failure.message}
      </p>
    ) : null;
  const invalid = (at: Part) =>
    failure?.at === at ? { "aria-invalid": true, "aria-describedby": errorId(at) } : {};

  return (
    <section ref={rootRef} className="sheet sheet-form" aria-label={`Editing ${sheet.name}`}>
      <div className="sheet-form-name">
        <input
          className="input sheet-name-input"
          value={name}
          aria-label="Name"
          readOnly={busy}
          enterKeyHint="done"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setName(event.target.value);
            clear("name");
          }}
          onKeyDown={onEnter(() => saveName(false))}
          onBlur={() => saveName(true)}
          {...invalid("name")}
        />
        {error("name")}
      </div>

      <section className="sheet-form-group" aria-labelledby={`${ids}-aliases`}>
        <h3 id={`${ids}-aliases`} className="section-label">
          Also called
        </h3>
        {aliases.length > 0 && (
          <ul className="alias-list">
            {aliases.map((row) => {
              const label = row.text.trim() || "this name";
              return (
                <li key={row.id} className="alias-row" data-row={row.id}>
                  <input
                    className="input alias-input"
                    value={row.text}
                    aria-label="Also called"
                    placeholder="Another name"
                    readOnly={busy}
                    enterKeyHint="done"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => typeAlias(row.id, event.target.value)}
                    onKeyDown={onEnter(() => saveAliases(aliases))}
                    onBlur={() => saveAliases(aliases)}
                  />
                  <label className="alias-case">
                    <input
                      type="checkbox"
                      checked={row.ignoreCase}
                      disabled={busy}
                      aria-label={`Match ${label} in any case`}
                      onChange={() => toggleCase(row.id)}
                    />
                    Any case
                  </label>
                  <button
                    type="button"
                    className="btn btn--icon btn--quiet"
                    aria-label={`Remove ${label}`}
                    title={`Remove ${label}`}
                    data-remove={row.id}
                    disabled={busy}
                    onClick={() => removeAlias(row.id)}
                  >
                    <X aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button ref={addAliasRef} type="button" className="btn btn--quiet add-button" disabled={busy} onClick={addAlias}>
          <Plus aria-hidden />
          Add another name
        </button>
        {error("aliases")}
      </section>

      <div className="sheet-form-group">
        {fields.length > 0 && (
          <dl className="fields fields--edit">
            {fields.map((row) => {
              const label = fieldLabel(row.key);
              const inputId = `${ids}-field-${row.id}`;
              return (
                <div key={row.id} className="field" data-row={row.id}>
                  <dt>
                    <label htmlFor={inputId}>{label}</label>
                  </dt>
                  <dd>
                    <span className="field-row">
                      <input
                        id={inputId}
                        className={cx("input", looksNumeric(row.value) && "num")}
                        value={row.value}
                        readOnly={busy}
                        autoComplete="off"
                        onChange={(event) => typeField(row.id, event.target.value)}
                      />
                      {removable(row) ? (
                        <button
                          type="button"
                          className="btn btn--icon btn--quiet"
                          aria-label={`Remove ${label}`}
                          title={`Remove ${label}`}
                          data-remove={row.id}
                          disabled={busy}
                          onClick={() => removeField(row.id)}
                        >
                          <X aria-hidden />
                        </button>
                      ) : (
                        anyRemovable && <span className="field-remove-slot" aria-hidden />
                      )}
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        {error("fields")}
        {newField === null ? (
          <button
            ref={addFieldRef}
            type="button"
            className="btn btn--quiet add-button"
            disabled={busy}
            onClick={() => setNewField("")}
          >
            <Plus aria-hidden />
            Add a field
          </button>
        ) : (
          <div className="new-field">
            <input
              className="input"
              value={newField}
              aria-label="Name of the new field"
              placeholder="Field name"
              readOnly={busy}
              enterKeyHint="done"
              autoComplete="off"
              autoFocus
              onChange={(event) => {
                setNewField(event.target.value);
                clear("new-field");
              }}
              onKeyDown={(event) => {
                cancelNewField(event);
                onEnter(() => addField(false))(event);
              }}
              onBlur={() => addField(true)}
              {...invalid("new-field")}
            />
            {error("new-field")}
          </div>
        )}
      </div>

      <section className="sheet-notes" aria-label="Notes">
        <h3 className="section-label">
          <label htmlFor={`${ids}-notes`}>Notes</label>
        </h3>
        <textarea
          ref={notesRef}
          id={`${ids}-notes`}
          className="input notes-input"
          rows={4}
          value={notes}
          placeholder="Free notes, in Markdown"
          readOnly={busy}
          onChange={(event) => typeNotes(event.target.value)}
          {...invalid("notes")}
        />
        {error("notes")}
      </section>
    </section>
  );
}
