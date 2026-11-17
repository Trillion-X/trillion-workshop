//! The core asks only what the files contract offers, through the engine's one door: every operation contract.json
//! names is one live-namespace's session lists (tools/live-namespace/mcp-tools.json), every refusal is read from the
//! door's answer ({code, outcome}), and an operation a computer does not serve answers `not_offered` rather than
//! being done another way.

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
fn an_operation_a_computer_does_not_serve_is_not_offered() {
    let mut world = World::fast(1);
    world.store.put_file("/a.jpg", Content::Kept(b"jpeg".to_vec()), Some(1));
    world.list(1, "trillion");
    world.tamper = Some(Box::new(|operation, _, reply| {
        if operation == "thumbnail" {
            *reply = Reply::NoMethod;
        }
    }));
    let (item, version) = (world.item_id("/a.jpg"), world.identity("/a.jpg"));
    let from = world.log.len();
    world.event(json!({"thumbnail": {"demand": 2, "item": item, "version": version, "size": 64}}));
    world.settle();
    assert_eq!(world.failed_with(from, 2), Some(Problem::NotOffered));
}

#[test]
fn new_folder_is_made_and_shown() {
    let mut world = World::fast(1);
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
    let mut world = World::fast(1);
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
fn every_call_is_one_door_message_and_waits_for_the_bounds() {
    let mut world = World::fast(2);
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    world.list(1, "trillion");
    let sent: Vec<&str> = world.sends.iter().map(|(_, operation, _)| operation.as_str()).collect();
    assert_eq!(sent, ["bounds", "bounds", "list_files"], "the bounds are asked of every computer before the first job");
    assert!(world.log.iter().any(|command| matches!(command, Command::Abandon { .. })), "the slower bounds call is let go");
    let urls: Vec<&String> = world.log.iter().filter_map(|command| match command { Command::Send { url, .. } => Some(url), _ => None }).collect();
    assert!(urls.iter().all(|url| url.ends_with("/mcp")), "{urls:?}");
    let from = world.sends.len();
    world.list(2, "trillion");
    assert_eq!(world.sends[from..].iter().map(|(_, operation, _)| operation.as_str()).collect::<Vec<_>>(), ["list_files"], "asked once");
}

#[test]
fn a_conflict_keeps_a_copy_and_asks_no_other_computer() {
    let mut world = World::fast(2);
    world.store.put_file("/report.txt", Content::Kept(b"mine".to_vec()), Some(1));
    world.list(1, "trillion");
    let (item, base) = (world.item_id("/report.txt"), world.identity("/report.txt"));
    // Another device's version lands after this one read the file: this one's write meets the store's compare-and-set.
    world.store.put_file("/report.txt", Content::Kept(b"theirs".to_vec()), Some(2));
    let asked = world.log.len();
    let Command::Done { kept_beside, .. } = world.edit_file(2, &item, &base, b"mine, edited") else { panic!() };
    assert!(kept_beside, "the edit is kept beside as a conflict copy");
    let computers: Vec<bool> = world.log[asked..].iter().filter_map(|command| match command {
        Command::Send { url, .. } => Some(url.starts_with(&sim::origin(1))),
        _ => None,
    }).collect();
    assert!(!computers.contains(&true), "a conflict is an answer, never a reason to ask another computer");
}

#[test]
fn a_refusal_no_row_names_asks_the_next_computer() {
    let mut world = World::fast(2);
    world.store.put_file("/a.txt", Content::Kept(b"abc".to_vec()), Some(1));
    let mut once = true;
    world.tamper = Some(Box::new(move |operation, _, reply| {
        if operation == "list_files" && once {
            *reply = Reply::Refused(json!({"code": "namespace_unavailable", "outcome": "not_started"}));
            once = false;
        }
    }));
    let Command::Items { items, .. } = world.list(1, "trillion") else { panic!() };
    assert_eq!(items.len(), 1);
}
