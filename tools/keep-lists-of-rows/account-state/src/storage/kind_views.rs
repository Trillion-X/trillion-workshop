//! Typed views of a person's own kinds: each kind's fields and their types, derived from the kind's schema history,
//! and each record of the kind projected onto them.
//!
//! Purpose: a person's own kinds (Twenty, Attio and Airtable style custom objects: `record:signals`,
//! `record:calendar-task`, ...) read like real tables, typed columns per kind, with no table per kind and no data moved.
//! The schema of a kind is the fold of its `table-schema-change` records in the same resource (kind_added,
//! field_added, field_type_changed, field_removed, index_added, index_removed, table_rebuilt), the history the old
//! engine kept beside its per-kind typed tables (`rt_*`) and carried into record store. A record's view is its stored value
//! projected onto the kind's fields by type, exactly as the old typed tables encoded a cell (`record-tables.mjs`
//! encode, then decode): `text` a string, `number` a finite number, `boolean` a boolean, `list` an array, `json` any
//! value. A value of another type is not coerced: the field reads null and is named in `mismatched`.
//!
//! Non-Negotiable Invariants:
//! - Nothing here writes. The schema is read from records the existing write path keeps, so a write of a schema
//!   change is the next read's schema.
//! - A store's schemas are folded once per committed state of the resource (`RecordStore::stamp`): any committed write to the
//!   resource folds again, so a view never answers from a schema older than the read.
//! - Events fold in their log order (the record's `sequence`), so a field removed and added again ends added.
//!
//! Key Concepts:
//! - Schema: kind -> {fields: field -> type, indexes}.
//! - View: one record's fields, typed per its kind's schema, and the fields whose stored value has another type.
//!
//! Security Considerations:
//! - The fold reads only `table-schema-change` records, which name kinds, fields and types, never record values. A
//!   view projects a value its caller already opened (`record_value`, sealed fields and erasure); it opens nothing.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use crate::{
    records::{Error, MAX_PAGE_ITEMS},
    storage::{record_store::RecordStore, Storage},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex, OnceLock},
};

/// The kind of the records that hold each kind's schema history.
pub const SCHEMA_KIND: &str = "table-schema-change";

/// A field's value type: the five JSON value classes the old typed tables stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    Text,
    Number,
    Boolean,
    List,
    Json,
}

impl FieldType {
    /// `value` as a cell of this type: itself when it has the type, None when it has another (null is no value).
    fn cell(self, value: &Value) -> Option<Value> {
        let fits = match self {
            Self::Text => value.is_string(),
            Self::Number => value.as_f64().is_some_and(f64::is_finite),
            Self::Boolean => value.is_boolean(),
            Self::List => value.is_array(),
            Self::Json => true,
        };
        fits.then(|| value.clone())
    }
}

/// One kind's typed schema.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct KindSchema {
    /// Each field and its current type.
    pub fields: BTreeMap<String, FieldType>,
    /// The kind's declared indexes, by name.
    pub indexes: BTreeSet<String>,
}

/// One record seen through its kind's schema.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
    /// Every schema field: its typed value, or null when the record has none or has one of another type.
    pub fields: Map<String, Value>,
    /// The fields whose stored value has another type than the schema's.
    pub mismatched: Vec<String>,
}

/// One schema history event as its record stores it.
#[derive(Deserialize)]
struct Event {
    kind: String,
    event: String,
    field: Option<String>,
    new_type: Option<FieldType>,
}

/// A supply of the account's own records that answers a kind's typed schema (the account's own records,
/// `local_account::own_records::OwnRead`): what a records read needs to answer a kind as a typed table.
pub trait KindSchemas {
    /// `kind`'s schema, None when its history names no such kind.
    fn kind_schema(&mut self, kind: &str) -> crate::record_value::Result<Option<KindSchema>>;
}

/// Fold schema history events, in log order, into each kind's schema. An event this fold does not know (a later
/// event name) changes nothing; a field event that names no field is refused.
pub fn fold<'a>(events: impl IntoIterator<Item = &'a str>) -> Result<BTreeMap<String, KindSchema>, Error> {
    let mut kinds: BTreeMap<String, KindSchema> = BTreeMap::new();
    for text in events {
        let event: Event = serde_json::from_str(text).map_err(|_| Error::Invalid("a schema change is unreadable", crate::cause!()))?;
        let schema = kinds.entry(event.kind).or_default();
        let field = || event.field.clone().ok_or(Error::Invalid("a field schema change names no field", crate::cause!()));
        match event.event.as_str() {
            "field_added" | "field_type_changed" => {
                let typed = event.new_type.ok_or(Error::Invalid("a field schema change names no type", crate::cause!()))?;
                schema.fields.insert(field()?, typed);
            }
            "field_removed" => {
                schema.fields.remove(&field()?);
            }
            "index_added" => {
                schema.indexes.insert(field()?);
            }
            "index_removed" => {
                schema.indexes.remove(&field()?);
            }
            _ => {}
        }
    }
    Ok(kinds)
}

impl KindSchema {
    /// `value` (an opened record value, a JSON object) projected onto this schema.
    pub fn view(&self, value: &Value) -> View {
        let mut fields = Map::new();
        let mut mismatched = Vec::new();
        for (name, typed) in &self.fields {
            let cell = match value.get(name).filter(|held| !held.is_null()) {
                None => Value::Null,
                Some(held) => typed.cell(held).unwrap_or_else(|| {
                    mismatched.push(name.clone());
                    Value::Null
                }),
            };
            fields.insert(name.clone(), cell);
        }
        View { fields, mismatched }
    }
}

/// Every kind's schema in `resource` of `account`'s store: folded once per committed state of the resource.
pub fn schemas<S: Storage>(store: &RecordStore<S>, account: &str, resource: &str) -> Result<Arc<BTreeMap<String, KindSchema>>, Error> {
    type Folded = HashMap<(String, String, String), (i64, Arc<BTreeMap<String, KindSchema>>)>;
    static FOLDED: OnceLock<Mutex<Folded>> = OnceLock::new();
    let stamp = store.stamp(account, resource)?;
    // A store with no file (memory) is never kept: its location names no state another store could share.
    let key = store.storage().location().map(|location| (location.to_owned(), account.to_owned(), resource.to_owned()));
    let folded = FOLDED.get_or_init(Mutex::default);
    if let Some(key) = &key {
        if let Some((at, kept)) = folded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(key) {
            if *at == stamp {
                return Ok(kept.clone());
            }
        }
    }
    let fresh = Arc::new(fold_store(store, account, resource)?);
    if let Some(key) = key {
        folded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key, (stamp, fresh.clone()));
    }
    Ok(fresh)
}

/// Read every schema history record of the resource and fold it in log order.
fn fold_store<S: Storage>(store: &RecordStore<S>, account: &str, resource: &str) -> Result<BTreeMap<String, KindSchema>, Error> {
    let mut events: Vec<(String, String)> = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let (ids, next) = store.ids_of_kind(account, resource, SCHEMA_KIND, before.as_deref(), MAX_PAGE_ITEMS)?;
        let asked: Vec<&str> = ids.iter().map(String::as_str).collect();
        for record in store.get_many(account, resource, &asked)?.into_iter().flatten() {
            let text = |field: &str| record.value.get(field).and_then(Value::as_str).map(str::to_owned);
            let sequence = text("sequence").ok_or(Error::Invalid("a schema change has no sequence", crate::cause!()))?;
            let stored = text("stored").ok_or(Error::Invalid("a schema change has no stored value", crate::cause!()))?;
            events.push((sequence, stored));
        }
        match next {
            Some(next) => before = Some(next),
            None => break,
        }
    }
    events.sort();
    fold(events.iter().map(|(_, stored)| stored.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        records::{Mutation, Records},
        storage::{memory::Memory, record_store::RealClock},
    };
    use serde_json::json;

    fn change(kind: &str, event: &str, field: Option<&str>, new_type: Option<&str>) -> String {
        json!({"kind": kind, "event": event, "field": field, "old_type": null, "new_type": new_type, "changed_at": "2026-10-11T00:00:00.000Z"})
            .to_string()
    }

    #[test]
    fn a_kinds_schema_is_its_history_folded_in_log_order() {
        let history = [
            change("record:habit", "kind_added", None, None),
            change("record:habit", "field_added", Some("title"), Some("text")),
            change("record:habit", "field_added", Some("streak"), Some("number")),
            change("record:habit", "field_added", Some("photo"), Some("text")),
            change("record:habit", "field_removed", Some("photo"), None),
            change("record:habit", "field_type_changed", Some("streak"), Some("json")),
            change("record:habit", "index_added", Some("title"), None),
            change("record:habit", "table_rebuilt", None, None),
            change("record:note", "field_added", Some("done"), Some("boolean")),
        ];
        let kinds = fold(history.iter().map(String::as_str)).unwrap();
        let habit = &kinds["record:habit"];
        assert_eq!(habit.fields, BTreeMap::from([("title".into(), FieldType::Text), ("streak".into(), FieldType::Json)]));
        assert_eq!(habit.indexes, BTreeSet::from(["title".to_owned()]));
        assert_eq!(kinds["record:note"].fields["done"], FieldType::Boolean);
        // A field event that names no field refuses the whole fold.
        assert!(fold([change("record:x", "field_added", None, Some("text")).as_str()]).is_err());
    }

    #[test]
    fn a_view_keeps_each_value_of_its_fields_type_and_names_the_others() {
        let schema = KindSchema {
            fields: BTreeMap::from([
                ("title".into(), FieldType::Text),
                ("count".into(), FieldType::Number),
                ("done".into(), FieldType::Boolean),
                ("tags".into(), FieldType::List),
                ("extra".into(), FieldType::Json),
                ("absent".into(), FieldType::Text),
            ]),
            indexes: BTreeSet::new(),
        };
        let view = schema.view(&json!({"title": "a", "count": "7", "done": true, "tags": ["x"], "extra": {"k": 1}, "other": 1}));
        assert_eq!(
            Value::Object(view.fields),
            json!({"title": "a", "count": null, "done": true, "tags": ["x"], "extra": {"k": 1}, "absent": null})
        );
        assert_eq!(view.mismatched, vec!["count".to_owned()]);
    }

    #[test]
    fn a_stores_schemas_are_read_from_its_history_records_and_follow_a_new_change() {
        let limits = crate::storage::record_store::settings::Limits::fixed(1 << 20, 10 << 30);
        let mut store = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap();
        let put = |store: &mut RecordStore<Memory>, id: &str, sequence: &str, stored: String| {
            let body = json!({"kind": SCHEMA_KIND, "sequence": sequence, "stored": stored, "meta": null, "protected": false});
            let write = Mutation { id: id.into(), expected_version: 0, request_key: id.into(), deleted: false, value: body };
            store.mutate("account", "own-records", write).unwrap();
        };
        // Written out of log order: the fold orders by sequence, not by id or write.
        put(&mut store, "table-schema-change:b", "002", change("record:habit", "field_removed", Some("title"), None));
        put(&mut store, "table-schema-change:a", "001", change("record:habit", "field_added", Some("title"), Some("text")));
        put(&mut store, "table-schema-change:c", "003", change("record:habit", "field_added", Some("streak"), Some("number")));
        let kinds = schemas(&store, "account", "own-records").unwrap();
        assert_eq!(kinds["record:habit"].fields, BTreeMap::from([("streak".into(), FieldType::Number)]));
        put(&mut store, "table-schema-change:d", "004", change("record:habit", "field_added", Some("title"), Some("text")));
        assert_eq!(schemas(&store, "account", "own-records").unwrap()["record:habit"].fields.len(), 2);
    }
}
