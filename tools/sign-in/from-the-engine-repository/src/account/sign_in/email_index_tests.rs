//! The email index's rules against an in-memory sign-in schema: a claim, a repeat, a taken email, a move, a release,
//! a lookup that answers None the same way for an unindexed email and a text that is not one, and rows that hold no
//! plain email.

use super::*;
use crate::account::sign_in::{Address, UserId};
use crate::storage::memory::Memory;

const ALICE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OPERATOR: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn fixture() -> Memory {
    Memory::open("sign_in").expect("the sign_in schema opens")
}

#[test]
fn claim_then_lookup_finds_the_account_by_its_email_in_any_case() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    claim(&store, &secrets, &names, UserId(OPERATOR), "  person@example.test ", Address(ALICE)).expect("a free email is claimed");
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), Some(ALICE.to_string()));
}

#[test]
fn a_repeat_claim_by_the_same_account_succeeds_and_another_account_is_taken() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(ALICE)).unwrap();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(ALICE)).expect("the same account claims again");
    assert!(matches!(claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(BOB)), Err(Refused::Taken(_))));
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), Some(ALICE.to_string()));
}

#[test]
fn an_unindexed_email_and_a_text_that_is_not_an_email_both_answer_none() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), None);
    assert_eq!(lookup(&store, &secrets, &names, "not an email").unwrap(), None);
}

#[test]
fn a_move_claims_the_new_email_and_releases_the_old_one() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(ALICE)).unwrap();
    move_claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", "person@example.test", Address(ALICE)).unwrap();
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), None);
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), Some(ALICE.to_string()));
}

#[test]
fn a_refused_move_leaves_the_old_email_held() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(ALICE)).unwrap();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(BOB)).unwrap();
    assert!(matches!(move_claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", "person@example.test", Address(ALICE)), Err(Refused::Taken(_))));
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), Some(ALICE.to_string()));
}

#[test]
fn release_removes_only_for_the_holder() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(ALICE)).unwrap();
    assert!(!release(&store, &secrets, &names, "person@example.test", Address(BOB)).unwrap());
    assert!(release(&store, &secrets, &names, "person@example.test", Address(ALICE)).unwrap());
    assert_eq!(lookup(&store, &secrets, &names, "person@example.test").unwrap(), None);
}

#[test]
fn a_stored_row_holds_a_keyed_hash_not_the_email() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    claim(&store, &secrets, &names, UserId(OPERATOR), "person@example.test", Address(ALICE)).unwrap();
    let id = row_id(&secrets, "person@example.test");
    assert_eq!(id.len(), 64);
    assert!(!id.contains('@'));
    assert!(store.get::<Entry>(Family::EmailIndex, "person@example.test").unwrap().is_none());
}

#[test]
fn attempts_past_the_limit_are_refused_and_another_key_has_its_own_count() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    assert!(count_attempt(&store, &secrets, UserId(OPERATOR), "lookup:person@example.test", 2).unwrap());
    assert!(count_attempt(&store, &secrets, UserId(OPERATOR), "lookup:person@example.test", 2).unwrap());
    assert!(!count_attempt(&store, &secrets, UserId(OPERATOR), "lookup:person@example.test", 2).unwrap());
    assert!(count_attempt(&store, &secrets, UserId(OPERATOR), "lookup:person@example.test", 2).unwrap());
}

#[test]
fn an_email_is_claimed_and_tried_under_the_operator_user_id_and_read_back_by_it() {
    let mem = fixture();
    let store = Store::new(&mem);
    let secrets = crate::secrets::secrets_key::generate().expect("a test secrets key");
    let names = ways::for_tests();
    let user = "account-operator-user";
    ways::set(&store, user, 0, names.clone()).expect("the operator's ways are kept under its user id");
    let read = ways::current(&store, UserId(user)).expect("the ways are read by the same user id");
    claim(&store, &secrets, &read, UserId(user), "person@example.test", Address(ALICE)).expect("a free email is claimed");
    assert!(count_attempt(&store, &secrets, UserId(user), "lookup:person@example.test", 5).expect("a try is counted"));
    assert_eq!(lookup(&store, &secrets, &read, "person@example.test").unwrap(), Some(ALICE.to_string()));
}
