// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ inApp: true, invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.inApp, invoke: tauri.invoke }));

import { reportWhenChapterShows } from "../launchCheck";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function editor(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

describe("launch check report", () => {
  beforeEach(() => {
    tauri.inApp = true;
    tauri.invoke.mockClear();
  });

  it("reports once, when a chapter editor appears", async () => {
    const root = document.createElement("div");
    reportWhenChapterShows(root);
    root.append(document.createElement("p"));
    await flush();
    expect(tauri.invoke).not.toHaveBeenCalled();

    root.append(editor("chapter-text-plain"));
    await flush();
    root.append(editor("chapter-text"));
    await flush();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("frontend_ready");
  });

  it("reports at once if the editor is already there", () => {
    const root = document.createElement("div");
    root.append(editor("chapter-text"));
    reportWhenChapterShows(root);
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it("does nothing in the browser preview", async () => {
    tauri.inApp = false;
    const root = document.createElement("div");
    reportWhenChapterShows(root);
    root.append(editor("chapter-text"));
    await flush();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
