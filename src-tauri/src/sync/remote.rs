//! What sync needs from the cloud, so the engine can be tested without it:
//! Dropbox in the app (dropbox/files.rs), a folder in memory in the tests.
//!
//! Paths are Dropbox paths: absolute, `/`-separated, compared without case.

use sha2::{Digest, Sha256};

/// A file in the cloud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMeta {
    /// Stays the same when the file is renamed or moved.
    pub id: String,
    /// As the writer named it.
    pub path: String,
    /// Changes with each new version of the content.
    pub rev: String,
    /// See content_hash.
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    File(FileMeta),
    Folder { path: String },
    /// Something at `path` was deleted, or moved away.
    Deleted { path: String },
}

/// Entries in a folder, or changed since a cursor, with the cursor to ask
/// for the next changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub cursor: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    /// Nothing is at that path, or no longer.
    NotFound,
    /// A write was refused: the file has changed since the revision given,
    /// or something is already at that path.
    Conflict,
    /// The cursor can no longer be used: list from the start.
    Reset,
    /// Anything else, as a sentence for the writer.
    Failed(String),
}

impl RemoteError {
    pub fn message(&self) -> String {
        match self {
            RemoteError::NotFound => "It is no longer in Dropbox.".into(),
            RemoteError::Conflict => "It changed in Dropbox meanwhile.".into(),
            RemoteError::Reset => "Dropbox asked to read the folder again.".into(),
            RemoteError::Failed(message) => message.clone(),
        }
    }
}

pub type Result<T> = std::result::Result<T, RemoteError>;

/// The cloud's side of sync. Shared between threads: files download several
/// at a time.
pub trait Remote: Sync {
    /// The folders at the top of the app's folder: the projects.
    fn top_folders(&self) -> Result<Vec<String>>;
    /// Everything inside `folder`, at any depth.
    fn list(&self, folder: &str) -> Result<Listing>;
    /// What changed since `cursor`.
    fn changes(&self, cursor: &str) -> Result<Listing>;
    fn download(&self, path: &str) -> Result<(FileMeta, Vec<u8>)>;
    /// Writes a file: a new one when `rev` is None (Conflict if one is
    /// there), else in place of revision `rev` (Conflict if it has changed).
    fn upload(&self, path: &str, bytes: &[u8], rev: Option<&str>) -> Result<FileMeta>;
    /// Creates a folder, and any missing above it. Fine if it exists.
    fn create_folder(&self, path: &str) -> Result<()>;
    /// Moves a file or folder; Conflict if something is at `to`.
    fn move_to(&self, from: &str, to: &str) -> Result<()>;
    /// Deletes a file, only if it is still at revision `rev` (Conflict
    /// otherwise), or a folder with everything in it when `rev` is None.
    fn delete(&self, path: &str, rev: Option<&str>) -> Result<()>;
}

/// Dropbox's content hash: SHA-256 of the SHA-256 of each 4 MB block, in
/// hex. Tells whether a local file is the version in Dropbox without
/// downloading it.
pub fn content_hash(bytes: &[u8]) -> String {
    const BLOCK: usize = 4 * 1024 * 1024;
    let mut whole = Sha256::new();
    for block in bytes.chunks(BLOCK) {
        whole.update(Sha256::digest(block));
    }
    whole.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_content_as_dropbox_does() {
        // An empty file has no blocks.
        assert_eq!(content_hash(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let one_block = Sha256::digest(Sha256::digest(b"abc"));
        assert_eq!(content_hash(b"abc"), one_block.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let big = vec![7u8; 4 * 1024 * 1024 + 1];
        let mut two = Sha256::new();
        two.update(Sha256::digest(&big[..4 * 1024 * 1024]));
        two.update(Sha256::digest(&big[4 * 1024 * 1024..]));
        assert_eq!(content_hash(&big), two.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
}
