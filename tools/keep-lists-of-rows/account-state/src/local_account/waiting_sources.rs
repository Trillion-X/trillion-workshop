//! Concrete notification-device source for the original waiting composition.
//! The original standalone owner reads workshop_facts `tell-devices`, falling
//! back to `push-subscriptions` only for null/absence. This is not setting:<id>.
//! Use the selected account's existing bounded current snapshot, then finish it
//! before returning. No registry, device registration, scheduler or effect is
//! created. Device addresses are deliberately never copied into the answer.
use super::LocalAccount;
use crate::{
    ecma_json::{self, Object, Value},
    import::{ImportError, SqlValue},
    record_source::{BoundedRecordSql, Parameter as Sql, QueryBudget},
};
use std::{
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use zeroize::Zeroizing;
// Moved from src/waiting_hold.rs when the hold it computed moved to trillion-workshop
// tools/hold-one-thing-until-done; these sources still answer with the failure kinds they use.
#[derive(Clone, Debug)]
pub enum Kind {
    Bounds(crate::refusal_cause::Cause),
    Cancelled(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
}
impl Kind {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Bounds(cause) => cause.clone(),
            Self::Cancelled(cause) => cause.clone(),
            Self::Source(cause) => cause.clone(),
        }
    }
}

impl PartialEq for Kind {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::Bounds(_),Self::Bounds(_)) => true,
            (Self::Cancelled(_),Self::Cancelled(_)) => true,
            (Self::Source(_),Self::Source(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Kind {}

#[derive(Clone)]
pub struct Failure {
    pub cause: crate::refusal_cause::Cause,
    pub kind: Kind,
}
impl Failure {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
}
crate::impl_caused!(Failure);
crate::impl_caused!(Kind);
impl fmt::Debug for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HoldFailure")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Waiting hold calculation refused")
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
const MAX_BYTES: usize = 4 * 1024 * 1024;
const FACT: &str = "SELECT value FROM main.workshop_facts WHERE entity=? ORDER BY seq DESC LIMIT 1";
type Result<T> = std::result::Result<T, Failure>;
fn fail(kind: Kind) -> Failure {
    Failure { cause: kind.cause(), kind }
}
fn check(cancel: &AtomicBool, deadline: Instant) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        return Err(fail(crate::cause!(Kind::Cancelled)));
    }
    if Instant::now() >= deadline {
        return Err(fail(crate::cause!(Kind::Bounds)));
    }
    Ok(())
}
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    if let Value::Object(o) = value {
        o.get(&key.into())
    } else {
        None
    }
}
fn object(items: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut o = Object::new();
    for (k, v) in items {
        o.insert(k.into(), v);
    }
    Value::Object(o)
}
fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => *v != 0.0 && !v.is_nan(),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn point(
    source: &mut impl BoundedRecordSql,
    key: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<Option<Value>> {
    check(cancel, deadline)?;
    let answer = source
        .query_with_budget(
            FACT,
            &[Sql::Text(key.into())],
            QueryBudget {
                rows: 1,
                source_bytes: MAX_BYTES,
                deadline,
            },
        )
        .map_err(|e| {
            fail(if matches!(&e, ImportError::Budget(_, _)) {
                Kind::Bounds(e.cause())
            } else {
                Kind::Source(e.cause())
            })
        })?;
    check(cancel, deadline)?;
    if answer.columns != ["value"] || answer.rows.len() > 1 {
        return Err(fail(crate::cause!(Kind::Source)));
    }
    let Some(row) = answer.rows.first() else {
        return Ok(None);
    };
    let [SqlValue::Text(bytes)] = row.as_slice() else {
        return Err(fail(crate::cause!(Kind::Source)));
    };
    if bytes.len() > MAX_BYTES {
        return Err(fail(crate::cause!(Kind::Bounds)));
    }
    let value = ecma_json::parse(bytes, Default::default()).map_err(|error| fail(Kind::Source(error.cause())))?;
    Ok(if matches!(value, Value::Null) {
        None
    } else {
        Some(value)
    })
}
/// The original tell-devices.listed whitelist. Unknown source fields and all
/// addresses remain private. Optional fields retain JS truthiness semantics.
fn listed(value: &Value) -> Result<Value> {
    let Value::Array(rows) = value else {
        return Ok(Value::Array(vec![]));
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if matches!(row, Value::Null) {
            return Err(fail(crate::cause!(Kind::Source)));
        }
        let mut item = Object::new();
        for key in ["device_id", "route", "label"] {
            if let Some(value) = get(row, key) {
                item.insert(key.into(), value.clone());
            }
        }
        for key in ["app", "environment", "can_show", "turn_on"] {
            if let Some(value) = get(row, key).filter(|v| truth(v)) {
                item.insert(key.into(), value.clone());
            }
        }
        if let Some(value) = get(row, "present").filter(|v| truth(v)) {
            item.insert("present".into(), value.clone());
            if let Some(value) = get(row, "present_at") {
                item.insert("present_at".into(), value.clone());
            }
        }
        if let Some(value) = get(row, "added_at") {
            item.insert("added_at".into(), value.clone());
        }
        out.push(Value::Object(item));
    }
    Ok(Value::Array(out))
}
/// Exact standalone legacy value model for well-formed retained subscriptions.
/// The endpoint identity is original databaseInputIdentity(string), raw BLAKE3
/// of ECMA JSON string bytes (no `1f:` prefix or alternate content grammar).
fn legacy(value: Value) -> Result<Value> {
    let Value::Array(rows) = value else {
        return Err(fail(crate::cause!(Kind::Source)));
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let endpoint = get(&row, "endpoint").ok_or_else(|| fail(crate::cause!(Kind::Source)))?;
        if !matches!(endpoint, Value::String(_)) {
            return Err(fail(crate::cause!(Kind::Source)));
        }
        let id = if let Some(id) = get(&row, "device_id").filter(|v| !matches!(v, Value::Null)) {
            id.clone()
        } else {
            let encoded = Zeroizing::new(
                ecma_json::stringify(endpoint, Default::default())
                    .map_err(|error| fail(crate::carry_cause!(Kind::Source, error)))?,
            );
            Value::String(
                format!(
                    "legacy:{}",
                    content_crypto::advanced::blake3::hash(encoded.as_bytes()).to_hex()
                )
                .into(),
            )
        };
        let mut item = Object::new();
        item.insert("device_id".into(), id);
        item.insert("route".into(), Value::String("web-push".into()));
        item.insert(
            "label".into(),
            get(&row, "label")
                .filter(|v| !matches!(v, Value::Null))
                .cloned()
                .unwrap_or_else(|| Value::String("A browser".into())),
        );
        if let Some(value) = get(&row, "added_at") {
            item.insert("added_at".into(), value.clone());
        }
        out.push(Value::Object(item));
    }
    Ok(Value::Array(out))
}
fn read_devices(
    source: &mut impl BoundedRecordSql,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<Value> {
    let value = match point(source, "tell-devices", cancel, deadline)? {
        Some(value) => listed(&value)?,
        None => match point(source, "push-subscriptions", cancel, deadline)? {
            Some(value) => legacy(value)?,
            None => Value::Array(vec![]),
        },
    };
    check(cancel, deadline)?;
    Ok(object([("devices", value)]))
}
impl LocalAccount {
}

#[cfg(test)]
mod controls {
    use super::*;
    use crate::{
        import::ReadLimits,
        record_source::SnapshotRecordSql,
        sqlite_work::{ObservedConnection, WorkMeter},
    };
    use rusqlite::{Connection, OpenFlags};
    use std::time::Duration;
    fn v(s: &str) -> Value {
        ecma_json::parse(s.as_bytes(), Default::default()).unwrap()
    }
    struct Fixture {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new(prefill: impl FnOnce(&Connection)) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("records.sqlite");
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY,entity TEXT NOT NULL,value TEXT NOT NULL);CREATE INDEX facts_current ON workshop_facts(entity,seq)").unwrap();
            prefill(&db);
            drop(db);
            Self { _dir: dir, path }
        }
        fn source(
            &self,
            cancel: Arc<AtomicBool>,
            meter: WorkMeter,
        ) -> SnapshotRecordSql<impl FnMut() -> crate::import::ImportResult<()>> {
            let db = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .unwrap();
            // SAFETY: fresh fixture connection, no existing trace owner.
            let db = unsafe { ObservedConnection::attach_untraced(db, meter) }.unwrap();
            SnapshotRecordSql::begin(db, ReadLimits::default(), || Ok(()), cancel).unwrap()
        }
    }
    fn put(db: &Connection, key: &str, raw: &str) {
        db.execute(
            "INSERT INTO workshop_facts(entity,value) VALUES(?,?)",
            [key, raw],
        )
        .unwrap();
    }
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }
    #[test]
    fn latest_actual_device_point_keeps_public_fields_and_never_returns_addresses() {
        let f = Fixture::new(|db| {
            put(db, "tell-devices", r#"[{"device_id":"old","label":"Old"}]"#);
            put(
                db,
                "tell-devices",
                r#"[{"device_id":"new","route":"mac","label":"Mac","address":{"token":"private-address-sentinel"},"keys":"private-key-sentinel","can_show":"no","turn_on":"x-apple.systempreferences:notifications","present":"here","present_at":"now","app":"","environment":"prod","added_at":"today"}]"#,
            );
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let meter = WorkMeter::new();
        let mut source = f.source(cancel.clone(), meter.clone());
        let before = meter.snapshot().unwrap().work;
        let out = read_devices(&mut source, &cancel, deadline()).unwrap();
        let after = meter.snapshot().unwrap().work;
        assert_eq!(
            (
                after.sql_statements - before.sql_statements,
                after.sqlite_scan_visits - before.sqlite_scan_visits,
                after.rows_written - before.rows_written
            ),
            (1, 1, 0)
        );
        assert_eq!(
            out,
            v(
                r#"{"devices":[{"device_id":"new","route":"mac","label":"Mac","environment":"prod","can_show":"no","turn_on":"x-apple.systempreferences:notifications","present":"here","present_at":"now","added_at":"today"}]}"#
            )
        );
        let bytes = ecma_json::stringify(&out, Default::default()).unwrap();
        assert!(!bytes.contains("private-"));
        source.finish().unwrap();
    }
    #[test]
    fn legacy_subscription_has_original_stable_identity_and_hides_private_endpoint() {
        let endpoint = "https://example.test/push";
        let f = Fixture::new(|db| {
            put(
                db,
                "push-subscriptions",
                r#"[{"endpoint":"https://example.test/push","keys":{"auth":"private"},"added_at":"today"}]"#,
            )
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let meter = WorkMeter::new();
        let mut source = f.source(cancel.clone(), meter.clone());
        let before = meter.snapshot().unwrap().work;
        let out = read_devices(&mut source, &cancel, deadline()).unwrap();
        let after = meter.snapshot().unwrap().work;
        assert_eq!(after.sql_statements - before.sql_statements, 2);
        let encoded =
            ecma_json::stringify(&Value::String(endpoint.into()), Default::default()).unwrap();
        let id = format!(
            "legacy:{}",
            content_crypto::advanced::blake3::hash(encoded.as_bytes()).to_hex()
        );
        assert_eq!(
            out,
            object([(
                "devices",
                Value::Array(vec![object([
                    ("device_id", Value::String(id.into())),
                    ("route", Value::String("web-push".into())),
                    ("label", Value::String("A browser".into())),
                    ("added_at", Value::String("today".into()))
                ])])
            )])
        );
        assert!(!ecma_json::stringify(&out, Default::default())
            .unwrap()
            .contains(endpoint));
        source.finish().unwrap();
    }
    #[test]
    fn non_array_current_registry_does_not_fall_back_to_legacy_but_null_does() {
        for (raw, expected) in [("{}", 0), ("null", 1)] {
            let f = Fixture::new(|db| {
                put(db, "tell-devices", raw);
                put(
                    db,
                    "push-subscriptions",
                    r#"[{"device_id":"retained","endpoint":"https://example.test"}]"#,
                );
            });
            let cancel = Arc::new(AtomicBool::new(false));
            let mut source = f.source(cancel.clone(), WorkMeter::new());
            let out = read_devices(&mut source, &cancel, deadline()).unwrap();
            let Some(Value::Array(rows)) = get(&out, "devices") else {
                panic!("devices")
            };
            assert_eq!(rows.len(), expected);
            source.finish().unwrap();
        }
    }
    #[test]
    fn malformed_current_registry_refuses_instead_of_using_legacy_or_empty_success() {
        for raw in ["not-json", "[null]"] {
            let f = Fixture::new(|db| {
                put(db, "tell-devices", raw);
                put(db, "push-subscriptions", "[]");
            });
            let cancel = Arc::new(AtomicBool::new(false));
            let mut source = f.source(cancel.clone(), WorkMeter::new());
            assert_eq!(
                read_devices(&mut source, &cancel, deadline())
                    .unwrap_err()
                    .kind,
                crate::cause!(Kind::Source)
            );
        }
    }
    #[test]
    fn cancelled_or_expired_point_performs_no_query() {
        let f = Fixture::new(|db| put(db, "tell-devices", "[]"));
        let cancel = Arc::new(AtomicBool::new(false));
        let meter = WorkMeter::new();
        let mut source = f.source(cancel.clone(), meter.clone());
        let before = meter.snapshot().unwrap().work;
        cancel.store(true, Ordering::Release);
        assert_eq!(
            read_devices(&mut source, &cancel, deadline())
                .unwrap_err()
                .kind,
            crate::cause!(Kind::Cancelled)
        );
        cancel.store(false, Ordering::Release);
        assert_eq!(
            read_devices(&mut source, &cancel, Instant::now())
                .unwrap_err()
                .kind,
            crate::cause!(Kind::Bounds)
        );
        assert_eq!(
            meter.snapshot().unwrap().work.sql_statements,
            before.sql_statements
        );
    }
}
