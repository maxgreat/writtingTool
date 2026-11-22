//! The Rust core. The interface never touches files itself: it asks these
//! commands, and the core owns the project folder.

mod project;

use std::path::PathBuf;
use std::sync::Mutex;

use project::{ProjectRoot, ProjectSnapshot};
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

/// Replaces one file of the open project, atomically. `root` is the root the
/// interface got with the project's snapshot: a save meant for a project that
/// is no longer open is refused, so it can never land in another project.
#[tauri::command]
async fn write_project_file(root: String, path: String, text: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.project.lock().map_err(|_| "The project state is unavailable.")?;
    let open = guard.as_ref().ok_or("No project is open.")?;
    if !open.is_at(&root) {
        return Err(format!("Cannot save {path}: that project is no longer open."));
    }
    open.write(&path, &text).map_err(|e| format!("Cannot save {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_sample_project,
            open_project,
            write_project_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
