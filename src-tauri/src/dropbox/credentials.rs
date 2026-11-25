//! Where the Dropbox refresh token is kept: the system's keyring on
//! desktops (macOS Keychain, Windows Credential Manager, the Secret Service
//! on Linux). Without one (a Linux desktop with no keyring service), and on
//! Android, it is a file in the app's data folder that only the app's user
//! can read; Android keeps each app's folder private and encrypted.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file holding the token when there is no keyring.
const TOKEN_FILE: &str = "dropbox-token";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Keeper {
    Keyring,
    File,
}

#[cfg(desktop)]
fn keyring_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new("io.github.maxgreat.writingtool", "dropbox")
}

/// Keeps `token`, in the keyring if there is one, else in a file in `dir`.
/// Says where it went.
pub fn save(dir: &Path, token: &str) -> Result<Keeper, String> {
    #[cfg(desktop)]
    if keyring_entry().and_then(|entry| entry.set_password(token)).is_ok() {
        // An older copy in a file is no longer needed.
        remove_file(&dir.join(TOKEN_FILE)).map_err(|e| format!("Cannot remove the old Dropbox sign-in file: {e}"))?;
        return Ok(Keeper::Keyring);
    }
    save_file(dir, token).map_err(|e| format!("Cannot keep the Dropbox sign-in in {}: {e}", dir.display()))?;
    Ok(Keeper::File)
}

/// The token kept by `keeper`, or None when it is no longer there.
pub fn load(dir: &Path, keeper: Keeper) -> Result<Option<String>, String> {
    match keeper {
        #[cfg(desktop)]
        Keeper::Keyring => match keyring_entry().and_then(|entry| entry.get_password()) {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Cannot read the Dropbox sign-in from the system keyring: {e}")),
        },
        #[cfg(not(desktop))]
        Keeper::Keyring => Ok(None),
        Keeper::File => match fs::read_to_string(dir.join(TOKEN_FILE)) {
            Ok(token) => Ok(Some(token.trim().to_string()).filter(|t| !t.is_empty())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Cannot read the Dropbox sign-in: {e}")),
        },
    }
}

/// Forgets the token. `kept` is where it was kept, when the connection
/// says so: a keyring that can't be reached then is an error, as the token
/// would stay in it. Without one, a keyring that isn't there is fine.
pub fn delete(dir: &Path, kept: Option<Keeper>) -> Result<(), String> {
    #[cfg(desktop)]
    match keyring_entry().and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        // No keyring here, and the token wasn't said to be in one.
        Err(keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)) if kept != Some(Keeper::Keyring) => {}
        Err(e) => return Err(format!("Cannot remove the Dropbox sign-in from the system keyring: {e}")),
    }
    #[cfg(not(desktop))]
    let _ = kept;
    remove_file(&dir.join(TOKEN_FILE)).map_err(|e| format!("Cannot remove the Dropbox sign-in: {e}"))
}

fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Writes the token file readable by its owner only, replacing it whole.
fn save_file(dir: &Path, token: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let target = dir.join(TOKEN_FILE);
    let temp: PathBuf = dir.join(format!(".{TOKEN_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        io::Write::write_all(&mut file, token.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_reads_and_forgets_the_token_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path(), Keeper::File), Ok(None));
        save_file(dir.path(), "secret-1").unwrap();
        save_file(dir.path(), "secret-2").unwrap();
        assert_eq!(load(dir.path(), Keeper::File), Ok(Some("secret-2".into())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(TOKEN_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        remove_file(&dir.path().join(TOKEN_FILE)).unwrap();
        remove_file(&dir.path().join(TOKEN_FILE)).unwrap();
        assert_eq!(load(dir.path(), Keeper::File), Ok(None));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
