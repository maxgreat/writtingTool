import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { Backend } from "../core/backend";

/*
 * Android's Back button. Each press closes one thing, the one on top, as
 * Escape does on a desktop: a menu or popover, a sheet from the bottom, a
 * confirmation, a name being typed, a phone's side panel. With nothing open
 * (the main screen), it closes the app, once pending edits are saved.
 *
 * What Back can close says so while it is open (useBackLayer, BackLayer).
 * Layers form a tree that follows the components, through portals: a menu
 * opened in the binder belongs to the binder's panel, so it closes first,
 * whichever of the two React registered first (it registers children
 * first). Of open layers side by side, the one opened last is on top.
 *
 * Escape itself can't stand in for Back: some of its handlers only listen
 * where focus is (a confirmation, a field), some close without saying so,
 * and a key, even a made-up one, also dismisses what goes at the next key.
 */

/**
 * Back on the main screen: decides whether the app may close (pending edits
 * are saved first), then closes it, unless `nothingOpen()` says something
 * was opened meanwhile.
 */
export type Leave = (nothingOpen: () => boolean) => Promise<void>;

/** Said in the save error when Back can't save: how to leave anyway. */
export const BACK_AGAIN = "Press Back again to close the app without them.";

interface Layer {
  /** Back closes it, once its own open layers are closed. */
  open: boolean;
  /** Off screen, with all it holds (a closed side panel): none of its layers count. */
  hidden: boolean;
  /** When it opened: of two open layers side by side, the later one is on top. */
  openedAt: number;
  close(): void;
  /** Layers inside it. Those of a layer that is neither open nor hidden count as its parent's. */
  readonly layers: Set<Layer>;
}

interface Stack {
  root: Layer;
  /** What Back does on the main screen, set by the screen shown (the latest wins over the app's own). */
  leaves: Leave[];
}

interface Scope {
  stack: Stack;
  /** The layer new layers go in. */
  layer: Layer;
}

const BackContext = createContext<Scope | null>(null);

let openings = 0;

/** The open layers directly in `layer`, looking through those that are neither open nor hidden. */
function openLayers(layer: Layer): Layer[] {
  return [...layer.layers].flatMap((inner) => (inner.hidden ? [] : inner.open ? [inner] : openLayers(inner)));
}

/** The layer Back closes now: the last opened, and in it, its own on top. Null on the main screen. */
function topLayer(layer: Layer): Layer | null {
  const open = openLayers(layer);
  if (open.length === 0) return null;
  const last = open.reduce((a, b) => (b.openedAt > a.openedAt ? b : a));
  return topLayer(last) ?? last;
}

/**
 * Something Back closes while `open`, by calling `onBack`, as Escape would.
 * `onBack` may leave it open (something under way that can't be left): the
 * press is spent all the same, so nothing under it closes. `hidden`: off
 * screen, its layers inside don't count either. Resolves to the scope for
 * layers inside it (see BackLayer); does nothing outside a BackStack.
 */
export function useBackLayer(open: boolean, onBack: () => void, hidden = false): Scope | null {
  const parent = useContext(BackContext);
  const [layer] = useState<Layer>(() => ({ open: false, hidden: false, openedAt: 0, close: onBack, layers: new Set() }));

  useLayoutEffect(() => {
    layer.close = onBack;
    layer.hidden = hidden;
  });

  useLayoutEffect(() => {
    if (!parent) return;
    const { layers } = parent.layer;
    layers.add(layer);
    return () => {
      layers.delete(layer);
    };
  }, [parent, layer]);

  useLayoutEffect(() => {
    if (!open) return;
    layer.open = true;
    layer.openedAt = ++openings;
    return () => {
      layer.open = false;
    };
  }, [open, layer]);

  return useMemo(() => (parent ? { stack: parent.stack, layer } : null), [parent, layer]);
}

/** useBackLayer, for something that holds other layers: those inside close before it. */
export function BackLayer({
  open,
  onBack,
  hidden,
  children,
}: {
  open: boolean;
  onBack(): void;
  hidden?: boolean;
  children: ReactNode;
}) {
  const scope = useBackLayer(open, onBack, hidden);
  return <BackContext.Provider value={scope}>{children}</BackContext.Provider>;
}

/** What Back does on the main screen while this component is shown, in place of the BackStack's own `leave`. */
export function useLeaveOnBack(leave: Leave): void {
  const scope = useContext(BackContext);
  const latest = useRef(leave);
  useLayoutEffect(() => {
    latest.current = leave;
  });
  useLayoutEffect(() => {
    if (!scope) return;
    const { leaves } = scope.stack;
    const entry: Leave = (nothingOpen) => latest.current(nothingOpen);
    leaves.push(entry);
    return () => {
      leaves.splice(leaves.indexOf(entry), 1);
    };
  }, [scope]);
}

/**
 * Handles Back, where the backend has one (Android): around the whole app,
 * so the screens shown before a project opens close the app too. `leave` is
 * what Back does on the main screen, unless the screen shown says otherwise
 * (useLeaveOnBack). Elsewhere nothing changes: there is no Back to handle.
 *
 * One press at a time: a layer closes at once (its screen is updated before
 * the next press is read), and while the app is deciding whether it may
 * close, other presses are ignored, so a second one can neither close it
 * nor count as the press that leaves without unsaved edits.
 */
export function BackStack({ backend, leave, children }: { backend: Backend | null; leave: Leave; children: ReactNode }) {
  const [scope] = useState<Scope>(() => {
    const root: Layer = { open: true, hidden: false, openedAt: 0, close: () => undefined, layers: new Set() };
    return { stack: { root, leaves: [] }, layer: root };
  });
  const latest = useRef(leave);
  useLayoutEffect(() => {
    latest.current = leave;
  });
  const leaving = useRef(false);

  const press = useCallback(() => {
    if (leaving.current) return;
    const { root, leaves } = scope.stack;
    const top = topLayer(root);
    if (top) {
      try {
        flushSync(() => top.close());
      } catch (error) {
        console.error("Back couldn’t close what is open", error);
      }
      return;
    }
    leaving.current = true;
    const run = leaves.at(-1) ?? latest.current;
    void (async () => {
      try {
        await run(() => topLayer(root) === null);
      } catch (error) {
        console.error("Back couldn’t close the app", error);
      } finally {
        leaving.current = false;
      }
    })();
  }, [scope]);

  useEffect(() => {
    if (!backend?.onBackButton) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    backend.onBackButton(press).then(
      (unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      },
      (error: unknown) => console.error("Can’t handle the Back button", error),
    );
    return () => {
      disposed = true;
      stop?.();
    };
  }, [backend, press]);

  return <BackContext.Provider value={scope}>{children}</BackContext.Provider>;
}
