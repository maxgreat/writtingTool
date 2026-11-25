//! Signing in to Dropbox with OAuth 2 and PKCE. The writer signs in on
//! Dropbox's own page, in the browser, so the app never sees the password,
//! and PKCE needs no secret shipped in the app. Dropbox sends the browser
//! back to a return address with a one-time code, which the app swaps for a
//! refresh token that lasts until the writer signs out.
//!
//! Return addresses must be registered in the Dropbox app console:
//! - desktops: `http://localhost:<port>/dropbox` for each of LOOPBACK_PORTS.
//!   The app listens on the first port it can take. When all are taken it
//!   asks without a return address, and Dropbox shows the code on its page
//!   for the writer to paste into the app.
//! - Android: APP_REDIRECT, a link the app opens itself (see deep links in
//!   tauri.conf.json).

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const AUTHORIZE: &str = "https://www.dropbox.com/oauth2/authorize";
const TOKEN: &str = "https://api.dropboxapi.com/oauth2/token";

/// What the app asks for: the files in its own folder, and the account's
/// name, to show whose Dropbox it is.
pub const SCOPES: &str = "account_info.read files.metadata.read files.content.read files.content.write";

/// Desktop return addresses: `http://localhost:<port>/dropbox`.
#[cfg(desktop)]
const LOOPBACK_PORTS: [u16; 3] = [46317, 46318, 46319];
const LOOPBACK_PATH: &str = "/dropbox";
/// Android's return address, which the system hands to the app.
#[cfg(mobile)]
pub const APP_REDIRECT: &str = "io.github.maxgreat.writingtool:/dropbox";

/// Sign-in was cancelled in the app.
pub const CANCELLED: &str = "Signing in to Dropbox was cancelled.";

/// A random string of URL-safe characters, from `bytes` random bytes.
fn random_token(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("The system gave no random numbers to sign in with: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// PKCE's challenge for a verifier (the S256 method).
fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// One sign-in: the secret the token request proves, and the value that
/// ties Dropbox's answer to this sign-in.
pub struct Attempt {
    pub verifier: String,
    pub state: String,
    /// None when Dropbox shows the code for the writer to paste.
    pub redirect_uri: Option<String>,
}

impl Attempt {
    pub fn new(redirect_uri: Option<String>) -> Result<Self, String> {
        // 48 bytes make 64 characters; PKCE takes 43 to 128.
        Ok(Self { verifier: random_token(48)?, state: random_token(16)?, redirect_uri })
    }

    /// Dropbox's sign-in page for this attempt.
    pub fn authorize_url(&self, app_key: &str) -> String {
        let mut url = url::Url::parse(AUTHORIZE).expect("the address is valid");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("client_id", app_key)
                .append_pair("response_type", "code")
                .append_pair("code_challenge", &challenge_for(&self.verifier))
                .append_pair("code_challenge_method", "S256")
                .append_pair("token_access_type", "offline")
                .append_pair("scope", SCOPES)
                .append_pair("state", &self.state);
            if let Some(redirect) = &self.redirect_uri {
                query.append_pair("redirect_uri", redirect);
            }
        }
        url.into()
    }

    /// Reads what Dropbox sent back to the return address, from its query.
    /// None when the answer belongs to another sign-in (an old tab, or a
    /// request that didn't come from Dropbox): it is ignored.
    pub fn read_answer(&self, query: &str) -> Option<Result<String, String>> {
        let pairs: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        if pairs.get("state") != Some(&self.state) {
            return None;
        }
        if let Some(code) = pairs.get("code").filter(|c| !c.is_empty()) {
            return Some(Ok(code.clone()));
        }
        Some(Err(match pairs.get("error").map(String::as_str) {
            Some("access_denied") => "Dropbox access was not allowed.".to_string(),
            Some(error) => match pairs.get("error_description") {
                Some(description) => format!("Dropbox refused: {description} ({error})."),
                None => format!("Dropbox refused ({error})."),
            },
            None => "Dropbox sent back no code.".to_string(),
        }))
    }
}

/// The local address a desktop browser comes back to.
pub struct Loopback {
    listeners: Vec<TcpListener>,
    port: u16,
}

impl Loopback {
    /// Listens on the first free port of LOOPBACK_PORTS, or None when all are taken.
    #[cfg(desktop)]
    pub fn bind() -> Option<Self> {
        Self::bind_ports(&LOOPBACK_PORTS)
    }

    #[cfg(desktop)]
    fn bind_ports(ports: &[u16]) -> Option<Self> {
        for &port in ports {
            let Ok(v4) = TcpListener::bind(("127.0.0.1", port)) else { continue };
            let mut listeners = vec![v4];
            // A browser may try "localhost" as ::1 first.
            if let Ok(v6) = TcpListener::bind(("::1", port)) {
                listeners.push(v6);
            }
            if listeners.iter().all(|l| l.set_nonblocking(true).is_ok()) {
                return Some(Self { listeners, port });
            }
        }
        None
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://localhost:{}{LOOPBACK_PATH}", self.port)
    }

    /// Waits for the browser to come back with the code for `attempt`, until
    /// `cancelled` is set or `deadline` passes. Requests that aren't the
    /// answer get a page saying so, and waiting goes on.
    pub fn wait(&self, attempt: &Attempt, cancelled: &AtomicBool, deadline: Instant) -> Result<String, String> {
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
            if Instant::now() >= deadline {
                return Err("Dropbox didn't answer in time. Connect again to retry.".into());
            }
            let mut accepted = false;
            for listener in &self.listeners {
                match listener.accept() {
                    Ok((stream, _)) => {
                        accepted = true;
                        if let Some(answer) = answer_request(stream, attempt) {
                            return answer;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                    // A connection that failed while being accepted: wait for the next.
                    Err(e) if e.kind() == io::ErrorKind::ConnectionAborted || e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => return Err(format!("The app stopped listening for Dropbox's answer: {e}")),
                }
            }
            if !accepted {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// The page the browser shows once it has brought the code back.
const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width\"><title>Writing Tool</title>\
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f1f1f}</style>\
</head><body><h1>Back to Writing Tool</h1><p>Dropbox has answered. You can close this tab and go back to the app.</p></body></html>";

const OTHER_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Writing Tool</title></head>\
<body><p>This page is not part of signing in to Dropbox.</p></body></html>";

/// Reads one request to the return address. The answer when it is
/// Dropbox's for `attempt`; None for anything else.
fn answer_request(mut stream: TcpStream, attempt: &Attempt) -> Option<Result<String, String>> {
    // An accepted socket keeps the listener's non-blocking mode on some systems.
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    let target = read_request_target(&mut stream)?;
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let answer = if path == LOOPBACK_PATH { attempt.read_answer(query) } else { None };
    let (status, page) = if answer.is_some() { ("200 OK", DONE_PAGE) } else { ("404 Not Found", OTHER_PAGE) };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    // Best effort: the code is what matters, whether or not the page reaches the browser.
    let _ = stream.write_all(response.as_bytes());
    answer
}

/// The target of a GET request (`/dropbox?code=…`), read from its first line.
fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while !head.windows(2).any(|w| w == b"\r\n") {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 || head.len() > 16 * 1024 {
            return None;
        }
        head.extend_from_slice(&buf[..n]);
    }
    let line = std::str::from_utf8(&head).ok()?.lines().next()?;
    let mut parts = line.split(' ');
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) => Some(target.to_string()),
        _ => None,
    }
}

/// Access to the account: a short-lived access token, and the refresh token
/// that gets the next ones.
#[derive(Debug)]
pub struct Tokens {
    pub access: AccessToken,
    pub refresh: String,
}

#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    /// When to stop using it: a few minutes before Dropbox does.
    pub use_until: Instant,
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct ErrorAnswer {
    error: String,
    error_description: Option<String>,
}

/// Why a token request failed.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// Dropbox no longer accepts the refresh token: the writer removed the
    /// app's access in Dropbox, or the code was already used.
    Refused(String),
    /// Dropbox couldn't be reached, or answered with something unexpected.
    Failed(String),
}

impl TokenError {
    pub fn message(self) -> String {
        match self {
            TokenError::Refused(m) | TokenError::Failed(m) => m,
        }
    }
}

fn read_token_answer(status: u16, body: &str) -> Result<TokenAnswer, TokenError> {
    if status == 200 {
        return serde_json::from_str(body).map_err(|e| TokenError::Failed(format!("Dropbox's answer could not be read: {e}")));
    }
    match serde_json::from_str::<ErrorAnswer>(body) {
        Ok(e) if e.error == "invalid_grant" => Err(TokenError::Refused(
            "Dropbox no longer accepts this app's access. Connect Dropbox again.".into(),
        )),
        Ok(e) => Err(TokenError::Failed(match e.error_description {
            Some(d) => format!("Dropbox refused the sign-in: {d} ({}).", e.error),
            None => format!("Dropbox refused the sign-in ({}).", e.error),
        })),
        Err(_) => Err(TokenError::Failed(format!("Dropbox answered with an error ({status})."))),
    }
}

/// Access tokens are used until this long before they expire.
const EXPIRY_MARGIN: Duration = Duration::from_secs(5 * 60);

fn access_from(answer: &TokenAnswer, now: Instant) -> AccessToken {
    let lasts = Duration::from_secs(answer.expires_in).saturating_sub(EXPIRY_MARGIN);
    AccessToken { token: answer.access_token.clone(), use_until: now + lasts }
}

fn post_form(agent: &ureq::Agent, form: &[(&str, &str)]) -> Result<(u16, String), TokenError> {
    let mut response = agent
        .post(TOKEN)
        .send_form(form.iter().copied())
        .map_err(|e| TokenError::Failed(format!("Dropbox could not be reached: {e}")))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_string()
        .map_err(|e| TokenError::Failed(format!("Dropbox's answer could not be read: {e}")))?;
    Ok((status, body))
}

/// Swaps the one-time code for tokens.
pub fn exchange(agent: &ureq::Agent, app_key: &str, attempt: &Attempt, code: &str) -> Result<Tokens, TokenError> {
    let mut form = vec![
        ("code", code.trim()),
        ("grant_type", "authorization_code"),
        ("code_verifier", attempt.verifier.as_str()),
        ("client_id", app_key),
    ];
    if let Some(redirect) = &attempt.redirect_uri {
        form.push(("redirect_uri", redirect.as_str()));
    }
    let (status, body) = post_form(agent, &form)?;
    // For a code, invalid_grant means the code itself: mistyped, used, or expired.
    let answer = read_token_answer(status, &body).map_err(|e| match e {
        TokenError::Refused(_) => TokenError::Refused(
            "Dropbox didn't accept that code. Check it, or connect again for a new one.".into(),
        ),
        other => other,
    })?;
    let refresh = answer
        .refresh_token
        .clone()
        .ok_or_else(|| TokenError::Failed("Dropbox gave no lasting access (no refresh token).".into()))?;
    Ok(Tokens { access: access_from(&answer, Instant::now()), refresh })
}

/// A new access token from the refresh token.
pub fn refresh(agent: &ureq::Agent, app_key: &str, refresh_token: &str) -> Result<AccessToken, TokenError> {
    let form = [("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", app_key)];
    let (status, body) = post_form(agent, &form)?;
    Ok(access_from(&read_token_answer(status, &body)?, Instant::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_the_pkce_challenge_as_rfc_7636_shows() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let attempt = Attempt::new(None).unwrap();
        assert_eq!(attempt.verifier.len(), 64);
        assert!(attempt.verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(attempt.state, Attempt::new(None).unwrap().state);
    }

    #[test]
    fn asks_for_offline_access_with_the_challenge() {
        let attempt = Attempt::new(Some("http://localhost:46317/dropbox".into())).unwrap();
        let url = url::Url::parse(&attempt.authorize_url("key123")).unwrap();
        let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("www.dropbox.com"));
        assert_eq!(query["client_id"], "key123");
        assert_eq!(query["response_type"], "code");
        assert_eq!(query["code_challenge"], challenge_for(&attempt.verifier));
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["token_access_type"], "offline");
        assert_eq!(query["scope"], SCOPES);
        assert_eq!(query["state"], attempt.state);
        assert_eq!(query["redirect_uri"], "http://localhost:46317/dropbox");
        assert!(!query.contains_key("code_verifier"));

        let pasted = Attempt::new(None).unwrap();
        assert!(!pasted.authorize_url("key123").contains("redirect_uri"));
    }

    #[test]
    fn reads_the_answer_only_for_its_own_sign_in() {
        let attempt = Attempt::new(None).unwrap();
        let state = &attempt.state;
        assert_eq!(attempt.read_answer(&format!("code=abc%2Fd&state={state}")), Some(Ok("abc/d".into())));
        assert_eq!(attempt.read_answer("code=abc&state=other"), None);
        assert_eq!(attempt.read_answer("code=abc"), None);
        assert_eq!(
            attempt.read_answer(&format!("error=access_denied&state={state}")),
            Some(Err("Dropbox access was not allowed.".into()))
        );
        assert!(matches!(attempt.read_answer(&format!("error=server_error&state={state}")), Some(Err(_))));
    }

    #[test]
    fn takes_the_code_from_the_browser_and_ignores_other_requests() {
        // Ports of its own, so the test never meets a running app.
        let loopback = Loopback::bind_ports(&[46327, 46328, 46329]).expect("a free port");
        let attempt = Attempt::new(Some(loopback.redirect_uri())).unwrap();
        let port = loopback.port;
        let state = attempt.state.clone();
        let browser = std::thread::spawn(move || {
            let get = |target: &str| {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(stream, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
                let mut page = String::new();
                stream.read_to_string(&mut page).unwrap();
                page
            };
            let other = get("/favicon.ico");
            let stale = get("/dropbox?code=old&state=stale");
            let done = get(&format!("/dropbox?code=fresh&state={state}"));
            (other, stale, done)
        });
        let cancelled = AtomicBool::new(false);
        let code = loopback.wait(&attempt, &cancelled, Instant::now() + Duration::from_secs(10));
        let (other, stale, done) = browser.join().unwrap();
        assert_eq!(code, Ok("fresh".into()));
        assert!(other.starts_with("HTTP/1.1 404"));
        assert!(stale.starts_with("HTTP/1.1 404"));
        assert!(done.starts_with("HTTP/1.1 200") && done.contains("Back to Writing Tool"));
    }

    #[test]
    fn stops_waiting_when_cancelled() {
        let loopback = Loopback::bind_ports(&[46337, 46338]).expect("a free port");
        let attempt = Attempt::new(Some(loopback.redirect_uri())).unwrap();
        let cancelled = AtomicBool::new(true);
        assert_eq!(loopback.wait(&attempt, &cancelled, Instant::now() + Duration::from_secs(10)), Err(CANCELLED.into()));
    }

    #[test]
    fn reads_token_answers_and_refusals() {
        let ok = read_token_answer(200, r#"{"access_token":"sl.A","expires_in":14400,"token_type":"bearer","refresh_token":"R","account_id":"dbid:x"}"#).unwrap();
        assert_eq!(ok.refresh_token.as_deref(), Some("R"));
        let now = Instant::now();
        let access = access_from(&ok, now);
        assert_eq!(access.use_until, now + Duration::from_secs(14400) - EXPIRY_MARGIN);
        assert!(matches!(
            read_token_answer(400, r#"{"error":"invalid_grant","error_description":"refresh token is invalid or revoked"}"#),
            Err(TokenError::Refused(_))
        ));
        assert!(matches!(read_token_answer(400, r#"{"error":"invalid_request"}"#), Err(TokenError::Failed(_))));
        assert!(matches!(read_token_answer(503, "<html>"), Err(TokenError::Failed(_))));
    }
}
