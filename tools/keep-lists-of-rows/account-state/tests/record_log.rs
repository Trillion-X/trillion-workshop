//! Purpose: real compact journal + kept-runs + canonical stamp consumer checks.
//! Invariants: grouped/delta history, no-op recovery, atomic current admission,
//! rollback/restart cache validity and bounded multipart replay remain visible.
//! Security: fixture scope, model admission and serde value text are synthetic;
//! no original/provider execution or production JSON-byte-parity claim.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::cell::Cell;
use trillion_local::{
    kept_runs::Settings,
    record_log::{
        Admission, Context, Error, LogIds, Projected, RecordInput, RecordLog, Request, Scope,
        ValueText,
    },
};

struct Text;
impl ValueText for Text {
    fn encode(&self, value: &Value) -> Result<String, Error> {
        Ok(serde_json::to_string(value)?)
    }
}
struct Guard {
    checks: Cell<usize>,
    refuse: Option<usize>,
    model: bool,
}
impl Guard {
    fn live() -> Self {
        Self {
            checks: Cell::new(0),
            refuse: None,
            model: true,
        }
    }
}
impl Admission for Guard {
    fn assert_current(&self, scope: &Scope, _: &Request, _: &str) -> bool {
        let n = self.checks.get() + 1;
        self.checks.set(n);
        scope == &scope_value() && self.refuse != Some(n)
    }
    fn validate_prepared(
        &self,
        _: &Scope,
        _: &[RecordInput],
        _: &std::collections::BTreeMap<String, Option<Projected>>,
    ) -> bool {
        self.model
    }
}
struct Ids(u32);
impl LogIds for Ids {
    fn next_log_id(&mut self) -> Option<String> {
        self.0 += 1;
        Some(format!("{:08x}-0000-7000-8000-000000000000", self.0))
    }
}
fn scope_value() -> Scope {
    Scope {
        account: "fixture-account".into(),
        resource: "fixture-resource".into(),
    }
}
fn settings() -> Settings {
    Settings {
        memtable_bytes: 8 * 1024 * 1024,
        ..Settings::default()
    }
}
fn request(key: &str) -> Request {
    Request {
        key: key.into(),
        sent_at_ms: 1_000_000,
    }
}
fn context() -> Context {
    Context {
        actor: json!({"person":"fixture"}),
        application_time: "2026-10-25T20:00:00Z".into(),
        system_time: "2026-10-25T20:00:00Z".into(),
        accepted_at_ms: 1_000_000,
    }
}
fn record(id: &str, fields: &[(&str, Value)]) -> RecordInput {
    RecordInput {
        id: id.into(),
        record_type: "note".into(),
        value: Some(
            fields
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        ),
    }
}
fn create(path: &std::path::Path) -> RecordLog {
    RecordLog::create(Connection::open(path).unwrap(), scope_value(), settings()).unwrap()
}
fn reopen(path: &std::path::Path) -> RecordLog {
    RecordLog::reopen(Connection::open(path).unwrap(), scope_value(), settings()).unwrap()
}
fn log_count(path: &std::path::Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM record_log", [], |r| r.get(0))
        .unwrap()
}
fn history(path: &std::path::Path) -> Vec<Value> {
    let db = Connection::open(path).unwrap();
    let mut q = db
        .prepare("SELECT envelopes FROM record_log ORDER BY rowid")
        .unwrap();
    let texts: Vec<String> = q
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    texts
        .into_iter()
        .flat_map(|s| serde_json::from_str::<Vec<Value>>(&s).unwrap())
        .collect()
}

#[test]
fn group_is_one_journal_row_and_restart_reuses_original_request() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    let input = vec![
        record(
            "one",
            &[("title", json!("First")), ("nullable", Value::Null)],
        ),
        record("two", &[("done", json!(false))]),
    ];
    let first = store
        .write(
            &input,
            &request("group"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert_eq!(first.work.journal_rows_appended, 1);
    assert_eq!(first.receipt.written, ["one", "two"]);
    assert_eq!(log_count(&path), 1);
    let read = store.read("one", &request("read"), &guard, &Text).unwrap();
    assert_eq!(
        read.record.unwrap().kept.value.unwrap().get("nullable"),
        Some(&Value::Null)
    );
    drop(store);
    let mut store = reopen(&path);
    let retry = store
        .write(
            &input,
            &request("group"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.receipt, first.receipt);
    assert_eq!(retry.work.journal_rows_appended, 0);
    assert_eq!(log_count(&path), 1);
    let changed = vec![record("one", &[("title", json!("Different"))])];
    assert!(matches!(
        store.write(
            &changed,
            &request("group"),
            &context(),
            &guard,
            &Text,
            &mut ids
        ),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn delta_retains_was_added_and_prior_without_duplicate_record_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    store
        .write(
            &[record(
                "one",
                &[("title", json!("first")), ("old", json!(7))],
            )],
            &request("create"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    store
        .write(
            &[record(
                "one",
                &[("title", json!("second")), ("new", json!(true))],
            )],
            &request("edit"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    let log = history(&path);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0]["prior"], Value::Null);
    assert_eq!(log[1]["set"], json!({"title":"second","new":true}));
    assert_eq!(log[1]["unset"], json!(["old"]));
    assert_eq!(log[1]["was"], json!({"title":"first","old":7}));
    assert_eq!(log[1]["added"], json!(["new"]));
    let remove = RecordInput {
        id: "one".into(),
        record_type: "note".into(),
        value: None,
    };
    store
        .write(
            &[remove],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    let log = history(&path);
    assert_eq!(log[2]["remove"], true);
    assert_eq!(log[2]["prior"]["type"], "note");
    assert_eq!(log[2]["prior"]["value"]["title"], "second");
    let removed = store
        .read("one", &request("read"), &guard, &Text)
        .unwrap()
        .record
        .unwrap();
    assert!(removed.kept.record_type.is_none());
}

#[test]
fn no_op_has_one_request_row_no_business_envelopes_and_cold_retry_survives_later_change() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    let first = record("one", &[("title", json!("first"))]);
    store
        .write(
            std::slice::from_ref(&first),
            &request("create"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    let business_before = store
        .read("one", &request("read-before-no-op"), &guard, &Text)
        .unwrap()
        .record;
    let noop = store
        .write(
            std::slice::from_ref(&first),
            &request("no-op"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert_eq!(noop.work.journal_rows_appended, 1);
    assert_eq!(noop.work.request_only_rows_appended, 1);
    assert_eq!(noop.work.business_envelopes_appended, 0);
    assert_eq!(noop.work.sqlite_user_rows_changed, 1);
    assert_eq!(noop.work.checkpoint_user_rows_changed, 0);
    assert!(noop.receipt.written.is_empty());
    assert!(noop.receipt.log_id.is_none());
    assert_eq!(noop.work.flush_pages, 0);
    assert_eq!(log_count(&path), 2);
    assert_eq!(history(&path).len(), 1);
    assert_eq!(
        store
            .read("one", &request("read-after-no-op"), &guard, &Text)
            .unwrap()
            .record,
        business_before
    );
    store
        .write(
            &[record("one", &[("title", json!("later"))])],
            &request("later"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    drop(store);
    let mut store = reopen(&path);
    let retry = store
        .write(
            std::slice::from_ref(&first),
            &request("no-op"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(log_count(&path), 3);
    assert_eq!(retry.receipt, noop.receipt);
    assert_eq!(retry.work.sqlite_user_rows_changed, 0);
    let mut expired = context();
    expired.accepted_at_ms += 700_000;
    assert!(matches!(
        store.write(
            std::slice::from_ref(&first),
            &request("no-op"),
            &expired,
            &guard,
            &Text,
            &mut ids
        ),
        Err(Error::StaleRequest(_))
    ));
    assert_eq!(log_count(&path), 3);
    assert_eq!(
        store
            .read("one", &request("read"), &guard, &Text)
            .unwrap()
            .record
            .unwrap()
            .kept
            .value
            .unwrap()
            .get("title"),
        Some(&json!("later"))
    );
}

#[test]
fn no_op_does_not_flush_large_pending_projection_and_exposes_sqlite_row_costs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    let payload = "x".repeat(16 * 1024);
    let input: Vec<_> = (0..128)
        .map(|n| record(&format!("record-{n:03}"), &[("body", json!(payload))]))
        .collect();
    let prefill = store
        .write(
            &input,
            &request("prefill-pending"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(prefill.work.pending_memtable_bytes_after > 1024 * 1024);
    assert_eq!(prefill.work.flush_pages, 0);
    let db = Connection::open(&path).unwrap();
    let catalog_before: (i64, i64) = db
        .query_row(
            "SELECT(SELECT count(*)FROM record_keys_runs),(SELECT count(*)FROM record_keys_meta)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let journal_before = log_count(&path);
    let noop = store
        .write(
            &[input[0].clone()],
            &request("small-no-op"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(noop.work.pending_memtable_bytes_before > 1024 * 1024);
    assert!(noop.work.pending_memtable_bytes_after >= noop.work.pending_memtable_bytes_before);
    assert_eq!(noop.work.sqlite_user_rows_changed, 1);
    assert_eq!(noop.work.checkpoint_user_rows_changed, 0);
    assert_eq!(noop.work.request_only_rows_appended, 1);
    assert_eq!(noop.work.business_envelopes_appended, 0);
    assert_eq!(noop.work.flush_pages, 0);
    assert_eq!(noop.work.flush_keys, 0);
    assert_eq!(log_count(&path), journal_before + 1);
    let catalog_after: (i64, i64) = db
        .query_row(
            "SELECT(SELECT count(*)FROM record_keys_runs),(SELECT count(*)FROM record_keys_meta)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(catalog_after, catalog_before);
    let row: (String, i64, i64) = db
        .query_row(
            "SELECT envelopes,part,parts FROM record_log WHERE transaction_id='small-no-op'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("[]".into(), 0, 1));
    let warm = store
        .write(
            &[input[0].clone()],
            &request("small-no-op"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(warm.duplicate);
    assert_eq!(warm.receipt, noop.receipt);
    assert_eq!(warm.work.sqlite_user_rows_changed, 0);
    store
        .write(
            &[record("record-000", &[("body", json!("later"))])],
            &request("later-change"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    drop(store);
    let mut store = reopen(&path);
    let cold = store
        .write(
            &[input[0].clone()],
            &request("small-no-op"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(cold.duplicate);
    assert_eq!(cold.receipt, noop.receipt);
    assert_eq!(cold.work.sqlite_user_rows_changed, 0);
    let repeated = store
        .write(
            &[input[0].clone()],
            &request("small-no-op"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(repeated.duplicate);
    assert_eq!(repeated.work.sqlite_user_rows_changed, 0);
    let current = store
        .read("record-000", &request("read"), &guard, &Text)
        .unwrap()
        .record
        .unwrap();
    assert_eq!(
        current.kept.value.unwrap().get("body"),
        Some(&json!("later"))
    );
    let checkpoint = store.checkpoint_measured(&Text).unwrap();
    assert!(checkpoint.flush.pages > 0);
    assert!(checkpoint.sqlite_user_rows_changed > checkpoint.flush.pages as u64);
    eprintln!(
        "{}",
        json!({"case":"no_op_pending_projection","pending_bytes":noop.work.pending_memtable_bytes_before,"no_op_sqlite_user_rows":noop.work.sqlite_user_rows_changed,"no_op_checkpoint_user_rows":noop.work.checkpoint_user_rows_changed,"no_op_business_envelopes":noop.work.business_envelopes_appended,"warm_retry_sqlite_user_rows":warm.work.sqlite_user_rows_changed,"cold_retry_sqlite_user_rows":cold.work.sqlite_user_rows_changed,"checkpoint_sqlite_user_rows":checkpoint.sqlite_user_rows_changed,"checkpoint_payload_pages":checkpoint.flush.pages,"checkpoint_keys":checkpoint.flush.keys})
    );
}

#[test]
fn final_rights_refusal_rolls_back_request_only_row_and_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let live = Guard::live();
    let mut ids = Ids(0);
    let input = [record("one", &[("x", json!(1))])];
    store
        .write(&input, &request("prefill"), &context(), &live, &Text, &mut ids)
        .unwrap();
    let count = log_count(&path);
    let revoked = Guard {
        checks: Cell::new(0),
        refuse: Some(2),
        model: true,
    };
    assert!(matches!(
        store.write(
            &input,
            &request("refused-no-op"),
            &context(),
            &revoked,
            &Text,
            &mut ids
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!(log_count(&path), count);
    let accepted = store
        .write(
            &input,
            &request("refused-no-op"),
            &context(),
            &live,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(!accepted.duplicate);
    assert_eq!(accepted.work.request_only_rows_appended, 1);
    assert_eq!(accepted.work.business_envelopes_appended, 0);
    assert_eq!(log_count(&path), count + 1);
}

#[test]
fn final_rights_refusal_rolls_back_log_then_same_key_recovers_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let mut ids = Ids(0);
    let input = [record("one", &[("x", json!(1))])];
    let revoked = Guard {
        checks: Cell::new(0),
        refuse: Some(2),
        model: true,
    };
    assert!(matches!(
        store.write(
            &input,
            &request("key"),
            &context(),
            &revoked,
            &Text,
            &mut ids
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!(log_count(&path), 0);
    let live = Guard::live();
    assert!(store
        .read("one", &request("read"), &live, &Text)
        .unwrap()
        .record
        .is_none());
    let result = store
        .write(&input, &request("key"), &context(), &live, &Text, &mut ids)
        .unwrap();
    assert!(!result.duplicate);
    assert_eq!(log_count(&path), 1);
    let denied = Guard {
        checks: Cell::new(0),
        refuse: Some(2),
        model: true,
    };
    assert!(matches!(
        store.write(
            &input,
            &request("key"),
            &context(),
            &denied,
            &Text,
            &mut ids
        ),
        Err(Error::Refused(_))
    ));
}

#[test]
fn model_refusal_and_wrong_scope_are_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let mut ids = Ids(0);
    let refused = Guard {
        checks: Cell::new(0),
        refuse: None,
        model: false,
    };
    assert!(matches!(
        store.write(
            &[record("one", &[("x", json!(1))])],
            &request("key"),
            &context(),
            &refused,
            &Text,
            &mut ids
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!(log_count(&path), 0);
    drop(store);
    assert!(matches!(
        RecordLog::reopen(
            Connection::open(&path).unwrap(),
            Scope {
                account: "foreign".into(),
                resource: "fixture-resource".into()
            },
            settings()
        ),
        Err(Error::Refused(_))
    ));
}

#[test]
fn packed_checkpoint_keeps_field_order_and_detects_a_second_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut one = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    one.write(
        &[record("one", &[("zeta", json!(1)), ("alpha", json!(2))])],
        &request("first"),
        &context(),
        &guard,
        &Text,
        &mut ids,
    )
    .unwrap();
    one.checkpoint(&Text).unwrap();
    let mut two = reopen(&path);
    let fields = two
        .read("one", &request("read"), &guard, &Text)
        .unwrap()
        .record
        .unwrap()
        .kept
        .value
        .unwrap();
    assert_eq!(fields.keys().collect::<Vec<_>>(), ["zeta", "alpha"]);
    two.write(
        &[record("one", &[("zeta", json!(3)), ("alpha", json!(2))])],
        &request("second"),
        &context(),
        &guard,
        &Text,
        &mut ids,
    )
    .unwrap();
    assert_eq!(
        one.read("one", &request("read"), &guard, &Text)
            .unwrap()
            .record
            .unwrap()
            .kept
            .value
            .unwrap()
            .get("zeta"),
        Some(&json!(3))
    );
}

#[test]
fn multipart_journal_replay_refuses_incomplete_or_changed_parts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    let long = "🙂".repeat(180_000);
    let result = store
        .write(
            &[record("one", &[("text", json!(long))])],
            &request("large"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(result.work.journal_rows_appended > 1);
    drop(store);
    let mut intact = reopen(&path);
    assert!(intact
        .read("one", &request("read"), &guard, &Text)
        .unwrap()
        .record
        .is_some());
    drop(intact);
    let db = Connection::open(&path).unwrap();
    db.execute(
        "DELETE FROM record_log WHERE rowid=(SELECT max(rowid) FROM record_log)",
        [],
    )
    .unwrap();
    drop(db);
    let mut broken = reopen(&path);
    assert!(broken.read("one", &request("read"), &guard, &Text).is_err());
}

#[test]
fn stale_original_timestamp_is_refused_instead_of_reexecuted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    let input = [record("one", &[("x", json!(1))])];
    store
        .write(&input, &request("key"), &context(), &guard, &Text, &mut ids)
        .unwrap();
    let mut later = context();
    later.accepted_at_ms += 700_000;
    assert!(matches!(
        store.write(&input, &request("key"), &later, &guard, &Text, &mut ids),
        Err(Error::StaleRequest(_))
    ));
    assert_eq!(log_count(&path), 1);
}

/// A removal whose reply was lost: the client knows only its request key and
/// the record id. Once the first attempt committed, the record and its kind
/// are gone, so the retry cannot repeat a kind it read.
fn removal(id: &str) -> RecordInput {
    RecordInput::remove(id)
}

#[test]
fn removal_retried_after_unknown_commit_returns_the_first_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let guard = Guard::live();
    let mut ids = Ids(0);
    store
        .write(
            &[record("one", &[("title", json!("first"))])],
            &request("create"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    // The first attempt was prepared while the record was live, so it named
    // the kind it read; it commits and then the process dies before the reply.
    let typed = RecordInput {
        id: "one".into(),
        record_type: "note".into(),
        value: None,
    };
    let first = store
        .write(
            &[typed],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert_eq!(first.receipt.written, ["one"]);
    drop(store);
    let mut store = reopen(&path);
    let rows = log_count(&path);
    let retry = store
        .write(
            &[removal("one")],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(retry.duplicate);
    assert_eq!(retry.receipt, first.receipt);
    assert_eq!(retry.work.journal_rows_appended, 0);
    assert_eq!(log_count(&path), rows);
    // Any kind label on a removal names the same change.
    let relabelled = RecordInput {
        id: "one".into(),
        record_type: "task".into(),
        value: None,
    };
    let again = store
        .write(
            &[relabelled],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.receipt, first.receipt);
    // The same key for a different change is still refused.
    assert!(matches!(
        store.write(
            &[removal("two")],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids
        ),
        Err(Error::Conflict(_))
    ));
    assert!(store
        .read("one", &request("read"), &guard, &Text)
        .unwrap()
        .record
        .and_then(|p| p.kept.record_type)
        .is_none());
}

#[test]
fn removal_rolled_back_then_retried_removes_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("records.sqlite");
    let mut store = create(&path);
    let mut ids = Ids(0);
    store
        .write(
            &[record("one", &[("title", json!("first"))])],
            &request("create"),
            &context(),
            &Guard::live(),
            &Text,
            &mut ids,
        )
        .unwrap();
    // The final rights check refuses after the journal row was appended, so
    // the whole transaction rolls back: no removal, no receipt.
    let refusing = Guard {
        checks: Cell::new(0),
        refuse: Some(2),
        model: true,
    };
    assert!(matches!(
        store.write(
            &[removal("one")],
            &request("delete"),
            &context(),
            &refusing,
            &Text,
            &mut ids
        ),
        Err(Error::Refused(_))
    ));
    assert_eq!(log_count(&path), 1);
    let guard = Guard::live();
    let retry = store
        .write(
            &[removal("one")],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(!retry.duplicate);
    assert_eq!(retry.receipt.written, ["one"]);
    let repeat = store
        .write(
            &[removal("one")],
            &request("delete"),
            &context(),
            &guard,
            &Text,
            &mut ids,
        )
        .unwrap();
    assert!(repeat.duplicate);
    assert_eq!(repeat.receipt, retry.receipt);
    let removals = history(&path)
        .into_iter()
        .filter(|e| e["remove"] == true)
        .count();
    assert_eq!(removals, 1);
}
