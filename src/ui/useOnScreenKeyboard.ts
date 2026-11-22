import { useEffect, useState, useSyncExternalStore } from "react";

/*
 * The on-screen keyboard, as the app's shell reports it. From inside the page
 * a keyboard and a shorter window (a split-screen divider or a freeform
 * window's edge dragged) look the same, so the page doesn't guess from its
 * size. The shell, which knows, sets data-on-screen-keyboard="shown" or
 * "hidden" on the root element whenever the keyboard is shown or hidden, then
 * fires "onscreenkeyboardchange" on the window. The Android shell does
 * (MainActivity.kt, tellPage). Where nothing sends it (desktop, the browser
 * preview, iOS until its shell does the same) the attribute is never set and
 * the keyboard never counts as up.
 */

function subscribe(onChange: () => void): () => void {
  window.addEventListener("onscreenkeyboardchange", onChange);
  return () => window.removeEventListener("onscreenkeyboardchange", onChange);
}

const shellSaysShown = () => document.documentElement.dataset.onScreenKeyboard === "shown";

/**
 * Whether the on-screen keyboard is up for an element inside `scope` (a CSS
 * selector): the shell says the keyboard is shown, focus is in the scope, and
 * `enabled` is on.
 *
 * The shell's word is read on mount and again on each
 * "onscreenkeyboardchange". Focus moving within the scope, or staying there
 * through a tap on a button that keeps it (Bold, Italic), is not leaving.
 * Focus and the shell's word are followed whether or not `enabled` is on, so
 * the answer is right as soon as it turns on.
 */
export function useOnScreenKeyboard(enabled: boolean, scope: string): boolean {
  const shown = useSyncExternalStore(subscribe, shellSaysShown);
  const [focusInScope, setFocusInScope] = useState(false);

  useEffect(() => {
    const inScope = (element: Element | null) => element !== null && element.closest(scope) !== null;
    const onFocusIn = (event: FocusEvent) => {
      setFocusInScope(inScope(event.target instanceof Element ? event.target : null));
    };
    // Where focus goes next, so a move within the scope never counts as leaving it.
    const onFocusOut = (event: FocusEvent) => {
      setFocusInScope(inScope(event.relatedTarget instanceof Element ? event.relatedTarget : null));
    };

    setFocusInScope(inScope(document.activeElement));
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [scope]);

  return enabled && shown && focusInScope;
}
