import { useSyncExternalStore } from "react";

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
