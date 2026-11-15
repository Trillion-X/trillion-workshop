//! The old trillion app as the record store migration reads it: the kept-run checkpoint in id
//! order, the journal rows past a position, the canonical reader's answer for
//! the ids those rows changed, and every record's field key. This is the only
//! code where the native account reads the old record tables, once, to fill record store
//! (`src/local_account/own_records.rs` drives it); the record store itself holds
//! no SQL. It also reads the old Worker's sealed per-person vault
//! (`secrets`) for the startup carry into the account's own vault
//! (`src/local_account/secrets_carry.rs`).
//!
//! Non-Negotiable Invariants:
//! - Reads only, on the caller's readonly snapshot (`SnapshotRecordSql` opened
//!   under the account's browser access check and file witness).
//! - The checkpoint decode is the canonical reader's own checkpoint step
//!   (`legacy_records::checkpoint`): the pointer array is `[type, sequence,
//!   value?, meta?, protected?]`; a value kept apart is the `r\0<type>\0<sequence>\0<id>`
//!   key; a null type or a tombstone is no record.
//! - A journal row names its changed records in its envelopes
//!   (`CanonicalHead::affected_ids`); a multipart row is refused rather than
//!   guessed, since the canonical reader alone assembles its parts.
//! - A record's key is the old key owner's answer (record-log-store.mjs
//!   keyInLog, erasable.mjs): the newest journal row naming it in its `keys`,
//!   else the checkpoint's `e\0<id>` root, else the `protected` entry of its
//!   `i\0<id>` pointer, each a `{"key": base64}` key object; with no key there,
//!   `record_erasable_keys` says erased (`erased_at`) or holds a 32-byte key.
//!   The checkpoint step reads the `e\0` roots of exactly the id interval its
//!   `i\0` page covered, so the two key prefixes of one id meet in one step.
//!
//! Key Concepts:
//! - Allowances: the largest the old readers accept, as the one-time migration
//!   tool (`examples/record_store_migrate.rs`) proved them on a 2.4 million record account.
//!
//! Security Considerations:
//! - Nothing here logs; values leave only as stored forms into record store, keys only
//!   as zeroized 32-byte buffers into the account's record store key records.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use crate::{
    ecma_json::JsString,
    import::{QueryRows, SqlValue},
    legacy_kept::{
        range::{RangeLimits, Request},
        Entry, LegacyKept, Limits, Refusal,
    },
    legacy_records::{current_head::CanonicalHead, Bounds, Engine, LegacyRecords, StoredRecord},
    record_source::BoundedRecordSql,
    records::Error,
    storage::record_store::legacy::refused,
};
use base64::{
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
    Engine as _,
};
use rusqlite::types::Value;
use serde_json::value::RawValue;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};

/// Rows that may hold field keys, each text and blob cell zeroized when dropped.
struct Sensitive(QueryRows);
impl Drop for Sensitive {
    fn drop(&mut self) {
        for cell in self.0.rows.iter_mut().flatten() {
            if let SqlValue::Text(bytes) | SqlValue::Blob(bytes) = cell {
                bytes.zeroize();
            }
        }
    }
}

/// One record's 32-byte field key.
pub(crate) type Key = Zeroizing<[u8; 32]>;

/// A key's text as the old trillion app keeps it: standard base64, padding optional, ASCII white space ignored.
fn decode_key(raw: &RawValue) -> Result<Key, Error> {
    let encoded = Zeroizing::new(serde_json::from_str::<String>(raw.get()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
    if encoded.len() > 128 {
        return Err(Error::Invalid("a kept field key is too long", crate::cause!()));
    }
    let clean: Zeroizing<Vec<u8>> =
        Zeroizing::new(encoded.bytes().filter(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 12)).collect());
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let decoded = Zeroizing::new(engine.decode(clean.as_slice()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
    let bytes: [u8; 32] = decoded.as_slice().try_into().map_err(|_| Error::Invalid("a kept field key is not 32 bytes", crate::cause!()))?;
    Ok(Zeroizing::new(bytes))
}
/// The key of a `{"key": base64}` key object; None for JSON null or a key object without a key.
fn holder(raw: &RawValue) -> Result<Option<Key>, Error> {
    if raw.get() == "null" {
        return Ok(None);
    }
    let object: BTreeMap<String, &RawValue> = serde_json::from_str(raw.get()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    object.get("key").map(|raw| decode_key(raw)).transpose()
}

/// The kept-run reader with the largest allowances the old reader accepts; its per-record value bound is the
/// canonical reader's own (`BOUNDS.bytes`), so no record the canonical reader answers is refused here.
pub(crate) fn kept() -> Result<LegacyKept, Error> {
    LegacyKept::new(Limits {
        statements: 65_536,
        rows: 131_072,
        source_bytes: 128 * 1024 * 1024,
        value_bytes: 32 * 1024 * 1024,
        elapsed: Duration::from_secs(30),
        ..Limits::default()
    })
    .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}
/// The range reader's largest allowances; a page whose records do not fit is asked again in halves.
const RANGES: RangeLimits = RangeLimits { entries: 1_000_000, pages: 65_536, held_bytes: 64 * 1024 * 1024, output_bytes: 32 * 1024 * 1024 };
/// The largest per-read allowance the canonical reader accepts.
fn bounds() -> Bounds {
    Bounds { statements: 4096, rows: 30_000, bytes: 32 * 1024 * 1024, elapsed: Duration::from_secs(30) }
}

/// The journal position the checkpoint covers (`record_keys_meta.covered.at`); 0 when the store has none.
pub(crate) fn covered<S: BoundedRecordSql>(source: &mut S) -> Result<i64, Error> {
    let rows = source
        .query("SELECT value FROM record_keys_meta WHERE key=? LIMIT 1", &[Value::Text("covered".into())])
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok(match rows.rows.first().and_then(|row| row.first()) {
        Some(SqlValue::Text(text)) => {
            let value: serde_json::Value = serde_json::from_slice(text).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            value.get("at").unwrap_or(&value).as_i64().unwrap_or(0)
        }
        _ => 0,
    })
}

/// Journal rows past a position: how many, the last rowid read, the ids they changed, and the keys they carry
/// (a later row's key for an id replaces an earlier one's). `keyed` is false for a journal written before the keys
/// column existed: its rows carry no keys, so a protected record they write has no known key.
pub(crate) struct Journal {
    pub rows: usize,
    pub last: i64,
    pub ids: BTreeSet<String>,
    pub keys: BTreeMap<String, Key>,
    pub keyed: bool,
}

/// At most `limit` journal rows with rowid above `after`, in order.
pub(crate) fn journal_after<S: BoundedRecordSql>(source: &mut S, after: i64, limit: usize) -> Result<Journal, Error> {
    // A journal written before the keys column existed holds no row keys; its rows read as keyless.
    let columns = source.query("PRAGMA table_info(record_log)", &[]).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let keyed = columns.rows.iter().any(|row| matches!(row.get(1), Some(SqlValue::Text(name)) if name.as_slice() == b"keys"));
    let page = source
        .query(
            if keyed {
                "SELECT rowid,parts,envelopes,keys FROM record_log WHERE rowid>? ORDER BY rowid LIMIT ?"
            } else {
                "SELECT rowid,parts,envelopes,NULL FROM record_log WHERE rowid>? ORDER BY rowid LIMIT ?"
            },
            &[Value::Integer(after), Value::Integer(i64::try_from(limit).map_err(|_| Error::Invalid("journal page", crate::cause!()))?)],
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let page = Sensitive(page);
    let mut journal = Journal { rows: 0, last: after, ids: BTreeSet::new(), keys: BTreeMap::new(), keyed };
    for row in &page.0.rows {
        let (Some(SqlValue::Integer(rowid)), Some(SqlValue::Integer(parts)), Some(SqlValue::Text(envelopes)), Some(keys)) =
            (row.first(), row.get(1), row.get(2), row.get(3))
        else {
            return Err(crate::cause!(Error::Unavailable));
        };
        if *parts != 1 {
            return Err(Error::Invalid("a multipart journal row needs the canonical replay", crate::cause!()));
        }
        let body = std::str::from_utf8(envelopes).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        journal.ids.extend(CanonicalHead::affected_ids(body).map_err(refused)?);
        match keys {
            SqlValue::Null => {}
            SqlValue::Text(text) => {
                let text = Zeroizing::new(std::str::from_utf8(text).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.to_owned());
                let named: BTreeMap<String, &RawValue> = serde_json::from_str(&text).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                for (id, raw) in named {
                    journal.keys.insert(id, decode_key(raw)?);
                }
            }
            _ => return Err(crate::cause!(Error::Unavailable)),
        }
        journal.last = *rowid;
        journal.rows += 1;
    }
    Ok(journal)
}

/// The old trillion app's workspace records (`workspace_records`: label -> the exact JSON text of its value) after `after`,
/// in label order: at most `limit` rows, and the last label when more may follow. None when the table does not exist.
/// A value that is not JSON refuses rather than being carried as text.
pub(crate) fn workspace_after<S: BoundedRecordSql>(
    source: &mut S,
    after: Option<&str>,
    limit: usize,
) -> Result<Option<WorkspacePage>, Error> {
    let present = source
        .query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workspace_records' LIMIT 1", &[])
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if present.rows.is_empty() {
        return Ok(None);
    }
    let page = source
        .query(
            "SELECT label,value FROM workspace_records WHERE label>? ORDER BY label LIMIT ?",
            &[
                Value::Text(after.unwrap_or_default().to_owned()),
                Value::Integer(i64::try_from(limit).map_err(|_| Error::Invalid("workspace page", crate::cause!()))?),
            ],
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let page = Sensitive(page);
    let mut rows = Vec::with_capacity(page.0.rows.len());
    for row in &page.0.rows {
        let (Some(SqlValue::Text(label)), Some(SqlValue::Text(value))) = (row.first(), row.get(1)) else {
            return Err(crate::cause!(Error::Unavailable));
        };
        let label = String::from_utf8(label.clone()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let value = String::from_utf8(value.clone()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        serde_json::from_str::<&RawValue>(&value).map_err(|_| Error::Invalid("a workspace record value is not JSON", crate::cause!()))?;
        rows.push((label, value));
    }
    let last = if rows.len() == limit { rows.last().map(|(label, _)| label.clone()) } else { None };
    Ok(Some(WorkspacePage { rows, last }))
}

/// One page of the old workspace records: (label, exact JSON text) rows, and the last label when more may follow.
pub(crate) struct WorkspacePage {
    pub rows: Vec<(String, String)>,
    pub last: Option<String>,
}

/// The most source bytes and the longest time one copied page may read.
const COPY_PAGE_BYTES: usize = 16 * 1024 * 1024;
const COPY_PAGE_TIME: Duration = Duration::from_secs(10);

/// One page of an old table the generic startup copy moves (`record_store_resources::Copy`): (record id, value) rows, and the
/// cursor to read after when more may follow.
pub(crate) struct RowsPage {
    pub rows: Vec<(String, serde_json::Value)>,
    pub last: Option<serde_json::Value>,
}

/// One storage cell as JSON; bytes, an unread field and a number JSON cannot hold refuse rather than being guessed.
fn cell_json(cell: crate::storage::Value) -> Result<serde_json::Value, Error> {
    use crate::storage::Value as Cell;
    Ok(match cell {
        Cell::Null => serde_json::Value::Null,
        Cell::Integer(n) => n.into(),
        Cell::Real(n) => serde_json::Number::from_f64(n).ok_or(Error::Invalid("a copied number is not finite", crate::cause!()))?.into(),
        Cell::Text(text) => text.into(),
        Cell::Blob(_) | Cell::Oversized(_) => return Err(Error::Invalid("a copied row holds bytes or an unread field", crate::cause!())),
    })
}

/// The JSON cell back as a storage cell, for a walk cursor.
fn json_cell(value: &serde_json::Value) -> Result<crate::storage::Value, Error> {
    use crate::storage::Value as Cell;
    match value {
        serde_json::Value::String(text) => Ok(Cell::Text(text.clone())),
        other => other.as_i64().map(Cell::Integer).ok_or(Error::Invalid("a copy position is not a cursor", crate::cause!())),
    }
}

/// An own-records sequence for a copied row written at `time` (`OwnRecord::time`: ISO 8601 text, a day as its start in
/// UTC, or milliseconds since 1970; None for a table that keeps no time, the start of 1970): the millisecond time in
/// the position a record log id puts it in (`record_log::sequence`), so copied records order by when they were written.
fn sequence_at(time: Option<&serde_json::Value>) -> Result<String, Error> {
    let ms = match time {
        None => 0,
        Some(serde_json::Value::String(text)) => match chrono::DateTime::parse_from_rfc3339(text) {
            Ok(at) => at.timestamp_millis(),
            Err(_) => chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .map_err(|_| Error::Invalid("a copied row's time is neither ISO 8601 nor a day", crate::cause!()))?
                .and_time(chrono::NaiveTime::MIN)
                .and_utc()
                .timestamp_millis(),
        },
        Some(serde_json::Value::Number(n)) => match (n.as_i64(), n.as_f64()) {
            (Some(ms), _) => ms,
            (None, Some(ms)) if ms.fract() == 0.0 => ms as i64,
            _ => return Err(Error::Invalid("a copied row's time is not whole milliseconds", crate::cause!())),
        },
        Some(_) => return Err(Error::Invalid("a copied record has no time", crate::cause!())),
    };
    let ms = u64::try_from(ms).map_err(|_| Error::Invalid("a copied row's time is before 1970", crate::cause!()))?;
    Ok(format!("{ms:012x}0000000"))
}

/// One part of a copied record's id: a text or integer field of the row.
fn id_part(value: &serde_json::Map<String, serde_json::Value>, field: &str) -> Result<String, Error> {
    match value.get(field) {
        Some(serde_json::Value::String(text)) => Ok(text.clone()),
        Some(serde_json::Value::Number(n)) if n.is_i64() => Ok(n.to_string()),
        _ => Err(Error::Invalid("a copied record has no id", crate::cause!())),
    }
}

/// At most `limit` rows of `copy`'s old family (src/storage/families.json), walked by its key or its declared order
/// after `after` (the `last` of the page before, the walked fields' values), read through the storage boundary on the
/// caller's snapshot. With `newest_per` the walk goes backward, so the first row of each value is its newest and
/// the rest are passed over; `skip` leaves rows out; `own_record` shapes each kept row as one of the account's own
/// records (`kind`, `sequence`, `stored`, `meta`, `protected`), else a row's id is its one key field and its value
/// every declared field. None when the table does not exist. A page may keep fewer rows than it walked.
pub(crate) fn rows_after<S: BoundedRecordSql>(
    source: &mut S,
    copy: &crate::storage::record_store_resources::Copy,
    after: Option<&serde_json::Value>,
    limit: usize,
) -> Result<Option<RowsPage>, Error> {
    use crate::storage::{Order, Range, Read, Storage};
    let declared = crate::storage::schema(&copy.schema).and_then(|schema| schema.family(&copy.family)).map_err(|error| Error::Invalid("copy family", error.cause()))?;
    let walked: &[String] = match &copy.order {
        Some(order) => &declared.order(order).map_err(|error| Error::Invalid("copy order", error.cause()))?.fields,
        None => &declared.key,
    };
    let budget = crate::record_source::QueryBudget { rows: limit, source_bytes: COPY_PAGE_BYTES, deadline: std::time::Instant::now() + COPY_PAGE_TIME };
    let store = crate::storage::sqlite::bounded::lend(source, &copy.schema, budget).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !store.present(&copy.family).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
        return Ok(None);
    }
    let mut range = match &copy.prefix {
        Some(prefix) => Range::prefix(prefix),
        None => Range::all(),
    };
    if let Some(order) = &copy.order {
        range = range.order(Order::Named(order));
    }
    if copy.newest_per.is_some() {
        range = range.reverse();
    }
    // The value `newest_per` names in the last row walked: its older rows on this page are passed over too.
    let mut current = None;
    if let Some(after) = after {
        let cursor = after.as_array().ok_or(Error::Invalid("a copy position is not a cursor", crate::cause!()))?;
        if cursor.len() != walked.len() {
            return Err(Error::Invalid("a copy position is not a cursor", crate::cause!()));
        }
        if copy.newest_per.is_some() {
            current = cursor.first().cloned();
        }
        range = range.after(cursor.iter().map(json_cell).collect::<Result<_, _>>()?);
    }
    let reads: Vec<Read<'_>> = declared.fields.iter().map(|field| Read::whole(field)).collect();
    let found = store.scan(&copy.family, &range.limit(limit), &reads).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let walked_rows = found.len();
    let (mut rows, mut last) = (Vec::new(), None);
    for row in found {
        let mut value = serde_json::Map::new();
        for (field, cell) in declared.fields.iter().zip(row.0) {
            value.insert(field.clone(), cell_json(cell)?);
        }
        let cursor: Vec<serde_json::Value> = walked.iter().map(|field| value.get(field).cloned().unwrap_or_default()).collect();
        last = Some(serde_json::Value::Array(cursor));
        if let Some(per) = &copy.newest_per {
            let named = value.get(per).cloned();
            if named == current {
                continue;
            }
            current = named;
        }
        let left_out = copy.skip.iter().any(|skip| {
            value.get(&skip.field).and_then(serde_json::Value::as_str)
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                .is_some_and(|held| held.pointer(&skip.pointer).is_some_and(|at| !at.is_null()))
        });
        if left_out {
            continue;
        }
        let text = |field: &str| value.get(field).and_then(serde_json::Value::as_str).map(str::to_owned);
        let kept = match &copy.own_record {
            Some(own) => {
                let parts = own.id.iter().map(|field| id_part(&value, field)).collect::<Result<Vec<_>, _>>()?;
                let (first, rest) = parts.split_first().ok_or(Error::Invalid("a copied record has no id", crate::cause!()))?;
                let first = copy.prefix.as_deref().and_then(|prefix| first.strip_prefix(prefix)).unwrap_or(first);
                let named = if rest.is_empty() {
                    first.to_owned()
                } else {
                    let escape = |part: &str| part.replace('%', "%25").replace(':', "%3A");
                    std::iter::once(first).chain(rest.iter().map(String::as_str)).map(escape).collect::<Vec<_>>().join(":")
                };
                let id = format!("{}{named}", own.id_prefix.as_deref().unwrap_or_default());
                let stored = match &own.stored {
                    Some(field) => text(field).ok_or(Error::Invalid("a copied record has no stored value", crate::cause!()))?,
                    None => {
                        let mut row = value.clone();
                        for field in &own.json {
                            if let Some(held) = row.get_mut(field).filter(|held| !held.is_null()) {
                                let text = held.as_str().ok_or(Error::Invalid("a copied JSON field is not text", crate::cause!()))?;
                                *held = serde_json::from_str(text).map_err(|_| Error::Invalid("a copied JSON field is not JSON", crate::cause!()))?;
                            }
                        }
                        serde_json::Value::Object(row).to_string()
                    }
                };
                serde_json::from_str::<&RawValue>(&stored).map_err(|_| Error::Invalid("a copied record's stored value is not JSON", crate::cause!()))?;
                let time = match &own.time {
                    Some(field) => Some(value.get(field).ok_or(Error::Invalid("a copied record has no time", crate::cause!()))?),
                    None => None,
                };
                let body = serde_json::json!({
                    "kind": own.kind, "sequence": sequence_at(time)?, "stored": stored, "meta": null, "protected": false,
                });
                (id, body)
            }
            None => {
                let [key] = declared.key.as_slice() else { return Err(Error::Invalid("a copied family has one key field", crate::cause!())) };
                let id = match value.get(key) {
                    Some(serde_json::Value::String(text)) => text.clone(),
                    Some(serde_json::Value::Number(n)) if n.is_i64() => n.to_string(),
                    _ => return Err(Error::Invalid("a copied row's key is neither text nor an integer", crate::cause!())),
                };
                (id, serde_json::Value::Object(value))
            }
        };
        if kept.0.is_empty() {
            return Err(Error::Invalid("a copied record has an empty id", crate::cause!()));
        }
        rows.push(kept);
    }
    let last = if walked_rows == limit { last } else { None };
    Ok(Some(RowsPage { rows, last }))
}

/// What `record_erasable_keys` says of one record that has no key in the journal or the checkpoint.
pub(crate) enum Erasable {
    Erased,
    Key(Key),
}

/// At most `limit` `record_erasable_keys` rows with record_id above `after`, in record_id order: each erased one, and
/// each one still holding a 32-byte key; the answer's second part is the last record_id read (None when no row was).
/// None when the store has no such table: then no key erasure or kept key is known.
pub(crate) fn erasable_after<S: BoundedRecordSql>(
    source: &mut S,
    after: Option<&str>,
    limit: usize,
) -> Result<Option<(Vec<(String, Erasable)>, Option<String>)>, Error> {
    let present = source
        .query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='record_erasable_keys' LIMIT 1", &[])
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if present.rows.is_empty() {
        return Ok(None);
    }
    let page = source
        .query(
            "SELECT record_id,erased_at,length(key),CASE WHEN length(key)=32 THEN key END FROM record_erasable_keys \
             WHERE record_id>? ORDER BY record_id LIMIT ?",
            &[
                Value::Text(after.unwrap_or_default().to_owned()),
                Value::Integer(i64::try_from(limit).map_err(|_| Error::Invalid("erasable page", crate::cause!()))?),
            ],
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let page = Sensitive(page);
    let (mut answers, mut last) = (Vec::with_capacity(page.0.rows.len()), None);
    for row in &page.0.rows {
        let id = match row.first() {
            Some(SqlValue::Text(id)) => String::from_utf8(id.clone()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
            _ => return Err(crate::cause!(Error::Unavailable)),
        };
        let erased = match row.get(1) {
            Some(SqlValue::Null) => false,
            Some(SqlValue::Text(at)) => !at.is_empty(),
            _ => return Err(crate::cause!(Error::Unavailable)),
        };
        let answer = match (erased, row.get(2), row.get(3)) {
            (true, _, _) => Some(Erasable::Erased),
            (false, Some(SqlValue::Null), Some(SqlValue::Null)) => None,
            (false, Some(SqlValue::Integer(32)), Some(SqlValue::Blob(key))) => {
                let bytes: [u8; 32] = key.as_slice().try_into().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                Some(Erasable::Key(Zeroizing::new(bytes)))
            }
            _ => return Err(Error::Invalid("an erasable key row holds no 32-byte key", crate::cause!())),
        };
        if let Some(answer) = answer {
            answers.push((id.clone(), answer));
        }
        last = Some(id);
    }
    Ok(Some((answers, last)))
}

/// One checkpoint page: its records in id order, the id of the last checkpoint key it covered (records or not), and
/// whether more keys follow.
pub(crate) struct CheckpointPage {
    pub records: Vec<StoredRecord>,
    /// Each id of the covered interval that has a key, in id order.
    pub keys: Vec<(String, Key)>,
    pub last_key: Option<String>,
    pub more: bool,
}

/// Why a checkpoint page was refused.
#[derive(Debug)]
pub(crate) enum PageRefusal {
    /// The page's output budget had no room for its next value after the values before it
    /// (`legacy_kept::Refusal::PageBudget`); a page with fewer records holds it.
    OverBudget(crate::refusal_cause::Cause),
    /// Every other refusal; asking again for the same page cannot help.
    Refused(Error, crate::refusal_cause::Cause),
}
impl PageRefusal {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::OverBudget(cause) => cause.clone(),
            Self::Refused(_, cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(PageRefusal);


impl From<Error> for PageRefusal {
    fn from(error: Error) -> Self {
        let cause = error.cause();
        Self::Refused(error, cause)
    }
}
impl PageRefusal {
    /// The refusal as the migration step answers it.
    pub(crate) fn into_error(self) -> Error {
        match self {
            Self::OverBudget(cause) => Error::Invalid("original kept range output budget exhausted", cause),
            Self::Refused(error, _) => error,
        }
    }
}

/// A kept range read, with the old reader's refusal kept as a category and bounded work counts only.
fn kept_range<S: BoundedRecordSql>(
    source: &mut S,
    kept: &LegacyKept,
    request: Request<'_>,
) -> Result<crate::legacy_kept::range::Page, PageRefusal> {
    kept.range(source, request, RANGES).map_err(|error| {
        // The original source adapter already reduces failures to static reasons,
        // I/O kinds, or SQLite numeric codes. Keep that category and bounded work
        // visible so a failed migration can be repaired without exposing keys,
        // values, SQL text, or source paths.
        crate::quiet_eprintln!(
            "native-own-records-checkpoint source={} sql={} rows={} bytes={} pages={}",
            error.source.map_or_else(|| "none".to_owned(), |source| source.to_string()),
            error.work.sql_statements,
            error.work.rows_returned,
            error.work.source_bytes,
            error.work.page_bodies,
        );
        match error.kind {
            Refusal::PageBudget(_) => crate::cause!(PageRefusal::OverBudget),
            Refusal::Other(_) | Refusal::ValueBound(_) => PageRefusal::from(Error::Invalid(error.reason, crate::cause!())),
        }
    })
}

/// The most `e\0` roots one range read returns; a longer interval is read in several.
const ROOT_PAGE: usize = 4096;

/// The keys of the `e\0<id>` roots for ids after `after` up to and including `through` (to the end of the roots when
/// None). A tombstoned or keyless root is no key: the record's pointer entry answers for it.
fn key_roots<S: BoundedRecordSql>(
    source: &mut S,
    kept: &LegacyKept,
    after: Option<&str>,
    through: Option<&str>,
) -> Result<BTreeMap<String, Key>, PageRefusal> {
    let lo = JsString::from(match after {
        Some(after) => format!("e\0{after}\0"),
        None => "e\0".to_owned(),
    });
    // `e\0<id>\0` is the first key after `e\0<id>`, so the interval holds `through` itself and no longer id.
    let hi = JsString::from(match through {
        Some(through) => format!("e\0{through}\0"),
        None => "e\u{1}".to_owned(),
    });
    let mut keys = BTreeMap::new();
    let mut cursor = None;
    loop {
        let request = Request { lo: &lo, hi: &hi, reverse: false, keys_only: false, limit: ROOT_PAGE, cursor: cursor.as_ref() };
        let mut page = kept_range(source, kept, request)?;
        for item in &mut page.items {
            let id = item.key.strip_prefix("e\0").ok_or(crate::cause!(Error::Unavailable))?.to_owned();
            if let Some(raw) = item.value.as_mut() {
                let held = serde_json::from_str::<&RawValue>(raw).map_err(|error| crate::carry_cause!(Error::Unavailable, error)).and_then(holder);
                raw.zeroize();
                if let Some(key) = held? {
                    keys.insert(id, key);
                }
            }
        }
        match page.next.take() {
            Some(next) => cursor = Some(next),
            None => return Ok(keys),
        }
    }
}

/// At most `limit` checkpoint keys after id `after` (`i\0<id>` keys, newest run wins), decoded into stored forms, with
/// the key of every id in the interval the page covered: its `e\0<id>` root, else its pointer's `protected` entry.
pub(crate) fn checkpoint_page<S: BoundedRecordSql>(
    source: &mut S,
    kept: &LegacyKept,
    after: Option<&str>,
    limit: usize,
) -> Result<CheckpointPage, PageRefusal> {
    // `i\0<id>\0` is the first key after `i\0<id>`: every longer id sharing its text sorts after the NUL.
    let lo = JsString::from(match after {
        Some(after) => format!("i\0{after}\0"),
        None => "i\0".to_owned(),
    });
    let hi = JsString::from("i\u{1}");
    let request = Request { lo: &lo, hi: &hi, reverse: false, keys_only: false, limit, cursor: None };
    let mut page = kept_range(source, kept, request)?;
    if std::env::var_os("OWN_RECORDS_CHECKPOINT_WORK").is_some() {
        crate::quiet_eprintln!(
            "native-own-records-checkpoint-work sql={} rows={} bytes={} pages={} source_sql_us={} page_decode_us={} head_decode_us={} elapsed_us={} timing_complete={}",
            page.work.sql_statements,
            page.work.rows_returned,
            page.work.source_bytes,
            page.work.page_bodies,
            page.work.source_sql_us,
            page.work.page_decode_us,
            page.work.head_decode_us,
            page.work.elapsed_us,
            page.work.source_timing_complete,
        );
    }
    let mut records = Vec::with_capacity(page.items.len());
    let mut keys = BTreeMap::new();
    let mut last_key = None;
    for item in &mut page.items {
        let id = item.key.strip_prefix("i\0").ok_or(crate::cause!(Error::Unavailable))?.to_owned();
        last_key = Some(id.clone());
        let Some(raw) = item.value.as_mut() else { continue };
        let decoded = checkpoint_record(source, kept, &id, raw);
        raw.zeroize();
        let (record, key) = decoded?;
        if let Some(key) = key {
            keys.insert(id, key);
        }
        records.extend(record);
    }
    let more = page.next.is_some();
    // A record's root key replaces its pointer entry's key; a root may also name an id without a record.
    keys.extend(key_roots(source, kept, after, if more { last_key.as_deref() } else { None })?);
    Ok(CheckpointPage { records, keys: keys.into_iter().collect(), last_key, more })
}

/// One `i\0<id>` pointer: the stored form it names (None for a removed record), and the key in its `protected` entry.
fn checkpoint_record<S: BoundedRecordSql>(
    source: &mut S,
    kept: &LegacyKept,
    id: &str,
    raw: &str,
) -> Result<(Option<StoredRecord>, Option<Key>), PageRefusal> {
    let pointer: Vec<&RawValue> = serde_json::from_str(raw).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !(2..=5).contains(&pointer.len()) {
        return Err(Error::Invalid("checkpoint pointer has an unexpected shape", crate::cause!()).into());
    }
    let key = pointer.get(4).map(|raw| holder(raw)).transpose()?.flatten();
    if pointer[0].get() == "null" {
        return Ok((None, key));
    }
    let record_type: String = serde_json::from_str(pointer[0].get()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let sequence: String = serde_json::from_str(pointer[1].get()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let meta_json = pointer.get(3).filter(|raw| raw.get() != "null").map(|raw| raw.get().to_owned());
    let protected_key_present = pointer.get(4).is_some_and(|raw| raw.get() != "null");
    let value_json = if pointer.len() >= 3 {
        pointer[2].get().to_owned()
    } else {
        let point = kept
            .point(source, &format!("r\0{record_type}\0{sequence}\0{id}"))
            .map_err(|error| { let cause = error.cause(); Error::Invalid(error.reason, cause) })?;
        match point.entry {
            Entry::Json(text) => text,
            Entry::Absent | Entry::Tombstone => return Ok((None, key)),
        }
    };
    let record = StoredRecord { id: id.to_owned(), record_type, sequence, value_json, meta_json, protected_key_present };
    Ok((Some(record), key))
}

/// Each id with the canonical reader's answer for it: its stored form, None when absent or deleted.
pub(crate) type Answers = Vec<(String, Option<StoredRecord>)>;

/// What the canonical reader gave for a set of ids, with the snapshot back.
pub(crate) enum Canonical<S> {
    /// Each id's answer.
    Answers(Answers, S),
    /// The ids' records together exceed the read bounds; fewer ids at once may fit. The snapshot's read allowance is
    /// spent, so the caller asks again in a later step, on a fresh snapshot.
    OverBounds(S),
}

/// The canonical reader's answer for each id (journal tail included), then the snapshot back. More than one id over
/// the read bounds answers `OverBounds`; one id alone over them refuses.
pub(crate) fn canonical<S: BoundedRecordSql>(
    source: S,
    kept: &LegacyKept,
    ids: &BTreeSet<String>,
) -> Result<Canonical<S>, Error> {
    let over = |error: &crate::legacy_records::Error| matches!(error, crate::legacy_records::Error::Bounds(_)) && ids.len() > 1;
    let mut records = LegacyRecords::open_source(source, bounds()).map_err(refused)?;
    let answers = if ids.len() <= 256 && records.engine().map_err(refused)? == Engine::RecordLog {
        let selected: Vec<String> = ids.iter().cloned().collect();
        let values = match records.read_stored_batch(&selected, kept) {
            Ok(values) => values,
            Err(error) if over(&error) => return Ok(Canonical::OverBounds(records.into_source())),
            Err(error) => return Err(refused(error)),
        };
        if values.len() != selected.len() { return Err(crate::cause!(Error::Unavailable)); }
        selected.into_iter().zip(values).collect()
    } else {
        let mut answers = Vec::with_capacity(ids.len());
        for id in ids {
            match records.read_stored(id, kept) {
                Ok(value) => answers.push((id.clone(), value)),
                Err(error) if over(&error) => return Ok(Canonical::OverBounds(records.into_source())),
                Err(error) => return Err(refused(error)),
            }
        }
        answers
    };
    Ok(Canonical::Answers(answers, records.into_source()))
}

/// Creating the record store tables changes the RecordBook file's SQLite schema version, which an original append attempt
/// keeps as its reconciliation witness. So the tables are created only while no captured working or unknown
/// original command still needs reconciliation; once they exist, opening changes nothing.
pub(crate) fn may_create_store(path: &std::path::Path) -> Result<(), Error> {
    let db = rusqlite::Connection::open_with_flags(
        &crate::storage::sqlite::no_follow_path(path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let exists = |table: &str| -> Result<bool, Error> {
        // A name search of sqlite_schema walks every catalogue row in large
        // restored accounts. Ask SQLite's named table-list virtual table for
        // only this fixed owner table instead.
        db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_list(?1) WHERE type IN ('table','virtual','shadow'))", [table], |row| row.get(0))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    };
    if exists("versions")? || !exists("resource_behavior_commands")? {
        return Ok(());
    }
    let pending: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM resource_behavior_commands WHERE state IN ('working','unknown') AND result IS NOT NULL LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if pending {
        return Err(Error::Invalid("an original command awaits reconciliation; the record store tables wait for it", crate::cause!()));
    }
    Ok(())
}

/// The old Worker's per-person vault as the RecordBook keeps it (`held_values(address, bytes)`, trillion
/// src/held-values.mjs): the sealed snapshot at `snapshot_address` and the root identity text at
/// `sealed_under_address`. None when the table or the snapshot row does not exist. The snapshot stays sealed.
pub(crate) fn secrets<S: BoundedRecordSql>(
    source: &mut S,
    snapshot_address: &str,
    sealed_under_address: &str,
) -> Result<Option<crate::secrets::OldVault>, Error> {
    let present = source
        .query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='held_values' LIMIT 1", &[])
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if present.rows.is_empty() {
        return Ok(None);
    }
    let rows = source
        .query(
            "SELECT address,bytes FROM held_values WHERE address IN (?,?)",
            &[Value::Text(snapshot_address.to_owned()), Value::Text(sealed_under_address.to_owned())],
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let rows = Sensitive(rows);
    let (mut snapshot, mut sealed_under) = (None, None);
    for row in &rows.0.rows {
        let (Some(SqlValue::Text(address)), Some(SqlValue::Blob(bytes) | SqlValue::Text(bytes))) = (row.first(), row.get(1)) else {
            return Err(crate::cause!(Error::Unavailable));
        };
        if address.as_slice() == snapshot_address.as_bytes() {
            snapshot = Some(Zeroizing::new(bytes.clone()));
        } else {
            sealed_under = Some(String::from_utf8(bytes.clone()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?);
        }
    }
    Ok(snapshot.map(|snapshot| crate::secrets::OldVault { snapshot, sealed_under }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn may_create_store_opens_an_owner_database_under_a_symlinked_folder() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        rusqlite::Connection::open(real.join("records.sqlite")).unwrap().execute_batch("CREATE TABLE versions(x INTEGER)").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(super::may_create_store(&link.join("records.sqlite")).is_ok(), "a symlink above the folder is not the database's own link");
    }
}
