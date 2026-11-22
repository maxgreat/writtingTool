import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import type { Backend } from "../core/backend";
import type { TextPosition } from "../core/caret";
import type { BlockStyle, EditorHandle, FormatState } from "../core/editor/types";
import type { Project } from "../core/project";
import type { EditorMode, ViewSettings } from "../core/settings";
import type { useProject } from "../core/useProject";
import { Binder } from "./Binder";
import { BottomSheet } from "./BottomSheet";
import { cx, hasMod, shortcut } from "./dom";
import { EditorPane } from "./EditorPane";
import { FormatBar } from "./FormatBar";
import { HOVER_QUERY, useMediaQuery } from "./hooks";
import { Inspector, type InspectorView } from "./Inspector";
import { panelStyle } from "./layoutStyle";
import { ResizeHandle } from "./ResizeHandle";
import { StatusBar } from "./StatusBar";
import { useOpenFolder } from "./useOpenFolder";

type ProjectApi = ReturnType<typeof useProject>;

export interface WorkspaceProps {
  api: ProjectApi;
  project: Project;
  backend: Backend;
  settings: ViewSettings;
  update(patch: Partial<ViewSettings>): void;
  isPhone: boolean;
}

const NO_FORMAT: FormatState = { bold: false, italic: false, block: "body" };

/**
 * The main window: formatting bar on top, binder, chapter and inspector,
 * status bar at the bottom. Phones get the editor alone, with the panels as
 * overlays; focus mode hides everything but the text.
 */
export function Workspace({ api, project, backend, settings, update, isPhone }: WorkspaceProps) {
  const { openChapterId, matcher } = api;
  const chapter = openChapterId ? (project.chapters[openChapterId] ?? null) : null;
  const sheetsById = useMemo(() => new Map(project.sheets.map((s) => [s.id, s])), [project.sheets]);
  const canHover = useMediaQuery(HOVER_QUERY);

  const editorRef = useRef<EditorHandle>(null);
  const [format, setFormat] = useState<FormatState>(NO_FORMAT);
  const [inspectorView, setInspectorView] = useState<InspectorView>({ kind: "chapter" });
  const [focusMode, setFocusMode] = useState(false);
  const [barRevealed, setBarRevealed] = useState(false);
  const [phonePanel, setPhonePanel] = useState<"binder" | "inspector" | null>(null);
  const [preview, setPreview] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const [drag, setDrag] = useState<{ binder?: number; inspector?: number }>({});

  // A chapter with Markdown the formatted editor can't keep is shown in Plain
  // until another chapter is opened. The mode setting itself doesn't change.
  const [plainOnlyId, setPlainOnlyId] = useState<string | null>(null);

  // The caret to restore when an editor mounts: after a mode switch, or when
  // coming back to a chapter opened earlier in this read of the project.
  // Saved carets are keyed by load, so carets from an older read never match.
  const [mountCaret, setMountCaret] = useState<{ key: string; caret: TextPosition } | null>(null);
  const carets = useRef(new Map<string, TextPosition>());
  const caretKey = (id: string) => `${api.loads}:${id}`;

  // A project read from disk, another one or the same folder again: the mount
  // caret, the plain-only flag and the inspector's place belong to the old
  // read. They are reset during render (React's pattern for state that follows
  // a prop), so the editors, remounted for the new read, never start from them.
  const [seenLoads, setSeenLoads] = useState(api.loads);
  if (seenLoads !== api.loads) {
    setSeenLoads(api.loads);
    setMountCaret(null);
    setPlainOnlyId(null);
    setInspectorView({ kind: "chapter" });
    setPreview({ id: null, open: false });
  }

  const plainOnly = chapter !== null && plainOnlyId === chapter.id;
  const mode: EditorMode = plainOnly ? "plain" : settings.mode;
  const editorKey = chapter ? `${chapter.id}:${mode}` : "";
  const initialCaret = mountCaret?.key === editorKey ? mountCaret.caret : null;

  const binderVisible = !focusMode && (isPhone ? phonePanel === "binder" : settings.binderOpen);
  const inspectorVisible = !focusMode && (isPhone ? phonePanel === "inspector" : settings.inspectorOpen);

  // Leaving phone layout closes the overlays.
  useEffect(() => {
    if (!isPhone) {
      setPhonePanel(null);
      setPreview((p) => ({ ...p, open: false }));
    }
  }, [isPhone]);

  /* Panels ----------------------------------------------------------------- */

  const togglePanel = useCallback(
    (panel: "binder" | "inspector") => {
      if (focusMode) {
        // From focus mode, the shortcut brings that panel back.
        setFocusMode(false);
        if (!isPhone) update(panel === "binder" ? { binderOpen: true } : { inspectorOpen: true });
        return;
      }
      if (isPhone) setPhonePanel((current) => (current === panel ? null : panel));
      else if (panel === "binder") update({ binderOpen: !settings.binderOpen });
      else update({ inspectorOpen: !settings.inspectorOpen });
    },
    [focusMode, isPhone, settings.binderOpen, settings.inspectorOpen, update],
  );

  /** Opens a sheet in the inspector, showing the inspector if it is hidden. */
  const openSheet = useCallback(
    (id: string) => {
      setInspectorView({ kind: "sheet", id });
      if (isPhone) setPhonePanel("inspector");
      else if (!settings.inspectorOpen) update({ inspectorOpen: true });
    },
    [isPhone, settings.inspectorOpen, update],
  );

  /**
   * A clicked name: the inspector on desktop, with the caret kept in the
   * text; a half-height preview on phones, which takes focus itself.
   */
  const openSheetFromText = useCallback(
    (id: string) => {
      if (isPhone) {
        setPreview({ id, open: true });
        return;
      }
      openSheet(id);
      editorRef.current?.focus();
    },
    [isPhone, openSheet],
  );

  const closePreview = useCallback(() => setPreview((p) => ({ ...p, open: false })), []);

  /* Chapters and modes ----------------------------------------------------- */

  const openChapter = (id: string) => {
    if (isPhone) setPhonePanel(null);
    if (id === openChapterId) {
      editorRef.current?.focus();
      return;
    }
    if (openChapterId && editorRef.current) carets.current.set(caretKey(openChapterId), editorRef.current.getCaret());
    const caret = carets.current.get(caretKey(id));
    setMountCaret(caret ? { key: `${id}:${settings.mode}`, caret } : null);
    setPlainOnlyId(null);
    setFormat(NO_FORMAT);
    api.openChapter(id);
  };

  const changeMode = (next: EditorMode) => {
    // A plain-only chapter is already in Plain, and Formatted can't show it.
    if (next === mode || plainOnly) return;
    const caret = editorRef.current?.getCaret();
    setMountCaret(chapter && caret ? { key: `${chapter.id}:${next}`, caret } : null);
    update({ mode: next });
  };

  /**
   * The formatted editor can't keep this chapter's Markdown and went
   * read-only: show the chapter in Plain, with the caret it was given.
   */
  const showInPlain = useCallback((id: string) => {
    setPlainOnlyId(id);
    setMountCaret((m) => (m?.key === `${id}:formatted` ? { key: `${id}:plain`, caret: m.caret } : m));
  }, []);

  /* Focus mode ------------------------------------------------------------- */

  const pointerInBar = useRef(false);
  const menuOpen = useRef(false);
  const barRef = useRef<HTMLElement>(null);

  const leaveFocus = useCallback(() => {
    setFocusMode(false);
    setBarRevealed(false);
  }, []);

  // Focus mode is for writing: the caret goes back to the text, out of the hidden bar.
  const enterFocus = useCallback(() => {
    setFocusMode(true);
    setBarRevealed(false);
    editorRef.current?.focus();
  }, []);

  const maybeHideBar = useCallback(() => {
    const focusInBar = barRef.current?.contains(document.activeElement) ?? false;
    if (!pointerInBar.current && !menuOpen.current && !focusInBar) setBarRevealed(false);
  }, []);

  const onMenuOpenChange = useCallback(
    (open: boolean) => {
      menuOpen.current = open;
      if (!open) maybeHideBar();
    },
    [maybeHideBar],
  );

  const onBarBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && barRef.current?.contains(next)) return;
    if (!pointerInBar.current && !menuOpen.current) setBarRevealed(false);
  };

  /* Keyboard --------------------------------------------------------------- */

  const keys = useRef({ togglePanel, enterFocus, leaveFocus, settings, update, focusMode, phonePanel });
  keys.current = { togglePanel, enterFocus, leaveFocus, settings, update, focusMode, phonePanel };

  useEffect(() => {
    // Capture phase, so these work whichever editor has focus.
    const onShortcut = (event: KeyboardEvent) => {
      const k = keys.current;
      if (event.key === "F11") {
        event.preventDefault();
        if (k.focusMode) k.leaveFocus();
        else k.enterFocus();
        return;
      }
      if (!hasMod(event) || event.getModifierState("AltGraph")) return;
      if (event.altKey && event.code === "KeyB") {
        event.preventDefault();
        k.togglePanel("binder");
      } else if (event.altKey && event.code === "KeyI") {
        event.preventDefault();
        k.togglePanel("inspector");
      } else if (!event.altKey && (event.key === "+" || event.key === "=" || event.code === "NumpadAdd")) {
        event.preventDefault();
        k.update({ fontSize: k.settings.fontSize + 1 });
      } else if (!event.altKey && (event.key === "-" || event.code === "NumpadSubtract")) {
        event.preventDefault();
        k.update({ fontSize: k.settings.fontSize - 1 });
      }
    };
    // Bubble phase: an open menu or sheet handles Escape first and stops it.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const k = keys.current;
      if (k.phonePanel) setPhonePanel(null);
      else if (k.focusMode) k.leaveFocus();
    };
    window.addEventListener("keydown", onShortcut, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onShortcut, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, []);

  /* Editor commands -------------------------------------------------------- */

  const run = (command: (handle: EditorHandle) => void) => {
    if (editorRef.current) command(editorRef.current);
  };

  const { busy: opening, error: openError, run: openFolder } = useOpenFolder(api.openFolder);

  const empty = (
    <div className="editor-empty">
      <h2>{project.title} has no chapters yet</h2>
      <p className="muted">
        Add a Markdown file to <code className="path">manuscript/</code> in the project folder, then open the project
        again.
      </p>
      {backend.canOpenFolders && (
        <button type="button" className="btn btn--primary" onClick={openFolder} disabled={opening}>
          {opening ? "Opening…" : "Open folder…"}
        </button>
      )}
      {openError && (
        <p className="inline-error" role="alert">
          {openError}
        </p>
      )}
    </div>
  );

  return (
    <div
      className={cx(
        "workspace",
        isPhone ? "is-phone" : "is-desktop",
        focusMode && "is-focus",
        (drag.binder !== undefined || drag.inspector !== undefined) && "is-resizing",
      )}
      style={panelStyle(settings, drag)}
    >
      {focusMode && <div className="reveal-zone" aria-hidden onPointerEnter={() => setBarRevealed(true)} />}

      <header
        ref={barRef}
        className={cx("bar-slot", barRevealed && "is-revealed")}
        onPointerEnter={() => {
          pointerInBar.current = true;
        }}
        onPointerLeave={() => {
          pointerInBar.current = false;
          maybeHideBar();
        }}
        onFocus={() => focusMode && setBarRevealed(true)}
        onBlur={onBarBlur}
      >
        <FormatBar
          settings={settings}
          update={update}
          format={format}
          hasChapter={chapter !== null}
          onBold={() => run((h) => h.toggleBold())}
          onItalic={() => run((h) => h.toggleItalic())}
          onBlockStyle={(style: BlockStyle) => run((h) => h.setBlockStyle(style))}
          onSceneBreak={() => run((h) => h.insertSceneBreak())}
          mode={mode}
          formattedUnavailable={plainOnly}
          onModeChange={changeMode}
          binderOpen={binderVisible}
          inspectorOpen={inspectorVisible}
          onToggleBinder={() => togglePanel("binder")}
          onToggleInspector={() => togglePanel("inspector")}
          focusMode={focusMode}
          onLeaveFocus={leaveFocus}
          onMenuOpenChange={onMenuOpenChange}
          onRefocus={() => editorRef.current?.focus()}
        />
      </header>

      <div className="workspace-main">
        <div id="binder" className={cx("panel panel--binder", binderVisible && "is-open")} inert={!binderVisible}>
          <div className="panel-inner">
            <Binder
              project={project}
              openChapterId={openChapterId}
              onOpenChapter={openChapter}
              onOpenSheet={openSheet}
              onOpenFolder={backend.canOpenFolders ? api.openFolder : undefined}
            />
          </div>
          {!isPhone && (
            <ResizeHandle
              panel="binder"
              width={drag.binder ?? settings.binderWidth}
              label="Binder width"
              onDrag={(width) => setDrag((d) => ({ ...d, binder: width ?? undefined }))}
              onCommit={(binderWidth) => update({ binderWidth })}
            />
          )}
        </div>

        <EditorPane
          // The editors read their text on mount. Chapter ids are paths inside
          // the project, so a newly read project (another one, or the same
          // folder after outside edits) can open the same id: remount on every
          // load, never reuse an editor holding the old text.
          key={api.loads}
          chapter={chapter}
          matcher={matcher}
          settings={settings}
          mode={mode}
          plainOnly={plainOnly}
          onUnsupportedMarkdown={showInPlain}
          readOnly={api.switching}
          editorRef={editorRef}
          initialCaret={initialCaret}
          onChange={api.updateChapter}
          onFormatChange={setFormat}
          onOpenSheet={focusMode ? null : openSheetFromText}
          sheetsById={sheetsById}
          hoverCards={canHover && !isPhone}
          empty={empty}
        />

        <div
          id="inspector"
          className={cx("panel panel--inspector", inspectorVisible && "is-open")}
          inert={!inspectorVisible}
        >
          {!isPhone && (
            <ResizeHandle
              panel="inspector"
              width={drag.inspector ?? settings.inspectorWidth}
              label="Inspector width"
              onDrag={(width) => setDrag((d) => ({ ...d, inspector: width ?? undefined }))}
              onCommit={(inspectorWidth) => update({ inspectorWidth })}
            />
          )}
          <div className="panel-inner">
            <Inspector
              project={project}
              chapter={chapter}
              matcher={matcher}
              sheetsById={sheetsById}
              view={inspectorView}
              onViewChange={setInspectorView}
              onOpenSheet={openSheet}
              versions={{
                list: api.listVersions,
                restore: api.restoreVersion,
                saveStatus: api.save.status,
                loads: api.loads,
                busy: api.switching,
              }}
              visible={inspectorVisible}
            />
          </div>
        </div>

        {isPhone && (
          <button
            type="button"
            className={cx("scrim", phonePanel && "is-open")}
            aria-label={phonePanel === "binder" ? "Close binder" : "Close inspector"}
            tabIndex={-1}
            inert={!phonePanel}
            onClick={() => setPhonePanel(null)}
          />
        )}
      </div>

      {!focusMode && (
        <StatusBar
          chapterWords={chapter?.wordCount ?? null}
          bookWords={api.bookWords}
          wordsToday={api.wordsToday}
          language={project.language}
          save={api.save}
          onRetry={api.saveNow}
          backendKind={backend.kind}
          problems={project.problems}
          compact={isPhone}
        />
      )}

      {isPhone && (
        <BottomSheet
          sheet={preview.id ? (sheetsById.get(preview.id) ?? null) : null}
          open={preview.open}
          onClose={closePreview}
        />
      )}

      {focusMode && (
        <p className="visually-hidden" role="status">
          Focus mode. Press Escape or {shortcut("F11")} to leave.
        </p>
      )}
    </div>
  );
}
