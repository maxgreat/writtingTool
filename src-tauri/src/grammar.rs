//! The grammar check for English, offline, with Harper. Spelling is the
//! dictionaries' job (dictionary.rs), so Harper's own spelling rules are
//! left out: they would flag every invented name.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use harper_core::linting::{LintGroup, LintKind, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::Serialize;

/// A problem Harper found in a paragraph.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    /// Where it is in the paragraph, in UTF-16 code units, as the interface counts.
    pub from: usize,
    pub to: usize,
    /// What is wrong, as a sentence for the writer.
    pub message: String,
    /// Harper's category, such as "Agreement" or "Repetition".
    pub kind: String,
    /// Text to put in place of the problem, best first; "" removes it.
    pub fixes: Vec<String>,
}

/// The English variant Harper checks a project language against; None for other languages.
fn dialect_for(language: &str) -> Option<Dialect> {
    let lower = language.trim().to_ascii_lowercase().replace('_', "-");
    let mut parts = lower.split('-');
    if parts.next()? != "en" {
        return None;
    }
    Some(match parts.next() {
        Some("gb" | "ie" | "nz" | "za") => Dialect::British,
        Some("au") => Dialect::Australian,
        Some("ca") => Dialect::Canadian,
        Some("in") => Dialect::Indian,
        _ => Dialect::American,
    })
}

/// One set of rules per dialect, made the first time it is asked for
/// (about a third of a second) and kept for the life of the app.
fn linter_for(dialect: Dialect) -> Arc<Mutex<LintGroup>> {
    static LINTERS: OnceLock<Mutex<HashMap<u8, Arc<Mutex<LintGroup>>>>> = OnceLock::new();
    let mut linters = LINTERS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    linters
        .entry(dialect as u8)
        .or_insert_with(|| Arc::new(Mutex::new(LintGroup::new_curated(FstDictionary::curated(), dialect))))
        .clone()
}

/// Harper writes code-like words in backticks; the interface shows plain sentences.
fn plain_message(message: &str) -> String {
    message.replace('`', "")
}

/// UTF-16 offsets for each char offset of `chars`, with one more for the end.
fn utf16_offsets(chars: &[char]) -> Vec<usize> {
    let mut out = Vec::with_capacity(chars.len() + 1);
    let mut at = 0;
    for c in chars {
        out.push(at);
        at += c.len_utf16();
    }
    out.push(at);
    out
}

/// The problems of each paragraph, in order. None when Harper doesn't
/// check the language (only English).
pub fn check(language: &str, paragraphs: &[String]) -> Result<Option<Vec<Vec<Problem>>>, String> {
    let Some(dialect) = dialect_for(language) else {
        return Ok(None);
    };
    let linter = linter_for(dialect);
    let mut linter = linter.lock().map_err(|_| "The grammar check is unavailable.".to_string())?;
    let dictionary = FstDictionary::curated();
    Ok(Some(
        paragraphs
            .iter()
            .map(|text| {
                let document = Document::new_plain_english(text, &*dictionary);
                let chars: Vec<char> = text.chars().collect();
                let units = utf16_offsets(&chars);
                let mut problems: Vec<Problem> = linter
                    .lint(&document)
                    .into_iter()
                    .filter(|lint| lint.lint_kind != LintKind::Spelling)
                    .filter(|lint| lint.span.end <= chars.len() && lint.span.start < lint.span.end)
                    .map(|lint| {
                        let original: String = chars[lint.span.start..lint.span.end].iter().collect();
                        let mut fixes: Vec<String> = Vec::new();
                        for suggestion in &lint.suggestions {
                            let fix = match suggestion {
                                Suggestion::ReplaceWith(with) => with.iter().collect(),
                                Suggestion::InsertAfter(with) => format!("{original}{}", with.iter().collect::<String>()),
                                Suggestion::Remove => String::new(),
                            };
                            if fix != original && !fixes.contains(&fix) {
                                fixes.push(fix);
                            }
                        }
                        Problem {
                            from: units[lint.span.start],
                            to: units[lint.span.end],
                            message: plain_message(&lint.message),
                            kind: format!("{:?}", lint.lint_kind),
                            fixes,
                        }
                    })
                    .collect();
                problems.sort_by_key(|p| (p.from, p.to));
                problems
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problems(language: &str, text: &str) -> Vec<Problem> {
        check(language, &[text.to_string()]).unwrap().unwrap().remove(0)
    }

    #[test]
    fn finds_grammar_problems_with_fixes() {
        let found = problems("en-GB", "She have a boat. He could of gone with the the ferryman.");
        let words: Vec<_> = found.iter().map(|p| &"She have a boat. He could of gone with the the ferryman."[p.from..p.to]).collect();
        assert!(words.contains(&"have"), "{found:?}");
        assert!(words.contains(&"could of"), "{found:?}");
        assert!(found.iter().any(|p| p.fixes.contains(&"has".to_string())), "{found:?}");
        assert!(found.iter().all(|p| !p.message.contains('`')));
    }

    #[test]
    fn leaves_spelling_and_invented_names_alone() {
        assert_eq!(problems("en-US", "Elena reached the Harbor Inn and met Quillon by the Sel."), vec![]);
        assert_eq!(problems("en-US", "The boat was the bestest skiff on the Sel."), vec![]);
    }

    #[test]
    fn counts_offsets_as_the_interface_does() {
        let text = "“Zoë’s” café — she have it.";
        let found = problems("en-GB", text);
        let units: Vec<u16> = text.encode_utf16().collect();
        let have = found.iter().find(|p| String::from_utf16_lossy(&units[p.from..p.to]) == "have");
        assert!(have.is_some(), "{found:?}");
    }

    #[test]
    fn checks_english_only() {
        assert_eq!(check("fr-FR", &["Il a mangé.".to_string()]).unwrap(), None);
        assert!(check("en", &[]).unwrap().unwrap().is_empty());
    }
}
