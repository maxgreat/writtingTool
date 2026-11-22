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
 * Puts a fixed-position element just below a rectangle, or above it when
 * there is no room below, and keeps it inside the window.
 */
export function placeNear(el: HTMLElement, rect: DOMRect): void {
  const gap = tokenPx("--space-1");
  const edge = tokenPx("--space-2");
  const { width, height } = el.getBoundingClientRect();
  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - edge && rect.top - gap - height >= edge) top = rect.top - gap - height;
  el.style.top = `${Math.max(edge, top)}px`;
  el.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge))}px`;
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
