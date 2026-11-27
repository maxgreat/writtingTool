// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveState } from "../../core/useProject";
import { CloseDialog, type CloseDialogProps } from "../CloseDialog";

const ERROR = "Couldn’t write “01 Arrival.md”: the disk is full.";

const onCancel = vi.fn<() => void>();
const onClose = vi.fn<() => void>();
const onDiscard = vi.fn<() => void>();
const onSaveAndClose = vi.fn<() => void>();

let container: HTMLDivElement;
let root: Root;
let props: CloseDialogProps;
/** What had focus before the dialog opened: the chapter, say. */
let field: HTMLTextAreaElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const callback of [onCancel, onClose, onDiscard, onSaveAndClose]) callback.mockReset();
  props = { open: true, save: { status: "saved" }, closing: false, onCancel, onClose, onDiscard, onSaveAndClose };
  container = document.createElement("div");
  field = document.createElement("textarea");
  document.body.append(field, container);
  field.focus();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  field.remove();
});

function render(patch: Partial<CloseDialogProps> = {}) {
  props = { ...props, ...patch };
  act(() => root.render(createElement(CloseDialog, props)));
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const title = () => dialog()?.querySelector("h2")?.textContent;
const text = () => dialog()?.querySelector(".close-dialog-text")?.textContent;
const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])];
const labels = () => buttons().map((b) => b.textContent);
const button = (name: string) => buttons().find((b) => b.textContent === name)!;
const enabled = () => buttons().filter((b) => !b.disabled).map((b) => b.textContent);
const primary = () => dialog()?.querySelector<HTMLButtonElement>(".btn--primary");
const focused = () => document.activeElement?.textContent;

function key(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("what it says, in each save state", () => {
  it("saved: says so, and offers Close", () => {
    render({ save: { status: "saved" } });
    expect(title()).toBe("Close Writing Tool?");
    expect(text()).toBe("All your changes are saved.");
    expect(labels()).toEqual(["Cancel", "Close"]);
    expect(primary()?.textContent).toBe("Close");
  });

  it("saved with a warning: still saved", () => {
    render({ save: { status: "saved", warning: "The previous version couldn’t be kept." } });
    expect(title()).toBe("Close Writing Tool?");
    expect(text()).toBe("All your changes are saved.");
    expect(labels()).toEqual(["Cancel", "Close"]);
  });

  it("pending: asks to save first, with Close without saving set apart", () => {
    render({ save: { status: "pending" } });
    expect(title()).toBe("Save changes before closing?");
    expect(text()).toBe("Your latest changes aren’t saved yet.");
    expect(labels()).toEqual(["Close without saving", "Cancel", "Save and close"]);
    expect(primary()?.textContent).toBe("Save and close");
    expect(button("Close without saving").classList).toContain("btn--quiet");
    expect(enabled()).toEqual(labels());
  });

  it("saving: says so, and only Cancel can be pressed", () => {
    render({ save: { status: "saving" } });
    expect(title()).toBe("Save changes before closing?");
    expect(text()).toBe("Saving…");
    expect(labels()).toEqual(["Close without saving", "Cancel", "Save and close"]);
    expect(enabled()).toEqual(["Cancel"]);
    expect(primary()?.getAttribute("aria-busy")).toBe("true");
  });

  it("closing: waits as while saving, whatever the save state says", () => {
    for (const save of [{ status: "pending" }, { status: "error", message: ERROR }] as SaveState[]) {
      render({ save, closing: true });
      expect(title()).toBe("Save changes before closing?");
      expect(text()).toBe("Saving…");
      expect(enabled()).toEqual(["Cancel"]);
      expect(primary()?.disabled).toBe(true);
      expect(primary()?.getAttribute("aria-busy")).toBe("true");
    }
  });

  it("error: says why, and offers to try again or close without saving", () => {
    render({ save: { status: "error", message: ERROR } });
    expect(title()).toBe("Couldn’t save your changes");
    const paragraphs = [...dialog()!.querySelectorAll(".close-dialog-text p")].map((p) => p.textContent);
    expect(paragraphs).toEqual([ERROR, "Close without saving to quit without them."]);
    expect(labels()).toEqual(["Close without saving", "Cancel", "Try again"]);
    expect(primary()?.textContent).toBe("Try again");
    expect(enabled()).toEqual(labels());
  });

  it("keeps Try again as the label while the retry waits, so the button doesn't change size", () => {
    render({ save: { status: "error", message: ERROR } });
    render({ closing: true });
    expect(primary()?.textContent).toBe("Try again");
    expect(primary()?.disabled).toBe(true);
    render({ save: { status: "saving" } });
    expect(primary()?.textContent).toBe("Try again");

    // Cancelled, then asked again with edits pending: a fresh question.
    render({ open: false, closing: false, save: { status: "pending" } });
    render({ open: true });
    expect(primary()?.textContent).toBe("Save and close");
  });
});

describe("the dialog", () => {
  it("is a modal alert dialog in a portal on the page's body, named and described by its text", () => {
    render({ save: { status: "pending" } });
    const el = dialog()!;
    expect(container.contains(el)).toBe(false);
    expect(el.closest(".close-dialog-scrim")?.parentElement).toBe(document.body);
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Save changes before closing?",
    );
    expect(document.getElementById(el.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Your latest changes aren’t saved yet.",
    );
  });

  it("shows nothing while closed", () => {
    render({ open: false });
    expect(dialog()).toBeNull();
    expect(document.querySelector(".close-dialog-scrim")).toBeNull();
  });
});

describe("the buttons", () => {
  it("each calls its own callback", () => {
    render({ save: { status: "saved" } });
    act(() => button("Close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => button("Cancel").click());
    expect(onCancel).toHaveBeenCalledTimes(1);

    render({ save: { status: "pending" } });
    act(() => button("Save and close").click());
    expect(onSaveAndClose).toHaveBeenCalledTimes(1);
    act(() => button("Close without saving").click());
    expect(onDiscard).toHaveBeenCalledTimes(1);

    render({ save: { status: "error", message: ERROR } });
    act(() => button("Try again").click());
    expect(onSaveAndClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("can't be pressed while the save is written, except Cancel", () => {
    render({ save: { status: "pending" }, closing: true });
    for (const name of ["Close without saving", "Save and close"]) act(() => button(name).click());
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onSaveAndClose).not.toHaveBeenCalled();
    act(() => button("Cancel").click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a press on the scrim does nothing: this is a decision", () => {
    render({ save: { status: "pending" } });
    const scrim = document.querySelector(".close-dialog-scrim")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      scrim.dispatchEvent(down);
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The press doesn't take focus from the dialog either.
    expect(down.defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    for (const callback of [onCancel, onClose, onDiscard, onSaveAndClose]) expect(callback).not.toHaveBeenCalled();
  });
});

describe("the keyboard", () => {
  it("Escape cancels, even while the save is written", () => {
    render({ save: { status: "pending" } });
    const event = key({ key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    render({ closing: true });
    key({ key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("Escape is the dialog's alone: a menu or sheet beneath doesn't close too", () => {
    const beneath = vi.fn();
    document.addEventListener("keydown", beneath, true);
    try {
      render({ save: { status: "pending" } });
      key({ key: "Escape" });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(beneath).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", beneath, true);
    }
  });

  it("keys pressed in the dialog don't bubble on to the app", () => {
    const app = vi.fn();
    window.addEventListener("keydown", app);
    try {
      render({ save: { status: "pending" } });
      key({ key: "s", ctrlKey: true });
      key({ key: "Enter" });
      expect(app).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", app);
    }
  });

  it("stops listening once closed", () => {
    render({ save: { status: "pending" } });
    render({ open: false });
    key({ key: "Escape" });
    const tab = key({ key: "Tab" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(tab.defaultPrevented).toBe(false);
  });

  it("Tab and Shift+Tab go round the dialog's buttons and never leave it", () => {
    render({ save: { status: "pending" } });
    expect(focused()).toBe("Save and close");
    key({ key: "Tab" });
    expect(focused()).toBe("Close without saving");
    key({ key: "Tab" });
    expect(focused()).toBe("Cancel");
    key({ key: "Tab" });
    expect(focused()).toBe("Save and close");
    key({ key: "Tab", shiftKey: true });
    expect(focused()).toBe("Cancel");

    // From outside the dialog, Tab comes back in.
    act(() => field.focus());
    key({ key: "Tab" });
    expect(focused()).toBe("Close without saving");
    act(() => field.focus());
    key({ key: "Tab", shiftKey: true });
    expect(focused()).toBe("Save and close");
  });

  it("Tab stays on Cancel while it is the only button that can be pressed", () => {
    render({ save: { status: "saving" } });
    expect(focused()).toBe("Cancel");
    key({ key: "Tab" });
    expect(focused()).toBe("Cancel");
    key({ key: "Tab", shiftKey: true });
    expect(focused()).toBe("Cancel");
  });
});

describe("focus", () => {
  it("starts on the primary button and goes back where it was once the dialog closes", () => {
    expect(document.activeElement).toBe(field);
    render({ save: { status: "saved" } });
    expect(document.activeElement).toBe(button("Close"));

    render({ open: false });
    expect(document.activeElement).toBe(field);
  });

  it("starts on Cancel when the primary button waits", () => {
    render({ save: { status: "saving" } });
    expect(document.activeElement).toBe(button("Cancel"));
    render({ open: false });
    expect(document.activeElement).toBe(field);
  });

  it("follows the primary button while the save is written, fails, and is tried again", () => {
    render({ save: { status: "pending" } });
    expect(focused()).toBe("Save and close");
    render({ closing: true });
    expect(focused()).toBe("Cancel");
    render({ closing: false, save: { status: "error", message: ERROR } });
    expect(focused()).toBe("Try again");
  });

  it("moves to Close once an autosave under way when the dialog opened is written", () => {
    render({ save: { status: "saving" } });
    expect(focused()).toBe("Cancel");
    render({ save: { status: "saved" } });
    expect(focused()).toBe("Close");
  });

  it("stays where the user moved it", () => {
    render({ save: { status: "pending" } });
    key({ key: "Tab" });
    expect(focused()).toBe("Close without saving");
    // A write that was under way when the dialog opened fails.
    render({ save: { status: "error", message: ERROR } });
    expect(focused()).toBe("Close without saving");
  });

  it("does the same in StrictMode, whose effects run twice", () => {
    const strict = (patch: Partial<CloseDialogProps>) => {
      props = { ...props, ...patch };
      act(() => root.render(createElement(StrictMode, null, createElement(CloseDialog, props))));
    };
    strict({ save: { status: "pending" } });
    expect(focused()).toBe("Save and close");
    strict({ closing: true });
    expect(focused()).toBe("Cancel");
    strict({ closing: false, save: { status: "error", message: ERROR } });
    expect(focused()).toBe("Try again");
    strict({ open: false });
    expect(document.activeElement).toBe(field);
  });

  it("isn't given back when it shouldn't be (a phone's, where it would bring up the keyboard)", () => {
    render({ save: { status: "saved" }, returnFocus: false });
    expect(document.activeElement).toBe(button("Close"));
    render({ open: false });
    expect(document.activeElement).not.toBe(field);
  });

  it("goes back where it was when the dialog goes away while open", () => {
    render({ save: { status: "pending" } });
    act(() => root.render(null));
    expect(document.activeElement).toBe(field);
  });

  it("is left alone on closing when something else has taken it meanwhile", () => {
    const other = document.createElement("button");
    document.body.append(other);
    try {
      render({ save: { status: "pending" } });
      act(() => other.focus());
      render({ open: false });
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });
});
