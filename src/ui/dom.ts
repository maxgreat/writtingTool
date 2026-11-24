/** Small helpers shared by the components: tokens, shortcuts and number formats. */

/** A length token from tokens.css, in CSS pixels. */
export function tokenPx(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return value.endsWith("rem") ? number * Number.parseFloat(getComputedStyle(document.documentElement).fontSize) : number;
}

/** A duration token from tokens.css, in milliseconds. */
export function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return value.endsWith("ms") ? number : number * 1000;
}

/**
 * Puts a fixed-position element next to a rectangle and keeps all of it
 * inside the window: below the rectangle when it fits, else above when it
 * fits, else on the side with more room, its max-height capped to that room
 * so it scrolls inside. When neither side has room for one control (the
 * rectangle fills the window), it covers the rectangle instead.
 *
 * Safe to call again on resize or scroll: it drops the previous cap before
 * measuring, and keeps the element's own scroll position.
 */
export function placeNear(el: HTMLElement, rect: DOMRect): void {
  const gap = tokenPx("--space-1");
  const edge = tokenPx("--space-2");
  const view = window.innerHeight;
  const scrolled = el.scrollTop;
  el.style.maxHeight = "";
  const { width, height } = el.getBoundingClientRect();

  const below = view - edge - (rect.bottom + gap);
  const above = rect.top - gap - edge;
  let top: number;
  let room: number;
  if (height <= below) {
    top = rect.bottom + gap;
    room = below;
  } else if (height <= above) {
    top = rect.top - gap - height;
    room = above;
  } else if (Math.max(below, above) < tokenPx("--size-control")) {
    top = edge;
    room = view - 2 * edge;
  } else if (below >= above) {
    top = rect.bottom + gap;
    room = below;
  } else {
    top = edge;
    room = above;
  }

  // An anchor scrolled partly out of the window can leave more room than the window has.
  room = Math.max(0, Math.min(room, view - 2 * edge));
  top = Math.max(edge, Math.min(top, view - edge - Math.min(height, room)));
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge))}px`;
  el.style.maxHeight = `${Math.max(0, Math.min(room, view - edge - top))}px`;
  if (scrolled > 0) el.scrollTop = scrolled;
}

/**
 * Scrolls a scrolling box just enough to show one of its items, padding
 * included, without scrolling anything around the box.
 */
export function revealIn(box: HTMLElement, item: HTMLElement): void {
  const outer = box.getBoundingClientRect();
  const inner = item.getBoundingClientRect();
  const style = getComputedStyle(box);
  const top = outer.top + box.clientTop + (Number.parseFloat(style.paddingTop) || 0);
  const bottom = outer.top + box.clientTop + box.clientHeight - (Number.parseFloat(style.paddingBottom) || 0);
  if (inner.top < top) box.scrollTop -= top - inner.top;
  else if (inner.bottom > bottom) box.scrollTop += inner.bottom - bottom;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);

/** "Ctrl+Alt+B" on Linux and Windows, "⌘⌥B" on Apple systems. */
export function shortcut(...keys: ("mod" | "alt" | "shift" | string)[]): string {
  const names = keys.map((key) => {
    if (key === "mod") return isMac ? "⌘" : "Ctrl";
    if (key === "alt") return isMac ? "⌥" : "Alt";
    if (key === "shift") return isMac ? "⇧" : "Shift";
    return key;
  });
  return isMac ? names.join("") : names.join("+");
}

/** The Ctrl key on Linux and Windows, Cmd on Apple systems. */
export function hasMod(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

const numberFormat = new Intl.NumberFormat();

export function formatCount(n: number): string {
  return numberFormat.format(n);
}

/** "+35", "−12" (with a true minus sign) or "0". */
export function formatSigned(n: number): string {
  if (n > 0) return `+${numberFormat.format(n)}`;
  if (n < 0) return `−${numberFormat.format(-n)}`;
  return "0";
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "en-GB" becomes "British English"; unknown codes are shown as they are. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Focus went with a button that was removed or disabled: nothing has it now, so it can be put somewhere useful. */
export function focusLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
