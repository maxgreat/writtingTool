// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeNear, revealIn } from "../dom";

// The tokens placeNear reads, with their values from tokens.css.
const GAP = 4; // --space-1
const EDGE = 8; // --space-2
const CONTROL = 28; // --size-control

let el: HTMLDivElement;
/** The height the popover would have with no cap, as a browser would lay it out. */
let natural: number;

function setWindow(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

/** Where the popover ends up: its top, its height once capped, and the cap. */
function box() {
  const top = Number.parseFloat(el.style.top);
  const cap = Number.parseFloat(el.style.maxHeight);
  return { top, height: Math.min(natural, cap), bottom: top + Math.min(natural, cap), cap, left: Number.parseFloat(el.style.left) };
}

/** A button-sized anchor at a given vertical position. */
function anchorAt(top: number, height = 40, left = 300) {
  return new DOMRect(left, top, 40, height);
}

beforeEach(() => {
  const root = document.documentElement.style;
  root.setProperty("--space-1", `${GAP}px`);
  root.setProperty("--space-2", `${EDGE}px`);
  root.setProperty("--size-control", `${CONTROL}px`);
  setWindow(360, 800);
  natural = 600;
  el = document.createElement("div");
  // Like a browser: the measured height honours the max-height in force.
  el.getBoundingClientRect = () => {
    const cap = el.style.maxHeight ? Number.parseFloat(el.style.maxHeight) : Number.POSITIVE_INFINITY;
    const top = Number.parseFloat(el.style.top) || 0;
    const height = Math.min(natural, cap);
    return new DOMRect(Number.parseFloat(el.style.left) || 0, top, 176, height);
  };
  document.body.append(el);
});

afterEach(() => {
  el.remove();
  document.documentElement.removeAttribute("style");
});

describe("placeNear", () => {
  it("puts the popover below its anchor when it fits there", () => {
    natural = 200;
    placeNear(el, anchorAt(100));
    expect(box().top).toBe(100 + 40 + GAP);
    expect(box().cap).toBe(800 - EDGE - (140 + GAP));
    expect(box().height).toBe(200);
  });

  it("puts it above when it only fits above", () => {
    natural = 300;
    placeNear(el, anchorAt(600));
    expect(box().top).toBe(600 - GAP - 300);
    expect(box().bottom).toBe(600 - GAP);
    expect(box().height).toBe(300);
  });

  it("caps a tall menu low in the window to the room above, so it scrolls instead of running off the bottom", () => {
    // The phone bug: a ⋯ menu taller than the room on either side of its button.
    natural = 603;
    placeNear(el, anchorAt(500));
    const { top, bottom, cap } = box();
    expect(top).toBe(EDGE);
    expect(cap).toBe(500 - GAP - EDGE);
    expect(bottom).toBeLessThanOrEqual(500 - GAP);
  });

  it("caps a tall menu high in the window to the room below", () => {
    natural = 603;
    placeNear(el, anchorAt(260));
    const { top, bottom, cap } = box();
    expect(top).toBe(300 + GAP);
    expect(cap).toBe(800 - EDGE - (300 + GAP));
    expect(bottom).toBe(800 - EDGE);
  });

  it("drops the previous cap before measuring again", () => {
    natural = 603;
    placeNear(el, anchorAt(500));
    expect(box().cap).toBe(500 - GAP - EDGE);
    // The anchor moved up (the binder scrolled): the whole menu fits below now.
    placeNear(el, anchorAt(40));
    expect(box().top).toBe(80 + GAP);
    expect(box().height).toBe(603);
    expect(box().cap).toBeGreaterThanOrEqual(603);
  });

  it("re-caps when the window gets shorter", () => {
    natural = 300;
    placeNear(el, anchorAt(100));
    expect(box().height).toBe(300);
    setWindow(360, 320);
    placeNear(el, anchorAt(100));
    const { top, bottom } = box();
    expect(top).toBe(140 + GAP);
    expect(bottom).toBe(320 - EDGE);
  });

  it("keeps the popover's own scroll position when it is placed again", () => {
    natural = 603;
    placeNear(el, anchorAt(500));
    el.scrollTop = 120;
    placeNear(el, anchorAt(500));
    expect(el.scrollTop).toBe(120);
  });

  it("stays inside the window when the anchor has scrolled out of it", () => {
    natural = 400;
    placeNear(el, anchorAt(-200));
    expect(box().top).toBe(EDGE);
    expect(box().bottom).toBeLessThanOrEqual(800 - EDGE);

    placeNear(el, anchorAt(1000));
    expect(box().top).toBeGreaterThanOrEqual(EDGE);
    expect(box().bottom).toBe(800 - EDGE);
  });

  it("covers an anchor that leaves no room on either side", () => {
    natural = 400;
    placeNear(el, anchorAt(EDGE, 800 - 2 * EDGE));
    expect(box().top).toBe(EDGE);
    expect(box().cap).toBe(800 - 2 * EDGE);
    expect(box().height).toBe(400);
  });

  it("keeps the left edge inside the window", () => {
    natural = 100;
    placeNear(el, anchorAt(100, 40, 340));
    expect(box().left).toBe(360 - 176 - EDGE);
    placeNear(el, anchorAt(100, 40, -20));
    expect(box().left).toBe(EDGE);
  });

  it("never lets any popover cross the window's top or bottom edge", () => {
    for (const height of [100, 300, 600, 784, 1200]) {
      for (let y = -100; y <= 900; y += 25) {
        natural = height;
        placeNear(el, anchorAt(y));
        const { top, bottom } = box();
        expect(top, `height ${height}, anchor at ${y}`).toBeGreaterThanOrEqual(EDGE);
        expect(bottom, `height ${height}, anchor at ${y}`).toBeLessThanOrEqual(800 - EDGE);
        expect(bottom - top, `height ${height}, anchor at ${y}`).toBeGreaterThanOrEqual(Math.min(height, CONTROL));
      }
    }
  });
});

describe("revealIn", () => {
  const PAD = 4;
  let item: HTMLDivElement;
  let itemTop: number;

  beforeEach(() => {
    el.style.padding = `${PAD}px`;
    el.getBoundingClientRect = () => new DOMRect(0, 100, 176, 200);
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
    item = document.createElement("div");
    // The item's place in the menu's content, moved up by the menu's scroll.
    item.getBoundingClientRect = () => new DOMRect(0, 100 + itemTop - el.scrollTop, 176, 40);
    el.append(item);
  });

  it("scrolls down just enough to show an item below the visible part", () => {
    itemTop = 400;
    revealIn(el, item);
    expect(el.scrollTop).toBe(400 + 40 - (200 - PAD));
  });

  it("scrolls up to the top for the first item", () => {
    el.scrollTop = 300;
    itemTop = PAD;
    revealIn(el, item);
    expect(el.scrollTop).toBe(0);
  });

  it("leaves the scroll alone when the item is already in view", () => {
    el.scrollTop = 50;
    itemTop = 120;
    revealIn(el, item);
    expect(el.scrollTop).toBe(50);
  });
});
