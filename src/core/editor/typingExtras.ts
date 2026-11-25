import { Extension } from "@tiptap/core";
import { typewriterPlugin } from "./typewriter";
import { typingAidsPlugin, type TypingAids } from "./typingAids";

interface TypingExtrasOptions {
  /** The typing aids in force, read at each key; null: none. */
  getAids: () => TypingAids | null;
  /** Whether typewriter scrolling is on, read at each change. */
  isTypewriter: () => boolean;
}

/** The formatted editor's typing aids and typewriter scrolling (see typingAids.ts and typewriter.ts). */
export const TypingExtras = Extension.create<TypingExtrasOptions>({
  name: "typingExtras",
  addOptions() {
    return { getAids: () => null, isTypewriter: () => false };
  },
  addProseMirrorPlugins() {
    return [typingAidsPlugin(() => this.options.getAids()), typewriterPlugin(() => this.options.isTypewriter())];
  },
});
