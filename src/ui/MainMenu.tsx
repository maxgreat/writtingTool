import { Menu } from "lucide-react";
import type { RefObject } from "react";
import { isMac, shortcut } from "./dom";
import { MenuButton, MenuItem } from "./Popover";

/** What the main menu does: Workspace's commands, which the shortcuts run too. */
export interface MainMenuCommands {
  /** False in the browser preview, which only has the sample project: New project… waits for the app. */
  canCreateProjects: boolean;
  /** The Projects view, with its new project form ready. */
  onNewProject(): void;
  /** The Projects view, at its list. */
  onOpenProject(): void;
  /** A folder picker, then the folder chosen; absent where there is no picker (phones, the browser preview). */
  onOpenFolder?: () => void;
  onSave(): void;
  /** A save is being written: Save waits for it. */
  saving: boolean;
  /** The Export window: the format, its settings and a preview of the pages. */
  onExport(): void;
  /** Find in book, in the inspector's place (an overlay on phones), the selection in Find. */
  onFind(): void;
  /** The same, with the replacement showing. */
  onReplace(): void;
  /** The Settings dialog (a sheet on phones). */
  onSettings(): void;
  /** Enters or leaves focus mode; absent where the bar couldn't be brought back (touch screens). */
  onToggleFocus?: () => void;
  /** Closes the window, saving first; only in the desktop app. */
  onQuit?: () => void;
  /** A Quit is under way: Quit waits for it. */
  quitting: boolean;
  /** The project on disk is changing, or a folder is being opened: Open folder… waits. */
  busy: boolean;
  /** Shortcuts are shown beside their commands where there is likely a keyboard: not on touch screens. */
  showShortcuts: boolean;
}

interface MainMenuProps {
  commands: MainMenuCommands;
  focusMode: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The menu button: the Projects view hangs from it when opened from here. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

/** Find in book's replace shortcut: Ctrl+H, or ⌘⌥F on a Mac, where ⌘H hides the app. */
export const REPLACE_KEYS: string[] = isMac ? ["mod", "alt", "F"] : ["mod", "H"];

/**
 * The app's commands, from the far left of the bar: projects, saving and
 * exporting, finding, settings, focus mode and quitting. Groups
 * are set apart by space, in the order a File menu has them.
 */
export function MainMenu({ commands, focusMode, open, onOpenChange, triggerRef }: MainMenuProps) {
  const hint = (...keys: string[]) => (commands.showShortcuts ? shortcut(...keys) : undefined);
  const choose = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  return (
    <MenuButton
      open={open}
      onOpenChange={onOpenChange}
      menuLabel="Main menu"
      ariaLabel="Main menu"
      title="Main menu"
      className="btn--icon"
      chevron={false}
      triggerRef={triggerRef}
      menu={
        <>
          <MenuItem
            noCheck
            disabled={!commands.canCreateProjects}
            hint={commands.canCreateProjects ? undefined : "Needs the app"}
            onSelect={choose(commands.onNewProject)}
          >
            New project…
          </MenuItem>
          <MenuItem noCheck hint={hint("mod", "O")} onSelect={choose(commands.onOpenProject)}>
            Open project…
          </MenuItem>
          {commands.onOpenFolder && (
            <MenuItem noCheck disabled={commands.busy} onSelect={choose(commands.onOpenFolder)}>
              Open folder…
            </MenuItem>
          )}
          <div className="popover-gap" role="none" />
          <MenuItem noCheck disabled={commands.saving} hint={hint("mod", "S")} onSelect={choose(commands.onSave)}>
            Save
          </MenuItem>
          <MenuItem noCheck onSelect={choose(commands.onExport)}>
            Export…
          </MenuItem>
          <div className="popover-gap" role="none" />
          <MenuItem noCheck hint={hint("mod", "shift", "F")} onSelect={choose(commands.onFind)}>
            Find in book…
          </MenuItem>
          <MenuItem noCheck hint={hint(...REPLACE_KEYS)} onSelect={choose(commands.onReplace)}>
            Replace in book…
          </MenuItem>
          <div className="popover-gap" role="none" />
          <MenuItem noCheck hint={hint("mod", ",")} onSelect={choose(commands.onSettings)}>
            Settings…
          </MenuItem>
          {commands.onToggleFocus && (
            <>
              <div className="popover-gap" role="none" />
              <MenuItem noCheck hint={hint("F11")} onSelect={choose(commands.onToggleFocus)}>
                {focusMode ? "Leave focus mode" : "Focus mode"}
              </MenuItem>
            </>
          )}
          {commands.onQuit && (
            <>
              <div className="popover-gap" role="none" />
              <MenuItem
                noCheck
                disabled={commands.quitting}
                hint={hint("mod", "Q")}
                onSelect={choose(commands.onQuit)}
              >
                Quit
              </MenuItem>
            </>
          )}
        </>
      }
    >
      <Menu aria-hidden />
    </MenuButton>
  );
}
