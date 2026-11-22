//! The project folder: reading its Markdown files and writing them back
//! safely.
//!
//! ```text
//! MyNovel/
//!   project.json        binder notes, sheet types, settings
//!   manuscript/         one Markdown file per chapter, parts as folders
//!   sheets/<type>/      one Markdown file per sheet, with a YAML header
//!   snapshots/          earlier versions of each chapter, kept on this device
//! ```

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use include_dir::{Dir, include_dir};
use serde::Serialize;

static SAMPLE_PROJECT: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../sample-project/MyNovel");
const SAMPLE_FOLDER: &str = "MyNovel";

const PROJECT_FILE: &str = "project.json";
/// Folders whose Markdown files the interface reads and may write.
const TEXT_FOLDERS: [&str; 2] = ["manuscript", "sheets"];

/// Earlier versions of each chapter, one file per version:
/// `snapshots/<chapter path without .md>/<milliseconds since 1970>.md`.
const VERSIONS_FOLDER: &str = "snapshots";
/// How many versions of a chapter are kept; older ones are deleted.
pub const VERSIONS_KEPT: usize = 20;
/// While a chapter is being edited, its previous text is kept at most this
/// often, so the versions span hours of work rather than the last few saves.
pub const VERSION_INTERVAL_MS: u64 = 10 * 60 * 1000;

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

/// An earlier version of a chapter.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    /// When it was kept, in milliseconds since 1970. Also names the version.
    pub saved_at: u64,
    pub text: String,
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

/// A chapter: a Markdown file inside manuscript/.
fn is_chapter(relative: &str) -> bool {
    relative.starts_with("manuscript/") && is_markdown(Path::new(relative))
}

fn now_ms() -> u64 {
    // A clock set before 1970 counts as 1970; versions still sort by name.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The versions in a folder, oldest first. Files not named like a version
/// are not versions and are left alone.
fn version_files(dir: &Path) -> io::Result<Vec<(u64, PathBuf)>> {
    let mut versions = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let stamp = name
            .to_str()
            .and_then(|n| n.strip_suffix(".md"))
            .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|n| n.parse::<u64>().ok());
        if let Some(stamp) = stamp {
            if entry.file_type()?.is_file() {
                versions.push((stamp, entry.path()));
            }
        }
    }
    versions.sort_by_key(|(stamp, _)| *stamp);
    Ok(versions)
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

    /// Before a chapter is replaced with `new_text`: keeps its current text
    /// as a version, unless the newest version is less than
    /// VERSION_INTERVAL_MS old. Does nothing for other files, for a chapter
    /// that does not exist yet, or when the text is unchanged.
    pub fn keep_before_write(&self, relative: &str, new_text: &str) -> io::Result<()> {
        if !is_chapter(relative) {
            return Ok(());
        }
        let target = self.resolve_writable(relative)?;
        let current = match fs::read(&target) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if current == new_text.as_bytes() {
            return Ok(());
        }
        self.keep_version(relative, &current, false)
    }

    /// The versions of a chapter, newest first. A version that is not UTF-8
    /// text cannot be shown or restored, so it is left out.
    pub fn versions(&self, chapter: &str) -> io::Result<Vec<Version>> {
        self.resolve_chapter(chapter)?;
        let Some(dir) = self.versions_dir(chapter, false)? else {
            return Ok(Vec::new());
        };
        let mut versions = Vec::new();
        for (saved_at, path) in version_files(&dir)?.into_iter().rev() {
            if let Ok(text) = String::from_utf8(fs::read(&path)?) {
                versions.push(Version { saved_at, text });
            }
        }
        Ok(versions)
    }

    /// Puts a version back as the chapter's text and returns that text. The
    /// text it replaces is kept as a version first, so a restore can be
    /// undone by restoring again.
    pub fn restore_version(&self, chapter: &str, saved_at: u64) -> io::Result<String> {
        let target = self.resolve_chapter(chapter)?;
        let missing = || io::Error::new(io::ErrorKind::NotFound, "that version is no longer kept");
        let dir = self.versions_dir(chapter, false)?.ok_or_else(missing)?;
        let path = dir.join(format!("{saved_at}.md"));
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Err(invalid("that version is not a regular file")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(missing()),
            Err(e) => return Err(e),
        }
        let text = String::from_utf8(fs::read(&path)?).map_err(|_| invalid("that version is not UTF-8 text"))?;
        match fs::read(&target) {
            Ok(current) if current != text.as_bytes() => self.keep_version(chapter, &current, true)?,
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        atomic_write(&target, text.as_bytes())?;
        Ok(text)
    }

    /// A chapter's file, checked as for a write: a Markdown file inside
    /// manuscript/, through a plain path that stays inside the project.
    fn resolve_chapter(&self, relative: &str) -> io::Result<PathBuf> {
        if !is_chapter(relative) {
            return Err(invalid(format!("{relative} is not a chapter (a .md file in manuscript/)")));
        }
        self.resolve_writable(relative)
    }

    /// The folder holding a chapter's versions. Each folder on the way must
    /// be a real folder, not a link, so versions never land outside the
    /// project. Missing folders are created when `create` is set; otherwise
    /// a missing folder means there are no versions yet.
    fn versions_dir(&self, chapter: &str, create: bool) -> io::Result<Option<PathBuf>> {
        // The caller checked that `chapter` is a plain path ending in ".md" (any case).
        let stem = &chapter[..chapter.len() - ".md".len()];
        let mut dir = self.root.clone();
        for segment in std::iter::once(VERSIONS_FOLDER).chain(stem.split('/')) {
            dir.push(segment);
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return Err(invalid(format!("{} is not a folder", self.relative(&dir)))),
                Err(e) if e.kind() == io::ErrorKind::NotFound && create => fs::create_dir(&dir)?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e),
            }
        }
        Ok(Some(dir))
    }

    /// Keeps `text` as a new version of `chapter`, then deletes the oldest
    /// versions beyond VERSIONS_KEPT. Skipped when the newest version holds
    /// the same text, or, unless `force` is set, when it is less than
    /// VERSION_INTERVAL_MS old.
    fn keep_version(&self, chapter: &str, text: &[u8], force: bool) -> io::Result<()> {
        let dir = self
            .versions_dir(chapter, true)?
            .ok_or_else(|| invalid("the versions folder could not be created"))?;
        let existing = version_files(&dir)?;
        let now = now_ms();
        if let Some((newest, path)) = existing.last() {
            if !force && now.saturating_sub(*newest) < VERSION_INTERVAL_MS {
                return Ok(());
            }
            if fs::read(path)? == text {
                return Ok(());
            }
        }
        // Always after the newest, even if the clock went back, so names stay unique and in order.
        let stamp = existing.last().map_or(now, |(newest, _)| now.max(newest + 1));
        atomic_write(&dir.join(format!("{stamp}.md")), text)?;
        let all = version_files(&dir)?;
        for (_, path) in all.iter().take(all.len().saturating_sub(VERSIONS_KEPT)) {
            fs::remove_file(path)?;
        }
        Ok(())
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

    const ARRIVAL: &str = "manuscript/Part 1 - Arrival/01 The arrival.md";

    fn read(root: &ProjectRoot, relative: &str) -> String {
        fs::read_to_string(root.root.join(relative)).unwrap()
    }

    #[test]
    fn keeps_the_previous_text_before_a_chapter_is_replaced() {
        let (_dir, root) = sample();
        let original = read(&root, ARRIVAL);
        root.keep_before_write(ARRIVAL, "# New\n").unwrap();
        root.write(ARRIVAL, "# New\n").unwrap();
        let versions = root.versions(ARRIVAL).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].text, original);
        assert!(root.root.join("snapshots/manuscript/Part 1 - Arrival/01 The arrival").is_dir());

        // A save soon after keeps nothing more: the newest version is recent.
        root.keep_before_write(ARRIVAL, "# Newer\n").unwrap();
        root.write(ARRIVAL, "# Newer\n").unwrap();
        assert_eq!(root.versions(ARRIVAL).unwrap().len(), 1);

        // Neither does saving the same text.
        root.keep_before_write(ARRIVAL, "# Newer\n").unwrap();
        assert_eq!(root.versions(ARRIVAL).unwrap().len(), 1);
    }

    #[test]
    fn keeps_no_versions_of_other_files_or_new_chapters() {
        let (_dir, root) = sample();
        root.keep_before_write("project.json", "{}").unwrap();
        root.keep_before_write("sheets/places/Varn.md", "x").unwrap();
        root.keep_before_write("manuscript/Part 1 - Arrival/09 New.md", "# New\n").unwrap();
        assert!(!root.root.join("snapshots").exists());
        assert!(root.versions("manuscript/Part 1 - Arrival/09 New.md").unwrap().is_empty());
    }

    #[test]
    fn keeps_the_newest_versions_only() {
        let (_dir, root) = sample();
        for i in 0..VERSIONS_KEPT + 5 {
            root.keep_version(ARRIVAL, format!("text {i}").as_bytes(), true).unwrap();
        }
        let versions = root.versions(ARRIVAL).unwrap();
        assert_eq!(versions.len(), VERSIONS_KEPT);
        assert_eq!(versions[0].text, format!("text {}", VERSIONS_KEPT + 4));
        assert_eq!(versions[VERSIONS_KEPT - 1].text, "text 5");
        assert!(versions.windows(2).all(|w| w[0].saved_at > w[1].saved_at));
    }

    #[test]
    fn restores_a_version_and_keeps_the_text_it_replaces() {
        let (_dir, root) = sample();
        let original = read(&root, ARRIVAL);
        root.keep_before_write(ARRIVAL, "# Rewritten\n").unwrap();
        root.write(ARRIVAL, "# Rewritten\n").unwrap();
        let saved_at = root.versions(ARRIVAL).unwrap()[0].saved_at;

        assert_eq!(root.restore_version(ARRIVAL, saved_at).unwrap(), original);
        assert_eq!(read(&root, ARRIVAL), original);
        let versions = root.versions(ARRIVAL).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].text, "# Rewritten\n");
    }

    #[test]
    fn refuses_to_restore_what_is_not_a_kept_version() {
        let (_dir, root) = sample();
        assert!(root.restore_version(ARRIVAL, 42).is_err());
        root.keep_version(ARRIVAL, b"old", true).unwrap();
        assert!(root.restore_version(ARRIVAL, 42).is_err());
        assert!(root.restore_version("sheets/places/Varn.md", 42).is_err());
        assert!(root.restore_version("manuscript/../project.json", 42).is_err());
        assert!(root.versions("project.json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn never_keeps_versions_through_a_link() {
        let (_dir, root) = sample();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.root.join("snapshots")).unwrap();
        assert!(root.keep_before_write(ARRIVAL, "# New\n").is_err());
        assert!(root.versions(ARRIVAL).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn skips_files_that_are_not_utf8() {
        let (_dir, root) = sample();
        fs::write(root.root.join("manuscript/bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        let snapshot = root.snapshot().unwrap();
        assert_eq!(snapshot.skipped, vec!["manuscript/bad.md".to_string()]);
    }
}
