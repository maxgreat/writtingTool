import { useEffect, useRef, type RefObject } from "react";
import { tokenMs, tokenPx } from "./dom";
import { judgeSwipe, swipeIntent, type SidePanel, type SwipeIntent } from "./swipe";

export interface EdgeSwipeOptions {
  /**
   * Where swipes can start: the editor and the side panels with their scrim.
   * Its touch-action must leave sideways moves to the page (pan-y), or the
   * browser takes them over.
   */
  area: RefObject<HTMLElement | null>;
  /** The phone layout, outside focus mode. */
  enabled: boolean;
  /** The side panel open now, if any. */
  open: SidePanel | null;
  onSwipe(intent: SwipeIntent): void;
}

/** Touches on these are left alone: a sideways drag there moves through the text of the field. */
const FIELDS = "input, textarea, select";

/**
 * Edge swipes for the phone layout (see swipe.ts), from touch only. A touch
 * is dropped as soon as it can't be a swipe: a second finger, a move mostly
 * up or down (the browser scrolls it), a finger resting long enough to be a
 * long-press, or the selection changing under it. A swipe is reported once,
 * when it has gone far enough; the panel's own slide shows the result.
 */
export function useEdgeSwipe(options: EdgeSwipeOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const { area, enabled } = options;

  useEffect(() => {
    const el = area.current;
    if (!el || !enabled) return;

    let gesture: {
      pointerId: number;
      intent: SwipeIntent;
      x: number;
      y: number;
      moved: boolean;
      hold: ReturnType<typeof setTimeout>;
    } | null = null;

    const end = () => {
      if (!gesture) return;
      clearTimeout(gesture.hold);
      gesture = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.removeEventListener("selectionchange", end);
    };

    const onMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      const slop = tokenPx("--size-swipe-slop");
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= slop) gesture.moved = true;
      const verdict = judgeSwipe(gesture.intent, dx, dy, { slop, distance: tokenPx("--size-swipe-distance") });
      if (verdict === "wait") return;
      const { intent } = gesture;
      end();
      if (verdict === "swipe") latest.current.onSwipe(intent);
    };

    const onEnd = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.pointerId) end();
    };

    const onDown = (event: PointerEvent) => {
      if (gesture) {
        // A second finger: a pinch or a two-finger scroll, not a swipe.
        end();
        return;
      }
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      if (event.target instanceof Element && event.target.closest(FIELDS)) return;
      const intent = swipeIntent(event.clientX, window.innerWidth, latest.current.open, tokenPx("--size-swipe-edge"));
      if (!intent) return;
      const hold = setTimeout(() => {
        if (gesture && !gesture.moved) end();
      }, tokenMs("--duration-swipe-hold"));
      gesture = { pointerId: event.pointerId, intent, x: event.clientX, y: event.clientY, moved: false, hold };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd);
      window.addEventListener("pointercancel", onEnd);
      document.addEventListener("selectionchange", end);
    };

    el.addEventListener("pointerdown", onDown);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      end();
    };
  }, [area, enabled]);
}
