//! Hunspell dictionaries bundled into the app (`src-tauri/dictionaries/`),
//! checked with spellbook. For now they tell which capitalized words are
//! ordinary words written with a capital ("River", "Rose"), so only the
//! others are offered as possible names; the spelling check will use them
//! too.
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

/// For each word, whether it is an ordinary word of `language` rather than
/// a name: a dictionary word in lower case ("River" is "river"), or one of
/// the language's capitalized words that are not names (English days and
/// months). None when no dictionary is bundled for the language.
pub fn ordinary_words(language: &str, words: &[String]) -> Result<Option<Vec<bool>>, String> {
    let Some(bundled) = bundled_for(language) else {
        return Ok(None);
    };
    let dictionary = bundled
        .loaded
        .get_or_init(|| Dictionary::new(bundled.aff, bundled.dic).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| format!("The {language} dictionary could not be read: {e}"))?;
    Ok(Some(
        words
            .iter()
            .map(|word| bundled.not_names.contains(&word.as_str()) || dictionary.check(&word.to_lowercase()))
            .collect(),
    ))
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
    }
}
