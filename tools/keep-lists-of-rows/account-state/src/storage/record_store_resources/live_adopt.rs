//! Live adoption of a source-owned command closure through the Storage boundary.
//!
//! Ports placed-lists.mjs:10-24's single authority and resumable copy. Sequential
//! dual writes and the placement lookup are replaced by transactional capture,
//! ordered replay, a durable source seal, and qualified target activation. Nothing
//! imports an issuer, deletes original bytes, or emits copied rows as user events.
//!
//! The command owner supplies the COMPLETE closure as family/key-prefix selections,
//! including keys, versions, tombstones, indexes and request receipts. All writers
//! of that closure must enter `commit`; a raw Storage handle is not a fenced writer.
//! Disjoint prefixes of one family are allowed; overlapping selections refuse.
//! This is an adapter for the command owner, not a
//! claim that an arbitrary subset of an account is independently movable.
//!
//! A trusted Fence holds current external incarnation authority THROUGH durable
//! commit (including failed/uncertain closes). This is required to reject restored
//! backups: no protocol relying only on a restored database can detect its rollback.
//! Storage supplies must prove full atomic visibility, not only crash recovery.

use crate::storage::{Bound, Error, Intent, Range, Read, Result, Row, Scope, Storage, Value, When};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, rc::Rc, sync::{Arc, Mutex, OnceLock, Weak}, collections::HashMap};

pub(super) const STATE: &str = "adopt_state";
pub(super) const LOG: &str = "adopt_changes";

/// A reservation from the existing authority owner; held until the operation ends.
pub trait FenceGuard {}
pub trait Fence {
    fn hold(&self, incarnation: &str) -> Result<Box<dyn FenceGuard + '_>>;
    /// Deferred native read custody needs an owned reservation. A producer
    /// without one refuses; a phase/header or a previous check is insufficient.
    fn hold_owned(self: Arc<Self>, _incarnation: &str) -> Result<Box<dyn FenceGuard + Send + Sync>> {
        Err(crate::cause!(Error::Unavailable))
    }
}

/// Bounds are supplied by the owner from its settings, never an unbounded log.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub page_rows: usize,
    pub page_bytes: usize,
    pub commit_bytes: usize,
    pub capture_bytes: usize,
}

/// A canonical stored scalar. Floating point bits are preserved, including -0.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Cell {
    Null,
    Integer(i64),
    Real(u64),
    Text(String),
    Blob(Vec<u8>),
}
impl TryFrom<Value> for Cell {
    type Error = Error;
    fn try_from(value: Value) -> Result<Self> {
        Ok(match value {
            Value::Null => Self::Null,
            Value::Integer(n) => Self::Integer(n),
            Value::Real(n) => Self::Real(n.to_bits()),
            Value::Text(s) => Self::Text(s),
            Value::Blob(b) => Self::Blob(b),
            Value::Oversized(_) => return Err(crate::cause!(Error::TooBig)),
        })
    }
}
impl From<Cell> for Value {
    fn from(value: Cell) -> Self {
        match value {
            Cell::Null => Self::Null,
            Cell::Integer(n) => Self::Integer(n),
            Cell::Real(n) => Self::Real(f64::from_bits(n)),
            Cell::Text(s) => Self::Text(s),
            Cell::Blob(b) => Self::Blob(b),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Selection {
    pub family: String,
    pub prefix: Vec<Cell>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Plan {
    /// Stable command-closure identity, not a per-call placement record.
    pub slot: String,
    pub move_id: String,
    pub source_incarnation: String,
    pub target_incarnation: String,
    pub selections: Vec<Selection>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Effect {
    pub family: String,
    pub key: Vec<Cell>,
    /// Complete postimage in DATA field order; None is an exact key deletion.
    pub row: Option<Vec<Cell>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
enum Phase {
    Copy,
    CatchUp,
    Comparing,
    Proved,
    Sealed,
    Active,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct State {
    plan: Plan,
    source: bool,
    phase: Phase,
    sequence: i64,
    family: usize,
    cursor: Option<Vec<Cell>>,
    captured_bytes: u64,
    #[serde(default)]
    last_portable: Option<String>,
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
fn decode<T: for<'a> Deserialize<'a>>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
fn values(cells: &[Cell]) -> Vec<Value> {
    cells.iter().cloned().map(Value::from).collect()
}
fn cells(row: Row) -> Result<Vec<Cell>> {
    row.0.into_iter().map(Cell::try_from).collect()
}
fn load(store: &dyn Storage, slot: &str) -> Result<State> {
    optional_state(store, slot)?.ok_or(crate::cause!(Error::Moved))
}
fn optional_state(store: &dyn Storage, slot: &str) -> Result<Option<State>> {
    let Some(row) = store.get(STATE, &[Value::from(slot)], &[Read::whole("body")])? else { return Ok(None); };
    match &row.0[0] {
        Value::Blob(bytes) => decode(bytes).map(Some),
        _ => Err(crate::cause!(Error::Invalid)),
    }
}
fn save(store: &dyn Storage, state: &State) -> Result<()> {
    store.put(
        STATE,
        &[
            ("slot", state.plan.slot.as_str().into()),
            ("body", Value::Blob(encode(state)?)),
        ],
        When::Always,
    )?;
    Ok(())
}
fn range(prefix: &[Cell], cursor: Option<&[Cell]>) -> Range<'static> {
    let mut range = Range::all();
    range.from = cursor.map_or_else(
        || if prefix.is_empty() { Bound::Unbounded } else { Bound::Included(values(prefix)) },
        |key| Bound::Excluded(values(key)),
    );
    range.to = if prefix.is_empty() { Bound::Unbounded } else { Bound::Included(values(prefix)) };
    range
}
fn validate(store: &dyn Storage, plan: &Plan, limits: Limits) -> Result<()> {
    if plan.slot.is_empty()
        || plan.move_id.is_empty()
        || plan.source_incarnation.is_empty()
        || plan.target_incarnation.is_empty()
        || plan.source_incarnation == plan.target_incarnation
        || plan.selections.is_empty()
        || limits.page_rows == 0
        || limits.page_bytes == 0
        || limits.commit_bytes == 0
        || limits.capture_bytes < limits.commit_bytes
    {
        return Err(crate::cause!(Error::Invalid));
    }
    for (at, selection) in plan.selections.iter().enumerate() {
        let family = store.schema().family(&selection.family)?;
        if selection.family == STATE
            || selection.family == LOG
            || family.arrival
            || selection.prefix.len() > family.key.len()
            || plan.selections[..at]
                .iter()
                .any(|other| other.family == selection.family &&
                    (other.prefix.starts_with(&selection.prefix) || selection.prefix.starts_with(&other.prefix)))
            || selection
                .prefix
                .iter()
                .any(|cell| matches!(cell, Cell::Null))
        {
            return Err(crate::cause!(Error::Invalid));
        }
    }
    Ok(())
}
// Equal raw rows are meaningful only under the same declared shape, including
// derived orders. A target with reordered fields must never pass byte equality.
fn compatible(source: &dyn Storage, target: &dyn Storage, plan: &Plan) -> Result<()> {
    for selection in &plan.selections {
        let left = source.schema().family(&selection.family)?;
        let right = target.schema().family(&selection.family)?;
        if left.key != right.key
            || left.fields != right.fields
            || left.arrival != right.arrival
            || left.orders.len() != right.orders.len()
        {
            return Err(crate::cause!(Error::Invalid));
        }
        for (name, order) in &left.orders {
            let other = right.orders.get(name).ok_or(crate::cause!(Error::Invalid))?;
            if order.fields != other.fields
                || order.only.len() != other.only.len()
                || order
                    .only
                    .iter()
                    .zip(&other.only)
                    .any(|(a, b)| a.field != b.field || a.equals != b.equals || a.not != b.not)
            {
                return Err(crate::cause!(Error::Invalid));
            }
        }
    }
    Ok(())
}

fn apply(store: &dyn Storage, plan: &Plan, effect: &Effect) -> Result<()> {
    let selection = plan
        .selections
        .iter()
        .find(|s| s.family == effect.family && effect.key.starts_with(&s.prefix))
        .ok_or(crate::cause!(Error::Invalid))?;
    let family = store.schema().family(&effect.family)?;
    if effect.key.len() != family.key.len()
        || !effect.key.starts_with(&selection.prefix)
        || effect.key.iter().any(|cell| matches!(cell, Cell::Null))
    {
        return Err(crate::cause!(Error::Invalid));
    }
    match &effect.row {
        Some(row) => {
            if row.len() != family.fields.len() {
                return Err(crate::cause!(Error::Invalid));
            }
            for (field, key) in family.key.iter().zip(&effect.key) {
                if row[family
                    .fields
                    .iter()
                    .position(|f| f == field)
                    .ok_or(crate::cause!(Error::Invalid))?]
                    != *key
                {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            let fields: Vec<_> = family
                .fields
                .iter()
                .map(String::as_str)
                .zip(values(row))
                .collect();
            store.put(&effect.family, &fields, When::Always)?;
        }
        None => {
            let mut exact = Range::all();
            exact.from = Bound::Included(values(&effect.key));
            exact.to = exact.from.clone();
            store.erase(&effect.family, &exact)?;
        }
    }
    Ok(())
}
fn page(
    store: &dyn Storage,
    selection: &Selection,
    cursor: Option<&[Cell]>,
    limits: Limits,
) -> Result<Vec<Effect>> {
    let family = store.schema().family(&selection.family)?;
    // One bounded row per read: neither a page nor a comparison materializes N huge values.
    let reads: Vec<_> = family
        .fields
        .iter()
        .map(|name| Read::at_most(name, limits.commit_bytes))
        .collect();
    let mut result = Vec::new();
    let mut bytes = 0usize;
    let mut after = cursor.map(<[Cell]>::to_vec);
    while result.len() < limits.page_rows {
        let Some(row) = store
            .scan(
                &selection.family,
                &range(&selection.prefix, after.as_deref()).limit(1),
                &reads,
            )?
            .into_iter()
            .next()
        else {
            break;
        };
        let row = cells(row)?;
        let key = family
            .key
            .iter()
            .map(|key| row[family.fields.iter().position(|f| f == key).unwrap()].clone())
            .collect();
        let effect = Effect {
            family: selection.family.clone(),
            key,
            row: Some(row),
        };
        let size = encode(&effect)?.len();
        if size > limits.commit_bytes {
            return Err(crate::cause!(Error::TooBig));
        }
        if !result.is_empty() && bytes.saturating_add(size) > limits.page_bytes {
            break;
        }
        bytes += size;
        after = Some(effect.key.clone());
        result.push(effect);
    }
    Ok(result)
}

/// Enable capture BEFORE the first source page. A retry reads the same move.
/// Existing source rows stay in place. Target must be empty over the full closure.
pub fn prepare(
    store: &dyn Storage,
    plan: &Plan,
    source: bool,
    limits: Limits,
    fence: &dyn Fence,
) -> Result<()> {
    validate(store, plan, limits)?;
    let _authority = fence.hold(if source {
        &plan.source_incarnation
    } else {
        &plan.target_incarnation
    })?;
    let scope = Scope::begin(store, Intent::Write)?;
    if store
        .get(STATE, &[plan.slot.as_str().into()], &[Read::whole("body")])?
        .is_some()
    {
        let state = load(store, &plan.slot)?;
        if state.plan != *plan || state.source != source {
            return Err(crate::cause!(Error::Conflict));
        }
    } else {
        if !source {
            for selection in &plan.selections {
                if store.count(&selection.family, &range(&selection.prefix, None).limit(1))? != 0 {
                    return Err(crate::cause!(Error::Conflict));
                }
            }
        }
        save(
            store,
            &State {
                plan: plan.clone(),
                source,
                phase: Phase::Copy,
                sequence: 0,
                family: 0,
                cursor: None,
                captured_bytes: 0,
                last_portable: None,
            },
        )?;
    }
    scope.commit()
}

/// Read-only command view under the write reservation. The check cannot issue
/// A current replica baseline proved by the actual complete-frame owner on
/// this same held target writer. This does not authorize independent history
/// merging; the final sealed byte comparison must still match every row.
pub(crate) trait ReplicaBaseline {
    fn assert_same(&self, target: &dyn Storage, plan: &Plan) -> Result<()>;
}

/// Freeze a qualified existing complete-domain replica without deleting or
/// hiding any original rows. Copy/replay preserves history; an extra row or a
/// missing source tombstone fails the final full comparison. The private
/// Group proof binds current writer/term, physical header, stream and stored
/// versus materialized frontier inside this exact target transaction.
pub(crate) fn prepare_replica(target: &dyn Storage, plan: &Plan, limits: Limits,
    fence: &dyn Fence, baseline: &dyn ReplicaBaseline) -> Result<()> {
    validate(target, plan, limits)?;
    let _authority = fence.hold(&plan.target_incarnation)?;
    if !target.scoped() || !target.writing()? { return Err(crate::cause!(Error::Invalid)); }
    let tx = Scope::begin(target, Intent::Nested)?;
    if let Some(state) = optional_state(target, &plan.slot)? {
        if state.plan != *plan || state.source { return Err(crate::cause!(Error::Conflict)); }
    } else {
        baseline.assert_same(target, plan)?;
        save(target, &State { plan: plan.clone(), source: false, phase: Phase::Copy,
            sequence: 0, family: 0, cursor: None, captured_bytes: 0, last_portable: None })?;
        baseline.assert_same(target, plan)?;
    }
    tx.commit()
}

/// A resumed target is checked against its exact durable plan and role.
/// This grants no fence or membership, and does not relabel source state.
pub(crate) fn target_prepared(target:&dyn Storage,plan:&Plan)->Result<bool> {
    match optional_state(target,&plan.slot)? {None=>Ok(false),Some(state)=>{
        if state.plan!=*plan || state.source {return Err(crate::cause!(Error::Conflict));}Ok(true)
    }}
}

/// Read-only command view under the write reservation. The check cannot issue
/// uncaptured writes or close the enclosing transaction through this value.
pub struct Current<'a> {
    store: &'a dyn Storage,
}
impl Current<'_> {
    pub fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        self.store.get(family, key, read)
    }
    pub fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        self.store.scan(family, range, read)
    }
    pub fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        self.store.count(family, range)
    }
}

/// The complete source/target command batch, including its durable retry receipt.
/// The command owner checks current rights, CAS and same-key input binding inside
/// `check` under this SAME transaction. Retried commands return no effects.
pub fn commit(
    store: &dyn Storage,
    plan: &Plan,
    limits: Limits,
    fence: &dyn Fence,
    check: impl FnOnce(Current<'_>) -> Result<Vec<Effect>>,
) -> Result<()> {
    validate(store, plan, limits)?;
    let role = load(store, &plan.slot)?.source;
    let _authority = fence.hold(if role {
        &plan.source_incarnation
    } else {
        &plan.target_incarnation
    })?;
    let scope = Scope::begin(store, Intent::Write)?;
    let mut state = load(store, &plan.slot)?;
    if state.plan != *plan
        || (state.source && state.phase == Phase::Sealed)
        || (!state.source && state.phase != Phase::Active)
    {
        return Err(crate::cause!(Error::Moved));
    }
    let effects = check(Current { store })?;
    let bytes = encode(&effects)?;
    if bytes.len() > limits.commit_bytes {
        return Err(crate::cause!(Error::TooBig));
    }
    for effect in &effects {
        apply(store, plan, effect)?;
    }
    if state.source && !effects.is_empty() {
        state.captured_bytes = state
            .captured_bytes
            .checked_add(bytes.len() as u64)
            .ok_or(crate::cause!(Error::TooBig))?;
        if state.captured_bytes > limits.capture_bytes as u64 {
            return Err(crate::cause!(Error::TooBig));
        }
        state.sequence = state.sequence.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
        store.put(
            LOG,
            &[
                ("slot", plan.slot.as_str().into()),
                ("sequence", state.sequence.into()),
                ("body", Value::Blob(bytes)),
            ],
            When::New,
        )?;
        save(store, &state)?;
    }
    scope.commit()
}

/// One copy page plus cursor, atomically. Replay begins only after all families
/// finish, so an old copy can never resurrect a replayed delete. Lost replies
/// resume from the TARGET's saved cursor, never a caller's tentative cursor.
pub fn copy_step(
    source: &dyn Storage,
    target: &dyn Storage,
    plan: &Plan,
    limits: Limits,
    fence: &dyn Fence,
) -> Result<bool> {
    validate(source, plan, limits)?;
    validate(target, plan, limits)?;
    compatible(source, target, plan)?;
    let _source_authority = fence.hold(&plan.source_incarnation)?;
    let _authority = fence.hold(&plan.target_incarnation)?;
    let read = Scope::current_read(source)?;
    let from = load(source, &plan.slot)?;
    if from.plan != *plan || !from.source {
        return Err(crate::cause!(Error::Moved));
    }
    let scope = Scope::begin(target, Intent::Write)?;
    let mut state = load(target, &plan.slot)?;
    if state.plan != *plan || state.source {
        return Err(crate::cause!(Error::Moved));
    }
    if state.phase != Phase::Copy {
        return Ok(false);
    }
    let selection = plan.selections.get(state.family).ok_or(crate::cause!(Error::Invalid))?;
    let effects = page(source, selection, state.cursor.as_deref(), limits)?;
    if let Some(last) = effects.last() {
        state.cursor = Some(last.key.clone());
    }
    if effects.len() < limits.page_rows {
        // A byte-truncated page can be short: advance family only on an empty page.
        if effects.is_empty() {
            state.family += 1;
            state.cursor = None;
        }
    }
    for effect in &effects {
        apply(target, plan, effect)?;
    }
    if state.family == plan.selections.len() {
        state.phase = Phase::CatchUp;
    }
    save(target, &state)?;
    scope.commit()?;
    read.commit()?;
    Ok(state.phase == Phase::Copy)
}

/// Replay ONE complete committed command and save its frontier atomically.
pub fn replay_step(
    source: &dyn Storage,
    target: &dyn Storage,
    plan: &Plan,
    limits: Limits,
    fence: &dyn Fence,
) -> Result<bool> {
    validate(source, plan, limits)?;
    validate(target, plan, limits)?;
    compatible(source, target, plan)?;
    let _source_authority = fence.hold(&plan.source_incarnation)?;
    let _authority = fence.hold(&plan.target_incarnation)?;
    let read = Scope::current_read(source)?;
    let from = load(source, &plan.slot)?;
    let scope = Scope::begin(target, Intent::Write)?;
    let mut state = load(target, &plan.slot)?;
    if from.plan != *plan || !from.source || state.plan != *plan || state.source {
        return Err(crate::cause!(Error::Moved));
    }
    if matches!(
        state.phase,
        Phase::Active | Phase::Comparing | Phase::Proved
    ) {
        return if state.sequence == from.sequence {
            Ok(false)
        } else {
            Err(crate::cause!(Error::Moved))
        };
    }
    if state.phase != Phase::CatchUp {
        return Err(crate::cause!(Error::Moved));
    }
    if state.sequence == from.sequence {
        return Ok(false);
    }
    if state.sequence > from.sequence {
        return Err(crate::cause!(Error::Moved));
    }
    let next = state.sequence.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
    let row = source
        .get(
            LOG,
            &[plan.slot.as_str().into(), next.into()],
            &[Read::at_most("body", limits.commit_bytes)],
        )?
        .ok_or(crate::cause!(Error::Moved))?;
    let effects: Vec<Effect> = match &row.0[0] {
        Value::Blob(bytes) => decode(bytes)?,
        _ => return Err(crate::cause!(Error::TooBig)),
    };
    for effect in &effects {
        apply(target, plan, effect)?;
    }
    state.sequence = next;
    save(target, &state)?;
    scope.commit()?;
    read.commit()?;
    Ok(true)
}

/// Durable irreversible source fence. Same move recovers a lost seal reply.
pub fn seal(source: &dyn Storage, plan: &Plan, fence: &dyn Fence) -> Result<i64> {
    let _authority = fence.hold(&plan.source_incarnation)?;
    let scope = Scope::begin(source, Intent::Write)?;
    let mut state = load(source, &plan.slot)?;
    if state.plan != *plan || !state.source {
        return Err(crate::cause!(Error::Moved));
    }
    state.phase = Phase::Sealed;
    save(source, &state)?;
    scope.commit()?;
    Ok(state.sequence)
}

/// Compare ONE bounded page at the source's sealed frontier. Target remains
/// unavailable to ordinary commands throughout proof; replay/copy cannot alter
/// a proved page. Comparison progress commits atomically and survives crashes.
pub fn verify_step(
    source: &dyn Storage,
    target: &dyn Storage,
    plan: &Plan,
    limits: Limits,
    fence: &dyn Fence,
) -> Result<bool> {
    validate(source, plan, limits)?;
    validate(target, plan, limits)?;
    compatible(source, target, plan)?;
    let _source_authority = fence.hold(&plan.source_incarnation)?;
    let _target_authority = fence.hold(&plan.target_incarnation)?;
    let read = Scope::current_read(source)?;
    let from = load(source, &plan.slot)?;
    let scope = Scope::begin(target, Intent::Write)?;
    let mut state = load(target, &plan.slot)?;
    if from.plan != *plan
        || !from.source
        || from.phase != Phase::Sealed
        || state.plan != *plan
        || state.source
        || state.sequence != from.sequence
    {
        return Err(crate::cause!(Error::Moved));
    }
    if matches!(state.phase, Phase::Active | Phase::Proved) {
        return Ok(false);
    }
    if state.phase == Phase::CatchUp {
        state.phase = Phase::Comparing;
        state.family = 0;
        state.cursor = None;
    }
    if state.phase != Phase::Comparing {
        return Err(crate::cause!(Error::Conflict));
    }
    let selection = plan.selections.get(state.family).ok_or(crate::cause!(Error::Invalid))?;
    let left = page(source, selection, state.cursor.as_deref(), limits)?;
    let right = page(target, selection, state.cursor.as_deref(), limits)?;
    if left != right {
        return Err(crate::cause!(Error::Conflict));
    }
    match left.last() {
        Some(last) => state.cursor = Some(last.key.clone()),
        None => {
            state.family += 1;
            state.cursor = None;
        }
    }
    if state.family == plan.selections.len() {
        state.phase = Phase::Proved;
    }
    save(target, &state)?;
    scope.commit()?;
    read.commit()?;
    Ok(state.phase == Phase::Comparing)
}

/// Activate only the target proved at this source seal. No page scan or second
/// writer is hidden in activation. Its lost reply recovers from target state.
pub(crate) fn assert_sealed(source: &dyn Storage, plan: &Plan) -> Result<()> {
    let read = Scope::begin(source, Intent::Read)?;
    let state = load(source, &plan.slot)?;
    if !state.source || state.phase != Phase::Sealed || state.plan != *plan { return Err(crate::cause!(Error::Moved)); }
    read.commit()
}

pub fn activate(
    source: &dyn Storage,
    target: &dyn Storage,
    plan: &Plan,
    limits: Limits,
    fence: &dyn Fence,
) -> Result<()> {
    activate_with(source, target, plan, limits, fence, |_| Ok(()))
}

/// The native composition may replace the proved source physical-authority
/// header with the independently admitted target token in this same commit.
/// A failed callback leaves both the header and Active state unchanged. A
/// recovered Active reply never invokes the transition a second time.
pub(crate) fn activate_with(
    source: &dyn Storage,
    target: &dyn Storage,
    plan: &Plan,
    limits: Limits,
    fence: &dyn Fence,
    transition: impl FnOnce(&dyn Storage) -> Result<()>,
) -> Result<()> {
    validate(source, plan, limits)?;
    validate(target, plan, limits)?;
    compatible(source, target, plan)?;
    let _source_authority = fence.hold(&plan.source_incarnation)?;
    let _target_authority = fence.hold(&plan.target_incarnation)?;
    let read = Scope::current_read(source)?;
    let from = load(source, &plan.slot)?;
    let scope = Scope::begin(target, Intent::Write)?;
    let mut state = load(target, &plan.slot)?;
    if from.plan != *plan
        || !from.source
        || from.phase != Phase::Sealed
        || state.plan != *plan
        || state.source
        || state.sequence != from.sequence
    {
        return Err(crate::cause!(Error::Moved));
    }
    if state.phase == Phase::Active {
        return Ok(());
    }
    if state.phase != Phase::Proved {
        return Err(crate::cause!(Error::Conflict));
    }
    transition(target)?;
    state.phase = Phase::Active;
    save(target, &state)?;
    scope.commit()?;
    read.commit()
}

/// Durable target progress for recovering a lost reply under the SAME move id.
/// Active remains recoverable after source authority or connectivity has ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    Copying,
    CatchingUp { through: i64 },
    Verifying { through: i64 },
    Ready { sealed_through: i64 },
    Active { sealed_through: i64 },
}
pub fn recover(target: &dyn Storage, plan: &Plan, fence: &dyn Fence) -> Result<Progress> {
    let _authority = fence.hold(&plan.target_incarnation)?;
    let read = Scope::current_read(target)?;
    let state = load(target, &plan.slot)?;
    if state.plan != *plan || state.source {
        return Err(crate::cause!(Error::Moved));
    }
    let progress = match state.phase {
        Phase::Copy => Progress::Copying,
        Phase::CatchUp => Progress::CatchingUp {
            through: state.sequence,
        },
        Phase::Comparing => Progress::Verifying {
            through: state.sequence,
        },
        Phase::Proved => Progress::Ready {
            sealed_through: state.sequence,
        },
        Phase::Active => Progress::Active {
            sealed_through: state.sequence,
        },
        Phase::Sealed => return Err(crate::cause!(Error::Moved)),
    };
    read.commit()?;
    Ok(progress)
}

/// The native owner derives this direct local fence key from the admitted
/// account/history. It is never a directory or a placement lookup.
pub fn command_slot(account: &str, history: &serde_json::Value) -> Result<String> {
    let framed = encode(&("native-command-domain/v1", account, history))?;
    Ok(content_crypto::advanced::blake3::hash(&framed).to_hex().to_string())
}

/// A whole command domain includes every declared family, even when its keys
/// do not start with account/resource (custody, totals and shared indexes).
/// Smaller groups need a separately proved source closure; ids are not proof.
pub fn complete_domain_plan(store: &dyn Storage, slot: String, move_id: String,
    source_incarnation: String, target_incarnation: String) -> Plan {
    Plan { slot, move_id, source_incarnation, target_incarnation,
        selections: store.schema().families.iter()
            .filter(|family| !super::commit_log::opaque_map::is_transport_family(&family.family))
            .map(|family| Selection { family: family.family.clone(), prefix: Vec::new() }).collect() }
}

/// A committed source seal and a copying target never admit ordinary native
/// work. Call inside the same writer reservation as the eventual commit.
pub fn command_access(store: &dyn Storage, slot: &str) -> Result<()> {
    let Some(state) = optional_state(store, slot)? else { return Ok(()); };
    if (state.source && state.phase != Phase::Sealed) || (!state.source && state.phase == Phase::Active) {
        Ok(())
    } else { Err(crate::cause!(Error::Moved)) }
}

/// Native read admission/final disclosure must retain this current external
/// reservation as well as the snapshot's exact header/key custody. Local saved
/// Active state alone never authorizes a restored target to serve data.
pub(crate) fn native_access(store: &dyn Storage, slot: &str) -> Result<Option<Box<dyn FenceGuard + Send + Sync>>> {
    let limits = crate::storage::record_store::settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.live_adoption;
    let progress = super::commit_log::frontiers(store, slot, limits)?;
    if progress.materialized != progress.stored { return Err(crate::cause!(Error::Moved)); }
    let Some(state) = optional_state(store, slot)? else { return Ok(None); };
    if (state.source && state.phase == Phase::Sealed) || (!state.source && state.phase != Phase::Active) { return Err(crate::cause!(Error::Moved)); }
    let fence = {
        let table = native_fences().lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let held = table.get(slot).and_then(Weak::upgrade).ok_or(crate::cause!(Error::Moved))?;
        if held.plan != state.plan { return Err(crate::cause!(Error::Moved)); }
        held.fence.clone()
    };
    let incarnation = if state.source { &state.plan.source_incarnation } else { &state.plan.target_incarnation };
    fence.hold_owned(incarnation).map(Some)
}

/// One outer native transaction's bounded set of touched keys. Each journal,
/// field-key, record and index lend shares this context. The final postimages
/// come from the actual transaction, so a direct SQL savepoint rollback cannot
/// publish a phantom effect. Ordinary Storage scope rollbacks also truncate
/// the touched-key prefix immediately.
pub struct CommandCapture {
    plan: Option<Plan>,
    source: bool,
    collecting: std::cell::Cell<bool>,
    selections: Vec<Selection>,
    limits: Limits,
    admitted_authority: Option<Arc<CurrentFence>>,
    keys: RefCell<Vec<(String, Vec<Cell>)>>,
    key_bytes: std::cell::Cell<usize>,
}
impl CommandCapture {
    /// Start only after the native owner acquired its write transaction and
    /// checked current external authority. A target never records source work.
    pub fn begin(store: &dyn Storage, slot: &str, limits: Limits) -> Result<Option<Rc<Self>>> {
        let progress = super::commit_log::frontiers(store, slot, limits)?;
        if progress.materialized != progress.stored { return Err(crate::cause!(Error::Moved)); }
        let Some(state) = optional_state(store, slot)? else { return Ok(None); };
        if (state.source && state.phase == Phase::Sealed) || (!state.source && state.phase != Phase::Active) { return Err(crate::cause!(Error::Moved)); }
        validate(store, &state.plan, limits)?;
        if state.plan.selections != complete_domain_plan(store, String::new(), String::new(), String::new(), String::new()).selections {
            return Err(crate::cause!(Error::Invalid));
        }
        if !store.scoped() || !store.writing()? { return Err(crate::cause!(Error::Invalid)); }
        Ok(Some(Rc::new(Self { source: state.source, collecting: std::cell::Cell::new(state.source), selections: state.plan.selections.clone(), plan: Some(state.plan), limits, admitted_authority: None, keys: RefCell::new(Vec::new()), key_bytes: std::cell::Cell::new(0) })))
    }

    /// A scoped native request already owns an independently current original
    /// canonical authority. Retain that exact producer instead of requiring a
    /// process-global fence from a previous transfer request or process.
    pub(crate) fn begin_admitted(store:&dyn Storage,slot:&str,limits:Limits,
        authority:Option<Arc<CurrentFence>>)->Result<Option<Rc<Self>>> {
        let mut capture=Self::begin(store,slot,limits)?;
        if let (Some(capture),Some(authority))=(capture.as_mut(),authority) {
            // The existing separately fenced migration owner can name a
            // different external incarnation (for example another supply's
            // independently admitted producer). Preserve that actual fence;
            // a native source only replaces it when its original canonical
            // authority itself qualifies the plan's physical incarnation.
            let incarnation=capture.source_incarnation()?;
            let qualified=authority.hold(incarnation).is_ok();
            if qualified {Rc::get_mut(capture).ok_or(crate::cause!(Error::Busy))?.admitted_authority=Some(authority);}
        }
        Ok(capture)
    }

    /// The same recorder for a current command that needs an atomic replica
    /// frame but has no active move. It invents no migration or placement state.
    pub fn unbound(store: &dyn Storage, limits: Limits) -> Rc<Self> {
        Rc::new(Self { plan: None, source: false, admitted_authority: None, collecting: std::cell::Cell::new(true), selections: complete_domain_plan(store, String::new(), String::new(), String::new(), String::new()).selections,
            limits, keys: RefCell::new(Vec::new()), key_bytes: std::cell::Cell::new(0) })
    }

    fn touched(&self, family: &str, key: Vec<Cell>) -> Result<()> {
        if !self.collecting.get() || super::commit_log::opaque_map::is_transport_family(family) { return Ok(()); }
        if !self.selections.iter().any(|selection| selection.family == family && key.starts_with(&selection.prefix)) {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut keys = self.keys.borrow_mut();
        if keys.iter().any(|(held, old)| held == family && old == &key) { return Ok(()); }
        let size = encode(&(family, &key))?.len();
        let held = self.key_bytes.get();
        if held.saturating_add(size) > self.limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        self.key_bytes.set(held + size);
        keys.push((family.into(), key));
        Ok(())
    }

    fn truncate(&self, count: usize) -> Result<()> {
        let mut keys = self.keys.borrow_mut();
        keys.truncate(count);
        self.key_bytes.set(keys.iter().try_fold(0usize, |bytes, key| bytes.checked_add(encode(key)?.len()).ok_or(crate::cause!(Error::TooBig)))?);
        Ok(())
    }

    /// The native command retains this authority and its guard until its outer
    /// commit is confirmed. Missing registration after restart is a refusal.
    pub(crate) fn native_fence(&self) -> Result<Arc<CurrentFence>> {
        let plan = self.plan.as_ref().ok_or(crate::cause!(Error::Invalid))?;
        if let Some(authority)=&self.admitted_authority {return Ok(authority.clone());}
        let table = native_fences().lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let registered = table.get(&plan.slot).and_then(Weak::upgrade).ok_or(crate::cause!(Error::Moved))?;
        if &registered.plan != plan { return Err(crate::cause!(Error::Moved)); }
        Ok(registered.fence.clone())
    }
    pub(crate) fn source_incarnation(&self) -> Result<&str> {
        self.plan.as_ref().map(|plan| if self.source { plan.source_incarnation.as_str() } else { plan.target_incarnation.as_str() }).ok_or(crate::cause!(Error::Invalid))
    }
    /// An active target may also need to send its new native command to copies.
    pub fn enable_replication(&self) { self.collecting.set(true); }

    /// Complete final physical images from the SAME held source transaction.
    /// Replication and adoption consume this one representation.
    pub fn final_effects(&self, store: &dyn Storage) -> Result<Vec<Effect>> {
        if !store.scoped() || !store.writing()? { return Err(crate::cause!(Error::Invalid)); }
        let mut effects = Vec::new();
        let mut bytes = 0usize;
        for (family, key) in self.keys.borrow().iter() {
            let declaration = store.schema().family(family)?;
            let reads: Vec<_> = declaration.fields.iter().map(|field| Read::at_most(field, self.limits.commit_bytes)).collect();
            let effect = Effect { family: family.clone(), key: key.clone(),
                row: store.get(family, &values(key), &reads)?.map(cells).transpose()? };
            bytes = bytes.checked_add(encode(&effect)?.len()).ok_or(crate::cause!(Error::TooBig))?;
            if bytes > self.limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
            effects.push(effect);
        }
        if encode(&effects)?.len() > self.limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        Ok(effects)
    }

    /// Append ONE complete native command after its protected receipt exists,
    /// immediately before the original native commit. No scope is committed
    /// here: effects, key/index changes, log and progress share that outer one.
    pub fn flush(&self, store: &dyn Storage) -> Result<()> {
        let Some(plan) = &self.plan else { return Ok(()); };
        if !self.source { return Ok(()); }
        if !store.scoped() || !store.writing()? { return Err(crate::cause!(Error::Invalid)); }
        command_access(store, &plan.slot)?;
        let mut state = load(store, &plan.slot)?;
        if !state.source || &state.plan != plan { return Err(crate::cause!(Error::Moved)); }
        let effects = self.final_effects(store)?;
        if effects.is_empty() { return Ok(()); }
        let body = encode(&effects)?;
        if body.len() > self.limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        state.captured_bytes = state.captured_bytes.checked_add(body.len() as u64).ok_or(crate::cause!(Error::TooBig))?;
        if state.captured_bytes > self.limits.capture_bytes as u64 { return Err(crate::cause!(Error::TooBig)); }
        state.sequence = state.sequence.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
        store.put(LOG, &[("slot", plan.slot.as_str().into()), ("sequence", state.sequence.into()),
            ("body", Value::Blob(body))], When::New)?;
        save(store, &state)
    }
}

/// The generic Storage adapter used by native command lends. Without an
/// active move it delegates with no extra store reads or copies.
struct CaptureCheckpoint { inner: crate::storage::Checkpoint, count: usize }

pub struct Recording<S> {
    inner: S,
    capture: RefCell<Option<Rc<CommandCapture>>>,
    scopes: RefCell<Vec<usize>>,
}
impl<S> Recording<S> {
    pub fn new(inner: S) -> Self { Self { inner, capture: RefCell::new(None), scopes: RefCell::new(Vec::new()) } }
    pub fn bind(&self, capture: Option<Rc<CommandCapture>>) { *self.capture.borrow_mut() = capture; }
}
impl<S> std::ops::Deref for Recording<S> { type Target = S; fn deref(&self) -> &S { &self.inner } }
impl<S: Storage> Storage for Recording<S> {
    fn schema(&self) -> &'static crate::storage::Schema { self.inner.schema() }
    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> { self.inner.get(family, key, read) }
    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> { self.inner.scan(family, range, read) }
    fn read_many(&self, queries: &[crate::storage::Query<'_>]) -> Result<Vec<crate::storage::Reply>> { self.inner.read_many(queries) }
    fn put(&self, family: &str, row: &[(&str, Value)], when: When<'_>) -> Result<u64> {
        if let Some(capture) = self.capture.borrow().as_ref() {
            let declared = self.schema().family(family)?;
            let key = declared.key.iter().map(|key| row.iter().find(|(field, _)| field == key)
                .ok_or(crate::cause!(Error::Invalid)).and_then(|(_, value)| Cell::try_from(value.clone()))).collect::<Result<_>>()?;
            capture.touched(family, key)?;
        }
        self.inner.put(family, row, when)
    }
    fn erase(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        if let Some(capture) = self.capture.borrow().as_ref() {
            // Native record-store erasures use exact/key ranges. An unlike
            // owner must supply a bounded key selection before a named-order erase.
            if range.order != crate::storage::Order::Key { return Err(crate::cause!(Error::Invalid)); }
            let declared = self.schema().family(family)?;
            let reads: Vec<_> = declared.key.iter().map(|key| Read::at_most(key, capture.limits.commit_bytes)).collect();
            let mut next = range.clone();
            let mut left = range.limit.unwrap_or(usize::MAX);
            while left > 0 {
                let Some(row) = self.inner.scan(family, &next.clone().limit(1), &reads)?.into_iter().next() else { break; };
                let key = cells(row)?;
                capture.touched(family, key.clone())?;
                next.from = Bound::Excluded(values(&key));
                left -= 1;
            }
        }
        self.inner.erase(family, range)
    }
    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> { self.inner.count(family, range) }
    fn present(&self, family: &str) -> Result<bool> { self.inner.present(family) }
    fn prepare_declared_families(&self, names: &[&str]) -> Result<()> { self.inner.prepare_declared_families(names) }
    fn custody(&self) -> Result<()> { self.inner.custody() }
    fn location(&self) -> Option<&str> { self.inner.location() }
    fn scoped(&self) -> bool { self.inner.scoped() }
    fn writing(&self) -> Result<bool> { self.inner.writing() }
    fn changes(&self) -> u64 { self.inner.changes() }
    fn mark(&self) -> Result<i64> { self.inner.mark() }
    fn schema_mark(&self) -> Result<i64> { self.inner.schema_mark() }
    fn allocated_bytes(&self) -> Result<u64> { self.inner.allocated_bytes() }
    fn reclaim(&self) -> Result<()> { self.inner.reclaim() }
    fn reclaim_step(&self, pages: u64) -> Result<u64> { self.inner.reclaim_step(pages) }
    fn vacuum_state(&self) -> Result<Option<crate::storage::VacuumState>> { self.inner.vacuum_state() }
    fn overwrites_removed(&self) -> Result<bool> { self.inner.overwrites_removed() }
    fn checkpoint(&self) -> Result<crate::storage::Checkpoint> {
        let inner = self.inner.checkpoint()?;
        let count = self.capture.borrow().as_ref().map_or(0, |capture| capture.keys.borrow().len());
        Ok(crate::storage::Checkpoint::new(CaptureCheckpoint { inner, count }))
    }
    fn close_checkpoint(&self, checkpoint: crate::storage::Checkpoint, commit: bool) -> Result<()> {
        let checkpoint = checkpoint.take::<CaptureCheckpoint>()?;
        self.inner.close_checkpoint(checkpoint.inner, commit)?;
        if !commit { if let Some(capture) = self.capture.borrow().as_ref() { capture.truncate(checkpoint.count)?; } }
        Ok(())
    }
    fn open_scope(&self, intent: Intent) -> Result<()> {
        self.inner.open_scope(intent)?;
        let count = self.capture.borrow().as_ref().map_or(0, |capture| capture.keys.borrow().len());
        self.scopes.borrow_mut().push(count);
        Ok(())
    }
    fn close_scope(&self, commit: bool) -> Result<()> {
        self.inner.close_scope(commit)?;
        let count = self.scopes.borrow_mut().pop().ok_or(crate::cause!(Error::Invalid))?;
        if !commit { if let Some(capture) = self.capture.borrow().as_ref() { capture.truncate(count)?; } }
        Ok(())
    }
}

pub(crate) type CurrentFence = dyn Fence + Send + Sync;
struct RegisteredFence { plan: Plan, fence: Arc<CurrentFence> }
type NativeFences = HashMap<String, Weak<RegisteredFence>>;
fn native_fences() -> &'static Mutex<NativeFences> {
    static FENCES: OnceLock<Mutex<NativeFences>> = OnceLock::new();
    FENCES.get_or_init(Default::default)
}
/// Lifetime of an actual external authority supplied by the trusted native
/// migration owner. This holds no path, routing table or credential. A restart
/// forgets it, so restored local state cannot manufacture current authority.
pub(crate) struct FenceRegistration { _held: Arc<RegisteredFence> }
impl FenceRegistration {
    pub(crate) fn bind(plan: &Plan, fence: Arc<CurrentFence>) -> Result<Self> {
        { let _source = fence.hold(&plan.source_incarnation)?; let _target = fence.hold(&plan.target_incarnation)?; }
        let mut table = native_fences().lock().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        table.retain(|_, fence| fence.strong_count() > 0);
        let held = if let Some(held) = table.get(&plan.slot).and_then(Weak::upgrade) {
            if &held.plan != plan || !Arc::ptr_eq(&held.fence, &fence) { return Err(crate::cause!(Error::Conflict)); }
            held
        } else {
            let held = Arc::new(RegisteredFence { plan: plan.clone(), fence });
            table.insert(plan.slot.clone(), Arc::downgrade(&held));
            held
        };
        Ok(Self { _held: held })
    }
}

pub(super) fn apply_complete(store: &dyn Storage, effects: &[Effect]) -> Result<()> {
    let plan = complete_domain_plan(store, String::new(), String::new(), String::new(), String::new());
    for effect in effects { apply(store, &plan, effect)?; }
    Ok(())
}

/// Bounded transfer turns for two independently admitted computers. Every
/// function touches ONE local supply. The existing sealed group transport
/// must authenticate account/history, both members, canonical staged revision
/// and this exact move before exposing source bytes to `accept`/`activate`.
/// These bytes are plaintext protocol material, never a public request body.
pub mod portable {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct Request {
        pub plan: Plan,
        pub shape: String,
        pub step: Step,
    }
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub enum Step {
        Copy { family: usize, cursor: Option<Vec<Cell>> },
        Replay { after: i64 },
        Verify { through: i64, family: usize, cursor: Option<Vec<Cell>> },
    }
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct Response {
        pub request: Request,
        pub source_through: i64,
        pub sealed: bool,
        pub next_commit: Option<i64>,
        pub effects: Vec<Effect>,
    }
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    pub struct Seal {
        pub plan: Plan,
        pub shape: String,
        pub through: i64,
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Accepted {
        Advanced,
        Duplicate,
        AwaitSeal { through: i64 },
    }
    /// A native reservation from independently current canonical authority.
    /// A maintenance permit admitting a staged target is insufficient.
    pub trait ActivationGuard: FenceGuard {
        fn mark_outcome_unknown(&self);
    }
    pub trait TargetAuthority: Fence {
        fn hold_current(&self, incarnation: &str) -> Result<Box<dyn ActivationGuard>>;
    }

    fn bounded<T: Serialize>(value: &T, limits: Limits) -> Result<Vec<u8>> {
        let bytes = encode(value)?;
        if bytes.len() > limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        Ok(bytes)
    }
    fn received<T: for<'a> Deserialize<'a>>(bytes: &[u8], limits: Limits) -> Result<T> {
        if bytes.len() > limits.commit_bytes { return Err(crate::cause!(Error::TooBig)); }
        decode(bytes)
    }
    fn shape(store: &dyn Storage, plan: &Plan) -> Result<String> {
        let mut families = Vec::new();
        for selection in &plan.selections {
            let family = store.schema().family(&selection.family)?;
            let orders: Vec<_> = family.orders.iter().map(|(name, order)| {
                let only: Vec<_> = order.only.iter().map(|only|
                    serde_json::json!([only.field, only.equals, only.not])).collect();
                serde_json::json!([name, order.fields, only])
            }).collect();
            families.push(serde_json::json!([family.family, family.key, family.fields, family.arrival, orders]));
        }
        Ok(content_crypto::advanced::blake3::hash(&encode(&families)?).to_hex().to_string())
    }
    fn step(state: &State) -> Result<Option<Step>> {
        if state.source { return Err(crate::cause!(Error::Moved)); }
        Ok(match state.phase {
            Phase::Copy => Some(Step::Copy { family: state.family, cursor: state.cursor.clone() }),
            Phase::CatchUp => Some(Step::Replay { after: state.sequence }),
            Phase::Comparing => Some(Step::Verify { through: state.sequence, family: state.family, cursor: state.cursor.clone() }),
            Phase::Proved | Phase::Active => None,
            Phase::Sealed => return Err(crate::cause!(Error::Moved)),
        })
    }

    /// The target's durable cursor is the only source of a next request. A
    /// failed/lost caller reply simply regenerates that same request.
    pub fn request(target: &dyn Storage, plan: &Plan, limits: Limits, fence: &dyn Fence) -> Result<Option<Vec<u8>>> {
        validate(target, plan, limits)?;
        let _authority = fence.hold(&plan.target_incarnation)?;
        let read = Scope::begin(target, Intent::Read)?;
        let state = load(target, &plan.slot)?;
        if state.plan != *plan { return Err(crate::cause!(Error::Moved)); }
        let result = step(&state)?.map(|step| bounded(&Request { plan: plan.clone(), shape: shape(target, plan)?, step }, limits)).transpose()?;
        read.commit()?;
        Ok(result)
    }

    /// Export one local source snapshot page or one COMPLETE source command.
    /// Writes remain live until a separate durable seal is requested.
    pub fn export(source: &dyn Storage, plan: &Plan, request: &[u8], limits: Limits, fence: &dyn Fence) -> Result<Vec<u8>> {
        validate(source, plan, limits)?;
        let request: Request = received(request, limits)?;
        if request.plan != *plan || request.shape != shape(source, plan)? { return Err(crate::cause!(Error::Moved)); }
        let _authority = fence.hold(&plan.source_incarnation)?;
        let read = Scope::begin(source, Intent::Read)?;
        let state = load(source, &plan.slot)?;
        if !state.source || state.plan != *plan { return Err(crate::cause!(Error::Moved)); }
        let sealed = state.phase == Phase::Sealed;
        let mut next_commit = None;
        let effects = match &request.step {
            Step::Copy { family, cursor } => page(source, plan.selections.get(*family).ok_or(crate::cause!(Error::Invalid))?, cursor.as_deref(), limits)?,
            Step::Replay { after } => {
                if *after < 0 || *after > state.sequence { return Err(crate::cause!(Error::Moved)); }
                if *after == state.sequence { Vec::new() } else {
                    let next = after.checked_add(1).ok_or(crate::cause!(Error::TooBig))?;
                    let row = source.get(LOG, &[plan.slot.as_str().into(), next.into()], &[Read::at_most("body", limits.commit_bytes)])?.ok_or(crate::cause!(Error::Moved))?;
                    next_commit = Some(next);
                    match &row.0[0] { Value::Blob(bytes) => received(bytes, limits)?, _ => return Err(crate::cause!(Error::TooBig)) }
                }
            }
            Step::Verify { through, family, cursor } => {
                if !sealed || *through != state.sequence { return Err(crate::cause!(Error::Moved)); }
                page(source, plan.selections.get(*family).ok_or(crate::cause!(Error::Invalid))?, cursor.as_deref(), limits)?
            }
        };
        let bytes = bounded(&Response { request, source_through: state.sequence, sealed, next_commit, effects }, limits)?;
        read.commit()?;
        Ok(bytes)
    }

    /// Accept only the authenticated response to this target's exact durable
    /// request. Effects and cursor/frontier/duplicate receipt share one commit.
    pub fn accept(target: &dyn Storage, plan: &Plan, response: &[u8], limits: Limits, fence: &dyn Fence) -> Result<Accepted> {
        validate(target, plan, limits)?;
        let response: Response = received(response, limits)?;
        if response.request.plan != *plan || response.request.shape != shape(target, plan)? || response.source_through < 0 { return Err(crate::cause!(Error::Moved)); }
        let digest = content_crypto::advanced::blake3::hash(&bounded(&response, limits)?).to_hex().to_string();
        let _authority = fence.hold(&plan.target_incarnation)?;
        let tx = Scope::begin(target, Intent::Write)?;
        let mut state = load(target, &plan.slot)?;
        if state.plan != *plan || state.source { return Err(crate::cause!(Error::Moved)); }
        if state.last_portable.as_deref() == Some(&digest) { return Ok(Accepted::Duplicate); }
        if step(&state)?.as_ref() != Some(&response.request.step) { return Err(crate::cause!(Error::Conflict)); }
        let mut outcome = Accepted::Advanced;
        match &response.request.step {
            Step::Copy { family, cursor } => {
                if response.next_commit.is_some() || response.effects.len() > limits.page_rows { return Err(crate::cause!(Error::Invalid)); }
                let selection = plan.selections.get(*family).ok_or(crate::cause!(Error::Invalid))?;
                // Validate shape and membership before changing anything. The
                // supply's declared key order validates the final page again
                // during sealed comparison, including extra/missing rows.
                if response.effects.iter().any(|effect| effect.family != selection.family || effect.row.is_none()
                    || !effect.key.starts_with(&selection.prefix) || cursor.as_ref().is_some_and(|cursor| effect.key == *cursor)) { return Err(crate::cause!(Error::Invalid)); }
                for effect in &response.effects { apply(target, plan, effect)?; }
                if let Some(last) = response.effects.last() { state.cursor = Some(last.key.clone()); }
                else { state.family += 1; state.cursor = None; }
                if state.family == plan.selections.len() { state.phase = Phase::CatchUp; }
            }
            Step::Replay { after } => {
                if let Some(next) = response.next_commit {
                    if next != after.checked_add(1).ok_or(crate::cause!(Error::TooBig))? || next > response.source_through || response.effects.is_empty() { return Err(crate::cause!(Error::Moved)); }
                    for effect in &response.effects { apply(target, plan, effect)?; }
                    state.sequence = next;
                } else {
                    if !response.effects.is_empty() || response.source_through != *after { return Err(crate::cause!(Error::Moved)); }
                    if response.sealed { state.phase = Phase::Comparing; state.family = 0; state.cursor = None; }
                    else { outcome = Accepted::AwaitSeal { through: *after }; }
                }
            }
            Step::Verify { through, family, cursor } => {
                if !response.sealed || response.next_commit.is_some() || *through != response.source_through { return Err(crate::cause!(Error::Moved)); }
                let selection = plan.selections.get(*family).ok_or(crate::cause!(Error::Invalid))?;
                if page(target, selection, cursor.as_deref(), limits)? != response.effects { return Err(crate::cause!(Error::Conflict)); }
                if let Some(last) = response.effects.last() { state.cursor = Some(last.key.clone()); }
                else { state.family += 1; state.cursor = None; }
                if state.family == plan.selections.len() { state.phase = Phase::Proved; }
            }
        }
        state.last_portable = Some(digest);
        save(target, &state)?;
        tx.commit()?;
        Ok(outcome)
    }

    /// A source-owned durable seal response, carried only by authenticated
    /// maintenance transport. Its local owner also mints SealedSourceProof for
    /// canonical retirement; the destination never invents a local source.
    pub fn seal_reply(source: &dyn Storage, plan: &Plan, limits: Limits, fence: &dyn Fence) -> Result<Vec<u8>> {
        validate(source, plan, limits)?;
        let through = seal(source, plan, fence)?;
        bounded(&Seal { plan: plan.clone(), shape: shape(source, plan)?, through }, limits)
    }

    /// Activate after authenticated canonical retirement and a full sealed
    /// target comparison. The protected physical header changes alongside
    /// Active; ordinary native reads need this current-target reservation.
    pub fn activate(target: &dyn Storage, plan: &Plan, seal: &[u8], limits: Limits,
        authority: &dyn TargetAuthority, transition: impl FnOnce(&dyn Storage) -> Result<()>) -> Result<()> {
        validate(target, plan, limits)?;
        let seal: Seal = received(seal, limits)?;
        if seal.plan != *plan || seal.shape != shape(target, plan)? { return Err(crate::cause!(Error::Moved)); }
        let permit = authority.hold_current(&plan.target_incarnation)?;
        let tx = Scope::begin(target, if target.scoped() {Intent::Nested} else {Intent::Write})?;
        let mut state = load(target, &plan.slot)?;
        if state.source || state.plan != *plan || state.sequence != seal.through { return Err(crate::cause!(Error::Moved)); }
        if state.phase == Phase::Active { return Ok(()); }
        if state.phase != Phase::Proved { return Err(crate::cause!(Error::Conflict)); }
        transition(target)?;
        state.phase = Phase::Active;
        save(target, &state)?;
        tx.commit().map_err(|error| { permit.mark_outcome_unknown(); error })
    }
}
