use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TriggerRule {
    #[serde(default)]
    pub id: Option<String>,
    pub match_condition: Value,
    #[serde(default)]
    pub evaluator: Option<RuleEvaluator>,
    pub dispatch: RuleDispatch,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub trigger_type: Option<String>,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

impl TriggerRule {
    pub fn is_delta_driven(&self) -> bool {
        self.trigger_type.as_deref() != Some("interval")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RuleEvaluator {
    pub address: String,
    pub request_template: Value,
    #[serde(default)]
    pub matched_path: Option<String>,
    #[serde(default)]
    pub bindings_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RuleDispatch {
    pub target: String,
    pub output_template: Value,
    /// Generic inter-slot reply-delivery policy selected by rule DATA.
    /// Inline is the compatibility default; later-with-durable-outcome moves
    /// arbitrary target completion off this slot's subscriber/query hot path.
    #[serde(default)]
    pub delivery: RuleDispatchDelivery,
    /// Optional owner-provided correlation material for the generic durable
    /// dispatch outcome. The trigger engine never interprets it; producers use
    /// it to reconcile their own durable request records.
    #[serde(default)]
    pub outcome_correlation_template: Option<Value>,
    /// Maximum target-dispatch attempts for one matched mutation. This is
    /// bounded by `u8` in the record schema; zero is normalized to one. The
    /// retry policy is entirely rule DATA and applies to arbitrary targets.
    #[serde(default)]
    pub max_attempts: Option<u8>,
}

impl RuleDispatch {
    /// One durable send-later submission is the terminal trigger-side attempt.
    /// The generic transport retains one exact request and one terminal outcome;
    /// synchronous trigger retries would only replay that same identity.
    pub fn attempt_limit(&self) -> u8 {
        if self.delivery == RuleDispatchDelivery::LaterWithDurableOutcome {
            1
        } else {
            self.max_attempts.unwrap_or(1).max(1)
        }
    }

    /// Send-later success means accepted, not target-complete.
    pub fn accepted_status(&self) -> &'static str {
        if self.delivery == RuleDispatchDelivery::LaterWithDurableOutcome {
            "accepted"
        } else {
            "succeeded"
        }
    }
}

fn default_true() -> bool {
    true
}

/// Rule DATA vocabulary for the generic inter-slot transport boundary.
///
/// This enum deliberately names transport semantics rather than a trigger-specific
/// queue. It maps one-to-one to `slot_protocol::ReplyDelivery`; no trigger-specific
/// execution machinery is attached to it here.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleDispatchDelivery {
    #[default]
    Inline,
    LaterWithDurableOutcome,
}

impl From<RuleDispatchDelivery> for slot_protocol::ReplyDelivery {
    fn from(delivery: RuleDispatchDelivery) -> Self {
        match delivery {
            RuleDispatchDelivery::Inline => Self::Inline,
            RuleDispatchDelivery::LaterWithDurableOutcome => Self::LaterWithDurableOutcome,
        }
    }
}

pub(super) fn parse_trigger_rule_record(bytes: &[u8]) -> Result<Option<TriggerRule>, String> {
    match serde_json::from_slice::<TriggerRule>(bytes) {
        Ok(rule) => Ok(Some(rule)),
        Err(_) => Ok(None),
    }
}
