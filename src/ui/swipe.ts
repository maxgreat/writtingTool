/**
 * Edge swipes on phones, as pure functions (useEdgeSwipe.ts listens to the
 * touches). A swipe from the left edge slides the binder in, one from the
 * right edge the inspector; a swipe on an open panel towards its edge sends
 * it back.
 */

export type SidePanel = "binder" | "inspector";

/** What a swipe would do. */
export interface SwipeIntent {
  action: "open" | "close";
  panel: SidePanel;
}

export interface SwipeThresholds {
  /** Below this movement a touch is not judged yet: it may still be a tap or a long-press. */
  slop: number;
  /** How far a swipe travels, along its direction, to count. */
  distance: number;
}

export type SwipeVerdict = "wait" | "swipe" | "abandon";

/**
 * What a touch starting `x` pixels from the window's left edge could do, or
 * null if it can't be a swipe. With no panel open, only touches within
 * `edge` of the left or right edge count. With a panel open, the panel and
 * the scrim cover the window, so any touch can send the panel back.
 */
export function swipeIntent(x: number, width: number, open: SidePanel | null, edge: number): SwipeIntent | null {
  if (open) return { action: "close", panel: open };
  if (x <= edge) return { action: "open", panel: "binder" };
  if (x >= width - edge) return { action: "open", panel: "inspector" };
  return null;
}

/** 1 when the swipe goes right (the binder coming in, the inspector going back), -1 when it goes left. */
export function swipeDirection(intent: SwipeIntent): 1 | -1 {
  return (intent.panel === "binder") === (intent.action === "open") ? 1 : -1;
}

/**
 * Judges a touch that moved `dx`, `dy` from where it started. Once it has
 * moved past the slop it must go mostly along the swipe's direction, or it
 * is a scroll, a selection or a swipe the other way: it is abandoned for
 * good, and the browser keeps it. It is a swipe once it has gone `distance`
 * along, still more along than across.
 */
export function judgeSwipe(intent: SwipeIntent, dx: number, dy: number, thresholds: SwipeThresholds): SwipeVerdict {
  const along = dx * swipeDirection(intent);
  const across = Math.abs(dy);
  if (Math.max(Math.abs(dx), across) < thresholds.slop) return "wait";
  if (along <= across) return "abandon";
  return along >= thresholds.distance ? "swipe" : "wait";
}
