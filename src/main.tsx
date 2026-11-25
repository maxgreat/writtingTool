import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { reportWhenChapterShows } from "./core/launchCheck";
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/workspace.css";
import "./ui/format-bar.css";
import "./ui/binder.css";
import "./ui/editor.css";
import "./ui/inspector.css";
import "./ui/status-bar.css";
import "./ui/screens.css";
import "./ui/close-dialog.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
reportWhenChapterShows();
