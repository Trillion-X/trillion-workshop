// Purpose: Load and validate the DATA declarations of every stored family once, from every declared families file
// (`FILES`: the shared `families.json` and each owner's own, such as `record_store/families.json`), and answer the boundary's
// lookups: which schema, which family, which key, fields and orders exist.
//
// Non-Negotiable Invariants:
// - The DATA files are the only list of families. Code never names a table, column or index of its own.
// - Files merge by schema: a schema declared in several files holds the union of their families, and a family name
//   declared twice in one schema refuses every lookup, so each family is declared in exactly one place.
// - Every identifier is lowercase ASCII `[a-z_][a-z0-9_]*`, at most 80 bytes (a family laid out while running is named `rt_` and a
//   64-digit hash), unique within its scope, so a supply may quote it.
// - A family's key fields and order fields are declared fields; an order is never empty.
// - A malformed DATA file fails every lookup (`Error::Undeclared`); it is never partly accepted.
//
// Key Concepts:
// - Schema: the families of one kind of storage (one account policy store, one R2 inventory ledger, ...).
// - Family: key, fields, named orders (optionally partial: only rows whose fields hold given values), whether it
//   keeps arrival order, and the readers that justify it (CP1).
//
// Security Considerations:
// - Validation here is what lets a supply build statements from names without injection.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{Error, Result};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};

/// Every families file. An owner whose families change with its own code keeps them in its own file, so two owners never
/// edit one DATA file; adding a file is a row here.
const FILES: [&[u8]; 6] = [include_bytes!("families.json"), include_bytes!("record_store/families.json"), include_bytes!("method_effect_families.json"), include_bytes!("../account_files/families.json"), include_bytes!("../account_rights/families.json"), include_bytes!("../account/rows/families.json")];
/// Families only the unit tests declare; never compiled into a shipped build.
#[cfg(test)]
const TEST_DATA: &[u8] = include_bytes!("test-families.json");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(rename = "_what")]
    _what: String,
    schemas: Vec<Schema>,
}

/// The families of one kind of storage.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    pub schema: String,
    #[serde(rename = "_what")]
    pub what: String,
    pub families: Vec<Family>,
}

/// One stored family: one declaration row.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Family {
    pub family: String,
    /// The fields whose values identify one row, in order.
    pub key: Vec<String>,
    /// Every readable and writable field, key fields included.
    pub fields: Vec<String>,
    /// Named secondary orders.
    #[serde(default)]
    pub orders: BTreeMap<String, OrderDeclaration>,
    /// Whether the family keeps the order rows arrived in (`Order::Arrival`).
    #[serde(default)]
    pub arrival: bool,
    /// The source files that read this family, the reason it is stored.
    pub readers: Vec<String>,
    /// When a SQL supply makes this family's table (DATA per family; `sqlite.rs` `declared_tables`).
    #[serde(default)]
    pub made: Made,
}
/// When a SQL supply makes a family's table and indexes.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Made {
    /// When the store opens (every family declared before this choice existed).
    #[default]
    Open,
    /// By the first write that puts a row in it; until then it reads as empty and an erase changes nothing.
    /// Ported from old trillion `src/hosts/schema-on-first-write.mjs` (see `sqlite/first_write.rs`).
    FirstWrite,
}
/// One named order: its cursor fields, and the rows it holds (all rows, or only rows whose named fields hold a value).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderDeclaration {
    pub fields: Vec<String>,
    /// The order holds only rows matching every condition (a partial order, e.g. live rows only).
    #[serde(default)]
    pub only: Vec<Only>,
}
/// A row condition of a partial order: `field` holds exactly `equals` (`null` matches a null field), or, with
/// `not`, anything else (`IS NOT`: a null field differs from every non-null value).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Only {
    pub field: String,
    pub equals: serde_json::Value,
    #[serde(default)]
    pub not: bool,
}

impl Family {
    pub fn has(&self, field: &str) -> bool {
        self.fields.iter().any(|known| known == field)
    }
    /// A declared named order.
    pub fn order(&self, name: &str) -> Result<&OrderDeclaration> {
        self.orders.get(name).ok_or(crate::cause!(Error::Undeclared))
    }
}
impl Schema {
    /// A declared family of this schema: one of its DATA rows, else a family an owner laid out while the program runs under this
    /// schema (`runtime_family`).
    pub fn family(&self, name: &str) -> Result<&Family> {
        match self.families.iter().find(|family| family.family == name) {
            Some(family) => Ok(family),
            None => runtime(&self.schema, name).ok_or(crate::cause!(Error::Undeclared)),
        }
    }
}

/// Families laid out while the program runs, by (schema, family): the newest layout of each. A layout is leaked once per change of
/// shape (a kind's typed table gains a field, changes a type, gains an index), never per write, so the registry grows
/// with schema changes only.
fn runtime_families() -> &'static std::sync::RwLock<BTreeMap<(String, String), &'static Family>> {
    static RUNTIME: OnceLock<std::sync::RwLock<BTreeMap<(String, String), &'static Family>>> = OnceLock::new();
    RUNTIME.get_or_init(Default::default)
}
fn runtime(schema: &str, family: &str) -> Option<&'static Family> {
    runtime_families().read().ok()?.get(&(schema.to_string(), family.to_string())).copied()
}

/// Lay out one family while the program runs, under a declared schema: the generic operations of every supply then reach it like a
/// DATA row. Its owner (`sqlite/record_tables.rs`, a kind whose declaration says `"table": true`) makes or changes the
/// physical table first. The family is validated by the same rules as a DATA row; a name a DATA row of the schema
/// declares is refused, so a family laid out while running never shadows a declared one. Laying out the same shape again keeps the
/// layout already held.
pub fn runtime_family(schema: &str, family: Family) -> Result<&'static Family> {
    let declared = self::schema(schema)?;
    if declared.families.iter().any(|known| known.family == family.family) {
        return Err(crate::cause!(Error::Invalid));
    }
    let checked = validate(File { _what: String::new(), schemas: vec![Schema { schema: schema.to_string(), what: String::new(), families: vec![family] }] })
        .ok_or(crate::cause!(Error::Invalid))?
        .pop()
        .and_then(|mut one| one.families.pop())
        .ok_or(crate::cause!(Error::Invalid))?;
    let mut held = runtime_families().write().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let key = (schema.to_string(), checked.family.clone());
    if let Some(known) = held.get(&key) {
        if same_shape(known, &checked) {
            return Ok(known);
        }
    }
    let leaked: &'static Family = Box::leak(Box::new(checked));
    held.insert(key, leaked);
    Ok(leaked)
}
fn same_shape(one: &Family, other: &Family) -> bool {
    one.key == other.key
        && one.fields == other.fields
        && one.arrival == other.arrival
        && one.orders.len() == other.orders.len()
        && one.orders.iter().zip(&other.orders).all(|((a, x), (b, y))| a == b && x.fields == y.fields && x.only.len() == y.only.len())
}

fn identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'_'))
        && bytes.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
        && name.len() <= 80
}
fn unique<'a>(names: impl IntoIterator<Item = &'a String>) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    names.into_iter().all(|name| identifier(name) && seen.insert(name))
}

/// One file of every declared file: a schema named in several files gets the union of their families (in file order) and
/// their descriptions joined; `validate` then refuses a family name that appears twice.
fn merge(files: Vec<File>) -> File {
    let mut merged: Vec<Schema> = Vec::new();
    for schema in files.into_iter().flat_map(|file| file.schemas) {
        match merged.iter_mut().find(|known| known.schema == schema.schema) {
            Some(known) => {
                known.what = format!("{} {}", known.what, schema.what);
                known.families.extend(schema.families);
            }
            None => merged.push(schema),
        }
    }
    File { _what: String::new(), schemas: merged }
}

fn validate(file: File) -> Option<Vec<Schema>> {
    if !unique(file.schemas.iter().map(|schema| &schema.schema)) {
        return None;
    }
    for schema in &file.schemas {
        if schema.families.is_empty() || !unique(schema.families.iter().map(|family| &family.family)) {
            return None;
        }
        for family in &schema.families {
            let valid = !family.key.is_empty()
                && !family.readers.is_empty()
                && unique(&family.fields)
                && unique(&family.key)
                && family.key.iter().all(|field| family.has(field))
                && family.orders.iter().all(|(name, order)| {
                    identifier(name)
                        && !order.fields.is_empty()
                        && unique(&order.fields)
                        && order.fields.iter().all(|f| family.has(f))
                        && order.only.iter().all(|only| {
                            family.has(&only.field) && (only.equals.is_null() || only.equals.is_string() || only.equals.is_i64())
                        })
                });
            if !valid {
                return None;
            }
        }
    }
    Some(file.schemas)
}

fn schemas() -> Result<&'static [Schema]> {
    static LOADED: OnceLock<Option<Vec<Schema>>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            #[cfg_attr(not(test), allow(unused_mut))]
            let mut files = FILES.iter().map(|data| serde_json::from_slice::<File>(data).ok()).collect::<Option<Vec<_>>>()?;
            #[cfg(test)]
            files.push(serde_json::from_slice::<File>(TEST_DATA).ok()?);
            validate(merge(files))
        })
        .as_deref()
        .ok_or(crate::cause!(Error::Undeclared))
}

/// The declared schema named `name`.
pub fn schema(name: &str) -> Result<&'static Schema> {
    schemas()?.iter().find(|schema| schema.schema == name).ok_or(crate::cause!(Error::Undeclared))
}

#[cfg(test)]
mod merge_tests {
    use super::{merge, validate, File};

    fn file(schema: &str, families: &[&str]) -> File {
        let families: Vec<String> = families
            .iter()
            .map(|name| format!(r#"{{"family":"{name}","key":["k"],"fields":["k"],"readers":["src/storage/schema.rs"]}}"#))
            .collect();
        let text = format!(r#"{{"_what":"t","schemas":[{{"schema":"{schema}","_what":"t","families":[{}]}}]}}"#, families.join(","));
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn a_schema_spans_files_and_a_family_declared_twice_refuses() {
        let merged = validate(merge(vec![file("one", &["a", "b"]), file("one", &["c"]), file("two", &["a"])])).unwrap();
        let one = merged.iter().find(|schema| schema.schema == "one").unwrap();
        assert_eq!(one.families.iter().map(|family| family.family.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
        assert!(validate(merge(vec![file("one", &["a", "b"]), file("one", &["b"])])).is_none(), "b is declared twice");
    }
}
