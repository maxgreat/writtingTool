// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidePanel, SwipeIntent } from "../swipe";
import { useEdgeSwipe } from "../useEdgeSwipe";

const WIDTH = 412;
const HOLD_MS = 300;

let container: HTMLDivElement;
let root: Root;
const onSwipe = vi.fn<(intent: SwipeIntent) => void>();

function Harness({ enabled, open }: { enabled: boolean; open: SidePanel | null }) {
  const area = useRef<HTMLDivElement>(null);
  useEdgeSwipe({ area, enabled, open, onSwipe });
  return createElement("div", { ref: area, id: "area" }, createElement("input", { id: "field" }));
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  onSwipe.mockReset();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: WIDTH });
  const tokens = document.documentElement.style;
  tokens.setProperty("--size-swipe-edge", "24px");
  tokens.setProperty("--size-swipe-slop", "8px");
  tokens.setProperty("--size-swipe-distance", "32px");
  tokens.setProperty("--duration-swipe-hold", `${HOLD_MS}ms`);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("style");
  vi.useRealTimers();
});

function render(enabled = true, open: SidePanel | null = null) {
  act(() => root.render(createElement(Harness, { enabled, open })));
}

type Options = { pointerType?: string; pointerId?: number; isPrimary?: boolean; target?: string };

function pointer(type: string, x: number, y: number, { pointerType = "touch", pointerId = 1, isPrimary = true, target = "area" }: Options = {}) {
  const el = document.getElementById(target)!;
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType, pointerId, isPrimary }));
}

/** A touch from (x0, y0) to (x1, y1) in a few moves. */
function drag(x0: number, y0: number, x1: number, y1: number, options: Options = {}) {
  pointer("pointerdown", x0, y0, options);
  for (let i = 1; i <= 4; i++) pointer("pointermove", x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * i) / 4, options);
  pointer("pointerup", x1, y1, options);
}

describe("useEdgeSwipe", () => {
  it("opens the binder on a swipe right from the left edge, once", () => {
    render();
    drag(4, 400, 120, 404);
    expect(onSwipe).toHaveBeenCalledTimes(1);
    expect(onSwipe).toHaveBeenCalledWith({ action: "open", panel: "binder" });
  });

  it("opens the inspector on a swipe left from the right edge", () => {
    render();
    drag(WIDTH - 3, 400, WIDTH - 120, 396);
    expect(onSwipe).toHaveBeenCalledWith({ action: "open", panel: "inspector" });
  });

  it("closes an open panel on a swipe towards its edge, from anywhere", () => {
    render(true, "binder");
    drag(250, 400, 100, 410);
    expect(onSwipe).toHaveBeenCalledWith({ action: "close", panel: "binder" });
    onSwipe.mockReset();
    render(true, "inspector");
    drag(150, 400, 300, 390);
    expect(onSwipe).toHaveBeenCalledWith({ action: "close", panel: "inspector" });
  });

  it("only listens to touch", () => {
    render();
    drag(4, 400, 120, 400, { pointerType: "mouse" });
    drag(4, 400, 120, 400, { pointerType: "pen" });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("does nothing outside the phone layout", () => {
    render(false);
    drag(4, 400, 120, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("leaves a vertical move alone, even if it turns sideways later", () => {
    render();
    pointer("pointerdown", 4, 400);
    pointer("pointermove", 6, 420);
    pointer("pointermove", 120, 420);
    pointer("pointerup", 120, 420);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("drops a touch the browser takes over", () => {
    render();
    pointer("pointerdown", 4, 400);
    pointer("pointermove", 10, 400);
    pointer("pointercancel", 10, 400);
    pointer("pointermove", 120, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("treats a finger that rests before moving as a long-press, not a swipe", () => {
    render();
    pointer("pointerdown", 4, 400);
    vi.advanceTimersByTime(HOLD_MS + 1);
    pointer("pointermove", 120, 400);
    pointer("pointerup", 120, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("still counts a slow swipe that started moving in time", () => {
    render();
    pointer("pointerdown", 4, 400);
    pointer("pointermove", 14, 400);
    vi.advanceTimersByTime(HOLD_MS * 3);
    pointer("pointermove", 60, 402);
    expect(onSwipe).toHaveBeenCalledWith({ action: "open", panel: "binder" });
  });

  it("drops the touch when the selection changes under it", () => {
    render();
    pointer("pointerdown", 4, 400);
    pointer("pointermove", 10, 400);
    document.dispatchEvent(new Event("selectionchange"));
    pointer("pointermove", 120, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("drops the touch when a second finger comes down", () => {
    render();
    pointer("pointerdown", 4, 400);
    pointer("pointerdown", 200, 500, { pointerId: 2, isPrimary: false });
    pointer("pointermove", 120, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("ignores touches that start on a text field", () => {
    render(true, "binder");
    drag(250, 400, 100, 400, { target: "field" });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("stops listening when it is turned off mid-touch", () => {
    render();
    pointer("pointerdown", 4, 400);
    render(false);
    pointer("pointermove", 120, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
