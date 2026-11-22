// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterDetails as Details } from "../../core/binder";
import { buildProject, type Project } from "../../core/project";
import { ChapterDetails, povChoices, type ChapterDetailsProps } from "../ChapterDetails";

const CHAPTER = "manuscript/01 One.md";
const ELENA = "sheets/characters/Elena Voss.md";

function makeProject(pov: string): Project {
  return buildProject({
    root: "/test",
    folderName: "Test",
    projectJson: JSON.stringify({ chapters: { [CHAPTER]: { status: "Draft", pov, synopsis: "Elena waits." } } }),
    files: [
      { path: CHAPTER, text: "# One\n\nElena waits.\n" },
      { path: ELENA, text: "---\nname: Elena Voss\n---\n" },
      { path: "sheets/characters/Arno Kell.md", text: "---\nname: Arno Kell\n---\n" },
      { path: "sheets/places/Varn.md", text: "---\nname: Varn\n---\n" },
    ],
    skipped: [],
  });
}

let container: HTMLDivElement;
let root: Root;
let props: ChapterDetailsProps;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  const project = makeProject("Elena Voss");
  props = {
    project,
    chapter: project.chapters[CHAPTER],
    onChange: vi.fn<(id: string, details: Details) => void>(),
    busy: false,
    onOpenSheet: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(patch: Partial<ChapterDetailsProps> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(ChapterDetails, props)));
}

const select = (label: string) => {
  const id = [...container.querySelectorAll("label")].find((l) => l.textContent === label)!.htmlFor;
  return container.querySelector<HTMLSelectElement>(`#${CSS.escape(id)}`)!;
};
const options = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);
const synopsis = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Synopsis"]')!;

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function typeSynopsis(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(synopsis(), value);
    synopsis().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the chapter's details", () => {
  it("show the synopsis, status and point of view, with Not set to clear them", async () => {
    await render();
    expect(synopsis().value).toBe("Elena waits.");
    expect(select("Status").value).toBe("Draft");
    expect(options(select("Status"))).toEqual(["Not set", "Idea", "Draft", "Revised", "Final"]);
    expect(select("Point of view").value).toBe("Elena Voss");
    expect(options(select("Point of view"))).toEqual(["Not set", "Arno Kell", "Elena Voss"]);
  });

  it("save each change as it is made", async () => {
    await render();
    await choose(select("Status"), "Final");
    expect(props.onChange).toHaveBeenLastCalledWith(CHAPTER, { status: "Final" });
    await choose(select("Point of view"), "");
    expect(props.onChange).toHaveBeenLastCalledWith(CHAPTER, { pov: "" });
    await typeSynopsis("Elena waits, and waits.");
    expect(props.onChange).toHaveBeenLastCalledWith(CHAPTER, { synopsis: "Elena waits, and waits." });
  });

  it("keep a refused value in its field, with the reason", async () => {
    vi.mocked(props.onChange).mockImplementation(() => {
      throw new Error("project.json could not be read. Fix or remove it, then open the project again.");
    });
    await render();
    await choose(select("Status"), "Final");
    expect(select("Status").value).toBe("Final");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "project.json could not be read. Fix or remove it, then open the project again.",
    );
    expect(select("Status").getAttribute("aria-invalid")).toBe("true");
    await typeSynopsis("New synopsis");
    expect(synopsis().value).toBe("New synopsis");
  });

  it("follow the chapter when it changes outside the fields", async () => {
    await render();
    const project = makeProject("Arno Kell");
    await render({ project, chapter: project.chapters[CHAPTER] });
    expect(select("Point of view").value).toBe("Arno Kell");
  });

  it("open the point of view's sheet", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Elena Voss’s sheet"]')!.click());
    expect(props.onOpenSheet).toHaveBeenCalledWith(ELENA);
  });

  it("wait while the project is busy", async () => {
    await render({ busy: true });
    expect(select("Status").disabled).toBe(true);
    expect(select("Point of view").disabled).toBe(true);
    expect(synopsis().readOnly).toBe(true);
  });
});

describe("point of view choices", () => {
  it("are the character sheets, plus a current value that names none of them", () => {
    expect(povChoices(makeProject(""), "")).toEqual(["Arno Kell", "Elena Voss"]);
    expect(povChoices(makeProject(""), "The ferryman")).toEqual(["Arno Kell", "Elena Voss", "The ferryman"]);
  });
});
