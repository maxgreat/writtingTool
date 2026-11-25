//! The Rust core's grammar check for the browser preview, run by Vite's dev
//! server (scripts/dev-core.mjs) so `npm run dev` and `npm run screenshots`
//! show what the app shows. The app calls the same code in its own process
//! (src-tauri/src/lib.rs); this program is never part of a build.
//!
//! One request per line on stdin, one answer per line on stdout, matched by id:
//!   {"id": 1, "kind": "grammar", "language": "en-GB", "paragraphs": ["She have a boat."], "server": null}
//!   → {"id": 1, "result": [[{"from": 4, "to": 8, …}]]}   or   {"id": 1, "error": "…"}

use std::io::{BufRead, Write};

use serde::Deserialize;
use serde_json::{Value, json};
use writing_tool_lib::{grammar, languagetool};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Request {
    Grammar {
        language: String,
        paragraphs: Vec<String>,
        server: Option<languagetool::Server>,
    },
}

fn answer(request: Request) -> Result<Value, String> {
    match request {
        Request::Grammar { language, paragraphs, server } => {
            let result = match server {
                Some(server) => languagetool::check(&server, &language, &paragraphs).map(Some),
                None => grammar::check(&language, &paragraphs),
            }?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
    }
}

fn main() {
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let parsed: Result<Value, String> = serde_json::from_str(&line).map_err(|e| e.to_string());
        let id = parsed.as_ref().ok().and_then(|v| v.get("id").cloned()).unwrap_or(Value::Null);
        let reply = match parsed.and_then(|v| serde_json::from_value::<Request>(v).map_err(|e| e.to_string())) {
            Ok(request) => match answer(request) {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => json!({ "id": id, "error": error }),
            },
            Err(error) => json!({ "id": id, "error": error }),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
