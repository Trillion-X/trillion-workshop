//! Ignore rules, read from the person's rule rows and decided by the formula engine. (Pins are the contract's own
//! pin rule rows: the contract answers `kept` for this device, and core.rs writes them.)
//!
//! A row is `{id, on?, devices?, when}`: `devices` lists the device ids it applies to (absent or null: every device),
//! `when` is a rule tree over an item's facts (contract.json `item_facts`), the same shape as the storage release
//! rules, or null for every item. The tree is compiled once per row by the formula engine's compiler and each item
//! is decided by its evaluator; nothing here compares a value.
//!
//! Invariants
//!   - A row with an unfinished or empty condition is refused, never read as "every item": an ignore rule that
//!     broadened would hide the whole account.
//!   - The core decides offline: no rule needs a computer to answer.

use formula_engine_compile_rules::{compile_rules, Field, Vocabulary};
use formula_engine_evaluate_over_rows::{evaluate_request, EvaluateRequest};
use serde::Serialize;
use serde_json::Value;

use crate::data::Contract;

struct Rule {
    devices: Option<Vec<String>>,
    /// None: every item.
    binding: Option<Value>,
}

/// One refused row and why.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Refused {
    pub id: String,
    pub why: String,
}

#[derive(Default)]
pub struct RuleSet {
    rules: Vec<Rule>,
}

impl RuleSet {
    /// The rows that are on, compiled; the refused ones are answered beside.
    pub fn from_rows(contract: &Contract, rows: &[Value]) -> (RuleSet, Vec<Refused>) {
        let fields: Vec<Field> = contract
            .item_facts
            .iter()
            .map(|fact| Field { id: fact.id.clone(), kind: fact.kind.clone(), path: None })
            .collect();
        let mut rules = Vec::new();
        let mut refused = Vec::new();
        for row in rows {
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            if row.get("on").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let devices = match row.get("devices") {
                None | Some(Value::Null) => None,
                Some(Value::Array(list)) => Some(list.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
                Some(_) => {
                    refused.push(Refused { id, why: "devices is a list of device ids, or null for every device".into() });
                    continue;
                }
            };
            let binding = match row.get("when") {
                None => {
                    refused.push(Refused { id, why: "when is a rule tree, or null for every item".into() });
                    continue;
                }
                Some(Value::Null) => None,
                Some(tree) => {
                    let compiled = compile_rules(Some(tree), &fields, Vocabulary::shipped());
                    if !compiled.incomplete.is_empty() {
                        refused.push(Refused { id, why: format!("the condition {} is not finished", compiled.incomplete[0]) });
                        continue;
                    }
                    let Some(binding) = compiled.binding else {
                        refused.push(Refused { id, why: "the condition names no comparison; use when: null for every item".into() });
                        continue;
                    };
                    Some(binding)
                }
            };
            rules.push(Rule { devices, binding });
        }
        (RuleSet { rules }, refused)
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Whether any rule for this device holds for an item's facts.
    pub fn holds(&self, device: &str, facts: &Value) -> bool {
        self.rules.iter().any(|rule| {
            rule.devices.as_ref().is_none_or(|devices| devices.iter().any(|named| named == device))
                && match &rule.binding {
                    None => true,
                    Some(binding) => {
                        evaluate_request(EvaluateRequest { binding: binding.clone(), input: facts.clone() }) == Ok(Value::Bool(true))
                    }
                }
        })
    }
}
