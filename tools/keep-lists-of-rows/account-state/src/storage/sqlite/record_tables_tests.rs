// Purpose: `record_tables.rs` over a real SQLite connection. Ported one to one from old trillion
// test/record-tables.test.mjs (9 tests, same names); one more test reads a typed table through the generic storage
// operations as a runtime family.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use std::cell::RefCell;
use std::rc::Rc;

fn transaction<T>(db: &Connection, work: impl FnOnce() -> Result<T>) -> Result<T> {
    db.execute_batch("BEGIN").unwrap();
    match work() {
        Ok(value) => {
            db.execute_batch("COMMIT").unwrap();
            Ok(value)
        }
        Err(error) => {
            db.execute_batch("ROLLBACK").unwrap();
            Err(error)
        }
    }
}
fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}
fn columns(db: &Connection, table: &str) -> usize {
    count(db, &format!("SELECT count(*) FROM pragma_table_info('{table}')")) as usize
}
const ODD: &str = "row:odd\"; DROP TABLE x;--";
const ODD_FIELD: &str = "x\"; DROP TABLE x;--";
fn odd_kind() -> Value {
    json!({ "type": ODD, "declared_by": "list:one", "properties": { ODD_FIELD: "text", "count": "number", "enabled": "boolean", "tags": "list", "data": "object" }, "indexes": [{ "name": "by_count", "fields": ["count"] }] })
}
/// The old `setup()`: one odd kind (changeable), and a shipped machine kind that does not qualify.
fn setup(db: &Connection) -> (RecordTables<'_>, Rc<RefCell<Value>>) {
    let kind = Rc::new(RefCell::new(odd_kind()));
    let held = kind.clone();
    let tables = RecordTables::new(db, move |asked| {
        let kind = held.borrow();
        if asked == kind["type"] {
            Some(kind.clone())
        } else if asked == "machine" {
            Some(json!({ "type": "machine", "properties": { "name": "text" } }))
        } else {
            None
        }
    });
    (tables, kind)
}
fn events(tables: &RecordTables<'_>, kind: Option<&str>) -> Vec<String> {
    tables.schema_history(kind, 0, 1000).unwrap().into_iter().map(|row| row.event).collect()
}
fn none() -> Context {
    Context::default()
}

#[test]
fn hosted_column_limits_allow_ongoing_type_edits_by_compacting_retired_generations_and_preserving_values() {
    let db = Connection::open_in_memory().unwrap();
    let kind = Rc::new(RefCell::new(json!({ "type": "customer", "table": true, "properties": { "value": "number" }, "indexes": [{ "name": "value", "fields": ["value"] }] })));
    let held = kind.clone();
    let tables = RecordTables::new(&db, move |_| Some(held.borrow().clone()));
    transaction(&db, || tables.put("one", "customer", &json!({ "value": 7, "extra": "kept" }), &none())).unwrap();
    for i in 0..100 {
        kind.borrow_mut()["properties"] = json!({ "value": if i % 2 == 1 { "number" } else { "text" } });
        transaction(&db, || tables.ensure("customer", &none())).unwrap();
        let schema = tables.schema("customer").unwrap();
        assert!(columns(&db, &schema.table) <= 100);
        assert_eq!(count(&db, &format!("SELECT count(*) FROM pragma_index_list('{}') WHERE name LIKE 'rti_%'", schema.table)), 1);
        assert_eq!(tables.read("one", "customer").unwrap().unwrap().value, json!({ "value": 7, "extra": "kept" }));
    }
    let wide: Map<String, Value> = (0..95).map(|i| (format!("field{i}"), json!("text"))).collect();
    *kind.borrow_mut() = json!({ "type": "customer", "table": true, "properties": wide, "indexes": [] });
    let refused = transaction(&db, || tables.ensure("customer", &none())).err().unwrap();
    assert!(matches!(refused, TableError::Schema { limit: Some(93), .. }), "{refused:?}");
}

#[test]
fn customer_kinds_create_typed_columns_safely_become_visible_in_the_same_transaction_and_preserve_complete_values() {
    let db = Connection::open_in_memory().unwrap();
    let (tables, _) = setup(&db);
    assert!(events(&tables, None).is_empty());
    assert_eq!(count(&db, "SELECT count(*) FROM sqlite_master WHERE type = 'table'"), 0, "schema reads do not create storage");
    assert!(matches!(tables.ensure("machine", &none()), Err(TableError::Schema { .. })), "shipped machine kinds do not qualify");
    assert!(matches!(tables.put("bad-1", ODD, &json!({ "count": "three" }), &none()), Err(TableError::Schema { .. })), "declared values are validated before SQL projection");
    let value = json!({ ODD_FIELD: "hello", "count": 3, "enabled": true, "tags": ["a"], "data": { "ok": 1 }, "extra": "kept" });
    transaction(&db, || {
        let first = Context { at: Some("2026-10-10T10:00:00Z".into()), transaction_id: Some("tx-1".into()), actor: Some(json!({ "by": "tester" })), skip_validate: false };
        tables.put("id-1", ODD, &value, &first)?;
        assert_eq!(count(&db, "SELECT changes()"), 1, "one inserted projection row represents the save");
        tables.put("id-1", ODD, &value, &Context { at: Some("2026-10-10T11:00:00Z".into()), transaction_id: Some("tx-2".into()), ..Context::default() })?;
        assert_eq!(count(&db, "SELECT changes()"), 0, "an unchanged value does not rewrite its row or metadata");
        assert_eq!(tables.read("id-1", ODD)?.unwrap().value, value);
        let table = tables.schema(ODD)?.table;
        assert_eq!(count(&db, &format!("SELECT count(*) FROM \"{table}\" WHERE _deleted = 0")), 1, "one save does not add a separate registry row");
        assert_eq!(tables.rows(ODD, None, 100)?.into_iter().map(|row| row.id).collect::<Vec<_>>(), ["id-1"]);
        Ok(())
    })
    .unwrap();
    let physical = tables.schema(ODD).unwrap();
    assert!(physical.table.starts_with("rt_") && physical.table[3..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(physical.fields.iter().any(|field| field.field == "count" && field.value_type == "number"));
    assert_eq!(count(&db, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'x'"), 0, "injection-shaped identifiers remain data");
    assert_eq!(count(&db, "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'rti_%'"), 1);
    assert_eq!(events(&tables, Some(ODD)), ["kind_added", "field_added", "field_added", "field_added", "field_added", "field_added", "index_added"]);
}

#[test]
fn schema_edits_add_fields_remove_them_without_dropping_data_and_unchanged_declarations_add_no_history() {
    let db = Connection::open_in_memory().unwrap();
    let (tables, kind) = setup(&db);
    {
        let mut k = kind.borrow_mut();
        k["properties"] = json!({ "count": "number", "retired": "text" });
        k["indexes"] = json!([]);
    }
    transaction(&db, || tables.put("id-1", ODD, &json!({ "count": 2, "retired": "retained" }), &none())).unwrap();
    let before = events(&tables, Some(ODD)).len();
    kind.borrow_mut()["properties"] = json!({ ODD_FIELD: "text", "count": "number", "enabled": "boolean", "tags": "list", "data": "object" });
    assert_eq!(tables.schema(ODD).unwrap().fields.len(), 5);
    assert_eq!(events(&tables, Some(ODD)).len(), before, "schema reads do not mutate history");
    transaction(&db, || tables.ensure(ODD, &none())).unwrap();
    assert_eq!(events(&tables, Some(ODD)).len(), before + 5, "ensure adds missing fields and records the removed declaration");
    let stable = events(&tables, Some(ODD)).len();
    transaction(&db, || tables.ensure(ODD, &none())).unwrap();
    assert_eq!(events(&tables, Some(ODD)).len(), stable);
    assert_eq!(tables.read("id-1", ODD).unwrap().unwrap().value["retired"], "retained");
    assert!(!tables.schema(ODD).unwrap().fields.iter().any(|field| field.field == "retired" && field.column.is_none()));
    kind.borrow_mut()["properties"] = json!({ "count": "number" });
    transaction(&db, || tables.ensure(ODD, &none())).unwrap();
    assert_eq!(tables.read("id-1", ODD).unwrap().unwrap().value["retired"], "retained");
    assert!(events(&tables, Some(ODD)).iter().any(|event| event == "field_removed"));
}

#[test]
fn type_changes_retain_original_values_and_add_a_new_typed_generation_without_a_whole_table_migration() {
    let db = Connection::open_in_memory().unwrap();
    let (tables, kind) = setup(&db);
    transaction(&db, || tables.put("id-1", ODD, &json!({ "count": 42 }), &none())).unwrap();
    kind.borrow_mut()["properties"]["count"] = json!("text");
    transaction(&db, || tables.ensure(ODD, &none())).unwrap();
    assert_eq!(tables.read("id-1", ODD).unwrap().unwrap().value["count"], 42, "historical JSON preserves the original value");
    let count_fields: Vec<SchemaField> = tables.schema(ODD).unwrap().fields.into_iter().filter(|field| field.field == "count").collect();
    assert_eq!(count_fields.len(), 1);
    assert_eq!(count_fields[0].value_type, "text");
    transaction(&db, || tables.put("id-1", ODD, &json!({ "count": "forty-two" }), &none())).unwrap();
    assert_eq!(tables.read("id-1", ODD).unwrap().unwrap().value["count"], "forty-two");
}

#[test]
fn removal_is_a_tombstone_type_transitions_do_not_duplicate_live_rows_and_caller_rollback_covers_schema_and_records() {
    let db = Connection::open_in_memory().unwrap();
    let (tables, kind) = setup(&db);
    transaction(&db, || tables.put("id-1", ODD, &json!({ "count": 1 }), &none())).unwrap();
    let other = "customer:other";
    let first = kind.borrow().clone();
    // Both kinds stay declared: the setup answers the current kind, so the first is kept beside it here.
    let both = RecordTables::new(&db, move |asked| match asked {
        "customer:other" => Some(json!({ "type": "customer:other", "declared_by": "list:two", "properties": { "name": "text" }, "indexes": [] })),
        _ if asked == first["type"] => Some(first.clone()),
        _ => None,
    });
    drop(tables);
    assert!(transaction(&db, || both.remove("id-1", ODD, &none())).unwrap());
    transaction(&db, || both.put("id-1", other, &json!({ "name": "new" }), &none())).unwrap();
    assert_eq!(both.read("id-1", ODD).unwrap(), None);
    assert!(both.rows(ODD, None, 100).unwrap().is_empty());
    assert_eq!(both.read("id-1", other).unwrap().unwrap().value["name"], "new");
    assert!(both.remove("id-1", other, &none()).unwrap());
    assert_eq!(both.read("id-1", other).unwrap(), None);
    assert!(!both.remove("id-1", other, &none()).unwrap());
    let rolled = transaction(&db, || {
        both.put("id-2", other, &json!({ "name": "rollback" }), &none())?;
        Err::<(), _>(TableError::Invalid("rollback", crate::cause!()))
    });
    assert_eq!(rolled, Err(TableError::Invalid("rollback", crate::cause!())));
    assert_eq!(both.read("id-2", other).unwrap(), None);
}

#[test]
fn a_new_kind_declares_its_initial_fields_in_one_table_creation_and_keeps_every_schema_event() {
    let db = Connection::open_in_memory().unwrap();
    let fields: Map<String, Value> = (0..32).map(|i| (format!("field{i}"), json!("text"))).collect();
    let kind = Rc::new(RefCell::new(json!({ "type": "initial-wide-kind", "customer_declared": true, "properties": fields })));
    let alters = Rc::new(RefCell::new(0usize));
    let counted = alters.clone();
    let heard = Rc::new(RefCell::new(Vec::new()));
    let hear = heard.clone();
    let held = kind.clone();
    let tables = RecordTables::new(&db, move |_| Some(held.borrow().clone())).on_change(move |change| hear.borrow_mut().push(change.event.clone()));
    // ALTER statements are counted through SQLite's own schema cookie: each ALTER moves `schema_version`.
    let schema_version = |db: &Connection| count(db, "PRAGMA schema_version");
    let before = schema_version(&db);
    transaction(&db, || tables.put("one", "initial-wide-kind", &json!({ "field0": "first", "field31": "last" }), &none())).unwrap();
    let schema = tables.schema("initial-wide-kind").unwrap();
    // The metadata tables (4, one with AUTOINCREMENT's sqlite_sequence) and the kind's table: no ALTER moved it further.
    let made = schema_version(&db) - before;
    assert_eq!(columns(&db, &schema.table), 39);
    assert_eq!(schema.fields.len(), 32);
    assert_eq!(tables.read("one", "initial-wide-kind").unwrap().unwrap().value, json!({ "field0": "first", "field31": "last" }));
    let mut expected = vec!["kind_added".to_string()];
    expected.extend(std::iter::repeat("field_added".to_string()).take(32));
    assert_eq!(*heard.borrow(), expected);
    assert_eq!(tables.schema_history(Some("initial-wide-kind"), 0, 1000).unwrap().len(), 33);
    let mut wider = fields_of(&kind.borrow());
    wider.insert("later".into(), json!("number"));
    kind.borrow_mut()["properties"] = Value::Object(wider);
    let at = schema_version(&db);
    transaction(&db, || tables.ensure("initial-wide-kind", &none())).unwrap();
    *counted.borrow_mut() += (schema_version(&db) - at) as usize;
    assert_eq!(*alters.borrow(), 1, "an existing kind still evolves by its original additive path: one ALTER");
    assert!(made <= 6, "initial fields must not each alter the table: {made} schema changes");
    assert_eq!(tables.schema_history(Some("initial-wide-kind"), 0, 1000).unwrap().last().unwrap().field.as_deref(), Some("later"));
}
fn fields_of(kind: &Value) -> Map<String, Value> {
    kind["properties"].as_object().cloned().unwrap_or_default()
}

#[test]
fn a_new_kind_still_refuses_more_than_the_hosted_physical_column_limit() {
    let db = Connection::open_in_memory().unwrap();
    let wide: Map<String, Value> = (0..94).map(|i| (format!("field{i}"), json!("text"))).collect();
    let kind = json!({ "type": "too-wide-initial-kind", "table": true, "properties": wide });
    let tables = RecordTables::new(&db, move |_| Some(kind.clone()));
    assert!(matches!(transaction(&db, || tables.ensure("too-wide-initial-kind", &none())), Err(TableError::Schema { .. })));
    tables.forget_ready();
    assert!(tables.schema_history(None, 0, 1000).unwrap().is_empty(), "a refused declaration does not commit partial history");
}

#[test]
fn the_maximum_fresh_schema_fits_and_a_rolled_back_initial_declaration_retries_with_identical_field_history() {
    let db = Connection::open_in_memory().unwrap();
    let full: Map<String, Value> = (0..93).map(|i| (format!("field{i}"), json!("text"))).collect();
    let kind = json!({ "type": "full-initial-kind", "table": true, "properties": full });
    let tables = RecordTables::new(&db, move |_| Some(kind.clone()));
    let rolled = transaction(&db, || {
        tables.ensure("full-initial-kind", &none())?;
        Err::<(), _>(TableError::Invalid("rollback the complete initial schema", crate::cause!()))
    });
    assert_eq!(rolled, Err(TableError::Invalid("rollback the complete initial schema", crate::cause!())));
    tables.forget_ready();
    assert!(tables.schema_history(None, 0, 1000).unwrap().is_empty());
    transaction(&db, || tables.put("one", "full-initial-kind", &json!({ "field0": "first", "field92": "last" }), &none())).unwrap();
    let schema = tables.schema("full-initial-kind").unwrap();
    assert_eq!(columns(&db, &schema.table), 100);
    assert_eq!(schema.fields.len(), 93);
    assert_eq!(tables.read("one", "full-initial-kind").unwrap().unwrap().value, json!({ "field0": "first", "field92": "last" }));
    assert_eq!(tables.schema_history(Some("full-initial-kind"), 0, 1000).unwrap().len(), 94);
}

#[test]
fn a_declared_index_walks_in_json_spelling_order_then_id_with_cursors_and_prefixes() {
    let db = Connection::open_in_memory().unwrap();
    let kind = json!({ "type": "task", "table": true, "properties": { "title": "text", "rank": "number" }, "indexes": [{ "name": "by_title", "fields": ["title"] }, { "name": "by_rank", "fields": ["rank"] }] });
    let tables = RecordTables::new(&db, move |_| Some(kind.clone()));
    for (id, title, rank) in [("a", "beta", 2), ("b", "alpha", 10), ("c", "alpha", 1), ("d", "gamma", 3)] {
        transaction(&db, || tables.put(id, "task", &json!({ "title": title, "rank": rank }), &none())).unwrap();
    }
    let ids = |scan: IndexScan, name: &str| tables.scan_index("task", name, &IndexScan { limit: 10, ..scan }).unwrap().into_iter().map(|(id, _)| id).collect::<Vec<_>>();
    assert_eq!(ids(IndexScan::default(), "by_title"), ["b", "c", "a", "d"], "equal titles in id order");
    assert_eq!(ids(IndexScan { after: Some(json!("alpha")), after_id: Some("b".into()), ..IndexScan::default() }, "by_title"), ["c", "a", "d"]);
    assert_eq!(ids(IndexScan { starts_with: Some("gam".into()), ..IndexScan::default() }, "by_title"), ["d"]);
    assert_eq!(ids(IndexScan { equal: vec![json!("alpha")], ..IndexScan::default() }, "by_title"), ["b", "c"]);
    // JSON spelling order: "1" < "10" < "2" < "3", the packed record index's order.
    assert_eq!(ids(IndexScan::default(), "by_rank"), ["c", "b", "a", "d"]);
    assert_eq!(ids(IndexScan { reverse: true, ..IndexScan::default() }, "by_rank"), ["d", "a", "b", "c"]);
}

#[test]
fn a_kinds_table_is_a_runtime_family_the_generic_operations_read_by_key() {
    use crate::storage::{sqlite::{lend, Access}, Read, Storage, Value as Stored};
    let db = Connection::open_in_memory().unwrap();
    let kind = json!({ "type": "contact", "table": true, "properties": { "name": "text" } });
    let tables = RecordTables::new(&db, move |_| Some(kind.clone())).as_families_of("storage_test");
    transaction(&db, || tables.put("p1", "contact", &json!({ "name": "Ada" }), &none())).unwrap();
    let table = table_name("contact");
    let supply = lend(&db, "storage_test", Access::Read).unwrap();
    let row = supply.get(&table, &[Stored::from("p1")], &[Read::whole("_value_json")]).unwrap().unwrap();
    assert_eq!(row.0, vec![Stored::from("{\"name\":\"Ada\"}")]);
    assert!(supply.get("rt_not_laid_out", &[Stored::from("p1")], &[Read::whole("_id")]).is_err(), "an unknown family is still undeclared");
}
