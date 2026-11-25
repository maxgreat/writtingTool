//! The projects on this device: the ones in the app's own projects folder,
//! and folders opened from elsewhere. New projects are created in the app's
//! folder.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::project::{FileWrite, ProjectRoot, is_hidden, plain_segments};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    /// The project's folder, as its snapshot's root reports it.
    pub path: String,
    pub title: String,
    /// In the app's own projects folder, rather than opened from elsewhere.
    pub in_app_folder: bool,
    /// Synced with Dropbox.
    pub in_dropbox: bool,
}

/// The title in project.json, or else the folder name.
pub(crate) fn title_of(root: &Path) -> String {
    fs::read_to_string(root.join("project.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("title")?.as_str().map(|t| t.trim().to_string()))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// The projects in `projects_dir`, by title, then the `recent` folders opened
/// from elsewhere, in the order given. A recent folder that can't be opened
/// now (on a drive that isn't mounted, for example) is left out, as is a
/// folder in `projects_dir` that is not a project.
pub fn list(projects_dir: &Path, recent: &[String]) -> io::Result<Vec<ProjectEntry>> {
    let mut seen = HashSet::new();
    let mut local = Vec::new();
    match fs::read_dir(projects_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                if is_hidden(&entry.file_name()) || !entry.file_type()?.is_dir() {
                    continue;
                }
                if let Ok(root) = ProjectRoot::open(&entry.path()) {
                    if seen.insert(root.path().to_path_buf()) {
                        local.push(entry_for(&root, true));
                    }
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    local.sort_by_key(|entry| entry.title.to_lowercase());
    for path in recent {
        if let Ok(root) = ProjectRoot::open(Path::new(path)) {
            if seen.insert(root.path().to_path_buf()) {
                local.push(entry_for(&root, false));
            }
        }
    }
    Ok(local)
}

fn entry_for(root: &ProjectRoot, in_app_folder: bool) -> ProjectEntry {
    ProjectEntry {
        path: root.path().to_string_lossy().into_owned(),
        title: title_of(root.path()),
        in_app_folder,
        in_dropbox: crate::sync::engine::read_state(root.path()).is_ok_and(|state| state.is_some()),
    }
}

/// Only these go into a new project: project.json, and folders and Markdown
/// files inside manuscript/ and sheets/.
fn allowed_in_new_project(relative: &str, is_folder: bool) -> io::Result<Vec<&str>> {
    let parts = plain_segments(relative)?;
    let ok = match parts.as_slice() {
        ["project.json"] => !is_folder,
        [top, ..] if *top == "manuscript" || *top == "sheets" => {
            is_folder || (parts.len() > 1 && relative.to_ascii_lowercase().ends_with(".md"))
        }
        _ => false,
    };
    if ok {
        Ok(parts)
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{relative} does not belong in a new project")))
    }
}

/// Creates a project in `projects_dir`, in a folder called `name`, or
/// "name 2", "name 3"... if that is taken, and returns its path. `folders`
/// (parents first) and `files` are created inside it. It is built in a
/// hidden folder and renamed into place, so an interrupted creation leaves
/// nothing that looks like a project.
pub fn create(projects_dir: &Path, name: &str, folders: &[String], files: &[FileWrite]) -> io::Result<PathBuf> {
    if plain_segments(name)?.len() != 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{name} is not a folder name")));
    }
    fs::create_dir_all(projects_dir)?;
    let staging = projects_dir.join(format!(".{name}.{}.new", std::process::id()));
    if fs::symlink_metadata(&staging).is_ok() {
        fs::remove_dir_all(&staging)?;
    }
    let result = (|| {
        fs::create_dir(&staging)?;
        for folder in folders {
            let parts = allowed_in_new_project(folder, true)?;
            fs::create_dir(staging.join(parts.iter().collect::<PathBuf>()))?;
        }
        for file in files {
            let parts = allowed_in_new_project(&file.path, false)?;
            fs::write(staging.join(parts.iter().collect::<PathBuf>()), &file.text)?;
        }
        for n in 1.. {
            let target = projects_dir.join(if n == 1 { name.to_string() } else { format!("{name} {n}") });
            if fs::symlink_metadata(&target).is_ok() {
                continue;
            }
            fs::rename(&staging, &target)?;
            return Ok(target);
        }
        unreachable!("the loop only ends by returning")
    })();
    if result.is_err() {
        // Best effort: the error that stopped the creation is the one to report.
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::install_sample;

    fn new_project_files() -> (Vec<String>, Vec<FileWrite>) {
        let folders = ["manuscript", "sheets", "sheets/characters"].map(String::from).to_vec();
        let files = vec![
            FileWrite { path: "project.json".into(), text: r#"{"title":"Night Ferry"}"#.into(), must_be_new: false },
            FileWrite { path: "manuscript/01 Chapter one.md".into(), text: "# Chapter one\n".into(), must_be_new: false },
        ];
        (folders, files)
    }

    #[test]
    fn creates_projects_with_free_names_and_lists_them() {
        let dir = tempfile::tempdir().unwrap();
        install_sample(dir.path()).unwrap();
        let (folders, files) = new_project_files();
        let first = create(dir.path(), "Night Ferry", &folders, &files).unwrap();
        let second = create(dir.path(), "Night Ferry", &folders, &files).unwrap();
        assert_eq!(first.file_name().unwrap(), "Night Ferry");
        assert_eq!(second.file_name().unwrap(), "Night Ferry 2");
        assert_eq!(fs::read_to_string(first.join("manuscript/01 Chapter one.md")).unwrap(), "# Chapter one\n");
        assert!(first.join("sheets/characters").is_dir());

        fs::create_dir(dir.path().join("Not a project")).unwrap();
        let listed = list(dir.path(), &[]).unwrap();
        let titles: Vec<_> = listed.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["Night Ferry", "Night Ferry", "The Ferryman’s Debt"]);
        assert!(listed.iter().all(|p| p.in_app_folder));
        assert!(fs::read_dir(dir.path()).unwrap().all(|e| !is_hidden(&e.unwrap().file_name())));
    }

    #[test]
    fn lists_recent_folders_from_elsewhere_once_and_only_if_they_open() {
        let apps = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = install_sample(elsewhere.path()).unwrap();
        let inside = install_sample(apps.path()).unwrap();
        let recent = [
            outside.to_string_lossy().into_owned(),
            "/no/such/folder".to_string(),
            inside.to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
        ];
        let listed = list(apps.path(), &recent).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed[0].in_app_folder);
        assert!(!listed[1].in_app_folder);
        assert_eq!(listed[1].path, fs::canonicalize(&outside).unwrap().to_string_lossy());
        assert!(list(&apps.path().join("missing"), &[]).unwrap().is_empty());
    }

    #[test]
    fn refuses_names_and_files_that_do_not_belong() {
        let dir = tempfile::tempdir().unwrap();
        let (folders, files) = new_project_files();
        for name in ["", ".hidden", "a/b", ".."] {
            assert!(create(dir.path(), name, &folders, &files).is_err(), "{name:?} should be refused");
        }
        for bad in ["notes.txt", "manuscript/x.txt", "../x.md", "sheets"] {
            let files = vec![FileWrite { path: bad.into(), text: String::new(), must_be_new: false }];
            assert!(create(dir.path(), "P", &folders, &files).is_err(), "{bad} should be refused");
        }
        assert!(create(dir.path(), "P", &["trash".to_string()], &[]).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
