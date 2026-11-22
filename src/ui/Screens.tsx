import type { ViewSettings } from "../core/settings";
import { cx } from "./dom";
import { editorStyle, panelStyle } from "./layoutStyle";

const ROWS = ["long", "medium", "long", "short", "medium"] as const;
const PARAGRAPH = ["long", "long", "long", "medium"] as const;

/**
 * Shown while the project opens: the window's real layout, with placeholder
 * lines where the binder, text and inspector will be, so nothing jumps.
 */
export function LoadingScreen({ settings, isPhone }: { settings: ViewSettings; isPhone: boolean }) {
  return (
    <div className={cx("workspace", isPhone ? "is-phone" : "is-desktop")} style={panelStyle(settings)} aria-busy="true">
      <p className="visually-hidden" role="status">
        Opening the project…
      </p>
      <header className="bar-slot">
        <div className="format-bar format-bar--skeleton" aria-hidden>
          <span className="skeleton skeleton--chip" />
          <span className="skeleton skeleton--chip" />
          <span className="skeleton skeleton--chip" />
        </div>
      </header>
      <div className="workspace-main" aria-hidden>
        {!isPhone && (
          <div className={cx("panel panel--binder", settings.binderOpen && "is-open")}>
            <div className="panel-inner skeleton-panel">
              <span className="skeleton skeleton--title" />
              {ROWS.map((width, i) => (
                <span key={i} className={`skeleton skeleton--${width}`} />
              ))}
            </div>
          </div>
        )}
        <main className="editor-pane" style={editorStyle(settings)}>
          <div className="editor-column skeleton-text">
            <span className="skeleton skeleton--heading" />
            {[0, 1].map((p) => (
              <div key={p} className="skeleton-paragraph">
                {PARAGRAPH.map((width, i) => (
                  <span key={i} className={`skeleton skeleton--${width}`} />
                ))}
              </div>
            ))}
          </div>
        </main>
        {!isPhone && (
          <div className={cx("panel panel--inspector", settings.inspectorOpen && "is-open")}>
            <div className="panel-inner skeleton-panel">
              <span className="skeleton skeleton--medium" />
              {ROWS.slice(0, 3).map((width, i) => (
                <span key={i} className={`skeleton skeleton--${width}`} />
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="status-bar" aria-hidden>
        <span className="skeleton skeleton--chip" />
      </footer>
    </div>
  );
}

/** Shown when the project could not be opened at all. */
export function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="error-screen">
      <div className="error-content" role="alert">
        <h1>Writing Tool couldn’t open the project</h1>
        <p className="error-message">{message}</p>
        <p className="muted">Nothing in the project was changed.</p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    </main>
  );
}
