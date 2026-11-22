/** When a chapter version was kept, as the inspector shows it. */

const formats = new Map<string, Intl.DateTimeFormat>();

function format(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`;
  let formatter = formats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formats.set(key, formatter);
  }
  return formatter;
}

/** 24-hour clocks read best padded ("09:12"), 12-hour ones without ("9:12 AM"). */
function timeOptions(locale: string | undefined): Intl.DateTimeFormatOptions {
  const { hour12 } = format(locale, { hour: "numeric" }).resolvedOptions();
  return { hour: hour12 ? "numeric" : "2-digit", minute: "2-digit" };
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * "Today, 14:03", "Yesterday, 09:12", otherwise the day and time, such as
 * "21 Nov, 09:12", with the year only when it isn't the current one:
 * "21 Nov 2025, 09:12". Local time; the order of day, month and time follows
 * the locale (the system's when none is given).
 */
export function formatVersionTime(savedAt: number | Date, now: number | Date, locale?: string): string {
  const when = new Date(savedAt);
  const today = new Date(now);
  const time = timeOptions(locale);
  // Calendar days, not 24-hour spans, so the change to and from summer time doesn't matter.
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(when, today)) return `Today, ${format(locale, time).format(when)}`;
  if (sameDay(when, yesterday)) return `Yesterday, ${format(locale, time).format(when)}`;
  const year: Intl.DateTimeFormatOptions = when.getFullYear() === today.getFullYear() ? {} : { year: "numeric" };
  return format(locale, { day: "numeric", month: "short", ...year, ...time }).format(when);
}
