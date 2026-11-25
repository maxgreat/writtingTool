//! Keeps a project folder on this device and its folder in the cloud the
//! same. A sync pulls first (what changed in the cloud since the last sync
//! comes in, merged with what changed here), then pushes (what changed here
//! goes up, each upload naming the revision it replaces, so it can never
//! overwrite a version this device hasn't seen).
//!
//! Kept in the project folder, on this device only (hidden, so never synced):
//! ```text
//! .sync/state.json    the cloud folder, the cursor, each synced file's id and revision
//! .sync/base/<id>     each file as last synced: the base of a three-way merge
//! ```
//!
//! What syncs: project.json, dictionary.txt, and the Markdown files and
//! folders in manuscript/, sheets/ and trash/. Versions (snapshots/) stay on
//! each device.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use super::merge;
use super::remote::{Entry, FileMeta, Remote, RemoteError, content_hash};
use crate::project::{atomic_write, is_hidden, plain_segments};

pub const STATE_DIR: &str = ".sync";
const STATE_FILE: &str = "state.json";
const BASE_DIR: &str = "base";
const STATE_VERSION: u32 = 1;

/// Folders whose Markdown files and sub-folders sync.
const SYNCED_FOLDERS: [&str; 3] = ["manuscript", "sheets", "trash"];
const ROOT_FILES: [&str; 2] = ["project.json", "dictionary.txt"];
/// How many files download at once.
const DOWNLOADS_AT_ONCE: usize = 6;

/// A file as last synced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub id: String,
    pub rev: String,
    /// The content hash of the base (see remote::content_hash).
    pub hash: String,
}

/// A move made on this device, from one path to another, relative to the project.
pub type Move = (String, String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub version: u32,
    /// The account the project syncs with.
    pub account_id: String,
    /// The project's folder in the cloud, such as "/Night Ferry".
    pub remote_root: String,
    /// Where the last pull stopped; None until the first one.
    pub cursor: Option<String>,
    /// Each synced file, by its path relative to the project.
    pub files: BTreeMap<String, Synced>,
    /// The folders known to be in the cloud, relative to the project.
    pub folders: BTreeSet<String>,
    /// Moves made on this device that the cloud hasn't seen yet: each
    /// change's moves together, as they were made at once.
    #[serde(default)]
    pub moves: Vec<Vec<Move>>,
}

/// What a sync changed on this device, for the interface.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// Files whose text changed here, with the text before and after (None: no file).
    pub changed: Vec<Changed>,
    /// Files moved by another device, from and to.
    pub moved: Vec<Move>,
    /// Files or folders came, went or moved: the binder must be read again.
    pub reshaped: bool,
    /// Files changed in the same places on two devices: both versions are in the text.
    pub conflicts: Vec<String>,
    /// Things that could not be synced, as sentences for the writer.
    pub problems: Vec<String>,
    /// Something changed in the cloud while this sync ran: sync again soon.
    pub again: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug)]
pub enum SyncError {
    Remote(RemoteError),
    Local(io::Error),
    /// Sync can't go on until the writer acts, as a sentence.
    Stopped(String),
}

impl SyncError {
    pub fn message(&self) -> String {
        match self {
            SyncError::Remote(e) => e.message(),
            SyncError::Local(e) => format!("A file on this device could not be read or written: {e}"),
            SyncError::Stopped(m) => m.clone(),
        }
    }
}

impl From<RemoteError> for SyncError {
    fn from(e: RemoteError) -> Self {
        SyncError::Remote(e)
    }
}

impl From<io::Error> for SyncError {
    fn from(e: io::Error) -> Self {
        SyncError::Local(e)
    }
}

type Result<T> = std::result::Result<T, SyncError>;

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

/// Whether sync carries the file at this path, relative to the project.
pub fn is_synced_file(relative: &str) -> bool {
    match plain_segments(relative).as_deref() {
        Ok([only]) => ROOT_FILES.contains(only),
        Ok([top, .., name]) => SYNCED_FOLDERS.contains(top) && name.to_lowercase().ends_with(".md"),
        _ => false,
    }
}

fn is_synced_folder(relative: &str) -> bool {
    matches!(plain_segments(relative).as_deref(), Ok([top, ..]) if SYNCED_FOLDERS.contains(top))
}

/// Whether `path` is `folder` or inside it, by `/`-separated segments.
fn within(path: &str, folder: &str) -> bool {
    path == folder || path.starts_with(&format!("{folder}/"))
}

/// `path` with its leading `from` replaced by `to`, if it is within `from`.
fn rebased(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        Some(to.to_string())
    } else {
        path.strip_prefix(&format!("{from}/")).map(|rest| format!("{to}/{rest}"))
    }
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// A cloud path relative to `root`, by segments compared without case. None
/// when it isn't inside `root`; "" for `root` itself.
fn relative_to(root: &str, path: &str) -> Option<String> {
    let root_parts: Vec<&str> = root.split('/').filter(|s| !s.is_empty()).collect();
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < root_parts.len() || !root_parts.iter().zip(&parts).all(|(a, b)| same_name(a, b)) {
        return None;
    }
    Some(parts[root_parts.len()..].join("/"))
}

/// The project folder on this device, written only through plain paths
/// whose every folder is a real folder inside it.
struct Local {
    root: PathBuf,
}

impl Local {
    fn resolve(&self, relative: &str, make_folders: bool) -> io::Result<PathBuf> {
        let parts = plain_segments(relative)?;
        let mut path = self.root.clone();
        for part in &parts[..parts.len() - 1] {
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return Err(invalid(format!("{relative}: a folder on the way is not a folder"))),
                Err(e) if e.kind() == io::ErrorKind::NotFound && make_folders => fs::create_dir(&path)?,
                Err(e) => return Err(e),
            }
        }
        path.push(parts[parts.len() - 1]);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => Err(invalid(format!("{relative} is a link"))),
            _ => Ok(path),
        }
    }

    fn read(&self, relative: &str) -> io::Result<Option<Vec<u8>>> {
        let path = match self.resolve(relative, false) {
            Ok(path) => path,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> io::Result<()> {
        atomic_write(&self.resolve(relative, true)?, bytes)
    }

    fn remove(&self, relative: &str) -> io::Result<()> {
        match fs::remove_file(self.resolve(relative, false)?) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// Moves a file or folder; false, moving nothing, when the source is
    /// missing or the target is taken.
    fn rename(&self, from: &str, to: &str) -> io::Result<bool> {
        let source = self.resolve(from, false)?;
        if fs::symlink_metadata(&source).is_err() {
            return Ok(false);
        }
        let target = self.resolve(to, true)?;
        if fs::symlink_metadata(&target).is_ok() {
            return Ok(false);
        }
        fs::rename(source, target)?;
        Ok(true)
    }

    fn make_folder(&self, relative: &str) -> io::Result<()> {
        let path = self.resolve(relative, true)?;
        match fs::create_dir(&path) {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
            other => other,
        }
    }

    /// Removes a folder if it is empty; otherwise leaves it.
    fn remove_folder_if_empty(&self, relative: &str) -> io::Result<()> {
        let path = match self.resolve(relative, false) {
            Ok(path) => path,
            // A folder on the way is gone already, and this one with it.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        let empty = match fs::read_dir(&path) {
            Ok(mut entries) => entries.next().is_none(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        if empty { fs::remove_dir(path) } else { Ok(()) }
    }

    /// Moves a file to a hidden name beside it, out of the way of other
    /// moves made at once; None when it isn't here.
    fn park(&self, relative: &str, n: usize) -> io::Result<Option<PathBuf>> {
        let source = match self.resolve(relative, false) {
            Ok(source) => source,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if fs::symlink_metadata(&source).is_err() {
            return Ok(None);
        }
        let temp = source.with_file_name(format!(".sync-moving-{}-{n}", std::process::id()));
        fs::rename(&source, &temp)?;
        Ok(Some(temp))
    }

    /// Puts a parked file at `relative`; false, moving nothing, when that is taken.
    fn unpark(&self, temp: &Path, relative: &str) -> io::Result<bool> {
        let target = self.resolve(relative, true)?;
        if fs::symlink_metadata(&target).is_ok() {
            return Ok(false);
        }
        fs::rename(temp, target)?;
        Ok(true)
    }

    /// Whether something is at `relative`; false too when a folder on the way is missing.
    fn exists(&self, relative: &str) -> io::Result<bool> {
        match self.resolve(relative, false).and_then(fs::symlink_metadata) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// A free name beside a file: "01 Night.md" gives "01 Night 2.md", "01 Night 3.md"…
    fn free_name_beside(&self, relative: &str) -> io::Result<String> {
        let (stem, extension) = match relative.rsplit_once('.') {
            Some((stem, extension)) if !stem.ends_with('/') && !extension.contains('/') => (stem, format!(".{extension}")),
            _ => (relative, String::new()),
        };
        for n in 2.. {
            let candidate = format!("{stem} {n}{extension}");
            if !self.exists(&candidate)? {
                return Ok(candidate);
            }
        }
        unreachable!("the loop only ends by returning")
    }

    fn read_dir_exists(&self, relative: &str) -> io::Result<bool> {
        match self.resolve(relative, false).and_then(fs::symlink_metadata) {
            Ok(meta) => Ok(meta.is_dir()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// The synced files and folders here, with each file's content.
    fn scan(&self) -> io::Result<(BTreeMap<String, Vec<u8>>, BTreeSet<String>)> {
        let mut files = BTreeMap::new();
        let mut folders = BTreeSet::new();
        for name in ROOT_FILES {
            if let Some(bytes) = self.read(name)? {
                files.insert(name.to_string(), bytes);
            }
        }
        for top in SYNCED_FOLDERS {
            let dir = self.root.join(top);
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() => {
                    folders.insert(top.to_string());
                    self.scan_folder(&dir, top, &mut files, &mut folders)?;
                }
                // Read as empty, it would delete everything in it from the cloud.
                Ok(_) => return Err(invalid(format!("the {top} folder is a link to another place, not a folder"))),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok((files, folders))
    }

    fn scan_folder(
        &self,
        dir: &Path,
        relative: &str,
        files: &mut BTreeMap<String, Vec<u8>>,
        folders: &mut BTreeSet<String>,
    ) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name_text) = name.to_str() else { continue };
            if is_hidden(&name) {
                continue;
            }
            let child = format!("{relative}/{name_text}");
            let kind = entry.file_type()?;
            if kind.is_dir() {
                folders.insert(child.clone());
                self.scan_folder(&entry.path(), &child, files, folders)?;
            } else if kind.is_file() && is_synced_file(&child) {
                files.insert(child, fs::read(entry.path())?);
            }
        }
        Ok(())
    }

    fn state_dir(&self) -> PathBuf {
        self.root.join(STATE_DIR)
    }

    fn base_path(&self, id: &str) -> PathBuf {
        let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        self.state_dir().join(BASE_DIR).join(safe)
    }

    fn read_base(&self, id: &str) -> io::Result<Option<Vec<u8>>> {
        match fs::read(self.base_path(id)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write_base(&self, id: &str, bytes: &[u8]) -> io::Result<()> {
        fs::create_dir_all(self.state_dir().join(BASE_DIR))?;
        atomic_write(&self.base_path(id), bytes)
    }

    fn remove_base(&self, id: &str) -> io::Result<()> {
        match fs::remove_file(self.base_path(id)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

fn state_path(root: &Path) -> PathBuf {
    root.join(STATE_DIR).join(STATE_FILE)
}

/// The project's sync state, or None when the project isn't synced.
pub fn read_state(root: &Path) -> io::Result<Option<SyncState>> {
    match fs::read_to_string(state_path(root)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| invalid(format!("the sync state could not be read: {e}"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write_state(root: &Path, state: &SyncState) -> io::Result<()> {
    fs::create_dir_all(root.join(STATE_DIR))?;
    let text = serde_json::to_string_pretty(state).map_err(|e| invalid(e.to_string()))?;
    atomic_write(&state_path(root), text.as_bytes())
}

/// Starts syncing a project with `remote_root` in the cloud: the next sync
/// takes it from there. Nothing is sent yet.
pub fn link(root: &Path, account_id: &str, remote_root: &str) -> io::Result<()> {
    if read_state(root)?.is_some() {
        return Err(invalid("the project is already synced"));
    }
    let state = SyncState {
        version: STATE_VERSION,
        account_id: account_id.to_string(),
        remote_root: remote_root.to_string(),
        cursor: None,
        files: BTreeMap::new(),
        folders: BTreeSet::new(),
        moves: Vec::new(),
    };
    write_state(root, &state)
}

/// Notes moves made on this device (by the binder), so the next sync makes
/// them in the cloud too and the files keep their identity. Does nothing
/// for a project that isn't synced.
pub fn record_moves(root: &Path, moves: &[Move]) -> io::Result<()> {
    let Some(mut state) = read_state(root)? else { return Ok(()) };
    if moves.is_empty() {
        return Ok(());
    }
    let moved = |path: &str| moves.iter().find_map(|(from, to)| rebased(path, from, to));
    state.files = std::mem::take(&mut state.files)
        .into_iter()
        .map(|(path, synced)| (moved(&path).unwrap_or(path), synced))
        .collect();
    state.folders = std::mem::take(&mut state.folders)
        .into_iter()
        .map(|path| moved(&path).unwrap_or(path))
        .collect();
    state.moves.push(moves.to_vec());
    write_state(root, &state)
}

/// Orders moves made at once so each target is free when its turn comes:
/// a move waits while its target is still the source of another, and a
/// cycle (two chapters swapping names) goes through a temporary name.
fn in_order(moves: &[Move], temporary: impl Fn(&str, usize) -> String) -> Vec<Move> {
    let mut pending: Vec<Move> = moves.to_vec();
    let mut out = Vec::new();
    let mut temps = 0;
    while !pending.is_empty() {
        // A target is taken while another move's source is at it, in it, or around it.
        let taken = |i: usize| {
            let to = &pending[i].1;
            pending.iter().enumerate().any(|(j, (from, _))| j != i && (within(to, from) || within(from, to)))
        };
        match (0..pending.len()).find(|&i| !taken(i)) {
            Some(i) => out.push(pending.remove(i)),
            None => {
                let (from, to) = pending.remove(0);
                let temp = temporary(&from, temps);
                temps += 1;
                out.push((from, temp.clone()));
                pending.push((temp, to));
            }
        }
    }
    out
}

/// One project being synced.
pub struct Sync<'a, R: Remote> {
    remote: &'a R,
    local: Local,
    state: SyncState,
}

impl<'a, R: Remote> Sync<'a, R> {
    /// The sync of the project at `root`, or None when it isn't synced.
    /// Refused when it syncs with another account than `account_id`.
    pub fn open(remote: &'a R, root: &Path, account_id: &str) -> Result<Option<Self>> {
        let Some(state) = read_state(root)? else { return Ok(None) };
        if state.account_id != account_id {
            return Err(SyncError::Stopped(
                "This project syncs with another Dropbox account. Connect that account to sync it.".into(),
            ));
        }
        Ok(Some(Self { remote, local: Local { root: root.to_path_buf() }, state }))
    }

    fn remote_path(&self, relative: &str) -> String {
        format!("{}/{relative}", self.state.remote_root.trim_end_matches('/'))
    }

    fn save(&self) -> io::Result<()> {
        write_state(&self.local.root, &self.state)
    }

    /// Pulls, then pushes. Moves made here go first, so that what the pull
    /// reads is already at the paths this device uses. `lock` is held while
    /// files on this device are read and written, so a save from the editor
    /// never interleaves.
    pub fn run<T>(&mut self, lock: &Mutex<T>) -> Result<Outcome> {
        let mut out = Outcome::default();
        self.push_moves()?;
        self.pull(lock, &mut out)?;
        self.push(lock, &mut out)?;
        Ok(out)
    }

    fn forget(&mut self, path: &str) -> io::Result<()> {
        if let Some(synced) = self.state.files.remove(path) {
            self.local.remove_base(&synced.id)?;
        }
        Ok(())
    }

    fn remember(&mut self, path: &str, meta: &FileMeta, bytes: &[u8]) -> io::Result<()> {
        self.local.write_base(&meta.id, bytes)?;
        let synced = Synced { id: meta.id.clone(), rev: meta.rev.clone(), hash: meta.hash.clone() };
        self.state.files.insert(path.to_string(), synced);
        Ok(())
    }

    fn pull<T>(&mut self, lock: &Mutex<T>, out: &mut Outcome) -> Result<()> {
        let root = self.state.remote_root.clone();
        let gone = || SyncError::Stopped(format!(
            "The project's folder {root} is no longer in Dropbox: it was moved, renamed or deleted there. \
             Nothing was changed here; syncing is paused."
        ));
        let (listing, complete) = match self.state.cursor.clone() {
            Some(cursor) => match self.remote.changes(&cursor) {
                Err(RemoteError::Reset) => (self.remote.list(&root), true),
                other => (other, false),
            },
            None => (self.remote.list(&root), true),
        };
        let listing = match listing {
            Err(RemoteError::NotFound) => return Err(gone()),
            other => other?,
        };

        // Entries come in the order things happened: a later entry
        // supersedes earlier ones for the same path, a deletion supersedes
        // everything that was inside it, and a file's newest entry
        // supersedes the places it was before.
        let mut latest: Vec<(String, Entry)> = Vec::new();
        for entry in listing.entries {
            let path = match &entry {
                Entry::File(meta) => &meta.path,
                Entry::Folder { path } | Entry::Deleted { path } => path,
            };
            let Some(relative) = relative_to(&root, path) else { continue };
            if relative.is_empty() {
                if matches!(entry, Entry::Deleted { .. }) {
                    return Err(gone());
                }
                continue;
            }
            let lower = relative.to_lowercase();
            latest.retain(|(earlier, earlier_entry)| {
                let same_path = earlier.to_lowercase() == lower;
                let inside_deleted =
                    matches!(entry, Entry::Deleted { .. }) && within(&earlier.to_lowercase(), &lower);
                let same_file = matches!((&entry, earlier_entry), (Entry::File(a), Entry::File(b)) if a.id == b.id);
                !(same_path || inside_deleted || same_file)
            });
            latest.push((relative, entry));
        }

        let mut files: Vec<(String, FileMeta)> = Vec::new();
        let mut folders: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();
        for (relative, entry) in latest {
            match entry {
                Entry::File(meta) if is_synced_file(&relative) => files.push((relative, meta)),
                Entry::File(_) => {
                    if relative.ends_with(".md") || relative.ends_with(".MD") {
                        out.problems.push(format!(
                            "{relative} in Dropbox was left out: its name can't be used for a file on this device."
                        ));
                    }
                }
                Entry::Folder { .. } if is_synced_folder(&relative) => folders.push(relative),
                Entry::Folder { .. } => {}
                Entry::Deleted { .. } => deleted.push(relative),
            }
        }
        let listed_ids: BTreeSet<&str> = files.iter().map(|(_, m)| m.id.as_str()).collect();

        // What left the cloud: deleted paths (and everything in them), or,
        // when the whole folder was listed, every known file not in the list.
        let mut gone_files: Vec<String> = Vec::new();
        let mut gone_folders: Vec<String> = Vec::new();
        for (path, synced) in &self.state.files {
            // Deleted, in a deleted folder, or replaced by another file at its
            // path (whose entry supersedes the deletion's): and not moved.
            let removed = if complete {
                !listed_ids.contains(synced.id.as_str())
            } else {
                let touched = deleted.iter().any(|d| within(&path.to_lowercase(), &d.to_lowercase()))
                    || files.iter().any(|(p, meta)| same_name(p, path) && meta.id != synced.id);
                touched && !listed_ids.contains(synced.id.as_str())
            };
            if removed {
                gone_files.push(path.clone());
            }
        }
        for folder in &self.state.folders {
            let removed = if complete {
                !folders.iter().any(|f| same_name(f, folder))
            } else {
                deleted.iter().any(|d| within(&folder.to_lowercase(), &d.to_lowercase()))
                    && !folders.iter().any(|f| same_name(f, folder))
            };
            if removed {
                gone_folders.push(folder.clone());
            }
        }

        {
            let _guard = lock.lock().map_err(|_| SyncError::Stopped("The project is unavailable.".into()))?;

            // Gone first, so their paths are free for files moving here.
            for path in gone_files {
                let synced = self.state.files[&path].clone();
                match self.local.read(&path)? {
                    Some(bytes) if content_hash(&bytes) != synced.hash => {
                        // Edited here since: kept, and sent again as a new file.
                        out.problems.push(format!(
                            "{path} was deleted in Dropbox, but had changes on this device, so it was kept and will be sent again."
                        ));
                    }
                    Some(bytes) => {
                        self.local.remove(&path)?;
                        out.changed.push(Changed { path: path.clone(), before: String::from_utf8(bytes).ok(), after: None });
                        out.reshaped = true;
                    }
                    None => {}
                }
                self.forget(&path)?;
            }

            // Moves: known files now at other paths, made here at once, as
            // the other device made them. Each file first goes to a hidden
            // name beside it, then to its new path, so files can swap names.
            let by_id: HashMap<String, String> =
                self.state.files.iter().map(|(path, s)| (s.id.clone(), path.clone())).collect();
            let mut moving: Vec<(String, String, Synced)> = Vec::new();
            for (path, meta) in &files {
                if let Some(old) = by_id.get(&meta.id).filter(|old| *old != path) {
                    let synced = self.state.files.remove(old).expect("known by its id");
                    moving.push((old.clone(), path.clone(), synced));
                }
            }
            let mut parked = Vec::with_capacity(moving.len());
            for (i, (old, _, _)) in moving.iter().enumerate() {
                parked.push(self.local.park(old, i)?);
            }
            for ((old, path, synced), temp) in moving.into_iter().zip(parked) {
                let Some(temp) = temp else {
                    // Not here any more (deleted on this device): it comes down
                    // at its new path, rather than be deleted everywhere.
                    self.local.remove_base(&synced.id)?;
                    continue;
                };
                if self.local.exists(&path)? {
                    // A file made here since the last sync has that name: it
                    // steps aside, and goes up under its new name.
                    let aside = self.local.free_name_beside(&path)?;
                    self.local.rename(&path, &aside)?;
                    // Not in Dropbox under that name: it goes up as a new file.
                    self.forget(&path)?;
                    out.problems.push(format!(
                        "{path} on this device was renamed {aside}, as another device moved a file to that name."
                    ));
                }
                if !self.local.unpark(&temp, &path)? {
                    return Err(SyncError::Local(invalid(format!("{old} could not be moved to {path}"))));
                }
                out.moved.push((old, path.clone()));
                out.reshaped = true;
                self.state.files.insert(path, synced);
            }

            // Deepest first, so a folder is empty once what was in it has
            // moved or gone. One still holding something stays.
            gone_folders.sort_by(|a, b| b.cmp(a));
            for folder in gone_folders {
                self.local.remove_folder_if_empty(&folder)?;
                if self.local.read_dir_exists(&folder)? {
                    continue;
                }
                self.state.folders.remove(&folder);
                out.reshaped = true;
            }

            for folder in &folders {
                if !self.state.folders.contains(folder) {
                    self.local.make_folder(folder)?;
                    self.state.folders.insert(folder.clone());
                    out.reshaped = true;
                }
            }
        }

        // Content: files that are new here, or have a new revision.
        let mut wanted: Vec<(String, FileMeta)> = Vec::new();
        for (path, meta) in files {
            match self.state.files.get(&path) {
                Some(synced) if synced.rev == meta.rev && synced.id == meta.id => {}
                Some(synced) if synced.hash == meta.hash && synced.id == meta.id => {
                    // A new revision with the same content (our own upload, seen again).
                    let synced = Synced { rev: meta.rev.clone(), ..synced.clone() };
                    self.state.files.insert(path, synced);
                }
                _ => wanted.push((path, meta)),
            }
        }
        let downloads = self.download_all(&wanted);
        let _guard = lock.lock().map_err(|_| SyncError::Stopped("The project is unavailable.".into()))?;
        // The cursor moves on only once everything listed is here, so a file
        // skipped now is listed again next time.
        let mut all_in = true;
        for ((path, listed), download) in wanted.into_iter().zip(downloads) {
            match download {
                Ok((meta, theirs)) if meta.id == listed.id => self.take_in(&path, &meta, &theirs, out)?,
                // Gone or replaced since it was listed: the next sync sees what became of it.
                Ok(_) | Err(RemoteError::NotFound) => all_in = false,
                Err(e) => {
                    self.save()?;
                    return Err(e.into());
                }
            }
        }
        if all_in {
            self.state.cursor = Some(listing.cursor);
        } else {
            out.again = true;
        }
        self.save()?;
        Ok(())
    }

    /// Brings a file's version from the cloud into the file here, merged
    /// with the changes made here since the last sync.
    fn take_in(&mut self, path: &str, meta: &FileMeta, theirs: &[u8], out: &mut Outcome) -> Result<()> {
        let ours = self.local.read(path)?;
        // The file last synced at this path; it may have been replaced in
        // the cloud by a new file of the same name (another id).
        let known = self.state.files.get(path).cloned();
        let base = match &known {
            Some(synced) => self.local.read_base(&synced.id)?,
            None => None,
        };
        let unchanged_here = match (&ours, &known) {
            (None, _) => true,
            (Some(bytes), Some(synced)) => content_hash(bytes) == synced.hash,
            (Some(_), None) => false,
        };
        let text = |bytes: &[u8]| String::from_utf8(bytes.to_vec()).ok();
        let result: Vec<u8> = if unchanged_here || ours.as_deref() == Some(theirs) {
            theirs.to_vec()
        } else {
            let ours = ours.clone().expect("changed here, so present");
            let base = base.unwrap_or_default();
            match (text(&base), text(&ours), text(theirs)) {
                (Some(base), Some(ours_text), Some(theirs_text)) => {
                    let merged = if path == "project.json" {
                        merge::merge_json(&base, &ours_text, &theirs_text)
                    } else {
                        Some(merge::merge_text(&base, &ours_text, &theirs_text))
                    };
                    match merged {
                        Some(merged) => {
                            if merged.conflicts > 0 {
                                out.conflicts.push(path.to_string());
                            }
                            merged.text.into_bytes()
                        }
                        None => {
                            out.problems.push(format!(
                                "{path} was changed on two devices and one version can't be read, so this device's version was kept. \
                                 Dropbox keeps the other in the file's version history."
                            ));
                            ours
                        }
                    }
                }
                _ => {
                    out.problems.push(format!(
                        "{path} was changed on two devices and isn't text that can be merged, so this device's version was kept. \
                         Dropbox keeps the other in the file's version history."
                    ));
                    ours
                }
            }
        };
        if ours.as_deref() != Some(&result[..]) {
            self.local.write(path, &result)?;
            if ours.is_none() {
                out.reshaped = true;
            }
            out.changed.push(Changed {
                path: path.to_string(),
                before: ours.as_deref().and_then(text),
                after: text(&result),
            });
        }
        if let Some(previous) = known.filter(|k| k.id != meta.id) {
            self.local.remove_base(&previous.id)?;
        }
        self.remember(path, meta, theirs)?;
        Ok(())
    }

    /// Downloads files several at a time, each result in the order asked.
    fn download_all(&self, wanted: &[(String, FileMeta)]) -> Vec<std::result::Result<(FileMeta, Vec<u8>), RemoteError>> {
        let next = AtomicUsize::new(0);
        let results: Vec<Mutex<Option<_>>> = wanted.iter().map(|_| Mutex::new(None)).collect();
        std::thread::scope(|scope| {
            for _ in 0..DOWNLOADS_AT_ONCE.min(wanted.len()) {
                scope.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        let Some((_, meta)) = wanted.get(i) else { break };
                        // By id, so a file renamed since it was listed is still found.
                        let result = self.remote.download(&meta.id);
                        *results[i].lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
                    }
                });
            }
        });
        results
            .into_iter()
            .map(|r| {
                r.into_inner()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .unwrap_or_else(|| Err(RemoteError::Failed("The download did not run.".into())))
            })
            .collect()
    }

    /// Makes the moves made here in the cloud too, so files keep their
    /// identity there and on other devices.
    fn push_moves(&mut self) -> Result<()> {
        while !self.state.moves.is_empty() {
            let batch = self.state.moves[0].clone();
            let stamp = std::process::id();
            let ordered = in_order(&batch, |from, i| {
                let parent = from.rsplit_once('/').map_or("", |(p, _)| p);
                format!("{parent}/.moving-{stamp}-{i}")
            });
            for (from, to) in &ordered {
                match self.remote.move_to(&self.remote_path(from), &self.remote_path(to)) {
                    Ok(()) => {}
                    Err(RemoteError::NotFound | RemoteError::Conflict) => {
                        // Not in the cloud as it was here: what is at the new
                        // path here goes up as new files.
                        let stale: Vec<String> =
                            self.state.files.keys().filter(|p| within(p, to)).cloned().collect();
                        for path in stale {
                            self.forget(&path)?;
                        }
                        self.state.folders.retain(|f| !within(f, to));
                    }
                    Err(e) => {
                        self.save()?;
                        return Err(e.into());
                    }
                }
            }
            self.state.moves.remove(0);
            self.save()?;
        }

        Ok(())
    }

    fn push<T>(&mut self, lock: &Mutex<T>, out: &mut Outcome) -> Result<()> {
        let (files, folders) = {
            let _guard = lock.lock().map_err(|_| SyncError::Stopped("The project is unavailable.".into()))?;
            self.local.scan()?
        };
        for top in SYNCED_FOLDERS {
            if self.state.folders.contains(top) && !folders.contains(top) {
                return Err(SyncError::Stopped(format!(
                    "The {top} folder is missing from the project on this device. Syncing is paused, \
                     so Dropbox keeps it: put the folder back, or remove the project from this device."
                )));
            }
        }

        for folder in &folders {
            if !self.state.folders.contains(folder) {
                self.remote.create_folder(&self.remote_path(folder))?;
                self.state.folders.insert(folder.clone());
            }
        }

        for (path, bytes) in &files {
            let hash = content_hash(bytes);
            let rev = match self.state.files.get(path) {
                Some(synced) if synced.hash == hash => continue,
                Some(synced) => Some(synced.rev.clone()),
                None => None,
            };
            match self.remote.upload(&self.remote_path(path), bytes, rev.as_deref()) {
                Ok(meta) => self.remember(path, &meta, bytes)?,
                // Changed in the cloud since the pull: the next sync merges it.
                Err(RemoteError::Conflict) => out.again = true,
                Err(e) => {
                    self.save()?;
                    return Err(e.into());
                }
            }
        }

        // Files gone from here: deleted in the cloud too, unless changed there since.
        let missing: Vec<(String, Synced)> = self
            .state
            .files
            .iter()
            .filter(|(path, _)| !files.contains_key(*path))
            .map(|(p, s)| (p.clone(), s.clone()))
            .collect();
        for (path, synced) in missing {
            match self.remote.delete(&self.remote_path(&path), Some(&synced.rev)) {
                Ok(()) | Err(RemoteError::NotFound) => self.forget(&path)?,
                Err(RemoteError::Conflict) => out.again = true,
                Err(e) => {
                    self.save()?;
                    return Err(e.into());
                }
            }
        }
        // Folders gone from here: deleted in the cloud only once nothing is in them there.
        let mut gone: Vec<String> = self.state.folders.iter().filter(|f| !folders.contains(*f)).cloned().collect();
        gone.sort_by(|a, b| b.cmp(a));
        for folder in gone {
            match self.remote.list(&self.remote_path(&folder)) {
                Ok(listing) if listing.entries.iter().all(|e| !matches!(e, Entry::File(_))) => {
                    match self.remote.delete(&self.remote_path(&folder), None) {
                        Ok(()) | Err(RemoteError::NotFound) => {
                            self.state.folders.remove(&folder);
                        }
                        Err(e) => {
                            self.save()?;
                            return Err(e.into());
                        }
                    }
                }
                Ok(_) => out.again = true,
                Err(RemoteError::NotFound) => {
                    self.state.folders.remove(&folder);
                }
                Err(e) => {
                    self.save()?;
                    return Err(e.into());
                }
            }
        }
        self.save()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
