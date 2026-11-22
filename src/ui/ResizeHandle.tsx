import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { PANEL_WIDTH } from "../core/settings";
import { cx, tokenPx } from "./dom";

interface ResizeHandleProps {
  /** Which panel: the binder grows to the right, the inspector to the left. */
  panel: "binder" | "inspector";
  width: number;
  label: string;
  /** Live width while dragging; null when the drag ends. */
  onDrag(width: number | null): void;
  /** The width to keep. */
  onCommit(width: number): void;
}

/**
 * The inner edge of a side panel: drag it, or focus it and use the arrow
 * keys, to change the panel's width.
 */
export function ResizeHandle({ panel, width, label, onDrag, onCommit }: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; last: number; max: number } | null>(null);
  const direction = panel === "binder" ? 1 : -1;

  // The panel never takes more than its share of the window (--panel-max-share).
  const maxWidth = (handle: HTMLElement) => {
    const max = Number.parseFloat(getComputedStyle(handle.parentElement!).maxWidth);
    return Number.isFinite(max) ? Math.min(PANEL_WIDTH.max, max) : PANEL_WIDTH.max;
  };
  const clamp = (value: number, max: number) =>
    Math.round(Math.min(Math.max(PANEL_WIDTH.min, max), Math.max(PANEL_WIDTH.min, value)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const max = maxWidth(event.currentTarget);
    const startWidth = Math.min(width, max);
    drag.current = { startX: event.clientX, startWidth, last: startWidth, max };
    onDrag(startWidth);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = clamp(d.startWidth + direction * (event.clientX - d.startX), d.max);
    onDrag(d.last);
  };

  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    onDrag(null);
    onCommit(d.last);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = tokenPx("--space-4");
    let delta = 0;
    if (event.key === "ArrowRight") delta = step * direction;
    else if (event.key === "ArrowLeft") delta = -step * direction;
    else return;
    event.preventDefault();
    onCommit(clamp(Math.min(width, maxWidth(event.currentTarget)) + delta, maxWidth(event.currentTarget)));
  };

  return (
    <div
      className={cx("resize-handle", `resize-handle--${panel}`)}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PANEL_WIDTH.min}
      aria-valuemax={PANEL_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    />
  );
}
