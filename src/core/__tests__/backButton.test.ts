import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The backend's Back button and app exit, with Tauri's modules faked: on
 * phones (no folder picker) they are there, on desktops they aren't.
 */
const tauri = vi.hoisted(() => ({
  desktop: false,
  handlers: [] as ((payload: { canGoBack: boolean }) => void)[],
  unregister: vi.fn(async () => undefined),
  exit: vi.fn(async (_code?: number) => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => (command === "app_info" ? { canOpenFolders: tauri.desktop } : null)),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: async (handler: (payload: { canGoBack: boolean }) => void) => {
    tauri.handlers.push(handler);
    return { unregister: tauri.unregister };
  },
  exit: tauri.exit,
}));

beforeEach(() => {
  tauri.desktop = false;
  tauri.handlers.length = 0;
  tauri.unregister.mockReset().mockResolvedValue(undefined);
  tauri.exit.mockReset().mockResolvedValue(undefined);
});

describe("the Back button", () => {
  it("is handed to the page on phones, until it lets go", async () => {
    const { loadBackend } = await import("../backend");
    const backend = await loadBackend();
    const handler = vi.fn();
    const stop = await backend.onBackButton!(handler);
    expect(tauri.handlers).toHaveLength(1);
    tauri.handlers[0]({ canGoBack: false });
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    expect(tauri.unregister).toHaveBeenCalledTimes(1);
  });

  it("closes the app on phones, or says why it couldn't", async () => {
    const { loadBackend } = await import("../backend");
    const backend = await loadBackend();
    await backend.exitApp!();
    expect(tauri.exit).toHaveBeenCalledWith(0);
    tauri.exit.mockRejectedValue("app.exit not allowed");
    await expect(backend.exitApp!()).rejects.toThrow("app.exit not allowed");
  });

  it("isn't there on desktops, which close windows instead", async () => {
    tauri.desktop = true;
    const { loadBackend } = await import("../backend");
    const backend = await loadBackend();
    expect(backend.onBackButton).toBeUndefined();
    expect(backend.exitApp).toBeUndefined();
    expect(backend.closeWindow).toBeDefined();
  });
});
