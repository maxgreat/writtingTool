// @vitest-environment jsdom
import { act, createElement, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../../core/backend";
import { NameIndex } from "../../core/nameIndex";
import { buildNameMatcher, buildProject, withSheetText, type Project } from "../../core/project";
import { DEFAULT_SETTINGS } from "../../core/settings";
import { editSheetText, newSheetPath, newSheetText, type SheetEdit } from "../../core/sheetFile";
import type { useProject } from "../../core/useProject";
import { SheetPreview } from "../BottomSheet";
import { Inspector, type InspectorView } from "../Inspector";
import { Workspace } from "../Workspace";

const CHAPTER = "manuscript/01 One.md";
const ELENA = "sheets/characters/Elena Voss.md";
const ARNO = "sheets/characters/Arno Kell.md";
const VARN = "sheets/places/Varn.md";
const BROKEN = "sheets/notes/Broken.md";

/** Elena has a role but no age (characters offer both); Broken's header can't be read. */
const START = buildProject({
  root: "/test",
  folderName: "Test",
  projectJson: null,
  files: [
    { path: CHAPTER, text: "# One\n\nElena waits for the ferryman.\n" },
    { path: ELENA, text: "---\nname: Elena Voss\naliases: [Elena, Voss]\nrole: Protagonist\n---\nA surveyor.\n" },
    { path: ARNO, text: "---\nname: Arno Kell\nrole: Ferryman\neyes: grey\n---\n" },
    { path: VARN, text: "---\nname: Varn\ntype: Town\n---\nA city.\n" },
    { path: BROKEN, text: "---\nname: [unclosed\n---\nSome notes.\n" },
  ],
  skipped: [],
});

/** A promise to resolve by hand, to control when the core answers. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* The project as useProject would keep it ----------------------------------- */

let latest: Project;
let showProject: (project: Project) => void = () => undefined;

/** A change to the project, as the core makes it (or as a read from disk brings it). */
function apply(next: Project) {
  latest = next;
  showProject(next);
}

/** As useProject's updateSheet: throws, changing nothing, when the edit is refused. */
const updateSheet = vi.fn((id: string, edit: SheetEdit) => {
  const sheet = latest.sheets.find((s) => s.id === id)!;
  if (!sheet.editable) throw new Error("This sheet's header could not be read. Fix it in the file first.");
  apply(withSheetText(latest, id, editSheetText(sheet.text, edit)));
});

/** As useProject's createSheet: the sheet joins the project, and its id comes back. */
const createSheet = vi.fn(async (kind: string, name: string) => {
  const text = newSheetText(name);
  const id = newSheetPath(latest, kind, name);
  apply(withSheetText(latest, id, text));
  return id;
});

const sheetOf = (id: string) => latest.sheets.find((s) => s.id === id)!;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  latest = START;
  updateSheet.mockClear();
  createSheet.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* The inspector, with the view state Workspace keeps -------------------------- */

let view: InspectorView;

function Harness({ initialView, busy }: { initialView: InspectorView; busy: boolean }) {
  const [project, setProject] = useState(latest);
  const [shown, setShown] = useState(initialView);
  showProject = setProject;
  view = shown;
  const sheetsById = useMemo(() => new Map(project.sheets.map((s) => [s.id, s])), [project.sheets]);
  const matcher = useMemo(() => buildNameMatcher(project.sheets), [project.sheets]);
  const [index] = useState(() => new NameIndex());
  return createElement(Inspector, {
    project,
    chapter: project.chapters[CHAPTER],
    matcher,
    index,
    sheetsById,
    view: shown,
    onViewChange: setShown,
    onOpenSheet: (id: string) => setShown({ kind: "sheet", id }),
    onOpenChapter: () => undefined,
    onChapterDetails: () => undefined,
    onCreateSheet: createSheet,
    onUpdateSheet: updateSheet,
    ignoring: { ignored: project.ignoredNames, setIgnored: () => undefined, busy },
    onMarkNotName: () => undefined,
    busy,
    versions: { list: async () => [], restore: async () => undefined, saveStatus: "saved", loads: 1, busy: false },
    visible: true,
  });
}

let mounted: { initialView: InspectorView; busy: boolean };

/** Shows the inspector at `initialView`; later calls only change `busy`, keeping the inspector's state. */
async function render(initialView: InspectorView, busy = false) {
  mounted = { initialView, busy };
  await act(async () => root.render(createElement(Harness, mounted)));
}

async function setBusy(busy: boolean) {
  mounted = { ...mounted, busy };
  await act(async () => root.render(createElement(Harness, mounted)));
}

/* Finding and using controls ---------------------------------------------- */

const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  );
const input = (label: string) => {
  const byLabel = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  if (byLabel?.htmlFor) return document.getElementById(byLabel.htmlFor) as HTMLInputElement;
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"], textarea[aria-label="${label}"]`)!;
};
const aliasInputs = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Also called"]')];
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? null;
const form = () => container.querySelector(".sheet-form");

const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const setAreaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

/** Types `value` into a field, as one change, with the field focused. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    el.focus();
    (el instanceof HTMLTextAreaElement ? setAreaValue : setInputValue).call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const press = (el: Element, key: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

const leave = (el: HTMLElement) =>
  act(async () => {
    el.blur();
  });

const click = (el: HTMLElement) =>
  act(async () => {
    el.click();
  });

/* New sheets ---------------------------------------------------------------- */

describe("a new sheet", () => {
  it("is named in place: Enter makes it and opens its form, with the caret in its first field", async () => {
    await render({ kind: "type", folder: "characters" });
    await click(button("New character")!);
    const name = input("Name of the new character");
    expect(document.activeElement).toBe(name);

    await type(name, "Mira Holt");
    await press(name, "Enter");
    expect(createSheet).toHaveBeenCalledExactlyOnceWith("characters", "Mira Holt");
    expect(view).toEqual({ kind: "sheet", id: "sheets/characters/Mira Holt.md", editing: true });
    expect(input("Name").value).toBe("Mira Holt");
    // The type's template: Role and Age, empty, Role first.
    expect(input("Role").value).toBe("");
    expect(input("Age").value).toBe("");
    expect(document.activeElement).toBe(input("Role"));
  });

  it("is cancelled by Escape, which gives focus back to New", async () => {
    await render({ kind: "type", folder: "places" });
    await click(button("New place")!);
    const name = input("Name of the new place");
    await type(name, "Lowmere");
    await press(name, "Escape");
    expect(name.isConnected).toBe(false);
    expect(document.activeElement).toBe(button("New place"));
    expect(createSheet).not.toHaveBeenCalled();
  });

  it("is dropped when its name is left empty", async () => {
    await render({ kind: "type", folder: "characters" });
    await click(button("New character")!);
    await leave(input("Name of the new character"));
    expect(container.querySelector('input[aria-label="Name of the new character"]')).toBeNull();
    expect(button("New character")).toBeDefined();
  });

  it("shows a refusal below the name, which stays as typed", async () => {
    createSheet.mockRejectedValueOnce(new Error("sheets/characters/Mira Holt.md already exists"));
    await render({ kind: "type", folder: "characters" });
    await click(button("New character")!);
    const name = input("Name of the new character");
    await type(name, "Mira Holt");
    await press(name, "Enter");
    expect(alert()).toBe("sheets/characters/Mira Holt.md already exists");
    expect(name.value).toBe("Mira Holt");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.readOnly).toBe(false);
    expect(view).toEqual({ kind: "type", folder: "characters" });

    // Typing again clears the message; Enter tries again.
    await type(name, "Mira Holt 2");
    expect(alert()).toBeNull();
  });

  it("waits while the project changes on disk, and while the sheet is being made", async () => {
    await render({ kind: "type", folder: "characters" }, true);
    expect(button("New character")!.disabled).toBe(true);

    await setBusy(false);
    await click(button("New character")!);
    const answer = deferred<string>();
    createSheet.mockReturnValueOnce(answer.promise);
    const name = input("Name of the new character");
    await type(name, "Tomas");
    await press(name, "Enter");
    expect(name.readOnly).toBe(true);
    expect(name.getAttribute("aria-busy")).toBe("true");
    await press(name, "Enter");
    await press(name, "Escape");
    expect(createSheet).toHaveBeenCalledOnce();
    expect(name.isConnected).toBe(true);

    await act(async () => {
      apply(withSheetText(latest, "sheets/characters/Tomas.md", newSheetText("Tomas")));
      answer.resolve("sheets/characters/Tomas.md");
    });
    expect(input("Name").value).toBe("Tomas");
  });

  it("says there are none yet, without sending the writer to the files", async () => {
    latest = { ...START, sheetTypes: [...START.sheetTypes, { folder: "creatures", label: "Creatures", fields: [] }] };
    await render({ kind: "type", folder: "creatures" });
    expect(container.querySelector(".empty-note")?.textContent).toBe("No creatures yet.");
    expect(button("New sheet")).toBeDefined();
  });
});

/* The form ---------------------------------------------------------------- */

describe("a sheet's form", () => {
  it("opens with Edit and closes with Done, focus staying on the button", async () => {
    await render({ kind: "sheet", id: ELENA });
    expect(form()).toBeNull();
    const toggle = button("Edit")!;
    toggle.focus();
    await click(toggle);
    expect(form()).not.toBeNull();
    expect(toggle.textContent).toBe("Done");
    expect(document.activeElement).toBe(toggle);
    // Appears in stays with the sheet as it reads.
    expect(container.querySelector('section[aria-label="Appears in"]')).toBeNull();

    await click(toggle);
    expect(form()).toBeNull();
    expect(container.querySelector(".sheet-name")?.textContent).toBe("Elena Voss");
    expect(document.activeElement).toBe(toggle);
  });

  it("saves the name when the writer leaves it or presses Enter, not as it is typed", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    const name = input("Name");
    await type(name, "Elena Vance");
    expect(updateSheet).not.toHaveBeenCalled();
    await leave(name);
    expect(updateSheet).toHaveBeenCalledExactlyOnceWith(ELENA, { name: "Elena Vance" });
    expect(sheetOf(ELENA).name).toBe("Elena Vance");

    await type(name, "Elena V. ");
    await press(name, "Enter");
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, { name: "Elena V." });

    // Leaving it unchanged saves nothing.
    await leave(name);
    expect(updateSheet).toHaveBeenCalledTimes(2);
  });

  it("refuses an empty name with the reason, and leaving it puts the saved name back", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    const name = input("Name");
    await type(name, "");
    await press(name, "Enter");
    expect(updateSheet).toHaveBeenCalledWith(ELENA, { name: "" });
    expect(alert()).toBe("A sheet needs a name.");
    expect(name.value).toBe("");
    expect(name.getAttribute("aria-invalid")).toBe("true");

    await leave(name);
    expect(name.value).toBe("Elena Voss");
    expect(alert()).toBe("A sheet needs a name.");
    expect(sheetOf(ELENA).name).toBe("Elena Voss");
  });

  it("adds, changes and removes other names, saving the whole list each time", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    expect(aliasInputs().map((i) => i.value)).toEqual(["Elena", "Voss"]);

    await click(button("Add another name")!);
    const added = aliasInputs()[2];
    expect(added.value).toBe("");
    expect(document.activeElement).toBe(added);
    await type(added, "Lena");
    expect(updateSheet).not.toHaveBeenCalled();
    await leave(added);
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
      aliases: [
        { text: "Elena", ignoreCase: false },
        { text: "Voss", ignoreCase: false },
        { text: "Lena", ignoreCase: false },
      ],
    });

    const anyCase = container.querySelector<HTMLInputElement>('input[aria-label="Match Lena in any case"]')!;
    expect(anyCase.checked).toBe(false);
    await click(anyCase);
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
      aliases: [
        { text: "Elena", ignoreCase: false },
        { text: "Voss", ignoreCase: false },
        { text: "Lena", ignoreCase: true },
      ],
    });
    expect(anyCase.checked).toBe(true);

    await click(button("Remove Voss")!);
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
      aliases: [
        { text: "Elena", ignoreCase: false },
        { text: "Lena", ignoreCase: true },
      ],
    });
    expect(aliasInputs().map((i) => i.value)).toEqual(["Elena", "Lena"]);
    // Focus goes to the Remove of the name that took its place.
    expect(document.activeElement).toBe(button("Remove Lena"));
    expect(sheetOf(ELENA).aliases).toEqual([
      { text: "Elena", ignoreCase: false },
      { text: "Lena", ignoreCase: true },
    ]);
  });

  it("saves a field as it is typed, with every field the form shows, empty template ones too", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    expect(input("Role").value).toBe("Protagonist");
    expect(input("Age").value).toBe("");
    // Template fields can be emptied, not removed.
    expect(button("Remove Role")).toBeUndefined();
    expect(button("Remove Age")).toBeUndefined();

    await type(input("Role"), "Surveyor");
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
      fields: [
        ["role", "Surveyor"],
        ["age", ""],
      ],
    });
    await type(input("Age"), "34");
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
      fields: [
        ["role", "Surveyor"],
        ["age", "34"],
      ],
    });
    expect(input("Age").classList.contains("num")).toBe(true);
    expect(sheetOf(ELENA).fields).toEqual([
      ["role", "Surveyor"],
      ["age", "34"],
    ]);
  });

  it("removes a field the type's template doesn't have", async () => {
    await render({ kind: "sheet", id: ARNO, editing: true });
    expect(input("Eyes").value).toBe("grey");
    await click(button("Remove Eyes")!);
    expect(updateSheet).toHaveBeenLastCalledWith(ARNO, {
      fields: [
        ["role", "Ferryman"],
        ["age", ""],
      ],
    });
    expect(sheetOf(ARNO).fields).toEqual([["role", "Ferryman"]]);
    expect(document.activeElement).toBe(button("Add a field"));
  });

  it("adds a field by name, refusing the name, the other names and a field already there", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    await click(button("Add a field")!);
    const name = input("Name of the new field");
    expect(document.activeElement).toBe(name);

    await press(name, "Enter");
    expect(alert()).toBe("Give the field a name.");
    await type(name, "Name");
    await press(name, "Enter");
    expect(alert()).toBe("The sheet’s name is already at the top.");
    await type(name, "aliases");
    await press(name, "Enter");
    expect(alert()).toBe("Other names go under Also called.");
    await type(name, "role");
    await press(name, "Enter");
    expect(alert()).toBe("There is already a Role field.");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(updateSheet).not.toHaveBeenCalled();

    await type(name, "Eye colour");
    await press(name, "Enter");
    expect(alert()).toBeNull();
    const eyes = input("Eye colour");
    expect(eyes.value).toBe("");
    expect(document.activeElement).toBe(eyes);
    // Empty, it isn't written: it is once it has a value.
    expect(updateSheet).not.toHaveBeenCalled();

    await type(eyes, "grey");
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
      fields: [
        ["role", "Protagonist"],
        ["age", ""],
        ["Eye colour", "grey"],
      ],
    });
    expect(button("Remove Eye colour")).toBeDefined();
  });

  it("cancels a new field with Escape", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    await click(button("Add a field")!);
    const name = input("Name of the new field");
    await type(name, "Eyes");
    await press(name, "Escape");
    expect(name.isConnected).toBe(false);
    expect(document.activeElement).toBe(button("Add a field"));
    expect(container.textContent).not.toContain("Eyes");
  });

  it("saves the notes as they are typed, keeping what is being typed", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    const notes = input("Notes") as unknown as HTMLTextAreaElement;
    expect(notes.value).toBe("A surveyor.");
    await type(notes, "A surveyor from the coast. ");
    expect(updateSheet).toHaveBeenLastCalledWith(ELENA, { body: "A surveyor from the coast. " });
    expect(sheetOf(ELENA).body).toBe("A surveyor from the coast.\n");
    // The space at the end stays where the writer is typing.
    expect(notes.value).toBe("A surveyor from the coast. ");
  });

  it("follows changes made to the sheet outside the form", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    await act(async () => {
      apply(
        withSheetText(
          latest,
          ELENA,
          "---\nname: Elena Vance\naliases: [Lena]\nrole: Lead\nage: 35\n---\nChanged on disk.\n",
        ),
      );
    });
    expect(input("Name").value).toBe("Elena Vance");
    expect(aliasInputs().map((i) => i.value)).toEqual(["Lena"]);
    expect(input("Role").value).toBe("Lead");
    expect(input("Age").value).toBe("35");
    expect((input("Notes") as unknown as HTMLTextAreaElement).value).toBe("Changed on disk.");
  });

  it("keeps a field just added, still empty, when the sheet is saved", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true });
    await click(button("Add a field")!);
    const name = input("Name of the new field");
    await type(name, "Eyes");
    await press(name, "Enter");
    await type(input("Role"), "Lead");
    expect(input("Eyes").value).toBe("");
  });

  it("waits while the project changes on disk", async () => {
    await render({ kind: "sheet", id: ELENA, editing: true }, true);
    const fields = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".sheet-form input:not([type]), .sheet-form textarea")];
    expect(fields.length).toBe(6);
    expect(fields.every((f) => f.readOnly)).toBe(true);
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.sheet-form input[type="checkbox"]')];
    expect(boxes.every((b) => b.disabled)).toBe(true);
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".sheet-form button")];
    expect(actions.every((b) => b.disabled)).toBe(true);

    await press(input("Name"), "Enter");
    await leave(input("Name"));
    expect(updateSheet).not.toHaveBeenCalled();
  });

  it("isn't offered for a sheet whose header can't be read, which says why", async () => {
    await render({ kind: "sheet", id: BROKEN, editing: true });
    expect(form()).toBeNull();
    expect(button("Edit")).toBeUndefined();
    expect(button("Done")).toBeUndefined();
    expect(container.querySelector(".sheet-locked")?.textContent).toBe(
      "The header of sheets/notes/Broken.md can’t be read, so this sheet can’t be edited here. Fix the header in the file.",
    );
    expect(container.querySelector(".sheet-notes")?.textContent).toContain("Some notes.");
  });
});

/* The phone's preview ----------------------------------------------------- */

describe("the phone's name preview", () => {
  it("has no Edit for a sheet whose header can't be read", async () => {
    await act(async () =>
      root.render(
        createElement(SheetPreview, {
          sheet: sheetOf(BROKEN),
          open: true,
          onClose: () => undefined,
          onEdit: () => undefined,
          ignoring: { ignored: [], setIgnored: () => undefined, busy: false },
          appearances: {
            index: new NameIndex(),
            project: START,
            matcher: buildNameMatcher(START.sheets),
            openChapterId: CHAPTER,
            onOpenChapter: () => undefined,
            busy: false,
          },
        }),
      ),
    );
    const preview = document.querySelector(".bottom-sheet.is-open")!;
    expect(preview.querySelector(".sheet-name")?.textContent).toBe("Broken");
    expect([...preview.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Close",
    ]);
  });

  describe("on a phone", () => {
    const backend = {
      kind: "browser",
      canOpenFolders: false,
      canCreateProjects: false,
      listProjects: async () => [],
      listVersions: async () => [],
      onCloseRequested: async () => () => undefined,
    } as unknown as Backend;
    // Stable, as useProject's are.
    const listVersions = async () => [];
    const restoreVersion = async () => undefined;
    const listProjects = async () => [];

    beforeAll(() => {
      // A touchscreen phone: editors don't take focus when they mount.
      window.matchMedia = ((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;
      // jsdom has no layout; the editors measure ranges to scroll the caret into view.
      Range.prototype.getBoundingClientRect = () => new DOMRect();
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    });

    /** The phone layout on the test project, in Plain (its names answer clicks without layout). */
    async function mount() {
      function PhoneHarness() {
        const [current, setCurrent] = useState<Project>(latest);
        showProject = setCurrent;
        const matcher = useMemo(() => buildNameMatcher(current.sheets), [current.sheets]);
        const api = {
          backend,
          load: { status: "ready" },
          project: current,
          matcher,
          openChapterId: CHAPTER,
          openChapter: () => undefined,
          updateChapter: () => undefined,
          updateSheet,
          createSheet,
          save: { status: "saved" },
          saveNow: async () => undefined,
          openFolder: async () => undefined,
          openProjectAt: async () => undefined,
          createProject: async () => undefined,
          listProjects,
          listVersions,
          restoreVersion,
          switching: false,
          bookWords: 0,
          wordsToday: 0,
          loads: 1,
        } as unknown as ReturnType<typeof useProject>;
        return createElement(Workspace, {
          api,
          project: current,
          backend,
          settings: { ...DEFAULT_SETTINGS, mode: "plain" },
          update: () => undefined,
          isPhone: true,
        });
      }
      await act(async () => root.render(createElement(PhoneHarness)));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("Edit closes the preview and opens the sheet's form in the inspector", async () => {
      await mount();
      const mark = [...container.querySelectorAll(".cm-content .name-mark")].find((m) => m.textContent === "Elena")!;
      await act(async () => mark.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      const preview = document.querySelector<HTMLElement>(".bottom-sheet.is-open")!;
      expect(preview.querySelector(".sheet-name")?.textContent).toBe("Elena Voss");

      const edit = [...preview.querySelectorAll("button")].find((b) => b.textContent === "Edit")!;
      await click(edit);
      expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
      const panel = container.querySelector(".panel--inspector")!;
      expect(panel.classList.contains("is-open")).toBe(true);
      expect(panel.querySelector<HTMLInputElement>('.sheet-form input[aria-label="Name"]')?.value).toBe("Elena Voss");
      // Focus goes to Done, where Edit is in the inspector.
      expect(document.activeElement?.textContent).toBe("Done");
      expect(panel.contains(document.activeElement)).toBe(true);

      // It saves as the form does on desktop.
      await type(input("Role"), "Lead");
      expect(updateSheet).toHaveBeenLastCalledWith(ELENA, {
        fields: [
          ["role", "Lead"],
          ["age", ""],
        ],
      });
    });
  });
});
