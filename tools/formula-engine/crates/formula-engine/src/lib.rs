//! crates/formula-engine/src/lib.rs
//!
//! Purpose
//!   The formula engine as one library every host calls directly: a person's rule tree is compiled here into one
//!   composition-ast binding (src/rules.rs, the comparisons being DATA), held to the limits of
//!   rules/evaluation-guards.json (src/guards.rs) and evaluated over rows by the composition-ast evaluator, every
//!   comparison, boolean combinator and text operation being an ops-core operator reached through
//!   `create_core_registry`. The requests a person's AI or a tool sends are src/requests.rs; the classifier is
//!   src/classify.rs. Two hosts carry them: src/host.rs (wasm-bindgen, for pages and Node tools) and src/main.rs (a
//!   WASI command: the one component the engine runs for the formula tool rows on any computer).
//!
//! Non-negotiable invariants
//!   - No operator, comparison or field name appears here. A binding the evaluator accepts is accepted with the same
//!     meaning on every host.
//!   - A row matches only when the binding yields JSON `true`. Null, a missing field, an operator error or any other
//!     value is "does not match"; an operator error is counted in error_rows.
//!   - A binding is parsed and prepared once per compiled rule, never once per row; a compiled rule is kept (at most
//!     COMPILED_KEPT, oldest first) so callers that read their rules afresh for every decision do not compile again.
//!   - The comparison rows and the limits are the two JSON files beside the tool (rules/), read into the build; a
//!     request may bring its own comparison rows.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::{Arc, OnceLock};

use composition_ast::binding::ast::{Binding, BindingEvaluationContext, Diagnostic, DiagnosticLevel};
use composition_ast::binding::operators::create_core_registry;
use composition_ast::binding::operators::registry::OperatorResolver;
use composition_ast::binding::prepared::PreparedBinding;
use ops_core::OpValue;
use serde_json::Value;

pub mod classify;
pub mod grammar;
pub mod guards;
pub mod requests;
pub mod rules;
pub mod text;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
mod host;

/// The comparison rows a request that brings none uses.
pub const OPERATORS: &str = include_str!("../../../rules/rule-operators.json");
/// The limits every evaluation is held to.
pub const GUARDS: &str = include_str!("../../../rules/evaluation-guards.json");
/// The most compiled rules kept at once.
const COMPILED_KEPT: usize = 512;

// Evaluating a binding never draws entropy; see Cargo.toml.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
fn entropy_is_not_offered(_buffer: &mut [u8]) -> Result<(), getrandom_02::Error> {
    Err(getrandom_02::Error::UNSUPPORTED)
}
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
getrandom_02::register_custom_getrandom!(entropy_is_not_offered);

fn operator_resolver() -> &'static OperatorResolver {
    static RESOLVER: OnceLock<OperatorResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| {
        let registry = Arc::new(create_core_registry().expect("core operator registry"));
        Arc::new(move |key: &str| registry.get(key))
    })
}

/// The limits of rules/evaluation-guards.json.
pub fn limits() -> &'static guards::Limits {
    static LIMITS: OnceLock<guards::Limits> = OnceLock::new();
    LIMITS.get_or_init(|| serde_json::from_str(GUARDS).expect("rules/evaluation-guards.json"))
}

/// Why a call did not answer: a sentence saying what to send, or a guard's refusal.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    Sentence(String),
    Guard(guards::Refusal),
}

impl Refused {
    pub fn message(&self) -> &str {
        match self {
            Refused::Sentence(text) => text,
            Refused::Guard(refusal) => &refusal.message,
        }
    }
}

impl From<guards::Refusal> for Refused {
    fn from(refusal: guards::Refusal) -> Self {
        Refused::Guard(refusal)
    }
}

pub(crate) fn sentence(text: impl Into<String>) -> Refused {
    Refused::Sentence(text.into())
}

/// A binding ready to run: its text (what the slow-formula pause is kept under), weight and prepared form, and whether
/// it reads the row as `from: "context"` (a compiled text formula does), so each row is handed over that way too.
pub struct Ready {
    text: String,
    weight: u64,
    prepared: PreparedBinding,
    reads_context: bool,
}

/// Check and prepare a binding once.
pub fn ready(binding: &Value) -> Result<Ready, Refused> {
    let weight = limits().check_binding(binding)?;
    let parsed: Binding =
        serde_json::from_value(binding.clone()).map_err(|error| sentence(format!("The rule could not be read: {error}")))?;
    let text = binding.to_string();
    let reads_context = text.contains(r#""from":"context""#);
    Ok(Ready { text, weight, prepared: PreparedBinding::prepare(&parsed, operator_resolver()), reads_context })
}

/// The positions of the rows a binding holds for, how many rows an operator refused and the first such refusal.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub matches: Vec<u32>,
    pub error_rows: u32,
    pub first_error: Option<String>,
}

fn first_error(diagnostics: Vec<Diagnostic>) -> Option<String> {
    diagnostics.into_iter().find(|diagnostic| matches!(diagnostic.level, DiagnosticLevel::Error)).map(|diagnostic| {
        match diagnostic.data.as_ref().and_then(|data| data.get("error")) {
            Some(detail) => format!("{}: {}", diagnostic.message, detail),
            None => diagnostic.message,
        }
    })
}

/// Run `ready` over `rows`, a slice of rows_per_slice at a time, stopping between slices once past the clock budget.
pub fn filter_with(ready: &Ready, rows: &[OpValue], clock: &dyn Fn() -> f64) -> Result<Outcome, Refused> {
    let limits = limits();
    limits.check_work(ready.weight, rows.len())?;
    let budget = guards::Budget::start(limits, ready.text.clone(), clock)?;
    let context = BindingEvaluationContext::default();
    let mut outcome = Outcome::default();
    for (slice, chunk) in rows.chunks(limits.rows_per_slice.max(1)).enumerate() {
        if slice > 0 {
            budget.between_slices()?;
        }
        let from = slice * limits.rows_per_slice.max(1);
        for (offset, row) in chunk.iter().enumerate() {
            let result = if ready.reads_context {
                ready.prepared.evaluate(row, &context.clone().with_context(row.as_inner()), operator_resolver())
            } else {
                ready.prepared.evaluate(row, &context, operator_resolver())
            };
            if let Some(message) = first_error(result.diagnostics) {
                outcome.error_rows += 1;
                outcome.first_error.get_or_insert(message);
                continue;
            }
            if matches!(result.value.node(), ops_core::value::OpNode::Bool(true)) {
                outcome.matches.push((from + offset) as u32);
            }
        }
    }
    budget.note();
    Ok(outcome)
}

/// One binding over one input: the input is `self` for the binding's own selection and, as `from: "context"`, the
/// input for every nested argument binding.
pub fn evaluate_with(ready: &Ready, input: Value, clock: &dyn Fn() -> f64) -> Result<Value, Refused> {
    let limits = limits();
    limits.check_work(ready.weight, 1)?;
    let budget = guards::Budget::start(limits, ready.text.clone(), clock)?;
    let context = BindingEvaluationContext::default().with_context(input.clone());
    let result = ready.prepared.evaluate(&OpValue::from(input), &context, operator_resolver());
    budget.note();
    match first_error(result.diagnostics) {
        Some(message) => Err(sentence(message)),
        None => Ok(result.value.into_inner()),
    }
}

/// The default comparison rows, looked up once.
pub fn default_vocabulary() -> &'static rules::Vocabulary {
    static VOCABULARY: OnceLock<rules::Vocabulary> = OnceLock::new();
    VOCABULARY.get_or_init(|| rules::Vocabulary::new(serde_json::from_str(OPERATORS).expect("rules/rule-operators.json")))
}

/// A compiled rule tree, kept: its binding made ready, the fields it reads and the rules left out.
pub struct Kept {
    pub ready: Option<Ready>,
    pub binding: Option<Value>,
    pub reads: Vec<String>,
    pub incomplete: Vec<Value>,
}

thread_local! {
    static COMPILED: RefCell<VecDeque<(String, Rc<Kept>)>> = const { RefCell::new(VecDeque::new()) };
}

/// Compile `tree` over `fields` with `vocabulary` (the default rows when `own` is None), kept by its text.
pub fn compiled(tree: Option<&Value>, fields: &[Value], own: Option<&rules::Vocabulary>) -> Result<Rc<Kept>, Refused> {
    let key = serde_json::to_string(&(tree, fields, own.map(|vocabulary| &vocabulary.data))).unwrap_or_default();
    if let Some(kept) = COMPILED.with(|kept| kept.borrow().iter().find(|(held, _)| held == &key).map(|(_, kept)| kept.clone())) {
        return Ok(kept);
    }
    let vocabulary: &rules::Vocabulary = match own { Some(own) => own, None => default_vocabulary() };
    let rules::Compiled { binding, reads, incomplete } = rules::compile(tree, fields, vocabulary).map_err(sentence)?;
    let ready = binding.as_ref().map(ready).transpose()?;
    let kept = Rc::new(Kept { ready, binding, reads, incomplete });
    COMPILED.with(|held| {
        let mut held = held.borrow_mut();
        held.push_back((key, kept.clone()));
        while held.len() > COMPILED_KEPT {
            held.pop_front();
        }
    });
    Ok(kept)
}

/// The rows a host has loaded, in the host's own order (a page's measure engine keeps them loaded and patches single
/// rows). The host keeps the index-to-identity map; this table never learns what a row is.
#[derive(Default)]
pub struct RowTable {
    pub rows: Vec<OpValue>,
}

impl RowTable {
    pub fn replace(&mut self, rows: Vec<Value>) {
        self.rows = rows.into_iter().map(OpValue::from).collect();
    }

    /// Resize to `length` and replace the rows `set` names (`[{index, row}]`).
    pub fn patch(&mut self, length: usize, set: Vec<(usize, Value)>) -> Result<(), Refused> {
        self.rows.resize(length, OpValue::null());
        for (index, row) in set {
            let slot = self
                .rows
                .get_mut(index)
                .ok_or_else(|| sentence(format!("Row {index} is outside a table of {length} rows.")))?;
            *slot = OpValue::from(row);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(path: &str, op: &str, value: Value) -> Value {
        json!({"$kind":"binding","select":{"from":"self","path":path},"transform":[{"op":op,"args":{"value":value}}]})
    }

    fn group(op: &str, members: Vec<Value>, negate: bool) -> Value {
        let mut transform = vec![json!({"op":op,"args":{"values":members}})];
        if negate {
            transform.push(json!({"op":"op:core.not"}));
        }
        json!({"$kind":"binding","select":{"from":"self"},"transform":transform})
    }

    fn rows() -> Vec<OpValue> {
        [
            json!({"duration": 95.0, "words": "then the forehand swing", "labels": ["drill"], "kind": "original"}),
            json!({"duration": 30.0, "words": "backhand only", "labels": ["junk"], "kind": "export"}),
            json!({"duration": 240.0, "words": "Forehand and serve", "labels": ["junk", "drill"], "kind": "original"}),
            json!({"duration": null, "words": "", "labels": [], "kind": "project"}),
        ]
        .into_iter()
        .map(OpValue::from)
        .collect()
    }

    fn matches(binding: Value) -> Vec<u32> {
        filter_with(&ready(&binding).expect("ready"), &rows(), &guards::now_ms).expect("filter").matches
    }

    fn evaluated(binding: Value, input: Value) -> Value {
        evaluate_with(&ready(&binding).expect("ready"), input, &guards::now_ms).expect("evaluate")
    }

    #[test]
    fn and_or_not_compose_through_nested_bindings() {
        let long = rule("duration", "op:core.gt", json!(60));
        let short = rule("duration", "op:core.lt", json!(40));
        assert_eq!(matches(group("op:core.and", vec![long.clone()], false)), vec![0, 2]);
        assert_eq!(matches(group("op:core.or", vec![long.clone(), short.clone()], false)), vec![0, 1, 2]);
        // Tristate: a row whose duration is unknown is neither long nor short, and NOT of unknown stays unknown.
        assert_eq!(matches(group("op:core.or", vec![long.clone(), short.clone()], true)), Vec::<u32>::new());
        assert_eq!(matches(group("op:core.and", vec![long], true)), vec![1]);
    }

    #[test]
    fn range_is_two_comparisons_and_null_never_matches() {
        let between =
            group("op:core.and", vec![rule("duration", "op:core.ge", json!(30)), rule("duration", "op:core.le", json!(120))], false);
        assert_eq!(matches(between), vec![0, 1]);
    }

    #[test]
    fn multi_select_and_multi_valued_fields() {
        let any = json!({"$kind":"binding","select":{"from":"self","path":"kind"},"transform":[{"op":"op:core.in_list","args":{"values":["export","project"]}}]});
        assert_eq!(matches(any), vec![1, 3]);
        let has_junk = json!({"$kind":"binding","select":{"from":"self","path":"labels"},"transform":[{"op":"op:core.index_of","args":{"value":"junk"}},{"op":"op:core.ge","args":{"value":0}}]});
        assert_eq!(matches(has_junk.clone()), vec![1, 2]);
        assert_eq!(matches(group("op:core.and", vec![has_junk], true)), vec![0, 3]);
    }

    #[test]
    fn transcript_contains_ignores_case_through_lower() {
        let contains = json!({"$kind":"binding","select":{"from":"self","path":"words"},"transform":[{"op":"op:core.lower"},{"op":"op:core.contains","args":{"value":"forehand"}}]});
        assert_eq!(matches(contains), vec![0, 2]);
    }

    #[test]
    fn patch_replaces_one_row_and_resizes() {
        let mut table = RowTable { rows: rows() };
        table.patch(5, vec![(4, json!({"duration": 400}))]).expect("patch");
        let found = filter_with(&ready(&rule("duration", "op:core.gt", json!(300))).unwrap(), &table.rows, &guards::now_ms).unwrap();
        assert_eq!(found.matches, vec![4]);
        assert!(table.patch(2, vec![(3, json!({}))]).is_err());
    }

    #[test]
    fn a_field_divides_by_another_field_of_the_input() {
        let ratio = json!({"$kind":"binding","select":{"from":"self","path":["views"]},"transform":[
            {"op":"op:core.div","args":{"value":{"$kind":"binding","select":{"from":"context","path":["channel_median"]}}}}]});
        assert_eq!(evaluated(ratio.clone(), json!({"views": 300.0, "channel_median": 100.0})), json!(3));
        assert_eq!(evaluated(ratio, json!({"views": 50.0, "channel_median": 200.0})), json!(0.25));
    }

    #[test]
    fn a_nested_argument_reaches_the_input_while_self_stays_the_pipeline_value() {
        let both = json!({"$kind":"binding","select":{"from":"self","path":["views"]},"transform":[
            {"op":"op:core.mul","args":{"value":{"$kind":"binding","select":{"from":"self"}}}},
            {"op":"op:core.add","args":{"value":{"$kind":"binding","select":{"from":"context","path":["bonus"]}}}}]});
        assert_eq!(evaluated(both, json!({"views": 4.0, "bonus": 1.0})), json!(17));
    }

    #[test]
    fn the_largest_of_a_list_of_selections_is_one_formula() {
        let difference = |least: &str, live: &str| json!({"$kind":"binding","select":{"from":"self","path":[least]},
            "transform":[{"op":"op:core.sub","args":{"value":{"$kind":"binding","select":{"from":"context","path":[live]}}}}]});
        let largest = json!({"$kind":"binding","select":{"from":"literal","value":[0,
            difference("least_voters", "voters"), difference("least_copy_keepers", "copy_keepers")]},
            "transform":[{"op":"op:core.max"}]});
        let input = |voters: f64, keepers: f64| json!({"least_voters": 3.0, "voters": voters, "least_copy_keepers": 2.0, "copy_keepers": keepers});
        let mut listed = largest.clone();
        listed.as_object_mut().unwrap().remove("transform");
        assert_eq!(evaluated(listed, input(1.0, 2.0)), json!([0, 2, 0]), "each selection is evaluated");
        assert_eq!(evaluated(largest.clone(), input(1.0, 2.0)), json!(2));
        assert_eq!(evaluated(largest.clone(), input(3.0, 1.0)), json!(1));
        assert_eq!(evaluated(largest, input(5.0, 5.0)), json!(0), "never below the plain 0");
    }

    #[test]
    fn unreadable_binding_is_an_error_not_an_empty_answer() {
        assert!(ready(&json!({"select": 3})).is_err());
    }
}
