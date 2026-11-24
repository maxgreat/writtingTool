import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import type { Backend } from "../core/backend";
import type { TextPosition } from "../core/caret";
import type { BlockStyle, EditorHandle, FormatState } from "../core/editor/types";
import { NameIndex } from "../core/nameIndex";
import type { IgnoredName } from "../core/names";
import type { Project } from "../core/project";
import type { EditorMode, ViewSettings } from "../core/settings";
import type { useProject } from "../core/useProject";
import { Binder } from "./Binder";
import { SheetPreview } from "./BottomSheet";
import { cx, hasMod, shortcut } from "./dom";
import { EditorPane } from "./EditorPane";
import { FormatBar } from "./FormatBar";
import { HOVER_QUERY, useMediaQuery } from "./hooks";
import type { IgnoreSource } from "./IgnoreHere";
import { Inspector, type InspectorView } from "./Inspector";
import { panelStyle } from "./layoutStyle";
import type { ProjectsSource } from "./Projects";
import { ResizeHandle } from "./ResizeHandle";
import { StatusBar } from "./StatusBar";
import type { SwipeIntent } from "./swipe";
import { useEdgeSwipe } from "./useEdgeSwipe";
import { useOnScreenKeyboard } from "./useOnScreenKeyboard";

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
 * The phone's name preview: which sheet, whether it is up, the name tapped
 * in the text, and a count of taps, so each one starts the preview afresh.
 */
interface Preview {
  id: string | null;
  open: boolean;
  occurrence?: IgnoredName;
  opening: number;
}

/** A sheet in the inspector, as it reads or in its form, with the name in the text it was opened from, if any. */
function sheetView(id: string, editing: boolean, occurrence: IgnoredName | undefined): InspectorView {
  return { kind: "sheet", id, ...(editing && { editing: true }), ...(occurrence && { occurrence }) };
}

/** Where focus must be for the on-screen keyboard to dock the formatting bar: the chapter text. */
const KEYBOARD_SCOPE = ".editor-pane";

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
  // How often each sheet's names appear in each chapter, for the inspector and the sheet
  // preview. Kept as long as the workspace is: a new matcher (a sheet added, renamed or
  // removed, another project) starts it afresh.
  const [nameIndex] = useState(() => new NameIndex());

  const editorRef = useRef<EditorHandle>(null);
  const [format, setFormat] = useState<FormatState>(NO_FORMAT);
  const [inspectorView, setInspectorView] = useState<InspectorView>({ kind: "chapter" });
  const [focusMode, setFocusMode] = useState(false);
  const [barRevealed, setBarRevealed] = useState(false);
  const [phonePanel, setPhonePanel] = useState<"binder" | "inspector" | null>(null);
  const [preview, setPreview] = useState<Preview>({ id: null, open: false, opening: 0 });
  const [drag, setDrag] = useState<{ binder?: number; inspector?: number }>({});
  /** Goes up when the empty project's button asks the binder for a new chapter. */
  const [newChapterRequest, setNewChapterRequest] = useState(0);

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
    setPreview((p) => ({ id: null, open: false, opening: p.opening }));
  }

  const plainOnly = chapter !== null && plainOnlyId === chapter.id;
  const mode: EditorMode = plainOnly ? "plain" : settings.mode;
  const editorKey = chapter ? `${chapter.id}:${mode}` : "";
  const initialCaret = mountCaret?.key === editorKey ? mountCaret.caret : null;

  const binderVisible = !focusMode && (isPhone ? phonePanel === "binder" : settings.binderOpen);
  const inspectorVisible = !focusMode && (isPhone ? phonePanel === "inspector" : settings.inspectorOpen);

  /* Phones: edge swipes and the on-screen keyboard -------------------------- */

  const mainRef = useRef<HTMLDivElement>(null);

  /** A swipe from an edge slides its panel in; one towards an open panel's edge sends it back. */
  const onSwipe = useCallback((intent: SwipeIntent) => {
    if (intent.action === "close") {
      setPhonePanel(null);
      return;
    }
    // The panel covers the text: the on-screen keyboard goes away with the caret, as when its button is pressed.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(KEYBOARD_SCOPE)) active.blur();
    setPhonePanel(intent.panel);
  }, []);

  useEdgeSwipe({ area: mainRef, enabled: isPhone && !focusMode, open: phonePanel, onSwipe });

  /**
   * While the on-screen keyboard is up for the chapter, the formatting bar
   * docks just above it and the status bar makes room, unless it has a save
   * error to show. Only the app's shell can say the keyboard is up (see the
   * hook): where nothing says so, as on desktop or in the browser preview,
   * the bars stay where they are, however the window is resized.
   */
  const keyboardUp = useOnScreenKeyboard(isPhone && !focusMode, KEYBOARD_SCOPE);
  const statusShown = !focusMode && (!keyboardUp || api.save.status === "error");

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

  /**
   * Opens a sheet in the inspector, showing the inspector if it is hidden:
   * as it reads, or in its form with `editing`. A sheet already open in its
   * form stays there. `occurrence` is the name in the text it was opened
   * from; opened from anywhere else, it has none.
   */
  const showSheet = useCallback(
    (id: string, editing: boolean, occurrence?: IgnoredName) => {
      setInspectorView((view) =>
        sheetView(id, editing || (view.kind === "sheet" && view.id === id && view.editing === true), occurrence),
      );
      if (isPhone) setPhonePanel("inspector");
      else if (!settings.inspectorOpen) update({ inspectorOpen: true });
    },
    [isPhone, settings.inspectorOpen, update],
  );

  const openSheet = useCallback((id: string) => showSheet(id, false), [showSheet]);

  /**
   * A clicked name: the inspector on desktop, with the caret kept in the
   * text; a half-height preview on phones, which takes focus itself. Either
   * shows where the name was clicked, with Ignore here.
   */
  const openSheetFromText = useCallback(
    (id: string, occurrence: IgnoredName) => {
      if (isPhone) {
        setPreview((p) => ({ id, open: true, occurrence, opening: p.opening + 1 }));
        return;
      }
      showSheet(id, false, occurrence);
      editorRef.current?.focus();
    },
    [isPhone, showSheet],
  );

  const closePreview = useCallback(() => setPreview((p) => ({ ...p, open: false })), []);

  /**
   * The phone preview's Edit: the preview makes way for the inspector, with
   * the sheet's form. It is the same opening, so Done shows where the name
   * was tapped.
   */
  const previewOccurrence = preview.occurrence;
  const editFromPreview = useCallback(
    (id: string) => {
      closePreview();
      showSheet(id, true, previewOccurrence);
    },
    [closePreview, showSheet, previewOccurrence],
  );

  /** Ignore here, wherever a name opened from the text offers it. */
  const ignoring = useMemo<IgnoreSource>(
    () => ({ ignored: project.ignoredNames, setIgnored: api.ignoreName, busy: api.switching }),
    [project.ignoredNames, api.ignoreName, api.switching],
  );

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

  /** The binder created a chapter and opened it: on a phone, the panel makes way for it. */
  const chapterCreated = useCallback(() => {
    if (isPhone) setPhonePanel(null);
  }, [isPhone]);

  /** The empty project's button: show the binder, where the new chapter's title is typed. */
  const startFirstChapter = () => {
    setFocusMode(false);
    if (isPhone) setPhonePanel("binder");
    else if (!settings.binderOpen) update({ binderOpen: true });
    setNewChapterRequest((n) => n + 1);
  };

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

  const projects: ProjectsSource = {
    current: project.root,
    loads: api.loads,
    list: api.listProjects,
    open: api.openProjectAt,
    create: api.createProject,
    openFolder: backend.canOpenFolders ? api.openFolder : undefined,
    canCreate: backend.canCreateProjects,
    openUrl: backend.openUrl,
    busy: api.switching,
    phone: isPhone,
  };

  const empty = (
    <div className="editor-empty">
      <h2>{project.title} has no chapters yet</h2>
      <p className="muted">
        Each chapter is a Markdown file in the project’s <code className="path">manuscript/</code> folder. Name the
        first one in the binder.
      </p>
      <div className="editor-empty-actions">
        <button type="button" className="btn btn--primary" onClick={startFirstChapter} disabled={api.switching}>
          New chapter
        </button>
      </div>
    </div>
  );

  return (
    <div
      className={cx(
        "workspace",
        isPhone ? "is-phone" : "is-desktop",
        focusMode && "is-focus",
        keyboardUp && "is-keyboard",
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

      <div ref={mainRef} className="workspace-main">
        <div id="binder" className={cx("panel panel--binder", binderVisible && "is-open")} inert={!binderVisible}>
          <div className="panel-inner">
            <Binder
              project={project}
              openChapterId={openChapterId}
              onOpenChapter={openChapter}
              onOpenSheet={openSheet}
              projects={projects}
              onChange={api.changeBinder}
              onChapterDetails={api.updateChapterDetails}
              busy={api.switching}
              onChapterCreated={chapterCreated}
              newChapterRequest={newChapterRequest}
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
          ignoring={ignoring}
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
              index={nameIndex}
              sheetsById={sheetsById}
              view={inspectorView}
              onViewChange={setInspectorView}
              onOpenSheet={openSheet}
              onOpenChapter={openChapter}
              onChapterDetails={api.updateChapterDetails}
              onCreateSheet={api.createSheet}
              onUpdateSheet={api.updateSheet}
              ignoring={ignoring}
              onMarkNotName={api.markNotName}
              busy={api.switching}
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

      {statusShown && (
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
        <SheetPreview
          sheet={preview.id ? (sheetsById.get(preview.id) ?? null) : null}
          open={preview.open}
          onClose={closePreview}
          onEdit={editFromPreview}
          occurrence={preview.occurrence}
          ignoring={ignoring}
          opening={preview.opening}
          appearances={{
            index: nameIndex,
            project,
            matcher,
            openChapterId,
            onOpenChapter: openChapter,
            busy: api.switching,
          }}
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
