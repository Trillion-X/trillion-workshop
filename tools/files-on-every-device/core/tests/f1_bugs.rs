//! The 21 bugs of old Trillion's Finder client (f1-old-trillion-files-audit.md), each held as a regression of the
//! core. Where a bug lived only in an OS shell, the test holds the core to the rule that keeps the shell from
//! repeating it, and says so.

mod sim;

use files_core::{Command, Problem};
use serde_json::{json, Value};
use sim::{Content, Linked, Reply, World};

fn kept(bytes: &[u8]) -> Content {
    Content::Kept(bytes.to_vec())
}

fn names_of(items: &Command) -> Vec<String> {
    match items {
        Command::Items { items, .. } => items.iter().map(|item| item.name.clone()).collect(),
        other => panic!("not a listing: {other:?}"),
    }
}

/// Bug 1: a list held for 206 s behind a reader. A listing is sent the moment it is asked, whatever reads are open.
#[test]
fn bug_01_a_listing_never_waits_behind_a_read() {
    let mut world = World::new(vec![Linked::of(300, 100.0)]);
    world.store.put_file("/clip.mov", Content::Made { seed: 7, size: 1 << 30 }, Some(1));
    world.list(1, "trillion");
    let (item, version) = (world.item_id("/clip.mov"), world.identity("/clip.mov"));
    world.event(json!({"fetch": {"demand": 2, "item": item, "version": version, "offset": 0, "length": 1 << 20, "alignment": 4096}}));
    let sent = world.sends.len();
    world.event(json!({"list": {"demand": 3, "folder": "trillion", "page": null, "page_size": null}}));
    assert_eq!(world.sends[sent].1, "list_files", "the listing went out at once");
}

/// Bug 2: the domain shown turned off (Apple error -2011). Shell-side; the core holds the one fixed root id every
/// device registers, so a shell never makes a second domain.
#[test]
fn bug_02_the_root_is_one_fixed_id() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", kept(b"a"), Some(1));
    let listed = world.list(1, "trillion");
    match listed {
        Command::Items { items, .. } => assert_eq!(items[0].parent, "trillion"),
        other => panic!("{other:?}"),
    }
}

/// Bug 3: only one reader started the Drive. Any computer of the account serves; the first being off changes nothing.
#[test]
fn bug_03_any_computer_of_the_account_answers() {
    let mut world = World::fast(2);
    world.links[0].down = true;
    world.store.put_file("/a.txt", kept(b"a"), Some(1));
    assert_eq!(names_of(&world.list(1, "trillion")), vec!["a.txt"]);
}

/// Bug 4: a fresh start relisted everything. Changes come from the kept cursor, never from a full listing.
#[test]
fn bug_04_a_restart_resumes_from_its_cursor() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", kept(b"a"), Some(1));
    world.event(json!({"watch": null}));
    world.settle();
    world.store.put_file("/b.txt", kept(b"b"), Some(2));
    world.wake_watches();
    world.settle();
    let from = world.log.len();
    world.event(json!({"keep": null}));
    let state = match &world.log[from] {
        Command::State { state } => state.clone(),
        other => panic!("{other:?}"),
    };
    let mut again = World::fast(1);
    again.store = std::mem::take(&mut world.store);
    again.event(json!({"restore": {"state": state.clone()}}));
    again.event(json!({"watch": null}));
    again.settle();
    let watch = again.sends.iter().find(|(_, operation, _)| operation == "list_changes").unwrap();
    assert_eq!(watch.2["after"], state["cursor"]);
    assert!(again.sends.iter().all(|(_, operation, _)| operation != "list_files"), "no relisting");
}

/// Bug 5: dates showed as 1969. A file with no time has none; a folder's date is its newest child's.
#[test]
fn bug_05_dates_are_never_invented() {
    let mut world = World::fast(1);
    world.store.put_folder("/f");
    world.store.put_file("/f/old.txt", kept(b"o"), Some(100));
    world.store.put_file("/f/new.txt", kept(b"n"), Some(300));
    world.store.put_file("/undated.txt", kept(b"u"), None);
    let root = world.list(1, "trillion");
    let folder = world.item_id("/f");
    world.list(2, &folder);
    let root = match root {
        Command::Items { items, .. } => items,
        other => panic!("{other:?}"),
    };
    assert_eq!(root.iter().find(|item| item.name == "undated.txt").unwrap().modified_ms, None);
    let again = world.list(3, "trillion");
    let Command::Items { items, .. } = again else { panic!() };
    assert_eq!(items.iter().find(|item| item.name == "f").unwrap().modified_ms, Some(300));
}

/// Bug 6: the root was not refreshed after a restart. A restore asks the OS to read changes at once.
#[test]
fn bug_06_a_restart_refreshes_the_root() {
    let mut world = World::fast(1);
    let from = world.log.len();
    world.event(json!({"restore": {"state": {"items": null, "cursor": "c0"}}}));
    assert!(world.commands(from).contains(&Command::Signal));
}

/// Bug 7: refresh storms. However many changes one wait brings, the OS is signalled once.
#[test]
fn bug_07_one_signal_per_batch_of_changes() {
    let mut world = World::fast(1);
    world.event(json!({"watch": null}));
    world.settle();
    for index in 0..50 {
        world.store.put_file(&format!("/n{index}.txt"), kept(b"x"), Some(1));
    }
    let from = world.log.len();
    world.wake_watches();
    world.settle();
    assert_eq!(world.commands(from).iter().filter(|command| **command == Command::Signal).count(), 1);
}

/// Bug 7, the other side: a computer that answers a change wait at once, empty, is not asked again in a tight loop
/// (measured by lane finder-folder: about 300 waits a second). The next wait is no sooner than the contract's idle
/// bound after the last, and the core tells the shell when to wake for it.
#[test]
fn bug_07_an_unheld_wait_is_never_a_tight_loop() {
    let mut world = World::fast(1);
    world.holds_waits = false;
    world.event(json!({"watch": null}));
    world.settle();
    let waits = |world: &World| world.sends.iter().filter(|(_, operation, _)| operation == "list_changes").count();
    assert_eq!(waits(&world), 2, "the cursor of now, then one real wait");
    let wake = world.log.iter().rev().find_map(|command| match command {
        Command::Wake { at_ms } => Some(*at_ms),
        _ => None,
    });
    let idle_ms = sim::idle_ms();
    let at = wake.expect("a wake for the next wait");
    assert!(at >= idle_ms, "{at}");
    world.until(at - 1);
    assert_eq!(waits(&world), 2);
    world.until(at);
    world.settle();
    assert_eq!(waits(&world), 3);
}

/// Bug 8: Move to Trash failed. A delete is the contract's set-aside (Recently Deleted), and the OS trash lists nothing.
#[test]
fn bug_08_a_delete_goes_to_recently_deleted() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", kept(b"a"), Some(1));
    world.list(1, "trillion");
    let (item, version) = (world.item_id("/a.txt"), world.identity("/a.txt"));
    let from = world.log.len();
    world.event(json!({"delete": {"demand": 2, "item": item, "base_version": version}}));
    assert!(matches!(world.done(from, 2), Command::Done { item: None, .. }));
    assert!(world.sends.iter().any(|(_, operation, _)| operation == "set_aside"));
    assert!(names_of(&world.list(3, "trash")).is_empty());
}

/// Bug 9: Finder could not write. A new file is uploaded and kept, and the folder shows it.
#[test]
fn bug_09_a_new_file_is_kept() {
    let mut world = World::fast(1);
    let done = world.create_file(1, "trillion", "notes.txt", b"hello");
    let Command::Done { item: Some(item), .. } = done else { panic!("{done:?}") };
    assert_eq!(item.name, "notes.txt");
    assert!(item.writable && item.uploaded);
    assert_eq!(world.store.names["/notes.txt"].content.range(0, 5), b"hello");
}

/// Bug 10: enumeration never recovered after the Drive started. An unreachable account recovers on the next call.
#[test]
fn bug_10_enumeration_recovers_when_a_computer_comes_back() {
    let mut world = World::fast(1);
    world.links[0].down = true;
    assert!(matches!(world.list(1, "trillion"), Command::Failed { problem: Problem::Unreachable, .. }));
    world.links[0].down = false;
    assert!(matches!(world.list(2, "trillion"), Command::Items { .. }));
}

/// Bug 11: paging limits and continuations lost. Each page names the next until the folder is done.
#[test]
fn bug_11_pages_continue_to_the_end() {
    let mut world = World::fast(1);
    for index in 0..5 {
        world.store.put_file(&format!("/f{index}.txt"), kept(b"x"), Some(1));
    }
    let mut seen = Vec::new();
    let mut page: Value = Value::Null;
    for demand in 1.. {
        let from = world.log.len();
        world.event(json!({"list": {"demand": demand, "folder": "trillion", "page": page, "page_size": 2}}));
        let answer = world.until_logged(from, |command| matches!(command, Command::Items { .. })).unwrap();
        let Command::Items { items, next_page, .. } = answer else { panic!() };
        seen.extend(items.into_iter().map(|item| item.name));
        match next_page {
            Some(next) => page = json!(next),
            None => break,
        }
    }
    assert_eq!(seen, vec!["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
}

/// Bug 12: materialized folders lost after restarts. The items the core knew survive a kept state.
#[test]
fn bug_12_known_items_survive_a_restart() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", kept(b"abc"), Some(1));
    world.list(1, "trillion");
    let from = world.log.len();
    world.event(json!({"keep": null}));
    let Command::State { state } = world.log[from].clone() else { panic!() };
    let mut again = World::fast(1);
    again.store = std::mem::take(&mut world.store);
    again.event(json!({"restore": {"state": state}}));
    let (answer, _) = again.fetch(2, "/a.txt", 0, 3, 1);
    assert!(matches!(answer, Command::Fetched { .. }));
}

/// Bug 13: stale ancestor revisions. A changed child reports its folder changed too.
#[test]
fn bug_13_a_child_change_moves_its_folder() {
    let mut world = World::fast(1);
    world.store.put_folder("/f");
    world.list(1, "trillion");
    let folder = world.item_id("/f");
    world.event(json!({"anchor": {"demand": 2}}));
    world.settle();
    let anchor = world.log.iter().find_map(|command| match command {
        Command::Anchor { anchor, .. } => Some(anchor.clone()),
        _ => None,
    });
    world.store.put_file("/f/a.txt", kept(b"a"), Some(500));
    let from = world.log.len();
    world.event(json!({"changes": {"demand": 3, "anchor": anchor.unwrap(), "page_size": null}}));
    let Some(Command::Changed { updated, .. }) = world.until_logged(from, |command| matches!(command, Command::Changed { .. })) else { panic!() };
    let parent = updated.iter().find(|item| item.id == folder).expect("the folder is reported");
    assert_eq!(parent.modified_ms, Some(500));
}

/// Bug 14: read-ahead trained on failed copies. A refused copy is never handed, so it trains nothing.
#[test]
fn bug_14_a_failed_copy_never_trains_read_ahead() {
    let mut world = World::new(vec![Linked::of(200, 50_000.0)]);
    world.store.put_file("/clip.mov", Content::Made { seed: 3, size: 1 << 30 }, Some(1));
    world.list(1, "trillion");
    let mut refuse = true;
    world.tamper = Some(Box::new(move |operation, _, reply| {
        if let (Reply::Answer(body), true) = (reply, operation == "read_file_span" && refuse) {
            body["offset"] = json!(1);
            refuse = false;
        }
    }));
    let (first, _) = world.fetch(2, "/clip.mov", 0, 1 << 20, 4096);
    assert!(matches!(first, Command::Failed { problem: Problem::RefusedCopy, .. }));
    world.handed(2);
    let asked = world.span_bytes_asked;
    let (second, _) = world.fetch(3, "/clip.mov", 1 << 20, 1 << 20, 4096);
    assert!(matches!(second, Command::Fetched { .. }));
    world.handed(3);
    world.settle();
    assert_eq!(world.span_bytes_asked - asked, 1 << 20, "no read-ahead from one good copy after a failed one");
}

/// Bug 15: rescans after each hydration. A fetch signals nothing and lists nothing.
#[test]
fn bug_15_a_fetch_rescans_nothing() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", kept(b"abc"), Some(1));
    world.list(1, "trillion");
    let (sends, from) = (world.sends.len(), world.log.len());
    world.fetch(2, "/a.txt", 0, 3, 1);
    world.handed(2);
    assert!(!world.commands(from).contains(&Command::Signal));
    assert!(world.sends[sends..].iter().all(|(_, operation, _)| operation == "read_file_span"));
}

/// Bug 16: wrong-version bytes, and a bad range that poisoned the domain. Each wrong answer is refused with nothing
/// written, and the next good answer is served.
#[test]
fn bug_16_a_wrong_answer_is_refused_and_poisons_nothing() {
    let wrongs: Vec<(&str, Value)> = vec![
        ("identity", json!("1f:0000")),
        ("offset", json!(7)),
        ("byte_length", json!(3)),
        ("bytes_returned", json!(1)),
        ("content", json!("YQ==")),
    ];
    for (field, wrong) in wrongs {
        let mut world = World::fast(1);
        world.store.put_file("/a.txt", kept(b"abcdef"), Some(1));
        world.list(1, "trillion");
        let mut once = true;
        let (field_name, value) = (field.to_owned(), wrong.clone());
        world.tamper = Some(Box::new(move |operation, _, reply| {
            if let (Reply::Answer(body), true) = (reply, operation == "read_file_span" && once) {
                body[field_name.as_str()] = value.clone();
                once = false;
            }
        }));
        let (answer, _) = world.fetch(2, "/a.txt", 0, 6, 1);
        assert!(matches!(answer, Command::Failed { problem: Problem::RefusedCopy, .. }), "{field}");
        assert!(world.written.is_empty(), "{field}: nothing written");
        let (answer, _) = world.fetch(3, "/a.txt", 0, 6, 1);
        assert!(matches!(answer, Command::Fetched { .. }), "{field}: the next answer is served");
        assert_eq!(world.held("/a.txt", 0, 6).unwrap(), b"abcdef");
    }
}

/// Bug 17: a budget stop with no progress. A busy computer is asked again when the time it named has passed.
#[test]
fn bug_17_a_busy_computer_is_asked_again_after_its_wait() {
    let mut world = World::fast(1);
    world.store.put_file("/a.txt", kept(b"abc"), Some(1));
    world.list(1, "trillion");
    let mut busy = true;
    world.tamper = Some(Box::new(move |operation, _, reply| {
        if operation == "read_file_span" && busy {
            *reply = Reply::Answer(json!({"busy": true, "retry_after_seconds": 2}));
            busy = false;
        }
    }));
    let item = world.item_id("/a.txt");
    let version = world.identity("/a.txt");
    world.event(json!({"fetch": {"demand": 2, "item": item, "version": version, "offset": 0, "length": 3, "alignment": 1}}));
    world.settle();
    let asked = world.sends.len();
    let now = world.now;
    world.until(now + 1000);
    assert_eq!(world.sends.len(), asked, "not before the named wait");
    world.until(now + 2000);
    world.settle();
    assert!(world.log.iter().any(|command| matches!(command, Command::Fetched { demand: 2, .. })));
}

/// Bug 18: cold files downloaded through Finder. Listing a folder reads no bytes.
#[test]
fn bug_18_listing_reads_no_bytes() {
    let mut world = World::fast(1);
    world.store.put_file("/big.mov", Content::Made { seed: 1, size: 1 << 40 }, Some(1));
    world.list(1, "trillion");
    assert_eq!(world.span_bytes_asked, 0);
}

/// Bug 19: FSKit added as a second client. The core has one read path and one write path, both the contract's.
#[test]
fn bug_19_one_read_path_and_one_write_path() {
    let contract: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
    let operations = contract["operations"].as_object().unwrap();
    let reads: Vec<&String> = operations.keys().filter(|job| job.starts_with("read")).collect();
    assert_eq!(reads, vec!["read_span"]);
    assert!(operations.values().all(|operation| !operation.as_str().unwrap_or_default().contains("dav")));
}

/// Bug 20: names in GET URLs. Every request is a POST whose URL names only the operation.
#[test]
fn bug_20_no_name_travels_in_a_url() {
    let mut world = World::fast(1);
    world.store.put_file("/secret plans.txt", kept(b"abc"), Some(1));
    world.list(1, "trillion");
    world.fetch(2, "/secret plans.txt", 0, 3, 1);
    for command in &world.log {
        if let Command::Send { method, url, .. } = command {
            assert_eq!(method, "POST");
            assert!(!url.contains("secret"), "{url}");
        }
    }
}

/// Bug 21: a writable WebDAV and a write journal as a second write path. Every write is the contract's upload, and
/// every upload names the version it replaces (0: a new name).
#[test]
fn bug_21_every_write_names_the_version_it_replaces() {
    let mut world = World::fast(1);
    world.create_file(1, "trillion", "a.txt", b"one");
    let item = world.item_id("/a.txt");
    let base = world.identity("/a.txt");
    world.edit_file(2, &item, &base, b"two");
    let starts: Vec<&Value> = world.sends.iter().filter(|(_, operation, _)| operation == "write_file_start").map(|(_, _, input)| input).collect();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0]["expected_version"], 0);
    assert_eq!(starts[1]["expected_version"], 1);
    assert_eq!(world.store.names["/a.txt"].content.range(0, 3), b"two");
    assert_ne!(world.identity("/a.txt"), base);
}
