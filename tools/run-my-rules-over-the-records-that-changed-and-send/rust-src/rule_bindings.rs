//! Bounded DATA-driven compiler from formula-engine rule trees to bindings.
//!
//! Operator meaning remains in the operator vocabulary's binding templates.
//! This module fills templates and combines groups; it does not evaluate a
//! comparison or define an operator registry.
pub mod evaluator;
pub mod keep_condition;
pub mod rules_and_runs;

use crate::ecma_json::{JsString, Object, Value};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    time::{Duration, Instant},
};

const MAX_NODES: usize = 100_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_DEPTH: usize = 128;

#[derive(Clone, Debug)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Unsupported(crate::refusal_cause::Cause),
    Evaluator(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { match self {
        Self::Invalid(cause) => cause,
        Self::Bounds(cause) => cause,
        Self::Unsupported(cause) => cause,
        Self::Evaluator(cause) => cause,
    } }
}
crate::impl_caused!(Error);

impl PartialEq for Error { fn eq(&self, other: &Self) -> bool { std::mem::discriminant(self) == std::mem::discriminant(other) } }
impl Eq for Error {}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "rule binding input refused",
            Self::Bounds(_) => "rule binding work exceeds bounds",
            Self::Unsupported(_) => "rule binding operation is unsupported by the current owner",
            Self::Evaluator(_) => "binding evaluator unavailable",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug)]
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

#[derive(Clone, Copy, Default, Debug)]
pub struct Work {
    pub nodes: usize,
    pub bytes: usize,
}
struct Meter {
    limits: Limits,
    work: Work,
    deadline: Instant,
}
impl Meter {
    fn new(limits: Limits) -> Result<Self> {
        if !limits.valid() {
            return Err(crate::cause!(Error::Invalid));
        }
        Ok(Self {
            limits,
            work: Work::default(),
            deadline: Instant::now() + limits.elapsed,
        })
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        if Instant::now() >= self.deadline {
            return Err(crate::cause!(Error::Bounds));
        }
        self.work.nodes = self.work.nodes.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        self.work.bytes = self.work.bytes.checked_add(bytes).ok_or(crate::cause!(Error::Bounds))?;
        if self.work.nodes > self.limits.nodes || self.work.bytes > self.limits.bytes {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(())
    }
    fn walk(&mut self, value: &Value, depth: usize) -> Result<()> {
        if depth > self.limits.depth {
            return Err(crate::cause!(Error::Bounds));
        }
        match value {
            Value::Object(object) => {
                self.charge(
                    64usize
                        .checked_add(object.len().checked_mul(24).ok_or(crate::cause!(Error::Bounds))?)
                        .ok_or(crate::cause!(Error::Bounds))?,
                )?;
                for (key, child) in object.insertion_entries() {
                    self.charge(key.len().checked_mul(2).ok_or(crate::cause!(Error::Bounds))?)?;
                    self.walk(child, depth + 1)?;
                }
            }
            Value::Array(items) => {
                self.charge(
                    32usize
                        .checked_add(items.len().checked_mul(8).ok_or(crate::cause!(Error::Bounds))?)
                        .ok_or(crate::cause!(Error::Bounds))?,
                )?;
                for child in items {
                    self.walk(child, depth + 1)?;
                }
            }
            Value::String(string) => self.charge(
                16usize
                    .checked_add(string.len().checked_mul(2).ok_or(crate::cause!(Error::Bounds))?)
                    .ok_or(crate::cause!(Error::Bounds))?,
            )?,
            _ => self.charge(16)?,
        }
        Ok(())
    }
}

/// Default-locale case conversion and ECMAScript String.trim live with the
/// native text owner. Unsupported Unicode behavior must refuse, not drift.
pub trait TextSemantics {
    fn to_locale_lowercase(&mut self, value: &JsString) -> Result<JsString>;
    fn trim_is_empty(&mut self, value: &JsString) -> Result<bool>;
}

/// The existing formula evaluator is injected. The compiler never evaluates a
/// binding; the adapter must preserve ECMAScript strings or refuse lossily
/// encoded values before crossing into the Rust evaluator's input format.
pub trait BindingEvaluator {
    fn evaluate(&mut self, binding: &Value, input: &Value) -> Result<Value>;
}

/// A compiled tree. A null binding means no ready rule constrained the input;
/// `incomplete` preserves unfinished source rules in traversal order.
pub struct CompiledRules {
    pub binding: Option<Value>,
    pub reads: Vec<JsString>,
    pub incomplete: Vec<Value>,
    pub work: Work,
}
impl fmt::Debug for CompiledRules {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CompiledRules([redacted])")
    }
}
impl CompiledRules {
    /// Calls the injected canonical binding owner. A null binding means all
    /// rows match, matching the source compiler's empty-tree contract.
    pub fn evaluate(&self, evaluator: &mut impl BindingEvaluator, input: &Value) -> Result<Value> {
        match &self.binding {
            Some(binding) => evaluator.evaluate(binding, input),
            None => Ok(Value::Bool(true)),
        }
    }
}

fn get<'a>(value: &'a Value, key: &JsString) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(key),
        _ => None,
    }
}
fn get_s<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    get(value, &JsString::from(key))
}
fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}
fn string(value: Option<&Value>) -> Option<&JsString> {
    match value {
        Some(Value::String(value)) => Some(value),
        _ => None,
    }
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(Value::String(text)) => !text.is_empty(),
        _ => true,
    }
}
fn present(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        _ => true,
    }
}
fn object() -> Value {
    Value::Object(Object::new())
}
fn put(value: &mut Value, key: JsString, child: Value) {
    if let Value::Object(object) = value {
        object.insert(key, child);
    }
}
fn put_s(value: &mut Value, key: &str, child: Value) {
    put(value, JsString::from(key), child);
}

struct Vocabulary {
    operators: HashMap<JsString, Value>,
    combinators: HashMap<JsString, Value>,
    first: Option<JsString>,
}
impl Vocabulary {
    fn new(data: &Value, meter: &mut Meter) -> Result<Self> {
        meter.walk(data, 0)?;
        for row in array(get_s(data, "operators")) {
            if string(get_s(row, "input")).is_none()
                || !matches!(get_s(row, "applies_to"), Some(Value::Array(_)))
            {
                return Err(crate::cause!(Error::Invalid));
            }
            for kind in array(get_s(row, "applies_to")) {
                if string(Some(kind)).is_none() {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            if let Some(Value::Array(params)) = get_s(row, "field_params") {
                for name in params {
                    if string(Some(name)).is_none() {
                        return Err(crate::cause!(Error::Invalid));
                    }
                }
            }
            if truthy(get_s(row, "field_params"))
                && !matches!(get_s(row, "field_params"), Some(Value::Array(_)))
            {
                return Err(crate::cause!(Error::Invalid));
            }
            if let Some(each) = get_s(row, "each").filter(|v| truthy(Some(v))) {
                if string(get_s(each, "param")).is_none()
                    || string(get_s(each, "as")).is_none()
                    || string(get_s(each, "combine")).is_none()
                {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            if let Some(parts) = get_s(row, "parts").filter(|v| truthy(Some(v))) {
                let Value::Array(parts) = parts else {
                    return Err(crate::cause!(Error::Invalid));
                };
                for part in parts {
                    if string(get_s(part, "when")).is_none() || get_s(part, "binding").is_none() {
                        return Err(crate::cause!(Error::Invalid));
                    }
                }
                if string(get_s(row, "combine")).is_none() {
                    return Err(crate::cause!(Error::Invalid));
                }
            }
            if get_s(row, "binding").is_none() && !truthy(get_s(row, "parts")) {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        for row in array(get_s(data, "combinators")) {
            if string(get_s(row, "op")).is_none() {
                return Err(crate::cause!(Error::Invalid));
            }
        }
        let operators = rows_by_id(get_s(data, "operators"), meter)?;
        let combinators = rows_by_id(get_s(data, "combinators"), meter)?;
        let first = array(get_s(data, "combinators"))
            .first()
            .and_then(|row| string(get_s(row, "id")))
            .cloned();
        Ok(Self {
            operators,
            combinators,
            first,
        })
    }
}
fn rows_by_id(rows: Option<&Value>, meter: &mut Meter) -> Result<HashMap<JsString, Value>> {
    let Some(Value::Array(rows)) = rows else {
        return Err(crate::cause!(Error::Invalid));
    };
    let mut map = HashMap::new();
    for row in rows {
        meter.walk(row, 0)?;
        let id = string(get_s(row, "id")).ok_or(crate::cause!(Error::Invalid))?.clone();
        map.insert(id, row.clone());
    }
    Ok(map)
}
fn fields_by_id(fields: &[Value], meter: &mut Meter) -> Result<HashMap<JsString, Value>> {
    let mut map = HashMap::new();
    for field in fields {
        meter.walk(field, 0)?;
        let id = string(get_s(field, "id")).ok_or(crate::cause!(Error::Invalid))?.clone();
        let _kind = string(get_s(field, "kind")).ok_or(crate::cause!(Error::Invalid))?;
        map.insert(id, field.clone());
    }
    Ok(map)
}

struct Compiler<'a, T> {
    vocabulary: Vocabulary,
    fields: HashMap<JsString, Value>,
    text: &'a mut T,
    meter: Meter,
    reads: Vec<JsString>,
    read_set: HashSet<JsString>,
    incomplete: Vec<Value>,
}
impl<T: TextSemantics> Compiler<'_, T> {
    fn params(&mut self, operator: &Value, raw: Option<&Value>) -> Result<Value> {
        if !truthy(raw) {
            return Ok(object());
        }
        let Some(Value::Object(raw)) = raw else {
            return Err(crate::cause!(Error::Unsupported));
        };
        let lower = matches!(string(get_s(operator, "param_case")), Some(value) if value == &JsString::from("lower"));
        let mut params = object();
        for (key, value) in raw.property_entries() {
            self.meter
                .charge(key.len().checked_mul(2).ok_or(crate::cause!(Error::Bounds))?)?;
            let normalized = match value {
                Value::String(value) if lower => {
                    Value::String(self.text.to_locale_lowercase(value)?)
                }
                Value::Array(items) if lower => {
                    let mut normalized = Vec::with_capacity(items.len());
                    for item in items {
                        normalized.push(match item {
                            Value::String(value) => {
                                Value::String(self.text.to_locale_lowercase(value)?)
                            }
                            other => other.clone(),
                        });
                    }
                    Value::Array(normalized)
                }
                other => other.clone(),
            };
            self.meter.walk(&normalized, 0)?;
            put(&mut params, key.clone(), normalized);
        }
        Ok(params)
    }
    fn ready(&mut self, operator: &Value, params: &Value) -> Result<bool> {
        if string(get_s(operator, "input")) == Some(&JsString::from("none")) {
            return Ok(true);
        }
        if truthy(get_s(operator, "each")) {
            let each = get_s(operator, "each").ok_or(crate::cause!(Error::Invalid))?;
            let key = string(get_s(each, "param")).ok_or(crate::cause!(Error::Invalid))?;
            return Ok(matches!(get(params,key),Some(Value::Array(items)) if !items.is_empty()));
        }
        if string(get_s(operator, "input")) == Some(&JsString::from("values")) {
            return Ok(
                matches!(get_s(params,"values"),Some(Value::Array(items)) if !items.is_empty()),
            );
        }
        if truthy(get_s(operator, "parts")) {
            for part in array(get_s(operator, "parts")) {
                let when = string(get_s(part, "when")).ok_or(crate::cause!(Error::Invalid))?;
                if present(get(params, when)) {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
        if string(get_s(operator, "input")) == Some(&JsString::from("text")) {
            return match get_s(params, "text") {
                Some(Value::String(value)) => Ok(!self.text.trim_is_empty(value)?),
                _ => Ok(false),
            };
        }
        Ok(present(get_s(params, "value")))
    }
    fn resolve(
        &mut self,
        rule: &Value,
    ) -> Result<Option<(Value, Value, Value, Vec<(JsString, Value)>)>> {
        let field_id = string(get_s(rule, "field"));
        let operator_id = string(get_s(rule, "operator"));
        let Some(field) = field_id.and_then(|id| self.fields.get(id)).cloned() else {
            return Ok(None);
        };
        let Some(operator) = operator_id
            .and_then(|id| self.vocabulary.operators.get(id))
            .cloned()
        else {
            return Ok(None);
        };
        let applies = array(get_s(&operator, "applies_to"));
        let kind = string(get_s(&field, "kind")).ok_or(crate::cause!(Error::Invalid))?;
        if !applies
            .iter()
            .any(|value| string(Some(value)) == Some(kind))
        {
            return Ok(None);
        }
        let params = self.params(&operator, get_s(rule, "params"))?;
        if !self.ready(&operator, &params)? {
            return Ok(None);
        }
        let mut field_params = Vec::new();
        for name in array(get_s(&operator, "field_params")) {
            let name = string(Some(name)).ok_or(crate::cause!(Error::Invalid))?;
            let Some(other_id) = string(get(&params, name)) else {
                return Ok(None);
            };
            let Some(other) = self.fields.get(other_id) else {
                return Ok(None);
            };
            if string(get_s(other, "kind")) != Some(kind) {
                return Ok(None);
            }
            field_params.push((name.clone(), other.clone()));
        }
        Ok(Some((field, operator, params, field_params)))
    }
    fn target_path(&self, field: &Value) -> Result<Value> {
        let path = get_s(field, "path");
        let chosen = if truthy(path) {
            path.cloned().ok_or(crate::cause!(Error::Invalid))?
        } else {
            let id = get_s(field, "id").ok_or(crate::cause!(Error::Invalid))?.clone();
            Value::Array(vec![id])
        };
        let mut target = object();
        put_s(&mut target, "path", chosen);
        Ok(target)
    }
    fn fill(
        &mut self,
        template: &Value,
        field: &Value,
        params: &Value,
        field_params: &[(JsString, Value)],
        override_param: Option<(&JsString, &Value)>,
        depth: usize,
    ) -> Result<Value> {
        if depth > self.meter.limits.depth {
            return Err(crate::cause!(Error::Bounds));
        }
        let materialized = match template {
            Value::Array(items) => 32usize
                .checked_add(items.len().checked_mul(8).ok_or(crate::cause!(Error::Bounds))?)
                .ok_or(crate::cause!(Error::Bounds))?,
            Value::Object(obj) => obj.insertion_entries().try_fold(64usize, |n, (key, _)| {
                n.checked_add(
                    16usize
                        .checked_add(key.len().checked_mul(2).ok_or(crate::cause!(Error::Bounds))?)
                        .ok_or(crate::cause!(Error::Bounds))?,
                )
                .ok_or(crate::cause!(Error::Bounds))
            })?,
            Value::String(value) => 16usize
                .checked_add(value.len().checked_mul(2).ok_or(crate::cause!(Error::Bounds))?)
                .ok_or(crate::cause!(Error::Bounds))?,
            _ => 16,
        };
        self.meter.charge(materialized)?;
        match template {
            Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.fill(
                        item,
                        field,
                        params,
                        field_params,
                        override_param,
                        depth + 1,
                    )?);
                }
                Ok(Value::Array(out))
            }
            Value::Object(obj) => {
                if let Some(marker) = obj.get(&JsString::from("$field")) {
                    let key = string(Some(marker)).ok_or(crate::cause!(Error::Unsupported))?;
                    return get(field, key).cloned().ok_or(crate::cause!(Error::Unsupported));
                }
                if let Some(marker) = obj.get(&JsString::from("$param")) {
                    let key = string(Some(marker)).ok_or(crate::cause!(Error::Unsupported))?;
                    if let Some((name, value)) = override_param {
                        if name == key {
                            return Ok(value.clone());
                        }
                    }
                    return get(params, key).cloned().ok_or(crate::cause!(Error::Unsupported));
                }
                if let Some(marker) = obj.get(&JsString::from("$field_param")) {
                    let key = string(Some(marker)).ok_or(crate::cause!(Error::Unsupported))?;
                    let other = field_params
                        .iter()
                        .find(|(name, _)| name == key)
                        .map(|(_, value)| value)
                        .ok_or(crate::cause!(Error::Unsupported))?;
                    let path = get_s(other, "path");
                    return Ok(if truthy(path) {
                        path.cloned().ok_or(crate::cause!(Error::Unsupported))?
                    } else {
                        Value::Array(vec![Value::String(
                            string(get_s(other, "id"))
                                .ok_or(crate::cause!(Error::Unsupported))?
                                .clone(),
                        )])
                    });
                }
                let mut out = object();
                for (key, value) in obj.property_entries() {
                    let value = self.fill(
                        value,
                        field,
                        params,
                        field_params,
                        override_param,
                        depth + 1,
                    )?;
                    put(&mut out, key.clone(), value);
                }
                Ok(out)
            }
            other => Ok(other.clone()),
        }
    }
    fn combine(&mut self, op: &Value, members: Vec<Value>) -> Result<Value> {
        let mut result = object();
        put_s(
            &mut result,
            "$kind",
            Value::String(JsString::from("binding")),
        );
        let mut select = object();
        put_s(&mut select, "from", Value::String(JsString::from("self")));
        put_s(&mut result, "select", select);
        let mut args = object();
        put_s(&mut args, "values", Value::Array(members));
        let mut operation = object();
        put_s(&mut operation, "op", op.clone());
        put_s(&mut operation, "args", args);
        put_s(&mut result, "transform", Value::Array(vec![operation]));
        self.meter.walk(&result, 0)?;
        Ok(result)
    }
    fn negate(&mut self, binding: Value) -> Result<Value> {
        let mut out = match binding {
            Value::Object(o) => Value::Object(o),
            _ => return Err(crate::cause!(Error::Unsupported)),
        };
        let mut transforms = match get_s(&out, "transform") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            _ => return Err(crate::cause!(Error::Unsupported)),
        };
        let mut not = object();
        put_s(&mut not, "op", Value::String(JsString::from("op:core.not")));
        transforms.push(not);
        put_s(&mut out, "transform", Value::Array(transforms));
        self.meter.walk(&out, 0)?;
        Ok(out)
    }
    fn compile_rule(&mut self, node: &Value) -> Result<Option<Value>> {
        let Some((field, operator, params, field_params)) = self.resolve(node)? else {
            self.incomplete.push(node.clone());
            return Ok(None);
        };
        let target = self.target_path(&field)?;
        let binding = if truthy(get_s(&operator, "each")) {
            let each = get_s(&operator, "each").ok_or(crate::cause!(Error::Invalid))?;
            let list_name = string(get_s(each, "param")).ok_or(crate::cause!(Error::Invalid))?;
            let alias = string(get_s(each, "as")).ok_or(crate::cause!(Error::Invalid))?.clone();
            let Some(Value::Array(values)) = get(&params, list_name) else {
                return Err(crate::cause!(Error::Unsupported));
            };
            let template = get_s(&operator, "binding").ok_or(crate::cause!(Error::Invalid))?;
            let mut copies = Vec::with_capacity(values.len());
            for value in values {
                copies.push(self.fill(
                    template,
                    &target,
                    &params,
                    &field_params,
                    Some((&alias, value)),
                    0,
                )?);
            }
            if copies.len() == 1 {
                copies.into_iter().next().ok_or(crate::cause!(Error::Invalid))?
            } else {
                let combine = get_s(each, "combine").ok_or(crate::cause!(Error::Unsupported))?;
                self.combine(combine, copies)?
            }
        } else if truthy(get_s(&operator, "parts")) {
            let mut copies = Vec::new();
            for part in array(get_s(&operator, "parts")) {
                let when = string(get_s(part, "when")).ok_or(crate::cause!(Error::Invalid))?;
                if present(get(&params, when)) {
                    let template = get_s(part, "binding").ok_or(crate::cause!(Error::Invalid))?;
                    copies.push(self.fill(template, &target, &params, &field_params, None, 0)?);
                }
            }
            if copies.len() == 1 {
                copies.into_iter().next().ok_or(crate::cause!(Error::Invalid))?
            } else {
                let combine = get_s(&operator, "combine").ok_or(crate::cause!(Error::Unsupported))?;
                self.combine(combine, copies)?
            }
        } else {
            self.fill(
                get_s(&operator, "binding").ok_or(crate::cause!(Error::Invalid))?,
                &target,
                &params,
                &field_params,
                None,
                0,
            )?
        };
        for read in std::iter::once(string(get_s(&field, "id")).ok_or(crate::cause!(Error::Invalid))?.clone())
            .chain(
                field_params
                    .iter()
                    .map(|(_, other)| string(get_s(other, "id")).cloned().ok_or(crate::cause!(Error::Invalid)))
                    .collect::<Result<Vec<_>>>()?,
            )
        {
            if self.read_set.insert(read.clone()) {
                self.meter.charge(
                    16usize
                        .checked_add(read.len().checked_mul(2).ok_or(crate::cause!(Error::Bounds))?)
                        .ok_or(crate::cause!(Error::Bounds))?,
                )?;
                self.reads.push(read);
            }
        }
        if truthy(get_s(&operator, "negate")) {
            self.negate(binding).map(Some)
        } else {
            Ok(Some(binding))
        }
    }
    fn visit(&mut self, node: &Value, depth: usize) -> Result<Option<Value>> {
        if depth > self.meter.limits.depth {
            return Err(crate::cause!(Error::Bounds));
        }
        self.meter.charge(1)?;
        if string(get_s(node, "kind")) == Some(&JsString::from("group")) {
            let rules = get_s(node, "rules");
            let items = if !truthy(rules) {
                &[]
            } else if let Some(Value::Array(items)) = rules {
                items.as_slice()
            } else {
                return Err(crate::cause!(Error::Invalid));
            };
            let mut members = Vec::new();
            for child in items {
                if let Some(compiled) = self.visit(child, depth + 1)? {
                    members.push(compiled);
                }
            }
            if members.is_empty() {
                return Ok(None);
            }
            let negate = truthy(get_s(node, "negate"));
            let joined = if members.len() == 1 && !negate {
                members.pop().ok_or(crate::cause!(Error::Invalid))?
            } else {
                let combinator_id = string(get_s(node, "combinator"));
                let combinator = combinator_id
                    .and_then(|id| self.vocabulary.combinators.get(id))
                    .or_else(|| {
                        self.vocabulary
                            .first
                            .as_ref()
                            .and_then(|id| self.vocabulary.combinators.get(id))
                    })
                    .ok_or(crate::cause!(Error::Invalid))?;
                let op = get_s(combinator, "op").ok_or(crate::cause!(Error::Invalid))?.clone();
                self.combine(&op, members)?
            };
            if negate {
                self.negate(joined).map(Some)
            } else {
                Ok(Some(joined))
            }
        } else {
            self.compile_rule(node)
        }
    }
}

/// Source-compatible compileRules(tree, {fields, vocabulary}). `None` and
/// JSON null both mean no tree. Fields and every operator declaration carry
/// their own `kind`, path, template and operator metadata.
pub fn compile_rules(
    tree: Option<&Value>,
    fields: &[Value],
    operator_data: &Value,
    text: &mut impl TextSemantics,
    limits: Limits,
) -> Result<CompiledRules> {
    let mut meter = Meter::new(limits)?;
    meter.walk(operator_data, 0)?;
    for field in fields {
        meter.walk(field, 0)?;
    }
    if let Some(tree) = tree {
        meter.walk(tree, 0)?;
    }
    let vocabulary = Vocabulary::new(operator_data, &mut meter)?;
    let fields = fields_by_id(fields, &mut meter)?;
    let mut compiler = Compiler {
        vocabulary,
        fields,
        text,
        meter,
        reads: Vec::new(),
        read_set: HashSet::new(),
        incomplete: Vec::new(),
    };
    let binding = match tree {
        None | Some(Value::Null) => None,
        Some(tree) => compiler.visit(tree, 0)?,
    };
    if let Some(binding) = &binding {
        compiler.meter.walk(binding, 0)?;
    }
    for rule in &compiler.incomplete {
        compiler.meter.walk(rule, 0)?;
    }
    Ok(CompiledRules {
        binding,
        reads: compiler.reads,
        incomplete: compiler.incomplete,
        work: compiler.meter.work,
    })
}

/// Source rule-decisions.mjs strongest decisive DATA effects. Changes are
/// separate; callers decide the meaning of visibility or access themselves.
pub fn strongest_effect_indexes(effects: &[Value]) -> Result<Vec<usize>> {
    if effects.len() > 100_000 {
        return Err(crate::cause!(Error::Bounds));
    }
    let mut high = f64::NEG_INFINITY;
    let mut selected = Vec::new();
    for (index, effect) in effects.iter().enumerate() {
        let Value::Object(row) = effect else {
            return Err(crate::cause!(Error::Invalid));
        };
        if matches!(row.get(&JsString::from("changes")), Some(Value::Bool(true))) {
            continue;
        }
        let strength = match row.get(&JsString::from("strength")) {
            Some(Value::Number(value)) if value.is_finite() => *value,
            Some(Value::Null) | None => 0.0,
            _ => return Err(crate::cause!(Error::Invalid)),
        };
        if strength > high {
            high = strength;
            selected.clear();
        }
        if strength == high {
            selected.push(index);
        }
    }
    Ok(selected)
}
