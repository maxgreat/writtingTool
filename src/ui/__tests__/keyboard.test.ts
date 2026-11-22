// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useOnScreenKeyboard } from "../useOnScreenKeyboard";

/** What the Android shell runs in the page when the keyboard is shown or hidden (MainActivity.kt). */
function tell(state: "shown" | "hidden") {
  act(() => {
    document.documentElement.dataset.onScreenKeyboard = state;
    window.dispatchEvent(new Event("onscreenkeyboardchange"));
  });
}

describe("useOnScreenKeyboard", () => {
  let page: HTMLDivElement;
  let container: HTMLDivElement;
  let root: Root;
  let seen: boolean[];

  function Harness({ enabled }: { enabled: boolean }) {
    seen.push(useOnScreenKeyboard(enabled, ".editor-pane"));
    return null;
  }

  const last = () => seen.at(-1);
  const render = (enabled = true) => act(() => root.render(createElement(Harness, { enabled })));
  const focus = (id: string) => act(() => document.getElementById(id)!.focus());
  const blur = () => act(() => (document.activeElement as HTMLElement).blur());
  const resize = (width: number, height: number) =>
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
      window.dispatchEvent(new Event("resize"));
    });

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    seen = [];
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 412 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 915 });
    // The chapter text with a button that keeps focus in it (Bold), and a field elsewhere.
    page = document.createElement("div");
    page.innerHTML =
      '<div class="editor-pane"><textarea id="text"></textarea><button id="bold"></button></div>' +
      '<input id="elsewhere">';
    document.body.append(page);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    page.remove();
    delete document.documentElement.dataset.onScreenKeyboard;
  });

  it("is never up where the shell says nothing, whatever the window does", () => {
    render();
    focus("text");
    // A keyboard-sized drop, a split screen, a freeform window dragged shorter.
    resize(412, 560);
    expect(last()).toBe(false);
    resize(412, 450);
    resize(412, 250);
    expect(last()).toBe(false);
    resize(360, 300);
    expect(last()).toBe(false);
    // The event alone, without the attribute, doesn't count either.
    act(() => {
      window.dispatchEvent(new Event("onscreenkeyboardchange"));
    });
    expect(last()).toBe(false);
  });

  it("is up while the shell says the keyboard is shown and the chapter has focus", () => {
    render();
    focus("text");
    expect(last()).toBe(false);
    tell("shown");
    expect(last()).toBe(true);
    tell("hidden");
    expect(last()).toBe(false);
    tell("shown");
    expect(last()).toBe(true);
  });

  it("reads the shell's word when it mounts", () => {
    focus("text");
    document.documentElement.dataset.onScreenKeyboard = "shown";
    render();
    expect(last()).toBe(true);
  });

  it("goes down when focus leaves the chapter, even with the keyboard shown", () => {
    render();
    focus("text");
    tell("shown");
    // Another field's keyboard: still shown, but not for the chapter.
    focus("elsewhere");
    expect(last()).toBe(false);
    focus("text");
    expect(last()).toBe(true);
    blur();
    expect(last()).toBe(false);
  });

  it("isn't up for a keyboard shown for another field", () => {
    render();
    focus("elsewhere");
    tell("shown");
    expect(last()).toBe(false);
  });

  it("stays up while focus moves within the chapter", () => {
    render();
    focus("text");
    tell("shown");
    focus("bold");
    expect(last()).toBe(true);
    focus("text");
    expect(last()).toBe(true);
  });

  it("doesn't change when the window is resized alone", () => {
    render();
    focus("text");
    tell("shown");
    // Turned, or a split-screen divider dragged, with the keyboard still up.
    resize(915, 412);
    resize(412, 250);
    expect(last()).toBe(true);
    tell("hidden");
    // Split screen with no keyboard: the window shrinks like a keyboard would make it.
    resize(412, 450);
    resize(412, 560);
    expect(last()).toBe(false);
  });

  it("is never up while turned off, and right as soon as it is turned on", () => {
    render(false);
    focus("text");
    tell("shown");
    expect(last()).toBe(false);
    render(true);
    expect(last()).toBe(true);
  });
});
