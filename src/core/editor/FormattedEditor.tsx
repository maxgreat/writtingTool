import type { GrammarProblem } from "../backend";
import type { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useImperativeHandle, useRef } from "react";
import { chapterExtensions, keepsChapterExactly } from "../markdown";
import { grammarMarkAt, nameMarkAt, spellingMarkAt, suggestionMarkAt } from "./nameMarks";
import { TypingExtras } from "./typingExtras";
import {
  NameHighlight,
  REFRESH_NAMES,
  nameHighlightKey,
  pmPositionToText,
  selectedNameIn,
  markRangeIn,
  replaceWordIn,
  selectionContainsPoint,
  spellingWordAtPoint,
  textToPmPosition,
  wordAtPoint,
} from "./prosemirror";
import { sameFormat, shouldFocusOnMount, type ChapterEditorProps, type FormatState } from "./types";

const NO_WORDS: ReadonlySet<string> = new Set();
const NO_PROBLEMS: ReadonlyMap<string, readonly GrammarProblem[]> = new Map();

function formatOf(editor: Editor): FormatState {
  const block = editor.isActive("blockquote") ? "quote" : editor.isActive("heading") ? "heading" : "body";
  return { bold: editor.isActive("bold"), italic: editor.isActive("italic"), block };
}

/**
 * The WYSIWYG mode: Tiptap over the chapter's Markdown. The editable element
 * has the class `chapter-text`; highlighted names follow nameMarks.ts.
 */
export function FormattedEditor({
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
  typingAids = null,
  typewriter = false,
  onUnsupportedMarkdown,
  readOnly = false,
  className,
  ariaLabel,
}: ChapterEditorProps) {
  const latest = useRef({
    matcher,
    suggestions,
    misspelled,
    grammar,
    typingAids,
    typewriter,
    onChange,
    onFormatChange,
    onNameClick,
    onSuggestionClick,
    onSpellingClick,
    onGrammarClick,
    onUnsupportedMarkdown,
    readOnly,
  });
  latest.current = {
    matcher,
    suggestions,
    misspelled,
    grammar,
    typingAids,
    typewriter,
    onChange,
    onFormatChange,
    onNameClick,
    onSuggestionClick,
    onSpellingClick,
    onGrammarClick,
    onUnsupportedMarkdown,
    readOnly,
  };
  const lastFormat = useRef<FormatState | null>(null);
  // Saving starts off and is switched on in onCreate once the editor is known
  // to reproduce the chapter exactly. Until then, nothing reaches onChange:
  // a transaction before "create" (the matcher refresh, or StarterKit adding
  // a trailing paragraph) would otherwise save Markdown the schema dropped.
  const canSave = useRef(false);
  // The Markdown loaded at mount, which the check compares against; the
  // prop can already hold a later version by the time "create" fires.
  const loaded = useRef(markdown);
  const created = useRef(false);
  /** Edits and format commands are taken only when saving is on and the editor is not read-only. */
  const takesEdits = () => canSave.current && !latest.current.readOnly;

  const report = (editor: Editor) => {
    const format = formatOf(editor);
    if (sameFormat(lastFormat.current, format)) return;
    lastFormat.current = format;
    latest.current.onFormatChange?.(format);
  };

  const editor = useEditor({
    extensions: [
      ...chapterExtensions(),
      NameHighlight.configure({
        getMatcher: () => latest.current.matcher,
        getSuggestions: () => latest.current.suggestions,
        getMisspelled: () => latest.current.misspelled,
        getGrammar: () => latest.current.grammar,
      }),
      TypingExtras.configure({
        getAids: () => (takesEdits() ? latest.current.typingAids : null),
        isTypewriter: () => latest.current.typewriter,
      }),
    ],
    content: markdown,
    contentType: "markdown",
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "chapter-text",
        // The WebView's checker can't learn the project's names.
        spellcheck: "false",
        "aria-label": ariaLabel ?? "Chapter text",
      },
      handleClick(_view, _pos, event) {
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
    },
    onCreate({ editor }) {
      canSave.current = keepsChapterExactly(editor, loaded.current);
      created.current = true;
      editor.setEditable(takesEdits(), false);
      if (!canSave.current) latest.current.onUnsupportedMarkdown?.();
      if (initialCaret) {
        const { state } = editor;
        const pos = textToPmPosition(state.doc, initialCaret);
        editor.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos))).scrollIntoView());
      }
      if (takesEdits() && shouldFocusOnMount()) editor.commands.focus();
      report(editor);
    },
    onUpdate({ editor }) {
      if (canSave.current) latest.current.onChange(editor.getMarkdown());
    },
    onSelectionUpdate({ editor }) {
      report(editor);
    },
    onTransaction({ editor }) {
      report(editor);
    },
  });

  // Read-only can change while the editor is open (another project opening);
  // takesEdits reads it from `latest`. Before "create", onCreate sets it.
  useEffect(() => {
    if (editor && !editor.isDestroyed && created.current) editor.setEditable(takesEdits(), false);
  }, [editor, readOnly]);

  // A new matcher (a sheet was added or renamed), new possible names or misspelled words: mark everything again.
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(nameHighlightKey, REFRESH_NAMES));
    }
  }, [editor, matcher, suggestions, misspelled, grammar]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor?.commands.focus();
      },
      toggleBold: () => {
        if (takesEdits()) editor?.chain().focus().toggleBold().run();
      },
      toggleItalic: () => {
        if (takesEdits()) editor?.chain().focus().toggleItalic().run();
      },
      setBlockStyle: (style) => {
        if (!editor || !takesEdits()) return;
        const chain = editor.chain().focus();
        if (style === "body") chain.clearNodes();
        else if (style === "heading" && !editor.isActive("heading")) chain.clearNodes().setHeading({ level: 2 });
        else if (style === "quote" && !editor.isActive("blockquote")) chain.clearNodes().setBlockquote();
        chain.run();
      },
      insertSceneBreak: () => {
        if (takesEdits()) editor?.chain().focus().setHorizontalRule().run();
      },
      getCaret: () =>
        editor ? pmPositionToText(editor.state.doc, editor.state.selection.head) : { block: 0, offset: 0 },
      wordAt: (x, y) => (editor && !editor.isDestroyed ? wordAtPoint(editor.view, x, y) : null),
      selectedName: () => (editor && !editor.isDestroyed ? selectedNameIn(editor.state) : ""),
      selectionContains: (x, y) => (editor && !editor.isDestroyed ? selectionContainsPoint(editor.view, x, y) : false),
      spellingWordAt: (x, y) => (editor && !editor.isDestroyed ? spellingWordAtPoint(editor.view, x, y) : null),
      markRange: (mark) => (editor && !editor.isDestroyed ? markRangeIn(editor.view, mark) : null),
      replaceWord: (word, text) => !!editor && !editor.isDestroyed && takesEdits() && replaceWordIn(editor.view, word, text),
    }),
    [editor],
  );

  return <EditorContent editor={editor} className={className} />;
}
