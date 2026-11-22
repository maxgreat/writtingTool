//! The project folder: reading its Markdown files and writing them back
//! safely.
//!
//! ```text
//! MyNovel/
//!   project.json        binder notes, sheet types, settings
//!   manuscript/         one Markdown file per chapter, parts as folders
//!   sheets/<type>/      one Markdown file per sheet, with a YAML header
//!   trash/              chapters and parts moved to the Trash
//!   snapshots/          earlier versions of each chapter, kept on this device
//! ```

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};

static SAMPLE_PROJECT: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../sample-project/MyNovel");
const SAMPLE_FOLDER: &str = "MyNovel";

const PROJECT_FILE: &str = "project.json";
/// Folders whose Markdown files the interface reads and may write.
const TEXT_FOLDERS: [&str; 2] = ["manuscript", "sheets"];
/// The binder's folders: chapters and parts move inside and between these.
const BINDER_FOLDERS: [&str; 2] = ["manuscript", "trash"];

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
    /// manuscript/ and trash/ and every folder in them, so empty parts show.
    pub folders: Vec<String>,
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

/// A file or folder of the binder moving to a new path.
#[derive(Debug, Deserialize)]
pub struct Move {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    pub path: String,
    pub text: String,
    /// The file must not exist yet: a new chapter never replaces a file,
    /// even one the interface was not shown (not UTF-8, or named in
    /// another case on a disk that ignores case).
    #[serde(default)]
    pub must_be_new: bool,
}

/// A change to the binder, made as a whole or not at all: folders are
/// created, then every move is made at once (so two names can be swapped),
/// then the files are written.
#[derive(Debug, Deserialize)]
pub struct Change {
    pub folders: Vec<String>,
    pub moves: Vec<Move>,
    pub writes: Vec<FileWrite>,
}

/// One step of a change that has been made, and how to take it back.
enum Done {
    CreatedFolder(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
    Wrote { path: PathBuf, previous: Option<Vec<u8>> },
}

impl Done {
    fn undo(self) -> io::Result<()> {
        match self {
            Done::CreatedFolder(path) => fs::remove_dir(path),
            Done::Renamed { from, to } => fs::rename(to, from),
            Done::Wrote { path, previous: Some(bytes) } => atomic_write(&path, &bytes),
            Done::Wrote { path, previous: None } => fs::remove_file(path),
        }
    }
}

/// Whether `path` is inside `folder`, comparing `/`-separated segments.
fn inside(path: &str, folder: &str) -> bool {
    path.starts_with(&format!("{folder}/"))
}

/// A chapter path without its `.md` (any case), or a folder path as it is.
fn without_md(relative: &str, is_file: bool) -> &str {
    if is_file { &relative[..relative.len() - ".md".len()] } else { relative }
}

/// Checks a relative path's segments, as written by the interface: plain
/// names only, none hidden, no `.` or `..`.
pub(crate) fn plain_segments(relative: &str) -> io::Result<Vec<&str>> {
    // Checked on the raw `/`-separated segments: Path::components would
    // quietly drop a `.` and accept `\` or drive prefixes on Windows.
    let parts: Vec<&str> = relative.split('/').collect();
    let plain = parts
        .iter()
        .all(|p| !p.is_empty() && !p.starts_with('.') && !p.contains(NOT_IN_NAMES));
    if plain {
        Ok(parts)
    } else {
        Err(invalid(format!("{relative} is not a plain path inside the project")))
    }
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

pub(crate) fn is_hidden(name: &std::ffi::OsStr) -> bool {
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

    /// The project's folder, as its snapshot reports it.
    pub fn path(&self) -> &Path {
        &self.root
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
        let mut folders = Vec::new();
        let mut skipped = Vec::new();
        let mut problems = Vec::new();
        for folder in ["manuscript", "sheets", "trash"] {
            let dir = self.root.join(folder);
            if is_real_dir(&dir) {
                if BINDER_FOLDERS.contains(&folder) {
                    folders.push(folder.to_string());
                    self.collect_markdown(&dir, &mut files, Some(&mut folders), &mut skipped, &mut problems)?;
                } else {
                    self.collect_markdown(&dir, &mut files, None, &mut skipped, &mut problems)?;
                }
            } else if dir.is_symlink() {
                problems.push(format!(
                    "The {folder} folder is a link to another place, so it was left out: \
                     it has to be a real folder inside the project for changes to be saved."
                ));
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        folders.sort();
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
            folders,
            skipped,
            problems,
        })
    }

    /// Reads every Markdown file below `dir`, and lists its folders in
    /// `folders` if given. Hidden entries and symbolic links are skipped, so
    /// the walk never leaves the project folder. A folder or Markdown file
    /// whose name is not UTF-8 is left out and reported: its path could only
    /// be passed on altered, so saves would go to a different file.
    fn collect_markdown(
        &self,
        dir: &Path,
        files: &mut Vec<ProjectFile>,
        mut folders: Option<&mut Vec<String>>,
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
                if let Some(list) = folders.as_deref_mut() {
                    list.push(self.relative(&path));
                }
                self.collect_markdown(&path, files, folders.as_deref_mut(), skipped, problems)?;
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

    /// The folder holding a chapter's versions.
    fn versions_dir(&self, chapter: &str, create: bool) -> io::Result<Option<PathBuf>> {
        // The caller checked that `chapter` is a plain path ending in ".md" (any case).
        self.versions_dir_at(without_md(chapter, true), create.then_some(&mut Vec::new()))
    }

    /// The folder `snapshots/<stem>`. Each folder on the way must be a real
    /// folder, not a link, so versions never land outside the project.
    /// Missing folders are created when `created` is given, which lists them;
    /// otherwise a missing folder means there are no versions yet.
    fn versions_dir_at(&self, stem: &str, mut created: Option<&mut Vec<PathBuf>>) -> io::Result<Option<PathBuf>> {
        let mut dir = self.root.clone();
        for segment in std::iter::once(VERSIONS_FOLDER).chain(stem.split('/')) {
            dir.push(segment);
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return Err(invalid(format!("{} is not a folder", self.relative(&dir)))),
                Err(e) if e.kind() == io::ErrorKind::NotFound => match created.as_deref_mut() {
                    Some(list) => {
                        fs::create_dir(&dir)?;
                        list.push(dir.clone());
                    }
                    None => return Ok(None),
                },
                Err(e) => return Err(e),
            }
        }
        Ok(Some(dir))
    }

    /// Makes a change to the binder (see `Change`). Every path is checked
    /// first. If a step fails, the steps already made are taken back, newest
    /// first, and the error is returned. A chapter's or part's versions move
    /// with it, unless versions are already kept under the new name.
    pub fn apply(&self, change: &Change) -> io::Result<()> {
        let mut done = Vec::new();
        let result = self.apply_steps(change, &mut done);
        if result.is_err() {
            for step in done.into_iter().rev() {
                // Best effort: the error that stopped the change is the one
                // to report, and each step undone is one less left behind.
                let _ = step.undo();
            }
        }
        result
    }

    fn apply_steps(&self, change: &Change, done: &mut Vec<Done>) -> io::Result<()> {
        let mut moves = Vec::new();
        for (i, m) in change.moves.iter().enumerate() {
            if inside(&m.to, &m.from) {
                return Err(invalid(format!("{} cannot move inside itself", m.from)));
            }
            for other in &change.moves[i + 1..] {
                let shared = m.from == other.from || m.to == other.to;
                let nested = [&m.from, &m.to].iter().any(|p| inside(p, &other.from) || inside(p, &other.to))
                    || [&other.from, &other.to].iter().any(|p| inside(p, &m.from) || inside(p, &m.to));
                if shared || nested {
                    return Err(invalid(format!("{} and {} overlap", m.from, other.from)));
                }
            }
        }

        for folder in &change.folders {
            let path = self.resolve_binder_path(folder, true)?;
            fs::create_dir(&path)?;
            done.push(Done::CreatedFolder(path));
        }

        for m in &change.moves {
            let from = self.resolve_binder_path(&m.from, false)?;
            let meta = fs::symlink_metadata(&from)?;
            let is_file = meta.is_file() && is_markdown(&from);
            if !is_file && !meta.is_dir() {
                return Err(invalid(format!("{} is not a chapter or a part", m.from)));
            }
            if is_file && !is_markdown(Path::new(&m.to)) {
                return Err(invalid(format!("{} is not a Markdown file name", m.to)));
            }
            moves.push((m, from, self.resolve_binder_path(&m.to, false)?, is_file));
        }

        // Versions follow their chapter or part. A versions folder is left
        // where it is when versions are already kept under the new name and
        // that folder is not moving away itself, or when two moves would share
        // or nest versions folders. Leaving one behind can block another that
        // was to take its place, so this repeats until nothing more changes.
        let mut candidates = Vec::new();
        for (m, _, _, is_file) in &moves {
            if let Some(dir) = self.versions_dir_at(without_md(&m.from, *is_file), None)? {
                let to_stem = without_md(&m.to, *is_file);
                let target = self.root.join(VERSIONS_FOLDER).join(to_stem.split('/').collect::<PathBuf>());
                candidates.push((dir, target, to_stem));
            }
        }
        let overlap = |a: &Path, b: &Path| a.starts_with(b) || b.starts_with(a);
        let nested = |a: &Path, b: &Path| a != b && overlap(a, b);
        let mut active: Vec<bool> = (0..candidates.len())
            .map(|i| {
                let (dir, target, _) = &candidates[i];
                !candidates.iter().enumerate().any(|(j, (other_dir, other_target, _))| {
                    j != i
                        && (overlap(dir, other_dir)
                            || overlap(target, other_target)
                            || nested(dir, other_target)
                            || nested(target, other_dir))
                })
            })
            .collect();
        loop {
            let mut changed = false;
            for i in 0..candidates.len() {
                if !active[i] {
                    continue;
                }
                let target = &candidates[i].1;
                let freed = (0..candidates.len()).any(|j| active[j] && candidates[j].0 == *target);
                if fs::symlink_metadata(target).is_ok() && !freed {
                    active[i] = false;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        let mut pairs: Vec<(PathBuf, PathBuf)> = moves.iter().map(|(_, from, to, _)| (from.clone(), to.clone())).collect();
        for ((dir, target, to_stem), keep) in candidates.into_iter().zip(active) {
            if !keep {
                continue;
            }
            let parent = to_stem.rsplit_once('/').map_or("", |(parent, _)| parent);
            let mut created = Vec::new();
            let made = self.versions_dir_at(parent, Some(&mut created));
            done.extend(created.into_iter().map(Done::CreatedFolder));
            made?;
            pairs.push((dir, target));
        }
        self.move_all(&pairs, done)?;

        for write in &change.writes {
            let target = self.resolve_writable(&write.path)?;
            let previous = match fs::read(&target) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == io::ErrorKind::NotFound => None,
                Err(e) => return Err(e),
            };
            if write.must_be_new && (previous.is_some() || fs::symlink_metadata(&target).is_ok()) {
                let message = format!("{} already exists", write.path);
                return Err(io::Error::new(io::ErrorKind::AlreadyExists, message));
            }
            atomic_write(&target, write.text.as_bytes())?;
            done.push(Done::Wrote { path: target, previous });
        }
        Ok(())
    }

    /// Moves every pair at once: each source first goes to a short hidden
    /// name beside it (short, so a name near the length limit can still
    /// move), then to its target, so a name another pair frees can be taken.
    /// A target that already exists stops the move.
    fn move_all(&self, pairs: &[(PathBuf, PathBuf)], done: &mut Vec<Done>) -> io::Result<()> {
        let mut temps = Vec::with_capacity(pairs.len());
        let mut count = 0;
        for (from, _) in pairs {
            // A free name: never replace something left by an earlier move.
            let temp = loop {
                let candidate = from.with_file_name(format!(".moving-{}-{count}", std::process::id()));
                count += 1;
                match fs::symlink_metadata(&candidate) {
                    Err(e) if e.kind() == io::ErrorKind::NotFound => break candidate,
                    Err(e) => return Err(e),
                    Ok(_) => {}
                }
            };
            fs::rename(from, &temp)?;
            done.push(Done::Renamed { from: from.clone(), to: temp.clone() });
            temps.push(temp);
        }
        for ((_, to), temp) in pairs.iter().zip(temps) {
            match fs::symlink_metadata(to) {
                Ok(_) => {
                    let message = format!("{} already exists", self.relative(to));
                    return Err(io::Error::new(io::ErrorKind::AlreadyExists, message));
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            fs::rename(&temp, to)?;
            done.push(Done::Renamed { from: temp, to: to.clone() });
        }
        Ok(())
    }

    /// A path inside manuscript/ or trash/ (or, with `top`, one of those
    /// folders itself), through plain segments, whose folder resolves inside
    /// the project. Whether the path itself exists is for the caller to check.
    fn resolve_binder_path(&self, relative: &str, top: bool) -> io::Result<PathBuf> {
        let parts = plain_segments(relative)?;
        let in_binder = BINDER_FOLDERS.contains(&parts[0]) && (top || parts.len() > 1);
        if !in_binder {
            return Err(invalid(format!("{relative} is not inside manuscript/ or trash/")));
        }
        let mut full = self.root.clone();
        for part in &parts {
            full.push(part);
        }
        let parent = fs::canonicalize(full.parent().ok_or_else(|| invalid("no parent folder"))?)?;
        if !parent.starts_with(&self.root) {
            return Err(invalid(format!("{relative} is outside the project")));
        }
        Ok(parent.join(parts[parts.len() - 1]))
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
        let parts = plain_segments(relative)?;
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

    const FERRYMAN: &str = "manuscript/Part 1 - Arrival/02 The ferryman.md";

    fn change(folders: &[&str], moves: &[(&str, &str)], writes: &[(&str, &str)]) -> Change {
        Change {
            folders: folders.iter().map(|f| f.to_string()).collect(),
            moves: moves.iter().map(|(from, to)| Move { from: from.to_string(), to: to.to_string() }).collect(),
            writes: writes
                .iter()
                .map(|(path, text)| FileWrite { path: path.to_string(), text: text.to_string(), must_be_new: false })
                .collect(),
        }
    }

    #[test]
    fn swaps_two_chapters_and_their_versions() {
        let (_dir, root) = sample();
        let arrival = read(&root, ARRIVAL);
        let ferryman = read(&root, FERRYMAN);
        root.keep_version(ARRIVAL, b"old arrival", true).unwrap();
        root.apply(&change(&[], &[(ARRIVAL, FERRYMAN), (FERRYMAN, ARRIVAL)], &[])).unwrap();
        assert_eq!(read(&root, ARRIVAL), ferryman);
        assert_eq!(read(&root, FERRYMAN), arrival);
        assert_eq!(root.versions(FERRYMAN).unwrap()[0].text, "old arrival");
        assert!(root.versions(ARRIVAL).unwrap().is_empty());
        let hidden: Vec<_> = fs::read_dir(root.root.join("manuscript/Part 1 - Arrival"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_hidden(&e.file_name()))
            .collect();
        assert!(hidden.is_empty());
    }

    #[test]
    fn creates_parts_and_chapters() {
        let (_dir, root) = sample();
        root.apply(&change(
            &["manuscript/Part 3"],
            &[],
            &[("manuscript/Part 3/04 New.md", "# New\n"), ("project.json", "{}")],
        ))
        .unwrap();
        assert_eq!(read(&root, "manuscript/Part 3/04 New.md"), "# New\n");
        let snapshot = root.snapshot().unwrap();
        assert!(snapshot.folders.contains(&"manuscript/Part 3".to_string()));
        assert!(snapshot.folders.contains(&"manuscript".to_string()));
    }

    #[test]
    fn trashes_a_part_with_its_versions_and_reads_the_trash() {
        let (_dir, root) = sample();
        root.keep_version(ARRIVAL, b"old", true).unwrap();
        root.apply(&change(&["trash"], &[("manuscript/Part 1 - Arrival", "trash/Part 1 - Arrival")], &[]))
            .unwrap();
        assert!(!root.root.join("manuscript/Part 1 - Arrival").exists());
        assert!(root.root.join("snapshots/trash/Part 1 - Arrival/01 The arrival").is_dir());
        let snapshot = root.snapshot().unwrap();
        assert!(snapshot.files.iter().any(|f| f.path == "trash/Part 1 - Arrival/01 The arrival.md"));
        assert!(snapshot.folders.contains(&"trash/Part 1 - Arrival".to_string()));

        root.apply(&change(&[], &[("trash/Part 1 - Arrival", "manuscript/Part 1 - Arrival")], &[]))
            .unwrap();
        assert_eq!(root.versions(ARRIVAL).unwrap()[0].text, "old");
    }

    #[test]
    fn leaves_versions_behind_when_the_new_name_has_some() {
        let (_dir, root) = sample();
        root.keep_version(ARRIVAL, b"arrival", true).unwrap();
        let target = "manuscript/Part 1 - Arrival/05 Gone.md";
        root.keep_version(target, b"stale", true).unwrap();
        root.apply(&change(&[], &[(ARRIVAL, target)], &[])).unwrap();
        assert_eq!(root.versions(target).unwrap()[0].text, "stale");
    }

    #[test]
    fn leaves_a_chain_of_versions_behind_when_its_end_is_taken() {
        let (_dir, root) = sample();
        let part = "manuscript/Part 1 - Arrival";
        let one = format!("{part}/01.md");
        let two = format!("{part}/02.md");
        let three = format!("{part}/03.md");
        fs::write(root.root.join(&one), "# One\n").unwrap();
        fs::write(root.root.join(&two), "# Two\n").unwrap();
        root.keep_version(&one, b"one", true).unwrap();
        root.keep_version(&two, b"two", true).unwrap();
        root.keep_version(&three, b"stale", true).unwrap();
        // 01 becomes 02 and 02 becomes 03: the versions of 02 can't move onto
        // the stale 03, so the versions of 01 can't take 02's place either.
        root.apply(&change(&[], &[(&one, &two), (&two, &three)], &[])).unwrap();
        assert_eq!(read(&root, &two), "# One\n");
        assert_eq!(read(&root, &three), "# Two\n");
        assert_eq!(root.versions(&three).unwrap()[0].text, "stale");
        assert_eq!(root.versions(&two).unwrap()[0].text, "two");
        assert_eq!(root.versions(&one).unwrap()[0].text, "one");
    }

    #[test]
    fn moves_names_close_to_the_length_limit() {
        let (_dir, root) = sample();
        let title = "章".repeat(80);
        let from = format!("manuscript/Part 1 - Arrival/01 {title}.md");
        let to = format!("manuscript/Part 1 - Arrival/02 {title}.md");
        assert!(title.len() + 6 <= 255);
        fs::write(root.root.join(&from), "# Long\n").unwrap();
        root.apply(&change(&[], &[(&from, &to)], &[])).unwrap();
        assert_eq!(read(&root, &to), "# Long\n");
    }

    #[test]
    fn never_replaces_a_file_with_a_new_one() {
        let (_dir, root) = sample();
        let json = read(&root, "project.json");
        let arrival = read(&root, ARRIVAL);
        let mut new_chapter = change(&[], &[], &[("project.json", "{}")]);
        new_chapter.writes.insert(0, FileWrite { path: ARRIVAL.into(), text: "# New\n".into(), must_be_new: true });
        assert!(root.apply(&new_chapter).is_err());
        assert_eq!(read(&root, ARRIVAL), arrival);
        assert_eq!(read(&root, "project.json"), json);

        let fresh = "manuscript/Part 1 - Arrival/09 Fresh.md";
        let mut new_chapter = change(&[], &[], &[]);
        new_chapter.writes.push(FileWrite { path: fresh.into(), text: "# Fresh\n".into(), must_be_new: true });
        root.apply(&new_chapter).unwrap();
        assert_eq!(read(&root, fresh), "# Fresh\n");
    }

    #[test]
    fn takes_every_step_back_when_one_fails() {
        let (_dir, root) = sample();
        let json = read(&root, "project.json");
        let arrival = read(&root, ARRIVAL);
        let result = root.apply(&change(
            &["trash"],
            &[(ARRIVAL, "trash/01 The arrival.md")],
            &[("project.json", "{}"), ("notes.md", "x")],
        ));
        assert!(result.is_err());
        assert_eq!(read(&root, "project.json"), json);
        assert_eq!(read(&root, ARRIVAL), arrival);
        assert!(!root.root.join("trash").exists());
    }

    #[test]
    fn refuses_moves_that_leave_the_binder_or_overlap() {
        let (_dir, root) = sample();
        let part = "manuscript/Part 1 - Arrival";
        for bad in [
            change(&[], &[(ARRIVAL, "sheets/places/x.md")], &[]),
            change(&[], &[("sheets/places/Varn.md", "manuscript/Varn.md")], &[]),
            change(&[], &[(ARRIVAL, "manuscript/x.txt")], &[]),
            change(&[], &[(ARRIVAL, "manuscript/../x.md")], &[]),
            change(&[], &[(part, "manuscript/Part 1 - Arrival/Inner")], &[]),
            change(&[], &[(part, "manuscript/P"), (ARRIVAL, "manuscript/x.md")], &[]),
            change(&[], &[(ARRIVAL, "manuscript/x.md"), (FERRYMAN, "manuscript/x.md")], &[]),
            change(&[], &[(ARRIVAL, FERRYMAN)], &[]),
            change(&[], &[("manuscript/missing.md", "manuscript/x.md")], &[]),
            change(&["sheets/new"], &[], &[]),
            change(&["manuscript"], &[], &[]),
            change(&["manuscript/.hidden"], &[], &[]),
        ] {
            assert!(root.apply(&bad).is_err(), "{bad:?} should be refused");
        }
        assert!(root.root.join(ARRIVAL).is_file());
        assert!(root.root.join(FERRYMAN).is_file());
    }

    #[test]
    fn skips_files_that_are_not_utf8() {
        let (_dir, root) = sample();
        fs::write(root.root.join("manuscript/bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        let snapshot = root.snapshot().unwrap();
        assert_eq!(snapshot.skipped, vec!["manuscript/bad.md".to_string()]);
    }
}
