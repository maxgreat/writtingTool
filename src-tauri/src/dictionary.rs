//! Hunspell dictionaries bundled into the app (`src-tauri/dictionaries/`),
//! checked with spellbook. They check the spelling of the chapters' words
//! and suggest corrections, and tell which capitalized words are ordinary
//! words written with a capital ("River", "Rose"), so only the others are
//! offered as possible names.
//!
//! The dictionaries also list many names ("Mara", "London", even "Frodo"),
//! so a capitalized word counts as ordinary only when it is a dictionary
//! word in lower case, plus, in English, the days and months.
//!
//! Each dictionary is read the first time its language is asked about and
//! kept for the life of the app.

use std::sync::OnceLock;

use spellbook::Dictionary;

struct Bundled {
    aff: &'static str,
    dic: &'static str,
    /// Capitalized words of the language that are not names.
    not_names: &'static [&'static str],
    loaded: OnceLock<Result<Dictionary, String>>,
}

/// English writes these with a capital, and its dictionaries list them as such.
const ENGLISH_NOT_NAMES: &[&str] = &[
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February",
    "April", "June", "July", "September", "October", "November", "December",
];

macro_rules! bundled {
    ($folder:literal, $not_names:expr) => {
        Bundled {
            aff: include_str!(concat!("../dictionaries/", $folder, "/index.aff")),
            dic: include_str!(concat!("../dictionaries/", $folder, "/index.dic")),
            not_names: $not_names,
            loaded: OnceLock::new(),
        }
    };
}

static EN_US: Bundled = bundled!("en-US", ENGLISH_NOT_NAMES);
static EN_GB: Bundled = bundled!("en-GB", ENGLISH_NOT_NAMES);
static FR: Bundled = bundled!("fr", &[]);
static ES: Bundled = bundled!("es", &[]);

/// The dictionary for a project language such as "en-GB", "fr-CA" or "es":
/// British English for en-GB (and the other English variants written the
/// British way), American English for the rest of English. None for a
/// language without a bundled dictionary.
fn bundled_for(language: &str) -> Option<&'static Bundled> {
    let lower = language.trim().to_ascii_lowercase().replace('_', "-");
    let mut parts = lower.split('-');
    match (parts.next()?, parts.next()) {
        ("en", Some("gb" | "ie" | "au" | "nz" | "za" | "in")) => Some(&EN_GB),
        ("en", _) => Some(&EN_US),
        ("fr", _) => Some(&FR),
        ("es", _) => Some(&ES),
        _ => None,
    }
}

/// The bundled dictionary for `language`, read the first time it is asked
/// for, with the language's capitalized words that are not names. None when
/// no dictionary is bundled for the language.
fn dictionary_for(language: &str) -> Result<Option<(&'static Dictionary, &'static Bundled)>, String> {
    let Some(bundled) = bundled_for(language) else {
        return Ok(None);
    };
    let dictionary = bundled
        .loaded
        .get_or_init(|| Dictionary::new(bundled.aff, bundled.dic).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| format!("The {language} dictionary could not be read: {e}"))?;
    Ok(Some((dictionary, bundled)))
}

/// The dictionaries spell the apostrophe straight; text often has the
/// typographic one ("don’t", "l’auberge").
fn straight_apostrophes(word: &str) -> String {
    word.replace('\u{2019}', "'")
}

/// For each word, whether it is an ordinary word of `language` rather than
/// a name: a dictionary word in lower case ("River" is "river"), or one of
/// the language's capitalized words that are not names (English days and
/// months). None when no dictionary is bundled for the language.
pub fn ordinary_words(language: &str, words: &[String]) -> Result<Option<Vec<bool>>, String> {
    let Some((dictionary, bundled)) = dictionary_for(language)? else {
        return Ok(None);
    };
    Ok(Some(
        words
            .iter()
            .map(|word| {
                bundled.not_names.contains(&word.as_str())
                    || dictionary.check(&straight_apostrophes(&word.to_lowercase()))
            })
            .collect(),
    ))
}

/// For each word, whether `language`'s dictionary spells it this way: as
/// Hunspell checks, "Paris" and "PARIS" pass where "paris" is listed, and
/// "Hello" where "hello" is, but not "london" where only "London" is. A
/// hyphenated word passes when each part does. None when no dictionary is
/// bundled for the language.
pub fn check_words(language: &str, words: &[String]) -> Result<Option<Vec<bool>>, String> {
    let Some((dictionary, _)) = dictionary_for(language)? else {
        return Ok(None);
    };
    Ok(Some(
        words
            .iter()
            .map(|word| {
                let word = straight_apostrophes(word);
                dictionary.check(&word)
                    || (word.contains('-') && word.split('-').all(|part| !part.is_empty() && dictionary.check(part)))
            })
            .collect(),
    ))
}

/// At most this many corrections are offered for a word.
const MAX_SUGGESTIONS: usize = 6;

/// Corrections for a misspelled word, best first, written with the word's
/// own apostrophe. None when no dictionary is bundled for the language.
pub fn suggest(language: &str, word: &str) -> Result<Option<Vec<String>>, String> {
    let Some((dictionary, _)) = dictionary_for(language)? else {
        return Ok(None);
    };
    let curly = word.contains('\u{2019}');
    let mut found = Vec::new();
    dictionary.suggest(&straight_apostrophes(word), &mut found);
    let mut out: Vec<String> = Vec::new();
    for suggestion in found {
        let suggestion = if curly { suggestion.replace('\'', "\u{2019}") } else { suggestion };
        if suggestion != word && !out.contains(&suggestion) {
            out.push(suggestion);
        }
        if out.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ordinary(language: &str, words: &[&str]) -> Vec<bool> {
        let words: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        ordinary_words(language, &words).unwrap().unwrap()
    }

    #[test]
    fn knows_ordinary_words_written_with_a_capital() {
        assert_eq!(ordinary("en-GB", &["River", "Rose", "March", "Monday", "December"]), [true; 5]);
        assert_eq!(ordinary("fr-FR", &["Rivière", "Lundi", "Rose"]), [true; 3]);
        assert_eq!(ordinary("es", &["Río", "Lunes", "Rosa"]), [true; 3]);
    }

    #[test]
    fn leaves_names_to_be_names_even_where_the_dictionary_lists_them() {
        assert_eq!(ordinary("en-GB", &["Mara", "Elena", "London", "Frodo", "Varn"]), [false; 5]);
        assert_eq!(ordinary("en-US", &["Mara", "Kell"]), [false; 2]);
        assert_eq!(ordinary("fr-CA", &["Élodie", "Lyon", "Arwen"]), [false; 3]);
        // A name that is also a word ("paris", bets) counts as a word: add it by hand.
        assert_eq!(ordinary("fr-FR", &["Paris"]), [true]);
        assert_eq!(ordinary("es-MX", &["Madrid", "Arwen"]), [false; 2]);
    }

    #[test]
    fn follows_the_variant_of_english() {
        assert_eq!(ordinary("en-GB", &["Colour"]), [true]);
        assert_eq!(ordinary("en-US", &["Colour"]), [false]);
        assert_eq!(ordinary("en", &["Color"]), [true]);
    }

    #[test]
    fn has_no_answer_for_a_language_it_has_no_dictionary_for() {
        assert_eq!(ordinary_words("de-DE", &["Montag".to_string()]), Ok(None));
        assert_eq!(ordinary_words("", &["Montag".to_string()]), Ok(None));
        assert_eq!(check_words("de-DE", &["Montag".to_string()]), Ok(None));
        assert_eq!(suggest("de-DE", "Montg"), Ok(None));
    }

    fn checked(language: &str, words: &[&str]) -> Vec<bool> {
        let words: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        check_words(language, &words).unwrap().unwrap()
    }

    #[test]
    fn checks_spelling() {
        assert_eq!(checked("en-GB", &["soaked", "bone", "colour", "Morning", "grey"]), [true; 5]);
        assert_eq!(checked("en-GB", &["soakd", "bnoe", "teh"]), [false; 3]);
        assert_eq!(checked("en-US", &["color", "colour"]), [true, false]);
    }

    #[test]
    fn takes_both_apostrophes_and_hyphenated_words() {
        assert_eq!(checked("en-US", &["don't", "don\u{2019}t", "well-known", "sea-green"]), [true; 4]);
        assert_eq!(checked("en-US", &["don\u{2019}x", "well-knwn"]), [false; 2]);
        assert_eq!(checked("fr-FR", &["l'auberge", "l\u{2019}auberge", "aujourd\u{2019}hui", "peut-être"]), [true; 4]);
        assert_eq!(checked("es", &["mañana", "corazón", "vergüenza"]), [true; 3]);
    }

    #[test]
    fn suggests_corrections_in_the_word_s_own_apostrophe() {
        let found = suggest("en-US", "teh").unwrap().unwrap();
        assert!(found.contains(&"the".to_string()), "{found:?}");
        assert!(found.len() <= MAX_SUGGESTIONS);
        let found = suggest("en-US", "dont\u{2019}").unwrap().unwrap();
        assert!(found.iter().all(|s| !s.contains('\'')), "{found:?}");
        let found = suggest("fr-FR", "aubergee").unwrap().unwrap();
        assert!(found.contains(&"auberge".to_string()), "{found:?}");
    }
}
