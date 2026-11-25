import type { GrammarProblem } from "../backend";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";
import { markdownOffsetToPosition, positionToMarkdownOffset } from "../caret";
import {
  insertSceneBreak,
  markdownClasses,
  nameHighlight,
  plainFormat,
  plainSelectedName,
  plainMarkRange,
  plainReplaceWord,
  plainSelectionContains,
  plainSpellingWordAt,
  plainWordAt,
  refreshNames,
  setLineStyle,
  toggleMarker,
} from "./codemirror";
import { grammarMarkAt, nameMarkAt, spellingMarkAt, suggestionMarkAt } from "./nameMarks";
import { sameFormat, shouldFocusOnMount, type ChapterEditorProps, type FormatState } from "./types";

const NO_WORDS: ReadonlySet<string> = new Set();
const NO_PROBLEMS: ReadonlyMap<string, readonly GrammarProblem[]> = new Map();

/**
 * The unformatted mode: CodeMirror 6 over the same Markdown, markers visible
 * (class `md-mark`). The editor element has the class `chapter-text-plain`;
 * highlighted names follow nameMarks.ts.
 */
export function PlainEditor({
  ref,
  markdown,
  matcher,
  initialCaret,
  onChange,
  onFormatChange,
  onNameClick,
  suggestions = NO_WORDS,
  onSuggestionClick,
  misspelled = NO_WORDS,
  onSpellingClick,
  grammar = NO_PROBLEMS,
  onGrammarClick,
  readOnly = false,
  className,
  ariaLabel,
}: ChapterEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Read-only can change while the editor is open (another project opening).
  const editable = useRef(new Compartment());
  const editableExtensions = (on: boolean) => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
  const initialReadOnly = useRef(readOnly);
  const latest = useRef({ matcher, suggestions, misspelled, grammar, onChange, onFormatChange, onNameClick, onSuggestionClick, onSpellingClick, onGrammarClick });
  latest.current = { matcher, suggestions, misspelled, grammar, onChange, onFormatChange, onNameClick, onSuggestionClick, onSpellingClick, onGrammarClick };
  // Read once, when the editor is created; remount to load other text.
  const initial = useRef({ markdown, initialCaret, ariaLabel });

  useEffect(() => {
    const { markdown: doc, initialCaret: caret, ariaLabel: label } = initial.current;
    const anchor = caret ? positionToMarkdownOffset(doc, caret) : 0;
    let lastFormat: FormatState | null = null;
    const report = (state: EditorState) => {
      const format = plainFormat(state);
      if (sameFormat(lastFormat, format)) return;
      lastFormat = format;
      latest.current.onFormatChange?.(format);
    };

    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [
          history(),
          editable.current.of(editableExtensions(!initialReadOnly.current)),
          keymap.of([
            { key: "Mod-b", run: (v) => toggleMarker(v, 2) },
            { key: "Mod-i", run: (v) => toggleMarker(v, 1) },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdownLanguage(),
          syntaxHighlighting(markdownClasses),
          EditorView.lineWrapping,
          nameHighlight(
            () => latest.current.matcher,
            () => ({
              suggestions: latest.current.suggestions,
              misspelled: latest.current.misspelled,
              grammar: latest.current.grammar,
              markdown: true,
            }),
          ),
          EditorView.editorAttributes.of({ class: "chapter-text-plain" }),
          // The WebView's checker can't learn the project's names.
          EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": label ?? "Chapter text" }),
          EditorView.domEventHandlers({
            click(event) {
              const hit = nameMarkAt(event.target);
              if (hit) latest.current.onNameClick?.(hit);
              const suggestion = hit ? null : suggestionMarkAt(event.target);
              if (suggestion) latest.current.onSuggestionClick?.(suggestion);
              const misspelling = hit || suggestion ? null : spellingMarkAt(event.target);
              if (misspelling) latest.current.onSpellingClick?.(misspelling);
              const problem = hit || suggestion || misspelling ? null : grammarMarkAt(event.target);
              if (problem) latest.current.onGrammarClick?.(problem);
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) report(update.state);
          }),
        ],
      }),
    });
    view.current = editor;
    editor.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
    if (!initialReadOnly.current && shouldFocusOnMount()) editor.focus();
    report(editor.state);
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(editableExtensions(!readOnly)) });
  }, [readOnly]);

  // A new matcher (a sheet was added or renamed), new possible names or misspelled words: mark everything again.
  useEffect(() => {
    view.current?.dispatch({ effects: refreshNames.of(null) });
  }, [matcher, suggestions, misspelled, grammar]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      toggleBold: () => {
        if (view.current) toggleMarker(view.current, 2);
        view.current?.focus();
      },
      toggleItalic: () => {
        if (view.current) toggleMarker(view.current, 1);
        view.current?.focus();
      },
      setBlockStyle: (style) => {
        if (view.current) setLineStyle(view.current, style);
      },
      insertSceneBreak: () => {
        if (view.current) insertSceneBreak(view.current);
      },
      getCaret: () => {
        const v = view.current;
        return v ? markdownOffsetToPosition(v.state.doc.toString(), v.state.selection.main.head) : { block: 0, offset: 0 };
      },
      wordAt: (x, y) => (view.current ? plainWordAt(view.current, x, y) : null),
      selectedName: () => (view.current ? plainSelectedName(view.current.state) : ""),
      selectionContains: (x, y) => (view.current ? plainSelectionContains(view.current, x, y) : false),
      spellingWordAt: (x, y) => (view.current ? plainSpellingWordAt(view.current, x, y) : null),
      markRange: (mark) => (view.current ? plainMarkRange(view.current, mark) : null),
      replaceWord: (word, text) =>
        view.current !== null && !view.current.state.readOnly && plainReplaceWord(view.current, word, text),
    }),
    [],
  );

  return <div ref={host} className={className} />;
}
