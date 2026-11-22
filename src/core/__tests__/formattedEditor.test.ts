// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormattedEditor } from "../editor/FormattedEditor";
import type { EditorHandle } from "../editor/types";
import { NameMatcher } from "../names";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function mount(markdown: string, readOnly = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onChange = vi.fn();
  const onUnsupportedMarkdown = vi.fn();
  const ref = createRef<EditorHandle>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const matcher = new NameMatcher([]);
  const render = (readOnlyNow: boolean) =>
    root.render(
      createElement(FormattedEditor, { ref, markdown, matcher, onChange, onUnsupportedMarkdown, readOnly: readOnlyNow }),
    );
  await act(async () => {
    render(readOnly);
  });
  // Tiptap reports "create" on the next tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const setReadOnly = (value: boolean) =>
    act(async () => {
      render(value);
    });
  return { onChange, onUnsupportedMarkdown, ref, container, setReadOnly };
}

describe("formatted editor and Markdown it cannot keep", () => {
  it("is read-only and never saves such a chapter, even through the format commands", async () => {
    const editor = await mount("- Bonjour, dit-elle.\n- Bonsoir.\n");
    expect(editor.onUnsupportedMarkdown).toHaveBeenCalledTimes(1);
    expect(editor.container.querySelector('[contenteditable="false"]')).not.toBeNull();
    await act(async () => {
      editor.ref.current?.toggleBold();
      editor.ref.current?.toggleItalic();
      editor.ref.current?.setBlockStyle("heading");
      editor.ref.current?.insertSceneBreak();
    });
    expect(editor.onChange).not.toHaveBeenCalled();
  });

  it("does not save before the check, even when a list is the last block", async () => {
    // StarterKit adds a trailing paragraph and the name refresh dispatches
    // before Tiptap's "create": neither may save the list-less text.
    const editor = await mount("# Lists\n\n- Bonjour.\n- Bonsoir.\n");
    expect(editor.onChange).not.toHaveBeenCalled();
    expect(editor.onUnsupportedMarkdown).toHaveBeenCalledTimes(1);
  });

  it("saves edits to a chapter inside the subset", async () => {
    const editor = await mount("Elena waits.\n");
    expect(editor.onUnsupportedMarkdown).not.toHaveBeenCalled();
    await act(async () => {
      editor.ref.current?.insertSceneBreak();
    });
    expect(editor.onChange).toHaveBeenCalled();
  });
});

describe("formatted editor while read-only", () => {
  it("takes no edits or format commands, and takes them again once editable", async () => {
    const editor = await mount("Elena waits.\n", true);
    expect(editor.container.querySelector('[contenteditable="false"]')).not.toBeNull();
    await act(async () => {
      editor.ref.current?.insertSceneBreak();
      editor.ref.current?.toggleBold();
    });
    expect(editor.onChange).not.toHaveBeenCalled();

    await editor.setReadOnly(false);
    expect(editor.container.querySelector('[contenteditable="true"]')).not.toBeNull();
    await act(async () => {
      editor.ref.current?.insertSceneBreak();
    });
    expect(editor.onChange).toHaveBeenCalled();
  });
});
