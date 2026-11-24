import { useEffect, useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

/** Phones: under about 700 px wide. Mirrors the 700 px breakpoint in the stylesheets. */
export const PHONE_QUERY = "(max-width: 699.98px)";
/** Devices with a real hover: the only ones that get hover cards. */
export const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Sets a textarea's height to its text's. */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * Makes a textarea as tall as its text (its `rows` are the least it shows),
 * so it grows and shrinks as the writer types, and as a wider or narrower
 * panel rewraps the text. The textarea must be there from the first render.
 */
export function useFitHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [ref, value]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}
