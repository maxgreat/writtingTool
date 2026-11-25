// @vitest-environment jsdom
import { act, createElement, Fragment, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION, PRIVACY_POLICY_URL } from "../../core/about";
import type { ProjectEntry } from "../../core/projects";
import {
  folderName,
  projectDetail,
  ProjectsButton,
  ProjectsDialog,
  useProjectsDialog,
  type ProjectsIntent,
  type ProjectsSource,
} from "../Projects";

const FERRY: ProjectEntry = { path: "/data/projects/Night Ferry", title: "Night Ferry", inAppFolder: true };
const FERRY_2: ProjectEntry = { path: "/data/projects/Night Ferry 2", title: "Night Ferry", inAppFolder: true };
const DEBT: ProjectEntry = { path: "/data/projects/MyNovel", title: "The Ferryman’s Debt", inAppFolder: true };
const AWAY: ProjectEntry = { path: "/mnt/usb/Lighthouse", title: "The Lighthouse", inAppFolder: false };

describe("folderName", () => {
  it("takes the last part of a path, whichever separator it uses", () => {
    expect(folderName("/data/projects/Night Ferry 2")).toBe("Night Ferry 2");
    expect(folderName("C:\\Users\\Max\\Novels\\Lighthouse\\")).toBe("Lighthouse");
    expect(folderName("Lighthouse")).toBe("Lighthouse");
  });
});

describe("projectDetail", () => {
  it("shows the folder of a project opened from elsewhere", () => {
    expect(projectDetail(AWAY, [DEBT, AWAY])).toBe("/mnt/usb/Lighthouse");
  });

  it("shows nothing for a project in the app's folder with its own title", () => {
    expect(projectDetail(DEBT, [DEBT, AWAY])).toBeNull();
  });

  it("tells projects with the same title apart by their folder names", () => {
    const all = [FERRY, FERRY_2, DEBT];
    expect(projectDetail(FERRY, all)).toBe("Night Ferry");
    expect(projectDetail(FERRY_2, all)).toBe("Night Ferry 2");
  });
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

let container: HTMLDivElement;
let root: Root;
let source: ProjectsSource;
const list = vi.fn<() => Promise<ProjectEntry[]>>();
const open = vi.fn<(path: string) => Promise<void>>();
const create = vi.fn<(title: string, language: string) => Promise<void>>();
const openFolder = vi.fn<() => Promise<void>>();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["fr-BE", "en-US"] });
});

beforeEach(() => {
  other = { intent: "new" };
  list.mockReset().mockResolvedValue([DEBT, AWAY]);
  open.mockReset().mockResolvedValue(undefined);
  create.mockReset().mockResolvedValue(undefined);
  openFolder.mockReset().mockResolvedValue(undefined);
  source = {
    current: DEBT.path,
    loads: 1,
    list,
    open,
    create,
    openFolder,
    canCreate: true,
    busy: false,
    phone: false,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** What the other trigger asks for, and where focus goes when the view closes, if not back to it. */
let other: { intent: ProjectsIntent; returnFocus?: () => void } = { intent: "new" };

/**
 * The window's one Projects view, as Workspace has it: the project title
 * opens it, and so does another control (the main menu, in the app).
 */
function Harness({ source: from }: { source: ProjectsSource }) {
  const dialog = useProjectsDialog(from);
  const anchor = useRef<HTMLButtonElement>(null);
  return createElement(
    Fragment,
    null,
    createElement(ProjectsButton, { title: "The Ferryman’s Debt", dialog }),
    createElement(
      "button",
      {
        ref: anchor,
        type: "button",
        id: "other",
        onClick: () => dialog.show(other.intent, { anchor, returnFocus: other.returnFocus }),
      },
      "Other",
    ),
    createElement(ProjectsDialog, { dialog }),
  );
}

async function render(patch: Partial<ProjectsSource> = {}) {
  source = { ...source, ...patch };
  await act(async () => root.render(createElement(Harness, { source })));
}

const titleButton = () => container.querySelector<HTMLButtonElement>(".binder-title-button")!;
const otherButton = () => container.querySelector<HTMLButtonElement>("#other")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const rows = () => [...(dialog()?.querySelectorAll<HTMLElement>(".projects-list:not([aria-hidden]) .project-row") ?? [])];
const skeletons = () => dialog()?.querySelectorAll(".projects-list[aria-hidden] .skeleton").length ?? 0;
const row = (title: string) => rows().find((r) => r.querySelector(".project-title")?.textContent === title);
const button = (name: string) =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  );
const alerts = () => [...(dialog()?.querySelectorAll('[role="alert"]') ?? [])].map((a) => a.textContent);
const titleInput = () => dialog()?.querySelector<HTMLInputElement>("input")!;
const languageSelect = () => dialog()?.querySelector<HTMLSelectElement>("select")!;

async function openView() {
  await act(async () => titleButton().click());
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("Nothing to click");
  await act(async () => el.click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = dialog()!.querySelector("form")!;
  await act(async () => form.requestSubmit());
}

async function press(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("the Projects view", () => {
  it("opens from the title, with placeholder rows until the list arrives", async () => {
    const answer = deferred<ProjectEntry[]>();
    list.mockReturnValue(answer.promise);
    await render();
    expect(titleButton().getAttribute("aria-expanded")).toBe("false");
    await openView();
    expect(titleButton().getAttribute("aria-expanded")).toBe("true");
    expect(dialog()?.getAttribute("aria-label")).toBe("Projects");
    expect(skeletons()).toBeGreaterThan(0);

    await act(async () => answer.resolve([DEBT, AWAY]));
    expect(skeletons()).toBe(0);
    expect(rows().map((r) => r.querySelector(".project-title")?.textContent)).toEqual([DEBT.title, AWAY.title]);
  });

  it("marks the open project, which can't be chosen, and shows a folder from elsewhere", async () => {
    await render();
    await openView();
    const current = row(DEBT.title)!;
    expect(current.tagName).toBe("DIV");
    expect(current.querySelector(".check")).not.toBeNull();
    expect(current.textContent).toContain("open now");
    const away = row(AWAY.title)!;
    expect(away.tagName).toBe("BUTTON");
    expect(away.querySelector(".path")?.textContent).toBe(AWAY.path);
    expect(row(DEBT.title)!.querySelector(".path")).toBeNull();
  });

  it("puts focus on the first project that can be opened", async () => {
    await render();
    await openView();
    expect(document.activeElement).toBe(row(AWAY.title));
  });

  it("says when the list can't be read, and reads it again on Try again", async () => {
    list.mockRejectedValueOnce(new Error("Cannot list the projects in /data/projects: permission denied"));
    await render();
    await openView();
    expect(alerts()).toEqual(["Cannot list the projects in /data/projects: permission denied"]);
    await click(button("Try again"));
    expect(list).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(2);
  });

  it("opens a chosen project, shows progress on its row meanwhile, then closes", async () => {
    const answer = deferred<void>();
    open.mockReturnValue(answer.promise);
    await render();
    await openView();
    await click(row(AWAY.title));
    expect(open).toHaveBeenCalledWith(AWAY.path);
    expect(row(AWAY.title)!.textContent).toContain("Opening…");
    expect(button("Create")?.disabled).toBe(true);
    expect(button("Open folder…")?.disabled).toBe(true);
    expect(titleInput().readOnly).toBe(true);

    // useProject reads the new project (`loads` goes up) before the call resolves.
    await render({ current: AWAY.path, loads: 2 });
    await act(async () => answer.resolve());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(titleButton());
  });

  it("stays open with the reason under the row when the project can't be opened", async () => {
    open.mockRejectedValue(new Error("Cannot open /mnt/usb/Lighthouse: no such folder"));
    await render();
    await openView();
    await click(row(AWAY.title));
    expect(dialog()).not.toBeNull();
    const away = row(AWAY.title)!;
    expect(away.closest("li")?.querySelector('[role="alert"]')?.textContent).toBe(
      "Cannot open /mnt/usb/Lighthouse: no such folder",
    );
    expect((away as HTMLButtonElement).disabled).toBe(false);
  });

  it("can't be closed while a project is opening", async () => {
    const answer = deferred<void>();
    open.mockReturnValue(answer.promise);
    await render();
    await openView();
    await click(row(AWAY.title));
    await press("Escape");
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(dialog()).not.toBeNull();
    await act(async () => answer.reject(new Error("Cannot open it")));
    await press("Escape");
    expect(dialog()).toBeNull();
  });

  it("closes on Escape and gives focus back to the title", async () => {
    await render();
    await openView();
    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(titleButton());
  });

  it("closes on a press outside", async () => {
    await render();
    await openView();
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(dialog()).toBeNull();
  });

  it("lists the projects afresh each time it opens", async () => {
    await render();
    await openView();
    await press("Escape");
    await openView();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("Open folder…", () => {
  it("shows only where there is a folder picker", async () => {
    await render({ openFolder: undefined });
    await openView();
    expect(button("Open folder…")).toBeUndefined();
  });

  it("stays open if no folder was chosen, and shows why a folder can't be opened", async () => {
    await render();
    await openView();
    await click(button("Open folder…"));
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();

    openFolder.mockRejectedValue(new Error("Cannot open /tmp: not a project folder"));
    await click(button("Open folder…"));
    expect(alerts()).toEqual(["Cannot open /tmp: not a project folder"]);
  });
});

describe("a new project", () => {
  it("starts in the device's language, or the nearest one offered", async () => {
    await render();
    await openView();
    expect(languageSelect().value).toBe("fr-FR");
  });

  it("asks for a title first", async () => {
    await render();
    await openView();
    await submit();
    expect(create).not.toHaveBeenCalled();
    expect(alerts()).toEqual(["Give the project a title."]);
    expect(titleInput().getAttribute("aria-invalid")).toBe("true");
    await type(titleInput(), "N");
    expect(alerts()).toEqual([]);
  });

  it("creates it with the title and language chosen, showing progress on Create", async () => {
    const answer = deferred<void>();
    create.mockReturnValue(answer.promise);
    await render();
    await openView();
    await type(titleInput(), "Night Ferry");
    await act(async () => {
      languageSelect().value = "es-MX";
      languageSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submit();
    expect(create).toHaveBeenCalledWith("Night Ferry", "es-MX");
    expect(dialog()?.querySelector('button[type="submit"]')?.textContent).toBe("Creating…");
    expect(languageSelect().disabled).toBe(true);
    await render({ current: "/data/projects/Night Ferry", loads: 2 });
    await act(async () => answer.resolve());
    expect(dialog()).toBeNull();
  });

  it("keeps what was typed and says why when it can't be created", async () => {
    create.mockRejectedValue(new Error("Cannot create the project in /data/projects: disk full"));
    await render();
    await openView();
    await type(titleInput(), "Night Ferry");
    await submit();
    expect(alerts()).toEqual(["Cannot create the project in /data/projects: disk full"]);
    // The title isn't at fault: the field isn't marked, the Create button points to the reason.
    expect(titleInput().getAttribute("aria-invalid")).toBe("false");
    expect(button("Create")?.getAttribute("aria-describedby")).toBe(dialog()?.querySelector('[role="alert"]')?.id);
    expect(titleInput().value).toBe("Night Ferry");
    expect(titleInput().readOnly).toBe(false);
    expect(dialog()).not.toBeNull();
  });

  it("is replaced by one quiet line where projects can't be created", async () => {
    await render({ canCreate: false });
    await openView();
    expect(dialog()?.querySelector("form")).toBeNull();
    expect(dialog()?.querySelector(".projects-note")?.textContent).toBe(
      "The browser preview only has the sample project.",
    );
  });

  it("waits while the project on disk is changing", async () => {
    await render({ busy: true });
    await openView();
    expect((row(AWAY.title) as HTMLButtonElement).disabled).toBe(true);
    expect(button("Create")?.disabled).toBe(true);
  });
});

describe("on phones", () => {
  it("is a sheet with a close button, which takes focus and gives it back to the title", async () => {
    await render({ phone: true });
    await openView();
    const sheet = document.querySelector(".bottom-sheet.is-open");
    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await click(document.activeElement as HTMLElement);
    expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
    expect(document.activeElement).toBe(titleButton());
  });
});

describe("opened from elsewhere", () => {
  it("is the same single view, marked open on the control it came from only", async () => {
    other = { intent: "open" };
    await render();
    await click(otherButton());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(titleButton().getAttribute("aria-expanded")).toBe("false");
    expect(titleButton().hasAttribute("aria-controls")).toBe(false);
    expect(document.activeElement).toBe(row(AWAY.title));
    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(otherButton());
  });

  it("opens with the new project's title field ready, for a new project", async () => {
    await render();
    await click(otherButton());
    expect(document.activeElement).toBe(titleInput());
    // The list arriving doesn't take focus from the field.
    expect(rows()).toHaveLength(2);
    expect(document.activeElement).toBe(titleInput());
    await type(titleInput(), "Night Ferry");
    await submit();
    expect(create).toHaveBeenCalledWith("Night Ferry", "fr-FR");
  });

  it("starts at the list where projects can't be created, even for a new project", async () => {
    await render({ canCreate: false });
    await click(otherButton());
    expect(dialog()?.querySelector("form")).toBeNull();
    expect(document.activeElement).toBe(row(AWAY.title));
  });

  it("opens afresh for the other intent, and stays as it is for the same one", async () => {
    other = { intent: "open" };
    await render();
    await click(otherButton());
    expect(list).toHaveBeenCalledTimes(1);
    await click(otherButton());
    expect(list).toHaveBeenCalledTimes(1);
    other = { intent: "new" };
    await click(otherButton());
    expect(list).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(titleInput());
  });

  it("can't be opened again, nor for something else, while a project is opening", async () => {
    const answer = deferred<void>();
    open.mockReturnValue(answer.promise);
    other = { intent: "open" };
    await render();
    await click(otherButton());
    await click(row(AWAY.title));
    other = { intent: "new" };
    await click(otherButton());
    expect(list).toHaveBeenCalledTimes(1);
    expect(row(AWAY.title)!.textContent).toContain("Opening…");
    await act(async () => answer.resolve());
  });

  it("gives focus back where it was asked to, after Escape or once a project opens", async () => {
    const returnFocus = vi.fn();
    other = { intent: "open", returnFocus };
    await render();
    await click(otherButton());
    await press("Escape");
    expect(returnFocus).toHaveBeenCalledTimes(1);

    await click(otherButton());
    await click(row(AWAY.title));
    await render({ current: AWAY.path, loads: 2 });
    expect(dialog()).toBeNull();
    expect(returnFocus).toHaveBeenCalledTimes(2);
  });

  it("closes when the title is pressed, and opens again from it", async () => {
    other = { intent: "open" };
    await render();
    await click(otherButton());
    // A press on the title is outside the view, which closes; its click opens the view from the title.
    await act(async () => titleButton().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(dialog()).toBeNull();
    await openView();
    expect(titleButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("opens the phone's sheet with the keyboard's field ready, for a new project", async () => {
    await render({ phone: true });
    await click(otherButton());
    expect(document.querySelector(".bottom-sheet.is-open")).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector(".bottom-sheet.is-open input"));
    await click(document.querySelector<HTMLElement>('.bottom-sheet.is-open button[aria-label="Close"]')!);
    expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
    expect(document.activeElement).toBe(otherButton());
  });

  it("closes when the window crosses the phone breakpoint", async () => {
    other = { intent: "open" };
    await render();
    await click(otherButton());
    await render({ phone: true });
    expect(document.querySelector(".projects-popover")).toBeNull();
    // The sheet is there, closed, so it can slide in next time.
    expect(document.querySelector(".bottom-sheet.is-open")).toBeNull();
  });
});

describe("the version and the privacy policy", () => {
  const about = () => dialog()?.querySelector(".projects-about-line")?.textContent;
  const link = () => dialog()?.querySelector<HTMLAnchorElement>(".projects-about a") ?? null;

  /** Clicks the link and says whether its default action was prevented. Then prevents it: jsdom can't open pages. */
  async function clickLink(): Promise<boolean> {
    const el = link();
    if (!el) throw new Error("No link to click");
    let prevented = false;
    const record = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", record);
    try {
      await act(async () => el.click());
    } finally {
      document.removeEventListener("click", record);
    }
    return prevented;
  }

  it("ends the view with the app's version and a link to the policy", async () => {
    await render();
    await openView();
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
    expect(about()).toContain(`Version ${APP_VERSION}`);
    expect(link()?.textContent).toBe("Privacy policy");
    expect(link()?.href).toBe(PRIVACY_POLICY_URL);
    expect(link()?.target).toBe("_blank");
  });

  it("leaves the link to open a new tab in the browser preview", async () => {
    await render({ openUrl: undefined });
    await openView();
    expect(await clickLink()).toBe(false);
  });

  it("opens the policy in the system browser in the app", async () => {
    const openUrl = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    await render({ openUrl });
    await openView();
    expect(await clickLink()).toBe(true);
    expect(openUrl).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
    expect(alerts()).toEqual([]);
    expect(dialog()).not.toBeNull();
  });

  it("opens it once, however often the link is clicked meanwhile", async () => {
    const answer = deferred<void>();
    const openUrl = vi.fn<(url: string) => Promise<void>>(() => answer.promise);
    await render({ openUrl });
    await openView();
    await clickLink();
    expect(link()?.getAttribute("aria-disabled")).toBe("true");
    expect(await clickLink()).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    await act(async () => answer.resolve());
    expect(link()?.hasAttribute("aria-disabled")).toBe(false);
  });

  it("shows the address when the browser can't be opened, and tries again on the next click", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const openUrl = vi
        .fn<(url: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error("Not allowed to open url"))
        .mockResolvedValue(undefined);
      await render({ openUrl });
      await openView();
      await clickLink();
      const [alert] = alerts();
      expect(alert).toContain("Couldn’t open the browser.");
      expect(alert).toContain(PRIVACY_POLICY_URL);
      expect(link()?.getAttribute("aria-describedby")).toBe(dialog()?.querySelector('[role="alert"]')?.id);
      await clickLink();
      expect(openUrl).toHaveBeenCalledTimes(2);
      expect(alerts()).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
  });

  it("ends the sheet on phones too", async () => {
    await render({ phone: true });
    await openView();
    expect(document.querySelector(".bottom-sheet.is-open .projects-about a")?.textContent).toBe("Privacy policy");
  });
});
