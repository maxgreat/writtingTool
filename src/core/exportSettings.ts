/*
 * Export settings, as the Rust core's export module takes them
 * (src-tauri/src/export.rs): the same fields, in camelCase. Presets are
 * named sets of them; the project's own are kept in project.json, so they
 * travel with the project.
 */

export type ExportFormat = "pdf" | "epub" | "docx" | "markdown";
export type PageSize = "a5" | "trade" | "a4" | "letter";
export type ChapterStart = "newPage" | "rightPage";
export type ChapterHeading = "numberAndTitle" | "title" | "number";
export type BookFont = "libertinus" | "computerModern";

export interface ExportSettings {
  pageSize: PageSize;
  /** Margins in millimetres. Inside and outside swap on left-hand pages when mirrored. */
  marginInside: number;
  marginOutside: number;
  marginTop: number;
  marginBottom: number;
  mirrored: boolean;
  font: BookFont;
  /** Text size in points. */
  fontSize: number;
  /** Line spacing, as a multiple of the usual. */
  lineSpacing: number;
  /** First-line indent, with no space between paragraphs; off: space between paragraphs. */
  indent: boolean;
  justify: boolean;
  /** Hyphenation in the book's language. */
  hyphenate: boolean;
  chapterStart: ChapterStart;
  chapterHeading: ChapterHeading;
  partTitles: boolean;
  /** What a scene break prints as, centred. */
  sceneBreak: string;
  titlePage: boolean;
  contents: boolean;
  pageNumbers: boolean;
  runningHeads: boolean;
}

export const PAGE_SIZES: { value: PageSize; label: string }[] = [
  { value: "a5", label: "A5 (148 × 210 mm)" },
  { value: "trade", label: "6 × 9 in" },
  { value: "a4", label: "A4" },
  { value: "letter", label: "US Letter" },
];

export const BOOK_FONTS: { value: BookFont; label: string }[] = [
  { value: "libertinus", label: "Libertinus Serif" },
  { value: "computerModern", label: "New Computer Modern" },
];

export const FONT_SIZE_RANGE = { min: 8, max: 16 } as const;
export const LINE_SPACINGS = [1, 1.15, 1.3, 1.5, 2] as const;
export const MARGIN_RANGE = { min: 5, max: 40 } as const;

/** Paperback A5: the default. */
export const PAPERBACK: ExportSettings = {
  pageSize: "a5",
  marginInside: 20,
  marginOutside: 15,
  marginTop: 18,
  marginBottom: 20,
  mirrored: true,
  font: "libertinus",
  fontSize: 11,
  lineSpacing: 1,
  indent: true,
  justify: true,
  hyphenate: true,
  chapterStart: "rightPage",
  chapterHeading: "numberAndTitle",
  partTitles: true,
  sceneBreak: "* * *",
  titlePage: true,
  contents: true,
  pageNumbers: true,
  runningHeads: true,
};

/** The presets every project has: a paperback, a manuscript for agents and publishers, a copy to read. */
export const BUILT_IN_PRESETS: { name: string; settings: ExportSettings }[] = [
  { name: "Paperback A5", settings: PAPERBACK },
  {
    name: "Standard manuscript",
    settings: {
      ...PAPERBACK,
      pageSize: "letter",
      marginInside: 25,
      marginOutside: 25,
      marginTop: 25,
      marginBottom: 25,
      mirrored: false,
      fontSize: 12,
      lineSpacing: 2,
      justify: false,
      hyphenate: false,
      chapterStart: "newPage",
      sceneBreak: "#",
      contents: false,
    },
  },
  {
    name: "Reading copy",
    settings: {
      ...PAPERBACK,
      pageSize: "a4",
      marginInside: 25,
      marginOutside: 25,
      marginTop: 25,
      marginBottom: 25,
      mirrored: false,
      fontSize: 12,
      lineSpacing: 1.3,
      chapterStart: "newPage",
    },
  },
];

const PAGE_SIZE_VALUES: PageSize[] = ["a5", "trade", "a4", "letter"];

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Settings from what was stored (project.json, written by hand perhaps), field by field. */
export function sanitizeExportSettings(raw: unknown, base: ExportSettings = PAPERBACK): ExportSettings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    pageSize: oneOf(s.pageSize, PAGE_SIZE_VALUES, base.pageSize),
    marginInside: clamp(s.marginInside, MARGIN_RANGE.min, MARGIN_RANGE.max, base.marginInside),
    marginOutside: clamp(s.marginOutside, MARGIN_RANGE.min, MARGIN_RANGE.max, base.marginOutside),
    marginTop: clamp(s.marginTop, MARGIN_RANGE.min, MARGIN_RANGE.max, base.marginTop),
    marginBottom: clamp(s.marginBottom, MARGIN_RANGE.min, MARGIN_RANGE.max, base.marginBottom),
    mirrored: flag(s.mirrored, base.mirrored),
    font: oneOf(s.font, ["libertinus", "computerModern"] as const, base.font),
    fontSize: clamp(s.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, base.fontSize),
    lineSpacing: clamp(s.lineSpacing, 0.8, 3, base.lineSpacing),
    indent: flag(s.indent, base.indent),
    justify: flag(s.justify, base.justify),
    hyphenate: flag(s.hyphenate, base.hyphenate),
    chapterStart: oneOf(s.chapterStart, ["newPage", "rightPage"] as const, base.chapterStart),
    chapterHeading: oneOf(s.chapterHeading, ["numberAndTitle", "title", "number"] as const, base.chapterHeading),
    partTitles: flag(s.partTitles, base.partTitles),
    sceneBreak: typeof s.sceneBreak === "string" ? s.sceneBreak.slice(0, 20) : base.sceneBreak,
    titlePage: flag(s.titlePage, base.titlePage),
    contents: flag(s.contents, base.contents),
    pageNumbers: flag(s.pageNumbers, base.pageNumbers),
    runningHeads: flag(s.runningHeads, base.runningHeads),
  };
}

/** The pages laid out for the preview. */
export interface BookLayout {
  /** Names this layout: pages are asked for by it, so a page of an older layout is never shown. */
  generation: number;
  pages: number;
  /** A page's size in points. */
  width: number;
  height: number;
  /** The page each chosen chapter starts on (from 0), in order. */
  chapterPages: number[];
}

/** Which file extension each format writes. */
export const EXTENSIONS: Record<ExportFormat, string> = { pdf: "pdf", epub: "epub", docx: "docx", markdown: "md" };
