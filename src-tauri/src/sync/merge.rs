//! Three-way merges: a file as it was last synced (the base), as this
//! device has it (ours), and as another device saved it (theirs).
//!
//! Chapters, sheets and dictionary.txt merge line by line. A chapter holds
//! one paragraph per line, so edits to different paragraphs merge by
//! themselves. When both sides changed the same paragraphs, both versions
//! are kept, ours first: nothing is ever lost, and the writer chooses.
//!
//! project.json merges field by field (see merge_json).

use serde::Serialize;
use serde_json::Value;

/// A merge's result.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Merged {
    pub text: String,
    /// How many places both sides changed differently. Both versions are in
    /// the text, except in project.json, which keeps ours.
    pub conflicts: usize,
}

/// Above this many line pairs, the changed middle of two texts is compared
/// as a whole rather than line by line (memory for the comparison table).
const MAX_CELLS: usize = 4 * 1024 * 1024;

/// The pairs of equal lines of a longest common subsequence of `a` and `b`,
/// in order.
fn matches(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let (a_mid, b_mid) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut out: Vec<(usize, usize)> = (0..prefix).map(|i| (i, i)).collect();
    let (n, m) = (a_mid.len(), b_mid.len());
    if n > 0 && m > 0 && (n + 1).saturating_mul(m + 1) <= MAX_CELLS {
        // lcs[i * w + j]: the longest common subsequence of a_mid[i..] and b_mid[j..].
        let w = m + 1;
        let mut lcs = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i * w + j] = if a_mid[i] == b_mid[j] {
                    lcs[(i + 1) * w + j + 1] + 1
                } else {
                    lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if a_mid[i] == b_mid[j] {
                out.push((prefix + i, prefix + j));
                i += 1;
                j += 1;
            } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    out.extend((0..suffix).map(|k| (a.len() - suffix + k, b.len() - suffix + k)));
    out
}

/// One stretch of a line merge.
#[derive(Debug, PartialEq, Eq)]
enum Piece<'a> {
    Lines(&'a [&'a str]),
    /// Both sides changed this stretch of the base differently.
    Conflict { ours: &'a [&'a str], theirs: &'a [&'a str] },
}

/// diff3: the lines all three agree on anchor the merge; between two
/// anchors, a stretch only one side changed takes that side's lines.
fn merge_lines<'a>(base: &'a [&'a str], ours: &'a [&'a str], theirs: &'a [&'a str]) -> Vec<Piece<'a>> {
    let mut in_ours = vec![None; base.len()];
    for (b, o) in matches(base, ours) {
        in_ours[b] = Some(o);
    }
    let mut in_theirs = vec![None; base.len()];
    for (b, t) in matches(base, theirs) {
        in_theirs[b] = Some(t);
    }
    let anchors = (0..base.len())
        .filter_map(|b| Some((b, in_ours[b]?, in_theirs[b]?)))
        .chain(std::iter::once((base.len(), ours.len(), theirs.len())));
    let mut pieces = Vec::new();
    let (mut b0, mut o0, mut t0) = (0, 0, 0);
    for (b, o, t) in anchors {
        let (bs, os, ts) = (&base[b0..b], &ours[o0..o], &theirs[t0..t]);
        if os == ts || ts == bs {
            pieces.push(Piece::Lines(os));
        } else if os == bs {
            pieces.push(Piece::Lines(ts));
        } else {
            pieces.push(Piece::Conflict { ours: os, theirs: ts });
        }
        if b < base.len() {
            pieces.push(Piece::Lines(&base[b..=b]));
        }
        (b0, o0, t0) = (b + 1, o + 1, t + 1);
    }
    pieces
}

/// A text's lines, each with its line ending.
fn lines_of(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn strs(keys: &[String]) -> Vec<&str> {
    keys.iter().map(String::as_str).collect()
}

/// Adds both sides of a conflict to `text`: the lines they share once,
/// and between those, ours then theirs. Only lines with text count as
/// shared, so each side's paragraphs stay together rather than interleave
/// at the blank lines between them. Returns how many conflicts are left.
fn push_conflict(text: &mut String, ours: &[&str], theirs: &[&str]) -> usize {
    let shared = matches(ours, theirs).into_iter().filter(|&(o, _)| !ours[o].trim().is_empty());
    let mut conflicts = 0;
    let (mut o0, mut t0) = (0, 0);
    for (o, t) in shared.chain(std::iter::once((ours.len(), theirs.len()))) {
        let (os, ts) = (&ours[o0..o], &theirs[t0..t]);
        if os == ts {
            text.extend(os.iter().copied());
        } else {
            conflicts += 1;
            push_both(text, os, ts);
        }
        if o < ours.len() {
            text.push_str(ours[o]);
        }
        (o0, t0) = (o + 1, t + 1);
    }
    conflicts
}

/// Ours, then theirs, each its own paragraph: a blank line between them.
fn push_both(text: &mut String, ours: &[&str], theirs: &[&str]) {
    text.extend(ours.iter().copied());
    if !ours.is_empty() && !theirs.is_empty() {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        let blank_between =
            ours.last().is_some_and(|l| l.trim().is_empty()) || theirs.first().is_some_and(|l| l.trim().is_empty());
        if !blank_between {
            text.push('\n');
        }
    }
    text.extend(theirs.iter().copied());
}

/// Merges two edits of a text, line by line (see the module's comment).
pub fn merge_text(base: &str, ours: &str, theirs: &str) -> Merged {
    if ours == theirs || theirs == base {
        return Merged { text: ours.to_string(), conflicts: 0 };
    }
    if ours == base {
        return Merged { text: theirs.to_string(), conflicts: 0 };
    }
    let (base, ours, theirs) = (lines_of(base), lines_of(ours), lines_of(theirs));
    let mut text = String::new();
    let mut conflicts = 0;
    for piece in merge_lines(&base, &ours, &theirs) {
        match piece {
            Piece::Lines(lines) => text.extend(lines.iter().copied()),
            Piece::Conflict { ours, theirs } => conflicts += push_conflict(&mut text, ours, theirs),
        }
    }
    Merged { text, conflicts }
}

/// Merges two edits of the file at `path` (relative to the project) as sync
/// does: project.json field by field, anything else line by line. A
/// project.json that can't be merged as JSON keeps ours, counted as a
/// conflict: a line merge could break it.
pub fn merge_file(path: &str, base: &str, ours: &str, theirs: &str) -> Merged {
    if path == "project.json" {
        merge_json(base, ours, theirs).unwrap_or_else(|| Merged { text: ours.to_string(), conflicts: 1 })
    } else {
        merge_text(base, ours, theirs)
    }
}

/// Merges two edits of project.json field by field: objects key by key,
/// lists item by item, so binder moves, chapter details and ignored names
/// changed on two devices all arrive. Where both sides set one value
/// differently, ours is kept and counted as a conflict. None when one of
/// the three isn't JSON: it must then not be rewritten.
pub fn merge_json(base: &str, ours: &str, theirs: &str) -> Option<Merged> {
    let parse = |text: &str| serde_json::from_str::<Value>(text).ok();
    let (base_value, ours_value, theirs_value) = (parse(base)?, parse(ours)?, parse(theirs)?);
    if theirs_value == base_value || theirs_value == ours_value {
        return Some(Merged { text: ours.to_string(), conflicts: 0 });
    }
    if ours_value == base_value {
        return Some(Merged { text: theirs.to_string(), conflicts: 0 });
    }
    let mut conflicts = 0;
    let merged = merge_values(Some(&base_value), Some(&ours_value), Some(&theirs_value), &mut conflicts)?;
    let mut text = serde_json::to_string_pretty(&merged).ok()?;
    text.push('\n');
    Some(Merged { text, conflicts })
}

/// One value of a JSON merge; None stands for a missing key.
fn merge_values(base: Option<&Value>, ours: Option<&Value>, theirs: Option<&Value>, conflicts: &mut usize) -> Option<Value> {
    if ours == theirs || theirs == base {
        return ours.cloned();
    }
    if ours == base {
        return theirs.cloned();
    }
    match (ours, theirs) {
        (Some(Value::Object(o)), Some(Value::Object(t))) => {
            let b = base.and_then(Value::as_object);
            let mut out = serde_json::Map::new();
            // Ours' keys in ours' order, then keys only theirs has.
            let keys = o.keys().chain(t.keys().filter(|k| !o.contains_key(*k)));
            for key in keys {
                let merged = merge_values(b.and_then(|b| b.get(key)), o.get(key), t.get(key), conflicts);
                if let Some(value) = merged {
                    out.insert(key.clone(), value);
                }
            }
            Some(Value::Object(out))
        }
        (Some(Value::Array(o)), Some(Value::Array(t))) => {
            let empty = Vec::new();
            let b = base.and_then(Value::as_array).unwrap_or(&empty);
            Some(Value::Array(merge_arrays(b, o, t, conflicts)))
        }
        _ => {
            *conflicts += 1;
            ours.cloned()
        }
    }
}

/// Lists merge as lines do, each item a line. Where both sides changed the
/// same stretch, ours is kept, then the items only theirs added.
fn merge_arrays(base: &[Value], ours: &[Value], theirs: &[Value], conflicts: &mut usize) -> Vec<Value> {
    let key = |values: &[Value]| -> Vec<String> { values.iter().map(Value::to_string).collect() };
    let (base_keys, ours_keys, theirs_keys) = (key(base), key(ours), key(theirs));
    let (b, o, t) = (strs(&base_keys), strs(&ours_keys), strs(&theirs_keys));
    let parse = |line: &str| serde_json::from_str::<Value>(line).expect("each line is a value written above");
    let mut out = Vec::new();
    for piece in merge_lines(&b, &o, &t) {
        match piece {
            Piece::Lines(lines) => out.extend(lines.iter().map(|l| parse(l))),
            Piece::Conflict { ours, theirs } => {
                *conflicts += 1;
                out.extend(ours.iter().map(|l| parse(l)));
                let added = theirs.iter().filter(|l| !ours.contains(l) && !b.contains(l));
                out.extend(added.map(|l| parse(l)));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "# The arrival\n\nElena reached the inn.\n\nThe ferryman waited.\n\n***\n\nMorning came.\n";

    #[test]
    fn takes_the_side_that_changed() {
        let edited = BASE.replace("reached", "came to");
        assert_eq!(merge_text(BASE, &edited, BASE), Merged { text: edited.clone(), conflicts: 0 });
        assert_eq!(merge_text(BASE, BASE, &edited), Merged { text: edited.clone(), conflicts: 0 });
        assert_eq!(merge_text(BASE, &edited, &edited), Merged { text: edited, conflicts: 0 });
    }

    #[test]
    fn merges_edits_to_different_paragraphs() {
        let ours = BASE.replace("reached the inn", "reached the Harbor Inn");
        let theirs = BASE.replace("Morning came.", "Morning came grey.\n\nShe slept late.");
        let merged = merge_text(BASE, &ours, &theirs);
        assert_eq!(merged.conflicts, 0);
        assert_eq!(
            merged.text,
            "# The arrival\n\nElena reached the Harbor Inn.\n\nThe ferryman waited.\n\n***\n\nMorning came grey.\n\nShe slept late.\n"
        );
    }

    #[test]
    fn keeps_both_versions_of_a_paragraph_changed_on_both_sides() {
        let ours = BASE.replace("The ferryman waited.", "The ferryman was waiting.");
        let theirs = BASE.replace("The ferryman waited.", "Arno waited at the bar.");
        let merged = merge_text(BASE, &ours, &theirs);
        assert_eq!(merged.conflicts, 1);
        assert_eq!(
            merged.text,
            "# The arrival\n\nElena reached the inn.\n\nThe ferryman was waiting.\n\nArno waited at the bar.\n\n***\n\nMorning came.\n"
        );
    }

    #[test]
    fn keeps_both_additions_at_the_end_even_without_a_final_newline() {
        let merged = merge_text("One\n", "One\nTwo", "One\nThree\n");
        assert_eq!(merged, Merged { text: "One\nTwo\n\nThree\n".into(), conflicts: 1 });
        // dictionary.txt: words added on both devices are all kept.
        let words = merge_text("Arno\nVarn\n", "Arno\nVarn\nElena\n", "Arno\nVarn\nSel\n");
        assert_eq!(words.text, "Arno\nVarn\nElena\n\nSel\n");
    }

    #[test]
    fn merges_a_deletion_with_an_edit_elsewhere() {
        let ours = BASE.replace("The ferryman waited.\n\n", "");
        let theirs = BASE.replace("Morning came.", "Morning came late.");
        let merged = merge_text(BASE, &ours, &theirs);
        assert_eq!(merged.conflicts, 0);
        assert_eq!(merged.text, "# The arrival\n\nElena reached the inn.\n\n***\n\nMorning came late.\n");
    }

    #[test]
    fn merges_from_nothing_when_there_is_no_base() {
        // A file both sides created: what they share is kept once.
        let merged = merge_text("", "# One\n\nA.\n", "# One\n\nB.\n");
        assert_eq!(merged, Merged { text: "# One\n\nA.\n\nB.\n".into(), conflicts: 1 });
    }

    #[test]
    fn compares_huge_changed_middles_as_a_whole() {
        let lines: Vec<String> = (0..3000).map(|i| format!("Line {i}\n")).collect();
        let base = lines.concat();
        let ours = lines.iter().map(|l| l.replace("Line", "Ours")).collect::<String>();
        let theirs = lines.iter().map(|l| l.replace("Line", "Theirs")).collect::<String>();
        let merged = merge_text(&base, &ours, &theirs);
        assert_eq!(merged.conflicts, 1);
        assert!(merged.text.starts_with("Ours 0\n") && merged.text.ends_with("Theirs 2999\n"));
    }

    #[test]
    fn merges_project_json_by_field() {
        let base = r#"{
  "title": "Night Ferry",
  "binder": ["a.md", "b.md", "c.md"],
  "chapters": { "a.md": { "status": "Draft" } },
  "notNames": ["River"]
}
"#;
        let ours = r#"{
  "title": "Night Ferry",
  "binder": ["b.md", "a.md", "c.md"],
  "chapters": { "a.md": { "status": "Revised" } },
  "notNames": ["River", "Monday"]
}
"#;
        let theirs = r#"{
  "title": "The Night Ferry",
  "binder": ["a.md", "b.md", "c.md", "d.md"],
  "chapters": { "a.md": { "status": "Draft", "pov": "Elena" } },
  "notNames": ["River", "Harbor"],
  "language": "fr-FR"
}
"#;
        let merged = merge_json(base, ours, theirs).unwrap();
        let value: Value = serde_json::from_str(&merged.text).unwrap();
        assert_eq!(value["title"], "The Night Ferry");
        assert_eq!(value["binder"], serde_json::json!(["b.md", "a.md", "c.md", "d.md"]));
        assert_eq!(value["chapters"]["a.md"], serde_json::json!({ "status": "Revised", "pov": "Elena" }));
        assert_eq!(value["notNames"], serde_json::json!(["River", "Monday", "Harbor"]));
        assert_eq!(value["language"], "fr-FR");
        assert_eq!(merged.conflicts, 1, "both added a name at the same place");
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["title", "binder", "chapters", "notNames", "language"]);
        assert!(merged.text.ends_with("}\n"));
    }

    #[test]
    fn merges_each_file_as_sync_does() {
        let merged = merge_file("project.json", r#"{"notNames":["River"]}"#, r#"{"notNames":["River","Monday"]}"#, r#"{"notNames":["River","Harbor"]}"#);
        let value: Value = serde_json::from_str(&merged.text).unwrap();
        assert_eq!(value["notNames"], serde_json::json!(["River", "Monday", "Harbor"]));
        assert_eq!(merge_file("project.json", "{", "{\"a\":1}", "{}"), Merged { text: "{\"a\":1}".into(), conflicts: 1 });
        assert_eq!(merge_file("manuscript/a.md", "A\n", "B\n", "A\n").text, "B\n");
    }

    #[test]
    fn keeps_ours_where_both_set_a_value_and_refuses_what_is_not_json() {
        let merged = merge_json(r#"{"title":"A"}"#, r#"{"title":"B"}"#, r#"{"title":"C"}"#).unwrap();
        assert_eq!(merged.conflicts, 1);
        assert_eq!(serde_json::from_str::<Value>(&merged.text).unwrap()["title"], "B");
        // A key one side removed and the other left alone goes.
        let removed = merge_json(r#"{"a":1,"b":2}"#, r#"{"a":1}"#, r#"{"a":1,"b":2,"c":3}"#).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&removed.text).unwrap(), serde_json::json!({"a":1,"c":3}));
        assert_eq!(merge_json("{", "{}", "{}"), None);
    }
}
