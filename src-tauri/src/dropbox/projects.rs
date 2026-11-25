//! Projects in the writer's Dropbox: which are there, putting a project
//! there, bringing one to this device, and syncing one.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::files::DropboxFiles;
use super::{DropboxState, read_connection, require_app_key};
use crate::project::{ProjectRoot, plain_segments};
use crate::projects::title_of;
use crate::sync::engine::{self, Outcome, Sync, SyncError};
use crate::sync::remote::{Remote, RemoteError};

/// The connected account's files.
fn files<'a>(state: &'a DropboxState, dir: &Path) -> Result<DropboxFiles<'a>, String> {
    require_app_key()?;
    let connection = read_connection(dir)?.ok_or("Connect Dropbox in Settings first.")?;
    Ok(DropboxFiles::new(state, dir.to_path_buf(), connection))
}

/// A project in Dropbox.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DropboxProject {
    /// Its folder in Dropbox, such as "/Night Ferry".
    pub folder: String,
    pub title: String,
    /// Its folder on this device, when it is here.
    pub local: Option<String>,
}

fn last_segment(path: &str) -> &str {
    path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path)
}

/// The title in a project.json's text, if it has one.
fn title_in(text: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let title = json.get("title")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// Which of `candidates`, project folders on this device, sync with which
/// folder of `account_id`'s Dropbox: folder without case → copy. The first
/// copy of a folder counts.
fn copies(candidates: &[PathBuf], account_id: &str) -> HashMap<String, PathBuf> {
    let mut here = HashMap::new();
    for candidate in candidates {
        if let Ok(Some(sync)) = engine::read_state(candidate) {
            if sync.account_id == account_id {
                here.entry(sync.remote_root.to_lowercase()).or_insert_with(|| candidate.clone());
            }
        }
    }
    here
}

/// The copy among `candidates` of the project in `folder` of the connected
/// Dropbox, if there is one; asks nothing of Dropbox.
pub fn local_copy(dir: &Path, candidates: &[PathBuf], folder: &str) -> Result<Option<PathBuf>, String> {
    let connection = read_connection(dir)?.ok_or("Connect Dropbox in Settings first.")?;
    Ok(local_copy_in(candidates, &connection.account.account_id, folder))
}

fn local_copy_in(candidates: &[PathBuf], account_id: &str, folder: &str) -> Option<PathBuf> {
    copies(candidates, account_id).remove(&folder.to_lowercase())
}

/// The projects in Dropbox, by title. `candidates` are the project folders
/// on this device that may be copies of them.
pub fn list(state: &DropboxState, dir: &Path, candidates: &[PathBuf]) -> Result<Vec<DropboxProject>, String> {
    let files = files(state, dir)?;
    let here = copies(candidates, files.account_id());
    let folders = files.top_folders().map_err(|e| e.message())?;
    let mut projects = Vec::new();
    for folder in folders {
        let local = here.get(&folder.to_lowercase()).cloned();
        let title = match &local {
            Some(path) => title_of(path),
            None => match files.download(&format!("{folder}/project.json")) {
                Ok((_, bytes)) => String::from_utf8(bytes).ok().as_deref().and_then(title_in),
                // A folder without project.json may still be a project (a manuscript folder is enough).
                Err(RemoteError::NotFound) => None,
                Err(e) => return Err(e.message()),
            }
            .unwrap_or_else(|| last_segment(&folder).to_string()),
        };
        projects.push(DropboxProject { folder, title, local: local.map(|p| p.to_string_lossy().into_owned()) });
    }
    projects.sort_by_key(|p| p.title.to_lowercase());
    Ok(projects)
}

/// How a sync went, for the interface.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SyncResult {
    /// The project is on this device only.
    Off,
    /// The project syncs, but no Dropbox account is connected.
    SignedOut,
    Done { outcome: Outcome },
}

/// Syncs the project at `root`, if it is in Dropbox. `lock` is held while
/// its files are read and written.
pub fn sync<T>(state: &DropboxState, dir: &Path, root: &Path, lock: &Mutex<T>) -> Result<SyncResult, String> {
    if engine::read_state(root).map_err(|e| e.to_string())?.is_none() {
        return Ok(SyncResult::Off);
    }
    if require_app_key().is_err() || read_connection(dir)?.is_none() {
        return Ok(SyncResult::SignedOut);
    }
    let files = files(state, dir)?;
    let mut sync = Sync::open(&files, root, files.account_id())
        .map_err(|e| e.message())?
        .ok_or("The project is no longer in Dropbox.")?;
    let outcome = sync.run(lock).map_err(|e| e.message())?;
    Ok(SyncResult::Done { outcome })
}

/// A folder name in `taken` (compared without case) or, if that one is taken, "name 2", "name 3"…
fn free_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    (1..)
        .map(|n| if n == 1 { name.to_string() } else { format!("{name} {n}") })
        .find(|candidate| !taken(candidate))
        .expect("an endless range always has a free name")
}

/// Puts a project that is on this device only into Dropbox, in a folder
/// named after its own (or "name 2"… if that is taken there), and sends it.
pub fn put<T>(state: &DropboxState, dir: &Path, root: &Path, lock: &Mutex<T>) -> Result<Outcome, String> {
    let files = files(state, dir)?;
    put_in(&files, files.account_id(), root, lock)
}

fn put_in<T, R: Remote>(files: &R, account_id: &str, root: &Path, lock: &Mutex<T>) -> Result<Outcome, String> {
    if engine::read_state(root).map_err(|e| e.to_string())?.is_some() {
        return Err("This project is already in Dropbox.".into());
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("The project has no folder name.")?;
    let taken: Vec<String> = files
        .top_folders()
        .map_err(|e| e.message())?
        .iter()
        .map(|f| last_segment(f).to_lowercase())
        .collect();
    let folder = format!("/{}", free_name(&name, |n| taken.contains(&n.to_lowercase())));
    files.create_folder(&folder).map_err(|e| e.message())?;
    engine::link(root, account_id, &folder).map_err(|e| format!("Cannot start syncing the project: {e}"))?;
    let mut sync = Sync::open(files, root, account_id)
        .map_err(|e| e.message())?
        .ok_or("The project could not be linked to Dropbox.")?;
    sync.run(lock).map_err(|e| e.message())
}

/// Brings a project from Dropbox into `projects_dir`, as "name" (or
/// "name 2"… if that is taken here), and returns its folder. It is
/// downloaded into a hidden folder first and renamed into place, so an
/// interrupted download leaves nothing that looks like a project.
pub fn fetch(state: &DropboxState, dir: &Path, projects_dir: &Path, folder: &str) -> Result<PathBuf, String> {
    let files = files(state, dir)?;
    fetch_from(&files, files.account_id(), projects_dir, folder)
}

fn fetch_from<R: Remote>(files: &R, account_id: &str, projects_dir: &Path, folder: &str) -> Result<PathBuf, String> {
    let name = last_segment(folder).to_string();
    if !plain_segments(&name).is_ok_and(|parts| parts.len() == 1) {
        return Err(format!("{folder} can't be a folder name on this device."));
    }
    fs::create_dir_all(projects_dir).map_err(|e| format!("Cannot make {}: {e}", projects_dir.display()))?;
    let staging = projects_dir.join(format!(".{name}.{}.download", std::process::id()));
    if fs::symlink_metadata(&staging).is_ok() {
        fs::remove_dir_all(&staging).map_err(|e| format!("Cannot clear an earlier download: {e}"))?;
    }
    let result = (|| -> Result<PathBuf, String> {
        fs::create_dir(&staging).map_err(|e| e.to_string())?;
        engine::link(&staging, account_id, folder).map_err(|e| e.to_string())?;
        let mut sync = Sync::open(files, &staging, account_id)
            .map_err(|e| e.message())?
            .ok_or("The download could not start.")?;
        // Nobody else writes to the hidden folder: a lock of its own.
        sync.run(&Mutex::new(())).map_err(|e: SyncError| e.message())?;
        ProjectRoot::open(&staging).map_err(|_| format!("{folder} in Dropbox is not a project: it has no project.json or manuscript folder."))?;
        let target_name = free_name(&name, |n| fs::symlink_metadata(projects_dir.join(n)).is_ok());
        let target = projects_dir.join(target_name);
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        Ok(target)
    })();
    if result.is_err() {
        // Best effort: the error that stopped the download is the one to report.
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_folders_freely() {
        let taken = ["night ferry", "night ferry 2"];
        assert_eq!(free_name("Night Ferry", |n| taken.contains(&n.to_lowercase().as_str())), "Night Ferry 3");
        assert_eq!(free_name("Sel", |_| false), "Sel");
        assert_eq!(last_segment("/Night Ferry"), "Night Ferry");
        assert_eq!(title_in(r#"{"title":" The Sel "}"#).as_deref(), Some("The Sel"));
        assert_eq!(title_in(r#"{"title":""}"#), None);
        assert_eq!(title_in("{"), None);
    }

    #[test]
    fn puts_a_project_in_dropbox_under_a_free_name_and_brings_it_back_whole() {
        use crate::project::install_sample;
        use crate::sync::memory::Memory;
        let cloud = Memory::default();
        cloud.create_folder("/mynovel").unwrap();
        let here = tempfile::tempdir().unwrap();
        let project = fs::canonicalize(install_sample(here.path()).unwrap()).unwrap();
        put_in(&cloud, "dbid:ada", &project, &Mutex::new(())).unwrap();
        assert!(cloud.text("/MyNovel 2/project.json").is_some(), "the taken name is left alone");
        assert!(put_in(&cloud, "dbid:ada", &project, &Mutex::new(())).is_err());

        let there = tempfile::tempdir().unwrap();
        fs::create_dir(there.path().join("MyNovel 2")).unwrap();
        let copy = fetch_from(&cloud, "dbid:ada", there.path(), "/MyNovel 2").unwrap();
        assert_eq!(copy.file_name().unwrap(), "MyNovel 2 2");
        assert!(ProjectRoot::open(&copy).is_ok());
        assert_eq!(
            fs::read_to_string(copy.join("manuscript/Part 1 - Arrival/01 The arrival.md")).unwrap(),
            fs::read_to_string(project.join("manuscript/Part 1 - Arrival/01 The arrival.md")).unwrap()
        );
        assert_eq!(local_copy_in(&[copy.clone(), project.clone()], "dbid:ada", "/mynovel 2"), Some(copy.clone()));
        let names: Vec<_> = fs::read_dir(there.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "no download folder left behind: {names:?}");
    }

    #[test]
    fn leaves_nothing_behind_when_a_folder_is_not_a_project() {
        use crate::sync::memory::Memory;
        let cloud = Memory::default();
        cloud.edit("/Photos/beach.md", "not a project");
        let there = tempfile::tempdir().unwrap();
        let error = fetch_from(&cloud, "dbid:ada", there.path(), "/Photos").unwrap_err();
        assert!(error.contains("not a project"));
        assert_eq!(fs::read_dir(there.path()).unwrap().count(), 0);
        assert!(fetch_from(&cloud, "dbid:ada", there.path(), "/..").is_err());
    }
}
