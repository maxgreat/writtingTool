import { describe, expect, it } from "vitest";
import { judgeSwipe, swipeDirection, swipeIntent, type SwipeIntent } from "../swipe";

// The tokens' values: --size-swipe-edge, --size-swipe-slop, --size-swipe-distance.
const EDGE = 24;
const T = { slop: 8, distance: 32 };
const WIDTH = 412;

const OPEN_BINDER: SwipeIntent = { action: "open", panel: "binder" };
const OPEN_INSPECTOR: SwipeIntent = { action: "open", panel: "inspector" };
const CLOSE_BINDER: SwipeIntent = { action: "close", panel: "binder" };
const CLOSE_INSPECTOR: SwipeIntent = { action: "close", panel: "inspector" };

describe("swipeIntent", () => {
  it("opens the binder from within the left edge, and the inspector from within the right edge", () => {
    expect(swipeIntent(0, WIDTH, null, EDGE)).toEqual(OPEN_BINDER);
    expect(swipeIntent(EDGE, WIDTH, null, EDGE)).toEqual(OPEN_BINDER);
    expect(swipeIntent(WIDTH - EDGE, WIDTH, null, EDGE)).toEqual(OPEN_INSPECTOR);
    expect(swipeIntent(WIDTH - 1, WIDTH, null, EDGE)).toEqual(OPEN_INSPECTOR);
  });

  it("ignores touches away from the edges when no panel is open", () => {
    expect(swipeIntent(EDGE + 1, WIDTH, null, EDGE)).toBeNull();
    expect(swipeIntent(WIDTH / 2, WIDTH, null, EDGE)).toBeNull();
    expect(swipeIntent(WIDTH - EDGE - 1, WIDTH, null, EDGE)).toBeNull();
  });

  it("lets any touch send an open panel back, wherever it starts", () => {
    expect(swipeIntent(WIDTH / 2, WIDTH, "binder", EDGE)).toEqual(CLOSE_BINDER);
    expect(swipeIntent(WIDTH - 1, WIDTH, "binder", EDGE)).toEqual(CLOSE_BINDER);
    expect(swipeIntent(0, WIDTH, "inspector", EDGE)).toEqual(CLOSE_INSPECTOR);
  });
});

describe("swipeDirection", () => {
  it("goes right to bring the binder in or send the inspector back, left for the opposite", () => {
    expect(swipeDirection(OPEN_BINDER)).toBe(1);
    expect(swipeDirection(CLOSE_INSPECTOR)).toBe(1);
    expect(swipeDirection(OPEN_INSPECTOR)).toBe(-1);
    expect(swipeDirection(CLOSE_BINDER)).toBe(-1);
  });
});

describe("judgeSwipe", () => {
  it("waits while the finger has moved less than the slop, whichever way", () => {
    expect(judgeSwipe(OPEN_BINDER, 0, 0, T)).toBe("wait");
    expect(judgeSwipe(OPEN_BINDER, 7, 7, T)).toBe("wait");
    expect(judgeSwipe(OPEN_BINDER, -7, 0, T)).toBe("wait");
    expect(judgeSwipe(OPEN_BINDER, 0, -7, T)).toBe("wait");
  });

  it("is a swipe once it has gone the distance, mostly along its direction", () => {
    expect(judgeSwipe(OPEN_BINDER, 32, 0, T)).toBe("swipe");
    expect(judgeSwipe(OPEN_BINDER, 40, 30, T)).toBe("swipe");
    expect(judgeSwipe(OPEN_INSPECTOR, -32, 5, T)).toBe("swipe");
    expect(judgeSwipe(CLOSE_BINDER, -60, -10, T)).toBe("swipe");
    expect(judgeSwipe(CLOSE_INSPECTOR, 33, 0, T)).toBe("swipe");
  });

  it("keeps waiting between the slop and the distance", () => {
    expect(judgeSwipe(OPEN_BINDER, 8, 0, T)).toBe("wait");
    expect(judgeSwipe(OPEN_BINDER, 31, 10, T)).toBe("wait");
  });

  it("leaves a mostly vertical move to the browser's scrolling", () => {
    expect(judgeSwipe(OPEN_BINDER, 2, 8, T)).toBe("abandon");
    expect(judgeSwipe(OPEN_BINDER, 20, 40, T)).toBe("abandon");
    expect(judgeSwipe(OPEN_BINDER, 3, -50, T)).toBe("abandon");
  });

  it("abandons a move at 45 degrees: it must be more along than across", () => {
    expect(judgeSwipe(OPEN_BINDER, 40, 40, T)).toBe("abandon");
    expect(judgeSwipe(OPEN_INSPECTOR, -40, -40, T)).toBe("abandon");
  });

  it("abandons a move the other way", () => {
    expect(judgeSwipe(OPEN_BINDER, -8, 0, T)).toBe("abandon");
    expect(judgeSwipe(OPEN_INSPECTOR, 40, 0, T)).toBe("abandon");
    expect(judgeSwipe(CLOSE_BINDER, 40, 0, T)).toBe("abandon");
    expect(judgeSwipe(CLOSE_INSPECTOR, -40, 0, T)).toBe("abandon");
  });
});
