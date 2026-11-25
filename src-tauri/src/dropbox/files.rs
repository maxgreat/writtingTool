//! Dropbox's files API, as sync uses it (see sync::remote::Remote). Paths
//! are inside the app's own folder: "/Night Ferry" is
//! Dropbox/Apps/<app name>/Night Ferry.

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use super::{Connection, DropboxState};
use crate::sync::remote::{Entry, FileMeta, Listing, Remote, RemoteError, Result};

const API: &str = "https://api.dropboxapi.com/2/";
const CONTENT: &str = "https://content.dropboxapi.com/2/";
/// The largest file sync takes; chapters and sheets are a tiny part of it.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Times a request is tried again when Dropbox asks to slow down.
const RETRIES: usize = 3;

/// A request's failure, before it is read as sync's.
enum Http {
    Unauthorized,
    /// Too many requests: wait this many seconds.
    SlowDown(u64),
    Refused(u16, String),
    Unreachable(String),
}

/// The writer's Dropbox, signed in as `connection`.
pub struct DropboxFiles<'a> {
    state: &'a DropboxState,
    dir: PathBuf,
    connection: Connection,
}

impl<'a> DropboxFiles<'a> {
    pub(super) fn new(state: &'a DropboxState, dir: PathBuf, connection: Connection) -> Self {
        Self { state, dir, connection }
    }

    pub fn account_id(&self) -> &str {
        &self.connection.account.account_id
    }

    /// Runs a request with an access token: with a new token once if the
    /// first has expired, and again after a pause when Dropbox asks.
    fn authed<T>(&self, call: impl Fn(&str) -> std::result::Result<T, Http>) -> Result<T> {
        let token = |fresh| {
            self.state
                .access_token(&self.dir, &self.connection, fresh)
                .map_err(|e| RemoteError::Failed(e.message()))
        };
        let mut access = token(false)?;
        let mut renewed = false;
        let mut tries = 0;
        loop {
            match call(&access) {
                Ok(value) => return Ok(value),
                Err(Http::Unauthorized) if !renewed => {
                    renewed = true;
                    access = token(true)?;
                }
                Err(Http::Unauthorized) => {
                    return Err(RemoteError::Failed(
                        "Dropbox no longer accepts this app's access. Connect Dropbox again in Settings.".into(),
                    ));
                }
                Err(Http::SlowDown(seconds)) if tries < RETRIES => {
                    tries += 1;
                    std::thread::sleep(Duration::from_secs(seconds.clamp(1, 30)));
                }
                Err(Http::SlowDown(_)) => {
                    return Err(RemoteError::Failed("Dropbox asks to slow down. Sync will try again shortly.".into()));
                }
                Err(Http::Refused(409, body)) => return Err(route_error(&body)),
                Err(Http::Refused(status, _)) => {
                    return Err(RemoteError::Failed(format!("Dropbox answered with an error ({status}).")));
                }
                Err(Http::Unreachable(message)) => return Err(RemoteError::Failed(message)),
            }
        }
    }

    fn rpc(&self, route: &str, body: &Value) -> Result<Value> {
        let text = body.to_string();
        self.authed(|token| {
            let response = self
                .state
                .agent
                .post(format!("{API}{route}"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .send(&text);
            let (_, bytes) = answer(response, 4 * 1024 * 1024)?;
            serde_json::from_slice(&bytes).map_err(|e| Http::Unreachable(format!("Dropbox's answer could not be read: {e}")))
        })
    }

    /// list_folder, or list_folder/continue, with every page.
    fn listing(&self, route: &str, body: Value) -> Result<Listing> {
        let mut page: ListPage = parse(self.rpc(route, &body)?)?;
        let mut entries = Vec::new();
        loop {
            entries.extend(page.entries.into_iter().filter_map(ListEntry::into_entry));
            if !page.has_more {
                return Ok(Listing { entries, cursor: page.cursor });
            }
            page = parse(self.rpc("files/list_folder/continue", &json!({ "cursor": page.cursor }))?)?;
        }
    }
}

/// A request's answer: its status and body, or why it failed.
fn answer(
    response: std::result::Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    limit: u64,
) -> std::result::Result<(ureq::http::HeaderMap, Vec<u8>), Http> {
    let mut response = response.map_err(|e| Http::Unreachable(format!("Dropbox could not be reached: {e}")))?;
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = response
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_vec()
        .map_err(|e| Http::Unreachable(format!("Dropbox's answer could not be read: {e}")))?;
    match status {
        200 => Ok((headers, bytes)),
        401 => Err(Http::Unauthorized),
        429 | 503 => {
            let wait = headers.get("Retry-After").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
            Err(Http::SlowDown(wait.unwrap_or(2)))
        }
        _ => Err(Http::Refused(status, String::from_utf8_lossy(&bytes).into_owned())),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| RemoteError::Failed(format!("Dropbox's answer could not be read: {e}")))
}

/// Reads a route's own error (HTTP 409) as sync's.
fn route_error(body: &str) -> RemoteError {
    #[derive(Deserialize)]
    struct ErrorAnswer {
        error_summary: String,
    }
    let Ok(ErrorAnswer { error_summary }) = serde_json::from_str(body) else {
        return RemoteError::Failed("Dropbox refused the request.".into());
    };
    let summary = error_summary.trim_end_matches(['/', '.']);
    if summary.starts_with("reset") {
        RemoteError::Reset
    } else if summary.contains("not_found") {
        RemoteError::NotFound
    } else if summary.contains("/conflict") {
        RemoteError::Conflict
    } else if summary.contains("insufficient_space") {
        RemoteError::Failed("Your Dropbox is full. Make room in it for sync to go on.".into())
    } else {
        RemoteError::Failed(format!("Dropbox refused: {summary}."))
    }
}

/// JSON for the Dropbox-API-Arg header, which takes ASCII only: other
/// characters are written as \u escapes.
fn header_arg(value: &Value) -> String {
    let mut out = String::new();
    for c in value.to_string().chars() {
        if (c as u32) < 0x7f {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct ListPage {
    entries: Vec<ListEntry>,
    cursor: String,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(tag = ".tag", rename_all = "lowercase")]
enum ListEntry {
    File(FileAnswer),
    Folder { path_display: Option<String> },
    Deleted { path_display: Option<String> },
}

impl ListEntry {
    fn into_entry(self) -> Option<Entry> {
        Some(match self {
            ListEntry::File(file) => Entry::File(file.into_meta()),
            ListEntry::Folder { path_display } => Entry::Folder { path: path_display? },
            ListEntry::Deleted { path_display } => Entry::Deleted { path: path_display? },
        })
    }
}

#[derive(Deserialize)]
struct FileAnswer {
    id: String,
    path_display: String,
    rev: String,
    #[serde(default)]
    content_hash: String,
}

impl FileAnswer {
    fn into_meta(self) -> FileMeta {
        FileMeta { id: self.id, path: self.path_display, rev: self.rev, hash: self.content_hash }
    }
}

impl Remote for DropboxFiles<'_> {
    fn top_folders(&self) -> Result<Vec<String>> {
        let page: ListPage = parse(self.rpc("files/list_folder", &json!({ "path": "", "recursive": false }))?)?;
        let mut folders: Vec<String> = Vec::new();
        let mut page = Some(page);
        while let Some(current) = page.take() {
            for entry in current.entries {
                if let ListEntry::Folder { path_display: Some(path) } = entry {
                    folders.push(path);
                }
            }
            if current.has_more {
                page = Some(parse(self.rpc("files/list_folder/continue", &json!({ "cursor": current.cursor }))?)?);
            }
        }
        Ok(folders)
    }

    fn list(&self, folder: &str) -> Result<Listing> {
        self.listing(
            "files/list_folder",
            json!({ "path": folder, "recursive": true, "include_deleted": false, "limit": 2000 }),
        )
    }

    fn changes(&self, cursor: &str) -> Result<Listing> {
        self.listing("files/list_folder/continue", json!({ "cursor": cursor }))
    }

    fn download(&self, path: &str) -> Result<(FileMeta, Vec<u8>)> {
        let arg = header_arg(&json!({ "path": path }));
        self.authed(|token| {
            let response = self
                .state
                .agent
                .post(format!("{CONTENT}files/download"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Dropbox-API-Arg", &arg)
                .send_empty();
            let (headers, bytes) = answer(response, MAX_FILE_BYTES)?;
            let meta = headers
                .get("Dropbox-API-Result")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| serde_json::from_str::<FileAnswer>(v).ok())
                .ok_or_else(|| Http::Unreachable("Dropbox sent a file without saying which version it is.".into()))?;
            Ok((meta.into_meta(), bytes))
        })
    }

    fn upload(&self, path: &str, bytes: &[u8], rev: Option<&str>) -> Result<FileMeta> {
        let mode = match rev {
            Some(rev) => json!({ ".tag": "update", "update": rev }),
            None => json!("add"),
        };
        let arg = header_arg(&json!({
            "path": path,
            "mode": mode,
            "autorename": false,
            "mute": true,
            "strict_conflict": true,
        }));
        self.authed(|token| {
            let response = self
                .state
                .agent
                .post(format!("{CONTENT}files/upload"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Dropbox-API-Arg", &arg)
                .header("Content-Type", "application/octet-stream")
                .send(bytes);
            let (_, body) = answer(response, 4 * 1024 * 1024)?;
            serde_json::from_slice::<FileAnswer>(&body)
                .map(FileAnswer::into_meta)
                .map_err(|e| Http::Unreachable(format!("Dropbox's answer could not be read: {e}")))
        })
    }

    fn create_folder(&self, path: &str) -> Result<()> {
        match self.rpc("files/create_folder_v2", &json!({ "path": path, "autorename": false })) {
            Ok(_) => Ok(()),
            // Already there: a folder is fine, a file in the way isn't.
            Err(RemoteError::Conflict) => match self.rpc("files/get_metadata", &json!({ "path": path })) {
                Ok(meta) if meta.get(".tag").and_then(Value::as_str) == Some("folder") => Ok(()),
                Ok(_) => Err(RemoteError::Conflict),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        }
    }

    fn move_to(&self, from: &str, to: &str) -> Result<()> {
        let body = json!({ "from_path": from, "to_path": to, "autorename": false, "allow_ownership_transfer": false });
        self.rpc("files/move_v2", &body).map(|_| ())
    }

    fn delete(&self, path: &str, rev: Option<&str>) -> Result<()> {
        let body = match rev {
            Some(rev) => json!({ "path": path, "parent_rev": rev }),
            None => json!({ "path": path }),
        };
        self.rpc("files/delete_v2", &body).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_the_header_argument_to_ascii() {
        let arg = header_arg(&json!({ "path": "/Le Passeur/manuscript/01 L’arrivée 🚣.md" }));
        assert!(arg.is_ascii());
        assert_eq!(arg, r#"{"path":"/Le Passeur/manuscript/01 L\u2019arriv\u00e9e \ud83d\udea3.md"}"#);
        let back: Value = serde_json::from_str(&arg).unwrap();
        assert_eq!(back["path"], "/Le Passeur/manuscript/01 L’arrivée 🚣.md");
    }

    #[test]
    fn reads_route_errors_as_sync_does() {
        let error = |summary: &str| route_error(&format!(r#"{{"error_summary":"{summary}","error":{{}}}}"#));
        assert_eq!(error("path/conflict/file/.."), RemoteError::Conflict);
        assert_eq!(error("to/conflict/folder/."), RemoteError::Conflict);
        assert_eq!(error("path/not_found/.."), RemoteError::NotFound);
        assert_eq!(error("from_lookup/not_found/"), RemoteError::NotFound);
        assert_eq!(error("reset/.."), RemoteError::Reset);
        assert!(matches!(error("path/insufficient_space/"), RemoteError::Failed(m) if m.contains("full")));
        assert!(matches!(error("path/disallowed_name/"), RemoteError::Failed(m) if m.contains("disallowed_name")));
        assert!(matches!(route_error("<html>"), RemoteError::Failed(_)));
    }

    #[test]
    fn reads_listings() {
        let page: ListPage = serde_json::from_str(
            r#"{"entries":[
                {".tag":"folder","name":"manuscript","path_lower":"/mynovel/manuscript","path_display":"/MyNovel/manuscript","id":"id:f"},
                {".tag":"file","name":"01.md","path_lower":"/mynovel/manuscript/01.md","path_display":"/MyNovel/manuscript/01.md","id":"id:a","rev":"015f","size":12,"content_hash":"abc","client_modified":"2026-11-25T10:00:00Z","server_modified":"2026-11-25T10:00:00Z","is_downloadable":true},
                {".tag":"deleted","name":"old.md","path_lower":"/mynovel/old.md","path_display":"/MyNovel/old.md"}
            ],"cursor":"C1","has_more":false}"#,
        )
        .unwrap();
        let entries: Vec<Entry> = page.entries.into_iter().filter_map(ListEntry::into_entry).collect();
        assert_eq!(
            entries,
            vec![
                Entry::Folder { path: "/MyNovel/manuscript".into() },
                Entry::File(FileMeta { id: "id:a".into(), path: "/MyNovel/manuscript/01.md".into(), rev: "015f".into(), hash: "abc".into() }),
                Entry::Deleted { path: "/MyNovel/old.md".into() },
            ]
        );
        assert_eq!(page.cursor, "C1");
    }
}
