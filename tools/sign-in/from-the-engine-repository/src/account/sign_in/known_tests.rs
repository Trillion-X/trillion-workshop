//! Which passkeys are known, and which changes to the ways in a known passkey must confirm (`known.rs`), over the
//! ceremonies of `passkeys.rs` with simulated authenticators. Synthetic accounts and keys only.

use super::*;
use crate::account::sign_in::passkeys::{self, tests::{assertion, b, registration, row_of, Authenticator, BOTH, ORIGIN, RP}};
use serde_json::json;

const ACCOUNT: &str = "ada";

fn memory() -> crate::storage::memory::Memory {
    crate::account::sign_in::lists::test_memory()
}

/// Register `auth` for the account through the ordinary add ceremony.
fn add(store: &Store<'_>, auth: &Authenticator) -> super::super::Result<String> {
    let options = passkeys::registration_options(store, ACCOUNT, ORIGIN).unwrap();
    passkeys::finish_registration(store, ACCOUNT, ORIGIN, &registration(auth, options["challenge"].as_str().unwrap()))
}

/// Register `auth` as the passkey a sign-up made the account with.
fn sign_up(store: &Store<'_>, auth: &Authenticator) -> String {
    let challenge = "sign-up-challenge-0123456789abcdef";
    passkeys::remember_challenge(store, ACCOUNT, challenge, now_ms() + 60_000).unwrap();
    passkeys::finish_registration(store, ACCOUNT, ORIGIN, &registration(auth, challenge)).unwrap()
}

/// Sign in with `auth`, its counter at `counter`.
fn use_to_sign_in(store: &Store<'_>, auth: &Authenticator, counter: u32) -> super::super::Result<String> {
    let options = passkeys::sign_in_options(store, ACCOUNT, ORIGIN).unwrap();
    passkeys::finish_sign_in(store, ORIGIN, &assertion(auth, options["challenge"].as_str().unwrap(), ORIGIN, RP, BOTH, counter))
}

/// A confirmation of `change` by `auth`, its counter at `counter`.
fn confirmation(store: &Store<'_>, auth: &Authenticator, change: &Change, counter: u32) -> serde_json::Value {
    let options = passkeys::confirm_options(store, ACCOUNT, ORIGIN, &change.key()).unwrap();
    assertion(auth, options["challenge"].as_str().unwrap(), ORIGIN, RP, BOTH, counter)
}

/// Move a passkey's `from` (and a recovery's) into the past, as if its wait had run.
fn age(store: &Store<'_>, id: &str) {
    let mut row: Row<Passkey> = store.get(Family::Passkeys, id).unwrap().unwrap();
    let authority = row.value.authority.as_mut().unwrap();
    authority.from = authority.from.map(|_| 1);
    store.put(Family::Passkeys, &row).unwrap();
}

fn age_recovery(store: &Store<'_>) {
    let mut row: Row<AuthorityRow> = store.get(Family::Lists, &format!("{ROW_PREFIX}{ACCOUNT}")).unwrap().unwrap();
    let recovery = row.value.recovery.as_mut().unwrap();
    recovery.from = now_ms() - 1;
    store.put(Family::Lists, &row).unwrap();
}

#[test]
fn the_sign_up_passkey_is_known_at_once_and_a_later_one_added_without_a_confirmation_never_is() {
    let memory = memory();
    let store = Store::new(&memory);
    let first = sign_up(&store, &Authenticator::ec(1));
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(state.known, vec![first.clone()]);
    assert!(state.notices.is_empty(), "the sign-up passkey is not told");

    let second = add(&store, &Authenticator::ec(2)).unwrap();
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(state.known, vec![first], "an unvouched passkey signs in but is never known");
    assert!(state.waiting.is_empty());
    let row = state.passkeys.iter().find(|row| row.id == second).unwrap();
    assert_eq!(row.value.authority.as_ref().unwrap().by, Provenance::Unvouched);
    assert_eq!(state.notices.len(), 1, "every passkey but the sign-up passkey is told");
    assert_eq!(state.notices[0].body, said().added_unvouched_body);
}

#[test]
fn on_an_account_with_no_known_passkey_an_added_one_waits_out_its_notice_then_is_known() {
    let memory = memory();
    let store = Store::new(&memory);
    let id = add(&store, &Authenticator::ec(3)).unwrap();
    let now = now_ms();
    let state = super::state(&store, ACCOUNT, now).unwrap();
    assert!(state.known.is_empty());
    assert_eq!(state.waiting, vec![id.clone()]);
    let from = authority_from(&state.passkeys[0].value).unwrap();
    assert!(from >= now + wait_ms_for_tests(Provenance::Notice) - 60_000, "it waits the notice row's hours");
    // While it waits, no way in may change; once the wait has run, it is known.
    assert_eq!(guarded(&state, true, false), Err(crate::cause!(Refused::HeldWhileWaiting)));
    assert_eq!(guarded(&state, false, false), Ok(()), "with no known passkey the change goes (the stated risk)");
    age(&store, &id);
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(state.known, vec![id]);
    assert_eq!(guarded(&state, true, false), Err(crate::cause!(Refused::NeedsKnownPasskey)));
    assert_eq!(guarded(&state, true, true), Ok(()));
}

#[test]
fn a_known_passkeys_sign_in_cancels_what_waits_and_ends_a_waiting_recovery() {
    let memory = memory();
    let store = Store::new(&memory);
    let known = Authenticator::ec(4);
    let known_id = add(&store, &known).unwrap();
    age(&store, &known_id);
    // A passkey added while a recovery waits waits out the notice too, and no sooner than the recovery ends.
    assert_eq!(recover(&store, ACCOUNT, false).map(|said| said.contains("Recovery started")), Ok(true));
    let waiting = add(&store, &Authenticator::ec(5)).unwrap();
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(state.waiting, vec![waiting.clone()]);
    assert!(state.recovery.is_some());

    use_to_sign_in(&store, &known, 1).unwrap();
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert!(state.waiting.is_empty() && state.recovery.is_none(), "{state:?}");
    let cancelled = state.passkeys.iter().find(|row| row.id == waiting).unwrap().value.authority.clone().unwrap();
    assert_eq!((cancelled.by, cancelled.cancelled, cancelled.from), (Provenance::Unvouched, Some(Provenance::Notice), None));
}

#[test]
fn a_recovery_that_ran_its_wait_unknows_the_passkeys_known_before_it_and_can_be_cancelled_before() {
    let memory = memory();
    let store = Store::new(&memory);
    let old = sign_up(&store, &Authenticator::ec(6));
    assert_eq!(recover(&store, ACCOUNT, true), Ok(said().recovery_cancelled.clone()), "nothing to cancel is fine");
    recover(&store, ACCOUNT, false).unwrap();
    assert!(recover(&store, ACCOUNT, false).unwrap().contains("Recovery started"), "asking again answers the same recovery");
    assert_eq!(recover(&store, ACCOUNT, true), Ok(said().recovery_cancelled.clone()));
    assert!(super::state(&store, ACCOUNT, now_ms()).unwrap().recovery.is_none());

    recover(&store, ACCOUNT, false).unwrap();
    age_recovery(&store);
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert!(state.recovered.is_some() && !state.known.contains(&old), "the old passkey is unknown once the recovery ran");
    assert_eq!(recover(&store, ACCOUNT, false), Ok(said().recovery_not_needed.clone()));
}

#[test]
fn notices_are_bounded_per_window_so_a_flood_of_adds_is_refused() {
    let memory = memory();
    let store = Store::new(&memory);
    sign_up(&store, &Authenticator::ec(10));
    let most = super::super::settings().authority.notice_most;
    for byte in 0..most {
        add(&store, &Authenticator::ec(20 + byte as u8)).expect("within the window's room");
    }
    let refused = add(&store, &Authenticator::ec(90));
    assert!(matches!(refused, Err(super::super::Error::InvalidRequest(_, _))), "{refused:?}");
    assert!(store.get::<Passkey>(Family::Passkeys, &b(&Authenticator::ec(90).id)).unwrap().is_none(), "nothing is saved");
    assert_eq!(recover(&store, ACCOUNT, false), Err(crate::cause!(Refused::TooManyNotices)));
}

#[test]
fn a_passkey_saved_before_provenance_is_classified_once_and_told() {
    let memory = memory();
    let store = Store::new(&memory);
    // On an account with no known passkey: it waits out the notice from now.
    store.put(Family::Passkeys, &row_of(&Authenticator::ec(30), ACCOUNT, None)).unwrap();
    let first = super::state(&store, ACCOUNT, now_ms()).unwrap();
    let authority = first.passkeys[0].value.authority.clone().unwrap();
    assert_eq!((authority.by, authority.classified), (Provenance::Notice, true));
    assert_eq!(first.notices.len(), 1);
    assert_eq!(first.notices[0].title, said().legacy_title);
    let again = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(again.notices.len(), 1, "classified once");
    assert_eq!(again.passkeys[0].value.authority, Some(authority));

    // Beside a known passkey: unvouched.
    let memory = super::super::lists::test_memory();
    let store = Store::new(&memory);
    sign_up(&store, &Authenticator::ec(31));
    store.put(Family::Passkeys, &row_of(&Authenticator::ec(32), ACCOUNT, None)).unwrap();
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    let legacy = state.passkeys.iter().find(|row| row.id == b(&Authenticator::ec(32).id)).unwrap();
    assert_eq!(legacy.value.authority.as_ref().unwrap().by, Provenance::Unvouched);
}

#[test]
fn only_a_known_passkeys_confirmation_for_exactly_that_change_confirms_it() {
    let memory = memory();
    let store = Store::new(&memory);
    let known = Authenticator::ec(40);
    sign_up(&store, &known);
    let other = Authenticator::ec(41);
    add(&store, &other).unwrap();
    let change = Change::named("remove-way", &[("way", "password")]);
    assert_eq!(confirmed(&store, ACCOUNT, Some(ORIGIN), &change, None), Ok(false));

    let proof = confirmation(&store, &known, &change, 1);
    assert_eq!(confirmed(&store, ACCOUNT, Some(ORIGIN), &change, Some(&proof)), Ok(true));
    assert!(super::state(&store, ACCOUNT, now_ms()).unwrap().notices.iter().any(|notice| notice.title == said().confirmed_title), "each confirmation is told");
    assert_eq!(confirmed(&store, ACCOUNT, Some(ORIGIN), &change, Some(&proof)), Err(crate::cause!(Refused::PasskeyRefused)), "one use");

    let another = Change::named("remove-way", &[("way", "email-code")]);
    let proof = confirmation(&store, &known, &change, 2);
    assert_eq!(confirmed(&store, ACCOUNT, Some(ORIGIN), &another, Some(&proof)), Err(crate::cause!(Refused::PasskeyRefused)), "bound to its change");

    let proof = confirmation(&store, &other, &change, 1);
    assert_eq!(confirmed(&store, ACCOUNT, Some(ORIGIN), &change, Some(&proof)), Err(Refused::NotKnown(said().never_known.clone(), crate::cause!())));
}

#[test]
fn a_known_passkey_vouches_for_another_which_is_known_after_its_notice() {
    let memory = memory();
    let store = Store::new(&memory);
    let first = sign_up(&store, &Authenticator::ec(50));
    let second = add(&store, &Authenticator::ec(51)).unwrap();
    assert_eq!(vouch(&store, ACCOUNT, &second, false), Err(crate::cause!(Refused::NeedsKnownPasskey)));
    assert_eq!(vouch(&store, ACCOUNT, "nothing", true), Err(crate::cause!(Refused::NoPasskey)));
    assert_eq!(vouch(&store, ACCOUNT, &first, true), Ok(said().already_known.clone()));
    assert!(vouch(&store, ACCOUNT, &second, true).is_ok());
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(state.waiting, vec![second.clone()], "known only after the notice");
    let authority = state.passkeys.iter().find(|row| row.id == second).unwrap().value.authority.clone().unwrap();
    assert_eq!(authority.by, Provenance::KnownPasskey);
    // A vouched-for passkey waits on: a known passkey's use does not cancel what a known passkey confirmed.
    cancel_waiting(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(super::state(&store, ACCOUNT, now_ms()).unwrap().waiting, vec![second]);
}

#[test]
fn a_known_passkey_goes_only_with_a_confirmation_and_a_change_is_only_one_named_in_the_words() {
    let memory = memory();
    let store = Store::new(&memory);
    let first = sign_up(&store, &Authenticator::ec(60));
    let second = add(&store, &Authenticator::ec(61)).unwrap();
    let state = super::state(&store, ACCOUNT, now_ms()).unwrap();
    assert_eq!(removal(&state, &second, false), Ok(()), "a passkey that is not known goes with the sign-in alone");
    assert_eq!(removal(&state, &first, false), Err(crate::cause!(Refused::NeedsKnownPasskey)));
    assert_eq!(removal(&state, &first, true), Ok(()));
    assert_eq!(Change::of_test(&json!({"action": "remove-way", "way": "password"})).unwrap().key(),
        Change::named("remove-way", &[("way", "password")]).key(), "one key whatever the order");
    assert!(Change::of_test(&json!({"action": "delete-everything"})).is_err());
    assert!(Change::of_test(&json!({"action": "remove-way", "way": 3})).is_err());
    assert!(Change::named("remove-way", &[("way", "password")]).words(&said()).contains("(password)"));
}

/// The operation words every test account has (`words_row::for_tests`).
fn said() -> OperationWords {
    crate::account::sign_in::words_row::for_tests().operations
}

impl Change {
    fn of_test(value: &Value) -> std::result::Result<Change, Refused> {
        Change::of(value, &said())
    }
}

/// The person-present confirmation of a records write (`account::person_confirmation`) reads the account's KNOWN
/// passkeys through `passkeys::KnownPasskeys`: the known passkey's signature of the write's challenge confirms it and
/// commits its counter; a replay, a lower counter and a passkey added without a known passkey's confirmation do not.
#[test]
fn only_a_known_passkey_confirms_a_write_that_needs_the_person_present() {
    use crate::account::person_confirmation::{Challenges, Passkeys as _, Refused as Unconfirmed, Requirement};
    let shared: super::super::Shared = std::sync::Arc::new(super::super::Locked::new(memory()));
    let store = Store::new(&*shared);
    let known = Authenticator::ec(50);
    let known_id = sign_up(&store, &known);
    let unvouched = Authenticator::ec(51);
    add(&store, &unvouched).unwrap();
    let source = passkeys::KnownPasskeys::new(shared.clone(), ACCOUNT, ORIGIN).unwrap();
    assert_eq!((source.origin(), source.relying_party()), (ORIGIN.to_owned(), RP.to_owned()));
    let listed: Vec<_> = source.credentials("owner").into_iter().map(|stored| stored.credential["id"].clone()).collect();
    assert_eq!(listed, vec![json!(known_id)], "only the known passkey is listed");

    let challenges = Challenges::default();
    let requirement = Requirement { record: "record:synthetic-row:1".into(), field: "state".into(), value: "Down".into() };
    let now = now_ms();
    let confirm = |auth: &Authenticator, counter: u32| {
        let issued = challenges.issue("owner", &requirement, now).unwrap();
        let proof = json!({"nonce": issued.nonce, "assertion": assertion(auth, &issued.challenge, ORIGIN, RP, BOTH, counter)});
        challenges.confirm("owner", &requirement, &proof, now, &source)
    };
    assert_eq!(confirm(&unvouched, 1), Err(crate::cause!(Unconfirmed::Unverified)), "a passkey that is not known never confirms");
    assert_eq!(confirm(&known, 3), Ok(()));
    let row: Row<Passkey> = store.get(Family::Passkeys, &known_id).unwrap().unwrap();
    assert_eq!(row.value.counter, 3, "the use commits its counter");
    assert!(row.value.last_used_at.is_some());
    assert_eq!(confirm(&known, 3), Err(crate::cause!(Unconfirmed::Unverified)), "a counter that does not advance is refused");
    assert_eq!(confirm(&known, 2), Err(crate::cause!(Unconfirmed::Unverified)));
    assert_eq!(confirm(&known, 4), Ok(()));
    assert!(passkeys::KnownPasskeys::new(shared, ACCOUNT, "https://trillion.example/path").is_none(), "an origin is exactly an origin");
}
