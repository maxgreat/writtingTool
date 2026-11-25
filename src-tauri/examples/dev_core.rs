//! The Rust core's grammar check and export preview for the browser
//! preview, run by Vite's dev server (scripts/dev-core.mjs) so `npm run dev`
//! and `npm run screenshots` show what the app shows. The app calls the same
//! code in its own process (src-tauri/src/lib.rs); this program is never part
//! of a build.
//!
//! One request per line on stdin, one answer per line on stdout, matched by id:
//!   {"id": 1, "kind": "grammar", "language": "en-GB", "paragraphs": ["She have a boat."], "server": null}
//!   → {"id": 1, "result": [[{"from": 4, "to": 8, …}]]}   or   {"id": 1, "error": "…"}
//!   {"id": 2, "kind": "layOut", "book": {…}, "settings": {…}}
//!   → {"id": 2, "result": {"generation": 1, "pages": 13, "width": 419.5, "height": 595.3, "chapterPages": [6, 8, 12]}}
//!   {"id": 3, "kind": "page", "generation": 1, "index": 0}   → {"id": 3, "result": "<svg …"}

use std::io::{BufRead, Write};

use serde::Deserialize;
use serde_json::{Value, json};
use writing_tool_lib::{export, grammar, languagetool};
use typst_layout::PagedDocument;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Request {
    Grammar {
        language: String,
        paragraphs: Vec<String>,
        server: Option<languagetool::Server>,
    },
    LayOut {
        book: export::Book,
        settings: export::Settings,
    },
    Page {
        generation: u64,
        index: usize,
    },
}

/// The last layout, as the app keeps it: pages are only drawn from the layout asked for.
#[derive(Default)]
struct Kept {
    generation: u64,
    document: Option<PagedDocument>,
}

fn answer(request: Request, kept: &mut Kept) -> Result<Value, String> {
    match request {
        Request::LayOut { book, settings } => {
            let document = export::lay_out(&book, &settings)?;
            let (width, height) = export::page_size_pt(&document);
            kept.generation += 1;
            let layout = json!({
                "generation": kept.generation,
                "pages": document.pages().len(),
                "width": width,
                "height": height,
                "chapterPages": export::chapter_pages(&document),
            });
            kept.document = Some(document);
            Ok(layout)
        }
        Request::Page { generation, index } => match &kept.document {
            Some(document) if generation == kept.generation => export::page_svg(document, index)
                .map(Value::String)
                .ok_or_else(|| format!("There is no page {}.", index + 1)),
            _ => Err("That layout has been replaced.".into()),
        },
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
    let mut kept = Kept::default();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let parsed: Result<Value, String> = serde_json::from_str(&line).map_err(|e| e.to_string());
        let id = parsed.as_ref().ok().and_then(|v| v.get("id").cloned()).unwrap_or(Value::Null);
        let reply = match parsed.and_then(|v| serde_json::from_value::<Request>(v).map_err(|e| e.to_string())) {
            Ok(request) => match answer(request, &mut kept) {
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
