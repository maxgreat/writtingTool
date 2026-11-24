import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The desktop app's native text menu, with Tauri's menu classes faked: each
 * menu and item is a resource in the core until it is closed.
 */
const created = vi.hoisted(() => ({ resources: [] as { closed: boolean; close(): Promise<void> }[], popups: 0 }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => (command === "app_info" ? { canOpenFolders: true } : null)),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/menu", () => {
  const resource = () => {
    const r = {
      closed: false,
      async close() {
        r.closed = true;
      },
    };
    created.resources.push(r);
    return r;
  };
  return {
    MenuItem: { new: async () => resource() },
    PredefinedMenuItem: { new: async () => resource() },
    Menu: {
      new: async () => ({
        ...resource(),
        async popup() {
          created.popups += 1;
        },
      }),
    },
  };
});

vi.mock("@tauri-apps/api/dpi", () => ({ LogicalPosition: class {} }));

beforeEach(() => {
  created.resources.length = 0;
  created.popups = 0;
});

describe("the desktop text menu", () => {
  it("frees the last menu and its items before showing the next, so at most one stays", async () => {
    const { loadBackend } = await import("../backend");
    const backend = await loadBackend();
    const item = { text: "Add “Rose” to Characters", action: () => undefined };
    await backend.popupTextMenu!([item], 10, 10);
    const first = created.resources.slice();
    expect(first.some((r) => r.closed)).toBe(false);
    // Two right-clicks in a row: each frees the one before it.
    await Promise.all([backend.popupTextMenu!([item], 20, 20), backend.popupTextMenu!([], 30, 30)]);
    expect(created.popups).toBe(3);
    expect(first.every((r) => r.closed)).toBe(true);
    const open = created.resources.filter((r) => !r.closed);
    // The last menu: the menu itself and Cut, Copy, Paste, a separator and Select All.
    expect(open).toHaveLength(6);
  });
});
