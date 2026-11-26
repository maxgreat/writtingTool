// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveState, SyncState } from "../../core/useProject";
import { SLOW_SYNC_MS, StatusBar, type StatusBarProps } from "../StatusBar";

const WARNING = "Saved, but the previous version could not be kept: Permission denied";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(save: SaveState, extra: Partial<StatusBarProps> = {}) {
  act(() =>
    root.render(
      createElement(StatusBar, {
        chapterWords: 10,
        bookWords: 100,
        wordsToday: 0,
        language: "en-GB",
        save,
        onRetry: async () => undefined,
        backendKind: "app",
        problems: [],
        compact: false,
        ...extra,
      }),
    ),
  );
}

const live = () => container.querySelector('[role="status"]');

describe("the save state", () => {
  it("says the text is saved", () => {
    render({ status: "saved" });
    expect(container.textContent).toContain("Saved on this device");
    expect(container.querySelector(".save-warning")).toBeNull();
    expect(live()?.textContent).toBe("");
  });

  it("warns when the text was saved but its previous version wasn't kept, with the full reason", () => {
    render({ status: "saving" });
    const region = live();
    render({ status: "saved", warning: WARNING });
    const warning = container.querySelector(".save-warning");
    expect(warning?.textContent).toContain("Saved · previous version not kept");
    expect(warning?.getAttribute("title")).toBe(WARNING);
    expect(container.textContent).not.toContain("Saved on this device");
    // The same live region as before, so screen readers announce the change.
    expect(live()).toBe(region);
    expect(live()?.textContent).toBe(WARNING);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("the sync with Dropbox", () => {
  /** When the last sync finished: a quarter past two, today. */
  const AT = new Date(2026, 10, 25, 14, 15).getTime();
  const CHAPTER = "manuscript/01 Arrival.md";
  const SHEET = "sheets/characters/Elena.md";
  const TITLES = new Map([
    [CHAPTER, "Arrival"],
    [SHEET, "Elena"],
  ]);
  const PROBLEM = "cover.png was changed on two devices and isn't text that can be merged, so this device's version was kept.";
  const onSyncNow = vi.fn<() => Promise<void>>();
  const onDismissConflicts = vi.fn<() => void>();
  let compact = false;

  const synced = (patch: { conflicts?: string[]; problems?: string[]; unsent?: boolean } = {}): SyncState => ({
    status: "synced",
    at: AT,
    conflicts: [],
    problems: [],
    ...patch,
  });

  function show(sync: SyncState) {
    render(
      { status: "saved" },
      { sync, onSyncNow, onDismissConflicts, fileTitle: (path) => TITLES.get(path) ?? null, compact },
    );
  }

  /** What the bar's end shows but the save state, and its live region: what the sync shows. */
  const end = () =>
    [...container.querySelectorAll(".status-group--end > :not([role='status'])")]
      .map((el) => el.textContent)
      .join("")
      .replace("Saved on this device", "");
  const item = (text: string) =>
    [...container.querySelectorAll<HTMLElement>(".status-item")].find((el) => el.textContent?.includes(text));
  const syncLive = () => container.querySelector('.status-group--end > [role="status"]')?.textContent;
  const warning = () => container.querySelector<HTMLButtonElement>("button.status-problems");
  const popover = () => document.querySelector<HTMLElement>('.popover[role="dialog"]');
  const retry = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^Retr/u.test(b.textContent ?? ""));

  async function escape() {
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  }

  async function wait(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: AT + 60_000 });
    onSyncNow.mockReset().mockResolvedValue(undefined);
    onDismissConflicts.mockReset();
    compact = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing for a project on this device only", () => {
    show({ status: "off" });
    expect(end()).toBe("");
    expect(syncLive()).toBe("");
  });

  it("says a project in Dropbox isn't syncing without an account here, and where to connect one", () => {
    show({ status: "signedOut" });
    expect(end()).toContain("Not syncing · connect Dropbox in Settings");
    expect(item("Not syncing")?.title).toBe(
      "This project is in Dropbox, but no Dropbox account is connected on this device. Connect one in Settings to sync it.",
    );
    compact = true;
    show({ status: "signedOut" });
    expect(item("Not syncing")?.querySelector(".muted")?.textContent).toBe("Not syncing");
    // The rest is read out, after the note.
    expect(item("Not syncing")?.querySelector(".visually-hidden")?.textContent).toContain("Connect one in Settings");
  });

  it("says the project is synced, quietly, with the time of the last sync on hover", () => {
    show(synced());
    expect(end()).toBe("Synced with Dropbox");
    expect(item("Synced")?.title).toMatch(/^Last synced: Today, /u);
    expect(item("Synced")?.title).toContain("15");
    expect(syncLive()).toBe("");
    compact = true;
    show(synced());
    expect(item("Synced")?.querySelector(".muted")?.textContent).toBe("Synced");
  });

  it("says when the latest edits aren't in Dropbox yet (automatic saving off), quietly, and how to send them", () => {
    const UNSENT = "Edits not in Dropbox yet";
    const HOW = /^Last synced: Today, [^.]*15[^.]*\. Choose Save to Dropbox in the main menu to send your latest edits\.$/u;
    show(synced({ unsent: true }));
    expect(end()).not.toContain("Synced");
    const line = item(UNSENT)!;
    expect(line.querySelector(".muted")?.textContent).toBe(UNSENT);
    expect(line.title).toMatch(HOW);
    // The rest is read out, after the note.
    expect(line.querySelector(".visually-hidden")?.textContent).toBe(`. ${line.title}`);
    // The writer's choice, not a failure: nothing announced, no warning colour.
    expect(line.classList.contains("sync-error")).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(syncLive()).toBe("");

    compact = true;
    show(synced({ unsent: true }));
    const short = item("Not sent")!;
    expect(short.querySelector(".muted")?.textContent).toBe("Not sent");
    const read = short.querySelector(".visually-hidden")?.textContent ?? "";
    expect(read.startsWith(" to Dropbox. ")).toBe(true);
    expect(read.slice(" to Dropbox. ".length)).toMatch(HOW);
  });

  it("keeps saying the edits aren't in Dropbox while a quick sync sends them, then that it is synced", () => {
    show(synced({ unsent: true }));
    show({ status: "syncing", at: AT });
    expect(end()).toContain("Edits not in Dropbox yet");
    show(synced());
    expect(end()).toBe("Synced with Dropbox");
    expect(item("Synced")?.title).toMatch(/^Last synced: Today, /u);
  });

  it("doesn't flicker for a quick background sync, and says Syncing… once one lasts", async () => {
    show(synced());
    show({ status: "syncing", at: AT });
    expect(end()).toBe("Synced with Dropbox");
    await wait(SLOW_SYNC_MS - 1);
    expect(end()).toBe("Synced with Dropbox");
    await wait(1);
    expect(end()).toBe("Syncing…");

    show(synced());
    expect(end()).toBe("Synced with Dropbox");
    // The next sync counts afresh.
    show({ status: "syncing", at: AT });
    await wait(SLOW_SYNC_MS - 1);
    expect(end()).toBe("Synced with Dropbox");
    show(synced());
    await wait(SLOW_SYNC_MS);
    expect(end()).toBe("Synced with Dropbox");
  });

  it("says Syncing… at once when there is nothing to show before it, and synced if a sync ever finished", () => {
    show({ status: "syncing", at: null });
    expect(end()).toBe("Syncing…");
    act(() => root.unmount());
    root = createRoot(container);
    show({ status: "syncing", at: AT });
    expect(end()).toBe("Synced with Dropbox");
  });

  it("says a sync failed, with the reason and that edits are safe, and retries", async () => {
    show({ status: "error", message: "Cannot reach Dropbox: no connection", at: AT });
    expect(end()).toContain("Not synced · edits go with the next sync");
    const reason = item("Not synced")?.querySelector<HTMLElement>("[title]");
    expect(reason?.title).toBe(
      "Cannot reach Dropbox: no connection. Your edits are safe on this device and go to Dropbox with the next sync.",
    );
    expect(syncLive()).toBe("Not synced. Cannot reach Dropbox: no connection.");
    // Edits are safe: a warning, not an alert.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(item("Not synced")?.classList.contains("sync-error")).toBe(true);

    let finish: () => void = () => undefined;
    onSyncNow.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    await act(async () => retry()!.click());
    expect(onSyncNow).toHaveBeenCalledTimes(1);
    expect(retry()?.textContent).toBe("Retrying…");
    expect(retry()?.disabled).toBe(true);
    await act(async () => finish());
    expect(retry()?.textContent).toBe("Retry");
  });

  it("opens why a sync failed from a button on phones, which have no hover, with Retry", async () => {
    compact = true;
    show({ status: "error", message: "Cannot reach Dropbox: no connection", at: AT });
    const failed = container.querySelector<HTMLButtonElement>('button[aria-label="Not synced"]')!;
    expect(failed.classList.contains("sync-error")).toBe(true);
    expect(failed.getAttribute("aria-expanded")).toBe("false");
    expect(syncLive()).toBe("Not synced. Cannot reach Dropbox: no connection.");

    await act(async () => failed.click());
    expect(failed.getAttribute("aria-expanded")).toBe("true");
    expect(popover()?.getAttribute("aria-label")).toBe("Not synced");
    expect(popover()?.textContent).toContain("Cannot reach Dropbox: no connection.");
    expect(popover()?.textContent).toContain(
      "Your edits are safe on this device and go to Dropbox with the next sync.",
    );
    const again = [...popover()!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => again.click());
    expect(onSyncNow).toHaveBeenCalledTimes(1);

    // The sync went through: the reason goes with the failure.
    show(synced());
    expect(popover()).toBeNull();
    expect(end()).toContain("Synced");
  });

  it("keeps a failure in place while a quick sync tries again, without announcing it again", async () => {
    show({ status: "error", message: "Cannot reach Dropbox.", at: null });
    const region = container.querySelector('.status-group--end > [role="status"]');
    show({ status: "syncing", at: null });
    expect(end()).toContain("Not synced");
    expect(end()).not.toContain("Syncing…");
    expect(syncLive()).toBe("Not synced. Cannot reach Dropbox.");
    await wait(SLOW_SYNC_MS);
    expect(end()).toBe("Syncing…");
    // The failure stays announced as it was: nothing new to read out.
    expect(syncLive()).toBe("Not synced. Cannot reach Dropbox.");
    show(synced());
    expect(end()).toBe("Synced with Dropbox");
    expect(syncLive()).toBe("");
    expect(container.querySelector('.status-group--end > [role="status"]')).toBe(region);
  });

  it("warns of files edited on two devices, and lists them, by title where they have one", async () => {
    show(synced({ conflicts: [CHAPTER, SHEET, "notes/loose.md", "project.json"], problems: [] }));
    expect(warning()?.getAttribute("aria-label")).toBe("4 files edited on two devices");
    expect(warning()?.textContent).toBe("4 files edited on two devices");
    expect(end()).toContain("Synced with Dropbox");
    expect(syncLive()).toBe("4 files edited on two devices.");

    await act(async () => warning()!.click());
    expect(warning()?.getAttribute("aria-expanded")).toBe("true");
    const dialog = popover()!;
    expect(dialog.getAttribute("aria-label")).toBe("Edited on two devices");
    expect([...dialog.querySelectorAll(".problems-list li")].map((li) => li.textContent)).toEqual([
      "Arrival",
      "Elena",
      "notes/loose.md",
    ]);
    expect(dialog.querySelector(".problems-list .path")?.textContent).toBe("notes/loose.md");
    expect(dialog.textContent).toContain("These were edited in the same places on two devices.");
    expect(dialog.textContent).toContain("Both versions are in the text, one after the other, this device’s first");
    expect(dialog.textContent).toContain("Binder and project settings: where both devices changed the same thing");
    expect(dialog.textContent).not.toContain("Sync problems");

    // Only a sync's end carries the list: while the next one runs, or after it fails, the warning stays as it was.
    show({ status: "syncing", at: AT });
    expect(warning()?.textContent).toBe("4 files edited on two devices");
    expect(popover()).not.toBeNull();
    show({ status: "error", message: "Cannot reach Dropbox.", at: AT });
    expect(warning()?.textContent).toBe("4 files edited on two devices");
    expect(onDismissConflicts).not.toHaveBeenCalled();
  });

  it("takes the warning away once its list has been seen, until a later sync finds another file", async () => {
    show(synced({ conflicts: [CHAPTER] }));
    await act(async () => warning()!.click());
    expect(onDismissConflicts).not.toHaveBeenCalled();
    await escape();
    expect(popover()).toBeNull();
    expect(onDismissConflicts).toHaveBeenCalledTimes(1);

    // As useProject reports from then on.
    show(synced());
    expect(warning()).toBeNull();
    expect(syncLive()).toBe("");
    expect(end()).toBe("Synced with Dropbox");

    // A later sync finds another: the warning comes back, and is announced again.
    show(synced({ conflicts: [SHEET] }));
    expect(warning()?.textContent).toBe("1 file edited on two devices");
    expect(syncLive()).toBe("1 file edited on two devices.");
    await act(async () => warning()!.click());
    expect([...popover()!.querySelectorAll(".problems-list li")].map((li) => li.textContent)).toEqual(["Elena"]);
    // Closed from the warning itself, it counts as seen too.
    await act(async () => warning()!.click());
    expect(popover()).toBeNull();
    expect(onDismissConflicts).toHaveBeenCalledTimes(2);
  });

  it("takes the warning away at once while a sync runs, though only the sync's end says so", async () => {
    show(synced({ conflicts: [CHAPTER] }));
    await act(async () => warning()!.click());
    show({ status: "syncing", at: AT });
    await escape();
    expect(onDismissConflicts).toHaveBeenCalledTimes(1);
    expect(warning()).toBeNull();
    expect(end()).toBe("Synced with Dropbox");
    show(synced());
    expect(warning()).toBeNull();
  });

  it("keeps the list open until it is closed, even when the next sync reports nothing", async () => {
    show(synced({ problems: [PROBLEM] }));
    await act(async () => warning()!.click());
    show(synced());
    expect(popover()?.textContent).toContain(PROBLEM);
    await act(async () => warning()!.click());
    expect(popover()).toBeNull();
    expect(warning()).toBeNull();
  });

  it("lists what a sync couldn't do in the same place, until the next sync", async () => {
    show(synced({ problems: [PROBLEM] }));
    expect(warning()?.textContent).toBe("1 sync problem");
    await act(async () => warning()!.click());
    expect(popover()?.getAttribute("aria-label")).toBe("Sync problems");
    expect(popover()?.querySelector(".problems-list li")?.textContent).toBe(PROBLEM);
    // Seen, problems stay: they are the last sync's, and go with the next one.
    await act(async () => warning()!.click());
    expect(onDismissConflicts).not.toHaveBeenCalled();
    expect(warning()?.textContent).toBe("1 sync problem");

    show(synced({ conflicts: [CHAPTER], problems: [PROBLEM] }));
    expect(warning()?.textContent).toBe("1 file edited on two devices");
    await act(async () => warning()!.click());
    expect([...popover()!.querySelectorAll(".popover-title")].map((t) => t.textContent)).toEqual([
      "Edited on two devices",
      "Sync problems",
    ]);
    await escape();
    expect(onDismissConflicts).toHaveBeenCalledTimes(1);
    // As useProject reports then: the files are gone, the problem stays until the next sync.
    show(synced({ problems: [PROBLEM] }));
    expect(warning()?.textContent).toBe("1 sync problem");
    expect(document.activeElement).toBe(warning());
    show(synced());
    expect(warning()).toBeNull();
  });

  it("shows only the count on phones, in place of Synced, for which there is no room", () => {
    compact = true;
    show(synced({ conflicts: [CHAPTER, SHEET] }));
    expect(warning()?.textContent).toBe("2");
    expect(warning()?.getAttribute("aria-label")).toBe("2 files edited on two devices");
    expect(end()).not.toContain("Synced");
    show(synced());
    expect(end()).toContain("Synced");
  });

  it("drops the warning with the project, and its open list, without counting it as seen", async () => {
    show(synced({ conflicts: [CHAPTER] }));
    await act(async () => warning()!.click());
    show({ status: "off" });
    expect(warning()).toBeNull();
    expect(popover()).toBeNull();
    expect(end()).toBe("");
    expect(onDismissConflicts).not.toHaveBeenCalled();
    // The next project's first report starts afresh.
    show(synced({ conflicts: [SHEET] }));
    expect(warning()?.getAttribute("aria-expanded")).toBe("false");
  });
});
