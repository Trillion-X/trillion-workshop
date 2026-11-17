//! Apple File Provider's 10 rules and 5 failures (f2-apple-file-provider-best.md), held as the core's own rules. The
//! rules that only an extension target can show (its build, its app group) are held by the core's side of them:
//! no OS call in the core, no path in a write, no credential in a request.

mod sim;

use files_core::Command;
use serde_json::{json, Value};
use sim::{Content, Linked, World};

fn source_files() -> Vec<(String, String)> {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| (path.display().to_string(), std::fs::read_to_string(&path).unwrap()))
        .collect()
}

/// Rule 1: a replicated extension and nothing beside it. The core makes no OS call at all: no file, socket, process,
/// thread or clock, so every shell is only a translation.
#[test]
fn rule_01_the_core_calls_no_os() {
    for (path, text) in source_files() {
        for forbidden in ["std::fs", "std::net", "std::process", "std::thread", "SystemTime", "Instant", "std::env"] {
            assert!(!text.contains(forbidden), "{path} uses {forbidden}");
        }
    }
}

/// Rule 2: never write into CloudStorage. A write names an item and a version, never a path; the shell owns where.
#[test]
fn rule_02_writes_name_an_item_never_a_path() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    world.list(1, "trillion");
    world.fetch(2, "/a.txt", 0, 3, 1);
    let write = world.log.iter().find(|command| matches!(command, Command::Write { .. })).unwrap();
    let as_json = serde_json::to_value(write).unwrap();
    assert_eq!(as_json["write"].as_object().unwrap().keys().collect::<Vec<_>>(), vec!["bytes", "item", "offset", "version"]);
}

/// Rule 3: uploaded only when true. While an edit is on its way the item says so, and after it is kept it says so.
#[test]
fn rule_03_uploaded_only_when_kept() {
    let mut world = World::new(vec![Linked::of(100, 1000.0)]);
    world.store.put_file("/a.txt", Content::Kept(b"one".to_vec()), Some(1));
    world.list(1, "trillion");
    let (item, base) = (world.item_id("/a.txt"), world.identity("/a.txt"));
    world.local.insert(2, b"two".to_vec());
    world.event(json!({"modify": {"demand": 2, "item": item, "base_version": base, "parent": null, "name": null, "length": 3, "media_type": null, "date": "2026-11-17"}}));
    let Command::Items { items, .. } = world.list(3, "trillion") else { panic!() };
    assert!(!items[0].uploaded, "an edit on its way is not uploaded");
    world.settle();
    let Command::Items { items, .. } = world.list(4, "trillion") else { panic!() };
    assert!(items[0].uploaded);
}

/// Rule 4: a working set with anchors and small pages. The contract's anchor never expires (account-files-routes.json
/// `_folder`), so an anchor from long ago answers every change since, page by page, and never a full relisting.
#[test]
fn rule_04_changes_page_from_any_anchor() {
    let mut world = World::fast(1);
    let from = world.log.len();
    world.event(json!({"anchor": {"demand": 1}}));
    let Some(Command::Anchor { anchor, .. }) = world.until_logged(from, |command| matches!(command, Command::Anchor { .. })) else { panic!() };
    for index in 0..3 {
        world.store.put_file(&format!("/n{index}"), Content::Kept(b"x".to_vec()), Some(1));
    }
    let mut seen = Vec::new();
    let mut anchor = anchor;
    for demand in 2.. {
        let from = world.log.len();
        world.event(json!({"changes": {"demand": demand, "anchor": anchor, "page_size": 2}}));
        let Some(Command::Changed { updated, more, anchor: next, .. }) = world.until_logged(from, |command| matches!(command, Command::Changed { .. })) else { panic!() };
        assert!(updated.len() <= 2, "small pages");
        seen.extend(updated.into_iter().map(|item| item.name));
        anchor = next;
        if !more {
            break;
        }
    }
    assert_eq!(seen, vec!["n0", "n1", "n2"]);
    assert!(world.sends.iter().all(|(_, operation, _)| operation != "list_files"));
}

/// Rule 5: a progress that keeps moving. A long fetch reports progress after every span, rising to the total.
#[test]
fn rule_05_progress_keeps_moving() {
    let mut world = World::new(vec![Linked::of(50, 2_000.0)]);
    world.store.put_file("/a.bin", Content::Made { seed: 9, size: 1 << 30 }, Some(1));
    world.list(1, "trillion");
    world.fetch(2, "/a.bin", 0, 4096, 4096);
    world.handed(2);
    let from = world.log.len();
    world.fetch(3, "/a.bin", 1 << 25, 64 << 20, 4096);
    let progress: Vec<(u64, u64)> = world.commands(from).iter().filter_map(|command| match command {
        Command::Progress { demand: 3, done, total } => Some((*done, *total)),
        _ => None,
    }).collect();
    assert!(progress.len() > 2, "{progress:?}");
    assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));
    assert_eq!(progress.last().unwrap().0, progress.last().unwrap().1);
}

/// Rule 6: at high latency the first request takes the whole file when it fits in one round trip.
#[test]
fn rule_06_a_small_file_is_taken_whole_at_high_latency() {
    let mut world = World::new(vec![Linked::files(800, 5_000.0)]);
    world.store.put_file("/first.bin", Content::Made { seed: 1, size: 1 << 20 }, Some(1));
    world.store.put_file("/doc.pdf", Content::Made { seed: 2, size: 2 << 20 }, Some(1));
    world.list(1, "trillion");
    world.fetch(2, "/first.bin", 0, 4096, 4096);
    let sends = world.sends.len();
    world.fetch(3, "/doc.pdf", 4096, 4096, 4096);
    let asked: Vec<&Value> = world.sends[sends..].iter().map(|(_, _, input)| input).collect();
    assert_eq!(asked.iter().map(|input| input["length"].as_u64().unwrap()).sum::<u64>(), 2 << 20, "the whole file");
    assert_eq!(asked[0]["offset"], 0);
}

/// Rule 7: never write over a newer version. Two devices edit one file; both versions are kept, the later one beside
/// the other under a plain name.
#[test]
fn rule_07_a_conflict_keeps_both_versions() {
    let mut world = World::fast(1);
    world.store.put_file("/report.docx", Content::Kept(b"base".to_vec()), Some(1));
    world.list(1, "trillion");
    let (item, base) = (world.item_id("/report.docx"), world.identity("/report.docx"));
    world.store.put_file("/report.docx", Content::Kept(b"other device".to_vec()), Some(2));
    let done = world.edit_file(2, &item, &base, b"this device");
    let Command::Done { item: Some(copy), kept_beside: true, .. } = done else { panic!("{done:?}") };
    assert_eq!(copy.name, "report (Example Laptop conflicted copy 2026-11-17).docx");
    assert_eq!(world.store.names["/report.docx"].content.range(0, 12), b"other device");
    assert_eq!(world.store.names["/report (Example Laptop conflicted copy 2026-11-17).docx"].content.range(0, 11), b"this device");
    // A second conflict the same day takes the next plain name.
    let base = world.identity("/report.docx");
    world.store.put_file("/report.docx", Content::Kept(b"third".to_vec()), Some(3));
    let done = world.edit_file(3, &item, &base, b"again");
    let Command::Done { item: Some(copy), .. } = done else { panic!() };
    assert_eq!(copy.name, "report (Example Laptop conflicted copy 2026-11-17 2).docx");
}

/// Rule 8: one thumbnail request per identifier, however often it is asked meanwhile.
#[test]
fn rule_08_one_thumbnail_request_per_identity() {
    let mut world = World::fast(1);
    world.store.put_file("/a.jpg", Content::Kept(b"jpeg".to_vec()), Some(1));
    world.list(1, "trillion");
    let (item, version) = (world.item_id("/a.jpg"), world.identity("/a.jpg"));
    for demand in 2..6 {
        world.event(json!({"thumbnail": {"demand": demand, "item": item, "version": version, "size": 256}}));
    }
    world.settle();
    assert_eq!(world.store.thumbnail_calls[&version], 1);
    assert_eq!(world.log.iter().filter(|command| matches!(command, Command::Thumbnail { .. })).count(), 4);
}

/// Rule 9: the credential stays with the signed app. The core never holds or sends one; the shell adds its own.
#[test]
fn rule_09_no_credential_in_the_core() {
    let mut world = World::fast(1);
    world.list(1, "trillion");
    let send = world.log.iter().find(|command| matches!(command, Command::Send { .. })).unwrap();
    let keys: Vec<String> = serde_json::to_value(send).unwrap()["send"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, vec!["bytes", "content_type", "method", "request", "url"]);
}

/// Rule 10: errors cleared when they are over. After every computer was unreachable, the next answer says resolved.
#[test]
fn rule_10_a_problem_over_is_said_to_be_over() {
    let mut world = World::fast(2);
    world.links[0].down = true;
    world.links[1].down = true;
    world.list(1, "trillion");
    world.links[1].down = false;
    let from = world.log.len();
    world.list(2, "trillion");
    assert!(world.commands(from).contains(&Command::Resolved));
}

/// Failure 1: sequential reads timing out at high latency, held in tests/acceptance.rs (the reader that never
/// stalls). Here: a computer that stalls is passed over within the contract's idle bound, never waited on forever.
#[test]
fn failure_1_a_stalled_computer_is_passed_over() {
    let mut world = World::fast(2);
    world.links[0].silent = true;
    world.event(json!({"list": {"demand": 1, "folder": "trillion", "page": null, "page_size": null}}));
    let idle_ms = sim::idle_ms();
    world.until(idle_ms + 1);
    world.settle();
    assert!(world.log.iter().any(|command| matches!(command, Command::Abandon { .. })));
    assert!(world.log.iter().any(|command| matches!(command, Command::Items { demand: 1, .. })));
}

/// Failure 2: a static progress, held by rule 5.
#[test]
fn failure_2_progress_is_never_static() {
    rule_05_progress_keeps_moving();
}

/// Failure 3: online-only stubs break editors. "Make available offline" on a project folder writes this device's pin
/// rule naming the folder's item, and every file under it is then kept here (the contract answers `kept` for this
/// device); "Remove download" takes it away again.
#[test]
fn failure_3_a_pinned_folder_is_kept_here() {
    let mut world = World::fast(1);
    world.store.put_folder("/Film");
    world.store.put_file("/Film/cut.prproj", Content::Kept(b"p".to_vec()), Some(1));
    world.store.put_file("/other.txt", Content::Kept(b"o".to_vec()), Some(1));
    world.list(1, "trillion");
    let folder = world.item_id("/Film");
    let from = world.log.len();
    world.event(json!({"pin": {"demand": 2, "item": folder, "keep": true}}));
    assert!(matches!(world.done(from, 2), Command::Done { .. }));
    let rule = world.store.pins.values().next().expect("a pin rule row");
    assert_eq!((rule.device.as_str(), rule.items.clone()), ("device-a", vec![folder.clone()]));
    let Command::Items { items, .. } = world.list(3, &folder) else { panic!() };
    assert!(items[0].pinned);
    let Command::Items { items, .. } = world.list(4, "trillion") else { panic!() };
    assert!(!items.iter().find(|item| item.name == "other.txt").unwrap().pinned);
    let from = world.log.len();
    world.event(json!({"pin": {"demand": 5, "item": folder, "keep": false}}));
    world.done(from, 5);
    assert!(world.store.pins.is_empty());
    let Command::Items { items, .. } = world.list(6, &folder) else { panic!() };
    assert!(!items[0].pinned);
}

/// Failure 4: skipped conflict copies (rule 7) and drags that move instead of copy: a move keeps the item, a rename
/// is never a delete plus a create.
#[test]
fn failure_4_a_move_keeps_its_item() {
    let mut world = World::fast(1);
    world.store.put_folder("/a");
    world.store.put_file("/x.txt", Content::Kept(b"x".to_vec()), Some(1));
    world.list(1, "trillion");
    let (item, folder) = (world.item_id("/x.txt"), world.item_id("/a"));
    let from = world.log.len();
    world.event(json!({"modify": {"demand": 2, "item": item, "base_version": null, "parent": folder, "name": "y.txt", "length": null, "media_type": null, "date": "2026-11-17"}}));
    let Command::Done { item: Some(moved), .. } = world.done(from, 2) else { panic!() };
    assert_eq!((moved.id.as_str(), moved.name.as_str(), moved.parent.as_str()), (item.as_str(), "y.txt", folder.as_str()));
    assert_eq!(world.store.names["/a/y.txt"].item, item);
}

/// Failure 5: an orphaned domain. The root's id is the shell's own setup (the domain id it registers, read from the
/// computer's row), and the core's first command hands it back with the trash id, so no shell copies an id of its own
/// and a reinstalled shell registers the same domain.
#[test]
fn failure_5_the_core_names_its_root_and_trash_first() {
    let mut world = World::fast(1);
    world.event(json!({"tick": null}));
    assert_eq!(world.log[0], Command::Ready { root: "trillion".into(), trash: "trash".into() });
}
