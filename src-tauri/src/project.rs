//! The project folder: reading its Markdown files and writing them back
//! safely.
//!
//! ```text
//! MyNovel/
//!   project.json        binder notes, sheet types, settings
//!   manuscript/         one Markdown file per chapter, parts as folders
//!   sheets/<type>/      one Markdown file per sheet, with a YAML header
//! ```

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use include_dir::{Dir, include_dir};
use serde::Serialize;

static SAMPLE_PROJECT: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../sample-project/MyNovel");
const SAMPLE_FOLDER: &str = "MyNovel";

const PROJECT_FILE: &str = "project.json";
/// Folders whose Markdown files the interface reads and may write.
const TEXT_FOLDERS: [&str; 2] = ["manuscript", "sheets"];

/// Characters a path segment may not hold. On Windows `\` separates folders
/// and `:` names drives and streams. Elsewhere both are ordinary characters in
/// file names ("01 Day 1: Arrival.md"), so a chapter that can be read can be
/// saved too.
#[cfg(windows)]
const NOT_IN_NAMES: &[char] = &['\\', ':'];
#[cfg(not(windows))]
const NOT_IN_NAMES: &[char] = &[];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// Relative to the project root, always with `/`.
    pub path: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub root: String,
    pub folder_name: String,
    pub project_json: Option<String>,
    pub files: Vec<ProjectFile>,
    /// Markdown files left out because they are not UTF-8.
    pub skipped: Vec<String>,
    /// Other things left out, as sentences for the writer.
    pub problems: Vec<String>,
}

#[derive(Debug)]
pub struct ProjectRoot {
    /// Canonical path, so prefix checks are not fooled by `..` or links.
    root: PathBuf,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn is_markdown(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// A folder itself, not a link to one: writes are only allowed inside the
/// project, so a linked folder could be read but never saved to.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

impl ProjectRoot {
    /// Accepts a folder that holds a project.json or a manuscript folder.
    pub fn open(dir: &Path) -> io::Result<Self> {
        let root = fs::canonicalize(dir)?;
        if !root.is_dir() {
            return Err(invalid("not a folder"));
        }
        if !root.join(PROJECT_FILE).is_file() && !is_real_dir(&root.join("manuscript")) {
            return Err(invalid("not a project folder: it needs a project.json or a manuscript folder"));
        }
        Ok(Self { root })
    }

    /// Whether `root` names this project, as its snapshot reported it.
    pub fn is_at(&self, root: &str) -> bool {
        self.root.to_string_lossy() == root
    }

    pub fn snapshot(&self) -> io::Result<ProjectSnapshot> {
        let project_json = match fs::read_to_string(self.root.join(PROJECT_FILE)) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        let mut problems = Vec::new();
        for folder in TEXT_FOLDERS {
            let dir = self.root.join(folder);
            if is_real_dir(&dir) {
                self.collect_markdown(&dir, &mut files, &mut skipped, &mut problems)?;
            } else if dir.is_symlink() {
                problems.push(format!(
                    "The {folder} folder is a link to another place, so it was left out: \
                     it has to be a real folder inside the project for changes to be saved."
                ));
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        skipped.sort();
        Ok(ProjectSnapshot {
            root: self.root.to_string_lossy().into_owned(),
            folder_name: self
                .root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            project_json,
            files,
            skipped,
            problems,
        })
    }

    /// Reads every Markdown file below `dir`. Hidden entries and symbolic
    /// links are skipped, so the walk never leaves the project folder. A
    /// folder or Markdown file whose name is not UTF-8 is left out and
    /// reported: its path could only be passed on altered, so saves would go
    /// to a different file.
    fn collect_markdown(
        &self,
        dir: &Path,
        files: &mut Vec<ProjectFile>,
        skipped: &mut Vec<String>,
        problems: &mut Vec<String>,
    ) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if is_hidden(&name) {
                continue;
            }
            let kind = entry.file_type()?;
            let path = entry.path();
            if name.to_str().is_none() {
                if kind.is_dir() || (kind.is_file() && is_markdown(&path)) {
                    problems.push(format!(
                        "{} has a name that is not UTF-8, so it was left out. Rename it to open it here.",
                        self.relative(&path)
                    ));
                }
                continue;
            }
            if kind.is_dir() {
                self.collect_markdown(&path, files, skipped, problems)?;
            } else if kind.is_file() && is_markdown(&path) {
                let relative = self.relative(&path);
                match String::from_utf8(fs::read(&path)?) {
                    Ok(text) => files.push(ProjectFile { path: relative, text }),
                    Err(_) => skipped.push(relative),
                }
            }
        }
        Ok(())
    }

    fn relative(&self, path: &Path) -> String {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// Replaces a file atomically: the text goes to a temporary file in the
    /// same folder, which is then renamed over the original, so a crash never
    /// leaves half a chapter.
    pub fn write(&self, relative: &str, text: &str) -> io::Result<()> {
        let target = self.resolve_writable(relative)?;
        atomic_write(&target, text.as_bytes())
    }

    /// Only project.json and Markdown files inside manuscript/ or sheets/ can
    /// be written, and only through plain relative paths whose folder
    /// resolves inside the project.
    fn resolve_writable(&self, relative: &str) -> io::Result<PathBuf> {
        // Checked on the raw `/`-separated segments: Path::components would
        // quietly drop a `.` and accept `\` or drive prefixes on Windows.
        let parts: Vec<&str> = relative.split('/').collect();
        let plain = parts
            .iter()
            .all(|p| !p.is_empty() && !p.starts_with('.') && !p.contains(NOT_IN_NAMES));
        if !plain {
            return Err(invalid(format!("{relative} is not a plain path inside the project")));
        }
        let path: PathBuf = parts.iter().collect();
        let allowed = match parts.as_slice() {
            [only] => *only == PROJECT_FILE,
            [first, .., _] => TEXT_FOLDERS.contains(first) && is_markdown(&path),
            [] => false,
        };
        if !allowed {
            return Err(invalid(format!(
                "{relative} is not a project file (project.json, or a .md file in manuscript/ or sheets/)"
            )));
        }

        let full = self.root.join(path);
        let parent = full.parent().ok_or_else(|| invalid("no parent folder"))?;
        let parent = fs::canonicalize(parent)?;
        if !parent.starts_with(&self.root) {
            return Err(invalid(format!("{relative} is outside the project")));
        }
        let target = parent.join(full.file_name().ok_or_else(|| invalid("no file name"))?);
        match fs::symlink_metadata(&target) {
            Ok(meta) if !meta.file_type().is_file() => Err(invalid(format!("{relative} is not a regular file"))),
            Ok(_) => Ok(target),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(target),
            Err(e) => Err(e),
        }
    }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = target.parent().ok_or_else(|| invalid("no parent folder"))?;
    let name = target.file_name().ok_or_else(|| invalid("no file name"))?;
    let temp = dir.join(format!(".{}.{}.tmp", name.to_string_lossy(), std::process::id()));
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, target)
    })();
    if result.is_err() {
        // Best effort: the original file is untouched either way.
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Puts the bundled sample project in `projects_dir` unless a folder of that
/// name is already there, and returns its path. The files are extracted to a
/// hidden folder first and renamed into place, so an interrupted install
/// leaves nothing that looks like a project.
pub fn install_sample(projects_dir: &Path) -> io::Result<PathBuf> {
    let target = projects_dir.join(SAMPLE_FOLDER);
    if target.exists() {
        return Ok(target);
    }
    fs::create_dir_all(projects_dir)?;
    let staging = projects_dir.join(format!(".{SAMPLE_FOLDER}.{}.tmp", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    // `extract` creates sub-folders but not the folder it extracts into.
    let result = fs::create_dir(&staging)
        .and_then(|()| SAMPLE_PROJECT.extract(&staging))
        .and_then(|()| fs::rename(&staging, &target));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|()| target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (tempfile::TempDir, ProjectRoot) {
        let dir = tempfile::tempdir().unwrap();
        let path = install_sample(dir.path()).unwrap();
        let root = ProjectRoot::open(&path).unwrap();
        (dir, root)
    }

    #[test]
    fn installs_and_reads_the_sample_project() {
        let (_dir, root) = sample();
        let snapshot = root.snapshot().unwrap();
        assert_eq!(snapshot.folder_name, "MyNovel");
        assert!(snapshot.project_json.is_some());
        let paths: Vec<_> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"manuscript/Part 1 - Arrival/01 The arrival.md"));
        assert!(paths.contains(&"sheets/characters/Elena Voss.md"));
        assert!(!paths.iter().any(|p| p.ends_with("dictionary.txt")));
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn installing_twice_keeps_the_existing_project() {
        let dir = tempfile::tempdir().unwrap();
        let path = install_sample(dir.path()).unwrap();
        let chapter = path.join("manuscript/Part 1 - Arrival/01 The arrival.md");
        fs::write(&chapter, "# Changed\n").unwrap();
        install_sample(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(&chapter).unwrap(), "# Changed\n");
    }

    #[test]
    fn refuses_folders_that_are_not_projects() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ProjectRoot::open(dir.path()).is_err());
    }

    #[test]
    fn writes_a_chapter_atomically() {
        let (_dir, root) = sample();
        root.write("manuscript/Part 1 - Arrival/01 The arrival.md", "# New\n").unwrap();
        let text = fs::read_to_string(root.root.join("manuscript/Part 1 - Arrival/01 The arrival.md")).unwrap();
        assert_eq!(text, "# New\n");
        let leftovers: Vec<_> = fs::read_dir(root.root.join("manuscript/Part 1 - Arrival"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_hidden(&e.file_name()))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn writes_project_json_and_new_sheets() {
        let (_dir, root) = sample();
        root.write("project.json", "{}").unwrap();
        root.write("sheets/places/Lowmere.md", "---\nname: Lowmere\n---\n").unwrap();
        assert!(root.root.join("sheets/places/Lowmere.md").is_file());
    }

    #[test]
    fn refuses_paths_outside_the_text_folders() {
        let (_dir, root) = sample();
        for bad in [
            "../escape.md",
            "manuscript/../../escape.md",
            "/etc/passwd",
            "manuscript/./x.md",
            "manuscript//x.md",
            "manuscript\\..\\..\\x.md",
            "C:/x.md",
            "notes.md",
            "dictionary.txt",
            "manuscript/chapter.txt",
            "manuscript",
            "manuscript/.hidden.md",
            "sheets/.cache/x.md",
            "",
        ] {
            assert!(root.write(bad, "x").is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn knows_its_root_as_the_snapshot_reports_it() {
        let (_dir, root) = sample();
        let snapshot = root.snapshot().unwrap();
        assert!(root.is_at(&snapshot.root));
        assert!(!root.is_at("/some/other/project"));
    }

    #[test]
    fn refuses_to_create_folders() {
        let (_dir, root) = sample();
        assert!(root.write("manuscript/New part/01 New.md", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_that_leave_the_project() {
        let (_dir, root) = sample();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.root.join("manuscript/Linked")).unwrap();
        assert!(root.write("manuscript/Linked/x.md", "x").is_err());
        let file = outside.path().join("target.md");
        fs::write(&file, "keep").unwrap();
        std::os::unix::fs::symlink(&file, root.root.join("manuscript/link.md")).unwrap();
        assert!(root.write("manuscript/link.md", "x").is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep");
        let snapshot = root.snapshot().unwrap();
        assert!(!snapshot.files.iter().any(|f| f.path.contains("link")));
    }

    #[cfg(unix)]
    #[test]
    fn leaves_out_a_linked_manuscript_folder_and_says_why() {
        let (_dir, root) = sample();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("01 Away.md"), "# Away\n").unwrap();
        fs::remove_dir_all(root.root.join("manuscript")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.root.join("manuscript")).unwrap();
        let snapshot = root.snapshot().unwrap();
        assert!(!snapshot.files.iter().any(|f| f.path.starts_with("manuscript/")));
        assert_eq!(snapshot.problems.len(), 1);
        assert!(snapshot.problems[0].contains("manuscript folder is a link"));

        fs::remove_file(root.root.join(PROJECT_FILE)).unwrap();
        assert!(ProjectRoot::open(&root.root).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn saves_chapters_with_a_colon_in_their_name() {
        let (_dir, root) = sample();
        let path = "manuscript/Part 1 - Arrival/04 Day 1: Arrival.md";
        fs::write(root.root.join(path), "# Day 1\n").unwrap();
        let snapshot = root.snapshot().unwrap();
        assert!(snapshot.files.iter().any(|f| f.path == path));
        root.write(path, "# Day 1\n\nMore.\n").unwrap();
        assert_eq!(fs::read_to_string(root.root.join(path)).unwrap(), "# Day 1\n\nMore.\n");
    }

    // macOS file systems refuse to create a name that is not UTF-8.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn leaves_out_names_that_are_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let (_dir, root) = sample();
        let name = std::ffi::OsStr::from_bytes(b"05 Caf\xe9.md");
        fs::write(root.root.join("manuscript").join(name), "# Cafe\n").unwrap();
        let snapshot = root.snapshot().unwrap();
        assert!(!snapshot.files.iter().any(|f| f.path.contains("Caf")));
        assert_eq!(snapshot.problems.len(), 1);
        assert!(snapshot.problems[0].contains("not UTF-8"));
    }

    #[test]
    fn skips_files_that_are_not_utf8() {
        let (_dir, root) = sample();
        fs::write(root.root.join("manuscript/bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        let snapshot = root.snapshot().unwrap();
        assert_eq!(snapshot.skipped, vec!["manuscript/bad.md".to_string()]);
    }
}
