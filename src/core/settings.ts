import { useCallback, useState } from "react";

/**
 * How the text looks on this device. None of it touches the chapter files: a
 * phone and a large monitor need different sizes and margins.
 */
export type WritingFont = "serif" | "sans" | "mono";
export type EditorMode = "formatted" | "plain";
export type LineSpacing = 1.2 | 1.5 | 2;

/**
 * Where grammar is checked besides on this device: nowhere (English is
 * checked offline by Harper), or a LanguageTool server the writer chose,
 * which the paragraphs checked are sent to.
 */
export type LanguageToolMode = "off" | "public" | "premium" | "own";

export interface LanguageToolSettings {
  mode: LanguageToolMode;
  /** The writer's own server ("own"), such as http://localhost:8081. */
  url: string;
  /** A premium account ("premium"). */
  username: string;
  apiKey: string;
}

export interface ViewSettings {
  /** Text size on screen, in points. */
  fontSize: number;
  font: WritingFont;
  lineSpacing: LineSpacing;
  /** Margins of the text column, as a percentage of the editor's width. */
  marginLeft: number;
  marginRight: number;
  mode: EditorMode;
  binderOpen: boolean;
  inspectorOpen: boolean;
  /** Panel widths in CSS pixels. */
  binderWidth: number;
  inspectorWidth: number;
  /** Mark grammar problems. */
  grammar: boolean;
  languageTool: LanguageToolSettings;
}

export const FONT_SIZE = { min: 12, max: 28 } as const;
export const MARGIN = { min: 0, max: 35 } as const;
export const PANEL_WIDTH = { min: 180, max: 480 } as const;
export const LINE_SPACINGS: LineSpacing[] = [1.2, 1.5, 2];
export const MARGIN_PRESETS = { Narrow: 4, Medium: 12, Wide: 22 } as const;

export const DEFAULT_SETTINGS: ViewSettings = {
  fontSize: 16,
  font: "serif",
  lineSpacing: 1.5,
  marginLeft: MARGIN_PRESETS.Medium,
  marginRight: MARGIN_PRESETS.Medium,
  mode: "formatted",
  binderOpen: true,
  inspectorOpen: true,
  binderWidth: 260,
  inspectorWidth: 300,
  grammar: true,
  languageTool: { mode: "off", url: "", username: "", apiKey: "" },
};

const STORAGE_KEY = "writingTool.viewSettings.v1";

function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(range.max, Math.max(range.min, Math.round(value)))
    : fallback;
}

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Turns whatever was stored into valid settings, field by field. */
export function sanitizeSettings(raw: unknown): ViewSettings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    fontSize: clamp(s.fontSize, FONT_SIZE, d.fontSize),
    font: oneOf(s.font, ["serif", "sans", "mono"] as const, d.font),
    lineSpacing: oneOf(s.lineSpacing, LINE_SPACINGS, d.lineSpacing),
    marginLeft: clamp(s.marginLeft, MARGIN, d.marginLeft),
    marginRight: clamp(s.marginRight, MARGIN, d.marginRight),
    mode: oneOf(s.mode, ["formatted", "plain"] as const, d.mode),
    binderOpen: typeof s.binderOpen === "boolean" ? s.binderOpen : d.binderOpen,
    inspectorOpen: typeof s.inspectorOpen === "boolean" ? s.inspectorOpen : d.inspectorOpen,
    binderWidth: clamp(s.binderWidth, PANEL_WIDTH, d.binderWidth),
    inspectorWidth: clamp(s.inspectorWidth, PANEL_WIDTH, d.inspectorWidth),
    grammar: typeof s.grammar === "boolean" ? s.grammar : d.grammar,
    languageTool: sanitizeLanguageTool(s.languageTool),
  };
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

function sanitizeLanguageTool(raw: unknown): LanguageToolSettings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    mode: oneOf(s.mode, ["off", "public", "premium", "own"] as const, "off"),
    url: text(s.url, 500),
    username: text(s.username, 200),
    apiKey: text(s.apiKey, 200),
  };
}

/**
 * Below this width the editor fills the screen and the panels become
 * overlays. Keep in step with PHONE_QUERY in src/ui/hooks.ts.
 */
export const PHONE_MAX_WIDTH = 700;

/** First-run settings: phones start with narrow margins so lines aren't a few words long. */
export function defaultSettingsFor(viewportWidth: number): ViewSettings {
  return viewportWidth < PHONE_MAX_WIDTH
    ? { ...DEFAULT_SETTINGS, marginLeft: MARGIN_PRESETS.Narrow, marginRight: MARGIN_PRESETS.Narrow }
    : DEFAULT_SETTINGS;
}

function load(): ViewSettings {
  const defaults = defaultSettingsFor(typeof window === "undefined" ? Infinity : window.innerWidth);
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? sanitizeSettings(JSON.parse(stored)) : defaults;
  } catch {
    return defaults;
  }
}

function store(settings: ViewSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be full or blocked; the settings still apply this session.
  }
}

/** View settings, remembered per device. `update` validates what it is given. */
export function useViewSettings(): [ViewSettings, (patch: Partial<ViewSettings>) => void] {
  const [settings, setSettings] = useState(load);
  const update = useCallback((patch: Partial<ViewSettings>) => {
    setSettings((current) => {
      const next = sanitizeSettings({ ...current, ...patch });
      store(next);
      return next;
    });
  }, []);
  return [settings, update];
}
