import { Check, ChevronDown } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { BackLayer } from "./BackStack";
import { cx, placeNear, revealIn } from "./dom";

export type CloseReason = "outside" | "escape" | "select";

interface PopoverProps {
  /** The element or screen rectangle the popover hangs from. */
  anchor: RefObject<HTMLElement | null> | DOMRect;
  onClose(reason: CloseReason): void;
  children: ReactNode;
  role: "menu" | "dialog";
  label: string;
  id?: string;
  className?: string;
  /** Moves focus to the first item when the popover opens. */
  autoFocus?: boolean;
  /** Presses here don't count as outside: usually the trigger, which toggles. */
  ignore?: RefObject<HTMLElement | null>;
  /** Something chosen here is being done: its items wait (aria-busy). */
  busy?: boolean;
  /** The id of text inside that says more than the label, read as the popover's description. */
  describedBy?: string;
}

const ITEMS = '[role^="menuitem"]:not(:disabled)';
const FOCUSABLE = `${ITEMS}, input:not(:disabled), button:not(:disabled)`;

/**
 * A floating panel in a portal, so a scrolling toolbar can't clip it. It sits
 * below its anchor (above when there is no room), stays inside the window,
 * scrolls when it is taller than the room it has, and closes on Escape, a
 * phone's Back or a press outside.
 */
export function Popover({
  anchor,
  onClose,
  children,
  role,
  label,
  id,
  className,
  autoFocus,
  ignore,
  busy,
  describedBy,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const place = useCallback(() => {
    const el = ref.current;
    const a = anchorRef.current;
    const rect = a instanceof DOMRect ? a : a.current?.getBoundingClientRect();
    if (el && rect) placeNear(el, rect);
  }, []);

  useLayoutEffect(place);

  useEffect(() => {
    // Scrolling the popover itself doesn't move its anchor.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      place();
    };
    // An anchor that slides in (the bar, in focus mode) is followed once it has settled.
    const onTransitionEnd = (event: TransitionEvent) => {
      const a = anchorRef.current;
      const el = a instanceof DOMRect ? null : a.current;
      if (el && event.target instanceof Node && event.target.contains(el)) place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("transitionend", onTransitionEnd, true);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || ignore?.current?.contains(target)) return;
      close.current("outside");
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current("escape");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("transitionend", onTransitionEnd, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [place, ignore]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(`[aria-checked="true"]:not(:disabled), ${FOCUSABLE}`);
    (first ?? el).focus({ preventScroll: true });
    if (first) revealIn(el, first);
  }, [autoFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (role !== "menu" || !ref.current) return;
    if (event.key === "Tab") {
      close.current("outside");
      return;
    }
    const items = [...ref.current.querySelectorAll<HTMLElement>(ITEMS)];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === -1) return;
    event.preventDefault();
    // Scroll only the menu, when it is taller than its room, never the page.
    items[next].focus({ preventScroll: true });
    revealIn(ref.current, items[next]);
  };

  // Focus moving to something outside (Tab out of a dialog) closes it too.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && !ref.current?.contains(next) && !ignore?.current?.contains(next)) close.current("outside");
  };

  // A phone's Back closes it as Escape does.
  return createPortal(
    <BackLayer open onBack={() => close.current("escape")}>
      <div
        ref={ref}
        id={id}
        role={role}
        aria-label={label}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={cx("popover", className)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        {children}
      </div>
    </BackLayer>,
    document.body,
  );
}

interface MenuButtonProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** What the trigger shows; a chevron is added, unless `chevron` is false. */
  children: ReactNode;
  menu: ReactNode;
  menuLabel: string;
  role?: "menu" | "dialog";
  title?: string;
  ariaLabel?: string;
  /** The id of what the trigger acts on, for screen readers: a row's name, say. */
  describedBy?: string;
  disabled?: boolean;
  className?: string;
  popoverClassName?: string;
  /** False for a trigger whose icon already says it opens a menu. */
  chevron?: boolean;
  /** The trigger, for something else to hang from it once the menu has closed. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** A trigger button and the menu or small dialog it opens. */
export function MenuButton({
  open,
  onOpenChange,
  children,
  menu,
  menuLabel,
  role = "menu",
  title,
  ariaLabel,
  describedBy,
  disabled,
  className,
  popoverClassName,
  chevron = true,
  triggerRef,
}: MenuButtonProps) {
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? ownTrigger;
  const id = useId();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={cx("btn", className)}
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        title={title}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {children}
        {chevron && <ChevronDown className="chevron" aria-hidden />}
      </button>
      {open && (
        <Popover
          anchor={trigger}
          ignore={trigger}
          id={id}
          role={role}
          label={menuLabel}
          className={popoverClassName}
          autoFocus
          onClose={(reason) => {
            onOpenChange(false);
            if (reason === "escape") trigger.current?.focus();
          }}
        >
          {menu}
        </Popover>
      )}
    </>
  );
}

interface MenuItemProps {
  /** Radio items show a check when chosen; leave undefined for an action. */
  checked?: boolean;
  onSelect(): void;
  children: ReactNode;
  hint?: string;
  disabled?: boolean;
  className?: string;
  /** Leaves out the check column, for menus that only hold actions. */
  noCheck?: boolean;
}

export function MenuItem({ checked, onSelect, children, hint, disabled, className, noCheck }: MenuItemProps) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={cx("menu-item", className)}
      disabled={disabled}
      onClick={onSelect}
    >
      {!noCheck && (
        <span className="check-slot" aria-hidden>
          {checked && <Check className="check" />}
        </span>
      )}
      <span className="menu-item-label">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}
