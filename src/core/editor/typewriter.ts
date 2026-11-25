import { ViewPlugin, type EditorView as CodeMirrorView, type ViewUpdate } from "@codemirror/view";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView as ProseMirrorView } from "@tiptap/pm/view";

/*
 * Typewriter scrolling: the line being typed stays in the middle of the
 * screen, as on a typewriter, and the text moves up under it. The chapter
 * scrolls in the nearest scrolling element around the editor (the editor
 * pane). Only edits and caret moves from the keyboard move it; a click or
 * a scroll by hand doesn't, so reading back stays possible.
 */

/** The nearest element around `node` that scrolls vertically. */
function scrollerOf(node: Element): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/u.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/**
 * Scrolls `scroller` so a caret at `caretTop`–`caretBottom` (client
 * coordinates) sits at its middle. Small moves (under a few pixels) are
 * left alone, so typing along a line doesn't jitter.
 */
export function centerCaret(scroller: HTMLElement, caretTop: number, caretBottom: number): void {
  const box = scroller.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  const caretMiddle = (caretTop + caretBottom) / 2;
  const delta = caretMiddle - middle;
  if (Math.abs(delta) < 4) return;
  scroller.scrollTop += delta;
}

/** One measure per frame, after the editor has drawn the change. */
function onNextFrame(run: () => void): () => void {
  let frame = 0;
  return () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      run();
    });
  };
}

export const typewriterKey = new PluginKey("typewriter");

/** The formatted editor's typewriter scrolling, while `isOn()` holds. */
export function typewriterPlugin(isOn: () => boolean): Plugin {
  return new Plugin({
    key: typewriterKey,
    view(view: ProseMirrorView) {
      const center = onNextFrame(() => {
        if (!isOn() || view.isDestroyed || !view.hasFocus()) return;
        const scroller = scrollerOf(view.dom);
        if (!scroller) return;
        const { top, bottom } = view.coordsAtPos(view.state.selection.head);
        centerCaret(scroller, top, bottom);
      });
      return {
        update(updated, previous) {
          const moved = !updated.state.selection.eq(previous.selection) || !updated.state.doc.eq(previous.doc);
          // A click places the caret where the writer looks: only typing and keys move the page.
          if (moved && !updated.dom.matches(":active")) center();
        },
      };
    },
  });
}

/** The plain editor's typewriter scrolling, while `isOn()` holds. */
export function typewriterExtension(isOn: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      center: () => void;
      constructor(view: CodeMirrorView) {
        this.center = onNextFrame(() => {
          if (!isOn() || !view.hasFocus) return;
          const scroller = scrollerOf(view.dom);
          const head = view.state.selection.main.head;
          const coords = view.coordsAtPos(head);
          if (scroller && coords) centerCaret(scroller, coords.top, coords.bottom);
        });
      }
      update(update: ViewUpdate) {
        const fromPointer = update.transactions.some((tr) => tr.isUserEvent("select.pointer"));
        if ((update.docChanged || update.selectionSet) && !fromPointer) this.center();
      }
    },
  );
}
