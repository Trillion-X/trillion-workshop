//! The `workspace:write` effect on the workspace store (`crate::workspace_store`,
//! a record store resource lent from the caller's own IMMEDIATE command transaction).
//! Caller must hold the selected account's command transaction and current
//! browser/source check. This child opens no path or transaction and does not
//! mint a command, result, key, receipt, or screen revision.
//!
//! Each feature is the record store primitive that does its job:
//! - a write is one record store change, compare-and-set on the version read in this
//!   same transaction; the replaced version stays in record store history as its
//!   revision (no revision tables, counters, budget or turns);
//! - a refused identity condition keeps both sides as a conflict record
//!   (`workspace-conflict:<id>`, holding both branches): another record of the
//!   same store, resolved by a normal write of the kept branch;
//! - the conflict clock ticks from the store's scope stamp, the clock every
//!   change already moves (no clock table).
use super::workspace_write::{self as contract, Action, HybridClock, Policy, Write};
use crate::{
    ecma_json::{self, JsString, Object, Value},
    storage::record_store::stamp_ms,
    workspace_store::Workspace,
};
use std::collections::BTreeSet;

const CONFLICT_PREFIX: &str = "workspace-conflict:";
const CONFLICT_VALUE_BYTES: usize = contract::MAX_VALUE_UNITS * 4 + 8192;
const DEVICE: &str = "person-store";

#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    Changed(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Bounds(cause) => cause.clone(),
            Self::Changed(cause) => cause.clone(),
            Self::Invalid(cause) => cause.clone(),
            Self::Source(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) }
}
impl Eq for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Derived from the admitted command, never supplied by its JSON input.
pub struct WriteOrigin<'a> {
    pub author: Option<&'a str>,
    pub road: Option<&'a str>,
    pub permit_id: Option<&'a str>,
}

/// The effect's result. Who else must hear of the change reads the store's
/// scope stamp, which every committed change moves.
#[derive(Debug)]
pub struct Effect {
    pub result: Value,
}

fn obj(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut out = Object::new();
    for (name, value) in fields {
        out.insert(name.into(), value);
    }
    Value::Object(out)
}
fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    if let Value::Object(value) = value {
        value.get(&name.into())
    } else {
        None
    }
}
fn string(value: &Value) -> Result<JsString> {
    if let Value::String(value) = value {
        Ok(value.clone())
    } else {
        Err(crate::cause!(Error::Source))
    }
}
fn rust(value: &JsString) -> String {
    String::from_utf16_lossy(value.units())
}
fn encode(value: &Value) -> Result<String> {
    ecma_json::stringify(value, Default::default()).map_err(|error| Error::Bounds(error.cause()))
}
fn identity(value: &Value) -> Result<String> {
    contract::workspace_value_identity(value).map_err(|error| crate::carry_cause!(Error::Source, error))
}

/// The store and the command's retry identity: every change of one command
/// gets its own stable request key (`<permit>:<n>`).
pub struct Target<'w, 'db> {
    pub workspace: &'w mut Workspace<'db>,
    pub request: &'w str,
    changes: usize,
}
impl<'w, 'db> Target<'w, 'db> {
    pub fn new(workspace: &'w mut Workspace<'db>, request: &'w str) -> Self {
        Self { workspace, request, changes: 0 }
    }
    fn read(&self, label: &str) -> Result<(i64, Option<(String, Value)>)> {
        self.workspace.get(label).map_err(|error| Error::Source(error.cause()))
    }
    fn known(&self) -> Result<BTreeSet<String>> {
        self.workspace.labels(contract::MAX_LABELS).map_err(|kind| match kind {
            crate::workspace_store::Kind::Bounds(cause) => Error::Bounds(cause),
            kind => Error::Source(kind.cause()),
        })
    }
    /// The conflict clock's previous tick: the store's newest stamp.
    fn clock(&self) -> Result<HybridClock> {
        let stamp = self.workspace.stamp().map_err(|error| Error::Source(error.cause()))?;
        Ok(HybridClock { wall_ms: stamp_ms(stamp) as i64, logical: stamp & 0xFFFF, device_id: DEVICE.into() })
    }
    /// One compare-and-set change on the version read in this transaction.
    fn change(&mut self, label: &str, expected_version: i64, value: Option<&Value>) -> Result<()> {
        self.changes += 1;
        let key = format!("{}:{}", self.request, self.changes);
        self.workspace.change(label, expected_version, value, &key).map_err(|error| match error {
            crate::records::Error::Conflict(cause) => Error::Changed(cause),
            crate::records::Error::Invalid(_, cause) => Error::Bounds(cause),
            error => Error::Source(error.cause()),
        })?;
        Ok(())
    }
}

pub(super) fn conflict_label(id: &str) -> String {
    format!("{CONFLICT_PREFIX}{id}")
}
fn branch(found: bool, value: Option<&Value>) -> Result<Value> {
    let identity = value
        .map(identity)
        .transpose()?
        .unwrap_or_else(|| "missing".into());
    let mut fields = vec![
        ("found", Value::Bool(found)),
        ("identity", Value::String(identity.as_str().into())),
    ];
    if let Some(value) = value {
        fields.push(("value", value.clone()));
    }
    Ok(obj(fields))
}
fn make_conflict(
    address: &JsString,
    current: Option<&Value>,
    incoming: Option<&Value>,
    expected: Option<&JsString>,
    clock: &HybridClock,
) -> Result<Value> {
    let id = contract::conflict_id(address, current, incoming).map_err(|error| crate::carry_cause!(Error::Source, error))?;
    let current_branch = branch(current.is_some(), current)?;
    let incoming_branch = branch(incoming.is_some(), incoming)?;
    let current_id = rust(&string(
        field(&current_branch, "identity").ok_or(crate::cause!(Error::Source))?,
    )?);
    let incoming_id = rust(&string(
        field(&incoming_branch, "identity").ok_or(crate::cause!(Error::Source))?,
    )?);
    let mut branches = vec![
        (
            format!("{}:{current_id}", if current.is_some() { 1 } else { 0 }),
            current_branch,
        ),
        (
            format!("{}:{incoming_id}", if incoming.is_some() { 1 } else { 0 }),
            incoming_branch,
        ),
    ];
    branches.sort_by(|a, b| a.0.cmp(&b.0));
    branches.dedup_by(|a, b| a.0 == b.0);
    Ok(obj([
        ("id", Value::String(id.as_str().into())),
        ("address", Value::String(address.clone())),
        (
            "expected_identity",
            expected.map_or(Value::Null, |v| Value::String(v.clone())),
        ),
        (
            "current_identity",
            Value::String(current_id.as_str().into()),
        ),
        ("clock", clock_value(clock)),
        ("state", Value::String("open".into())),
        (
            "branches",
            Value::Array(branches.into_iter().map(|(_, b)| b).collect()),
        ),
    ]))
}
fn clock_value(clock: &HybridClock) -> Value {
    obj([
        ("wall_ms", Value::Number(clock.wall_ms as f64)),
        ("logical", Value::Number(clock.logical as f64)),
        ("device_id", Value::String(clock.device_id.as_str().into())),
    ])
}
fn conflict_clock(value: &Value) -> Result<HybridClock> {
    let clock = field(value, "clock").ok_or(crate::cause!(Error::Source))?;
    let number = |name| match field(clock, name) {
        Some(Value::Number(n))
            if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 =>
        {
            Ok(*n as i64)
        }
        _ => Err(crate::cause!(Error::Source)),
    };
    Ok(HybridClock {
        wall_ms: number("wall_ms")?,
        logical: number("logical")?,
        device_id: rust(&string(field(clock, "device_id").ok_or(crate::cause!(Error::Source))?)?),
    })
}
fn summary(conflict: &Value) -> Result<Value> {
    let id = field(conflict, "id").ok_or(crate::cause!(Error::Source))?.clone();
    let address = field(conflict, "address").ok_or(crate::cause!(Error::Source))?.clone();
    let current_identity = field(conflict, "current_identity").ok_or(crate::cause!(Error::Source))?;
    let branches = match field(conflict, "branches") {
        Some(Value::Array(branches)) => branches,
        _ => return Err(crate::cause!(Error::Source)),
    };
    let current = branches
        .iter()
        .find(|branch| field(branch, "identity") == Some(current_identity))
        .cloned()
        .unwrap_or_else(|| {
            obj([
                ("found", Value::Bool(false)),
                ("identity", Value::String("missing".into())),
            ])
        });
    Ok(obj([
        ("id", id),
        ("address", address),
        ("current", current),
    ]))
}
fn validate_conflict_size(value: &Value) -> Result<()> {
    if encode(value)?.len() > CONFLICT_VALUE_BYTES {
        return Err(crate::cause!(Error::Bounds));
    }
    Ok(())
}
/// Write a conflict record: compare-and-set on the version read now, so a
/// conflict record another change wrote meanwhile refuses this one.
fn save_conflict(target: &mut Target<'_, '_>, value: &Value) -> Result<()> {
    let id = rust(&string(field(value, "id").ok_or(crate::cause!(Error::Source))?)?);
    let label = conflict_label(&id);
    validate_conflict_size(value)?;
    let (version, _) = target.read(&label)?;
    target.change(&label, version, Some(value))
}

/// Run only after the command's begin returned Fresh. The caller owns exact
/// result capture and command completion on this same transaction.
pub fn execute_with_origin(
    target: &mut Target<'_, '_>,
    action: &Action,
    now_ms: i64,
    at: &str,
) -> Result<Effect> {
    match action {
        Action::Writes { writes, policy } => put(target, writes, *policy, now_ms),
        Action::Resolve {
            id,
            branch_identity,
        } => resolve(target, id, branch_identity, now_ms, at),
    }
}

fn put(target: &mut Target<'_, '_>, writes: &[Write], policy: Policy, now_ms: i64) -> Result<Effect> {
    let known = target.known()?;
    let rows: Vec<_> = writes
        .iter()
        .map(|write| {
            let label = rust(&write.address_label);
            let value = encode(&write.payload)?;
            Ok((write, label, value))
        })
        .collect::<Result<_>>()?;
    let all: BTreeSet<_> = known
        .iter()
        .cloned()
        .chain(rows.iter().map(|(_, label, _)| label.clone()))
        .collect();
    if all.len() > contract::MAX_LABELS {
        return Err(crate::cause!(Error::Bounds));
    }
    let mut next_clock = target.clock()?;
    let mut retry_conflicts = Vec::new();
    let mut prior_conflicts = Vec::new();
    // Source Maps retain first insertion order, including repeated labels.
    let mut queued: Vec<(String, Value)> = Vec::new();
    let mut refused = false;
    for (write, label, encoded) in &rows {
        let Some(expected) = &write.expected_identity else {
            continue;
        };
        let (_, stored) = target.read(label)?;
        let current = stored.as_ref().map(|(_, value)| value);
        let current_id = current.map(identity).transpose()?;
        if current_id.as_deref() == expected.as_ref().map(rust).as_deref() {
            continue;
        }
        if stored.as_ref().is_some_and(|(text, _)| text == encoded) {
            continue;
        }
        refused = true;
        if policy == Policy::Retry {
            retry_conflicts.push(obj([
                ("address", Value::String(write.address_label.clone())),
                ("current", branch(current.is_some(), current)?),
            ]));
            continue;
        }
        let zero = HybridClock {
            wall_ms: 0,
            logical: 0,
            device_id: DEVICE.into(),
        };
        let mut candidate = make_conflict(
            &write.address_label,
            current,
            Some(&write.payload),
            expected.as_ref(),
            &zero,
        )?;
        let id = rust(&string(field(&candidate, "id").ok_or(crate::cause!(Error::Source))?)?);
        let conflict_label = conflict_label(&id);
        if let (_, Some((_, prior))) = target.read(&conflict_label)? {
            prior_conflicts.push(prior.clone());
            if field(&prior, "state") == Some(&Value::String("resolved".into())) {
                let previous = conflict_clock(&prior)?;
                let tick = contract::tick_hybrid_clock(Some(&next_clock), Some(&previous), now_ms, DEVICE);
                next_clock = tick.clone();
                set_clock(&mut candidate, &tick)?;
                validate_conflict_size(&candidate)?;
                if let Some((_, value)) = queued.iter_mut().find(|(label, _)| label == &conflict_label) {
                    *value = candidate;
                } else {
                    queued.push((conflict_label, candidate));
                }
            }
        } else if !queued.iter().any(|(label, _)| label == &conflict_label) {
            let occupied = known.len()
                + queued
                    .iter()
                    .filter(|(label, _)| !known.contains(label))
                    .count();
            if occupied >= contract::MAX_LABELS {
                return Err(crate::cause!(Error::Bounds));
            }
            let tick = contract::tick_hybrid_clock(Some(&next_clock), None, now_ms, DEVICE);
            next_clock = tick.clone();
            set_clock(&mut candidate, &tick)?;
            validate_conflict_size(&candidate)?;
            queued.push((conflict_label, candidate));
        }
    }
    if refused {
        if policy == Policy::Retry {
            return Ok(Effect {
                result: obj([
                    ("written", Value::Number(0.0)),
                    ("conflicts", Value::Array(retry_conflicts)),
                ])
            });
        }
        for (_, value) in &queued {
            save_conflict(target, value)?;
        }
        let mut unique: Vec<(String, Value)> = Vec::new();
        for conflict in &prior_conflicts {
            let id = rust(&string(field(conflict, "id").ok_or(crate::cause!(Error::Source))?)?);
            if !unique.iter().any(|(prior, _)| prior == &id) {
                unique.push((id, conflict.clone()));
            }
        }
        for (_, value) in &queued {
            let id = rust(&string(field(value, "id").ok_or(crate::cause!(Error::Source))?)?);
            if let Some((_, held)) = unique.iter_mut().find(|(prior, _)| prior == &id) {
                *held = value.clone();
            } else {
                unique.push((id, value.clone()));
            }
        }
        let conflicts = unique
            .iter()
            .map(|(_, value)| summary(value))
            .collect::<Result<Vec<_>>>()?;
        return Ok(Effect {
            result: obj([
                ("written", Value::Number(0.0)),
                ("conflicts", Value::Array(conflicts)),
            ])
        });
    }
    for (write, label, value) in &rows {
        let (version, prior) = target.read(label)?;
        // An unchanged value is not a change: no version, no history row.
        if prior.as_ref().is_some_and(|(held, _)| held == value) {
            continue;
        }
        target.change(label, version, Some(&write.payload))?;
    }
    Ok(Effect {
        result: obj([("written", Value::Number(rows.len() as f64))]),
    })
}
fn set_clock(value: &mut Value, clock: &HybridClock) -> Result<()> {
    if let Value::Object(value) = value {
        value.insert("clock".into(), clock_value(clock));
        Ok(())
    } else {
        Err(crate::cause!(Error::Source))
    }
}

fn resolve(target: &mut Target<'_, '_>, id: &JsString, selected: &JsString, now_ms: i64, at: &str) -> Result<Effect> {
    let id = rust(id);
    let label = conflict_label(&id);
    let (conflict_version, held) = target.read(&label)?;
    let (_, mut conflict) = held.ok_or(crate::cause!(Error::Invalid))?;
    if field(&conflict, "state") != Some(&Value::String("open".into())) {
        return Err(crate::cause!(Error::Invalid));
    }
    let address = string(field(&conflict, "address").ok_or(crate::cause!(Error::Source))?)?;
    let address_text = rust(&address);
    let branches = match field(&conflict, "branches") {
        Some(Value::Array(branches)) => branches,
        _ => return Err(crate::cause!(Error::Source)),
    };
    let kept = branches
        .iter()
        .find(|b| field(b, "identity") == Some(&Value::String(selected.clone())))
        .ok_or(crate::cause!(Error::Invalid))?
        .clone();
    let original = branches
        .iter()
        .find(|b| field(b, "identity") != Some(&Value::String(selected.clone())));
    let original_id = original
        .filter(|b| field(b, "found") == Some(&Value::Bool(true)))
        .and_then(|b| field(b, "identity"))
        .map(string)
        .transpose()?;
    let (current_version, current) = target.read(&address_text)?;
    let current_id = current.as_ref().map(|(_, v)| identity(v)).transpose()?;
    let selected_found = field(&kept, "found") == Some(&Value::Bool(true));
    let selected_id = if selected_found {
        Some(rust(selected))
    } else {
        None
    };
    let is_current = current_id == selected_id;
    if !is_current && current_id != original_id.as_ref().map(rust) {
        let current_value = current.as_ref().map(|(_, v)| v);
        let incoming = if selected_found {
            Some(field(&kept, "value").ok_or(crate::cause!(Error::Source))?)
        } else {
            None
        };
        let zero = HybridClock {
            wall_ms: 0,
            logical: 0,
            device_id: DEVICE.into(),
        };
        let mut newer = make_conflict(
            &address,
            current_value,
            incoming,
            original_id.as_ref(),
            &zero,
        )?;
        let newer_id = rust(&string(field(&newer, "id").ok_or(crate::cause!(Error::Source))?)?);
        if target.read(&conflict_label(&newer_id))?.1.is_some() {
            return Ok(Effect {
                result: obj([
                    ("resolved", Value::Bool(false)),
                    ("conflict_id", Value::String(newer_id.as_str().into())),
                ])
            });
        }
        if target.known()?.len() >= contract::MAX_LABELS {
            return Err(crate::cause!(Error::Bounds));
        }
        let tick = contract::tick_hybrid_clock(
            Some(&target.clock()?),
            Some(&conflict_clock(&conflict)?),
            now_ms,
            DEVICE,
        );
        set_clock(&mut newer, &tick)?;
        save_conflict(target, &newer)?;
        return Ok(Effect {
            result: obj([
                ("resolved", Value::Bool(false)),
                ("conflict_id", Value::String(newer_id.as_str().into())),
            ])
        });
    }
    if selected_found && !is_current {
        let value = field(&kept, "value").ok_or(crate::cause!(Error::Source))?;
        target.change(&address_text, current_version, Some(value))?;
    } else if !selected_found && current.is_some() {
        target.change(&address_text, current_version, None)?;
    }
    let Value::Object(ref mut fields) = conflict else {
        return Err(crate::cause!(Error::Source));
    };
    fields.insert("state".into(), Value::String("resolved".into()));
    fields.insert(
        "resolution".into(),
        obj([
            ("branch_identity", Value::String(selected.clone())),
            ("at", Value::String(at.into())),
        ]),
    );
    target.change(&label, conflict_version, Some(&conflict))?;
    Ok(Effect {
        result: obj([
            ("resolved", Value::Bool(true)),
            ("address", Value::String(address)),
            ("kept", Value::String(selected.clone())),
        ]),
    })
}

/// The effect and its output custody on a real SQLite file holding the record store
/// families, through the same lent-handle path the native command uses.
#[cfg(test)]
mod tests {
    use super::super::{
        workspace_write::{self, parse_input, workspace_value_identity, Action},
        workspace_write_output as output,
    };
    use super::{conflict_label, execute_with_origin, Effect, Error, Target};
    use crate::{
        ecma_json::{self, Value},
        storage::sqlite::{self, Access, Spend},
        workspace_store::Workspace,
    };
    use crate::storage::sqlite::Connection;
    use std::time::Duration;
    use tempfile::TempDir;

    const ACCOUNT: &str = "owner-1";
    const BOARD_CONFLICT: &str = "1f:4afda7be02d707f78072a9ca4aa5a2ec9bbcdf8bbb03440a73448f4afdb28343";

    /// A RECORD_BOOK-like file holding the record store families, and a handle on it.
    struct Book {
        _dir: TempDir,
        db: Connection,
    }
    fn book() -> Book {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("book.sqlite");
        drop(
            sqlite::open_owned(
                &path,
                "record_store",
                sqlite::Bounds {
                    value_bytes: 64 * 1024 * 1024,
                    work: u64::MAX / 2,
                    deadline: Duration::MAX,
                    spend: Spend::EachOperation,
                    cancel: None,
                    busy: Duration::from_secs(5),
                },
            )
            .unwrap(),
        );
        let db = Connection::open(&path).unwrap();
        Book { _dir: dir, db }
    }
    fn json(text: &str) -> Value {
        ecma_json::parse(text.as_bytes(), Default::default()).unwrap()
    }
    fn text(value: &Value) -> String {
        ecma_json::stringify(value, Default::default()).unwrap()
    }
    fn execute(db: &Connection, action: &Action, now: i64) -> Result<Effect, Error> {
        let mut workspace = Workspace::lend(db, ACCOUNT, Access::Write).unwrap();
        let request = format!("permit-{now}");
        execute_with_origin(&mut Target::new(&mut workspace, &request), action, now, "2026-10-26T00:00:00.000Z")
    }
    fn run(db: &Connection, input: &str, now: i64) -> Value {
        execute(db, &parse_input(&json(input)).unwrap(), now).unwrap().result
    }
    fn held(db: &Connection, label: &str) -> (i64, Option<String>) {
        let (version, held) = Workspace::lend(db, ACCOUNT, Access::Read).unwrap().get(label).unwrap();
        (version, held.map(|(text, _)| text))
    }
    fn value(db: &Connection, label: &str) -> Option<String> {
        held(db, label).1
    }
    fn put(db: &Connection, label: &str, value: Option<&str>, key: &str) {
        let mut workspace = Workspace::lend(db, ACCOUNT, Access::Write).unwrap();
        let (version, _) = workspace.get(label).unwrap();
        workspace.change(label, version, value.map(json).as_ref(), key).unwrap();
    }
    fn stamp(db: &Connection) -> i64 {
        Workspace::lend(db, ACCOUNT, Access::Read).unwrap().stamp().unwrap()
    }
    fn conflicts(db: &Connection) -> usize {
        let labels = Workspace::lend(db, ACCOUNT, Access::Read).unwrap().labels(256).unwrap();
        labels.iter().filter(|label| label.starts_with(&conflict_label(""))).count()
    }
    /// A retry-policy conflict reply on `board` and its captured output witness.
    fn conflict_reply(db: &Connection) -> (Action, Value, output::Witness) {
        run(db, r#"{"writes":[{"address_label":"board","payload":1}]}"#, 100);
        let action = parse_input(&json(
            r#"{"writes":[{"address_label":"board","payload":2,"expected_identity":"old"}],"conflict_policy":"retry"}"#,
        ))
        .unwrap();
        let result = execute(db, &action, 101).unwrap().result;
        let witness = output::capture(db, ACCOUNT, &action, &result).unwrap();
        (action, result, witness)
    }

    #[test]
    fn write_is_one_version_and_an_unchanged_value_is_no_change() {
        let book = book();
        let first = run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#, 100);
        assert_eq!(text(&first), r#"{"written":1}"#);
        assert_eq!(held(&book.db, "board"), (1, Some(r#"{"a":1}"#.into())));
        let before = stamp(&book.db);
        let action = parse_input(&json(r#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#)).unwrap();
        let repeated = execute(&book.db, &action, 200).unwrap();
        assert_eq!(text(&repeated.result), r#"{"written":1}"#);
        assert_eq!(held(&book.db, "board").0, 1, "an unchanged value writes no version");
        assert_eq!(stamp(&book.db), before, "and does not move the store's stamp");
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":2}}]}"#, 300);
        assert_eq!(held(&book.db, "board"), (2, Some(r#"{"a":2}"#.into())), "version 1 is kept as history");
        assert!(stamp(&book.db) > before);
    }

    #[test]
    fn stored_text_keeps_original_key_order() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"z":1,"a":2}}]}"#, 100);
        assert_eq!(value(&book.db, "board").as_deref(), Some(r#"{"z":1,"a":2}"#));
    }

    #[test]
    fn stale_preserve_is_all_or_nothing_and_repeats_first_clock() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#, 100);
        let input = r#"{"writes":[{"address_label":"board","payload":{"a":2},"expected_identity":"stale"},{"address_label":"other","payload":1}],"conflict_policy":"preserve"}"#;
        let first = run(&book.db, input, 101);
        assert_eq!(value(&book.db, "other"), None);
        assert_eq!(value(&book.db, "board").as_deref(), Some(r#"{"a":1}"#));
        assert!(text(&first).contains(BOARD_CONFLICT));
        let held = value(&book.db, &conflict_label(BOARD_CONFLICT)).unwrap();
        let repeated = run(&book.db, input, 999);
        assert_eq!(text(&first), text(&repeated));
        assert_eq!(value(&book.db, &conflict_label(BOARD_CONFLICT)).unwrap(), held);
        assert_eq!(conflicts(&book.db), 1);
    }

    #[test]
    fn stale_retry_returns_current_without_creating_a_conflict() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#, 100);
        let reply = run(
            &book.db,
            r#"{"writes":[{"address_label":"board","payload":{"a":2},"expected_identity":"stale"},{"address_label":"other","payload":1}],"conflict_policy":"retry"}"#,
            101,
        );
        assert_eq!(value(&book.db, "other"), None);
        assert!(text(&reply).contains(r#""value":{"a":1}"#));
        assert_eq!(conflicts(&book.db), 0);
        let absent = run(&book.db, r#"{"writes":[{"address_label":"new","payload":3,"expected_identity":null}]}"#, 102);
        assert_eq!(text(&absent), r#"{"written":1}"#);
        let stale_missing = run(
            &book.db,
            r#"{"writes":[{"address_label":"new","payload":4,"expected_identity":null}],"conflict_policy":"retry"}"#,
            103,
        );
        assert!(text(&stale_missing).contains(r#""written":0"#));
    }

    #[test]
    fn resolve_selected_branch_and_refuse_closed_conflict() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#, 100);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":2},"expected_identity":"stale"}]}"#, 101);
        let branch = workspace_value_identity(&json(r#"{"a":2}"#)).unwrap();
        let input = format!(r#"{{"resolve_conflict":{{"id":"{BOARD_CONFLICT}","branch_identity":"{branch}"}}}}"#);
        let kept = run(&book.db, &input, 102);
        assert!(text(&kept).contains(r#""resolved":true"#));
        assert_eq!(value(&book.db, "board").as_deref(), Some(r#"{"a":2}"#));
        assert_eq!(execute(&book.db, &parse_input(&json(&input)).unwrap(), 103).unwrap_err(), crate::cause!(Error::Invalid));
    }

    #[test]
    fn newer_value_creates_a_second_conflict_instead_of_overwriting_it() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":1}}]}"#, 100);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":2},"expected_identity":"stale"}]}"#, 101);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":{"a":3}}]}"#, 102);
        let branch = workspace_value_identity(&json(r#"{"a":2}"#)).unwrap();
        let input = format!(r#"{{"resolve_conflict":{{"id":"{BOARD_CONFLICT}","branch_identity":"{branch}"}}}}"#);
        let reply = run(&book.db, &input, 103);
        assert!(text(&reply).contains(r#""resolved":false"#));
        assert_eq!(value(&book.db, "board").as_deref(), Some(r#"{"a":3}"#));
        assert_eq!(conflicts(&book.db), 2);
    }

    #[test]
    fn command_rollback_removes_effect_and_conflict_records() {
        let book = book();
        // The command's own IMMEDIATE transaction, as native holds it.
        book.db.execute("BEGIN IMMEDIATE", []).unwrap();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":1}]}"#, 100);
        assert_eq!(value(&book.db, "board").as_deref(), Some("1"));
        book.db.execute("ROLLBACK", []).unwrap();
        assert_eq!(value(&book.db, "board"), None);
        assert_eq!(stamp(&book.db), 0);
    }

    #[test]
    fn lone_surrogate_label_uses_original_node_sqlite_replacement() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"\ud800","payload":1}]}"#, 100);
        // node:sqlite binds the same JavaScript string as UTF-8 U+FFFD.
        assert_eq!(value(&book.db, "\u{FFFD}").as_deref(), Some("1"));
    }

    #[test]
    fn invalid_branch_leaves_open_conflict_untouched() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":1}]}"#, 100);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":2,"expected_identity":"old"}]}"#, 101);
        let id = workspace_write::conflict_id(&"board".into(), Some(&json("1")), Some(&json("2"))).unwrap();
        let label = conflict_label(&id);
        let before = held(&book.db, &label);
        let input = format!(r#"{{"resolve_conflict":{{"id":"{id}","branch_identity":"not-a-branch"}}}}"#);
        assert_eq!(execute(&book.db, &parse_input(&json(&input)).unwrap(), 102).unwrap_err(), crate::cause!(Error::Invalid));
        assert_eq!(held(&book.db, &label), before);
    }

    #[test]
    fn reopen_same_fork_advances_hybrid_clock() {
        let book = book();
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":1}]}"#, 100);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":2,"expected_identity":"old"}]}"#, 101);
        let id = workspace_write::conflict_id(&"board".into(), Some(&json("1")), Some(&json("2"))).unwrap();
        let clock = |db: &Connection| {
            let Value::Object(record) = json(&value(db, &conflict_label(&id)).unwrap()) else {
                panic!("conflict record");
            };
            let Some(Value::Object(clock)) = record.get(&"clock".into()) else {
                panic!("conflict clock");
            };
            let number = |name: &str| match clock.get(&name.into()) {
                Some(Value::Number(n)) => *n as i64,
                _ => panic!("clock field"),
            };
            (number("wall_ms"), number("logical"))
        };
        let before = clock(&book.db);
        let original = workspace_value_identity(&json("1")).unwrap();
        run(&book.db, &format!(r#"{{"resolve_conflict":{{"id":"{id}","branch_identity":"{original}"}}}}"#), 102);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":2,"expected_identity":"old"}]}"#, 103);
        assert!(clock(&book.db) > before);
    }

    #[test]
    fn distinct_label_quota_refuses_257th_write() {
        let book = book();
        for n in 0..256 {
            put(&book.db, &format!("label-{n}"), Some("0"), &format!("prefill-{n}"));
        }
        let action = parse_input(&json(r#"{"writes":[{"address_label":"extra","payload":1}]}"#)).unwrap();
        assert_eq!(execute(&book.db, &action, 100).unwrap_err(), crate::cause!(Error::Bounds));
        assert_eq!(value(&book.db, "extra"), None);
    }

    #[test]
    fn saved_conflict_output_rechecks_source_and_withholds_after_erase() {
        let book = book();
        let (_, result, witness) = conflict_reply(&book.db);
        let saved = output::Witness::from_value(&witness.value()).unwrap();
        output::verify_saved(&book.db, ACCOUNT, &result, &saved).unwrap();
        put(&book.db, "board", None, "erase");
        assert!(matches!(output::verify_saved(&book.db, ACCOUNT, &result, &saved).unwrap_err(), output::Error::Withdrawn(_)));
        // Restoring the identical value cannot revive the erased output.
        put(&book.db, "board", Some("1"), "restore");
        assert!(matches!(output::verify_saved(&book.db, ACCOUNT, &result, &saved).unwrap_err(), output::Error::Withdrawn(_)));
    }

    #[test]
    fn source_withdrawal_after_capture_refuses_final_output() {
        let book = book();
        let (action, result, witness) = conflict_reply(&book.db);
        let permit = output::final_output_permit_saved(&book.db, ACCOUNT, &result, &witness).unwrap();
        put(&book.db, "board", Some("3"), "edit");
        assert!(matches!(permit.assert_current(&book.db, &result).unwrap_err(), output::Error::Withdrawn(_)));
        assert!(matches!(output::verify(&book.db, ACCOUNT, &action, &result, &witness).unwrap_err(), output::Error::Withdrawn(_)));
    }

    #[test]
    fn count_only_output_keeps_original_reply_across_unrelated_workspace_edits() {
        let book = book();
        let action = parse_input(&json(r#"{"writes":[{"address_label":"board","payload":1}]}"#)).unwrap();
        let result = execute(&book.db, &action, 100).unwrap().result;
        let witness = output::capture(&book.db, ACCOUNT, &action, &result).unwrap();
        put(&book.db, "board", Some("2"), "edit");
        output::verify(&book.db, ACCOUNT, &action, &result, &witness).unwrap();
    }

    #[test]
    fn rolled_back_workspace_mutation_does_not_withdraw_committed_output() {
        let book = book();
        let (_, result, witness) = conflict_reply(&book.db);
        let before = stamp(&book.db);
        book.db.execute("BEGIN IMMEDIATE", []).unwrap();
        put(&book.db, "board", Some("3"), "edit");
        assert!(matches!(output::verify_saved(&book.db, ACCOUNT, &result, &witness).unwrap_err(), output::Error::Withdrawn(_)));
        book.db.execute("ROLLBACK", []).unwrap();
        assert_eq!(stamp(&book.db), before);
        output::verify_saved(&book.db, ACCOUNT, &result, &witness).unwrap();
    }

    #[test]
    fn final_output_permit_is_bound_to_the_selected_connection() {
        let book = book();
        let (_, result, witness) = conflict_reply(&book.db);
        let permit = output::final_output_permit_saved(&book.db, ACCOUNT, &result, &witness).unwrap();
        let other = Connection::open_in_memory().unwrap();
        assert!(matches!(permit.assert_current(&other, &result).unwrap_err(), output::Error::Withdrawn(_)));
        permit.assert_current(&book.db, &result).unwrap();
    }

    #[test]
    fn every_change_moves_the_stamp_and_an_unchanged_write_does_not() {
        let book = book();
        let start = stamp(&book.db);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":1}]}"#, 100);
        let written = stamp(&book.db);
        assert!(written > start);
        run(&book.db, r#"{"writes":[{"address_label":"board","payload":1}]}"#, 101);
        assert_eq!(stamp(&book.db), written);
        put(&book.db, "board", None, "delete");
        assert!(stamp(&book.db) > written);
    }

    #[test]
    fn unrelated_workspace_write_withdraws_saved_conflict_output() {
        let book = book();
        let (_, result, witness) = conflict_reply(&book.db);
        output::verify_saved(&book.db, ACCOUNT, &result, &witness).unwrap();
        put(&book.db, "unrelated", Some("1"), "unrelated");
        assert_eq!(value(&book.db, "board").as_deref(), Some("1"));
        assert!(matches!(output::verify_saved(&book.db, ACCOUNT, &result, &witness).unwrap_err(), output::Error::Withdrawn(_)));
    }

    #[test]
    fn saved_conflict_output_refuses_changed_result_words() {
        let book = book();
        let (_, result, witness) = conflict_reply(&book.db);
        let saved = output::Witness::from_value(&witness.value()).unwrap();
        output::verify_saved(&book.db, ACCOUNT, &result, &saved).unwrap();
        let changed = json(
            r#"{"written":0,"conflicts":[{"address":"board","current":{"found":true,"identity":"1f:forged","value":1}}]}"#,
        );
        assert!(matches!(output::verify_saved(&book.db, ACCOUNT, &changed, &saved).unwrap_err(), output::Error::Withdrawn(_)));
        output::verify_saved(&book.db, ACCOUNT, &result, &saved).unwrap();
    }

    #[test]
    fn witness_keeps_a_stamp_above_two_to_the_53_exactly() {
        let book = book();
        let (_, result, witness) = conflict_reply(&book.db);
        assert!(stamp(&book.db) > 1 << 53);
        let saved = output::Witness::from_value(&witness.value()).unwrap();
        assert_eq!(saved, witness);
        output::verify_saved(&book.db, ACCOUNT, &result, &saved).unwrap();
    }

    #[test]
    fn installed_scoped_write_contract_rejects_blank_scope() {
        let schema: serde_json::Value = serde_json::from_str(workspace_write::INPUT_SCHEMA).unwrap();
        assert_eq!(schema["properties"]["writes"]["items"]["properties"]["scope_id"]["type"], "string");
        assert!(parse_input(&json(
            r#"{"writes":[{"address_label":"screen-arrangement-of::review","payload":{"layout":1},"scope_id":"  "}]}"#,
        ))
        .is_err());
    }
}
