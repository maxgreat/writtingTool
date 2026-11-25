// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DROPBOX_SIGN_IN_CANCELLED, type DropboxBackend, type DropboxStatus } from "../backend";
import { useDropbox, type DropboxConnection } from "../useDropbox";

const ada = { accountId: "dbid:ada", name: "Ada Lovelace", email: "ada@example.com" };
const connected: DropboxStatus = { account: ada, tokenInFile: false };
const none: DropboxStatus = { account: null, tokenInFile: false };

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let result: DropboxConnection | null;
let finishes: ReturnType<typeof deferred<DropboxStatus>>[];
let dropbox: DropboxBackend & { [K in keyof DropboxBackend]: ReturnType<typeof vi.fn> };

function Probe({ backend }: { backend: DropboxBackend | undefined }) {
  result = useDropbox(backend);
  return null;
}

async function render(backend: { dropbox: DropboxBackend | undefined } = { dropbox }) {
  await act(async () => root.render(createElement(Probe, { backend: backend.dropbox })));
}

/** The connection, which these tests always have. */
function conn(): DropboxConnection {
  if (!result) throw new Error("no connection");
  return result;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  finishes = [];
  dropbox = {
    status: vi.fn(async () => none),
    signInStart: vi.fn(async () => ({ manual: false })),
    signInFinish: vi.fn(() => {
      const next = deferred<DropboxStatus>();
      finishes.push(next);
      return next.promise;
    }),
    signInCancel: vi.fn(async () => {
      for (const f of finishes) f.reject(new Error(DROPBOX_SIGN_IN_CANCELLED));
    }),
    signOut: vi.fn(async () => null),
  };
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useDropbox", () => {
  it("is null without Dropbox", async () => {
    await render({ dropbox: undefined });
    expect(result).toBeNull();
  });

  it("shows the account connected on this device", async () => {
    dropbox.status.mockResolvedValueOnce(connected);
    await render();
    expect(conn().view).toEqual({ step: "connected", account: ada, tokenInFile: false, disconnecting: false });
  });

  it("waits for Dropbox's answer, then shows the account", async () => {
    await render();
    expect(conn().view).toEqual({ step: "disconnected" });
    await act(async () => void conn().connect());
    expect(conn().view).toEqual({ step: "waiting", manual: false, submitting: false });
    await act(async () => finishes[0].resolve(connected));
    expect(conn().view.step).toBe("connected");
    expect(conn().error).toBeNull();
  });

  it("goes back quietly when cancelled, and a cancelled answer never undoes a newer sign-in", async () => {
    await render();
    await act(async () => void conn().connect());
    await act(async () => conn().cancel());
    expect(conn().view).toEqual({ step: "disconnected" });
    expect(conn().error).toBeNull();

    // The first sign-in's rejection arrives only after a second one has started.
    dropbox.signInCancel.mockResolvedValueOnce(undefined);
    await act(async () => void conn().connect());
    await act(async () => void conn().cancel());
    await act(async () => void conn().connect());
    expect(finishes).toHaveLength(3);
    await act(async () => finishes[1].reject(new Error(DROPBOX_SIGN_IN_CANCELLED)));
    expect(conn().view).toEqual({ step: "waiting", manual: false, submitting: false });
    await act(async () => finishes[2].resolve(connected));
    expect(conn().view.step).toBe("connected");
  });

  it("shows the account when the sign-in had kept its access before Cancel", async () => {
    await render();
    await act(async () => void conn().connect());
    dropbox.status.mockResolvedValueOnce(connected);
    await act(async () => conn().cancel());
    expect(conn().view.step).toBe("connected");
    expect(conn().error).toBeNull();
  });

  it("shows why signing in failed", async () => {
    await render();
    await act(async () => void conn().connect());
    await act(async () => finishes[0].reject(new Error("Dropbox access was not allowed.")));
    expect(conn().view).toEqual({ step: "disconnected" });
    expect(conn().error).toBe("Dropbox access was not allowed.");
  });

  it("shows why Dropbox's page could not be opened", async () => {
    dropbox.signInStart.mockRejectedValueOnce(new Error("Cannot open Dropbox's page in the browser"));
    await render();
    await act(async () => conn().connect());
    expect(conn().view).toEqual({ step: "disconnected" });
    expect(conn().error).toBe("Cannot open Dropbox's page in the browser");
  });

  it("takes a pasted code, and lets a wrong one be corrected", async () => {
    dropbox.signInStart.mockResolvedValueOnce({ manual: true });
    await render();
    await act(async () => conn().connect());
    expect(conn().view).toEqual({ step: "waiting", manual: true, submitting: false });
    expect(dropbox.signInFinish).not.toHaveBeenCalled();

    await act(async () => void conn().submitCode(" wrong "));
    expect(dropbox.signInFinish).toHaveBeenLastCalledWith("wrong");
    expect(conn().view).toEqual({ step: "waiting", manual: true, submitting: true });
    await act(async () => finishes[0].reject(new Error("Dropbox refused the sign-in (invalid_grant).")));
    expect(conn().view).toEqual({ step: "waiting", manual: true, submitting: false });
    expect(conn().error).toBe("Dropbox refused the sign-in (invalid_grant).");

    await act(async () => void conn().submitCode("right"));
    expect(conn().error).toBeNull();
    await act(async () => finishes[1].resolve(connected));
    expect(conn().view.step).toBe("connected");
  });

  it("signs out, with the note when Dropbox couldn't be told", async () => {
    dropbox.status.mockResolvedValueOnce(connected);
    dropbox.signOut.mockResolvedValueOnce("Disconnected on this device, but Dropbox could not be told.");
    await render();
    await act(async () => conn().disconnect());
    expect(conn().view).toEqual({ step: "disconnected" });
    expect(conn().note).toBe("Disconnected on this device, but Dropbox could not be told.");
  });

  it("stays connected when signing out fails", async () => {
    dropbox.status.mockResolvedValueOnce(connected);
    dropbox.signOut.mockRejectedValueOnce(new Error("Cannot remove the Dropbox sign-in"));
    await render();
    await act(async () => conn().disconnect());
    expect(conn().view).toEqual({ step: "connected", account: ada, tokenInFile: false, disconnecting: false });
    expect(conn().error).toBe("Cannot remove the Dropbox sign-in");
  });

  it("stops waiting for Dropbox when it goes away", async () => {
    await render();
    await act(async () => void conn().connect());
    act(() => root.unmount());
    expect(dropbox.signInCancel).toHaveBeenCalledTimes(1);
    root = createRoot(document.createElement("div"));
  });
});
