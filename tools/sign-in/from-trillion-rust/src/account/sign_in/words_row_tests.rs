//! The account's words row: its own, changed only from the revision read, a missing row never filled in, a row that lacks
//! a part takes that part from the product's words only (never from anywhere else), and never leaving a way of the
//! account's ways row without its words.

use super::*;
use crate::account::sign_in::ways;
use crate::storage::memory::Memory;

#[test]
fn a_missing_row_is_none_and_never_filled_in() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    assert_eq!(current(&store, "ada").unwrap(), None);
    assert!(read(&store, "ada").unwrap().is_none(), "reading wrote nothing");
    assert_eq!(crate::account::sign_in::known::words(&store, "ada"), Err(crate::cause!(crate::account::sign_in::Error::WordsMissing)));
}

#[test]
fn the_row_changes_only_from_the_revision_read() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    assert_eq!(set(&store, "ada", 0, for_tests(), None).unwrap().revision, 1);
    assert_eq!(set(&store, "ada", 0, for_tests(), None), Err(crate::cause!(Refused::Stale)), "a second first row is refused");
    let mut plainer = for_tests();
    plainer.sign_in_title = "Come in".into();
    assert_eq!(set(&store, "ada", 1, plainer.clone(), None).unwrap().revision, 2);
    assert_eq!(current(&store, "ada").unwrap(), Some(plainer));
    assert_eq!(set(&store, "ada", 1, for_tests(), None), Err(crate::cause!(Refused::Stale)), "a stale revision is refused");
    assert_eq!(current(&store, "bob").unwrap(), None, "another account's row is not this one");
}

#[test]
fn a_row_that_lacks_a_block_takes_it_from_the_product_and_keeps_what_it_sets() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    set_product_words(&for_tests());
    let mut older = serde_json::to_value(for_tests()).unwrap();
    older.as_object_mut().unwrap().remove("add_email");
    older["sign_in_title"] = serde_json::json!("Come in");
    let value = StoredRow { revision: 1, words: older, unknown_keys: Default::default() };
    store.insert(Family::Lists, &Row { id: row_id("ada"), account: "ada".into(), expires_at: 0, value }).unwrap();
    let now = current(&store, "ada").unwrap().unwrap();
    assert_eq!(now.ways.add_email, for_tests().ways.add_email, "the block the row lacks comes from the product");
    assert_eq!(now.sign_in_title, "Come in", "what the row sets wins over the product");
}

#[test]
fn a_save_stores_only_what_differs_from_the_product() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    set_product_words(&for_tests());
    let mut plainer = for_tests();
    plainer.sign_in_title = "Come in".into();
    set(&store, "bob", 0, plainer.clone(), None).unwrap();
    assert_eq!(read_stored(&store, "bob").unwrap().unwrap().value.words, serde_json::json!({"sign_in_title": "Come in"}), "only the part that differs is stored");
    assert_eq!(current(&store, "bob").unwrap(), Some(plainer), "the account still reads its whole words");
}

#[test]
fn words_that_leave_a_way_without_its_words_are_refused() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    let held = ways::for_tests();
    assert!(for_tests().covers(&held), "the starting words name every starting way");
    let mut no_password = for_tests();
    no_password.ways.rows.remove("password");
    assert!(!no_password.covers(&held));
    assert_eq!(set(&store, "ada", 0, no_password.clone(), Some(&held)), Err(crate::cause!(Refused::Invalid)));
    let mut no_field = for_tests();
    no_field.ways.fields.remove("phone");
    assert_eq!(set(&store, "ada", 0, no_field, Some(&held)), Err(crate::cause!(Refused::Invalid)), "a kind of name needs its field's words");
    assert!(read(&store, "ada").unwrap().is_none());
    // Without the password way, the same words hold.
    let mut fewer = held.clone();
    fewer.rows.retain(|row| row.way != "password" && !row.also.iter().any(|also| also == "password"));
    for row in &mut fewer.rows {
        row.recover_with.retain(|other| other != "password");
    }
    assert!(no_password.covers(&fewer));
}

#[test]
fn starting_rows_write_the_words_once_and_never_replace_the_owners() {
    let mem = Memory::open("sign_in").unwrap();
    let starting = crate::account::sign_in::StartingRows::for_tests();
    assert!(starting.valid());
    assert!(starting.write_missing(&mem, "ada").unwrap() >= 3);
    let store = Store::new(&mem);
    assert_eq!(current(&store, "ada").unwrap(), Some(for_tests()));
    let mut own = for_tests();
    own.sign_in_title = "Mine".into();
    set(&store, "ada", 1, own.clone(), None).unwrap();
    assert_eq!(starting.write_missing(&mem, "ada").unwrap(), 0);
    assert_eq!(current(&store, "ada").unwrap(), Some(own), "the owner's words stay");
    let mut uncovered = starting.clone();
    uncovered.sign_in_words.ways.rows.remove("email-code");
    assert!(!uncovered.valid(), "starting rows whose words miss a way do not hold together");
}

#[test]
fn a_row_that_still_holds_the_previous_code_message_reads_the_shipped_one_and_is_not_rewritten() {
    let mem = Memory::open("sign_in").unwrap();
    let store = Store::new(&mem);
    let shipped = crate::account::sign_in::shipped().sign_in_words.clone();
    let mut previous = for_tests();
    previous.ways.code_sent = ways::shape_defaults().previous_code_sent.clone();
    set(&store, "ada", 0, previous, None).unwrap();
    assert_eq!(current(&store, "ada").unwrap().unwrap().ways.code_sent, shipped.ways.code_sent);
    assert_eq!(read(&store, "ada").unwrap().unwrap().value.revision, 1, "reading never bumps the revision");
    let stored = read_stored(&store, "ada").unwrap().unwrap();
    assert_eq!(stored.value.words["ways"]["code_sent"], ways::shape_defaults().previous_code_sent, "the stored row is not rewritten");

    let mut own = shipped.clone();
    own.ways.code_sent = "Check the newest message from us.".into();
    set(&store, "bob", 0, own, None).unwrap();
    assert_eq!(current(&store, "bob").unwrap().unwrap().ways.code_sent, "Check the newest message from us.");
}

#[test]
fn a_kept_row_without_the_code_step_words_loads_and_leaves_them_empty() {
    let mut before = serde_json::to_value(for_tests()).unwrap();
    let email = before["ways"]["rows"]["email-code"].as_object_mut().unwrap();
    for key in ["code_heading", "sent_to", "change_sent_to"] {
        email.remove(key);
    }
    let words: Words = serde_json::from_value(before).unwrap();
    assert_eq!(words.ways.rows["email-code"].code_heading, "");
    assert_eq!(words.ways.rows["email-code"].sent_to, "");
    assert_eq!(words.ways.rows["email-code"].change_sent_to, "");
}
