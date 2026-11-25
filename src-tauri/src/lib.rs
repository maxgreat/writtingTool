//! The Rust core. The interface never touches files itself: it asks these
//! commands, and the core owns the project folder.

mod dictionary;
mod dropbox;
pub mod export;
pub mod grammar;
pub mod languagetool;
mod project;
mod projects;

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use project::{Change, FileWrite, ProjectRoot, ProjectSnapshot, Version};
use projects::ProjectEntry;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use typst_layout::PagedDocument;

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

/// The app's own projects folder, in its data folder.
fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot find the app data folder: {e}"))?
        .join("projects"))
}

/// What this device can do that others can't.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    /// Desktops can show a folder picker and open a project from any folder.
    /// On phones, projects live in the app's own folder.
    can_open_folders: bool,
    /// This build can connect to Dropbox: it was built with the app's key.
    dropbox: bool,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo { can_open_folders: cfg!(desktop), dropbox: dropbox::app_key().is_some() }
}

/// The projects in the app's own folder, then the `recent` folders opened
/// from elsewhere that still open.
#[tauri::command]
async fn list_projects(app: AppHandle, recent: Vec<String>) -> Result<Vec<ProjectEntry>, String> {
    let dir = projects_dir(&app)?;
    projects::list(&dir, &recent).map_err(|e| format!("Cannot list the projects in {}: {e}", dir.display()))
}

/// Creates a project in the app's own folder and opens it.
#[tauri::command]
async fn create_project(
    app: AppHandle,
    name: String,
    folders: Vec<String>,
    files: Vec<FileWrite>,
    state: State<'_, AppState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state.project.lock().map_err(|_| "The project state is unavailable.")?;
    let dir = projects_dir(&app)?;
    let created = projects::create(&dir, &name, &folders, &files)
        .map_err(|e| format!("Cannot create the project in {}: {e}", dir.display()))?;
    open_into(&mut guard, created)
}

/// Opens the sample project kept in the app's data folder, installing it on
/// first run.
#[tauri::command]
async fn open_sample_project(app: AppHandle, state: State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    let mut guard = state.project.lock().map_err(|_| "The project state is unavailable.")?;
    let projects = projects_dir(&app)?;
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

/// Makes a change to the binder or the sheets as a whole or not at all, then
/// returns the project as it is on disk afterwards.
#[tauri::command]
async fn apply_changes(root: String, change: Change, state: State<'_, AppState>) -> Result<ProjectSnapshot, String> {
    with_open(&state, &root, "change the project", |open| {
        open.apply(&change).map_err(|e| format!("Cannot make that change: {e}. Nothing was changed."))?;
        open.snapshot().map_err(|e| format!("The change was made, but the project could not be read again: {e}"))
    })
}

/// For each word, whether it is an ordinary word of `language` (a project
/// language such as "en-GB") written with a capital, rather than a name.
/// None when no dictionary is bundled for the language.
#[tauri::command]
async fn ordinary_words(language: String, words: Vec<String>) -> Result<Option<Vec<bool>>, String> {
    dictionary::ordinary_words(&language, &words)
}

/// For each word, whether the dictionary of `language` (a project language
/// such as "fr-CA") spells it this way. None when no dictionary is bundled
/// for the language.
#[tauri::command]
async fn check_words(language: String, words: Vec<String>) -> Result<Option<Vec<bool>>, String> {
    dictionary::check_words(&language, &words)
}

/// Corrections for a misspelled word, best first. None when no dictionary
/// is bundled for the language.
#[tauri::command]
async fn suggest_words(language: String, word: String) -> Result<Option<Vec<String>>, String> {
    dictionary::suggest(&language, &word)
}

/// Each paragraph's grammar problems: the writer's LanguageTool server when
/// one is set, else Harper for English. None when nothing checks the
/// language. Paragraphs are their text as it reads, without Markdown.
#[tauri::command]
async fn check_grammar(
    language: String,
    paragraphs: Vec<String>,
    server: Option<languagetool::Server>,
) -> Result<Option<Vec<Vec<grammar::Problem>>>, String> {
    match server {
        Some(server) => languagetool::check(&server, &language, &paragraphs).map(Some),
        None => grammar::check(&language, &paragraphs),
    }
}


/// The last pages laid out for the export preview, and the number naming
/// them: a page is only ever drawn from the layout it was asked for.
#[derive(Default)]
struct ExportState {
    layout: Mutex<Option<(u64, PagedDocument)>>,
    generation: AtomicU64,
}

/// The pages laid out for the preview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookLayout {
    generation: u64,
    pages: usize,
    /// A page's size in points.
    width: f64,
    height: f64,
    chapter_pages: Vec<usize>,
}

/// Lays the book out for the export preview, and keeps the pages for book_page.
#[tauri::command]
async fn lay_out_book(book: export::Book, settings: export::Settings, state: State<'_, ExportState>) -> Result<BookLayout, String> {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let document = export::lay_out(&book, &settings)?;
    let (width, height) = export::page_size_pt(&document);
    let layout = BookLayout {
        generation,
        pages: document.pages().len(),
        width,
        height,
        chapter_pages: export::chapter_pages(&document),
    };
    let mut kept = state.layout.lock().map_err(|_| "The preview is unavailable.")?;
    // A slower, older layout never replaces a newer one.
    if kept.as_ref().is_none_or(|(g, _)| *g < generation) {
        *kept = Some((generation, document));
    }
    Ok(layout)
}

/// One page of a layout as SVG. Refused once a newer layout replaced it.
#[tauri::command]
async fn book_page(generation: u64, index: usize, state: State<'_, ExportState>) -> Result<String, String> {
    let kept = state.layout.lock().map_err(|_| "The preview is unavailable.")?;
    match kept.as_ref() {
        Some((g, document)) if *g == generation => {
            export::page_svg(document, index).ok_or_else(|| format!("There is no page {}.", index + 1))
        }
        _ => Err("That layout has been replaced.".into()),
    }
}

/// Writes the book in `format` where the writer chooses in the system's save
/// dialog. Resolves to the file's path, "" when the dialog gives an address
/// that isn't one (Android's content://), or None when it was cancelled.
#[tauri::command]
async fn export_book(
    app: AppHandle,
    book: export::Book,
    settings: export::Settings,
    format: export::Format,
    file_name: String,
) -> Result<Option<String>, String> {
    // Made first, so a failure shows before the dialog asks where.
    let bytes = export::write(&book, &settings, format)?;
    let (label, extension) = format.filter();
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter(label, &[extension])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    // Where it went, to show: a path on desktop. Android's save dialog gives a content:// address,
    // which says nothing to the writer, who has just chosen the place: "" then.
    let shown = match &path {
        tauri_plugin_fs::FilePath::Path(p) => p.display().to_string(),
        tauri_plugin_fs::FilePath::Url(url) => url.to_file_path().map(|p| p.display().to_string()).unwrap_or_default(),
    };
    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut file = app.fs().open(path, options).map_err(|e| format!("Cannot write the file: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("Cannot write the file: {e}"))?;
    Ok(Some(shown))
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init());
    // Dropbox sends a phone's browser back to the app through a link the app opens.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init()).setup(|app| {
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let state = handle.state::<dropbox::DropboxState>();
            for link in event.urls() {
                state.link_opened(link.as_str());
            }
        });
        Ok(())
    });
    builder
        .manage(AppState::default())
        .manage(ExportState::default())
        .manage(dropbox::DropboxState::default())
        .invoke_handler(tauri::generate_handler![
            open_sample_project,
            open_project,
            app_info,
            list_projects,
            create_project,
            write_project_file,
            list_versions,
            restore_version,
            apply_changes,
            ordinary_words,
            check_words,
            suggest_words,
            check_grammar,
            lay_out_book,
            book_page,
            export_book,
            dropbox::dropbox_status,
            dropbox::dropbox_sign_in_start,
            dropbox::dropbox_sign_in_finish,
            dropbox::dropbox_sign_in_cancel,
            dropbox::dropbox_sign_out,
            frontend_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
