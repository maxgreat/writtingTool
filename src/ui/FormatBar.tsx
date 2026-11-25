import {
  AArrowDown,
  AArrowUp,
  Bold,
  Italic,
  Minimize,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useEffect, useState, type MouseEvent, type RefObject } from "react";
import type { BlockStyle, FormatState } from "../core/editor/types";
import {
  FONT_SIZE,
  LINE_SPACINGS,
  MARGIN,
  MARGIN_PRESETS,
  type EditorMode,
  type ViewSettings,
  type WritingFont,
} from "../core/settings";
import { shortcut } from "./dom";
import { PLAIN_ONLY_NOTE_ID } from "./EditorPane";
import { MainMenu, type MainMenuCommands } from "./MainMenu";
import { MenuButton, MenuItem } from "./Popover";

const BLOCK_LABELS: Record<BlockStyle, string> = { body: "Body text", heading: "Heading", quote: "Quote" };
const FONTS: { value: WritingFont; label: string }[] = [
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans" },
  { value: "mono", label: "Mono" },
];
const MODES: { value: EditorMode; label: string }[] = [
  { value: "formatted", label: "Formatted" },
  { value: "plain", label: "Plain" },
];

type MenuName = "main" | "style" | "size" | "line" | "margins";

export interface FormatBarProps {
  settings: ViewSettings;
  update(patch: Partial<ViewSettings>): void;
  format: FormatState;
  /** False when no chapter is open: the text commands have nothing to act on. */
  hasChapter: boolean;
  onBold(): void;
  onItalic(): void;
  onBlockStyle(style: BlockStyle): void;
  onSceneBreak(): void;
  /** The mode the open chapter is shown in, which can differ from the mode setting. */
  mode: EditorMode;
  /** The open chapter uses Markdown Formatted can't keep: only Plain can be chosen. */
  formattedUnavailable: boolean;
  onModeChange(mode: EditorMode): void;
  binderOpen: boolean;
  inspectorOpen: boolean;
  onToggleBinder(): void;
  onToggleInspector(): void;
  /** In focus mode the panel buttons give way to a way out. */
  focusMode: boolean;
  onLeaveFocus(): void;
  /** The main menu's commands, at the far left of the bar. */
  mainMenu: MainMenuCommands;
  /** The main menu's button, which the Projects view hangs from when opened from the menu or its shortcut. */
  mainMenuRef: RefObject<HTMLButtonElement | null>;
  onMenuOpenChange?(open: boolean): void;
  /** Puts the caret back in the text after a menu choice. */
  onRefocus(): void;
}

/** Keeps the caret in the text when a button is pressed with the mouse. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

export function formatLineSpacing(value: number): string {
  return value.toFixed(1);
}

/**
 * The one slim row of controls: style, bold, italic, text size, line
 * spacing, margins and the mode switch, with each panel's hide button at its
 * end of the bar, after the main menu on the left.
 */
export function FormatBar(props: FormatBarProps) {
  const { settings, update, format, hasChapter, focusMode, onMenuOpenChange } = props;
  const [menu, setMenu] = useState<MenuName | null>(null);
  const toggle = (name: MenuName) => (open: boolean) => setMenu(open ? name : null);

  useEffect(() => {
    onMenuOpenChange?.(menu !== null);
  }, [menu, onMenuOpenChange]);

  const preset = Object.entries(MARGIN_PRESETS).find(
    ([, value]) => settings.marginLeft === value && settings.marginRight === value,
  )?.[0];
  const binderLabel = `${props.binderOpen ? "Hide" : "Show"} binder (${shortcut("mod", "alt", "B")})`;
  const inspectorLabel = `${props.inspectorOpen ? "Hide" : "Show"} inspector (${shortcut("mod", "alt", "I")})`;

  return (
    <div className="format-bar" role="group" aria-label="Formatting">
      <div className="format-bar-end">
        <MainMenu
          commands={props.mainMenu}
          focusMode={focusMode}
          open={menu === "main"}
          onOpenChange={toggle("main")}
          triggerRef={props.mainMenuRef}
        />
        {!focusMode && (
          <button
            type="button"
            className="btn btn--icon"
            aria-label={binderLabel}
            title={binderLabel}
            aria-expanded={props.binderOpen}
            aria-controls="binder"
            onClick={props.onToggleBinder}
          >
            {props.binderOpen ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
          </button>
        )}
      </div>

      <div className="format-bar-scroll">
        <div className="format-bar-controls">
          <div className="format-group">
            <MenuButton
              open={menu === "style"}
              onOpenChange={toggle("style")}
              menuLabel="Paragraph style"
              ariaLabel={`Paragraph style: ${BLOCK_LABELS[format.block]}`}
              title="Paragraph style"
              disabled={!hasChapter}
              menu={
                <>
                  {(Object.keys(BLOCK_LABELS) as BlockStyle[]).map((style) => (
                    <MenuItem
                      key={style}
                      checked={format.block === style}
                      onSelect={() => {
                        setMenu(null);
                        props.onBlockStyle(style);
                      }}
                    >
                      {BLOCK_LABELS[style]}
                    </MenuItem>
                  ))}
                  <div className="popover-gap" role="none" />
                  <MenuItem
                    onSelect={() => {
                      setMenu(null);
                      props.onSceneBreak();
                    }}
                    hint="***"
                  >
                    Scene break
                  </MenuItem>
                </>
              }
            >
              {/* Every label in one grid cell, so the button is as wide as the longest. */}
              <span className="stacked-label">
                {(Object.keys(BLOCK_LABELS) as BlockStyle[]).map((style) => (
                  <span key={style} aria-hidden={style !== format.block} data-active={style === format.block}>
                    {BLOCK_LABELS[style]}
                  </span>
                ))}
              </span>
            </MenuButton>
          </div>

          <div className="format-group">
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Bold"
              title={`Bold (${shortcut("mod", "B")})`}
              aria-pressed={hasChapter && format.bold}
              disabled={!hasChapter}
              onMouseDown={keepFocus}
              onClick={props.onBold}
            >
              <Bold aria-hidden />
            </button>
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Italic"
              title={`Italic (${shortcut("mod", "I")})`}
              aria-pressed={hasChapter && format.italic}
              disabled={!hasChapter}
              onMouseDown={keepFocus}
              onClick={props.onItalic}
            >
              <Italic aria-hidden />
            </button>
          </div>

          <div className="format-group format-group--tight">
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Smaller text"
              title={`Smaller text (${shortcut("mod", "−")})`}
              disabled={settings.fontSize <= FONT_SIZE.min}
              onMouseDown={keepFocus}
              onClick={() => update({ fontSize: settings.fontSize - 1 })}
            >
              <AArrowDown aria-hidden />
            </button>
            <MenuButton
              open={menu === "size"}
              onOpenChange={toggle("size")}
              menuLabel="Writing font"
              ariaLabel={`Text size ${settings.fontSize} points, ${settings.font} font`}
              title="Text size and writing font"
              className="size-trigger"
              menu={
                <>
                  <div className="popover-title" role="none">
                    Writing font
                  </div>
                  {FONTS.map((font) => (
                    <MenuItem
                      key={font.value}
                      checked={settings.font === font.value}
                      className={`font-sample font-sample--${font.value}`}
                      onSelect={() => {
                        setMenu(null);
                        update({ font: font.value });
                        props.onRefocus();
                      }}
                    >
                      {font.label}
                    </MenuItem>
                  ))}
                </>
              }
            >
              <span className="num">{settings.fontSize}</span>
            </MenuButton>
            <button
              type="button"
              className="btn btn--icon"
              aria-label="Larger text"
              title={`Larger text (${shortcut("mod", "+")})`}
              disabled={settings.fontSize >= FONT_SIZE.max}
              onMouseDown={keepFocus}
              onClick={() => update({ fontSize: settings.fontSize + 1 })}
            >
              <AArrowUp aria-hidden />
            </button>
          </div>

          <div className="format-group">
            <MenuButton
              open={menu === "line"}
              onOpenChange={toggle("line")}
              menuLabel="Line spacing"
              ariaLabel={`Line spacing ${formatLineSpacing(settings.lineSpacing)}`}
              title="Line spacing"
              menu={LINE_SPACINGS.map((value) => (
                <MenuItem
                  key={value}
                  checked={settings.lineSpacing === value}
                  onSelect={() => {
                    setMenu(null);
                    update({ lineSpacing: value });
                    props.onRefocus();
                  }}
                >
                  <span className="num">{formatLineSpacing(value)}</span>
                </MenuItem>
              ))}
            >
              Line <span className="num muted">{formatLineSpacing(settings.lineSpacing)}</span>
            </MenuButton>

            <MenuButton
              open={menu === "margins"}
              onOpenChange={toggle("margins")}
              role="dialog"
              menuLabel="Margins"
              title="Left and right margins"
              popoverClassName="margins-popover"
              menu={
                <div className="margins">
                  <MarginSlider
                    label="Left"
                    value={settings.marginLeft}
                    onChange={(marginLeft) => update({ marginLeft })}
                  />
                  <MarginSlider
                    label="Right"
                    value={settings.marginRight}
                    onChange={(marginRight) => update({ marginRight })}
                  />
                  <div className="segmented segmented--full" role="group" aria-label="Margin presets">
                    {Object.entries(MARGIN_PRESETS).map(([name, value]) => (
                      <button
                        key={name}
                        type="button"
                        className="segmented-option"
                        aria-pressed={preset === name}
                        onClick={() => update({ marginLeft: value, marginRight: value })}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
              }
            >
              Margins
            </MenuButton>
          </div>

          <div className="segmented" role="radiogroup" aria-label="Editing mode">
            {MODES.map((mode) => {
              const unavailable = mode.value === "formatted" && props.formattedUnavailable;
              return (
                <button
                  key={mode.value}
                  type="button"
                  role="radio"
                  className="segmented-option"
                  aria-checked={props.mode === mode.value}
                  disabled={unavailable}
                  title={unavailable ? "Formatted isn’t available for this chapter" : undefined}
                  aria-describedby={unavailable ? PLAIN_ONLY_NOTE_ID : undefined}
                  onClick={() => props.onModeChange(mode.value)}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="format-bar-end format-bar-end--right">
        {focusMode ? (
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Leave focus mode (Esc)"
            title="Leave focus mode (Esc)"
            onClick={props.onLeaveFocus}
          >
            <Minimize aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--icon"
            aria-label={inspectorLabel}
            title={inspectorLabel}
            aria-expanded={props.inspectorOpen}
            aria-controls="inspector"
            onClick={props.onToggleInspector}
          >
            {props.inspectorOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
          </button>
        )}
      </div>
    </div>
  );
}

function MarginSlider({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return (
    <label className="margin-slider">
      <span className="margin-slider-label">
        {label}
        <span className="num muted">{value}%</span>
      </span>
      <input
        type="range"
        min={MARGIN.min}
        max={MARGIN.max}
        step={1}
        value={value}
        aria-valuetext={`${value}% of the editor width`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
