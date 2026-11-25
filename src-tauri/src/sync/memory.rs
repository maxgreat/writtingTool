//! A cloud folder in memory, for the tests: it behaves as Dropbox does for
//! what sync uses (ids that survive moves, revisions, guarded writes, a
//! change log read through cursors, paths compared without case).

use std::collections::BTreeMap;
use std::sync::Mutex;

use super::remote::{Entry, FileMeta, Listing, Remote, RemoteError, Result, content_hash};

#[derive(Clone)]
struct File {
    id: String,
    path: String,
    rev: String,
    bytes: Vec<u8>,
}

impl File {
    fn meta(&self) -> FileMeta {
        FileMeta { id: self.id.clone(), path: self.path.clone(), rev: self.rev.clone(), hash: content_hash(&self.bytes) }
    }
}

#[derive(Default)]
struct Inner {
    /// By path without case.
    files: BTreeMap<String, File>,
    folders: BTreeMap<String, String>,
    log: Vec<Entry>,
    counter: u64,
}

fn key(path: &str) -> String {
    path.to_lowercase()
}

fn parent(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(p, _)| p).filter(|p| !p.is_empty())
}

fn inside(path: &str, folder: &str) -> bool {
    key(path).starts_with(&format!("{}/", key(folder)))
}

impl Inner {
    fn next(&mut self) -> u64 {
        self.counter += 1;
        self.counter
    }

    fn make_folders(&mut self, path: &str) {
        if let Some(up) = parent(path) {
            self.make_folders(up);
        }
        if !self.folders.contains_key(&key(path)) {
            self.folders.insert(key(path), path.to_string());
            self.log.push(Entry::Folder { path: path.to_string() });
        }
    }

    fn put(&mut self, path: &str, bytes: &[u8]) -> FileMeta {
        if let Some(up) = parent(path) {
            self.make_folders(up);
        }
        let n = self.next();
        let id = self.files.get(&key(path)).map_or_else(|| format!("id:{n}"), |f| f.id.clone());
        let file = File { id, path: path.to_string(), rev: format!("rev{n}"), bytes: bytes.to_vec() };
        let meta = file.meta();
        self.files.insert(key(path), file);
        self.log.push(Entry::File(meta.clone()));
        meta
    }

    fn exists(&self, path: &str) -> bool {
        self.files.contains_key(&key(path)) || self.folders.contains_key(&key(path))
    }
}

#[derive(Default)]
pub struct Memory {
    inner: Mutex<Inner>,
    /// Run just before the next upload: another device saving meanwhile.
    before_upload: Mutex<Option<Box<dyn FnOnce(&Memory) + Send>>>,
}

impl Memory {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        f(&mut self.inner.lock().unwrap())
    }

    /// Another device, or the Dropbox website, saves a file.
    pub fn edit(&self, path: &str, text: &str) {
        self.with(|m| m.put(path, text.as_bytes()));
    }

    pub fn text(&self, path: &str) -> Option<String> {
        self.with(|m| m.files.get(&key(path)).map(|f| String::from_utf8(f.bytes.clone()).unwrap()))
    }

    pub fn id(&self, path: &str) -> Option<String> {
        self.with(|m| m.files.get(&key(path)).map(|f| f.id.clone()))
    }

    pub fn paths(&self) -> Vec<String> {
        self.with(|m| m.files.values().map(|f| f.path.clone()).collect())
    }

    pub fn has_folder(&self, path: &str) -> bool {
        self.with(|m| m.folders.contains_key(&key(path)))
    }

    pub fn before_next_upload(&self, action: impl FnOnce(&Memory) + Send + 'static) {
        *self.before_upload.lock().unwrap() = Some(Box::new(action));
    }

    /// Makes every cursor given out so far unusable, as Dropbox sometimes does.
    pub fn reset_cursors(&self) {
        self.with(|m| m.log.push(Entry::Deleted { path: "\u{0}reset".into() }));
    }
}

fn cursor(folder: &str, at: usize) -> String {
    format!("{at}|{folder}")
}

impl Remote for Memory {
    fn top_folders(&self) -> Result<Vec<String>> {
        Ok(self.with(|m| m.folders.values().filter(|p| p.matches('/').count() == 1).cloned().collect()))
    }

    fn list(&self, folder: &str) -> Result<Listing> {
        self.with(|m| {
            if !m.folders.contains_key(&key(folder)) {
                return Err(RemoteError::NotFound);
            }
            let mut entries: Vec<Entry> =
                m.folders.values().filter(|p| inside(p, folder)).map(|p| Entry::Folder { path: p.clone() }).collect();
            entries.extend(m.files.values().filter(|f| inside(&f.path, folder)).map(|f| Entry::File(f.meta())));
            Ok(Listing { entries, cursor: cursor(folder, m.log.len()) })
        })
    }

    fn changes(&self, given: &str) -> Result<Listing> {
        let (at, folder) = given.split_once('|').ok_or(RemoteError::Reset)?;
        let at: usize = at.parse().map_err(|_| RemoteError::Reset)?;
        self.with(|m| {
            let since = &m.log[at.min(m.log.len())..];
            if since.iter().any(|e| matches!(e, Entry::Deleted { path } if path == "\u{0}reset")) {
                return Err(RemoteError::Reset);
            }
            let entries = since
                .iter()
                .filter(|e| match e {
                    Entry::File(meta) => inside(&meta.path, folder),
                    Entry::Folder { path } => inside(path, folder),
                    Entry::Deleted { path } => inside(path, folder) || key(path) == key(folder),
                })
                .cloned()
                .collect();
            Ok(Listing { entries, cursor: cursor(folder, m.log.len()) })
        })
    }

    fn download(&self, path: &str) -> Result<(FileMeta, Vec<u8>)> {
        self.with(|m| {
            let file = if path.starts_with("id:") {
                m.files.values().find(|f| f.id == path)
            } else {
                m.files.get(&key(path))
            };
            file.map(|f| (f.meta(), f.bytes.clone())).ok_or(RemoteError::NotFound)
        })
    }

    fn upload(&self, path: &str, bytes: &[u8], rev: Option<&str>) -> Result<FileMeta> {
        if let Some(action) = self.before_upload.lock().unwrap().take() {
            action(self);
        }
        self.with(|m| {
            let current = m.files.get(&key(path)).map(|f| f.rev.clone());
            match (rev, current) {
                (None, None) if !m.folders.contains_key(&key(path)) => Ok(m.put(path, bytes)),
                (Some(rev), Some(current)) if rev == current => Ok(m.put(path, bytes)),
                _ => Err(RemoteError::Conflict),
            }
        })
    }

    fn create_folder(&self, path: &str) -> Result<()> {
        self.with(|m| {
            if m.files.contains_key(&key(path)) {
                return Err(RemoteError::Conflict);
            }
            m.make_folders(path);
            Ok(())
        })
    }

    fn move_to(&self, from: &str, to: &str) -> Result<()> {
        self.with(|m| {
            if !m.exists(from) {
                return Err(RemoteError::NotFound);
            }
            if m.exists(to) {
                return Err(RemoteError::Conflict);
            }
            if let Some(up) = parent(to) {
                m.make_folders(up);
            }
            m.log.push(Entry::Deleted { path: m.folders.get(&key(from)).cloned().unwrap_or_else(|| from.to_string()) });
            let moved = |p: &str| format!("{to}{}", &p[from.len()..]);
            let folders: Vec<String> =
                m.folders.values().filter(|p| key(p) == key(from) || inside(p, from)).cloned().collect();
            for old in folders {
                m.folders.remove(&key(&old));
                let new = moved(&old);
                m.folders.insert(key(&new), new.clone());
                m.log.push(Entry::Folder { path: new });
            }
            let files: Vec<File> =
                m.files.values().filter(|f| key(&f.path) == key(from) || inside(&f.path, from)).cloned().collect();
            for mut file in files {
                m.files.remove(&key(&file.path));
                file.path = moved(&file.path);
                m.log.push(Entry::File(file.meta()));
                m.files.insert(key(&file.path), file);
            }
            Ok(())
        })
    }

    fn delete(&self, path: &str, rev: Option<&str>) -> Result<()> {
        self.with(|m| {
            if let Some(file) = m.files.get(&key(path)) {
                if rev.is_some_and(|r| r != file.rev) {
                    return Err(RemoteError::Conflict);
                }
                m.files.remove(&key(path));
            } else if m.folders.contains_key(&key(path)) {
                m.folders.retain(|k, _| *k != key(path) && !k.starts_with(&format!("{}/", key(path))));
                m.files.retain(|k, _| !k.starts_with(&format!("{}/", key(path))));
            } else {
                return Err(RemoteError::NotFound);
            }
            m.log.push(Entry::Deleted { path: path.to_string() });
            Ok(())
        })
    }
}
