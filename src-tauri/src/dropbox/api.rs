//! Calls to Dropbox's API with an access token.

use serde::Deserialize;

const API: &str = "https://api.dropboxapi.com/2/";

#[derive(Debug, PartialEq, Eq)]
pub enum ApiError {
    /// The access token expired or was revoked: get a new one and retry.
    Unauthorized,
    /// Anything else, as a sentence for the writer.
    Failed(String),
}

#[derive(Deserialize)]
struct ErrorAnswer {
    error_summary: Option<String>,
}

/// Calls an RPC route with a JSON `body` and returns the answer's body.
fn rpc(agent: &ureq::Agent, token: &str, route: &str, body: &str) -> Result<String, ApiError> {
    let mut response = agent
        .post(format!("{API}{route}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .send(body)
        .map_err(|e| ApiError::Failed(format!("Dropbox could not be reached: {e}")))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| ApiError::Failed(format!("Dropbox's answer could not be read: {e}")))?;
    read_answer(status, text)
}

fn read_answer(status: u16, text: String) -> Result<String, ApiError> {
    match status {
        200 => Ok(text),
        401 => Err(ApiError::Unauthorized),
        429 => Err(ApiError::Failed("Dropbox asks to slow down. Try again in a minute.".into())),
        _ => {
            let summary = serde_json::from_str::<ErrorAnswer>(&text).ok().and_then(|e| e.error_summary);
            Err(ApiError::Failed(match summary {
                Some(summary) => format!("Dropbox refused: {}.", summary.trim_end_matches(['/', '.'])),
                None => format!("Dropbox answered with an error ({status})."),
            }))
        }
    }
}

/// The signed-in account, as the app shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub account_id: String,
    pub name: String,
    pub email: String,
}

#[derive(Deserialize)]
struct AccountAnswer {
    account_id: String,
    name: AccountName,
    email: String,
}

#[derive(Deserialize)]
struct AccountName {
    display_name: String,
}

fn read_account(text: &str) -> Result<Account, ApiError> {
    let answer: AccountAnswer = serde_json::from_str(text)
        .map_err(|e| ApiError::Failed(format!("Dropbox's account details could not be read: {e}")))?;
    Ok(Account { account_id: answer.account_id, name: answer.name.display_name, email: answer.email })
}

pub fn current_account(agent: &ureq::Agent, token: &str) -> Result<Account, ApiError> {
    read_account(&rpc(agent, token, "users/get_current_account", "null")?)
}

/// Ends the access token and the refresh token it came from.
pub fn revoke(agent: &ureq::Agent, token: &str) -> Result<(), ApiError> {
    rpc(agent, token, "auth/token/revoke", "null").map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_account() {
        let text = r#"{"account_id":"dbid:AAH4f","name":{"given_name":"Ada","surname":"L","familiar_name":"Ada","display_name":"Ada L","abbreviated_name":"AL"},"email":"ada@example.com","email_verified":true,"disabled":false,"country":"FR","locale":"fr","is_paired":false,"account_type":{".tag":"basic"}}"#;
        assert_eq!(
            read_account(text).unwrap(),
            Account { account_id: "dbid:AAH4f".into(), name: "Ada L".into(), email: "ada@example.com".into() }
        );
    }

    #[test]
    fn tells_an_expired_token_from_other_errors() {
        assert_eq!(read_answer(200, "{}".into()), Ok("{}".into()));
        assert_eq!(read_answer(401, r#"{"error_summary":"expired_access_token/"}"#.into()), Err(ApiError::Unauthorized));
        assert_eq!(
            read_answer(409, r#"{"error_summary":"path/not_found/..","error":{}}"#.into()),
            Err(ApiError::Failed("Dropbox refused: path/not_found.".into()))
        );
        assert_eq!(read_answer(500, "oops".into()), Err(ApiError::Failed("Dropbox answered with an error (500).".into())));
    }
}
