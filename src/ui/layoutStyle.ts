import type { CSSProperties } from "react";
import type { ViewSettings, WritingFont } from "../core/settings";

/**
 * The per-device view settings as CSS variables. The stylesheets turn them
 * into lengths (workspace.css for panels, editor.css for the text column).
 */

const FONT_STACKS: Record<WritingFont, string> = {
  serif: "var(--font-serif)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
};

/** Text size, font, line spacing and margins of the text column. */
export function editorStyle(settings: ViewSettings): CSSProperties {
  return {
    "--writing-size": settings.fontSize,
    "--writing-leading": settings.lineSpacing,
    "--writing-font": FONT_STACKS[settings.font],
    "--margin-left": settings.marginLeft,
    "--margin-right": settings.marginRight,
  } as CSSProperties;
}

/** Panel widths; `drag` holds a live width while a panel edge is being dragged. */
export function panelStyle(settings: ViewSettings, drag?: { binder?: number; inspector?: number }): CSSProperties {
  return {
    "--binder-width": `${drag?.binder ?? settings.binderWidth}px`,
    "--inspector-width": `${drag?.inspector ?? settings.inspectorWidth}px`,
  } as CSSProperties;
}
