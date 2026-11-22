//! The Rust core. The interface never touches files itself: it asks these
//! commands, and the core owns the project folder.

mod project;

use std::path::PathBuf;
use std::sync::Mutex;

use project::{Change, ProjectRoot, ProjectSnapshot, Version};
use tauri::{AppHandle, Manager, State};

/// The open project. The lock is held for a whole command, so two writes or
/// an open and a write never interleave.
#[derive(Default)]
struct AppState {
    project: Mutex<Option<ProjectRoot>>,
}

fn open_into(state: &mut Option<ProjectRoot>, dir: PathBuf) -> Result<ProjectSnapshot, String> {
    let root = ProjectRoot::open(&dir).map_err(|e| format!("Cannot open {}: {e}", dir.display()))?;
    let snapshot = root
        .snapshot()
        .map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
    *state = Some(root);
    Ok(snapshot)
}

/// Opens the sample project kept in the app's data folder, installing it on
/// first run.
#[tauri::command]
async fn open_sample_project(app: AppHandle, state: State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    let mut guard = state.project.lock().map_err(|_| "The project state is unavailable.")?;
    let projects = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot find the app data folder: {e}"))?
        .join("projects");
    let dir = project::install_sample(&projects)
        .map_err(|e| format!("Cannot install the sample project in {}: {e}", projects.display()))?;
    open_into(&mut guard, dir)
}

/// Opens a project folder the user picked.
#[tauri::command]
async fn open_project(path: String, state: State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    let mut guard = state.project.lock().map_err(|_| "The project state is unavailable.")?;
    open_into(&mut guard, PathBuf::from(path))
}

/// Runs `action` on the open project. `root` is the root the interface got
/// with the project's snapshot: a request meant for a project that is no
/// longer open is refused, so it can never land in another project.
fn with_open<T>(
    state: &State<'_, AppState>,
    root: &str,
    what: &str,
    action: impl FnOnce(&ProjectRoot) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.project.lock().map_err(|_| "The project state is unavailable.")?;
    let open = guard.as_ref().ok_or("No project is open.")?;
    if !open.is_at(root) {
        return Err(format!("Cannot {what}: that project is no longer open."));
    }
    action(open)
}

/// Replaces one file of the open project, atomically. A chapter's previous
/// text is kept as a version first. If that fails the text is still saved,
/// and the reason comes back as a warning.
#[tauri::command]
async fn write_project_file(
    root: String,
    path: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    with_open(&state, &root, &format!("save {path}"), |open| {
        let warning = open
            .keep_before_write(&path, &text)
            .err()
            .map(|e| format!("Saved, but the previous version of {path} could not be kept: {e}"));
        open.write(&path, &text).map_err(|e| format!("Cannot save {path}: {e}"))?;
        Ok(warning)
    })
}

/// The kept versions of a chapter, newest first.
#[tauri::command]
async fn list_versions(root: String, chapter: String, state: State<'_, AppState>) -> Result<Vec<Version>, String> {
    with_open(&state, &root, "list the versions", |open| {
        open.versions(&chapter)
            .map_err(|e| format!("Cannot list the versions of {chapter}: {e}"))
    })
}

/// Puts a kept version back as the chapter's text and returns that text.
#[tauri::command]
async fn restore_version(
    root: String,
    chapter: String,
    saved_at: u64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    with_open(&state, &root, "restore the version", |open| {
        open.restore_version(&chapter, saved_at)
            .map_err(|e| format!("Cannot restore that version of {chapter}: {e}"))
    })
}

/// Makes a change to the binder as a whole or not at all, then returns the
/// project as it is on disk afterwards.
#[tauri::command]
async fn apply_changes(root: String, change: Change, state: State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    with_open(&state, &root, "change the binder", |open| {
        open.apply(&change).map_err(|e| format!("Cannot change the binder: {e}. Nothing was changed."))?;
        open.snapshot().map_err(|e| format!("The binder was changed, but the project could not be read again: {e}"))
    })
}

/// Set by `.githooks/verify-launch` to check that a build starts.
const LAUNCH_CHECK_VAR: &str = "WRITING_TOOL_LAUNCH_CHECK";

/// The interface reports that a chapter is open in the editor. During a launch
/// check that means the app works, so it says so and quits; otherwise this
/// does nothing.
#[tauri::command]
fn frontend_ready(app: AppHandle) {
    if std::env::var_os(LAUNCH_CHECK_VAR).is_some() {
        println!("launch check: a chapter is open in the editor");
        app.exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_sample_project,
            open_project,
            write_project_file,
            list_versions,
            restore_version,
            apply_changes,
            frontend_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
