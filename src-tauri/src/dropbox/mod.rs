//! The writer's Dropbox: signing in and out, and the connection the app
//! keeps between launches. The app only ever sees its own folder,
//! Dropbox/Apps/<app name>.
//!
//! Kept in the app's data folder: `dropbox.json`, whose account is
//! connected and where its refresh token is kept (see credentials.rs).

mod api;
mod credentials;
mod files;
mod oauth;
pub mod projects;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

pub use api::Account;
use api::ApiError;
use credentials::Keeper;
use oauth::{AccessToken, Attempt, Loopback, TokenError};

/// The app's key in the Dropbox app console. It isn't a secret: with PKCE
/// there is no client secret, and every copy of the app carries the key.
const APP_KEY: &str = "24dw4vghy1ay4ai";

/// The key this build signs in with: APP_KEY, unless the build sets
/// WRITING_TOOL_DROPBOX_APP_KEY, for another Dropbox app, or sets it empty,
/// for a build with no Dropbox.
pub fn app_key() -> Option<&'static str> {
    key_from(option_env!("WRITING_TOOL_DROPBOX_APP_KEY"))
}

fn key_from(set: Option<&'static str>) -> Option<&'static str> {
    match set {
        None => Some(APP_KEY),
        Some(key) => Some(key.trim()).filter(|key| !key.is_empty()),
    }
}

fn require_app_key() -> Result<&'static str, String> {
    app_key().ok_or_else(|| "This build of the app has no Dropbox connection.".to_string())
}

/// How long the app waits for the writer to finish on Dropbox's page.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const CONNECTION_FILE: &str = "dropbox.json";

/// The connected account, as kept in `dropbox.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    account: Account,
    keeper: Keeper,
}

/// What the interface shows of the connection.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// None when no account is connected.
    account: Option<Account>,
    /// The sign-in is kept in a file, as there is no system keyring (some
    /// Linux desktops). Never set on Android, where a file is the norm.
    token_in_file: bool,
}

impl Status {
    fn of(connection: Option<&Connection>) -> Self {
        Self {
            account: connection.map(|c| c.account.clone()),
            token_in_file: cfg!(desktop) && connection.is_some_and(|c| c.keeper == Keeper::File),
        }
    }
}

/// How a sign-in started: whether Dropbox will show a code for the writer to
/// paste, because the app could not listen for its answer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInStart {
    manual: bool,
}

/// A sign-in waiting for Dropbox's answer.
struct SignIn {
    attempt: Attempt,
    /// Desktops: the local address the browser comes back to.
    loopback: Option<Loopback>,
    /// Android: the return addresses the system hands to the app.
    links: Option<mpsc::Receiver<String>>,
    cancelled: Arc<AtomicBool>,
}

impl SignIn {
    /// Waits for the code Dropbox sends back.
    fn wait(&self) -> Result<String, String> {
        let deadline = Instant::now() + SIGN_IN_TIMEOUT;
        if let Some(loopback) = &self.loopback {
            return loopback.wait(&self.attempt, &self.cancelled, deadline);
        }
        let Some(links) = &self.links else {
            return Err("Paste the code Dropbox shows to finish connecting.".into());
        };
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err(oauth::CANCELLED.into());
            }
            if Instant::now() >= deadline {
                return Err("Dropbox didn't answer in time. Connect again to retry.".into());
            }
            match links.recv_timeout(Duration::from_millis(200)) {
                Ok(link) => {
                    let query = url::Url::parse(&link).ok().and_then(|u| u.query().map(str::to_string));
                    if let Some(answer) = query.and_then(|q| self.attempt.read_answer(&q)) {
                        return answer;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // A newer sign-in took over the links.
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(oauth::CANCELLED.into()),
            }
        }
    }
}

/// The Dropbox connection, shared by the commands.
pub struct DropboxState {
    agent: ureq::Agent,
    access: Mutex<Option<AccessToken>>,
    sign_in: Mutex<Option<SignIn>>,
    /// The flag of the sign-in started last, which Cancel sets.
    cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Android: where the app's return addresses go while a sign-in waits.
    links: Mutex<Option<mpsc::Sender<String>>>,
}

impl Default for DropboxState {
    fn default() -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_global(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            agent,
            access: Mutex::new(None),
            sign_in: Mutex::new(None),
            cancel: Mutex::new(None),
            links: Mutex::new(None),
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A command that panicked leaves nothing half-done in these: each holds
    // a value that is replaced whole.
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl DropboxState {
    /// Android: the system opened one of the app's links. While a sign-in
    /// waits, it may be Dropbox's answer.
    #[cfg(mobile)]
    pub fn link_opened(&self, link: &str) {
        if let Some(sender) = locked(&self.links).as_ref() {
            // The sign-in may have just ended: then nobody needs the link.
            let _ = sender.send(link.to_string());
        }
    }

    /// Cancels the sign-in started last. Holding `cancel` while the flag is
    /// set means a sign-in that is keeping its access (see
    /// dropbox_sign_in_finish) has either finished or will see the flag.
    fn cancel_sign_in(&self) {
        let mut current = locked(&self.cancel);
        if let Some(flag) = current.take() {
            flag.store(true, Ordering::SeqCst);
        }
        locked(&self.sign_in).take();
        locked(&self.links).take();
    }

    /// An access token: the one in hand, or a new one from the refresh token.
    fn access_token(&self, dir: &Path, connection: &Connection, force_new: bool) -> Result<String, TokenError> {
        if !force_new {
            if let Some(access) = locked(&self.access).as_ref().filter(|a| Instant::now() < a.use_until) {
                return Ok(access.token.clone());
            }
        }
        let key = require_app_key().map_err(TokenError::Failed)?;
        let refresh = credentials::load(dir, connection.keeper)
            .map_err(TokenError::Failed)?
            .ok_or_else(|| TokenError::Refused("The Dropbox sign-in is missing on this device. Connect Dropbox again.".into()))?;
        let access = oauth::refresh(&self.agent, key, &refresh)?;
        let token = access.token.clone();
        *locked(&self.access) = Some(access);
        Ok(token)
    }

    /// Ends the app's access in Dropbox. Resolves to why Dropbox could not
    /// be told, when it couldn't be reached; None once the access is ended,
    /// or when Dropbox already refuses it (removed under Connected apps) or
    /// nothing of it is kept here: then there is nothing left to end.
    fn end_access(&self, dir: &Path, connection: &Connection) -> Option<String> {
        let mut fresh = false;
        loop {
            let token = match self.access_token(dir, connection, fresh) {
                Ok(token) => token,
                Err(TokenError::Refused(_)) => return None,
                Err(TokenError::Failed(reason)) => return Some(reason),
            };
            match api::revoke(&self.agent, &token) {
                Ok(()) => return None,
                // An access token that expired: once more with a new one.
                Err(ApiError::Unauthorized) if !fresh => fresh = true,
                Err(ApiError::Unauthorized) => return None,
                Err(ApiError::Failed(reason)) => return Some(reason),
            }
        }
    }
}

pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("Cannot find the app data folder: {e}"))
}

fn read_connection(dir: &Path) -> Result<Option<Connection>, String> {
    match fs::read_to_string(dir.join(CONNECTION_FILE)) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("The Dropbox connection could not be read ({e}). Connect Dropbox again.")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("The Dropbox connection could not be read: {e}")),
    }
}

fn write_connection(dir: &Path, connection: &Connection) -> Result<(), String> {
    let text = serde_json::to_string_pretty(connection).map_err(|e| e.to_string())?;
    crate::project::atomic_write(&dir.join(CONNECTION_FILE), text.as_bytes())
        .map_err(|e| format!("Cannot keep the Dropbox connection: {e}"))
}

fn remove_connection(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(CONNECTION_FILE)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(format!("Cannot forget the Dropbox connection: {e}")),
        _ => Ok(()),
    }
}

/// Which account is connected, read on this device without asking Dropbox.
#[tauri::command]
pub async fn dropbox_status(app: AppHandle) -> Result<Status, String> {
    require_app_key()?;
    Ok(Status::of(read_connection(&data_dir(&app)?)?.as_ref()))
}

/// Opens Dropbox's sign-in page in the browser. `dropbox_sign_in_finish`
/// then waits for its answer, or takes the code the writer pastes when the
/// start says `manual`. A sign-in still waiting is cancelled.
#[tauri::command]
pub async fn dropbox_sign_in_start(app: AppHandle, state: State<'_, DropboxState>) -> Result<SignInStart, String> {
    let key = require_app_key()?;
    state.cancel_sign_in();
    #[cfg(desktop)]
    let (loopback, redirect) = match Loopback::bind() {
        Some(loopback) => {
            let redirect = loopback.redirect_uri();
            (Some(loopback), Some(redirect))
        }
        None => (None, None),
    };
    #[cfg(mobile)]
    let (loopback, redirect) = (None::<Loopback>, Some(oauth::APP_REDIRECT.to_string()));
    let attempt = Attempt::new(redirect)?;
    let url = attempt.authorize_url(key);
    let manual = attempt.redirect_uri.is_none();
    let links = if cfg!(mobile) {
        let (sender, receiver) = mpsc::channel();
        *locked(&state.links) = Some(sender);
        Some(receiver)
    } else {
        None
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    *locked(&state.cancel) = Some(cancelled.clone());
    *locked(&state.sign_in) = Some(SignIn { attempt, loopback, links, cancelled });
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        state.cancel_sign_in();
        return Err(format!("Cannot open Dropbox's page in the browser: {e}"));
    }
    Ok(SignInStart { manual })
}

/// Finishes the sign-in started last: waits for Dropbox's answer, or uses
/// the `code` the writer pasted, then keeps the account's access. A pasted
/// code that doesn't work can be corrected and tried again.
#[tauri::command]
pub async fn dropbox_sign_in_finish(
    app: AppHandle,
    code: Option<String>,
    state: State<'_, DropboxState>,
) -> Result<Status, String> {
    let key = require_app_key()?;
    let dir = data_dir(&app)?;
    let sign_in = locked(&state.sign_in)
        .take()
        .ok_or("No sign-in is under way. Connect Dropbox again.")?;
    let agent = state.agent.clone();
    let pasted = code.is_some();
    let cancelled = sign_in.cancelled.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let code = match &code {
                Some(code) if code.trim().is_empty() => return Err("Paste the code Dropbox shows.".to_string()),
                Some(code) => code.clone(),
                None => sign_in.wait()?,
            };
            let tokens = oauth::exchange(&agent, key, &sign_in.attempt, &code).map_err(TokenError::message)?;
            let account = match api::current_account(&agent, &tokens.access.token) {
                Ok(account) => account,
                Err(e) => {
                    // The new access won't be kept: best effort to end it,
                    // as the error that stopped the sign-in is the one to report.
                    let _ = api::revoke(&agent, &tokens.access.token);
                    return Err(match e {
                        ApiError::Unauthorized => "Dropbox refused the new access. Connect Dropbox again.".to_string(),
                        ApiError::Failed(message) => message,
                    });
                }
            };
            Ok((tokens, account))
        })();
        (result, sign_in)
    })
    .await
    .map_err(|e| format!("Signing in stopped: {e}"))?;
    let (tokens, account) = match outcome {
        (Ok(done), _) => done,
        (Err(message), sign_in) => {
            // A mistyped code: the writer can paste it again, unless a new sign-in has started.
            if pasted && !sign_in.cancelled.load(Ordering::SeqCst) {
                locked(&state.sign_in).get_or_insert(sign_in);
            }
            return Err(message);
        }
    };
    // Kept only if this sign-in wasn't cancelled meanwhile; holding `cancel`
    // makes the check and the keeping one step that Cancel can't cut into.
    let kept = {
        let mut current = locked(&state.cancel);
        let ours = current.as_ref().is_some_and(|flag| Arc::ptr_eq(flag, &cancelled) && !flag.load(Ordering::SeqCst));
        if ours {
            let kept = credentials::save(&dir, &tokens.refresh).and_then(|keeper| {
                let connection = Connection { account, keeper };
                write_connection(&dir, &connection).map(|()| connection).inspect_err(|_| {
                    // Nothing would point to the token: best effort to remove it, as the
                    // error that stopped the sign-in is the one to report.
                    let _ = credentials::delete(&dir, Some(keeper));
                })
            });
            if kept.is_ok() {
                current.take();
            }
            Some(kept)
        } else {
            None
        }
    };
    match kept {
        Some(Ok(connection)) => {
            *locked(&state.access) = Some(tokens.access);
            Ok(Status::of(Some(&connection)))
        }
        Some(Err(message)) => Err(message),
        None => {
            // Nothing keeps this access: end it in Dropbox too, as far as it can be reached.
            let agent = state.agent.clone();
            let token = tokens.access.token;
            let revoked = tauri::async_runtime::spawn_blocking(move || api::revoke(&agent, &token))
                .await
                .unwrap_or_else(|e| Err(ApiError::Failed(e.to_string())));
            match revoked {
                Err(ApiError::Failed(reason)) => Err(format!("{} Dropbox could not be told ({reason}).", oauth::CANCELLED)),
                _ => Err(oauth::CANCELLED.into()),
            }
        }
    }
}

/// Stops waiting for Dropbox. Async, so the window never waits on a sign-in
/// that is keeping its access (the keyring may be asking to be unlocked).
#[tauri::command]
pub async fn dropbox_sign_in_cancel(state: State<'_, DropboxState>) -> Result<(), String> {
    state.cancel_sign_in();
    Ok(())
}

/// Signs out: ends the app's access in Dropbox, and forgets it on this
/// device. Resolves to a note for the writer only when Dropbox could not be
/// reached to end the access (offline): it is forgotten here all the same,
/// as nothing else holds it, and can be removed in Dropbox's settings.
#[tauri::command]
pub async fn dropbox_sign_out(app: AppHandle, state: State<'_, DropboxState>) -> Result<Option<String>, String> {
    require_app_key()?;
    let dir = data_dir(&app)?;
    // A connection that can't be read has no token to end: it is forgotten.
    let connection = read_connection(&dir).ok().flatten();
    let kept = connection.as_ref().map(|c| c.keeper);
    let note = match connection {
        None => None,
        Some(connection) => {
            let revoke_dir = dir.clone();
            let handle = app.clone();
            let unreached = tauri::async_runtime::spawn_blocking(move || {
                handle.state::<DropboxState>().end_access(&revoke_dir, &connection)
            })
            .await
            .unwrap_or_else(|e| Some(e.to_string()));
            unreached.map(|reason| {
                format!(
                    "Disconnected on this device, but Dropbox could not be told ({reason}). \
                     To end the app's access there too, remove it in Dropbox's settings, under Connected apps."
                )
            })
        }
    };
    *locked(&state.access) = None;
    credentials::delete(&dir, kept)?;
    remove_connection(&dir)?;
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_use_the_apps_key_unless_told_otherwise() {
        assert_eq!(key_from(None), Some(APP_KEY));
        assert_eq!(key_from(Some("otherkey123")), Some("otherkey123"));
        assert_eq!(key_from(Some(" otherkey123\n")), Some("otherkey123"));
        assert_eq!(key_from(Some("")), None);
        assert_eq!(key_from(Some("  ")), None);
    }
}
