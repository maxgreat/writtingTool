import { isolateHistory } from "@codemirror/commands";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { typedText, type Replacement, type Typography } from "../typography";
import { blockText } from "./prosemirror";

/*
 * Typing aids in both editors: what a typed character becomes, from
 * typedText (typography.ts). The character is typed first, then changed in
 * a step of its own, so Undo brings back what was typed ("--" after "—").
 * Nothing changes while an on-screen keyboard is composing a word: the
 * keyboard owns that text until it commits it.
 */

/** The rules in force, read at each key: null turns the aids off. */
export interface TypingAids {
  rules: Typography;
  replacements: readonly Replacement[];
}

export const typingAidsKey = new PluginKey("typingAids");

/** The common start and end of two texts, never splitting a character made of two code units. */
function commonEnds(a: string, b: string): { start: number; end: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/u.test(a[start - 1])) start--;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  if (end > 0 && /[\uDC00-\uDFFF]/u.test(a[a.length - end])) end--;
  return { start, end };
}

/** The formatted editor's typing aids. */
export function typingAidsPlugin(getAids: () => TypingAids | null): Plugin {
  return new Plugin({
    key: typingAidsKey,
    props: {
      handleTextInput(view, from, to, text) {
        const aids = getAids();
        if (!aids || view.composing || [...text].length !== 1) return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        const before = blockText($from.parent).slice(0, $from.parentOffset);
        const change = typedText(before, text, aids.rules, aids.replacements);
        if (!change || change.replace > $from.parentOffset) return false;
        // As typed, then changed: Undo takes the change back first.
        view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
        // The text before the typed character keeps its formatting, and the character its own:
        // only what differs is rewritten, each part in its place ("teh" in italics, then a plain space).
        const tr = closeHistory(view.state.tr);
        const oldHead = before.slice(before.length - change.replace);
        const head = change.insert.slice(0, change.insert.length - change.typed.length);
        const start = from - change.replace;
        if (head !== oldHead) {
          const same = commonEnds(oldHead, head);
          const middle = head.slice(same.start, head.length - same.end);
          const range = [start + same.start, from - same.end] as const;
          if (middle === "") tr.delete(...range);
          else if (range[0] === range[1]) {
            // Only added letters ("u" becoming "you"): they take the formatting of the replaced text
            // beside them, inside it, not of whatever comes before it.
            const beside = same.start > 0 ? range[0] - 1 : range[0];
            tr.insert(range[0], view.state.schema.text(middle, tr.doc.nodeAt(beside)?.marks ?? []));
          } else tr.insertText(middle, ...range);
        }
        const typedAt = from + head.length - oldHead.length;
        if (change.typed !== text) tr.insertText(change.typed, typedAt, typedAt + text.length);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}

/** The plain editor's typing aids. */
export function typingAidsHandler(getAids: () => TypingAids | null) {
  return CodeMirrorView.inputHandler.of((view, from, to, text) => {
    const aids = getAids();
    if (!aids || view.compositionStarted || [...text].length !== 1) return false;
    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    const change = typedText(before, text, aids.rules, aids.replacements);
    if (!change || change.replace > before.length) return false;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    const end = from + text.length;
    view.dispatch({
      changes: { from: from - change.replace, to: end, insert: change.insert },
      selection: { anchor: from - change.replace + change.insert.length },
      userEvent: "input.type",
      annotations: isolateHistory.of("before"),
      scrollIntoView: true,
    });
    return true;
  });
}
