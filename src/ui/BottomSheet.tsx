import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { Sheet } from "../core/project";
import { cx } from "./dom";
import { SheetView } from "./SheetView";

/**
 * Phones: a tapped name opens its sheet in a half-height sheet from the
 * bottom. It stays mounted while closed so it can slide away.
 */
export function BottomSheet({ sheet, open, onClose }: { sheet: Sheet | null; open: boolean; onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (!open) return;
    close.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  return (
    <>
      <button
        type="button"
        className={cx("scrim", open && "is-open")}
        aria-label="Close sheet"
        tabIndex={-1}
        onClick={onClose}
        inert={!open}
      />
      <div
        className={cx("bottom-sheet", open && "is-open")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        inert={!open}
      >
        {sheet && (
          <SheetView
            key={sheet.id}
            sheet={sheet}
            headingId={headingId}
            actions={
              <button ref={close} type="button" className="btn btn--icon" aria-label="Close" onClick={onClose}>
                <X aria-hidden />
              </button>
            }
          />
        )}
      </div>
    </>
  );
}
