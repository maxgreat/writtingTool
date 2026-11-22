// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Version } from "../../core/backend";
import { Versions, type VersionsProps } from "../Versions";

const CHAPTER = "manuscript/01 One.md";
const OTHER = "manuscript/02 Two.md";

const OLDER: Version = { savedAt: new Date(2026, 0, 2, 9, 12).getTime(), text: "# One\n\nElena waits.\n" };
const NEWER: Version = { savedAt: new Date(2026, 0, 3, 18, 45).getTime(), text: "# One\n\nElena waits by the door.\n" };

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

const list = vi.fn<(chapterId: string) => Promise<Version[]>>();
const restore = vi.fn<(chapterId: string, savedAt: number) => Promise<void>>();

let container: HTMLDivElement;
let root: Root;
let props: VersionsProps;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  list.mockReset().mockResolvedValue([NEWER, OLDER]);
  restore.mockReset().mockResolvedValue(undefined);
  props = { chapterId: CHAPTER, list, restore, saveStatus: "saved", loads: 1, busy: false, visible: true };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Renders with these props changed, keyed by chapter as the inspector does, and lets answers arrive. */
async function render(patch: Partial<VersionsProps> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(Versions, { key: props.chapterId, ...props })));
}

const rows = () => [...container.querySelectorAll(".version-list:not([aria-hidden]) > li")];
const skeletons = () => container.querySelectorAll(".version-list[aria-hidden] .skeleton").length;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name);
const click = (name: string) => act(async () => button(name)!.click());

describe("the list", () => {
  it("shows placeholder rows until the versions arrive, then one row each, newest first", async () => {
    const answer = deferred<Version[]>();
    list.mockReturnValue(answer.promise);
    await render();
    expect(skeletons()).toBeGreaterThan(0);
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("true");

    await act(async () => answer.resolve([NEWER, OLDER]));
    expect(skeletons()).toBe(0);
    expect(container.querySelector("section")?.getAttribute("aria-busy")).toBe("false");
    // The labels follow the system's locale (versionTime.test.ts checks them); the times are in dateTime.
    const times = [...container.querySelectorAll("time")].map((t) => t.getAttribute("dateTime"));
    expect(times).toEqual([new Date(NEWER.savedAt).toISOString(), new Date(OLDER.savedAt).toISOString()]);
    const words = [...container.querySelectorAll(".version-words")].map((w) => w.textContent);
    expect(words).toEqual(["5 words", "2 words"]);
    expect(list).toHaveBeenCalledWith(CHAPTER);
  });

  it("explains when versions are kept when there are none yet", async () => {
    list.mockResolvedValue([]);
    await render();
    expect(container.querySelector(".empty-note")?.textContent).toContain("every ten minutes");
  });

  it("shows why the list can't be read, and tries again", async () => {
    list.mockRejectedValueOnce(new Error("Permission denied"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t load earlier versions: Permission denied");

    await click("Try again");
    expect(list).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(2);
  });

  it("reads the list again each time a save finishes, not while typing", async () => {
    await render();
    await render({ saveStatus: "pending" });
    await render({ saveStatus: "saving" });
    expect(list).toHaveBeenCalledTimes(1);

    list.mockResolvedValue([{ savedAt: NEWER.savedAt + 1, text: "Newest." }, NEWER, OLDER]);
    await render({ saveStatus: "saved" });
    expect(list).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(3);
  });

  it("keeps the newest answer when an older one arrives late", async () => {
    const first = deferred<Version[]>();
    list.mockReturnValueOnce(first.promise).mockResolvedValueOnce([OLDER]);
    await render();
    await render({ loads: 2 });
    expect(rows()).toHaveLength(1);

    await act(async () => first.resolve([NEWER, OLDER]));
    expect(rows()).toHaveLength(1);
  });

  it("ignores the answer for a chapter that is no longer open", async () => {
    const first = deferred<Version[]>();
    list.mockReturnValueOnce(first.promise).mockResolvedValueOnce([]);
    await render();
    await render({ chapterId: OTHER });
    await act(async () => first.resolve([NEWER, OLDER]));
    expect(list).toHaveBeenLastCalledWith(OTHER);
    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".empty-note")).not.toBeNull();
  });

  it("reads nothing while the inspector is hidden, and catches up when it is shown", async () => {
    await render({ visible: false });
    await render({ saveStatus: "pending" });
    await render({ saveStatus: "saved" });
    expect(list).not.toHaveBeenCalled();

    await render({ visible: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(2);
  });
});

describe("restoring", () => {
  const restoreButtonOf = (version: Version) =>
    [...container.querySelectorAll<HTMLButtonElement>(".version-restore")].find(
      (b) => b.closest("li")?.querySelector("time")?.getAttribute("dateTime") === new Date(version.savedAt).toISOString(),
    )!;
  const confirmButton = () => container.querySelector<HTMLButtonElement>(".version-confirm .btn--primary");

  it("asks first, says nothing is lost, then restores and says how to undo", async () => {
    await render();
    await act(async () => restoreButtonOf(OLDER).click());
    expect(restoreButtonOf(OLDER).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".version-confirm")?.textContent).toContain("so nothing is lost");
    expect(restore).not.toHaveBeenCalled();

    const done = deferred<void>();
    restore.mockReturnValue(done.promise);
    await act(async () => confirmButton()!.click());
    expect(restore).toHaveBeenCalledWith(CHAPTER, OLDER.savedAt);
    expect(confirmButton()?.textContent).toBe("Restoring…");
    expect(confirmButton()?.disabled).toBe(true);
    expect(restoreButtonOf(NEWER).disabled).toBe(true);

    await act(async () => done.resolve());
    expect(container.querySelector(".version-confirm")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Restored. To undo, restore the newest version.");

    // useProject counts a load after a restore: the list is read again.
    await render({ loads: 2 });
    expect(list).toHaveBeenCalledTimes(2);

    // Typing again retires the note.
    await render({ saveStatus: "pending" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("shows why a restore failed next to the version, and lets it be tried again", async () => {
    restore.mockRejectedValueOnce(new Error("This chapter has changes that could not be saved."));
    await render();
    await act(async () => restoreButtonOf(NEWER).click());
    await act(async () => confirmButton()!.click());
    const error = container.querySelector(".version-confirm [role='alert']");
    expect(error?.textContent).toBe("This chapter has changes that could not be saved.");
    expect(confirmButton()?.disabled).toBe(false);
    expect(confirmButton()?.textContent).toBe("Restore");
  });

  it("closes the question on Cancel or Escape, back on the version's Restore", async () => {
    await render();
    await act(async () => restoreButtonOf(NEWER).click());
    await click("Cancel");
    expect(container.querySelector(".version-confirm")).toBeNull();
    expect(document.activeElement).toBe(restoreButtonOf(NEWER));

    await act(async () => restoreButtonOf(NEWER).click());
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);
    await act(async () => confirmButton()!.dispatchEvent(escape));
    window.removeEventListener("keydown", reachedWindow);
    expect(container.querySelector(".version-confirm")).toBeNull();
    expect(reachedWindow).not.toHaveBeenCalled();
  });

  it("offers no restore while the project on disk is changing", async () => {
    await render({ busy: true });
    expect(restoreButtonOf(NEWER).disabled).toBe(true);
  });
});
