//! The engine's one door: every contract operation is one JSON-RPC message to it (contract.json `call`), and every
//! answer is read from the door's body alone (contract.json `answer`), never from a transport status.
//!
//! Invariants
//!   - The message is contract.json's `call.body` with each slot filled; nothing of its shape is in code.
//!   - An answer is the operation's result, or a refusal mapped through `refusals` (by code, and outcome when a row
//!     names one) or `protocol_refusals` (a JSON-RPC error's code). Anything else, and a refusal no row names, is
//!     `unreachable`: the next computer is asked.

use serde_json::Value;

use crate::data::Contract;
use crate::errors::Problem;

/// The door's message for one operation: `request` the core's number for it, `key` its request key.
pub fn message(contract: &Contract, request: u64, key: &str, op: &str, input: Value) -> Vec<u8> {
    let slots = &contract.call.slots;
    let mut body = contract.call.body.clone();
    fill(&mut body, &mut |slot| {
        if slot == slots.request {
            Some(Value::from(request))
        } else if slot == slots.request_key {
            Some(Value::from(key))
        } else if slot == slots.op {
            Some(Value::from(op))
        } else if slot == slots.input {
            Some(input.clone())
        } else {
            None
        }
    });
    body.to_string().into_bytes()
}

fn fill(value: &mut Value, slot: &mut impl FnMut(&str) -> Option<Value>) {
    match value {
        Value::String(text) => {
            if let Some(filled) = slot(text) {
                *value = filled;
            }
        }
        Value::Array(values) => values.iter_mut().for_each(|value| fill(value, slot)),
        Value::Object(fields) => fields.values_mut().for_each(|value| fill(value, slot)),
        _ => {}
    }
}

/// One answer of the door: the operation's result, or the problem it was refused with.
pub fn answer(contract: &Contract, body: &[u8]) -> Result<Value, Problem> {
    let Ok(mut message) = serde_json::from_slice::<Value>(body) else { return Err(Problem::Unreachable) };
    let at = &contract.answer;
    if let Some(code) = message.pointer(&at.protocol_refusal).and_then(Value::as_i64) {
        let row = contract.protocol_refusals.iter().find(|row| row.code == code);
        return Err(row.map_or(Problem::Unreachable, |row| row.problem));
    }
    let refused = message.pointer(&at.refused).and_then(Value::as_bool);
    let Some(result) = message.pointer_mut(&at.result).map(Value::take) else { return Err(Problem::Unreachable) };
    if refused != Some(true) {
        return Ok(result);
    }
    let text = |job: &str| result.get(contract.field(job)).and_then(Value::as_str);
    let (code, outcome) = (text("failure_code"), text("failure_outcome"));
    let row = contract
        .refusals
        .iter()
        .find(|row| Some(row.code.as_str()) == code && row.outcome.as_deref().is_none_or(|named| Some(named) == outcome));
    Err(row.map_or(Problem::Unreachable, |row| row.problem))
}
