// Purpose: Exercise the canonical mutation stage on real synthetic SQLite.
// Invariants: no original-data reads, source adoption, credential issuance or
// remote gate substitutes. These controls do not qualify the separate drain,
// propagation, publication or physical-resource commit protocol.

#![cfg(unix)]
use content_crypto::advanced::blake3;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use trillion_local::{
    account::AccountIdentity,
    account_rights::{mutate_drained, CanonicalPolicyOwner, Change, Error, Result},
    storage::{
        sqlite::{self, Access},
        Read, Storage, Value as StoredValue,
    },
};
/// The canonical owner lends its writable policy handle to the storage boundary.
fn policy(connection: &Connection) -> sqlite::Supply<&Connection> {
    sqlite::lend(connection, "account_policy", Access::Write).unwrap()
}

const NOW: u64 = 1_790_000_000_000;
const UPDATE: &str = "synthetic-original-update";

// Component controls for canonical incarnation metadata. The production
// producer is LocalAccount::native_domain_authority, not this fixture witness.
mod native_incarnation_controls {
    use super::*;
    use trillion_local::{
        account_rights::resource_connection::{
            self as registration, NativeChange, NativeRegistrationOwner, NativeTransfer,
        },
        storage::record_store_resources::domains::Identity,
    };
    struct NativeWitness {
        source: Witness,
        request: String,
        identity: String,
        history: Identity,
        sealed: Option<NativeTransfer>,
    }
    impl NativeWitness {
        fn new(fixture: &Fixture, history: &Identity, change: &NativeChange) -> Self {
            Self {
                source: Witness::new(
                    &fixture.account,
                    &Change::Disconnect { at_ms: NOW },
                    &fixture.path,
                ),
                request: change.request_key().into(),
                identity: change.identity(history).unwrap(),
                history: history.clone(),
                sealed: None,
            }
        }
    }
    impl CanonicalPolicyOwner for NativeWitness {
        fn assert_current(&mut self, account: &AccountIdentity, store: &dyn Storage) -> Result<()> {
            self.source.assert_current(account, store)
        }
        fn assert_management_admission(
            &mut self,
            account: &AccountIdentity,
            request: &str,
            identity: &str,
        ) -> Result<()> {
            if *account != self.source.account
                || request != self.request
                || identity != self.identity
                || !self.source.admitted
            {
                return Err(trillion_local::cause!(Error::NotAuthorized));
            }
            Ok(())
        }
    }
    impl NativeRegistrationOwner for NativeWitness {
        fn assert_native_seal(
            &mut self,
            history: &Identity,
            transfer: &NativeTransfer,
        ) -> Result<()> {
            if *history != self.history
                || self.sealed.as_ref().is_none_or(|proof| {
                    proof.move_id != transfer.move_id
                        || proof.source_incarnation != transfer.source_incarnation
                        || proof.target_incarnation != transfer.target_incarnation
                })
            {
                return Err(trillion_local::cause!(Error::NotDrained));
            }
            Ok(())
        }
    }
    fn fixture() -> (Fixture, Identity) {
        let fixture = Fixture::new();
        put(&fixture.open(), "update", Value::Null);
        (
            fixture,
            Identity {
                id: "synthetic-history".into(),
                incarnation: "logical-lineage".into(),
                generation: 1,
            },
        )
    }
    fn change(
        fixture: &Fixture,
        history: &Identity,
        change: &NativeChange,
    ) -> registration::NativeRegistration {
        registration::native_change(
            &policy(&fixture.open()),
            &mut NativeWitness::new(fixture, history, change),
            &fixture.account,
            history,
            change,
        )
        .unwrap()
    }
    #[test]
    fn native_enrollment_is_exact_and_cannot_recreate_an_existing_authority() {
        let (fixture, history) = fixture();
        let enroll = NativeChange::Enroll {
            request_key: "enroll-original".into(),
        };
        let first = change(&fixture, &history, &enroll);
        assert_eq!(first, change(&fixture, &history, &enroll));
        let changed = NativeChange::Enroll {
            request_key: "enroll-other".into(),
        };
        let before = rows(&fixture.open());
        assert_eq!(
            registration::native_change(
                &policy(&fixture.open()),
                &mut NativeWitness::new(&fixture, &history, &changed),
                &fixture.account,
                &history,
                &changed
            ),
            Err(trillion_local::cause!(Error::SourceChanged))
        );
        assert_eq!(before, rows(&fixture.open()));
    }
    #[test]
    fn native_activation_requires_exact_seal_and_retains_retired_token_across_reopen() {
        let (fixture, history) = fixture();
        let initial = change(
            &fixture,
            &history,
            &NativeChange::Enroll {
                request_key: "enroll".into(),
            },
        );
        let prepare = NativeChange::Prepare {
            request_key: "prepare".into(),
            expected_revision: initial.revision,
            source_incarnation: initial.current_incarnation.clone(),
            move_id: "move-original".into(),
        };
        let staged = change(&fixture, &history, &prepare);
        assert_eq!(staged, change(&fixture, &history, &prepare));
        let activate = NativeChange::Activate {
            request_key: "activate".into(),
            expected_revision: staged.revision,
            move_id: "move-original".into(),
        };
        let before = rows(&fixture.open());
        let mut witness = NativeWitness::new(&fixture, &history, &activate);
        assert_eq!(
            registration::native_change(
                &policy(&fixture.open()),
                &mut witness,
                &fixture.account,
                &history,
                &activate
            ),
            Err(trillion_local::cause!(Error::NotDrained))
        );
        assert_eq!(before, rows(&fixture.open()));
        witness.sealed = staged.staged.clone();
        let active = registration::native_change(
            &policy(&fixture.open()),
            &mut witness,
            &fixture.account,
            &history,
            &activate,
        )
        .unwrap();
        assert_ne!(active.current_incarnation, initial.current_incarnation);
        assert!(active.staged.as_ref().unwrap().activated);
        assert_eq!(
            active.staged.as_ref().unwrap().source_incarnation,
            initial.current_incarnation
        );
        assert_eq!(
            active,
            registration::native_change(
                &policy(&fixture.open()),
                &mut witness,
                &fixture.account,
                &history,
                &activate
            )
            .unwrap()
        );
        let observed = registration::native_current(
            &policy(&fixture.open()),
            &mut witness,
            &fixture.account,
            &history,
        )
        .unwrap()
        .unwrap();
        assert_eq!(observed, active);
        let next = NativeChange::Prepare {
            request_key: "next-move".into(),
            expected_revision: active.revision,
            source_incarnation: active.current_incarnation,
            move_id: "move-next".into(),
        };
        assert!(change(&fixture, &history, &next).staged.is_some());
    }
    #[test]
    fn native_stale_revision_wrong_move_and_withdrawn_admission_never_mutate() {
        let (fixture, history) = fixture();
        let initial = change(
            &fixture,
            &history,
            &NativeChange::Enroll {
                request_key: "enroll".into(),
            },
        );
        let bad = NativeChange::Prepare {
            request_key: "prepare".into(),
            expected_revision: initial.revision + 1,
            source_incarnation: initial.current_incarnation.clone(),
            move_id: "move".into(),
        };
        let before = rows(&fixture.open());
        assert_eq!(
            registration::native_change(
                &policy(&fixture.open()),
                &mut NativeWitness::new(&fixture, &history, &bad),
                &fixture.account,
                &history,
                &bad
            ),
            Err(trillion_local::cause!(Error::SourceChanged))
        );
        let valid = NativeChange::Prepare {
            request_key: "prepare".into(),
            expected_revision: initial.revision,
            source_incarnation: initial.current_incarnation,
            move_id: "move".into(),
        };
        let mut withdrawn = NativeWitness::new(&fixture, &history, &valid);
        withdrawn.source.admitted = false;
        assert_eq!(
            registration::native_change(
                &policy(&fixture.open()),
                &mut withdrawn,
                &fixture.account,
                &history,
                &valid
            ),
            Err(trillion_local::cause!(Error::NotAuthorized))
        );
        assert_eq!(before, rows(&fixture.open()));
    }
}

struct Witness {
    account: AccountIdentity,
    policy: PathBuf,
    file_identity: (u64, u64),
    identity: String,
    admitted: bool,
    source_checks: usize,
    admission_checks: usize,
    change_source_on: Option<usize>,
    withdraw_on: Option<usize>,
}
impl Witness {
    fn new(account: &AccountIdentity, change: &Change, policy: &std::path::Path) -> Self {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(policy).unwrap();
        Self {
            account: account.clone(),
            policy: policy.into(),
            file_identity: (metadata.dev(), metadata.ino()),
            identity: change.identity().unwrap(),
            admitted: true,
            source_checks: 0,
            admission_checks: 0,
            change_source_on: None,
            withdraw_on: None,
        }
    }
}
impl CanonicalPolicyOwner for Witness {
    fn assert_current(&mut self, account: &AccountIdentity, policy: &dyn Storage) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        self.source_checks += 1;
        let metadata = fs::metadata(&self.policy).map_err(|_| trillion_local::cause!(Error::SourceChanged))?;
        if *account != self.account
            || self.change_source_on == Some(self.source_checks)
            || policy.location() != self.policy.to_str()
            || self.file_identity != (metadata.dev(), metadata.ino())
        {
            return Err(trillion_local::cause!(Error::SourceChanged));
        }
        Ok(())
    }
    fn assert_management_admission(
        &mut self,
        account: &AccountIdentity,
        update: &str,
        identity: &str,
    ) -> Result<()> {
        self.admission_checks += 1;
        if *account != self.account
            || update != UPDATE
            || identity != self.identity
            || !self.admitted
            || self.withdraw_on == Some(self.admission_checks)
        {
            return Err(trillion_local::cause!(Error::NotAuthorized));
        }
        Ok(())
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    path: PathBuf,
    account: AccountIdentity,
}
fn put(connection: &Connection, name: &str, value: Value) {
    connection.execute(
        "INSERT INTO policy_directory(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        params![name,value.to_string()],
    ).unwrap();
}
fn read(connection: &Connection, name: &str) -> Value {
    let value: String = connection
        .query_row(
            "SELECT value FROM policy_directory WHERE name=?",
            [name],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&value).unwrap()
}
fn rows(connection: &Connection) -> Vec<(String, String)> {
    connection
        .prepare("SELECT name,value FROM policy_directory ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(temp.path()).unwrap().join("policy.sqlite");
        let account = AccountIdentity {
            user_id: "synthetic-user".into(),
            owner_id: "a".repeat(64),
        };
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "CREATE TABLE policy_directory(name TEXT PRIMARY KEY,value TEXT NOT NULL);
             CREATE TABLE policy_gates(name TEXT PRIMARY KEY,sign_in TEXT NOT NULL,resource TEXT NOT NULL);
             INSERT INTO policy_gates VALUES('synthetic-gate','key:synthetic','@own-records');
             CREATE TABLE preserved_original(value TEXT NOT NULL);
             INSERT INTO preserved_original VALUES('unchanged');",
        ).unwrap();
        put(
            &connection,
            "policy-source",
            json!({"from":"fence","fenced_at":"synthetic-original-carry","missing":[]}),
        );
        put(
            &connection,
            "policy-source:account",
            json!({"lifecycle":{"browser_session_generation":4,"disconnected_at":null},"access":{"capabilities":["synthetic-access"]},"account_controls":{"owner_user_id":account.user_id,"unrelated":"preserved"},"future_field":{"x":1}}),
        );
        put(
            &connection,
            "policy-source:sign-in:key:synthetic",
            json!({"made":{"private":true,"spaces":[]},"ceiling":{"private":true,"spaces":"all"},"chosen":{"private":true,"spaces":[]},"idle_days":7,"last_used":"2026-09-20T00:00:00.000Z","future_field":"preserved"}),
        );
        put(&connection, "revision", json!(7));
        put(&connection, "update", json!(UPDATE));
        // This is the mutation-stage fixture, after the separate original
        // protocol has established drain completion; it does not simulate that
        // protocol's remote permits or claim its commit ordering is qualified.
        put(
            &connection,
            "update-progress",
            json!({"id":UPDATE,"phase":"drained","fence_cursor":"synthetic-gate","publish_cursor":"","future_progress":"preserved"}),
        );
        Self {
            _temp: temp,
            path,
            account,
        }
    }
    fn open(&self) -> Connection {
        Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .unwrap()
    }
    fn apply(&self, change: &Change) -> trillion_local::account_rights::Receipt {
        mutate_drained(
            &policy(&self.open()),
            &mut Witness::new(&self.account, change, &self.path),
            &self.account,
            UPDATE,
            change,
        )
        .unwrap()
    }
}

#[test]
fn revoke_uses_original_row_and_keeps_update_paused_with_atomic_retry_evidence() {
    let f = Fixture::new();
    let before = read(&f.open(), "policy-source:sign-in:key:synthetic");
    let change = Change::EndSignIn {
        sign_in: "key:synthetic".into(),
        at_ms: NOW,
    };
    let receipt = f.apply(&change);
    assert_eq!(receipt.result, json!({"ended":"key:synthetic"}));
    let connection = f.open();
    let mut expected = before;
    expected["ended_until_ms"] = json!(NOW + 86_400_000);
    assert_eq!(
        read(&connection, "policy-source:sign-in:key:synthetic"),
        expected
    );
    assert_eq!(read(&connection, "update"), UPDATE);
    assert_eq!(read(&connection, "revision"), 7);
    let progress = read(&connection, "update-progress");
    assert_eq!(progress["phase"], "drained");
    assert_eq!(progress["publish_cursor"], "");
    assert_eq!(progress["future_progress"], "preserved");
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM policy_gates", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let after = rows(&connection);
    let repeated = f.apply(&change);
    assert_eq!(repeated.change_identity, receipt.change_identity);
    assert_eq!(repeated.result, receipt.result);
    assert_eq!(rows(&connection), after);
}

#[test]
fn disconnect_preserves_account_parts_and_uses_original_iso_cutoff() {
    let f = Fixture::new();
    let mut expected = read(&f.open(), "policy-source:account");
    let result = f.apply(&Change::Disconnect { at_ms: NOW }).result;
    assert_eq!(result, "2026-09-21T14:13:20.000Z");
    expected["lifecycle"]["disconnected_at"] = result;
    assert_eq!(read(&f.open(), "policy-source:account"), expected);
    assert_eq!(read(&f.open(), "update"), UPDATE);
}

#[test]
fn browser_generation_advances_once_across_real_database_reopen() {
    let f = Fixture::new();
    assert_eq!(
        f.apply(&Change::EndBrowserSessions {
            expected_generation: 4
        })
        .result,
        5
    );
    assert_eq!(
        f.apply(&Change::EndBrowserSessions {
            expected_generation: 4
        })
        .result,
        5
    );
    assert_eq!(
        read(&f.open(), "policy-source:account")["lifecycle"]["browser_session_generation"],
        5
    );
    let change = Change::Disconnect { at_ms: NOW };
    let before = rows(&f.open());
    assert!(matches!(
        mutate_drained(
            &policy(&f.open()),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::DifferentChange(_))
    ));
    assert_eq!(rows(&f.open()), before);
}

#[test]
fn snapshots_incomplete_carries_and_another_accounts_parts_cannot_become_writer() {
    for case in [
        "snapshot-only",
        "missing-parts",
        "active-carry",
        "wrong-account",
        "unknown-source",
    ] {
        let f = Fixture::new();
        let connection = f.open();
        match case {
            "snapshot-only" => put(&connection, "policy-source", Value::Null),
            "missing-parts" => put(
                &connection,
                "policy-source",
                json!({"from":"fence","missing":["account"]}),
            ),
            "active-carry" => put(
                &connection,
                "policy-source-carry",
                json!("synthetic-incomplete-carry"),
            ),
            "wrong-account" => {
                let mut a = read(&connection, "policy-source:account");
                a["account_controls"]["owner_user_id"] = json!("another-user");
                put(&connection, "policy-source:account", a);
            }
            "unknown-source" => put(
                &connection,
                "policy-source",
                json!({"from":"snapshot","missing":[]}),
            ),
            _ => unreachable!(),
        }
        let before = rows(&connection);
        let change = Change::EndBrowserSessions {
            expected_generation: 4,
        };
        assert!(
            matches!(
                mutate_drained(
                    &policy(&connection),
                    &mut Witness::new(&f.account, &change, &f.path),
                    &f.account,
                    UPDATE,
                    &change
                ),
                Err(Error::NotCanonical(_))
            ),
            "{case}"
        );
        assert_eq!(rows(&connection), before, "{case}");
    }
}

#[test]
fn undrained_cancelled_foreign_or_partly_published_updates_cannot_mutate() {
    for case in [
        "fence",
        "cancel-preparation",
        "different-id",
        "partly-published",
        "erasure",
    ] {
        let f = Fixture::new();
        let connection = f.open();
        let mut progress = read(&connection, "update-progress");
        match case {
            "fence" | "cancel-preparation" => progress["phase"] = json!(case),
            "different-id" => progress["id"] = json!("another-update"),
            "partly-published" => progress["publish_cursor"] = json!("synthetic-gate"),
            "erasure" => put(
                &connection,
                "account-erasure-continuation",
                json!({"pending":true}),
            ),
            _ => unreachable!(),
        }
        put(&connection, "update-progress", progress);
        let before = rows(&connection);
        let change = Change::EndBrowserSessions {
            expected_generation: 4,
        };
        assert!(
            mutate_drained(
                &policy(&connection),
                &mut Witness::new(&f.account, &change, &f.path),
                &f.account,
                UPDATE,
                &change
            )
            .is_err(),
            "{case}"
        );
        assert_eq!(rows(&connection), before, "{case}");
    }
}

#[test]
fn management_or_source_withdrawal_before_commit_rolls_back_source_and_receipt() {
    for source in [false, true] {
        let f = Fixture::new();
        let connection = f.open();
        let before = rows(&connection);
        let change = Change::EndBrowserSessions {
            expected_generation: 4,
        };
        let mut witness = Witness::new(&f.account, &change, &f.path);
        if source {
            witness.change_source_on = Some(2);
        } else {
            witness.withdraw_on = Some(2);
        }
        assert!(mutate_drained(
            &policy(&connection),
            &mut witness,
            &f.account,
            UPDATE,
            &change
        )
        .is_err());
        assert_eq!(rows(&connection), before);
    }
}

#[test]
fn retry_disclosure_still_requires_current_management_admission() {
    let f = Fixture::new();
    let change = Change::EndBrowserSessions {
        expected_generation: 4,
    };
    f.apply(&change);
    let connection = f.open();
    let before = rows(&connection);
    let mut witness = Witness::new(&f.account, &change, &f.path);
    witness.withdraw_on = Some(2);
    assert!(matches!(
        mutate_drained(
            &policy(&connection),
            &mut witness,
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::NotAuthorized(_))
    ));
    assert_eq!(rows(&connection), before);
}

#[test]
fn stable_copy_with_equal_account_and_update_is_not_the_retained_policy_handle() {
    let f = Fixture::new();
    let copy = f.path.with_file_name("unadopted-copy.sqlite");
    fs::copy(&f.path, &copy).unwrap();
    let wrong = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    let before = rows(&wrong);
    let change = Change::EndBrowserSessions {
        expected_generation: 4,
    };
    assert!(matches!(
        mutate_drained(
            &policy(&wrong),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::SourceChanged(_))
    ));
    assert_eq!(rows(&wrong), before);
    assert_eq!(rows(&f.open()), before);
    assert_eq!(f.apply(&change).result, 5);
}

#[test]
fn same_identity_retry_refuses_forged_result_or_missing_committed_source_effect() {
    for change in [
        Change::EndBrowserSessions {
            expected_generation: 4,
        },
        Change::Disconnect { at_ms: NOW },
        Change::EndSignIn {
            sign_in: "key:synthetic".into(),
            at_ms: NOW,
        },
    ] {
        for alter_source in [false, true] {
            let f = Fixture::new();
            let receipt = f.apply(&change);
            let connection = f.open();
            if alter_source {
                match &change {
                    Change::EndBrowserSessions { .. } => {
                        let mut account = read(&connection, "policy-source:account");
                        account["lifecycle"]["browser_session_generation"] = json!(4);
                        put(&connection, "policy-source:account", account);
                    }
                    Change::Disconnect { .. } => {
                        let mut account = read(&connection, "policy-source:account");
                        account["lifecycle"]["disconnected_at"] = Value::Null;
                        put(&connection, "policy-source:account", account);
                    }
                    Change::EndSignIn { sign_in, .. } => {
                        let name = format!("policy-source:sign-in:{sign_in}");
                        let mut row = read(&connection, &name);
                        row.as_object_mut().unwrap().remove("ended_until_ms");
                        put(&connection, &name, row);
                    }
                }
            } else {
                let mut progress = read(&connection, "update-progress");
                assert_eq!(
                    progress["rights_change"]["change_identity"],
                    receipt.change_identity
                );
                progress["rights_change"]["result"] = json!({"forged":"success"});
                put(&connection, "update-progress", progress);
            }
            let before = rows(&connection);
            assert!(matches!(
                mutate_drained(
                    &policy(&connection),
                    &mut Witness::new(&f.account, &change, &f.path),
                    &f.account,
                    UPDATE,
                    &change
                ),
                Err(Error::SourceChanged(_))
            ));
            assert_eq!(rows(&connection), before);
        }
    }
}

#[test]
fn browser_receipt_cannot_claim_the_unchanged_generation_and_stale_before_refuses() {
    let f = Fixture::new();
    let change = Change::EndBrowserSessions {
        expected_generation: 4,
    };
    f.apply(&change);
    let connection = f.open();
    let mut account = read(&connection, "policy-source:account");
    account["lifecycle"]["browser_session_generation"] = json!(4);
    put(&connection, "policy-source:account", account);
    let mut progress = read(&connection, "update-progress");
    progress["rights_change"]["result"] = json!(4);
    put(&connection, "update-progress", progress);
    let before = rows(&connection);
    assert!(matches!(
        mutate_drained(
            &policy(&connection),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::SourceChanged(_))
    ));
    assert_eq!(rows(&connection), before);
    let fresh = Fixture::new();
    let stale = Change::EndBrowserSessions {
        expected_generation: 3,
    };
    assert!(matches!(
        mutate_drained(
            &policy(&fresh.open()),
            &mut Witness::new(&fresh.account, &stale, &fresh.path),
            &fresh.account,
            UPDATE,
            &stale
        ),
        Err(Error::SourceChanged(_))
    ));
    assert_eq!(
        read(&fresh.open(), "policy-source:account")["lifecycle"]["browser_session_generation"],
        4
    );
}

#[test]
fn malformed_change_or_backward_disconnect_never_weakens_existing_cutoff() {
    let f = Fixture::new();
    let connection = f.open();
    let mut account = read(&connection, "policy-source:account");
    account["lifecycle"]["disconnected_at"] = json!("2026-12-01T00:00:00.000Z");
    put(&connection, "policy-source:account", account);
    let before = rows(&connection);
    let change = Change::Disconnect { at_ms: NOW };
    assert!(mutate_drained(
        &policy(&connection),
        &mut Witness::new(&f.account, &change, &f.path),
        &f.account,
        UPDATE,
        &change
    )
    .is_err());
    assert_eq!(rows(&connection), before);
    assert!(Change::EndSignIn {
        sign_in: "".into(),
        at_ms: NOW
    }
    .identity()
    .is_err());
    assert!(Change::EndSignIn {
        sign_in: "key:synthetic".into(),
        at_ms: u64::MAX
    }
    .identity()
    .is_err());
}

#[test]
fn stale_accepted_time_cannot_shorten_an_existing_sign_in_revocation() {
    for field in ["ended_until_ms", "ended_until"] {
        let f = Fixture::new();
        let connection = f.open();
        let name = "policy-source:sign-in:key:synthetic";
        let mut row = read(&connection, name);
        row[field] = json!(NOW + 2 * 86_400_000);
        put(&connection, name, row);
        let before = rows(&connection);
        let change = Change::EndSignIn {
            sign_in: "key:synthetic".into(),
            at_ms: NOW,
        };
        assert!(matches!(
            mutate_drained(
                &policy(&connection),
                &mut Witness::new(&f.account, &change, &f.path),
                &f.account,
                UPDATE,
                &change
            ),
            Err(Error::Invalid(_))
        ));
        assert_eq!(rows(&connection), before);
    }
}

#[test]
fn readonly_and_already_transactional_handles_refuse_without_creating_another_store() {
    let f = Fixture::new();
    let connection =
        Connection::open_with_flags(&f.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let change = Change::EndBrowserSessions {
        expected_generation: 4,
    };
    assert!(matches!(
        mutate_drained(
            &policy(&connection),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::SourceChanged(_))
    ));
    drop(connection);
    let connection = f.open();
    connection.execute_batch("BEGIN").unwrap();
    assert!(matches!(
        mutate_drained(
            &policy(&connection),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::SourceChanged(_))
    ));
    connection.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        connection
            .query_row("SELECT value FROM preserved_original", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "unchanged"
    );
}

#[test]
fn oversized_policy_refuses_inside_sqlite_and_restores_callers_length_limit() {
    use rusqlite::limits::Limit;
    let f = Fixture::new();
    let connection = f.open();
    let configured = connection.limit(Limit::SQLITE_LIMIT_LENGTH);
    let mut account = read(&connection, "policy-source:account");
    account["future_field"] = json!("x".repeat(4 * 1024 * 1024));
    put(&connection, "policy-source:account", account);
    let change = Change::EndBrowserSessions {
        expected_generation: 4,
    };
    assert!(matches!(
        mutate_drained(
            &policy(&connection),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::Unavailable(_))
    ));
    assert_eq!(connection.limit(Limit::SQLITE_LIMIT_LENGTH), configured);
    assert_eq!(
        read(&connection, "policy-source:account")["lifecycle"]["browser_session_generation"],
        4
    );
    assert!(read(&connection, "update-progress")
        .get("rights_change")
        .is_none());
    let mut account = read(&connection, "policy-source:account");
    account["future_field"] = json!("x".repeat(8192));
    put(&connection, "policy-source:account", account);
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, 1024);
    assert!(matches!(
        mutate_drained(
            &policy(&connection),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::Unavailable(_))
    ));
    assert_eq!(
        connection.limit(Limit::SQLITE_LIMIT_LENGTH),
        1024,
        "do not widen a caller's smaller limit"
    );
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, configured);
    let mut account = read(&connection, "policy-source:account");
    account["future_field"] = json!({"x":1});
    put(&connection, "policy-source:account", account);
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, 1024);
    assert_eq!(
        mutate_drained(
            &policy(&connection),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &change
        )
        .unwrap()
        .result,
        5
    );
    assert_eq!(connection.limit(Limit::SQLITE_LIMIT_LENGTH), 1024);
}

#[cfg(unix)]
#[test]
fn restored_named_policy_cannot_hide_a_different_writable_sqlite_handle() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    let root = f.path.parent().unwrap();
    let selected = root.join("selected");
    let replacement = root.join("replacement");
    let held = root.join("held");
    fs::create_dir(&selected).unwrap();
    fs::create_dir(&replacement).unwrap();
    let path = selected.join("policy.sqlite");
    let other = replacement.join("policy.sqlite");
    fs::copy(&f.path, &path).unwrap();
    fs::copy(&f.path, &other).unwrap();
    let connection = Connection::open(&other).unwrap();
    let mut account = read(&connection, "policy-source:account");
    account["lifecycle"]["browser_session_generation"] = json!(40);
    put(&connection, "policy-source:account", account);
    drop(connection);
    let stamp = |p: &std::path::Path| {
        let m = fs::metadata(p).unwrap();
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    let original_stamp = stamp(&path);
    let original_pin = blake3::hash(&fs::read(&path).unwrap());
    let other_pin = blake3::hash(&fs::read(&other).unwrap());
    fs::rename(&selected, &held).unwrap();
    fs::rename(&replacement, &selected).unwrap();
    let wrong = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    assert_eq!(
        read(&wrong, "policy-source:account")["lifecycle"]["browser_session_generation"],
        40
    );
    fs::rename(&selected, &replacement).unwrap();
    fs::rename(&held, &selected).unwrap();
    assert_eq!(stamp(&path), original_stamp);
    let change = Change::EndBrowserSessions {
        expected_generation: 4,
    };
    assert!(matches!(
        mutate_drained(
            &policy(&wrong),
            &mut Witness::new(&f.account, &change, &path),
            &f.account,
            UPDATE,
            &change
        ),
        Err(Error::SourceChanged(_))
    ));
    assert_eq!(blake3::hash(&fs::read(&path).unwrap()), original_pin);
    assert_eq!(blake3::hash(&fs::read(&other).unwrap()), other_pin);
    drop(wrong);
    let correct = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    assert_eq!(
        mutate_drained(
            &policy(&correct),
            &mut Witness::new(&f.account, &change, &path),
            &f.account,
            UPDATE,
            &change
        )
        .unwrap()
        .result,
        5
    );
}

// Directory-stage host doubles below qualify actual durable SQLite transitions,
// not a Mac pause or physical-commit implementation. The separate concrete Mac
// owner and loopback integration remain required before distributed proof.
use trillion_local::account_rights::{
    begin_update, register_gate, resume_update, AckPhase, Acknowledgement, Gate,
    GateRegistrationOwner, HostStatus, PolicyHost, Registration, UpdateStep,
};

impl GateRegistrationOwner for Witness {
    fn assert_gate_registration(
        &mut self,
        account: &AccountIdentity,
        policy: &dyn Storage,
        _gate: &Gate,
        revision: u64,
    ) -> Result<()> {
        if *account != self.account
            || !self.admitted
            || stored(policy, "revision").as_u64() != Some(revision)
        {
            return Err(trillion_local::cause!(Error::NotAuthorized));
        }
        Ok(())
    }
}

/// A policy value read through the same storage boundary the owner was handed.
fn stored(policy: &dyn Storage, name: &str) -> Value {
    let mut row = policy
        .get(
            "policy_directory",
            &[StoredValue::from(name)],
            &[Read::whole("value")],
        )
        .unwrap()
        .unwrap();
    serde_json::from_str(row.take(0).as_text().unwrap()).unwrap()
}

fn update_fixture() -> (Fixture, Change, Vec<Gate>) {
    let f = Fixture::new();
    let connection = f.open();
    put(&connection, "update", Value::Null);
    put(&connection, "update-progress", Value::Null);
    put(
        &connection,
        "policy-source:quota",
        json!({"generation":"synthetic-quota-source","measured":[],"use_budgets":[],"spend_budgets":[]}),
    );
    connection.execute("DELETE FROM policy_gates", []).unwrap();
    let mut gates = vec![
        Gate::for_resource(&f.account, "key:synthetic", "@own-records").unwrap(),
        Gate::for_resource(&f.account, "grant:fixture", "@independent").unwrap(),
    ];
    gates.sort_by(|a, b| a.name.cmp(&b.name));
    for gate in &gates {
        connection
            .execute(
                "INSERT INTO policy_gates VALUES(?,?,?)",
                params![gate.name, gate.sign_in, gate.resource],
            )
            .unwrap();
    }
    (
        f,
        Change::EndBrowserSessions {
            expected_generation: 4,
        },
        gates,
    )
}

struct TraceHost {
    path: PathBuf,
    pause_pending: bool,
    publish_pending: bool,
    quota_publish_pending: bool,
    malformed: Option<&'static str>,
    calls: Vec<(AckPhase, Option<Gate>, u64, Option<Value>)>,
}
impl TraceHost {
    fn new(f: &Fixture) -> Self {
        Self {
            path: f.path.clone(),
            pause_pending: false,
            publish_pending: false,
            quota_publish_pending: false,
            malformed: None,
            calls: Vec::new(),
        }
    }
    fn ack(
        &mut self,
        account: &AccountIdentity,
        gate: Option<&Gate>,
        update: &str,
        revision: u64,
        phase: AckPhase,
        source: Option<&Value>,
    ) -> Result<HostStatus> {
        let connection =
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            read(&connection, "update"),
            update,
            "directory pause must precede every host effect"
        );
        self.calls
            .push((phase, gate.cloned(), revision, source.cloned()));
        if gate.is_some()
            && ((phase == AckPhase::Pause && self.pause_pending)
                || (phase == AckPhase::Publish && self.publish_pending))
            || gate.is_none() && phase == AckPhase::Publish && self.quota_publish_pending
        {
            return Ok(HostStatus::Pending);
        }
        let mut ack = Acknowledgement {
            owner_id: account.owner_id.clone(),
            gate_name: gate.map(|g| g.name.clone()),
            update: update.into(),
            directory_revision: revision,
            generation: "synthetic-actual-host-generation".into(),
            phase,
        };
        match self.malformed {
            Some("owner") => ack.owner_id = "b".repeat(64),
            Some("gate") => ack.gate_name = Some("another-gate".into()),
            Some("update") => ack.update = "another-update".into(),
            Some("revision") => ack.directory_revision += 1,
            Some("generation") => ack.generation.clear(),
            Some("phase") => {
                ack.phase = if phase == AckPhase::Pause {
                    AckPhase::Publish
                } else {
                    AckPhase::Pause
                }
            }
            _ => {}
        }
        Ok(HostStatus::Acknowledged(ack))
    }
}
impl PolicyHost for TraceHost {
    fn pause_quota(&mut self, a: &AccountIdentity, u: &str, r: u64) -> Result<HostStatus> {
        self.ack(a, None, u, r, AckPhase::Pause, None)
    }
    fn pause_gate(&mut self, a: &AccountIdentity, g: &Gate, u: &str, r: u64) -> Result<HostStatus> {
        self.ack(a, Some(g), u, r, AckPhase::Pause, None)
    }
    fn publish_gate(
        &mut self,
        a: &AccountIdentity,
        g: &Gate,
        u: &str,
        r: u64,
        s: &Value,
    ) -> Result<HostStatus> {
        self.ack(a, Some(g), u, r, AckPhase::Publish, Some(s))
    }
    fn publish_quota(
        &mut self,
        a: &AccountIdentity,
        u: &str,
        r: u64,
        s: &Value,
    ) -> Result<HostStatus> {
        self.ack(a, None, u, r, AckPhase::Publish, Some(s))
    }
}
fn begin(f: &Fixture, change: &Change) {
    assert!(matches!(
        begin_update(
            &policy(&f.open()),
            &mut Witness::new(&f.account, change, &f.path),
            &f.account,
            UPDATE,
            7,
            change
        )
        .unwrap(),
        UpdateStep::Advanced
    ));
}
fn advance(f: &Fixture, change: &Change, host: &mut TraceHost) -> UpdateStep {
    resume_update(
        &policy(&f.open()),
        &mut Witness::new(&f.account, change, &f.path),
        &f.account,
        UPDATE,
        host,
    )
    .unwrap()
}
fn complete(
    f: &Fixture,
    change: &Change,
    host: &mut TraceHost,
) -> trillion_local::account_rights::Receipt {
    for _ in 0..32 {
        match advance(f, change, host) {
            UpdateStep::Completed { revision, receipt } => {
                assert_eq!(revision, 8);
                return receipt;
            }
            UpdateStep::Advanced => {}
            UpdateStep::Pending => panic!("unexpected pending synthetic host"),
        }
    }
    panic!("directory failed to finish its finite synthetic cohort")
}

#[test]
fn update_persists_pause_and_offline_gate_remains_pending_without_source_mutation() {
    let (f, change, _) = update_fixture();
    begin(&f, &change);
    let mut host = TraceHost::new(&f);
    host.pause_pending = true;
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Advanced
    ));
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Pending
    ));
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Pending
    ));
    let connection = f.open();
    assert_eq!(read(&connection, "update"), UPDATE);
    assert_eq!(read(&connection, "revision"), 7);
    assert_eq!(read(&connection, "update-progress")["fence_cursor"], "");
    assert_eq!(
        read(&connection, "policy-source:account")["lifecycle"]["browser_session_generation"],
        4
    );
    host.pause_pending = false;
    assert_eq!(complete(&f, &change, &mut host).result, 5);
}

#[test]
fn completed_update_survives_reopen_without_replaying_mutation_or_host_effects() {
    let (f, change, gates) = update_fixture();
    begin(&f, &change);
    let mut host = TraceHost::new(&f);
    let receipt = complete(&f, &change, &mut host);
    assert_eq!(receipt.result, 5);
    let before = host.calls.len();
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Completed { revision: 8, .. }
    ));
    assert!(matches!(
        begin_update(
            &policy(&f.open()),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            7,
            &change
        )
        .unwrap(),
        UpdateStep::Completed { revision: 8, .. }
    ));
    assert_eq!(host.calls.len(), before);
    let connection = f.open();
    assert!(read(&connection, "update").is_null());
    assert!(read(&connection, "update-progress").is_null());
    assert_eq!(read(&connection, "revision"), 8);
    assert_eq!(
        read(&connection, "policy-source:account")["lifecycle"]["browser_session_generation"],
        5
    );
    let published = host
        .calls
        .iter()
        .filter(|(phase, gate, _, _)| *phase == AckPhase::Publish && gate.is_some())
        .collect::<Vec<_>>();
    assert_eq!(published.len(), gates.len());
    for (_, gate, revision, snapshot) in published {
        assert_eq!(*revision, 8);
        let source = snapshot.as_ref().unwrap();
        let gate = gate.as_ref().unwrap();
        assert_eq!(source["sign_ins"].as_object().unwrap().len(), 1);
        assert!(source["sign_ins"].get(&gate.sign_in).is_some());
        assert!(
            source.get("future_field").is_none(),
            "publication is the original narrow snapshot"
        );
    }
}

#[test]
fn missing_gate_publication_ack_retains_update_and_retries_do_not_advance_generation_again() {
    let (f, change, _) = update_fixture();
    begin(&f, &change);
    let mut host = TraceHost::new(&f);
    host.publish_pending = true;
    for _ in 0..8 {
        if matches!(advance(&f, &change, &mut host), UpdateStep::Pending) {
            break;
        }
    }
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Pending
    ));
    let connection = f.open();
    assert_eq!(
        read(&connection, "policy-source:account")["lifecycle"]["browser_session_generation"],
        5
    );
    assert_eq!(read(&connection, "update"), UPDATE);
    assert_eq!(read(&connection, "revision"), 7);
    assert_eq!(read(&connection, "update-progress")["publish_cursor"], "");
    host.publish_pending = false;
    assert_eq!(complete(&f, &change, &mut host).result, 5);
}

#[test]
fn quota_terminal_ack_is_required_after_all_gate_publications() {
    let (f, change, _) = update_fixture();
    begin(&f, &change);
    let mut host = TraceHost::new(&f);
    host.quota_publish_pending = true;
    for _ in 0..16 {
        if matches!(advance(&f, &change, &mut host), UpdateStep::Pending) {
            break;
        }
    }
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Pending
    ));
    let connection = f.open();
    assert_eq!(read(&connection, "update-progress")["phase"], "published");
    assert_eq!(
        read(&connection, "update-progress")["quota_published"],
        false
    );
    assert_eq!(read(&connection, "revision"), 7);
    assert_eq!(read(&connection, "update"), UPDATE);
    host.quota_publish_pending = false;
    complete(&f, &change, &mut host);
}

#[test]
fn acknowledgements_must_bind_original_owner_target_update_revision_generation_and_phase() {
    for field in ["owner", "gate", "update", "revision", "generation", "phase"] {
        let (f, change, _) = update_fixture();
        begin(&f, &change);
        let before = rows(&f.open());
        let mut host = TraceHost::new(&f);
        host.malformed = Some(field);
        assert!(
            matches!(
                resume_update(
                    &policy(&f.open()),
                    &mut Witness::new(&f.account, &change, &f.path),
                    &f.account,
                    UPDATE,
                    &mut host
                ),
                Err(Error::UpdateChanged(_))
            ),
            "{field}"
        );
        assert_eq!(rows(&f.open()), before, "{field}");
    }
}

#[test]
fn registration_cannot_enter_behind_a_pause_cursor_and_stale_registration_refuses() {
    let (f, change, _) = update_fixture();
    begin(&f, &change);
    let gate = Gate::for_resource(&f.account, "key:new-fixture", "@another-resource").unwrap();
    assert_eq!(
        register_gate(
            &policy(&f.open()),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            &gate,
            7
        )
        .unwrap(),
        Registration::Pending
    );
    assert_eq!(
        f.open()
            .query_row(
                "SELECT count(*) FROM policy_gates WHERE name=?",
                [&gate.name],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    complete(&f, &change, &mut TraceHost::new(&f));
    assert_eq!(
        register_gate(
            &policy(&f.open()),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            &gate,
            8
        )
        .unwrap(),
        Registration::Recorded { revision: 8 }
    );
    assert!(register_gate(
        &policy(&f.open()),
        &mut Witness::new(&f.account, &change, &f.path),
        &f.account,
        &gate,
        7
    )
    .is_err());
}

#[test]
fn unknown_existing_update_or_different_change_is_never_replaced() {
    let (f, change, _) = update_fixture();
    put(&f.open(), "update", json!(UPDATE));
    put(
        &f.open(),
        "update-progress",
        json!({"id":UPDATE,"phase":"fence","fence_cursor":""}),
    );
    let before = rows(&f.open());
    assert!(begin_update(
        &policy(&f.open()),
        &mut Witness::new(&f.account, &change, &f.path),
        &f.account,
        UPDATE,
        7,
        &change
    )
    .is_err());
    assert_eq!(rows(&f.open()), before);
    let (f, change, _) = update_fixture();
    begin(&f, &change);
    let before = rows(&f.open());
    let other = Change::Disconnect { at_ms: NOW };
    assert!(matches!(
        begin_update(
            &policy(&f.open()),
            &mut Witness::new(&f.account, &other, &f.path),
            &f.account,
            UPDATE,
            7,
            &other
        ),
        Err(Error::DifferentChange(_))
    ));
    assert_eq!(rows(&f.open()), before);
}

#[test]
fn corrupt_phase_cannot_skip_quota_gate_drain_or_publication_coverage() {
    for phase in ["drained", "published"] {
        let (f, change, _) = update_fixture();
        begin(&f, &change);
        let mut progress = read(&f.open(), "update-progress");
        progress["phase"] = json!(phase);
        put(&f.open(), "update-progress", progress);
        let before = rows(&f.open());
        let mut host = TraceHost::new(&f);
        assert!(matches!(
            resume_update(
                &policy(&f.open()),
                &mut Witness::new(&f.account, &change, &f.path),
                &f.account,
                UPDATE,
                &mut host
            ),
            Err(Error::NotDrained(_))
        ));
        assert_eq!(rows(&f.open()), before);
        assert!(host.calls.is_empty());
    }
}

#[test]
fn final_completion_refuses_a_changed_receipt_version_before_reporting_success() {
    let (f, change, _) = update_fixture();
    begin(&f, &change);
    let mut host = TraceHost::new(&f);
    host.quota_publish_pending = true;
    for _ in 0..16 {
        if matches!(advance(&f, &change, &mut host), UpdateStep::Pending) {
            break;
        }
    }
    assert_eq!(read(&f.open(), "update-progress")["phase"], "published");
    host.quota_publish_pending = false;
    assert!(matches!(
        advance(&f, &change, &mut host),
        UpdateStep::Advanced
    ));
    let mut progress = read(&f.open(), "update-progress");
    assert_eq!(progress["quota_published"], true);
    progress["rights_change"]["version"] = json!("unknown-receipt-version");
    put(&f.open(), "update-progress", progress);
    let before = rows(&f.open());
    let calls = host.calls.len();
    assert!(matches!(
        resume_update(
            &policy(&f.open()),
            &mut Witness::new(&f.account, &change, &f.path),
            &f.account,
            UPDATE,
            &mut host
        ),
        Err(Error::SourceChanged(_))
    ));
    assert_eq!(rows(&f.open()), before);
    assert_eq!(host.calls.len(), calls);
    assert_eq!(read(&f.open(), "update"), UPDATE);
    assert_eq!(read(&f.open(), "revision"), 7);
}
