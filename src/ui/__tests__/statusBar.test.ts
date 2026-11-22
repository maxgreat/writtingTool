// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SaveState } from "../../core/useProject";
import { StatusBar } from "../StatusBar";

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

function render(save: SaveState) {
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
