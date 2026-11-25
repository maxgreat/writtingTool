//! The grammar check through LanguageTool, for French and Spanish (and
//! English, when the writer prefers it to Harper). Off unless the writer
//! connects it: the paragraphs checked are sent to the server chosen, the
//! public one at languagetool.org, a premium account, or the writer's own.

use std::time::Duration;

use serde::Deserialize;

use crate::grammar::Problem;

/// Where to send paragraphs, as the writer set it up.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "mode")]
pub enum Server {
    /// languagetool.org's free server: 20 requests and 75 KB a minute, 20 KB a request.
    Public,
    /// A premium account.
    Premium { username: String, api_key: String },
    /// The writer's own server, such as `http://localhost:8081`.
    Own { url: String },
}

const PUBLIC: &str = "https://api.languagetool.org/v2/check";
const PREMIUM: &str = "https://api.languagetoolplus.com/v2/check";
/// The public server's limit per request, with room to spare.
pub const MAX_REQUEST_BYTES: usize = 18 * 1024;

impl Server {
    fn endpoint(&self) -> Result<String, String> {
        match self {
            Server::Public => Ok(PUBLIC.into()),
            Server::Premium { .. } => Ok(PREMIUM.into()),
            Server::Own { url } => {
                let url = url.trim().trim_end_matches('/');
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err("The LanguageTool server's address must start with http:// or https://.".into());
                }
                Ok(if url.ends_with("/v2/check") { url.to_string() } else { format!("{url}/v2/check") })
            }
        }
    }
}

/// The language code LanguageTool takes for a project language.
fn language_code(language: &str) -> String {
    let lower = language.trim().to_ascii_lowercase().replace('_', "-");
    let mut parts = lower.split('-');
    let lang = parts.next().unwrap_or("en");
    match (lang, parts.next()) {
        ("en", Some(region)) => format!("en-{}", region.to_ascii_uppercase()),
        ("en", None) => "en-US".into(),
        ("pt", Some(region)) => format!("pt-{}", region.to_ascii_uppercase()),
        (lang, _) => lang.to_string(),
    }
}

#[derive(Debug, Deserialize)]
struct Response {
    matches: Vec<Match>,
}

#[derive(Debug, Deserialize)]
struct Match {
    message: String,
    offset: usize,
    length: usize,
    #[serde(default)]
    replacements: Vec<Replacement>,
    rule: Rule,
}

#[derive(Debug, Deserialize)]
struct Replacement {
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rule {
    #[serde(default)]
    issue_type: String,
    category: Category,
}

#[derive(Debug, Deserialize)]
struct Category {
    #[serde(default)]
    name: String,
}

/// At most this many fixes are offered for a problem.
const MAX_FIXES: usize = 5;

/// Splits LanguageTool's answer for paragraphs sent joined by blank lines
/// back into each paragraph's problems. Spelling is left out: the
/// dictionaries check it, and know the project's names.
fn split_matches(paragraphs: &[String], matches: Vec<Match>) -> Vec<Vec<Problem>> {
    let mut starts = Vec::with_capacity(paragraphs.len());
    let mut at = 0;
    for p in paragraphs {
        starts.push(at);
        at += p.encode_utf16().count() + 2;
    }
    let mut out: Vec<Vec<Problem>> = vec![Vec::new(); paragraphs.len()];
    for m in matches {
        if m.rule.issue_type == "misspelling" || m.length == 0 {
            continue;
        }
        let index = starts.partition_point(|&s| s <= m.offset).saturating_sub(1);
        let start = starts[index];
        let length = paragraphs[index].encode_utf16().count();
        let from = m.offset - start;
        let to = from + m.length;
        if to > length {
            continue;
        }
        let mut fixes: Vec<String> = Vec::new();
        for r in m.replacements {
            if !fixes.contains(&r.value) {
                fixes.push(r.value);
            }
            if fixes.len() == MAX_FIXES {
                break;
            }
        }
        out[index].push(Problem { from, to, message: m.message, kind: m.rule.category.name, fixes });
    }
    out
}

/// Asks the server about `paragraphs` (at most MAX_REQUEST_BYTES of text
/// together) and returns each one's problems, in order.
pub fn check(server: &Server, language: &str, paragraphs: &[String]) -> Result<Vec<Vec<Problem>>, String> {
    if paragraphs.is_empty() {
        return Ok(Vec::new());
    }
    let text = paragraphs.join("\n\n");
    if text.len() > MAX_REQUEST_BYTES {
        return Err("Too much text for one LanguageTool request.".into());
    }
    let endpoint = server.endpoint()?;
    let language = language_code(language);
    let mut form: Vec<(&str, &str)> = vec![("text", text.as_str()), ("language", language.as_str())];
    if let Server::Premium { username, api_key } = server {
        form.push(("username", username.as_str()));
        form.push(("apiKey", api_key.as_str()));
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(&endpoint)
        .send_form(form)
        .map_err(|e| format!("LanguageTool could not be reached: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("LanguageTool's answer could not be read: {e}"))?;
    match status {
        200 => {}
        429 => return Err("LanguageTool asks to slow down: the public server takes 20 checks a minute.".into()),
        401 | 403 => return Err("LanguageTool refused the account: check the user name and API key.".into()),
        _ => return Err(format!("LanguageTool answered with an error ({status}).")),
    }
    let parsed: Response =
        serde_json::from_str(&body).map_err(|e| format!("LanguageTool's answer could not be read: {e}"))?;
    Ok(split_matches(paragraphs, parsed.matches))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_endpoint_and_language() {
        assert_eq!(Server::Public.endpoint().unwrap(), PUBLIC);
        assert_eq!(Server::Own { url: "http://localhost:8081/".into() }.endpoint().unwrap(), "http://localhost:8081/v2/check");
        assert!(Server::Own { url: "localhost:8081".into() }.endpoint().is_err());
        assert_eq!(language_code("fr-CA"), "fr");
        assert_eq!(language_code("es_MX"), "es");
        assert_eq!(language_code("en-gb"), "en-GB");
        assert_eq!(language_code("en"), "en-US");
    }

    #[test]
    fn reads_the_server_as_the_interface_sends_it() {
        let premium: Server = serde_json::from_str(r#"{"mode":"premium","username":"u","apiKey":"k"}"#).unwrap();
        assert!(matches!(premium, Server::Premium { ref username, ref api_key } if username == "u" && api_key == "k"));
        let own: Server = serde_json::from_str(r#"{"mode":"own","url":"http://localhost:8081"}"#).unwrap();
        assert!(matches!(own, Server::Own { .. }));
        assert!(matches!(serde_json::from_str::<Server>(r#"{"mode":"public"}"#).unwrap(), Server::Public));
    }

    #[test]
    fn splits_the_answer_back_into_paragraphs() {
        let paragraphs = vec!["Il a mangé une pomme.".to_string(), "Elles est « belle ».".to_string()];
        let body = r#"{"matches":[
            {"message":"Accord","offset":29,"length":3,"replacements":[{"value":"sont"},{"value":"sont"},{"value":"était"}],"rule":{"issueType":"grammar","category":{"name":"Grammaire"}}},
            {"message":"Faute","offset":3,"length":5,"replacements":[],"rule":{"issueType":"misspelling","category":{"name":"Typo"}}},
            {"message":"Across","offset":20,"length":5,"replacements":[],"rule":{"issueType":"grammar","category":{"name":"Grammaire"}}}
        ]}"#;
        let parsed: Response = serde_json::from_str(body).unwrap();
        let split = split_matches(&paragraphs, parsed.matches);
        assert!(split[0].is_empty());
        assert_eq!(split[1].len(), 1);
        let problem = &split[1][0];
        let units: Vec<u16> = paragraphs[1].encode_utf16().collect();
        assert_eq!(String::from_utf16_lossy(&units[problem.from..problem.to]), "est");
        assert_eq!(problem.fixes, vec!["sont", "était"]);
        assert_eq!(problem.kind, "Grammaire");
    }
}
