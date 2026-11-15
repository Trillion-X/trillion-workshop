//! Trigger Engine — subscribed trigger state + data-driven dispatch.
//!
//! The trigger-engine slot receives the generic delta firehose through the
//! existing subscribed-slot mechanism. It owns live trigger rule state,
//! bootstraps its rule state from package-owned rule records, matches
//! mutations against rule-owned predicates, and dispatches rule-owned output
//! templates to rule-owned target addresses.
//!
//! This crate does NOT know about compile, TSX, source paths, or any Society
//! trigger rows. It only knows:
//! - how to maintain live trigger definitions from opaque rule records
//! - how to derive a generic change/envelope context from a delta mutation
//! - how to optionally call a data-provided evaluator address
//! - how to render and dispatch a data-provided output template

pub mod slot_work;
pub mod talk_to_other_slots;

pub use slot_work::{RuleDispatch, RuleEvaluator, TalkToOtherSlots, TriggerHandler, TriggerRule};
