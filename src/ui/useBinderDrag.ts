import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { BinderItem } from "../core/project";
import { dropMove, findDrop, type DragItem, type DropMark, type Move, type RowBox } from "./binderModel";
import { tokenPx } from "./dom";

/** Near the top or bottom edge of the scrolling panel, the list scrolls by up to this much per frame. */
const AUTOSCROLL_MAX_PX = 12;

/** A drag under way: what is dragged, and where it would land (null: nowhere, or where it already is). */
export interface BinderDrag {
  item: DragItem;
  mark: DropMark | null;
}

export interface BinderDragOptions {
  binder: BinderItem[];
  /** False while the binder is busy or a title is being typed: no drag starts. */
  enabled: boolean;
  /**
   * The manuscript list. Its rows carry `data-drag-row` ("chapter", "part"
   * or "empty"), `data-drag-id`, `data-drag-part` and, on part rows,
   * `data-drag-open`; marks are in its coordinates.
   */
  container: RefObject<HTMLElement | null>;
  onDrop(item: DragItem, move: Move): void;
}

interface Session {
  item: DragItem;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  /** Escape was pressed: nothing lands, but the press still ends the drag. */
  cancelled: boolean;
  move: Move | null;
  /** The mark on screen, as a string, so an unchanged one doesn't render again. */
  shown: string | null;
  scroller: HTMLElement | null;
  frame: number;
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** Reads the rows of the list as laid out now. Rows in folded parts have no height and are left out. */
function measureRows(container: HTMLElement): { origin: DOMRect; rows: RowBox[] } {
  const origin = container.getBoundingClientRect();
  const rows: RowBox[] = [];
  for (const el of container.querySelectorAll<HTMLElement>("[data-drag-row]")) {
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) continue;
    const { dragRow, dragId, dragPart, dragOpen } = el.dataset;
    rows.push({
      type: dragRow as RowBox["type"],
      id: dragId ?? "",
      partId: dragPart || null,
      top: rect.top - origin.top,
      bottom: rect.bottom - origin.top,
      open: dragOpen === "true",
    });
  }
  return { origin, rows };
}

/**
 * Drag to reorder the binder with a mouse or pen. A drag starts once the
 * pointer has moved a few pixels with the button held, so a click stays a
 * click; Escape cancels it, and the click that ends a drag is swallowed.
 * Touch has no drag: the row menu's Move up, Move down and Move to do it.
 */
export function useBinderDrag(options: BinderDragOptions) {
  const [drag, setDrag] = useState<BinderDrag | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, item: DragItem) => {
    if (event.button !== 0 || event.pointerType === "touch" || !latest.current.enabled || stop.current) return;
    if ((event.target as Element).closest("[data-no-drag]")) return;

    const s: Session = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      cancelled: false,
      move: null,
      shown: null,
      scroller: null,
      frame: 0,
    };

    /** Works out where the item would land with the pointer where it is now. */
    const update = () => {
      const container = latest.current.container.current;
      if (!container) return;
      const { origin, rows } = measureRows(container);
      // A little room above and below the list still counts, so its first and last gaps are easy to reach.
      const slack = tokenPx("--space-5");
      const inside =
        s.x >= origin.left && s.x <= origin.right && s.y >= origin.top - slack && s.y <= origin.bottom + slack;
      const found = inside ? findDrop(latest.current.binder, rows, s.item, s.y - origin.top) : null;
      s.move = found ? dropMove(latest.current.binder, s.item, found.drop) : null;
      const mark = found && s.move ? found.mark : null;
      const shown = JSON.stringify(mark);
      if (shown === s.shown) return;
      s.shown = shown;
      setDrag({ item: s.item, mark });
    };

    const tick = () => {
      s.frame = 0;
      const scroller = s.scroller;
      if (!s.started || s.cancelled || !scroller) return;
      const box = scroller.getBoundingClientRect();
      const zone = tokenPx("--size-control");
      const depth = s.y < box.top + zone ? s.y - (box.top + zone) : s.y > box.bottom - zone ? s.y - (box.bottom - zone) : 0;
      if (depth === 0) return;
      const step = Math.sign(depth) * Math.ceil(Math.min(1, Math.abs(depth) / zone) * AUTOSCROLL_MAX_PX);
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop === before) return;
      update();
      s.frame = requestAnimationFrame(tick);
    };

    const swallowClick = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== s.pointerId || s.cancelled) return;
      s.x = move.clientX;
      s.y = move.clientY;
      if (!s.started) {
        if (Math.hypot(s.x - s.startX, s.y - s.startY) < tokenPx("--size-drag-threshold")) return;
        s.started = true;
        s.scroller = scrollParent(latest.current.container.current);
        window.addEventListener("click", swallowClick, true);
      }
      move.preventDefault();
      update();
      if (!s.frame) s.frame = requestAnimationFrame(tick);
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onCancel);
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
      // The click that follows this release (if any) comes before the timer.
      if (s.started) setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
      stop.current = null;
      setDrag(null);
    };

    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== s.pointerId) return;
      finish();
      if (s.started && !s.cancelled && s.move) latest.current.onDrop(s.item, s.move);
    };

    const onCancel = () => {
      s.cancelled = true;
      finish();
    };

    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !s.started || s.cancelled) return;
      // Handled here, so the phone layout or focus mode doesn't also react.
      key.preventDefault();
      key.stopPropagation();
      s.cancelled = true;
      s.move = null;
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
      setDrag(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onCancel);
    stop.current = finish;
  }, []);

  return { drag, onPointerDown };
}
