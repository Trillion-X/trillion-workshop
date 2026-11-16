//! Current product record store, not the historical simulator's cur/log implementation.
//!
//! Every data operation below calls the product record/storage API with shipped
//! record store settings. SQLite statements, scan visits and changed table rows come from
//! its actual `WorkMeter`. Secondary-index invoice units are deliberately absent:
//! `total_changes` does not measure them. This is the storage slice, not account
//! routing, native admission, provider conformance or full tool execution.
//!
//! The harness is the client: it retains each prepared CAS mutation across a
//! store crash, exactly as a client retains an immutable retry request. It never
//! supplies a saved answer or stored value after crash. Product receipt recovery
//! must return the original committed change. Mid-statement interruption and
//! owner-wide physical erasure are unsupported rather than falsely simulated.

use local_engine::{
    records::{Mutation, Records},
    scan::ReadWork,
    sqlite_work::WorkMeter,
    storage::{
        record_store::{
            self,
            settings::{self, Volume},
            Clock, record store,
        },
        sqlite, Storage,
    },
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use workload_simulation::{
    candidate::MeterDefinition, Candidate, Capability, ExtendedIntent, Intent, Interrupt, Meters,
    Opened, Operation, Outcome, Reply, SimTime, Store, StoreContext, StoreError,
};

const ACCOUNT: &str = "simulation-account";
const RESOURCE: &str = "own-records";
const METERS: &[&str] = &[
    "sql_statements",
    "scan_visits",
    "fullscan_steps",
    "vm_steps",
    "rows_returned",
    "row_changes",
    "table_rows_written",
    "bytes_stored",
];
type Product = record store<sqlite::Supply<sqlite::Handle>>;
fn err(e: impl std::fmt::Display) -> StoreError {
    StoreError(e.to_string())
}
#[derive(Clone)]
struct SimClock(Arc<AtomicU64>);
impl Clock for SimClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

pub struct ProductRecordStore {
    id: String,
}
impl ProductRecordStore {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        if params != json!({}) {
            return Err(err(
                "current product candidate takes no overrides; shipped settings are measured",
            ));
        }
        Ok(Self { id })
    }
}
impl Candidate for ProductRecordStore {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "Actual local_engine::storage::record_store over owned observed SQLite; shipped settings; storage slice only; index invoice units, mid-statement faults and physical owner erasure unmeasured".into()
    }
    fn meters(&self) -> Vec<&'static str> {
        METERS.to_vec()
    }
    fn meter_definitions(&self) -> Vec<MeterDefinition> {
        vec![
            MeterDefinition::counter("sql_statements", "sqlite_statement", "product_sqlite_work_meter"),
            MeterDefinition::counter("scan_visits", "sqlite_scan_visit", "product_sqlite_work_meter"),
            MeterDefinition::counter("fullscan_steps", "sqlite_fullscan_step", "product_sqlite_work_meter"),
            MeterDefinition::counter("vm_steps", "sqlite_virtual_machine_step", "product_sqlite_work_meter"),
            MeterDefinition::counter("rows_returned", "sqlite_row_returned", "product_sqlite_work_meter"),
            MeterDefinition::counter("row_changes", "sqlite_row_change", "product_sqlite_work_meter"),
            MeterDefinition::counter("table_rows_written", "sqlite_table_row_write", "product_sqlite_work_meter"),
            MeterDefinition::gauge("bytes_stored", "byte", "product_record_store_storage_gauge"),
        ]
    }
    fn capabilities(&self) -> Vec<Capability> {
        [("actual_product_record_store", true, "Actual product record store and SQLite supply, not a separate candidate implementation"),
         ("immutable_retry", true, "Client retains original CAS payload; product retains receipts"),
         ("newest_list", true, "Mapped through actual product changes feed, paging and filtering, not kind-id order"),
         ("bounded_key_page", true, "Mapped to the product Records::list_page API with its continuation cursor"),
         ("history", true, "Actual product history within the shipped retention horizon"),
         ("index_entries_written", false, "Product WorkMeter counts table changes, not secondary index entry changes"),
         ("mid_statement_interrupt", false, "No hook override of the product-owned progress/budget callback"),
         ("erase_owner", false, "Product erase enters custody; immediate physical owner erasure is not this API's contract"),
         ("account_routing_and_tools", false, "This candidate measures the product storage slice only")]
        .into_iter().map(|(name,supported,note)| Capability { name:name.into(), supported, note:note.into() }).collect()
    }
    fn params(&self) -> Value {
        json!({"settings":"product shipped", "coverage":"storage_only", "client_retry_payloads":4096, "table_row_meter":"sqlite total_changes; secondary indexes unmeasured"})
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        std::fs::create_dir_all(&ctx.dir).map_err(err)?;
        let (store, meters) = ProductStore::open_at(ctx.dir.join("product.sqlite"))?;
        Ok(Opened {
            store: Box::new(store),
            meters,
        })
    }
}

pub struct ProductStore {
    path: PathBuf,
    product: Option<Product>,
    meter: WorkMeter,
    clock: SimClock,
    // Client-side request preparation, NOT durable server receipts or answers.
    requests: BTreeMap<String, Mutation>,
    request_order: VecDeque<String>,
    // Harness metadata needed only to undo the API's separate kind -> body mapping.
    had_kind: BTreeSet<String>,
}
impl ProductStore {
    /// Open a private synthetic measurement file. This never selects a real
    /// account and grants no account authority; it is also used by contract tests.
    pub fn open_at(path: PathBuf) -> Result<(Self, Meters), StoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| err("measurement file needs a parent directory"))?;
        std::fs::create_dir_all(parent).map_err(err)?;
        let path = parent.canonicalize().map_err(err)?.join(
            path.file_name()
                .ok_or_else(|| err("measurement file needs a name"))?,
        );
        let mut store = Self {
            path,
            product: None,
            meter: WorkMeter::new(),
            clock: SimClock(Arc::new(AtomicU64::new(SimTime(0).unix_ms()))),
            requests: BTreeMap::new(),
            request_order: VecDeque::new(),
            had_kind: BTreeSet::new(),
        };
        let meters = store.recover()?;
        Ok((store, meters))
    }
    fn product(&self) -> Result<&Product, StoreError> {
        self.product
            .as_ref()
            .ok_or_else(|| err("product store is crashed"))
    }
    fn before(&self) -> Result<ReadWork, StoreError> {
        Ok(self.meter.snapshot().map_err(err)?.work)
    }
    fn measured(&self, before: &ReadWork) -> Result<Meters, StoreError> {
        let after = self.before()?;
        let mut m = Meters::new();
        for (name, a, b) in [
            (
                "sql_statements",
                after.sql_statements,
                before.sql_statements,
            ),
            (
                "scan_visits",
                after.sqlite_scan_visits,
                before.sqlite_scan_visits,
            ),
            (
                "fullscan_steps",
                after.fullscan_steps,
                before.fullscan_steps,
            ),
            ("vm_steps", after.vm_steps, before.vm_steps),
            ("rows_returned", after.rows_returned, before.rows_returned),
            ("row_changes", after.rows_written, before.rows_written),
            (
                "table_rows_written",
                after.rows_written,
                before.rows_written,
            ),
        ] {
            m.add_caused(name, "product_storage", a.saturating_sub(b));
        }
        Ok(m)
    }
    fn value(&self, key: &str, mut value: Value) -> Value {
        if !self.had_kind.contains(key) {
            if let Some(fields) = value.as_object_mut() {
                fields.remove("kind");
            }
        }
        value
    }
    fn current(&self, key: &str) -> Result<Option<Value>, StoreError> {
        Ok(self
            .product()?
            .get(ACCOUNT, RESOURCE, key)
            .map_err(err)?
            .record
            .map(|r| self.value(key, r.value)))
    }
    fn prepare(&mut self, op: &Operation) -> Result<Mutation, StoreError> {
        if let Some(saved) = self.requests.get(&op.request_key) {
            return Ok(saved.clone());
        }
        if op.attempt > 1 && !matches!(op.intent, Intent::Create { .. }) {
            return Err(err("original client CAS payload no longer retained; retry cannot be reconstructed safely"));
        }
        let (id, deleted, mut value, expected) = match &op.intent {
            Intent::Create {
                key, kind, value, ..
            } => {
                if let Some(held) = value.get("kind") {
                    if held.as_str() != Some(kind) {
                        return Err(err("workload value kind conflicts with its separate kind; no lossless product mapping"));
                    }
                    self.had_kind.insert(key.clone());
                }
                let mut body = value.clone();
                body.as_object_mut()
                    .ok_or_else(|| err("record value must be an object"))?
                    .insert("kind".into(), json!(kind));
                (key.clone(), false, body, 0)
            }
            Intent::Update { key, field, value } => {
                let held = self
                    .product()?
                    .get(ACCOUNT, RESOURCE, key)
                    .map_err(err)?
                    .record
                    .ok_or_else(|| err("record is absent"))?;
                let mut body = held.value;
                body.as_object_mut()
                    .ok_or_else(|| err("record value must be object"))?
                    .insert(field.clone(), value.clone());
                (key.clone(), false, body, held.version)
            }
            Intent::WriteMember {
                key,
                field,
                index,
                value,
            } => {
                let held = self
                    .product()?
                    .get(ACCOUNT, RESOURCE, key)
                    .map_err(err)?
                    .record
                    .ok_or_else(|| err("record is absent"))?;
                let mut body = held.value;
                let slot = body
                    .get_mut(field)
                    .and_then(Value::as_array_mut)
                    .and_then(|list| list.get_mut(*index as usize))
                    .ok_or_else(|| err("member is absent"))?;
                *slot = value.clone();
                (key.clone(), false, body, held.version)
            }
            Intent::Delete { key } => {
                let held = self
                    .product()?
                    .get(ACCOUNT, RESOURCE, key)
                    .map_err(err)?
                    .record
                    .ok_or_else(|| err("record is absent"))?;
                (key.clone(), true, Value::Null, held.version)
            }
            _ => return Err(err("not a mutation")),
        };
        if deleted {
            value = Value::Null;
        }
        let mutation = Mutation {
            id,
            expected_version: expected,
            request_key: op.request_key.clone(),
            deleted,
            value,
        };
        if self.requests.len() >= 4096 {
            if let Some(oldest) = self.request_order.pop_front() {
                self.requests.remove(&oldest);
            }
        }
        self.request_order.push_back(op.request_key.clone());
        self.requests
            .insert(op.request_key.clone(), mutation.clone());
        Ok(mutation)
    }
    fn apply_inner(&mut self, op: &Operation) -> Result<Reply, StoreError> {
        match &op.intent {
            Intent::Create { .. }
            | Intent::Update { .. }
            | Intent::WriteMember { .. }
            | Intent::Delete { .. } => {
                let input = self.prepare(op)?;
                self.product
                    .as_mut()
                    .ok_or_else(|| err("product store is crashed"))?
                    .mutate(ACCOUNT, RESOURCE, input)
                    .map_err(err)?;
                Ok(Reply::Nothing)
            }
            Intent::Read { key } => Ok(Reply::Value(self.current(key)?)),
            Intent::List { kind, limit } => {
                let mut after = 0;
                let mut held = Vec::new();
                loop {
                    let page = self
                        .product()?
                        .changes_page(ACCOUNT, RESOURCE, after, 1000)
                        .map_err(err)?;
                    for change in page.items {
                        if !change.deleted
                            && change
                                .value
                                .as_ref()
                                .and_then(|v| v.get("kind"))
                                .and_then(Value::as_str)
                                == Some(kind)
                        {
                            held.push((change.sequence, change.id));
                        }
                    }
                    match page.next {
                        Some(next) if next > after => after = next,
                        _ => break,
                    }
                }
                held.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
                Ok(Reply::Keys(
                    held.into_iter()
                        .take(*limit as usize)
                        .map(|(_, id)| id)
                        .collect(),
                ))
            }
            Intent::Search {
                field, word, limit, ..
            } => {
                let found = self
                    .product()?
                    .search(ACCOUNT, RESOURCE, Some(field), word, *limit as usize)
                    .map_err(err)?;
                Ok(Reply::Keys(
                    found.records.into_iter().map(|r| r.id).collect(),
                ))
            }
            Intent::EraseOwner { .. } => Err(err("owner-wide physical erasure unsupported")),
        }
    }
    fn outcome(
        &self,
        before: ReadWork,
        result: Result<Reply, StoreError>,
        duplicate: bool,
    ) -> Outcome {
        let meters = match self.measured(&before) {
            Ok(m) => m,
            Err(e) => {
                return Outcome::Failed {
                    error: e.0,
                    meters: Meters::new(),
                }
            }
        };
        match result {
            Ok(reply) => Outcome::Acked {
                reply,
                duplicate,
                meters,
            },
            Err(e) => Outcome::Failed { error: e.0, meters },
        }
    }
}
impl Store for ProductStore {
    fn load(&mut self, ops: &[Operation]) -> Result<Meters, StoreError> {
        let before = self.before()?;
        for op in ops {
            self.clock.0.store(op.at.unix_ms(), Ordering::Relaxed);
            self.apply_inner(op)?;
        }
        self.measured(&before)
    }
    fn apply(&mut self, op: &Operation, fault: Option<Interrupt>) -> Outcome {
        if fault.is_some() {
            return Outcome::Unsupported {reason:"actual product progress handler owns interruption; mid-statement fault injection not measured".into()};
        }
        if matches!(op.intent, Intent::EraseOwner { .. }) {
            return Outcome::Unsupported {reason:"actual product erase has custody/retention semantics, not immediate owner-wide physical erasure".into()};
        }
        if let Intent::Search { kinds: Some(_), .. } = &op.intent {
            return Outcome::Unsupported {reason:"product search has no kind-filtered continuation; cannot preserve this intent without an unbounded scan".into()};
        }
        self.clock.0.store(op.at.unix_ms(), Ordering::Relaxed);
        let before = match self.before() {
            Ok(b) => b,
            Err(e) => {
                return Outcome::Failed {
                    error: e.0,
                    meters: Meters::new(),
                }
            }
        };
        let result = self.apply_inner(op);
        self.outcome(before, result, op.attempt > 1)
    }
    fn apply_extended(
        &mut self,
        op: &Operation<ExtendedIntent>,
        fault: Option<Interrupt>,
    ) -> Outcome {
        if fault.is_some() {
            return Outcome::Unsupported {
                reason: "actual product mid-statement interruption is unmeasured".into(),
            };
        }
        if matches!(op.intent, ExtendedIntent::Declare { .. }) {
            return Outcome::Unsupported {
                reason: "runtime schema declaration does not map to this product storage API"
                    .into(),
            };
        }
        self.clock.0.store(op.at.unix_ms(), Ordering::Relaxed);
        let before = match self.before() {
            Ok(b) => b,
            Err(e) => {
                return Outcome::Failed {
                    error: e.0,
                    meters: Meters::new(),
                }
            }
        };
        let result = (|| match &op.intent {
            ExtendedIntent::ListPage { after, limit } => {
                let page = self
                    .product()?
                    .list_page(ACCOUNT, RESOURCE, after, *limit as usize)
                    .map_err(err)?;
                Ok(Reply::PageKeys {
                    keys: page.items.into_iter().map(|record| record.id).collect(),
                    next: page.next,
                })
            }
            ExtendedIntent::ReadMembers {
                key,
                field,
                from,
                limit,
            } => {
                let value = self.current(key)?.map(|mut v| {
                    if let Some(list) = v.get_mut(field).and_then(Value::as_array_mut) {
                        *list = list
                            .iter()
                            .skip(*from as usize)
                            .take(*limit as usize)
                            .cloned()
                            .collect();
                    }
                    v
                });
                Ok(Reply::Value(value))
            }
            ExtendedIntent::ReadAsOf { key, back } => {
                let history = self
                    .product()?
                    .history(ACCOUNT, RESOURCE, key, None, *back as usize + 1)
                    .map_err(err)?;
                let value = history
                    .versions
                    .get(*back as usize)
                    .and_then(|v| v.value.clone())
                    .map(|v| self.value(key, v));
                Ok(Reply::Value(value))
            }
            _ => unreachable!(),
        })();
        self.outcome(before, result, false)
    }
    fn alarm(&mut self, now: SimTime) -> Result<Meters, StoreError> {
        self.clock.0.store(now.unix_ms(), Ordering::Relaxed);
        let before = self.before()?;
        self.product
            .as_mut()
            .ok_or_else(|| err("crashed"))?
            .retire(ACCOUNT, RESOURCE)
            .map_err(err)?;
        self.measured(&before)
    }
    fn next_alarm(&self) -> Option<SimTime> {
        None
    }
    fn crash(&mut self) {
        self.product = None;
    }
    fn recover(&mut self) -> Result<Meters, StoreError> {
        let before = self.before()?;
        let bounds = sqlite::Bounds {
            value_bytes: 64 * 1024 * 1024,
            work: u64::MAX,
            deadline: Duration::MAX,
            spend: sqlite::Spend::EachOperation,
            cancel: None,
            busy: Duration::from_secs(2),
        };
        let supply =
            sqlite::open_owned_observed(&self.path, record_store::SCHEMA, bounds, self.meter.clone())
                .map_err(|e| err(format!("open owned observed SQLite supply: {e}")))?;
        let volume = Volume {
            store_bytes: supply
                .allocated_bytes()
                .map_err(|e| err(format!("measure opened supply bytes: {e}")))?,
            free_bytes: settings::volume_free_bytes(&self.path).map_err(err)?,
        };
        let limits = settings::shipped()
            .and_then(|settings| settings.limits("native", Some(volume)))
            .ok_or_else(|| err("shipped native limits unavailable"))?;
        self.product = Some(record store::new(supply, Box::new(self.clock.clone()), limits).map_err(err)?);
        self.measured(&before)
    }
    fn inspect(&mut self, key: &str) -> Result<Option<Value>, StoreError> {
        self.current(key)
    }
    fn gauges(&mut self) -> Result<Meters, StoreError> {
        let mut m = Meters::new();
        m.add(
            "bytes_stored",
            self.product()?.storage().allocated_bytes().map_err(err)?,
        );
        Ok(m)
    }
    fn files(&self) -> Vec<PathBuf> {
        vec![
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
        ]
    }
}
