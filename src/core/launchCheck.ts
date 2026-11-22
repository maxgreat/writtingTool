import { invoke, isTauri } from "@tauri-apps/api/core";

/** The editable element of either chapter editor (FormattedEditor, PlainEditor). */
const CHAPTER_EDITOR = ".chapter-text, .chapter-text-plain";

/**
 * Tells the Rust core, once, that a chapter is open in an editor: the
 * interface loaded, read the project and rendered. The core ignores this
 * except during a launch check (.githooks/verify-launch), when it quits.
 */
export function reportWhenChapterShows(root: ParentNode & Node = document.body): void {
  if (!isTauri()) return;
  const report = () => {
    invoke("frontend_ready").catch((error: unknown) => console.error("frontend_ready failed", error));
  };
  if (root.querySelector(CHAPTER_EDITOR)) {
    report();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!root.querySelector(CHAPTER_EDITOR)) return;
    observer.disconnect();
    report();
  });
  observer.observe(root, { childList: true, subtree: true });
}
