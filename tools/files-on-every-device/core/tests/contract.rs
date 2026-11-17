//! The core asks only what the files contract offers: every operation contract.json names is one the account files
//! door answers (tools/live-namespace/src/account_files/account-files-routes.json `operations`), and an operation a
//! computer does not serve answers `not_offered` rather than being done another way.

mod sim;

use files_core::{Command, Problem};
use serde_json::{json, Value};
use sim::{Content, World};

#[test]
fn every_operation_the_core_asks_is_offered() {
    let contract: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
    let routes: Value = serde_json::from_str(include_str!("../../../live-namespace/src/account_files/account-files-routes.json")).unwrap();
    let offered: Vec<&str> = routes["operations"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
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
    world.tamper = Some(Box::new(|operation, _, status, body| {
        if operation == "thumbnail" {
            *status = 404;
            *body = json!("No such operation.");
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
