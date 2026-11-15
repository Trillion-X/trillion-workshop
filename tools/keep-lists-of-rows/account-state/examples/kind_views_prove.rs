// examples/kind_views_prove.rs
//
// Purpose: Prove the typed views of a person's own kinds (`storage::kind_views`) on a CLONE of an account's RecordBook
// file: every kind's schema folded from its record store schema history equals the old engine's typed-table catalogue
// (`_record_tables_fields`, each field's newest generation still declared), and every row of every old typed table
// (`rt_*`) whose record record store still holds unchanged reads the same through its kind's view. Then the read cost: one page
// of a kind read plain (ids, then the records) against the same page read through the view (plus the schemas and the
// projection), as p50 / p95 over every kind, several passes.
//
// Non-Negotiable Invariants:
// - Read-only: the record store side reads through `record_store_resources::Readers` (query_only WAL handles); the old tables through a
//   read-only connection. Run it on an APFS clone, never on the live file.
// - The output holds counts, kinds' names and timings only, never a record value.
//
// Security Considerations:
// - Record values are compared in memory and dropped; nothing of them is printed or written.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: kind_views_prove RECORDBOOK_SQLITE [PASSES]

use rusqlite::{types::ValueRef, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Instant,
};
use trillion_local::{
    records::Error,
    sqlite_work::WorkMeter,
    storage::{
        kind_views::{self, FieldType},
        record_store_resources::Readers,
    },
};

const RESOURCE: &str = "own-records";
const PAGE: usize = 100;

type Failure = Box<dyn std::error::Error>;

/// One old typed table: its table, and each declared field's newest type and column.
struct OldKind {
    table: String,
    fields: BTreeMap<String, (FieldType, String)>,
}

fn main() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = PathBuf::from(args.first().ok_or("usage: kind_views_prove RECORDBOOK_SQLITE [PASSES]")?).canonicalize()?;
    let passes: usize = args.get(1).map_or(Ok(5), |text| text.parse())?;
    let old = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let account: String =
        old.query_row("SELECT account FROM versions WHERE resource = ?1 LIMIT 1", [RESOURCE], |row| row.get(0))?;
    let kinds = old_kinds(&old)?;
    let readers = Readers::new(path, WorkMeter::new());
    let schemas = readers.read(|store| kind_views::schemas(&store, &account, RESOURCE).map(|kept| (*kept).clone()))?;

    // 1. Each kind's folded schema against the old catalogue.
    let mut schema_differs = Vec::new();
    for (kind, held) in &kinds {
        let folded: BTreeMap<&String, FieldType> =
            schemas.get(kind).map(|schema| schema.fields.iter().map(|(field, typed)| (field, *typed)).collect()).unwrap_or_default();
        let catalogue: BTreeMap<&String, FieldType> = held.fields.iter().map(|(field, (typed, _))| (field, *typed)).collect();
        if folded != catalogue {
            schema_differs.push(kind.clone());
        }
    }

    // 2. Every old typed row against the record's view.
    let (mut compared, mut same, mut differs, mut changed_since, mut gone) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut differing_kinds = BTreeSet::new();
    for (kind, held) in &kinds {
        let Some(schema) = schemas.get(kind) else { continue };
        let columns: Vec<(&String, FieldType, &String)> =
            held.fields.iter().map(|(field, (typed, column))| (field, *typed, column)).collect();
        let select = columns.iter().map(|(_, _, column)| format!("\"{column}\"")).collect::<Vec<_>>();
        let sql = format!(
            "SELECT _id, _value_json{}{} FROM \"{}\" WHERE _deleted = 0 ORDER BY _id",
            if select.is_empty() { "" } else { ", " },
            select.join(", "),
            held.table
        );
        let mut statement = old.prepare(&sql)?;
        let mut rows = statement.query([])?;
        let mut page: Vec<(String, Value, Value)> = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let value: Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
            let mut cells = serde_json::Map::new();
            for (at, (field, typed, _)) in columns.iter().enumerate() {
                cells.insert((*field).clone(), decode(row.get_ref(at + 2)?, *typed)?);
            }
            page.push((id, value, Value::Object(cells)));
        }
        for chunk in page.chunks(PAGE) {
            let ids: Vec<&str> = chunk.iter().map(|(id, _, _)| id.as_str()).collect();
            let held = readers.read(|store| store.get_many(&account, RESOURCE, &ids))?;
            for ((_, old_value, old_cells), record) in chunk.iter().zip(held) {
                compared += 1;
                let Some(record) = record else {
                    gone += 1;
                    continue;
                };
                let stored: Value = serde_json::from_str(record.value["stored"].as_str().ok_or("a record has no stored value")?)?;
                if &stored != old_value {
                    changed_since += 1;
                    continue;
                }
                if same_cells(&Value::Object(schema.view(&stored).fields), old_cells) {
                    same += 1;
                } else {
                    differs += 1;
                    differing_kinds.insert(kind.clone());
                }
            }
        }
    }

    // 3. One page of each kind, plain and through the view.
    let (mut plain, mut viewed) = (Vec::new(), Vec::new());
    for _ in 0..passes {
        for kind in kinds.keys() {
            plain.push(timed(|| readers.read(|store| page_of(&store, &account, kind).map(drop)))?);
            viewed.push(timed(|| {
                readers.read(|store| {
                    let schemas = kind_views::schemas(&store, &account, RESOURCE)?;
                    let records = page_of(&store, &account, kind)?;
                    let schema = schemas.get(kind.as_str()).cloned().unwrap_or_default();
                    for record in records {
                        let stored: Value =
                            serde_json::from_str(record.value["stored"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
                        drop(schema.view(&stored));
                    }
                    Ok::<_, Error>(())
                })
            })?);
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "kinds": kinds.len(),
            "schemas_folded": schemas.len(),
            "schemas_differing_from_the_catalogue": schema_differs,
            "rows": {"compared": compared, "same_through_the_view": same, "different": differs,
                     "changed_since_the_tables_froze": changed_since, "no_longer_held": gone},
            "kinds_with_different_rows": differing_kinds,
            "page_ms": {"plain": spread(plain), "through_the_view": spread(viewed)},
        }))?
    );
    Ok(())
}

/// The old catalogue: each kind's table, and each field's newest generation while still declared.
fn old_kinds(old: &rusqlite::Connection) -> Result<BTreeMap<String, OldKind>, Failure> {
    let mut kinds = BTreeMap::new();
    let mut tables = old.prepare("SELECT kind, table_name FROM _record_tables_kinds")?;
    for row in tables.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))? {
        let (kind, table) = row?;
        kinds.insert(kind, OldKind { table, fields: BTreeMap::new() });
    }
    let mut fields = old.prepare(
        "SELECT f.kind, f.field, f.value_type, f.column_name FROM _record_tables_fields f WHERE f.declared = 1 AND \
         f.generation = (SELECT max(g.generation) FROM _record_tables_fields g WHERE g.kind = f.kind AND g.field = f.field)",
    )?;
    for row in fields.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))? {
        let (kind, field, typed, column) = row?;
        let typed: FieldType = serde_json::from_value(Value::String(typed))?;
        if let Some(held) = kinds.get_mut(&kind) {
            held.fields.insert(field, (typed, column));
        }
    }
    Ok(kinds)
}

/// An old typed cell as the old engine read it back (`record-tables.mjs` decode).
fn decode(cell: ValueRef<'_>, typed: FieldType) -> Result<Value, Failure> {
    Ok(match (cell, typed) {
        (ValueRef::Null, _) => Value::Null,
        (ValueRef::Integer(n), FieldType::Boolean) => Value::Bool(n == 1),
        (ValueRef::Text(text), FieldType::List | FieldType::Json) => serde_json::from_slice(text)?,
        (ValueRef::Text(text), _) => Value::String(String::from_utf8(text.to_vec())?),
        (ValueRef::Integer(n), _) => json!(n),
        (ValueRef::Real(n), _) => json!(n),
        (ValueRef::Blob(_), _) => return Err("an old typed cell is a blob".into()),
    })
}

/// Equal cells, numbers compared by value (SQLite REAL keeps 1 as 1.0).
fn same_cells(view: &Value, old: &Value) -> bool {
    match (view, old) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|w| same_cells(v, w))),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(v, w)| same_cells(v, w)),
        _ => view == old,
    }
}

/// One page of a kind: its newest ids, then their records.
fn page_of<S: trillion_local::storage::Storage>(
    store: &trillion_local::storage::record_store::RecordStore<S>,
    account: &str,
    kind: &str,
) -> Result<Vec<trillion_local::records::Record>, Error> {
    let (ids, _) = store.ids_of_kind(account, RESOURCE, kind, None, PAGE)?;
    let asked: Vec<&str> = ids.iter().map(String::as_str).collect();
    Ok(store.get_many(account, RESOURCE, &asked)?.into_iter().flatten().collect())
}

fn timed<E>(work: impl FnOnce() -> Result<(), E>) -> Result<f64, E> {
    let started = Instant::now();
    work()?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

fn spread(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    let at = |q: f64| values.get(((values.len() as f64 * q) as usize).min(values.len().saturating_sub(1))).copied().unwrap_or(0.0);
    json!({"n": values.len(), "p50": (at(0.5) * 100.0).round() / 100.0, "p95": (at(0.95) * 100.0).round() / 100.0})
}
