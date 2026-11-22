import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, MARGIN_PRESETS, defaultSettingsFor, sanitizeSettings } from "../settings";

describe("view settings", () => {
  it("falls back to defaults for anything unreadable", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps numbers and rejects unknown choices field by field", () => {
    const s = sanitizeSettings({ fontSize: 99, lineSpacing: 3, font: "comic", marginLeft: -5, binderWidth: 300.6, mode: "plain" });
    expect(s.fontSize).toBe(28);
    expect(s.lineSpacing).toBe(DEFAULT_SETTINGS.lineSpacing);
    expect(s.font).toBe(DEFAULT_SETTINGS.font);
    expect(s.marginLeft).toBe(0);
    expect(s.binderWidth).toBe(301);
    expect(s.mode).toBe("plain");
  });

  it("starts phones with narrow margins", () => {
    expect(defaultSettingsFor(390).marginLeft).toBe(MARGIN_PRESETS.Narrow);
    expect(defaultSettingsFor(1280)).toEqual(DEFAULT_SETTINGS);
  });
});
