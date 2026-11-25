//! Two devices syncing one project through a cloud folder in memory.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use super::*;
use crate::project::{Change, Move as BinderMove, ProjectRoot, install_sample};
use crate::sync::memory::Memory;

const ACCOUNT: &str = "dbid:ada";
const ROOT: &str = "/MyNovel";
const ARRIVAL: &str = "manuscript/Part 1 - Arrival/01 The arrival.md";
const FERRYMAN: &str = "manuscript/Part 1 - Arrival/02 The ferryman.md";

struct Device {
    _dir: tempfile::TempDir,
    root: PathBuf,
    lock: Mutex<()>,
}

impl Device {
    /// A device with the sample project, put in the cloud.
    fn first(cloud: &Memory) -> Device {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(install_sample(dir.path()).unwrap()).unwrap();
        cloud.create_folder(ROOT).unwrap();
        link(&root, ACCOUNT, ROOT).unwrap();
        let device = Device { _dir: dir, root, lock: Mutex::new(()) };
        device.sync(cloud);
        device
    }

    /// A device that takes the project from the cloud.
    fn second(cloud: &Memory) -> Device {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("MyNovel");
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        link(&root, ACCOUNT, ROOT).unwrap();
        let device = Device { _dir: dir, root, lock: Mutex::new(()) };
        device.sync(cloud);
        device
    }

    fn try_sync(&self, cloud: &Memory) -> std::result::Result<Outcome, SyncError> {
        Sync::open(cloud, &self.root, ACCOUNT)?.expect("synced").run(&self.lock)
    }

    fn sync(&self, cloud: &Memory) -> Outcome {
        self.try_sync(cloud).unwrap_or_else(|e| panic!("sync failed: {}", e.message()))
    }

    fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.root.join(path)).ok()
    }

    fn write(&self, path: &str, text: &str) {
        let target = self.root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, text).unwrap();
    }

    /// Moves in the binder, as the app does: made at once, then noted for sync.
    fn binder_moves(&self, moves: &[(&str, &str)]) {
        let project = ProjectRoot::open(&self.root).unwrap();
        // The binder makes the Trash with the first thing moved into it.
        let trash = moves.iter().any(|(_, to)| to.starts_with("trash/")) && !self.root.join("trash").exists();
        let change = Change {
            folders: if trash { vec!["trash".to_string()] } else { Vec::new() },
            sheet_folders: Vec::new(),
            moves: moves.iter().map(|(f, t)| BinderMove { from: f.to_string(), to: t.to_string() }).collect(),
            writes: Vec::new(),
        };
        project.apply(&change).unwrap();
        let moves: Vec<super::Move> = moves.iter().map(|(f, t)| (f.to_string(), t.to_string())).collect();
        record_moves(&self.root, &moves).unwrap();
    }

    /// Every synced file here, with its text.
    fn files(&self) -> BTreeMap<String, String> {
        let local = Local { root: self.root.clone() };
        let (files, _) = local.scan().unwrap();
        files.into_iter().map(|(p, b)| (p, String::from_utf8(b).unwrap())).collect()
    }
}

fn remote(path: &str) -> String {
    format!("{ROOT}/{path}")
}

#[test]
fn puts_a_project_in_the_cloud_and_brings_it_to_another_device() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    assert!(cloud.text(&remote(ARRIVAL)).unwrap().starts_with("# The arrival"));
    assert!(cloud.has_folder(&remote("trash")) || !a.root.join("trash").exists());

    let b = Device::second(&cloud);
    assert_eq!(a.files(), b.files());
    assert!(b.root.join(".sync/state.json").is_file());
    assert!(ProjectRoot::open(&b.root).is_ok());

    // Nothing changed: nothing to do.
    assert_eq!(a.sync(&cloud), Outcome::default());
    assert_eq!(b.sync(&cloud), Outcome::default());
}

#[test]
fn merges_edits_to_different_paragraphs_made_on_two_devices() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    let original = a.read(ARRIVAL).unwrap();
    a.write(ARRIVAL, &original.replace("# The arrival", "# The Arrival"));
    b.write(ARRIVAL, &original.replace("Morning came grey over the river.", "Morning came, grey."));

    a.sync(&cloud);
    let outcome = b.sync(&cloud);
    let merged = b.read(ARRIVAL).unwrap();
    assert!(merged.starts_with("# The Arrival\n"));
    assert!(merged.contains("Morning came, grey."));
    assert!(outcome.conflicts.is_empty());
    let changed = &outcome.changed[0];
    assert_eq!(changed.path, ARRIVAL);
    assert_eq!(changed.before.as_deref(), Some(original.replace("Morning came grey over the river.", "Morning came, grey.").as_str()));
    assert_eq!(changed.after.as_deref(), Some(merged.as_str()));

    a.sync(&cloud);
    assert_eq!(a.read(ARRIVAL), Some(merged));
    assert_eq!(a.files(), b.files());
}

#[test]
fn keeps_both_versions_of_a_paragraph_changed_on_two_devices() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    let original = a.read(ARRIVAL).unwrap();
    a.write(ARRIVAL, &original.replace("Morning came grey over the river.", "Morning came late."));
    b.write(ARRIVAL, &original.replace("Morning came grey over the river.", "Dawn was grey."));

    assert!(a.sync(&cloud).conflicts.is_empty());
    let outcome = b.sync(&cloud);
    assert_eq!(outcome.conflicts, vec![ARRIVAL.to_string()]);
    let kept = b.read(ARRIVAL).unwrap();
    assert!(kept.contains("Dawn was grey.\n\nMorning came late."));
    a.sync(&cloud);
    assert_eq!(a.files(), b.files());
}

#[test]
fn carries_binder_moves_and_the_edits_made_meanwhile() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    let arrival_id = cloud.id(&remote(ARRIVAL)).unwrap();

    // Two chapters swap places: their file names swap, at once.
    let swapped_arrival = "manuscript/Part 1 - Arrival/02 The arrival.md";
    let swapped_ferryman = "manuscript/Part 1 - Arrival/01 The ferryman.md";
    a.binder_moves(&[(ARRIVAL, swapped_arrival), (FERRYMAN, swapped_ferryman)]);
    // Meanwhile, the other device edits the arrival where it was.
    let edited = b.read(ARRIVAL).unwrap().replace("Morning came grey over the river.", "Morning came, grey.");
    b.write(ARRIVAL, &edited);

    a.sync(&cloud);
    assert_eq!(cloud.id(&remote(swapped_arrival)), Some(arrival_id), "the file kept its identity");
    assert!(cloud.text(&remote(ARRIVAL)).is_none());
    assert!(cloud.paths().iter().all(|p| !p.contains(".moving")));

    let outcome = b.sync(&cloud);
    assert!(outcome.reshaped);
    assert!(outcome.moved.contains(&(ARRIVAL.to_string(), swapped_arrival.to_string())));
    assert_eq!(b.read(swapped_arrival), Some(edited.clone()));
    assert!(b.read(swapped_ferryman).unwrap().starts_with("# The ferryman"));
    assert_eq!(b.read(ARRIVAL), None);

    a.sync(&cloud);
    assert_eq!(a.read(swapped_arrival), Some(edited));
    assert_eq!(a.files(), b.files());
}

#[test]
fn takes_in_a_swap_of_two_names_without_merging_the_files() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    let arrival = a.read(ARRIVAL).unwrap();
    let ferryman = a.read(FERRYMAN).unwrap();
    // Two chapters trade file names: a cycle, made at once.
    a.binder_moves(&[(ARRIVAL, FERRYMAN), (FERRYMAN, ARRIVAL)]);
    a.sync(&cloud);
    assert_eq!(cloud.text(&remote(FERRYMAN)), Some(arrival.clone()));

    let outcome = b.sync(&cloud);
    assert!(outcome.conflicts.is_empty() && outcome.problems.is_empty(), "{outcome:?}");
    assert_eq!(b.read(FERRYMAN), Some(arrival.clone()));
    assert_eq!(b.read(ARRIVAL), Some(ferryman.clone()));
    assert!(fs::read_dir(b.root.join("manuscript/Part 1 - Arrival")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with('.')));
    b.sync(&cloud);
    assert_eq!(cloud.text(&remote(ARRIVAL)), Some(ferryman));
    assert_eq!(cloud.text(&remote(FERRYMAN)), Some(arrival));
    assert_eq!(a.files(), b.files());
}

#[test]
fn brings_back_a_file_deleted_here_that_another_device_moved() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    let moved = "manuscript/Part 2 - The river/01 The arrival.md";
    a.binder_moves(&[(ARRIVAL, moved)]);
    a.sync(&cloud);
    fs::remove_file(b.root.join(ARRIVAL)).unwrap();

    b.sync(&cloud);
    assert_eq!(b.read(moved), a.read(moved));
    assert!(cloud.text(&remote(moved)).is_some(), "not deleted everywhere");
    b.sync(&cloud);
    assert!(cloud.text(&remote(moved)).is_some());
}

#[test]
fn moves_a_file_made_here_aside_when_another_device_moves_one_to_its_name() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    let target = "manuscript/Part 2 - The river/04 New.md";
    a.binder_moves(&[(ARRIVAL, target)]);
    a.sync(&cloud);
    b.write(target, "# Written here\n");

    let outcome = b.sync(&cloud);
    let aside = "manuscript/Part 2 - The river/04 New 2.md";
    assert_eq!(b.read(aside).as_deref(), Some("# Written here\n"));
    assert_eq!(b.read(target), a.read(target));
    assert!(outcome.conflicts.is_empty());
    assert!(outcome.problems.iter().any(|p| p.contains("04 New 2.md")));
    assert_eq!(cloud.text(&remote(aside)).as_deref(), Some("# Written here\n"));
    a.sync(&cloud);
    assert_eq!(a.files(), b.files());
}

#[test]
fn takes_in_a_file_deleted_and_replaced_by_a_move_between_two_syncs() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let arrival = a.read(ARRIVAL).unwrap();
    let rev = a.state().files[FERRYMAN].rev.clone();
    // Elsewhere: the ferryman is deleted, then the arrival takes its name.
    cloud.delete(&remote(FERRYMAN), Some(&rev)).unwrap();
    cloud.move_to(&remote(ARRIVAL), &remote(FERRYMAN)).unwrap();

    let outcome = a.sync(&cloud);
    assert!(outcome.problems.is_empty() && outcome.conflicts.is_empty(), "{outcome:?}");
    assert_eq!(a.read(FERRYMAN), Some(arrival));
    assert_eq!(a.read(ARRIVAL), None);
    assert_eq!(a.state().files[FERRYMAN].id, cloud.id(&remote(FERRYMAN)).unwrap());
    assert_eq!(a.sync(&cloud), Outcome::default());
}

#[test]
fn keeps_a_replaced_file_edited_here_and_sends_it_under_a_new_name() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let rev = a.state().files[FERRYMAN].rev.clone();
    a.write(FERRYMAN, "# The ferryman\n\nEdited here.\n");
    cloud.delete(&remote(FERRYMAN), Some(&rev)).unwrap();
    cloud.move_to(&remote(ARRIVAL), &remote(FERRYMAN)).unwrap();

    a.sync(&cloud);
    let aside = "manuscript/Part 1 - Arrival/02 The ferryman 2.md";
    assert_eq!(a.read(aside).as_deref(), Some("# The ferryman\n\nEdited here.\n"));
    assert_eq!(cloud.text(&remote(aside)).as_deref(), Some("# The ferryman\n\nEdited here.\n"));
    assert!(a.read(FERRYMAN).unwrap().starts_with("# The arrival"));
    let again = a.sync(&cloud);
    assert!(!again.again, "nothing left waiting: {again:?}");
}

#[test]
fn moves_a_part_with_its_chapters() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    a.binder_moves(&[("manuscript/Part 1 - Arrival", "trash/Part 1 - Arrival")]);
    a.sync(&cloud);
    assert!(cloud.text(&remote("trash/Part 1 - Arrival/01 The arrival.md")).is_some());

    b.sync(&cloud);
    assert!(b.read("trash/Part 1 - Arrival/01 The arrival.md").is_some());
    assert!(!b.root.join("manuscript/Part 1 - Arrival").exists(), "the emptied part folder goes");
    assert_eq!(a.files(), b.files());
    // And nothing comes back on the next round.
    a.sync(&cloud);
    assert!(!cloud.has_folder(&remote("manuscript/Part 1 - Arrival")));
}

#[test]
fn deletes_what_was_deleted_in_the_cloud_unless_it_changed_here() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let rev = |path: &str| a.state().files[path].rev.clone();
    cloud.delete(&remote(ARRIVAL), Some(&rev(ARRIVAL))).unwrap();
    cloud.delete(&remote(FERRYMAN), Some(&rev(FERRYMAN))).unwrap();
    a.write(FERRYMAN, "# The ferryman\n\nEdited here.\n");

    let outcome = a.sync(&cloud);
    assert_eq!(a.read(ARRIVAL), None);
    assert!(outcome.changed.iter().any(|c| c.path == ARRIVAL && c.after.is_none()));
    assert_eq!(a.read(FERRYMAN).as_deref(), Some("# The ferryman\n\nEdited here.\n"));
    assert!(outcome.problems.iter().any(|p| p.contains("02 The ferryman.md was deleted in Dropbox")));
    assert_eq!(cloud.text(&remote(FERRYMAN)).as_deref(), Some("# The ferryman\n\nEdited here.\n"));
}

impl Device {
    fn state(&self) -> SyncState {
        read_state(&self.root).unwrap().unwrap()
    }
}

#[test]
fn takes_in_edits_made_outside_the_app_and_new_chapters() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    cloud.edit(&remote(ARRIVAL), "# The arrival\n\nWritten on the web.\n");
    cloud.edit(&remote("manuscript/Part 1 - Arrival/04 New.md"), "# New\n");
    cloud.edit(&remote("manuscript/notes.txt"), "not a chapter");
    let outcome = a.sync(&cloud);
    assert_eq!(a.read(ARRIVAL).as_deref(), Some("# The arrival\n\nWritten on the web.\n"));
    assert_eq!(a.read("manuscript/Part 1 - Arrival/04 New.md").as_deref(), Some("# New\n"));
    assert_eq!(a.read("manuscript/notes.txt"), None);
    assert!(outcome.reshaped);
    assert!(outcome.problems.is_empty());
}

#[test]
fn takes_a_file_replaced_in_the_cloud_without_a_conflict() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let rev = a.state().files[ARRIVAL].rev.clone();
    cloud.delete(&remote(ARRIVAL), Some(&rev)).unwrap();
    cloud.edit(&remote(ARRIVAL), "# Rewritten\n");
    assert_ne!(cloud.id(&remote(ARRIVAL)), Some(a.state().files[ARRIVAL].id.clone()));
    let outcome = a.sync(&cloud);
    assert_eq!(a.read(ARRIVAL).as_deref(), Some("# Rewritten\n"));
    assert!(outcome.conflicts.is_empty());
    assert_eq!(a.state().files[ARRIVAL].id, cloud.id(&remote(ARRIVAL)).unwrap());
}

#[test]
fn an_upload_that_meets_a_newer_version_waits_for_the_next_pull() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let original = a.read(ARRIVAL).unwrap();
    a.write(ARRIVAL, &original.replace("# The arrival", "# Arrival"));
    let theirs = original.replace("Morning came grey over the river.", "Saved between the pull and the push.");
    let path = remote(ARRIVAL);
    cloud.before_next_upload(move |cloud| cloud.edit(&path, &theirs));

    let outcome = a.sync(&cloud);
    assert!(outcome.again);
    assert!(cloud.text(&remote(ARRIVAL)).unwrap().starts_with("# The arrival"), "never overwritten");
    a.sync(&cloud);
    let merged = a.read(ARRIVAL).unwrap();
    assert!(merged.starts_with("# Arrival\n") && merged.contains("Saved between the pull and the push."));
    assert_eq!(cloud.text(&remote(ARRIVAL)), Some(merged));
}

#[test]
fn syncs_empty_parts_and_new_files() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let b = Device::second(&cloud);
    fs::create_dir(a.root.join("manuscript/Part 3 - Empty")).unwrap();
    a.write("sheets/characters/Mira.md", "---\nname: Mira\n---\n");
    a.sync(&cloud);
    let outcome = b.sync(&cloud);
    assert!(outcome.reshaped);
    assert!(b.root.join("manuscript/Part 3 - Empty").is_dir());
    assert_eq!(b.read("sheets/characters/Mira.md").as_deref(), Some("---\nname: Mira\n---\n"));
}

#[test]
fn lists_again_after_a_reset_without_changing_anything() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    cloud.reset_cursors();
    assert_eq!(a.sync(&cloud), Outcome::default());
}

#[test]
fn pauses_when_the_project_left_the_cloud() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let before = a.files();
    cloud.delete(ROOT, None).unwrap();
    let error = a.try_sync(&cloud).unwrap_err();
    assert!(matches!(error, SyncError::Stopped(ref m) if m.contains("no longer in Dropbox")));
    assert_eq!(a.files(), before);

    // A fresh read of a missing folder pauses too.
    let state_path = a.root.join(".sync/state.json");
    let mut state = a.state();
    state.cursor = None;
    fs::write(&state_path, serde_json::to_string(&state).unwrap()).unwrap();
    assert!(matches!(a.try_sync(&cloud), Err(SyncError::Stopped(_))));
    assert_eq!(a.files(), before);
}

#[test]
fn pauses_rather_than_empty_the_cloud_when_the_manuscript_folder_is_gone() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    let in_cloud = cloud.paths().len();
    fs::rename(a.root.join("manuscript"), a.root.join("elsewhere")).unwrap();
    assert!(matches!(a.try_sync(&cloud), Err(SyncError::Stopped(ref m)) if m.contains("manuscript folder is missing")));
    assert_eq!(cloud.paths().len(), in_cloud);
}

#[test]
fn refuses_a_project_synced_with_another_account() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    assert!(matches!(Sync::open(&cloud, &a.root, "dbid:someone-else"), Err(SyncError::Stopped(_))));
    let plain = tempfile::tempdir().unwrap();
    assert!(Sync::open(&cloud, plain.path(), ACCOUNT).unwrap().is_none());
}

#[test]
fn never_writes_outside_the_project() {
    let cloud = Memory::default();
    let a = Device::first(&cloud);
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        fs::remove_dir_all(a.root.join("sheets/places")).unwrap();
        std::os::unix::fs::symlink(outside.path(), a.root.join("sheets/places")).unwrap();
        cloud.edit(&remote("sheets/places/Varn.md"), "---\nname: Varn\n---\nfrom the cloud\n");
        assert!(a.try_sync(&cloud).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
    assert!(!is_synced_file("../x.md"));
    assert!(!is_synced_file("manuscript/.hidden.md"));
    assert!(!is_synced_file("snapshots/x.md"));
    assert!(is_synced_file("trash/x.md") && is_synced_file("project.json") && is_synced_file("dictionary.txt"));
}

#[test]
fn orders_moves_made_at_once() {
    let temp = |from: &str, i: usize| format!("{from}.tmp{i}");
    let m = |a: &str, b: &str| (a.to_string(), b.to_string());
    // A chain: b moves out of the way before a takes its place.
    assert_eq!(in_order(&[m("a", "b"), m("b", "c")], temp), vec![m("b", "c"), m("a", "b")]);
    // A swap goes through a temporary name.
    assert_eq!(in_order(&[m("a", "b"), m("b", "a")], temp), vec![m("a", "a.tmp0"), m("b", "a"), m("a.tmp0", "b")]);
    assert_eq!(relative_to("/MyNovel", "/mynovel/Manuscript/x.md").as_deref(), Some("Manuscript/x.md"));
    assert_eq!(relative_to("/MyNovel", "/Other/x.md"), None);
    assert_eq!(rebased("a/b/c", "a/b", "z"), Some("z/c".into()));
    assert_eq!(rebased("a/bc", "a/b", "z"), None);
}
