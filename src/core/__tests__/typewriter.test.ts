// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { centerCaret } from "../editor/typewriter";

function scroller(top: number, height: number, scrollTop: number): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => new DOMRect(0, top, 600, height);
  el.scrollTop = scrollTop;
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true });
  return el;
}

describe("typewriter scrolling", () => {
  it("scrolls so the caret's line sits in the middle", () => {
    const el = scroller(100, 800, 1000);
    // The middle is at 500; a caret line at 880–900 is 390 px below it.
    centerCaret(el, 880, 900);
    expect(el.scrollTop).toBe(1390);
    centerCaret(el, 100, 120);
    expect(el.scrollTop).toBe(1000);
  });

  it("leaves small moves alone, so typing along a line doesn't jitter", () => {
    const el = scroller(0, 800, 200);
    centerCaret(el, 392, 410);
    expect(el.scrollTop).toBe(200);
  });
});
