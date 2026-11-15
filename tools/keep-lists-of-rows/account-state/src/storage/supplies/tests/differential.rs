// src/storage/supplies/tests/differential.rs
//
// Purpose: Hold a supply to the whole `Storage` contract, not only the parts the record store happens to use. The same
// random operations run against the SQLite supply (the production supply, the reference) and against the supply under
// test, and every answer, error and final row must be equal.
//
// Non-Negotiable Invariants:
// - Both supplies see the identical operation stream from one random start; any difference in an answer is reported with the
//   random start, the step and the operation, so it replays.
// - Operations cover every `When`, every order of the families (key, named, partial, arrival), prefix bounds that
//   include NULL, reverse walks, limits, bounded reads, erase, scopes (begin, nested, commit, rollback), batch reads
//   (`read_many`: point gets with repeated and absent keys mixed with ranges) and batch writes (`write_many`, whose refusals must leave the writes
//   before them done and the scope usable, as asked one at a time).
// - Arrival positions are compared by order only: how a rolled-back insert numbers its successor is not part of the
//   contract (SQLite reuses the rowid, a Postgres identity does not), so neither reads nor bounds name a position.
// - A key field is never NULL: SQLite refuses it in a WITHOUT ROWID key.
//
// Key Concepts:
// - `STORAGE_SUPPLY` and `STORAGE_URL` choose the supply; `DIFFERENTIAL_STEPS` and `DIFFERENTIAL_SEEDS` size the run.
//
// Security Considerations:
// - Scratch store names on a local throwaway server only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use local_engine::storage::{
    sqlite::{self, Bounds, Spend},
    Bound, Intent, Order, Query, Range, Read, Row, Storage, Value, When, Write, ARRIVAL,
};
use std::time::Duration;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// A value for a field of the families under test; small domains so keys collide and ranges select something.
fn value(rng: &mut Rng, field: &str) -> Value {
    match field {
        "account" => Value::from(*rng.pick(&["a", "b"])),
        "resource" => Value::from(*rng.pick(&["r", "s"])),
        "id" | "record_id" | "permit_id" => Value::from(*rng.pick(&["i0", "i1", "i2", "i3", "i4", "i5", "i\0x"])),
        "valid_to" => Value::Integer(*rng.pick(&[1, 2, 3, i64::MAX])),
        "valid_from" | "version" => {
            if rng.below(5) == 0 {
                Value::Null
            } else {
                Value::Integer(rng.below(4) as i64)
            }
        }
        "deleted" => Value::Integer(rng.below(2) as i64),
        "kind" | "state" => {
            if rng.below(4) == 0 {
                Value::Null
            } else {
                Value::from(*rng.pick(&["k1", "k2", "k3"]))
            }
        }
        "body" | "payload" | "envelopes" => match rng.below(4) {
            0 => Value::Null,
            1 => Value::Text("text body".into()),
            2 => Value::Blob(vec![0, 1, 2, 0xFF, 0]),
            _ => Value::Blob(vec![7; 1 + rng.below(40)]),
        },
        "id_log" => Value::Integer(rng.below(6) as i64),
        _ => match rng.below(4) {
            0 => Value::Null,
            1 => Value::Integer(rng.below(3) as i64),
            2 => Value::from(*rng.pick(&["x", "y", "z"])),
            _ => Value::Blob(vec![rng.below(256) as u8]),
        },
    }
}

/// A value for a key field: never NULL.
fn key_value(rng: &mut Rng, field: &str) -> Value {
    loop {
        let one = value(rng, field);
        if !one.is_null() {
            return one;
        }
    }
}

/// One random put: its row, the conditions of a compare-and-set, and which `When` it asks.
struct Put {
    row: Vec<(String, Value)>,
    conditions: Vec<(String, Value)>,
    kind: usize,
    insert_only: bool,
}
impl Put {
    fn random(rng: &mut Rng, shape: &Shape) -> Self {
        let mut row: Vec<(String, Value)> = shape.key.iter().map(|field| (field.clone(), key_value(rng, field))).collect();
        let others: Vec<&String> = shape.fields.iter().filter(|field| !shape.key.contains(field)).collect();
        // A family whose fields are all key fields can only be inserted; a put that changes nothing is not asked.
        let count = if others.is_empty() { 0 } else { 1 + rng.below(others.len().min(4)) };
        for _ in 0..count {
            let field = *rng.pick(&others);
            if !row.iter().any(|(name, _)| name == field) {
                row.push((field.clone(), value(rng, field)));
            }
        }
        let conditions: Vec<(String, Value)> = if others.is_empty() {
            Vec::new()
        } else {
            (0..rng.below(3))
                .map(|_| {
                    let field = *rng.pick(&others);
                    (field.clone(), value(rng, field))
                })
                .collect()
        };
        Self { row, conditions, kind: rng.below(4), insert_only: others.is_empty() }
    }
    fn row(&self) -> Vec<(&str, Value)> {
        self.row.iter().map(|(field, one)| (field.as_str(), one.clone())).collect()
    }
    fn conditions(&self) -> Vec<(&str, Value)> {
        self.conditions.iter().map(|(field, one)| (field.as_str(), one.clone())).collect()
    }
    fn when<'a>(&self, conditions: &'a [(&'a str, Value)]) -> When<'a> {
        match (self.insert_only, self.kind) {
            (true, 0 | 1) => When::Absent,
            (true, _) => When::New,
            (false, 0) => When::Always,
            (false, 1) => When::Absent,
            (false, 2) => When::New,
            (false, _) => When::Matches(conditions),
        }
    }
}

fn describe(op: &str, detail: String) -> String {
    format!("{op} {detail}")
}

/// One family under test: its fields, its key, its named orders with their cursor fields, and whether it has arrival.
struct Shape {
    family: &'static str,
    fields: Vec<String>,
    key: Vec<String>,
    orders: Vec<(String, Vec<String>)>,
    arrival: bool,
}

fn shapes(schema: &'static local_engine::storage::Schema, families: &[&'static str]) -> Vec<Shape> {
    families
        .iter()
        .map(|name| {
            let family = schema.family(name).expect("declared family");
            Shape {
                family: name,
                fields: family.fields.clone(),
                key: family.key.clone(),
                orders: family.orders.iter().map(|(order, declaration)| (order.clone(), declaration.fields.clone())).collect(),
                arrival: family.arrival,
            }
        })
        .collect()
}

fn bound(rng: &mut Rng, cursor: &[String], arrival: bool) -> Bound {
    match rng.below(5) {
        0 | 1 => Bound::Unbounded,
        _ if arrival => Bound::Unbounded,
        kind => {
            let length = 1 + rng.below(if arrival { 1 } else { cursor.len() });
            let values: Vec<Value> = if arrival {
                vec![Value::Integer(rng.below(8) as i64)]
            } else {
                cursor[..length]
                    .iter()
                    .map(|field| if rng.below(30) == 0 { Value::Null } else { value(rng, field) })
                    .collect()
            };
            if kind == 2 {
                Bound::Included(values)
            } else {
                Bound::Excluded(values)
            }
        }
    }
}

fn range<'a>(rng: &mut Rng, shape: &'a Shape, limit: bool) -> Range<'a> {
    let choices = 1 + shape.orders.len() + usize::from(shape.arrival);
    let pick = rng.below(choices);
    let (order, cursor, arrival): (Order<'a>, Vec<String>, bool) = if pick == 0 {
        (Order::Key, shape.key.clone(), false)
    } else if pick <= shape.orders.len() {
        let (name, fields) = &shape.orders[pick - 1];
        (Order::Named(name.as_str()), fields.clone(), false)
    } else {
        (Order::Arrival, vec![ARRIVAL.to_owned()], true)
    };
    Range {
        order,
        from: bound(rng, &cursor, arrival),
        to: bound(rng, &cursor, arrival),
        reverse: rng.below(2) == 0,
        limit: if limit && rng.below(2) == 0 { Some(1 + rng.below(5)) } else { None },
    }
}

fn reads<'a>(rng: &mut Rng, shape: &'a Shape) -> Vec<Read<'a>> {
    let mut reads = Vec::new();
    for field in &shape.fields {
        if rng.below(2) == 0 {
            reads.push(if rng.below(4) == 0 { Read::at_most(field, 3) } else { Read::whole(field) });
        }
    }
    if reads.is_empty() {
        reads.push(Read::whole(&shape.fields[0]));
    }
    reads
}

fn same<T: PartialEq + std::fmt::Debug>(left: &T, right: &T, random_start: u64, step: usize, op: &str) -> Result<(), String> {
    if left == right {
        Ok(())
    } else {
        Err(format!("random start {random_start} step {step}: {op}\n  reference: {left:?}\n  supply:    {right:?}"))
    }
}

fn reference_supply(schema: &str, random_start: u64) -> (tempfile::TempDir, sqlite::Supply<rusqlite::Connection>) {
    let dir = tempfile::tempdir().expect("scratch folder");
    // The SQLite supply refuses a path through a symbolic link (macOS /var is one), so the folder is named by its real path.
    let path = dir.path().canonicalize().expect("real path").join(format!("reference-{random_start}.sqlite"));
    let bounds = Bounds { value_bytes: 2 * 1024 * 1024, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) };
    let supply = sqlite::open_owned(&path, schema, bounds).expect("SQLite supply");
    (dir, supply)
}

fn run(random_start: u64, steps: usize, schema_name: &str, families: &[&'static str], supply: &dyn Storage) -> Result<(), String> {
    let (_scratch, reference) = reference_supply(schema_name, random_start);
    let shapes = shapes(supply.schema(), families);
    let mut rng = Rng(random_start.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut depth = 0usize;
    for step in 0..steps {
        let shape = &shapes[rng.below(shapes.len())];
        let storages: [&dyn Storage; 2] = [&reference, supply];
        match rng.below(24) {
            0..=7 => {
                let put = Put::random(&mut rng, shape);
                let (row_refs, condition_refs) = (put.row(), put.conditions());
                let when = put.when(&condition_refs);
                let op = describe("put", format!("{} {row_refs:?} {when:?}", shape.family));
                let answers: Vec<_> = storages.iter().map(|s| s.put(shape.family, &row_refs, when)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            8..=9 => {
                let key: Vec<Value> = shape.key.iter().map(|field| key_value(&mut rng, field)).collect();
                let read = reads(&mut rng, shape);
                let op = describe("get", format!("{} {key:?} {read:?}", shape.family));
                let answers: Vec<_> = storages.iter().map(|s| s.get(shape.family, &key, &read)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            10..=13 => {
                let range = range(&mut rng, shape, true);
                let read = reads(&mut rng, shape);
                let op = describe("scan", format!("{} {range:?} {read:?}", shape.family));
                let answers: Vec<Result<Vec<Row>, _>> = storages.iter().map(|s| s.scan(shape.family, &range, &read)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            14..=15 => {
                let range = range(&mut rng, shape, true);
                let op = describe("count", format!("{} {range:?}", shape.family));
                let answers: Vec<_> = storages.iter().map(|s| s.count(shape.family, &range)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            16 => {
                let range = range(&mut rng, shape, false);
                let op = describe("erase", format!("{} {range:?}", shape.family));
                let answers: Vec<_> = storages.iter().map(|s| s.erase(shape.family, &range)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            17 => {
                let intent = if depth == 0 { Intent::Write } else { Intent::Nested };
                let op = describe("open_scope", format!("{intent:?} at depth {depth}"));
                let answers: Vec<_> = storages.iter().map(|s| s.open_scope(intent)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
                if answers[0].is_ok() {
                    depth += 1;
                }
            }
            18 | 19 if depth > 0 => {
                let commit = rng.below(2) == 0;
                let op = describe("close_scope", format!("commit {commit} at depth {depth}"));
                let answers: Vec<_> = storages.iter().map(|s| s.close_scope(commit)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
                depth -= 1;
            }
            20..=21 => {
                // Keys asked together: some repeated, some from the rows the run has written, some absent.
                let keys: Vec<Vec<Value>> = (0..1 + rng.below(5)).map(|_| shape.key.iter().map(|field| key_value(&mut rng, field)).collect()).collect();
                let keys: Vec<Vec<Value>> = keys.iter().cloned().chain(keys.first().cloned()).collect();
                let read = reads(&mut rng, shape);
                // A range among the gets, at a random place: the batch answers each as asked alone, in order.
                let walk = range(&mut rng, shape, true);
                let at = rng.below(keys.len() + 1);
                let mut queries: Vec<Query<'_>> = keys.iter().map(|key| Query::Get { family: shape.family, key, read: &read }).collect();
                queries.insert(at, Query::Scan { family: shape.family, range: &walk, read: &read });
                let op = describe("read_many", format!("{} {queries:?}", shape.family));
                let answers: Vec<_> = storages.iter().map(|s| s.read_many(&queries)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            22..=23 => {
                // A batch of puts and erases; a refusal in the middle (a `New` on a held key) must leave the writes
                // before it done and the scope usable.
                let puts: Vec<Put> = (0..1 + rng.below(4)).map(|_| Put::random(&mut rng, shape)).collect();
                let rows: Vec<Vec<(&str, Value)>> = puts.iter().map(Put::row).collect();
                let conditions: Vec<Vec<(&str, Value)>> = puts.iter().map(Put::conditions).collect();
                let erase = range(&mut rng, shape, false);
                let mut writes: Vec<Write<'_>> =
                    puts.iter().enumerate().map(|(at, put)| Write::Put { family: shape.family, row: &rows[at], when: put.when(&conditions[at]) }).collect();
                if rng.below(2) == 0 {
                    let at = rng.below(writes.len() + 1);
                    writes.insert(at, Write::Erase { family: shape.family, range: &erase });
                }
                let op = describe("write_many", format!("{} {writes:?}", shape.family));
                let answers: Vec<_> = storages.iter().map(|s| s.write_many(&writes)).collect();
                same(&answers[0], &answers[1], random_start, step, &op)?;
            }
            _ => {}
        }
        same(&reference.scoped(), &supply.scoped(), random_start, step, "scoped")?;
        same(&reference.writing().ok(), &supply.writing().ok(), random_start, step, "writing")?;
    }
    while depth > 0 {
        reference.close_scope(true).map_err(|e| format!("{e:?}"))?;
        supply.close_scope(true).map_err(|e| format!("{e:?}"))?;
        depth -= 1;
    }
    for shape in &shapes {
        let read: Vec<Read<'_>> = shape.fields.iter().map(|field| Read::whole(field)).collect();
        let everything = [Order::Key].into_iter().chain(shape.orders.iter().map(|(name, _)| Order::Named(name))).chain(shape.arrival.then_some(Order::Arrival));
        for order in everything {
            for reverse in [false, true] {
                let range = Range { order, from: Bound::Unbounded, to: Bound::Unbounded, reverse, limit: None };
                let op = describe("final scan", format!("{} {range:?}", shape.family));
                same(&reference.scan(shape.family, &range, &read), &supply.scan(shape.family, &range, &read), random_start, steps, &op)?;
            }
        }
    }
    Ok(())
}

fn supply_for(schema: &str, random_start: u64) -> storage_supplies::Dynamic {
    let kind = std::env::var("STORAGE_SUPPLY").expect("STORAGE_SUPPLY names the supply under test");
    let url = std::env::var("STORAGE_URL").expect("STORAGE_URL names the server");
    let store_name = format!("d{}_{}_{}_{}", std::process::id(), schema, random_start, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() % 100_000_000));
    storage_supplies::open_schema(&kind, &url, &store_name, schema).unwrap_or_else(|error| panic!("{kind} at {url}: {error}"))
}

fn campaign(schema: &str, families: &[&'static str]) {
    let steps: usize = std::env::var("DIFFERENTIAL_STEPS").ok().and_then(|text| text.parse().ok()).unwrap_or(400);
    let random_starts: u64 = std::env::var("DIFFERENTIAL_SEEDS").ok().and_then(|text| text.parse().ok()).unwrap_or(8);
    let mut failures = Vec::new();
    for random_start in 1..=random_starts {
        let supply = supply_for(schema, random_start);
        if let Err(difference) = run(random_start, steps, schema, families, &supply) {
            failures.push(difference);
        }
    }
    println!("differential {schema}: {random_starts} random starts x {steps} steps, {} with a difference", failures.len());
    for failure in failures.iter().take(3) {
        println!("{failure}");
    }
    assert!(failures.is_empty(), "{} of {random_starts} random starts differ from the reference supply", failures.len());
}

#[test]
fn versions_family_with_partial_orders_equals_the_reference() {
    campaign("record_store", &["versions", "custody", "ordered", "order_state"]);
}

#[test]
fn arrival_and_named_orders_equal_the_reference() {
    campaign("record_log", &["record_log", "resource_behavior_commands", "record_keys_meta"]);
}

/// The mark moves for another handle's commit and never for this handle's own (as SQLite's `data_version`), outside a
/// scope and inside a write scope, so an owner that caches what it read (the record store's stamps and search memory)
/// keeps its cache across its own writes and drops it when another handle wrote.
#[test]
fn the_mark_moves_for_other_handles_commits_only() {
    let kind = std::env::var("STORAGE_SUPPLY").expect("STORAGE_SUPPLY names the supply under test");
    let url = std::env::var("STORAGE_URL").expect("STORAGE_URL names the server");
    let store_name = format!("m{}_{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() % 100_000_000));
    let own = storage_supplies::open_schema(&kind, &url, &store_name, "record_log").unwrap_or_else(|error| panic!("{kind} at {url}: {error}"));
    let other = storage_supplies::open_schema(&kind, &url, &store_name, "record_log").unwrap_or_else(|error| panic!("{kind} at {url}: {error}"));
    let row = |key: &str, value: &str| vec![("key", Value::from(key)), ("value", Value::from(value))];
    let write = |handle: &dyn Storage, key: &str, value: &str| {
        handle.open_scope(Intent::Write).unwrap();
        let inside = handle.mark().unwrap();
        handle.put("record_keys_meta", &row(key, value), When::Always).unwrap();
        handle.close_scope(true).unwrap();
        inside
    };
    let first = own.mark().unwrap();
    assert_eq!(write(&own, "a", "1"), first, "a write scope's own opening does not move the mark");
    assert_eq!(own.mark().unwrap(), first, "this handle's own commit does not move its mark");
    write(&own, "b", "2");
    let inside_own_nested = {
        own.open_scope(Intent::Write).unwrap();
        own.open_scope(Intent::Nested).unwrap();
        own.put("record_keys_meta", &row("c", "3"), When::Always).unwrap();
        own.close_scope(true).unwrap();
        let mark = own.mark().unwrap();
        own.close_scope(true).unwrap();
        mark
    };
    assert_eq!(inside_own_nested, first);
    assert_eq!(own.mark().unwrap(), first, "own commits, plain and nested, leave the mark where it was");
    let rolled = {
        own.open_scope(Intent::Write).unwrap();
        own.put("record_keys_meta", &row("d", "4"), When::Always).unwrap();
        own.close_scope(false).unwrap();
        own.mark().unwrap()
    };
    assert_eq!(rolled, first, "a rolled-back write moves nothing");
    write(&other, "e", "5");
    let moved = own.mark().unwrap();
    assert_ne!(moved, first, "another handle's commit moves the mark");
    own.open_scope(Intent::Write).unwrap();
    assert_eq!(own.mark().unwrap(), moved, "inside a write scope the mark covers every commit before it");
    own.close_scope(false).unwrap();
    write(&own, "f", "6");
    assert_eq!(own.mark().unwrap(), moved);
}
