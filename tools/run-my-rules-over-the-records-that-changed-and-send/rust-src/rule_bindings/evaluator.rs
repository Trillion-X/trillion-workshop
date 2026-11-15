//! Bounded adapter from the ECMAScript JSON value model to the existing formula
//! binding evaluator. Operator behavior and registry ownership stay there.
use crate::{
    ecma_json::{JsString, Object, Value},
    rule_bindings::{BindingEvaluator, Error, Result},
};
pub(crate) use formula_engine_evaluate_over_rows::{evaluate_request, EvaluateRequest};
use serde_json::{Map, Number, Value as Json};

const MAX_NODES: usize = 100_000;
const MAX_DEPTH: usize = 128;
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Uses the row evaluator crate's (crates/evaluate-over-rows) canonical registry and evaluator.
#[derive(Default)]
pub struct FormulaBindingEvaluator;
impl BindingEvaluator for FormulaBindingEvaluator {
    fn evaluate(&mut self, binding: &Value, input: &Value) -> Result<Value> {
        let mut meter = Meter::default();
        let binding = to_json(binding, 0, &mut meter)?;
        let input = to_json(input, 0, &mut meter)?;
        let result =
            evaluate_request(EvaluateRequest { binding, input }).map_err(|error| crate::carry_cause!(Error::Evaluator, error))?;
        let mut output_meter = Meter::default();
        from_json(&result, 0, &mut output_meter)
    }
}

#[derive(Default)]
struct Meter {
    nodes: usize,
    bytes: usize,
}
impl Meter {
    fn charge(&mut self, bytes: usize, depth: usize) -> Result<()> {
        self.nodes = self.nodes.checked_add(1).ok_or(crate::cause!(Error::Bounds))?;
        self.bytes = self.bytes.checked_add(bytes).ok_or(crate::cause!(Error::Bounds))?;
        if depth > MAX_DEPTH || self.nodes > MAX_NODES || self.bytes > MAX_BYTES {
            return Err(crate::cause!(Error::Bounds));
        }
        Ok(())
    }
}
fn text(s: &JsString, m: &mut Meter) -> Result<String> {
    let remaining = MAX_BYTES.checked_sub(m.bytes).ok_or(crate::cause!(Error::Bounds))?;
    if m.nodes >= MAX_NODES || remaining < 8 || s.len() > remaining - 8 {
        return Err(crate::cause!(Error::Bounds));
    }
    let mut bytes = 0usize;
    for scalar in char::decode_utf16(s.units().iter().copied()) {
        bytes = bytes
            .checked_add(scalar.map_err(|error| crate::carry_cause!(Error::Unsupported, error))?.len_utf8())
            .ok_or(crate::cause!(Error::Bounds))?;
        if bytes > remaining - 8 {
            return Err(crate::cause!(Error::Bounds));
        }
    }
    m.charge(bytes.checked_add(8).ok_or(crate::cause!(Error::Bounds))?, 0)?;
    let text = s.to_rust_string().map_err(|error| crate::carry_cause!(Error::Unsupported, error))?;
    Ok(text)
}
fn to_json(v: &Value, depth: usize, m: &mut Meter) -> Result<Json> {
    match v {
        Value::Null => {
            m.charge(8, depth)?;
            Ok(Json::Null)
        }
        Value::Bool(b) => {
            m.charge(8, depth)?;
            Ok(Json::Bool(*b))
        }
        Value::Number(n) => {
            m.charge(16, depth)?;
            Number::from_f64(*n)
                .map(Json::Number)
                .ok_or(crate::cause!(Error::Unsupported))
        }
        Value::String(s) => {
            m.charge(8, depth)?;
            Ok(Json::String(text(s, m)?))
        }
        Value::Array(items) => {
            m.charge(items.len().checked_mul(8).ok_or(crate::cause!(Error::Bounds))?, depth)?;
            items
                .iter()
                .map(|x| to_json(x, depth + 1, m))
                .collect::<Result<Vec<_>>>()
                .map(Json::Array)
        }
        Value::Object(obj) => {
            m.charge(obj.len().checked_mul(24).ok_or(crate::cause!(Error::Bounds))?, depth)?;
            let mut out = Map::new();
            // Walk in ECMAScript own-property order before crossing to the
            // evaluator's JSON map (whose key order is not evaluator input).
            for (k, x) in obj.property_entries() {
                let k = text(k, m)?;
                out.insert(k, to_json(x, depth + 1, m)?);
            }
            Ok(Json::Object(out))
        }
    }
}
fn from_json(v: &Json, depth: usize, m: &mut Meter) -> Result<Value> {
    match v {
        Json::Null => {
            m.charge(8, depth)?;
            Ok(Value::Null)
        }
        Json::Bool(b) => {
            m.charge(8, depth)?;
            Ok(Value::Bool(*b))
        }
        Json::Number(n) => {
            m.charge(16, depth)?;
            n.as_f64()
                .filter(|x| x.is_finite())
                .map(Value::Number)
                .ok_or(crate::cause!(Error::Unsupported))
        }
        Json::String(s) => {
            m.charge(s.len().checked_add(8).ok_or(crate::cause!(Error::Bounds))?, depth)?;
            Ok(Value::String(s.as_str().into()))
        }
        Json::Array(items) => {
            m.charge(items.len().checked_mul(8).ok_or(crate::cause!(Error::Bounds))?, depth)?;
            items
                .iter()
                .map(|x| from_json(x, depth + 1, m))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array)
        }
        Json::Object(obj) => {
            m.charge(obj.len().checked_mul(24).ok_or(crate::cause!(Error::Bounds))?, depth)?;
            let mut out = Object::new();
            for (k, x) in obj {
                m.charge(k.len().checked_add(8).ok_or(crate::cause!(Error::Bounds))?, depth)?;
                out.insert(k.as_str().into(), from_json(x, depth + 1, m)?);
            }
            Ok(Value::Object(out))
        }
    }
}
