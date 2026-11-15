//! Row layout parts shared by the current-row candidates (S2, S3, S2h):
//! the generic declared index table `idx(index_id, value, record_id)` whose
//! declarations are DATA, member rows `mem` for large lists, and the value
//! split between a current-row body and its member lists.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use workload_simulation::{Operation, StoreError};

use crate::meter::err;

pub const IDX_DDL: &str =
    "CREATE TABLE idx(index_id TEXT NOT NULL, value TEXT NOT NULL, record_id TEXT NOT NULL,
                       PRIMARY KEY(index_id, value, record_id)) WITHOUT ROWID;";
pub const MEM_DDL: &str = "CREATE TABLE mem(record_id TEXT NOT NULL, list_id TEXT NOT NULL, member_key INTEGER NOT NULL,
                       body TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(record_id, list_id, member_key)) WITHOUT ROWID;";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndexDecl {
    pub id: String,
    pub of: IndexOf,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndexOf {
    /// (kind, order key): newest-first lists of a kind.
    KindNewest,
    Owner,
    /// (kind, JSON text of a top-level field).
    Field {
        field: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EraseLookup {
    OwnerIndex,
    Scan,
}

pub fn owner_of(body: &Map<String, Value>) -> String {
    body.get(workload_simulation::generate::OWNER_FIELD)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// The declaration of a given kind, if any.
pub fn declared<'a>(indexes: &'a [IndexDecl], of: &IndexOf) -> Option<&'a IndexDecl> {
    indexes.iter().find(|d| d.of == *of)
}

/// Entries of every declared index for one record version. `order` is the
/// candidate's newest-first key (S2: operation sequence; S2h: commit stamp).
pub fn index_values(
    indexes: &[IndexDecl],
    kind: &str,
    body: &Map<String, Value>,
    order: i64,
) -> Vec<(String, String)> {
    indexes
        .iter()
        .filter_map(|d| {
            let v = match &d.of {
                IndexOf::KindNewest => Some(format!("{kind}\u{1}{order:020}")),
                IndexOf::Owner => Some(owner_of(body)),
                IndexOf::Field { field } => body.get(field).map(|v| format!("{kind}\u{1}{v}")),
            }?;
            Some((d.id.clone(), v))
        })
        .collect()
}

pub fn put_index(
    conn: &Connection,
    entries: &[(String, String)],
    key: &str,
) -> Result<(), StoreError> {
    let mut stmt = conn
        .prepare_cached("INSERT INTO idx(index_id, value, record_id) VALUES(?1, ?2, ?3)")
        .map_err(err)?;
    for (id, v) in entries {
        stmt.execute(params![id, v, key]).map_err(err)?;
    }
    Ok(())
}

pub fn drop_index(
    conn: &Connection,
    entries: &[(String, String)],
    key: &str,
) -> Result<(), StoreError> {
    let mut stmt = conn
        .prepare_cached("DELETE FROM idx WHERE index_id = ?1 AND value = ?2 AND record_id = ?3")
        .map_err(err)?;
    for (id, v) in entries {
        stmt.execute(params![id, v, key]).map_err(err)?;
    }
    Ok(())
}

/// Delete the entries that left and insert the ones that arrived.
pub fn move_index(
    conn: &Connection,
    before: &[(String, String)],
    after: &[(String, String)],
    key: &str,
) -> Result<(), StoreError> {
    let gone: Vec<_> = before
        .iter()
        .filter(|e| !after.contains(e))
        .cloned()
        .collect();
    let new: Vec<_> = after
        .iter()
        .filter(|e| !before.contains(e))
        .cloned()
        .collect();
    drop_index(conn, &gone, key)?;
    put_index(conn, &new, key)
}

/// Record ids under one exact declared index value (owner lookups).
pub fn index_keys(
    conn: &Connection,
    index_id: &str,
    value: &str,
) -> Result<Vec<String>, StoreError> {
    let mut stmt = conn
        .prepare_cached("SELECT record_id FROM idx WHERE index_id = ?1 AND value = ?2")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![index_id, value], |r| r.get(0))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// Newest `limit` record ids of `kind` from a kind_newest declaration.
pub fn newest_of_kind(
    conn: &Connection,
    index_id: &str,
    kind: &str,
    limit: u32,
) -> Result<Vec<String>, StoreError> {
    let lo = format!("{kind}\u{1}");
    let hi = format!("{kind}\u{2}");
    let mut stmt = conn
        .prepare_cached(
            "SELECT record_id FROM idx WHERE index_id = ?1 AND value >= ?2 AND value < ?3 ORDER BY value DESC LIMIT ?4",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![index_id, lo, hi, limit as i64], |r| r.get(0))
        .map_err(err)?;
    rows.collect::<Result<Vec<String>, _>>().map_err(err)
}

/// A value split into its current-row body and its member lists.
pub type Split = (Map<String, Value>, Vec<(String, Vec<Value>)>);

/// Lists with at least `member_min` members leave the body as member rows.
pub fn split(value: &Value, member_min: usize) -> Split {
    let mut body = value.as_object().cloned().unwrap_or_default();
    let mut lists = Vec::new();
    let names: Vec<String> = body
        .iter()
        .filter(|(_, v)| v.as_array().is_some_and(|a| a.len() >= member_min))
        .map(|(k, _)| k.clone())
        .collect();
    for k in names {
        if let Some(Value::Array(a)) = body.remove(&k) {
            lists.push((k, a));
        }
    }
    (body, lists)
}

/// JSON text of a record's member-list names (None when it has none).
pub fn list_names(lists: &[(String, Vec<Value>)]) -> Result<Option<String>, StoreError> {
    if lists.is_empty() {
        return Ok(None);
    }
    let names: Vec<&String> = lists.iter().map(|(k, _)| k).collect();
    serde_json::to_string(&names).map(Some).map_err(err)
}

pub fn parse_lists(text: Option<String>) -> Result<Vec<String>, StoreError> {
    text.map(|l| serde_json::from_str(&l))
        .transpose()
        .map_err(err)
        .map(Option::unwrap_or_default)
}

pub fn put_members(
    conn: &Connection,
    key: &str,
    list: &str,
    members: &[Value],
    op: &Operation,
) -> Result<(), StoreError> {
    let mut stmt = conn
        .prepare_cached(
            "INSERT INTO mem(record_id, list_id, member_key, body, seq) VALUES(?1, ?2, ?3, ?4, ?5)",
        )
        .map_err(err)?;
    for (i, m) in members.iter().enumerate() {
        stmt.execute(params![
            key,
            list,
            i as i64,
            serde_json::to_string(m).map_err(err)?,
            op.sequence as i64
        ])
        .map_err(err)?;
    }
    Ok(())
}

/// Every member list of a record, in list order.
pub fn members(conn: &Connection, key: &str) -> Result<Vec<(String, Vec<Value>)>, StoreError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT list_id, body FROM mem WHERE record_id = ?1 ORDER BY list_id, member_key",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map([key], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(err)?;
    let mut out: Vec<(String, Vec<Value>)> = Vec::new();
    for row in rows {
        let (list, body) = row.map_err(err)?;
        let v: Value = serde_json::from_str(&body).map_err(err)?;
        match out.last_mut() {
            Some((l, items)) if *l == list => items.push(v),
            _ => out.push((list, vec![v])),
        }
    }
    Ok(out)
}

/// Whole current value: body plus member lists (read only when it has lists).
pub fn assemble(
    conn: &Connection,
    key: &str,
    body: &Map<String, Value>,
    lists: &[String],
) -> Result<Value, StoreError> {
    let mut value = body.clone();
    if !lists.is_empty() {
        for (list, items) in members(conn, key)? {
            value.insert(list, Value::Array(items));
        }
    }
    Ok(Value::Object(value))
}

/// The kinds a kind_newest declaration holds: a skip scan, one seek per kind.
pub fn kinds_of(conn: &Connection, index_id: &str) -> Result<Vec<String>, StoreError> {
    let mut out = Vec::new();
    let mut from = String::new();
    loop {
        let next: Option<String> = conn
            .prepare_cached(
                "SELECT value FROM idx WHERE index_id = ?1 AND value > ?2 ORDER BY value LIMIT 1",
            )
            .map_err(err)?
            .query_row(params![index_id, from], |r| r.get(0))
            .optional()
            .map_err(err)?;
        let Some(v) = next else { break };
        let kind = v.split('\u{1}').next().unwrap_or_default().to_owned();
        from = format!("{kind}\u{2}");
        out.push(kind);
    }
    Ok(out)
}

/// Record ids whose kind_newest order key is above `after` (every kind).
pub fn changed_since(
    conn: &Connection,
    index_id: &str,
    after: i64,
) -> Result<Vec<String>, StoreError> {
    let mut out = Vec::new();
    for kind in kinds_of(conn, index_id)? {
        let lo = if after == i64::MIN {
            format!("{kind}\u{1}")
        } else {
            format!("{kind}\u{1}{after:020}\u{0}")
        };
        let hi = format!("{kind}\u{2}");
        let mut stmt = conn
            .prepare_cached(
                "SELECT record_id FROM idx WHERE index_id = ?1 AND value > ?2 AND value < ?3",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![index_id, lo, hi], |r| r.get::<_, String>(0))
            .map_err(err)?;
        for id in rows {
            out.push(id.map_err(err)?);
        }
    }
    Ok(out)
}
