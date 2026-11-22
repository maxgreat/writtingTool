import { describe, expect, it } from "vitest";
import { formatVersionTime } from "../versionTime";

// Dates are built in local time, so the tests pass in any time zone.
const now = new Date(2026, 10, 22, 16, 30);

/** Some locales put a narrow no-break space before AM and PM. */
const spaced = (text: string) => text.replace(/\s/gu, " ");

describe("formatVersionTime", () => {
  it("says Today for a version kept earlier today", () => {
    expect(formatVersionTime(new Date(2026, 10, 22, 14, 3), now, "en-GB")).toBe("Today, 14:03");
    expect(formatVersionTime(new Date(2026, 10, 22, 0, 0), now, "en-GB")).toBe("Today, 00:00");
  });

  it("says Yesterday for the day before, by the calendar", () => {
    expect(formatVersionTime(new Date(2026, 10, 21, 9, 12), now, "en-GB")).toBe("Yesterday, 09:12");
    expect(formatVersionTime(new Date(2026, 10, 21, 23, 59), new Date(2026, 10, 22, 0, 1), "en-GB")).toBe(
      "Yesterday, 23:59",
    );
    expect(formatVersionTime(new Date(2025, 11, 31, 22, 0), new Date(2026, 0, 1, 8, 0), "en-GB")).toBe(
      "Yesterday, 22:00",
    );
  });

  it("gives the day for older versions, and the year only when it isn't this one", () => {
    expect(formatVersionTime(new Date(2026, 10, 20, 9, 12), now, "en-GB")).toBe("20 Nov, 09:12");
    expect(formatVersionTime(new Date(2026, 0, 2, 18, 45), now, "en-GB")).toBe("2 Jan, 18:45");
    expect(formatVersionTime(new Date(2025, 10, 21, 9, 12), now, "en-GB")).toBe("21 Nov 2025, 09:12");
  });

  it("follows the locale's clock and date order", () => {
    expect(spaced(formatVersionTime(new Date(2026, 10, 22, 14, 3), now, "en-US"))).toBe("Today, 2:03 PM");
    expect(spaced(formatVersionTime(new Date(2026, 10, 20, 9, 12), now, "en-US"))).toBe("Nov 20, 9:12 AM");
  });

  it("takes milliseconds since 1970, as versions store them", () => {
    const savedAt = new Date(2026, 10, 22, 14, 3).getTime();
    expect(formatVersionTime(savedAt, now.getTime(), "en-GB")).toBe("Today, 14:03");
  });
});
