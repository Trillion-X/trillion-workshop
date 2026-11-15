//! Bounded, DATA-driven workspace show-rule reads and decisions.
//!
//! This module owns rule ordering and show semantics only. Current account,
//! operator, shared-space, clock and formula owners are injected and rechecked
//! before a result is returned. `None` means an owner proved absence; an owner
//! failure is never converted into an empty record, no-giver or false match.
pub mod formula;

use crate::ecma_json::{JsString, Object, Value};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    time::{Duration, Instant},
};

const MAX_NODES: usize = 100_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_DEPTH: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Unavailable(crate::refusal_cause::Cause),
    Changed(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::Unavailable(cause) => cause,
            Self::Changed(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cause={}", match self {
            Self::Invalid(_) => "show-rule input refused",
            Self::Bounds(_) => "show-rule work exceeds bounds",
            Self::Unavailable(_) => "current show-rule owner unavailable",
            Self::Changed(_) => "current show-rule owner changed",
        }, self.cause())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Authority {
    Personal,
    Operator,
}
impl Authority {
    fn text(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Operator => "operator",
        }
    }
}

/// The native shared-resource owner supplies the authenticated role-derived
/// type graph. A caller-supplied space id never supplies a role.
#[derive(Clone)]
pub struct GivenContext {
    pub giver: Value,
    pub facts: Value,
    pub space_types: Vec<Value>,
    /// `accountRuleFields` built by the same current source read as `giver`
    /// and `facts`; never reconstructed from fact values or subject DATA.
    pub audience_fields: Vec<Value>,
}
impl fmt::Debug for GivenContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GivenContext([redacted])")
    }
}

/// Exact composition point for current, rights-checked native owners. Each
/// optional result uses `None` only for a proved absent record/context.
pub trait CurrentOwner {
    fn assert_current(&mut self) -> Result<()>;
    fn authority(&mut self) -> Result<Authority>;
    fn personal_record(&mut self, label: &str) -> Result<Option<Value>>;
    fn given_context(&mut self, space_id: Option<&str>) -> Result<Option<GivenContext>>;
    /// Canonical fact reader for declarations sourced from the thing or other
    /// current records. A missing fact is represented by JSON null.
    fn thing_facts(&mut self, declarations: &[Value], thing: &Value, now_ms: i64) -> Result<Value>;
    fn edit_rules_now(
        &mut self,
        record: Option<&Value>,
        authority: Authority,
        now_ms: i64,
    ) -> Result<Value>;
    fn attribute_fields(&mut self, record: Option<&Value>) -> Result<Value>;
    fn controls(&mut self) -> Result<Value>;
    fn operators(&mut self) -> Result<Value>;
}

/// Shared formula owner boundary. This module never interprets rule operators.
/// `incomplete` contains formula-owner diagnostics; missing/invalid owner
/// output is an error, not a non-match.
pub struct FormulaAnswer {
    pub matches: bool,
    pub incomplete: Vec<Value>,
}
pub trait FormulaOwner {
    /// Evaluate against one row using the caller's explicit field declarations.
    /// Subject and account-audience schemas are distinct and must stay attached
    /// to the source snapshot that produced their rows.
    fn matches(&mut self, tree: &Value, row: &Value, fields: &[Value]) -> Result<FormulaAnswer>;
}

/// Timezone conversion and next-turn calculation remain with the injected
/// clock owner (including its UTC fallback and DST behavior).
#[derive(Clone)]
pub struct ClockFacts {
    pub hour: Option<i64>,
    pub minute: Option<i64>,
    pub weekday: Option<String>,
}
pub trait ClockOwner {
    fn now_ms(&mut self) -> Result<i64>;
    /// `show-rules.mjs` timeOf: numbers are already milliseconds; strings use
    /// the old JavaScript's Date.parse semantics.
    fn time_of(&mut self, value: &Value) -> Result<Option<i64>>;
    /// `show-rules-store.mjs` current: Date.parse(value), after its JS-falsy
    /// no-expiry check. This intentionally differs from timeOf for numbers.
    fn date_parse(&mut self, value: &Value) -> Result<Option<i64>>;
    fn facts(&mut self, now_ms: i64, time_zone: Option<&str>) -> Result<ClockFacts>;
    fn next_turn(
        &mut self,
        now_ms: i64,
        turns: &str,
        time_zone: Option<&str>,
    ) -> Result<Option<i64>>;
    /// The canonical sidebar fact owner handles measured facts and current
    /// record reads used by `nextTurn`.
    fn rule_turn(
        &mut self,
        now_ms: i64,
        tree: &Value,
        declarations: &[Value],
        thing: &Value,
        time_zone: Option<&str>,
    ) -> Result<Option<i64>>;
}

#[derive(Copy, Clone, Debug)]
pub struct Limits {
    pub nodes: usize,
    pub bytes: usize,
    pub depth: usize,
    pub elapsed: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            nodes: MAX_NODES,
            bytes: MAX_BYTES,
            depth: MAX_DEPTH,
            elapsed: Duration::from_secs(2),
        }
    }
}
impl Limits {
    fn valid(self) -> bool {
        self.nodes > 0
            && self.nodes <= MAX_NODES
            && self.bytes > 0
            && self.bytes <= MAX_BYTES
            && self.depth > 0
            && self.depth <= MAX_DEPTH
            && !self.elapsed.is_zero()
            && self.elapsed <= Duration::from_secs(10)
    }
}

struct Meter {
    limits: Limits,
    nodes: usize,
    bytes: usize,
    deadline: Instant,
}
impl Meter {
    fn new(limits: Limits) -> Result<Self> {
        if !limits.valid() {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(Self {
            limits,
            nodes: 0,
            bytes: 0,
            deadline: Instant::now() + limits.elapsed,
        })
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        if Instant::now() >= self.deadline {
            return Err(crate::cause!(Error::Bounds));
        }
        self.nodes = self.nodes.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        self.bytes = self.bytes.checked_add(bytes).ok_or(crate::cause!(Error::Bounds))?;
        if self.nodes > self.limits.nodes || self.bytes > self.limits.bytes {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(())
    }
    fn walk(&mut self, value: &Value, depth: usize) -> Result<()> {
        if depth > self.limits.depth {
            return Err(crate::cause!(Error::Bounds));
        }
        match value {
            Value::Object(obj) => {
                self.charge(64 + obj.len() * 24)?;
                for (key, child) in obj.insertion_entries() {
                    self.charge(key.len() * 2)?;
                    let name = key.to_rust_string().ok();
                    if matches!(name.as_deref(), Some("subjects")) {
                        if let Value::Object(subjects) = child {
                            for (subject, _) in subjects.insertion_entries() {
                                subject.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
                            }
                        }
                    }
                    if name.as_deref() == Some("starting") {
                        if let Value::Object(starting) = child {
                            for (id, _) in starting.insertion_entries() {
                                id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
                            }
                        }
                    }
                    if matches!(
                        name.as_deref(),
                        Some(
                            "id" | "subject"
                                | "effect"
                                | "field"
                                | "operator"
                                | "combinator"
                                | "time_zone"
                                | "space_id"
                                | "from_time"
                                | "moment"
                                | "turns"
                        )
                    ) {
                        if let Value::String(text) = child {
                            text.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
                        }
                    }
                    if matches!(
                        name.as_deref(),
                        Some("inherits" | "in_use" | "cohorts" | "knownness_operators" | "path")
                    ) {
                        for item in arr(Some(child)) {
                            if let Value::String(text) = item {
                                text.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
                            }
                        }
                    }
                    self.walk(child, depth + 1)?;
                }
            }
            Value::Array(items) => {
                self.charge(32 + items.len() * 8)?;
                for child in items {
                    self.walk(child, depth + 1)?;
                }
            }
            Value::String(text) => self.charge(16 + text.len() * 2)?,
            _ => self.charge(16)?,
        }
        Ok(())
    }
}

fn s(value: &Value) -> Option<String> {
    match value {
        Value::String(v) => v.to_rust_string().ok(),
        _ => None,
    }
}
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(v) => v.get(&JsString::from(key)),
        _ => None,
    }
}
fn arr(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(v)) => v,
        _ => &[],
    }
}
fn obj() -> Value {
    Value::Object(Object::new())
}
fn put(value: &mut Value, key: &str, child: Value) {
    if let Value::Object(o) = value {
        o.insert(JsString::from(key), child);
    }
}
fn text(value: impl Into<String>) -> Value {
    Value::String(JsString::from(value.into()))
}
fn boolv(value: bool) -> Value {
    Value::Bool(value)
}
fn string_field(value: &Value, field: &str) -> Option<String> {
    get(value, field).and_then(s)
}
fn truthy_on(value: &Value) -> bool {
    !matches!(get(value, "on"), Some(Value::Bool(false)))
}
fn clone_object(value: &Value) -> Value {
    match value {
        Value::Object(o) => Value::Object(o.clone()),
        _ => obj(),
    }
}
fn set(value: &mut Value, key: &str, child: Value) {
    put(value, key, child);
}

/// Every type a giver offers: the types their own record keeps, one per id (a later one with the same id wins).
/// No type ships in DATA, so this reads only the record (old trillion 190f72754e show-rules.mjs typesOf).
fn types_of(record: Option<&Value>, meter: &mut Meter) -> Result<Vec<Value>> {
    let mut by_id: Vec<Value> = Vec::new();
    let mut positions = HashMap::<String, usize>::new();
    for ty in arr(record.and_then(|v| get(v, "types"))) {
        meter.walk(ty, 0)?;
        if !matches!(ty, Value::Object(_)) {
            continue;
        }
        let Some(id) = string_field(ty, "id").filter(|x| !x.trim().is_empty()) else {
            continue;
        };
        if let Some(at) = positions.get(&id).copied() {
            by_id[at] = ty.clone();
        } else {
            positions.insert(id, by_id.len());
            by_id.push(ty.clone());
        }
    }
    Ok(by_id)
}

fn held_types(types: &[Value], held: &[Value], meter: &mut Meter) -> Result<Vec<usize>> {
    let ids: HashMap<String, usize> = types
        .iter()
        .enumerate()
        .filter_map(|(i, t)| string_field(t, "id").map(|id| (id, i)))
        .collect();
    let mut seen = HashSet::new();
    let mut level: Vec<usize> = held
        .iter()
        .filter_map(s)
        .filter_map(|id| ids.get(&id).copied())
        .collect();
    let mut output = Vec::new();
    let mut depth = 0;
    while !level.is_empty() {
        if depth > meter.limits.depth || output.len() > meter.limits.nodes {
            return Err(crate::cause!(Error::Bounds));
        }
        let mut next = Vec::new();
        for idx in level {
            if !seen.insert(idx) {
                continue;
            }
            output.push(idx);
            for parent in arr(get(&types[idx], "inherits")) {
                meter.charge(8)?;
                if let Some(id) = s(parent).and_then(|x| ids.get(&x).copied()) {
                    next.push(id);
                }
            }
        }
        level = next;
        depth += 1;
    }
    Ok(output)
}

fn rules_of_types(
    types: &[Value],
    held: &[Value],
    family: &str,
    meter: &mut Meter,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut named = HashSet::new();
    for index in held_types(types, held, meter)? {
        let ty = &types[index];
        let ty_id = string_field(ty, "id").unwrap_or_default();
        let label = get(ty, "label")
            .filter(|v| !matches!(v, Value::Null))
            .cloned()
            .unwrap_or_else(|| text(ty_id.clone()));
        for rule in arr(get(ty, family)) {
            meter.walk(rule, 0)?;
            if !matches!(rule, Value::Object(_)) {
                continue;
            }
            let Some(id) = string_field(rule, "id") else {
                continue;
            };
            if !named.insert(id.clone()) {
                continue;
            }
            if !truthy_on(rule) {
                continue;
            }
            let mut copied = clone_object(rule);
            set(&mut copied, "id", text(format!("type:{ty_id}:{id}")));
            set(&mut copied, "given", label.clone());
            out.push(copied);
        }
    }
    Ok(out)
}

fn types_for(
    record: Option<&Value>,
    extra: &[Value],
    space: Option<&str>,
    meter: &mut Meter,
) -> Result<Vec<Value>> {
    let mut types = types_of(record, meter)?;
    for ty in extra {
        meter.walk(ty, 0)?;
    }
    types.extend(extra.iter().cloned());
    types.retain(|ty| match get(ty, "scope") {
        None | Some(Value::Null) => true,
        Some(scope) => match (space, get(scope, "space_id")) {
            (None, Some(Value::Null)) => true,
            (Some(wanted), Some(Value::String(actual))) => {
                actual.to_rust_string().ok().as_deref() == Some(wanted)
            }
            _ => false,
        },
    });
    Ok(types)
}

fn profile_rules(
    record: Option<&Value>,
    space: Option<&str>,
    meter: &mut Meter,
) -> Result<Vec<Value>> {
    let types = types_for(record, &[], space, meter)?;
    rules_of_types(
        &types,
        arr(record.and_then(|v| get(v, "in_use"))),
        "rules",
        meter,
    )
}

fn validate_formula_fields(fields: &[Value], meter: &mut Meter, required: bool) -> Result<()> {
    if required && fields.is_empty() {
        return Err(crate::cause!(Error::Unavailable));
    }
    let mut ids = HashSet::new();
    for field in fields {
        meter.walk(field, 0)?;
        let id = string_field(field, "id")
            .filter(|id| !id.trim().is_empty())
            .ok_or(crate::cause!(Error::Invalid))?;
        string_field(field, "kind")
            .filter(|kind| !kind.trim().is_empty())
            .ok_or(crate::cause!(Error::Invalid))?;
        if !ids.insert(id) {
            return Err(crate::cause!(Error::Invalid));
        }
    }
    Ok(())
}

fn subject_fields(facts: &[Value], meter: &mut Meter) -> Result<Vec<Value>> {
    let mut fields = Vec::with_capacity(facts.len());
    for fact in facts {
        let id = get(fact, "id")
            .and_then(s)
            .filter(|id| !id.trim().is_empty())
            .ok_or(crate::cause!(Error::Invalid))?;
        let kind = get(fact, "kind")
            .and_then(s)
            .filter(|kind| !kind.trim().is_empty())
            .ok_or(crate::cause!(Error::Invalid))?;
        let mut field = obj();
        set(&mut field, "id", text(id));
        set(&mut field, "kind", text(kind));
        fields.push(field);
    }
    validate_formula_fields(&fields, meter, false)?;
    Ok(fields)
}

fn audience_matches<F: FormulaOwner>(
    formula: &mut F,
    tree: &Value,
    facts: &Value,
    fields: &[Value],
    meter: &mut Meter,
) -> Result<bool> {
    validate_formula_fields(fields, meter, true)?;
    let answer = formula.matches(tree, facts, fields)?;
    if !answer.incomplete.is_empty() {
        return Err(crate::cause!(Error::Unavailable));
    }
    Ok(answer.matches)
}

fn given_family_rules<F: FormulaOwner>(
    context: Option<&GivenContext>,
    space: Option<&str>,
    family: &str,
    formula: &mut F,
    meter: &mut Meter,
) -> Result<Vec<Value>> {
    let Some(context) = context else {
        return Ok(Vec::new());
    };
    meter.walk(&context.giver, 0)?;
    meter.walk(&context.facts, 0)?;
    for field in &context.audience_fields {
        meter.walk(field, 0)?;
    }
    let types = types_for(
        Some(&context.giver),
        &context.space_types,
        space,
        meter,
    )?;
    let mut assigned = arr(get(&context.facts, "cohorts")).to_vec();
    for ty in &types {
        if let Some(audience) = get(ty, "audience").filter(|x| matches!(x, Value::Object(_))) {
            if audience_matches(
                formula,
                audience,
                &context.facts,
                &context.audience_fields,
                meter,
            )? {
                if let Some(id) = get(ty, "id") {
                    assigned.push(id.clone());
                }
            }
        }
    }
    let mut out = rules_of_types(&types, &assigned, family, meter)?;
    for rule in arr(get(&context.giver, family)) {
        meter.walk(rule, 0)?;
        if !matches!(rule, Value::Object(_)) || !truthy_on(rule) {
            continue;
        }
        let Some(audience) = get(rule, "audience").filter(|x| matches!(x, Value::Object(_))) else {
            continue;
        };
        if audience_matches(
            formula,
            audience,
            &context.facts,
            &context.audience_fields,
            meter,
        )? {
            let id = string_field(rule, "id").unwrap_or_default();
            let mut copy = clone_object(rule);
            if let Value::Object(o) = &mut copy {
                let mut kept = Object::new();
                for (k, v) in o.insertion_entries() {
                    if k != &JsString::from("audience") {
                        kept.insert(k.clone(), v.clone());
                    }
                }
                *o = kept;
            }
            set(&mut copy, "id", text(format!("given:{id}")));
            let given = get(rule, "label")
                .filter(|v| {
                    !matches!(v, Value::Null) && !matches!(v, Value::String(s) if s.is_empty())
                })
                .cloned()
                .unwrap_or_else(|| text(id.clone()));
            set(&mut copy, "given", given);
            out.push(copy);
        }
    }
    Ok(out)
}

fn given_rules<F: FormulaOwner>(
    context: Option<&GivenContext>,
    space: Option<&str>,
    formula: &mut F,
    meter: &mut Meter,
) -> Result<Vec<Value>> {
    given_family_rules(context, space, "rules", formula, meter)
}

/// The native account joins the original edit-policy family through this same
/// rule/type/audience evaluator. Supplied context is still provisional data;
/// its current source and disclosure remain with the actual account owner.
pub fn current_given_edit_rules<F: FormulaOwner>(
    data: &Value,
    context: Option<&GivenContext>,
    formula: &mut F,
    limits: Limits,
) -> Result<Vec<Value>> {
    let mut meter = Meter::new(limits)?;
    meter.walk(data, 0)?;
    given_family_rules(context, None, "edit_rules", formula, &mut meter)
}

fn every_rule(data: &Value, record: Option<&Value>, meter: &mut Meter) -> Result<Vec<Value>> {
    let starting = record.and_then(|v| get(v, "starting"));
    let mut out = Vec::new();
    for rule in arr(get(data, "starting_rules")) {
        meter.walk(rule, 0)?;
        let mut copy = clone_object(rule);
        set(&mut copy, "starting", boolv(true));
        let enabled = string_field(rule, "id")
            .and_then(|id| starting.and_then(|v| get(v, &id)))
            .map(|v| !matches!(get(v, "on"), Some(Value::Bool(false))))
            .unwrap_or(true);
        set(&mut copy, "on", boolv(enabled));
        out.push(copy);
    }
    for rule in arr(record.and_then(|v| get(v, "rules"))) {
        meter.walk(rule, 0)?;
        let mut copy = clone_object(rule);
        set(&mut copy, "on", boolv(truthy_on(rule)));
        out.push(copy);
    }
    Ok(out)
}

fn read_until_active(value: Option<&Value>, now: i64, clock: &mut impl ClockOwner) -> Result<bool> {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(true),
        Some(Value::Number(n)) if *n == 0.0 => Ok(true),
        Some(Value::String(text)) if text.is_empty() => Ok(true),
        Some(value) => Ok(clock.date_parse(value)?.map(|at| at > now).unwrap_or(false)),
    }
}
fn rule_leaves<'a>(
    tree: &'a Value,
    out: &mut Vec<&'a Value>,
    meter: &mut Meter,
    depth: usize,
) -> Result<()> {
    if depth > meter.limits.depth {
        return Err(crate::cause!(Error::Bounds));
    };
    meter.charge(1)?;
    if string_field(tree, "kind").as_deref() == Some("group") {
        for node in arr(get(tree, "rules")) {
            rule_leaves(node, out, meter, depth + 1)?;
        }
    } else if string_field(tree, "kind").as_deref() == Some("rule") {
        out.push(tree)
    }
    Ok(())
}
fn fact_value(fact: &Value, thing: &Value, moment: &Value, now: i64, clock: &ClockFacts) -> Value {
    let id = string_field(fact, "id").unwrap_or_default();
    if matches!(get(fact, "clock"), Some(Value::Bool(true))) {
        return Value::Number(now as f64);
    }
    if let Some(from) = string_field(fact, "from_time") {
        return match from.as_str() {
            "hour" => clock.hour.map(|v| Value::Number(v as f64)),
            "weekday" => clock.weekday.clone().map(text),
            _ => None,
        }
        .unwrap_or(Value::Null);
    }
    if let Some(m) = string_field(fact, "moment") {
        return get(moment, &m)
            .or_else(|| get(thing, &id))
            .cloned()
            .unwrap_or(Value::Null);
    }
    let path = arr(get(fact, "path"));
    let mut at = thing;
    for part in path {
        let Some(key) = s(part) else {
            return Value::Null;
        };
        let Some(next) = get(at, &key) else {
            return Value::Null;
        };
        at = next;
    }
    at.clone()
}

fn rule_facts(
    data: &Value,
    subject: &str,
    when: Option<&Value>,
    meter: &mut Meter,
) -> Result<Vec<Value>> {
    let declared = get(get(data, "subjects").unwrap_or(&Value::Null), subject);
    let mut facts = arr(declared.and_then(|x| get(x, "facts"))).to_vec();
    facts.extend(arr(get(data, "moment_facts")).iter().cloned());
    let mut known: HashSet<String> = facts.iter().filter_map(|f| string_field(f, "id")).collect();
    let mut leaves = Vec::new();
    if let Some(when) = when {
        rule_leaves(when, &mut leaves, meter, 0)?;
    }
    for leaf in leaves {
        if let Some(field) = string_field(leaf, "field").filter(|f| !known.contains(f)) {
            let mut f = obj();
            set(&mut f, "id", text(field.clone()));
            set(&mut f, "kind", text("choice"));
            set(&mut f, "path", Value::Array(vec![text(field.clone())]));
            facts.push(f);
            known.insert(field);
        }
    }
    Ok(facts)
}

pub struct ShowRules<'a, O, F, C> {
    pub data: &'a Value,
    pub owner: &'a mut O,
    pub formula: &'a mut F,
    pub clock: &'a mut C,
    pub limits: Limits,
}
impl<O: CurrentOwner, F: FormulaOwner, C: ClockOwner> ShowRules<'_, O, F, C> {
    fn begin(&mut self) -> Result<(Meter, Option<Value>, Authority)> {
        let mut meter = Meter::new(self.limits)?;
        meter.walk(self.data, 0)?;
        self.owner.assert_current()?;
        let authority = self.owner.authority()?;
        let label = string_field(self.data, "record").ok_or(crate::cause!(Error::Invalid))?;
        let record = self.owner.personal_record(&label)?;
        if let Some(record) = &record {
            meter.walk(record, 0)?;
        }
        Ok((meter, record, authority))
    }
    fn finish(&mut self) -> Result<()> {
        self.owner.assert_current()
    }
    pub fn read(&mut self) -> Result<Value> {
        let (mut meter, record, authority) = self.begin()?;
        let context = self.owner.given_context(None)?;
        let mut rules = every_rule(self.data, record.as_ref(), &mut meter)?;
        rules.extend(profile_rules(record.as_ref(), None, &mut meter)?);
        rules.extend(given_rules(
            context.as_ref(),
            None,
            self.formula,
            &mut meter,
        )?);
        let now = self.clock.now_ms()?;
        let mut active_rules = Vec::with_capacity(rules.len());
        for rule in rules {
            if read_until_active(get(&rule, "until"), now, self.clock)? {
                active_rules.push(rule);
            }
        }
        let rules = active_rules;
        let edit = self.owner.edit_rules_now(record.as_ref(), authority, now)?;
        if !matches!(&edit, Value::Object(_))
            || !matches!(get(&edit, "rules"), Some(Value::Array(_)))
        {
            return Err(crate::cause!(Error::Unavailable));
        }
        meter.walk(&edit, 0)?;
        let controls = self.owner.controls()?;
        let operators = self.owner.operators()?;
        let attribute_fields = self.owner.attribute_fields(record.as_ref())?;
        meter.walk(&controls, 0)?;
        meter.walk(&operators, 0)?;
        meter.walk(&attribute_fields, 0)?;
        let subjects = read_subjects(self.data, authority, &mut meter)?;
        let types = types_of(record.as_ref(), &mut meter)?;
        let mut type_rows = Vec::new();
        for ty in types {
            meter.walk(&ty, 0)?;
            let mut row = obj();
            if let Some(id) = get(&ty, "id") {
                set(&mut row, "id", id.clone());
            }
            let id_fallback = get(&ty, "id").cloned().unwrap_or(Value::Null);
            let label = get(&ty, "label")
                .filter(|v| !matches!(v, Value::Null))
                .cloned()
                .unwrap_or(id_fallback);
            set(&mut row, "label", label);
            for key in ["inherits", "rules"] {
                set(
                    &mut row,
                    key,
                    get(&ty, key)
                        .filter(|v| !matches!(v, Value::Null))
                        .cloned()
                        .unwrap_or(Value::Array(Vec::new())),
                );
            }
            for key in ["edit_rules", "audience", "scope"] {
                if let Some(v) = get(&ty, key).filter(|v| !matches!(v, Value::Null)) {
                    set(&mut row, key, v.clone());
                }
            }
            type_rows.push(row);
        }
        let effects = word_rows(arr(get(self.data, "effects")), &mut meter)?;
        let moments = word_rows(arr(get(self.data, "moment_facts")), &mut meter)?;
        let quick = word_rows(arr(get(self.data, "quick")), &mut meter)?;
        let mut result = obj();
        let on = rules
            .iter()
            .filter(|rule| matches!(get(rule, "on"), Some(Value::Bool(true))))
            .count();
        set(&mut result, "rules", Value::Array(rules));
        set(&mut result, "subjects", subjects);
        set(&mut result, "authority", text(authority.text()));
        let mut edit_authority = obj();
        for key in ["actions", "effects", "facts"] {
            if let Some(v) = get(
                get(self.data, "edit_authority").unwrap_or(&Value::Null),
                key,
            ) {
                set(&mut edit_authority, key, v.clone());
            }
        }
        if let Some(v) = get(&edit, "rules") {
            set(&mut edit_authority, "rules", v.clone());
        } else {
            set(&mut edit_authority, "rules", Value::Array(Vec::new()));
        }
        set(&mut result, "edit_authority", edit_authority);
        set(&mut result, "types", Value::Array(type_rows));
        set(&mut result, "attribute_fields", attribute_fields);
        let in_use = match record.as_ref().and_then(|r| get(r, "in_use")) {
            Some(Value::Array(values)) => Value::Array(values.clone()),
            _ => Value::Array(Vec::new()),
        };
        set(&mut result, "in_use", in_use);
        set(
            &mut result,
            "record",
            get(self.data, "record").cloned().unwrap_or(Value::Null),
        );
        set(&mut result, "moment_facts", moments);
        set(&mut result, "effects", effects);
        set(&mut result, "quick", quick);
        set(&mut result, "operators", operators);
        set(&mut result, "controls", controls);
        set(
            &mut result,
            "said",
            text(if on > 0 {
                format!("{on} rules are on.")
            } else {
                "No rules are on: everything shows.".to_string()
            }),
        );
        meter.walk(&result, 0)?;
        self.finish()?;
        Ok(result)
    }
    pub fn decide(
        &mut self,
        subject: &str,
        thing: &Value,
        moment: &Value,
        space_id: Option<&str>,
    ) -> Result<Value> {
        if subject.is_empty() || subject.len() > 256 || subject.chars().any(char::is_control) {
            return Err(crate::cause!(Error::Invalid));
        }
        let (mut meter, record, _authority) = self.begin()?;
        meter.walk(thing, 0)?;
        meter.walk(moment, 0)?;
        let context = self.owner.given_context(space_id)?;
        let mut rules = every_rule(self.data, record.as_ref(), &mut meter)?;
        rules.extend(profile_rules(
            record.as_ref(),
            space_id,
            &mut meter,
        )?);
        rules.extend(given_rules(
            context.as_ref(),
            space_id,
            self.formula,
            &mut meter,
        )?);
        let now = self.clock.now_ms()?;
        self.decide_rules(subject, thing, moment, rules, meter, now)
    }

    /// Reuse the decision engine for rules already read and selected by a
    /// current trusted source owner (for example setup's operator then personal
    /// policy phases). This grants no authority and does not load unrelated
    /// personal/profile/given rules. The caller keeps source selection and
    /// validation in its original owner. Currentness is checked around output.
    pub fn decide_selected_rules(
        &mut self,
        subject: &str,
        thing: &Value,
        moment: &Value,
        rules: &[Value],
        now_ms: i64,
    ) -> Result<Value> {
        if subject.is_empty() || subject.len() > 256 || subject.chars().any(char::is_control) {
            return Err(crate::cause!(Error::Invalid));
        }
        let mut meter = Meter::new(self.limits)?;
        meter.walk(self.data, 0)?;
        self.owner.assert_current()?;
        meter.walk(thing, 0)?;
        meter.walk(moment, 0)?;
        let mut selected = Vec::with_capacity(rules.len());
        for rule in rules {
            meter.walk(rule, 0)?;
            selected.push(rule.clone());
        }
        self.decide_rules(subject, thing, moment, selected, meter, now_ms)
    }

    fn decide_rules(
        &mut self,
        subject: &str,
        thing: &Value,
        moment: &Value,
        mut rules: Vec<Value>,
        mut meter: Meter,
        now: i64,
    ) -> Result<Value> {
        rules.retain(truthy_on);
        let mut incomplete = Vec::new();
        let mut candidates = Vec::new();
        for rule in rules {
            if string_field(&rule, "subject").as_deref() != Some(subject) {
                continue;
            }
            let effect = string_field(&rule, "effect").unwrap_or_default();
            let Some(effect_row) = arr(get(self.data, "effects"))
                .iter()
                .find(|x| string_field(x, "id").as_deref() == Some(&effect))
            else {
                continue;
            };
            if let Some(until) = get(&rule, "until").filter(|v| !matches!(v, Value::Null)) {
                if let Some(at) = self.clock.time_of(until)? {
                    if at <= now {
                        continue;
                    }
                } else {
                    continue;
                }
            }
            let when = get(&rule, "when").filter(|x| !matches!(x, Value::Null));
            let facts = rule_facts(self.data, subject, when, &mut meter)?;
            let timezone =
                string_field(&rule, "time_zone").or_else(|| string_field(moment, "time_zone"));
            let clock = self.clock.facts(now, timezone.as_deref())?;
            let own_facts: Vec<Value> = facts
                .iter()
                .filter(|fact| {
                    get(fact, "clock").is_none()
                        && get(fact, "from_time").is_none()
                        && get(fact, "moment").is_none()
                })
                .cloned()
                .collect();
            let mut row = self.owner.thing_facts(&own_facts, thing, now)?;
            if !matches!(row, Value::Object(_)) {
                return Err(crate::cause!(Error::Unavailable));
            }
            for fact in &facts {
                let id = string_field(fact, "id").ok_or(crate::cause!(Error::Invalid))?;
                if matches!(get(fact, "clock"), Some(Value::Bool(true)))
                    || get(fact, "from_time").is_some()
                    || get(fact, "moment").is_some()
                {
                    set(&mut row, &id, fact_value(fact, thing, moment, now, &clock));
                }
            }
            meter.walk(&row, 0)?;
            let mut leaves = Vec::new();
            if let Some(tree) = when {
                rule_leaves(tree, &mut leaves, &mut meter, 0)?;
            }
            let strict = matches!(
                get(
                    get(get(self.data, "subjects").unwrap_or(&Value::Null), subject)
                        .unwrap_or(&Value::Null),
                    "strict_facts"
                ),
                Some(Value::Bool(true))
            );
            let knownness: HashSet<String> = arr(get(
                get(get(self.data, "subjects").unwrap_or(&Value::Null), subject)
                    .unwrap_or(&Value::Null),
                "knownness_operators",
            ))
            .iter()
            .filter_map(s)
            .collect();
            let mut missing = Vec::new();
            if strict {
                for leaf in &leaves {
                    let field = string_field(leaf, "field").unwrap_or_default();
                    let operator = string_field(leaf, "operator").unwrap_or_default();
                    if matches!(get(&row, &field), None | Some(Value::Null))
                        && !knownness.contains(&operator)
                    {
                        let mut p = obj();
                        set(
                            &mut p,
                            "rule",
                            get(&rule, "id").cloned().unwrap_or(Value::Null),
                        );
                        set(&mut p, "field", text(field));
                        set(&mut p, "reason", text("missing-fact"));
                        missing.push(p);
                    }
                }
            }
            if !missing.is_empty() {
                incomplete.extend(missing);
                continue;
            }
            let matched = match when {
                None => true,
                Some(tree) => {
                    let fields = subject_fields(&facts, &mut meter)?;
                    let answer = self.formula.matches(tree, &row, &fields)?;
                    if !answer.incomplete.is_empty() {
                        for mut p in answer.incomplete {
                            meter.walk(&p, 0)?;
                            if get(&p, "rule").is_none() {
                                set(
                                    &mut p,
                                    "rule",
                                    get(&rule, "id").cloned().unwrap_or(Value::Null),
                                );
                            }
                            incomplete.push(p);
                        }
                        if strict {
                            continue;
                        }
                    }
                    answer.matches
                }
            };
            let mut prepared = obj();
            set(&mut prepared, "rule", rule.clone());
            set(&mut prepared, "effect", effect_row.clone());
            set(&mut prepared, "matched", boolv(matched));
            candidates.push((prepared, clock, timezone, facts, when.cloned()));
        }
        // Complete matched rules resolve by DATA strength; changed effects are
        // returned separately and never compete with visibility effects.
        let mut held = Vec::new();
        let mut changes = Vec::new();
        let mut high = f64::NEG_INFINITY;
        for (entry, _, _, _, _) in &candidates {
            if !matches!(get(entry, "matched"), Some(Value::Bool(true))) {
                continue;
            }
            let rule = get(entry, "rule").unwrap();
            let effect = get(entry, "effect").unwrap();
            if matches!(get(effect, "changes"), Some(Value::Bool(true))) {
                changes.push(rule.clone());
            } else {
                held.push((rule.clone(), effect.clone()));
                high = high.max(number(get(effect, "strength")).unwrap_or(0.0));
            }
        }
        let winners: Vec<_> = held
            .iter()
            .filter(|(_, effect)| number(get(effect, "strength")).unwrap_or(0.0) == high)
            .collect();
        let shown = winners
            .iter()
            .any(|(_, effect)| matches!(get(effect, "shows"), Some(Value::Bool(true))));
        let holding: Vec<_> = held
            .iter()
            .filter(|(_, effect)| !matches!(get(effect, "changes"), Some(Value::Bool(true))))
            .collect();
        let hide_strength = arr(get(self.data, "effects"))
            .iter()
            .filter(|e| string_field(e, "id").as_deref() == Some("hide"))
            .filter_map(|e| number(get(e, "strength")))
            .next();
        let hidden = !shown
            && !holding.is_empty()
            && winners
                .iter()
                .any(|(_, e)| hide_strength == number(get(e, "strength")));
        let silenced = !shown && !holding.is_empty();
        let mut output_rules = Vec::new();
        for (rule, _) in holding {
            let mut row = obj();
            for key in ["id", "label", "effect", "until", "starting", "given"] {
                if let Some(v) = get(&rule, key) {
                    set(&mut row, key, v.clone());
                }
            }
            if get(&row, "label").is_none() {
                set(&mut row, "label", text(""));
            }
            if get(&row, "until").is_none() {
                set(&mut row, "until", Value::Null);
            }
            set(
                &mut row,
                "starting",
                boolv(matches!(get(&rule, "starting"), Some(Value::Bool(true)))),
            );
            output_rules.push(row);
        }
        let mut output_changes = Vec::new();
        for rule in changes {
            for one in arr(get(&rule, "set")) {
                let mut row = obj();
                set(
                    &mut row,
                    "rule",
                    get(&rule, "id").cloned().unwrap_or(Value::Null),
                );
                set(
                    &mut row,
                    "label",
                    get(&rule, "label").cloned().unwrap_or(text("")),
                );
                if let Some(v) = get(one, "path") {
                    set(&mut row, "path", v.clone());
                }
                if let Some(v) = get(one, "value") {
                    set(&mut row, "value", v.clone());
                }
                set(
                    &mut row,
                    "starting",
                    boolv(matches!(get(&rule, "starting"), Some(Value::Bool(true)))),
                );
                output_changes.push(row);
            }
        }
        let winners_until: Vec<_> = winners
            .iter()
            .map(|(r, _)| match get(r, "until") {
                None | Some(Value::Null) => Ok(None),
                Some(v) => self.clock.time_of(v),
            })
            .collect::<Result<Vec<_>>>()?;
        let until = if !winners.is_empty() && winners_until.iter().all(Option::is_some) {
            winners_until.into_iter().flatten().max()
        } else {
            None
        };
        let mut next: Option<i64> = None;
        for (entry, _clock, tz, facts, when) in &candidates {
            // Candidates retain their prepared match answer around the source
            // rule. Expiry belongs to that rule, not the preparation wrapper.
            let rule = get(entry, "rule").ok_or(crate::cause!(Error::Invalid))?;
            let rule_until = match get(rule, "until") {
                None | Some(Value::Null) => None,
                Some(v) => self.clock.time_of(v)?,
            };
            if get(rule, "until").is_none()
                || matches!(get(rule, "until"), Some(Value::Null))
                || rule_until.map(|x| x > now).unwrap_or(false)
            {
                if let Some(at) = rule_until.filter(|x| *x > now) {
                    next = Some(next.map(|n| n.min(at)).unwrap_or(at));
                }
                if let Some(tree) = when {
                    if let Some(at) = self
                        .clock
                        .rule_turn(now, tree, facts, thing, tz.as_deref())?
                        .filter(|at| *at > now)
                    {
                        next = Some(next.map(|n| n.min(at)).unwrap_or(at));
                    }
                    let mut leaves = Vec::new();
                    rule_leaves(tree, &mut leaves, &mut meter, 0)?;
                    let declarations = rule_facts(self.data, subject, Some(tree), &mut meter)?;
                    for leaf in leaves {
                        let field = string_field(leaf, "field").unwrap_or_default();
                        if let Some(fact) = declarations
                            .iter()
                            .find(|f| string_field(f, "id").as_deref() == Some(&field))
                        {
                            if let Some(turns) = string_field(fact, "turns") {
                                if let Some(at) =
                                    self.clock.next_turn(now, &turns, tz.as_deref())?
                                {
                                    if at > now {
                                        next = Some(next.map(|n| n.min(at)).unwrap_or(at));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut result = obj();
        set(&mut result, "hidden", boolv(hidden));
        set(&mut result, "silenced", boolv(silenced));
        set(
            &mut result,
            "until",
            until
                .map(|v| {
                    text(
                        chrono::DateTime::from_timestamp_millis(v)
                            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                            .unwrap_or_default(),
                    )
                })
                .unwrap_or(Value::Null),
        );
        set(&mut result, "rules", Value::Array(output_rules));
        set(&mut result, "changes", Value::Array(output_changes));
        set(
            &mut result,
            "next_change_at",
            next.map(|v| Value::Number(v as f64)).unwrap_or(Value::Null),
        );
        if matches!(
            get(
                get(get(self.data, "subjects").unwrap_or(&Value::Null), subject)
                    .unwrap_or(&Value::Null),
                "strict_facts"
            ),
            Some(Value::Bool(true))
        ) || !incomplete.is_empty()
        {
            set(&mut result, "incomplete", Value::Array(incomplete));
        }
        meter.walk(&result, 0)?;
        self.finish()?;
        Ok(result)
    }
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}
fn read_subjects(data: &Value, authority: Authority, meter: &mut Meter) -> Result<Value> {
    let Some(Value::Object(subjects)) = get(data, "subjects") else {
        return Err(crate::cause!(Error::Invalid));
    };
    let mut out = obj();
    for (id, subject) in subjects.insertion_entries() {
        meter.walk(subject, 0)?;
        let name = id.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))?;
        let mut row = obj();
        if let Some(label) = get(subject, "label") {
            set(&mut row, "label", label.clone());
        }
        set(
            &mut row,
            "facts",
            word_rows(arr(get(subject, "facts")), meter)?,
        );
        for key in ["allowed_effects"] {
            if let Some(v) = get(subject, key) {
                set(&mut row, key, v.clone());
            }
        }
        if let Some(fields) = get(subject, "change_fields") {
            let kept: Vec<_> = arr(Some(fields))
                .iter()
                .filter(|f| {
                    string_field(f, "authority")
                        .map(|a| a == authority.text())
                        .unwrap_or(true)
                })
                .cloned()
                .collect();
            set(&mut row, "change_fields", Value::Array(kept));
        }
        put(&mut out, &name, row);
    }
    Ok(out)
}
fn word_rows(rows: &[Value], meter: &mut Meter) -> Result<Value> {
    let mut out = Vec::new();
    for row in rows {
        meter.walk(row, 0)?;
        let mut word = obj();
        for key in ["id", "label", "kind", "choices"] {
            if let Some(v) = get(row, key) {
                set(&mut word, key, v.clone());
            }
        }
        out.push(word);
    }
    Ok(Value::Array(out))
}
