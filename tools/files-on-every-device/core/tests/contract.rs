//! The core asks only what the files contract offers, through the engine's one door: every operation contract.json
//! names is one live-namespace's session lists (tools/live-namespace/mcp-tools.json), every refusal is read from the
//! door's answer ({code, outcome}), and an operation the session does not list is refused rather than done another
//! way.

mod sim;

use files_core::{Command, Problem};
use serde_json::{json, Value};
use sim::{Content, Reply, World};

#[test]
fn every_operation_the_core_asks_is_offered() {
    let contract: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
    let tools: Value = serde_json::from_str(include_str!("../../../live-namespace/mcp-tools.json")).unwrap();
    let offered: Vec<&str> = tools["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str()).collect();
    for (job, operation) in contract["operations"].as_object().unwrap() {
        if let Some(operation) = operation.as_str() {
            assert!(offered.contains(&operation), "{job}: {operation} is not offered by the contract");
        }
    }
}

#[test]
fn an_operation_the_session_does_not_list_is_refused() {
    let mut world = World::fast();
    world.store.put_file("/a.jpg", Content::Kept(b"jpeg".to_vec()), Some(1));
    world.list(1, "trillion");
    world.tamper = Some(Box::new(|operation, _, reply| {
        if operation == "thumbnail" {
            *reply = Reply::NoTool;
        }
    }));
    let (item, version) = (world.item_id("/a.jpg"), world.identity("/a.jpg"));
    let from = world.log.len();
    world.event(json!({"thumbnail": {"demand": 2, "item": item, "version": version, "size": 64}}));
    world.settle();
    assert_eq!(world.failed_with(from, 2), Some(Problem::Invalid), "refused, never done another way");
}

#[test]
fn new_folder_is_made_and_shown() {
    let mut world = World::fast();
    let from = world.log.len();
    world.event(json!({"create": {"demand": 1, "parent": "trillion", "name": "New Folder", "folder": true, "length": null, "media_type": null, "date": "2026-11-17"}}));
    let Command::Done { item: Some(made), .. } = world.done(from, 1) else { panic!() };
    assert_eq!((made.name.as_str(), made.folder, made.id.clone()), ("New Folder", true, world.item_id("/New Folder")));
    let from = world.log.len();
    world.event(json!({"create": {"demand": 2, "parent": "trillion", "name": "New Folder", "folder": true, "length": null, "media_type": null, "date": "2026-11-17"}}));
    world.settle();
    assert_eq!(world.failed_with(from, 2), Some(Problem::StaleVersion), "a name already there is a conflict");
}

#[test]
fn one_item_by_its_id() {
    let mut world = World::fast();
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    let item = world.item_id("/a.txt");
    let from = world.log.len();
    world.event(json!({"item": {"demand": 1, "item": item}}));
    let Some(Command::Items { items, .. }) = world.until_logged(from, |command| matches!(command, Command::Items { .. })) else { panic!() };
    assert_eq!((items[0].id.as_str(), items[0].name.as_str()), (item.as_str(), "a.txt"));
    let from = world.log.len();
    world.event(json!({"item": {"demand": 2, "item": "trillion"}}));
    assert!(matches!(&world.log[from], Command::Items { items, .. } if items[0].name == "Trillion"));
}

#[test]
fn every_call_is_one_door_message_after_the_start() {
    let mut world = World::fast();
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    world.list(1, "trillion");
    let sent: Vec<&str> = world.sends.iter().map(|(_, operation, _)| operation.as_str()).collect();
    assert_eq!(sent, ["bounds", "this_computer", "list_files"], "the bounds and this computer are asked before the first job");
    let urls: Vec<&String> = world.log.iter().filter_map(|command| match command { Command::Send { url, .. } => Some(url), _ => None }).collect();
    assert!(urls.iter().all(|url| url.ends_with("/mcp")), "{urls:?}");
    let from = world.sends.len();
    world.list(2, "trillion");
    assert_eq!(world.sends[from..].iter().map(|(_, operation, _)| operation.as_str()).collect::<Vec<_>>(), ["list_files"], "asked once");
}

#[test]
fn a_conflict_keeps_a_copy_and_is_no_failure() {
    let mut world = World::fast();
    world.store.put_file("/report.txt", Content::Kept(b"mine".to_vec()), Some(1));
    world.list(1, "trillion");
    let (item, base) = (world.item_id("/report.txt"), world.identity("/report.txt"));
    // Another device's version lands after this one read the file: this one's write meets the store's compare-and-set.
    world.store.put_file("/report.txt", Content::Kept(b"theirs".to_vec()), Some(2));
    let Command::Done { kept_beside, .. } = world.edit_file(2, &item, &base, b"mine, edited") else { panic!() };
    assert!(kept_beside, "the edit is kept beside as a conflict copy");
}

#[test]
fn a_refusal_no_row_names_is_unreachable() {
    let mut world = World::fast();
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    let mut once = true;
    world.tamper = Some(Box::new(move |operation, _, reply| {
        if operation == "list_files" && once {
            *reply = Reply::Refused(json!({"code": "namespace_unavailable", "outcome": "not_started"}));
            once = false;
        }
    }));
    assert!(matches!(world.list(1, "trillion"), Command::Failed { problem: Problem::Unreachable, .. }));
    let from = world.log.len();
    let Command::Items { items, .. } = world.list(2, "trillion") else { panic!() };
    assert_eq!(items.len(), 1);
    assert!(world.commands(from).contains(&Command::Resolved));
}

#[test]
fn with_no_computer_named_a_pin_and_a_conflict_copy_are_not_offered() {
    let mut world = World::fast();
    world.store.names_computer = false;
    world.store.put_file("/report.txt", Content::Kept(b"mine".to_vec()), Some(1));
    let Command::Items { items, .. } = world.list(1, "trillion") else { panic!() };
    assert_eq!(items.len(), 1, "listing works with no computer named");
    assert!(world.sends.iter().all(|(_, _, input)| input.get("device").is_none()), "no device is named");
    let item = world.item_id("/report.txt");
    let from = world.log.len();
    world.event(json!({"pin": {"demand": 2, "item": item, "keep": true}}));
    assert_eq!(world.failed_with(from, 2), Some(Problem::NotOffered));
    let base = world.identity("/report.txt");
    world.store.put_file("/report.txt", Content::Kept(b"theirs".to_vec()), Some(2));
    let from = world.log.len();
    world.edit_file(3, &item, &base, b"mine, edited");
    assert_eq!(world.failed_with(from, 3), Some(Problem::StaleVersion), "the store's newer version is never written over");
    assert_eq!(world.store.names["/report.txt"].content.range(0, 6), b"theirs");
}

/// Every problem, by an exhaustive match: a new problem stops this test from compiling until it is listed.
fn every_problem() -> Vec<Problem> {
    let all = [Problem::Unauthorised, Problem::Forbidden, Problem::Missing, Problem::StaleVersion, Problem::Unreachable, Problem::Invalid, Problem::RefusedCopy, Problem::NotOffered, Problem::Cancelled, Problem::AnswerIncomplete];
    for problem in all {
        match problem {
            Problem::Unauthorised | Problem::Forbidden | Problem::Missing | Problem::StaleVersion | Problem::Unreachable | Problem::Invalid | Problem::RefusedCopy | Problem::NotOffered | Problem::Cancelled | Problem::AnswerIncomplete => {}
        }
    }
    all.to_vec()
}

#[test]
fn every_problem_has_words_and_a_failure_carries_them() {
    let contract = files_core::Contract::shipped();
    for problem in every_problem() {
        assert!(!contract.words(problem).is_empty(), "{problem:?}");
    }
    assert_eq!(contract.problem_words.len(), every_problem().len(), "no words for a problem that is not one");
    let mut world = World::fast();
    world.link.down = true;
    let failed = world.list(1, "trillion");
    assert!(matches!(&failed, Command::Failed { problem: Problem::Unreachable, words, .. } if words == "Your files can't be reached right now."), "{failed:?}");
}
