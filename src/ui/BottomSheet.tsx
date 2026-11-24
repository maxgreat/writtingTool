import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IgnoredName } from "../core/names";
import type { Sheet } from "../core/project";
import type { AppearancesSource } from "./AppearsIn";
import { cx } from "./dom";
import type { IgnoreSource } from "./IgnoreHere";
import { SheetView } from "./SheetView";

export interface BottomSheetProps {
  open: boolean;
  onClose(): void;
  /** The id of the sheet's heading. */
  labelledBy: string;
  /** What the scrim says to screen readers, which can't press it. */
  closeLabel: string;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Opened from a side panel: the sheet and its scrim go above the panel. */
  overPanels?: boolean;
}

/**
 * Phones: a modal sheet that slides up from the bottom, over a scrim. On
 * opening, focus goes to the element marked `data-autofocus` inside it (or
 * the sheet itself); Escape and a tap on the scrim close it. It stays
 * mounted while closed so it can slide away. It lives in a portal, so a
 * sheet opened from a side panel isn't held inside the panel.
 */
export function BottomSheet({ open, onClose, labelledBy, closeLabel, children, id, className, overPanels }: BottomSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const sheet = ref.current;
    (sheet?.querySelector<HTMLElement>("[data-autofocus]") ?? sheet)?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return createPortal(
    <>
      <button
        type="button"
        className={cx("scrim", open && "is-open", overPanels && "is-over-panels")}
        aria-label={closeLabel}
        tabIndex={-1}
        onClick={() => close.current()}
        inert={!open}
      />
      <div
        ref={ref}
        id={id}
        className={cx("bottom-sheet", open && "is-open", overPanels && "is-over-panels", className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        inert={!open}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

export interface SheetPreviewProps {
  sheet: Sheet | null;
  open: boolean;
  onClose(): void;
  /** For the sheet's Appears in list. A tapped chapter closes the preview before it is opened. */
  appearances: AppearancesSource;
  /**
   * Edit: the sheet's form, in the inspector (the preview itself stays
   * read-only). Not offered for a sheet whose header can't be read.
   */
  onEdit(id: string): void;
  /** The name tapped in the text, shown under the sheet's name with Ignore here. */
  occurrence?: IgnoredName;
  /** For Ignore here and the sheet's ignored mentions. */
  ignoring: IgnoreSource;
  /** Goes up each time a name is tapped: what the preview showed for an earlier tap is put away. */
  opening?: number;
}

/** Phones: a tapped name opens its sheet in a half-height sheet from the bottom. */
export function SheetPreview({
  sheet,
  open,
  onClose,
  appearances,
  onEdit,
  occurrence,
  ignoring,
  opening = 0,
}: SheetPreviewProps) {
  const headingId = useId();
  const source: AppearancesSource = {
    ...appearances,
    onOpenChapter: (id) => {
      onClose();
      appearances.onOpenChapter(id);
    },
  };
  return (
    <BottomSheet open={open} onClose={onClose} labelledBy={headingId} closeLabel="Close sheet">
      {sheet && (
        <SheetView
          key={`${sheet.id}\n${opening}`}
          sheet={sheet}
          headingId={headingId}
          appearances={source}
          occurrence={occurrence}
          ignoring={ignoring}
          actions={
            <div className="sheet-actions">
              {sheet.editable && (
                <button type="button" className="btn btn--quiet" onClick={() => onEdit(sheet.id)}>
                  Edit
                </button>
              )}
              <button type="button" className="btn btn--icon" aria-label="Close" data-autofocus onClick={onClose}>
                <X aria-hidden />
              </button>
            </div>
          }
        />
      )}
    </BottomSheet>
  );
}
