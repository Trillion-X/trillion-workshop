// crates/workflow-core/src/domain/errors.rs
//
// Purpose:
//   Canonical error types for the workflow engine. WorkflowError is the single
//   source of truth for all workflow-related errors — structured, machine-readable,
//   with remediation hints.
//
// Previously lived in workflow-protocol leaf crate. Merged into workflow crate
// because workflow-protocol had only 2 consumers and the circular dep that
// justified its existence was eliminated by E.24/E.28.

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ============================================================================
// ERROR TYPES
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Error)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkflowError {
    /// Database read operation failed.
    #[error("Database read error: {reason}. Hint: {hint}")]
    #[serde(rename = "READ_ERROR")]
    ReadError { reason: String, hint: String },

    /// Database transaction failed.
    #[error("Database transaction error: {reason}. Hint: {hint}")]
    #[serde(rename = "TRANSACT_ERROR")]
    TransactError { reason: String, hint: String },

    /// Workflow definition not found in the database.
    #[error("Workflow not found: '{workflow_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "WORKFLOW_NOT_FOUND")]
    WorkflowNotFound {
        workflow_id: String,
        reason: String,
        hint: String,
    },

    /// Definition not found in the database.
    #[error("Definition not found: '{definition_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "DEFINITION_NOT_FOUND")]
    DefinitionNotFound {
        definition_id: String,
        reason: String,
        hint: String,
    },

    /// Workflow instance not found.
    #[error("Workflow instance not found: '{instance_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "INSTANCE_NOT_FOUND")]
    InstanceNotFound {
        instance_id: String,
        reason: String,
        hint: String,
    },

    /// Step not found in workflow definition.
    #[error("Step not found: '{step_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "STEP_NOT_FOUND")]
    StepNotFound {
        step_id: String,
        reason: String,
        hint: String,
    },

    /// Workflow definition is invalid (malformed structure or missing fields).
    #[error("Invalid workflow definition: {reason}. Hint: {hint}")]
    #[serde(rename = "INVALID_WORKFLOW")]
    InvalidWorkflow { reason: String, hint: String },

    /// Definition is invalid (malformed structure or missing fields).
    #[error("Invalid definition: '{definition_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "INVALID_DEFINITION")]
    InvalidDefinition {
        definition_id: String,
        reason: String,
        hint: String,
    },

    /// Step configuration is invalid.
    #[error("Invalid step configuration: '{step_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "INVALID_STEP")]
    InvalidStep {
        step_id: String,
        reason: String,
        hint: String,
    },

    /// Trigger configuration is invalid.
    #[error("Invalid trigger configuration: {reason}. Hint: {hint}")]
    #[serde(rename = "INVALID_TRIGGER")]
    InvalidTrigger { reason: String, hint: String },

    /// Template expression is invalid.
    #[error("Invalid template expression: {reason}. Hint: {hint}")]
    #[serde(rename = "INVALID_TEMPLATE")]
    InvalidTemplate { reason: String, hint: String },

    /// Schema validation failed (input does not match expected schema).
    #[error("Schema validation failed: '{definition_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "SCHEMA_VALIDATION")]
    SchemaValidation {
        definition_id: String,
        reason: String,
        hint: String,
    },

    /// Workflow execution failed (top-level execution failure).
    #[error("Workflow execution failed: {reason}. Hint: {hint}")]
    #[serde(rename = "EXECUTION_FAILED")]
    ExecutionFailed { reason: String, hint: String },

    /// A specific step failed during execution.
    #[error("Step execution failed: '{step_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "STEP_EXECUTION_FAILED")]
    StepExecutionFailed {
        step_id: String,
        reason: String,
        hint: String,
    },

    /// Definition execution failed (wrapper around step-level failures).
    #[error("Definition execution failed: '{definition_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "DEFINITION_EXECUTION_FAILED")]
    DefinitionExecutionFailed {
        definition_id: String,
        reason: String,
        hint: String,
    },

    /// Template resolution failed during parameter substitution.
    #[error("Template resolution failed: {reason}. Hint: {hint}")]
    #[serde(rename = "TEMPLATE_RESOLUTION_FAILED")]
    TemplateResolutionFailed { reason: String, hint: String },

    /// A binding's path found nothing inside a value that is there: a completed step's answer, or a loop's item. The
    /// step whose input it is fails, naming the binding and the path, instead of being handed a null that reads as
    /// "nothing to do" (Nov 25 2026, 9:11 AM CST: workflow:route-each-row-change's loops read output.chosen from an
    /// answer that had no such field, looped over none, and the run completed having chosen nothing). A binding that
    /// declares `omit_if_missing: true`, or whose first transform handles absence (op:core.if_null, coalesce, is_null,
    /// is_not_null), reads the absence as null instead: that absence is one its author expected.
    #[error("binding-missing: {reason}. Hint: {hint}")]
    #[serde(rename = "BINDING_MISSING")]
    BindingMissing { reason: String, hint: String, binding: String, path: String },

    /// Branch condition evaluation failed during workflow execution.
    #[error("Branch condition evaluation failed: '{step_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "CONDITION_EVALUATION_FAILED")]
    ConditionEvaluationFailed {
        step_id: String,
        reason: String,
        hint: String,
    },

    /// Loop execution failed (iteration error, missing source, etc.).
    #[error("Loop execution failed: '{step_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "LOOP_EXECUTION_FAILED")]
    LoopExecutionFailed {
        step_id: String,
        reason: String,
        hint: String,
    },

    /// External service call failed.
    #[error("External call failed: {reason}. Hint: {hint}")]
    #[serde(rename = "EXTERNAL_CALL_FAILED")]
    ExternalCallFailed { reason: String, hint: String },

    /// Primitive dispatch failed — the async executor could not route or execute
    /// a `PrimitiveCall`. The `primitive` field identifies which of the 8 Kernel
    /// Codex primitives failed, and `hint` provides actionable remediation.
    #[error("Primitive dispatch failed for '{primitive}': {reason}. Hint: {hint}")]
    #[serde(rename = "PRIMITIVE_DISPATCH_FAILED")]
    PrimitiveDispatchFailed {
        primitive: String,
        reason: String,
        hint: String,
    },

    /// Operation timed out.
    #[error("Timeout: '{step_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "TIMEOUT")]
    Timeout {
        step_id: String,
        reason: String,
        hint: String,
    },

    /// Definition is not in an active state and cannot be executed.
    #[error("Definition not active: '{definition_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "DEFINITION_NOT_ACTIVE")]
    DefinitionNotActive {
        definition_id: String,
        reason: String,
        hint: String,
    },

    /// Workflow is already running (concurrent execution prevented).
    #[error("Workflow already running: '{workflow_id}'. {reason}. Hint: {hint}")]
    #[serde(rename = "WORKFLOW_ALREADY_RUNNING")]
    WorkflowAlreadyRunning {
        workflow_id: String,
        reason: String,
        hint: String,
    },

    /// Instance cannot transition to the requested state from its current state.
    #[error("Invalid state transition: {reason}. Hint: {hint}")]
    #[serde(rename = "INVALID_STATE_TRANSITION")]
    InvalidStateTransition { reason: String, hint: String },

    /// Caller does not have permission for the requested operation.
    #[error("Permission denied: {reason}. Hint: {hint}")]
    #[serde(rename = "PERMISSION_DENIED")]
    PermissionDenied { reason: String, hint: String },

    /// System-protected action cannot be modified.
    #[error("System definition cannot be modified")]
    #[serde(rename = "SYSTEM_PROTECTED")]
    SystemProtected,

    /// Circuit is OPEN — step execution skipped to conserve retry budget.
    #[error("CIRCUIT_OPEN: {reason}")]
    #[serde(rename = "CIRCUIT_OPEN")]
    CircuitOpen { reason: String },

    /// Circuit is HALF_OPEN — a probe is in flight, yield to orchestrator.
    #[error("CIRCUIT_HALF_OPEN: {reason}")]
    #[serde(rename = "CIRCUIT_HALF_OPEN")]
    CircuitHalfOpen { reason: String },

    /// JSON serialization/deserialization failed.
    #[error("Serialization error: {reason}. Hint: {hint}")]
    #[serde(rename = "SERIALIZATION")]
    Serialization { reason: String, hint: String },

    /// Unknown transform operator encountered during binding resolution.
    #[error("Unknown transform '{op}' in binding. Hint: {hint}")]
    #[serde(rename = "UNKNOWN_TRANSFORM")]
    UnknownTransform { op: String, hint: String },

    #[error("FE_PAYLOAD_TOO_DEEP: JSON depth {observed} exceeds limit {limit}")]
    #[serde(rename = "FE_PAYLOAD_TOO_DEEP")]
    PayloadTooDeep { observed: usize, limit: usize },

    #[error("FE_PAYLOAD_TOO_LARGE: JSON {dimension} {observed} exceeds limit {limit}")]
    #[serde(rename = "FE_PAYLOAD_TOO_LARGE")]
    PayloadTooLarge {
        dimension: String,
        observed: usize,
        limit: usize,
    },

    #[error("FE_RESOURCE_POLICY_INVALID: {field}: {reason}")]
    #[serde(rename = "FE_RESOURCE_POLICY_INVALID")]
    ResourcePolicyInvalid { field: String, reason: String },

    /// An ask whose answer is not there yet: the work is under way somewhere else (a person, an agent, a tool on
    /// another computer). The run pauses at this step and a later run of the same definition asks again. `detail`
    /// is what the host said about the wait, kept as the step's output.
    #[error("Waiting at step '{step_id}' for an answer that is not there yet")]
    #[serde(rename = "WAITING")]
    Waiting { step_id: String, detail: serde_json::Value },

    /// A `fail` step ended the run on purpose: `said` is the definition's own words for why (a refused answer, a
    /// recovery that gave up), and it is the run's whole message, never wrapped in engine words.
    #[error("{said}")]
    #[serde(rename = "REFUSED")]
    Refused { step_id: String, said: String },

    /// Internal error (catch-all for unexpected failures).
    #[error("Internal error: {reason}. Hint: {hint}")]
    #[serde(rename = "INTERNAL")]
    Internal { reason: String, hint: String },
}

impl WorkflowError {
    /// Get a unique, stable error code for this error variant.
    ///
    /// Error codes are SCREAMING_SNAKE_CASE strings suitable for i18n keys,
    /// structured logging, and programmatic error handling by JavaScript callers.
    pub fn code(&self) -> &'static str {
        match self {
            Self::ReadError { .. } => "READ_ERROR",
            Self::TransactError { .. } => "TRANSACT_ERROR",
            Self::WorkflowNotFound { .. } => "WORKFLOW_NOT_FOUND",
            Self::DefinitionNotFound { .. } => "DEFINITION_NOT_FOUND",
            Self::InstanceNotFound { .. } => "INSTANCE_NOT_FOUND",
            Self::StepNotFound { .. } => "STEP_NOT_FOUND",
            Self::InvalidWorkflow { .. } => "INVALID_WORKFLOW",
            Self::InvalidDefinition { .. } => "INVALID_DEFINITION",
            Self::InvalidStep { .. } => "INVALID_STEP",
            Self::InvalidTrigger { .. } => "INVALID_TRIGGER",
            Self::InvalidTemplate { .. } => "INVALID_TEMPLATE",
            Self::SchemaValidation { .. } => "SCHEMA_VALIDATION",
            Self::ExecutionFailed { .. } => "EXECUTION_FAILED",
            Self::StepExecutionFailed { .. } => "STEP_EXECUTION_FAILED",
            Self::DefinitionExecutionFailed { .. } => "DEFINITION_EXECUTION_FAILED",
            Self::TemplateResolutionFailed { .. } => "TEMPLATE_RESOLUTION_FAILED",
            Self::BindingMissing { .. } => "BINDING_MISSING",
            Self::ConditionEvaluationFailed { .. } => "CONDITION_EVALUATION_FAILED",
            Self::LoopExecutionFailed { .. } => "LOOP_EXECUTION_FAILED",
            Self::ExternalCallFailed { .. } => "EXTERNAL_CALL_FAILED",
            Self::PrimitiveDispatchFailed { .. } => "PRIMITIVE_DISPATCH_FAILED",
            Self::Timeout { .. } => "TIMEOUT",
            Self::DefinitionNotActive { .. } => "DEFINITION_NOT_ACTIVE",
            Self::WorkflowAlreadyRunning { .. } => "WORKFLOW_ALREADY_RUNNING",
            Self::InvalidStateTransition { .. } => "INVALID_STATE_TRANSITION",
            Self::PermissionDenied { .. } => "PERMISSION_DENIED",
            Self::SystemProtected => "SYSTEM_PROTECTED",
            Self::CircuitOpen { .. } => "CIRCUIT_OPEN",
            Self::CircuitHalfOpen { .. } => "CIRCUIT_HALF_OPEN",
            Self::Serialization { .. } => "SERIALIZATION",
            Self::UnknownTransform { .. } => "UNKNOWN_TRANSFORM",
            Self::PayloadTooDeep { .. } => "FE_PAYLOAD_TOO_DEEP",
            Self::PayloadTooLarge { .. } => "FE_PAYLOAD_TOO_LARGE",
            Self::ResourcePolicyInvalid { .. } => "FE_RESOURCE_POLICY_INVALID",
            Self::Waiting { .. } => "WAITING",
            Self::Refused { .. } => "REFUSED",
            Self::Internal { .. } => "INTERNAL",
        }
    }

    /// Extract the `reason` field from any variant.
    pub fn reason(&self) -> &str {
        match self {
            Self::ReadError { reason, .. }
            | Self::TransactError { reason, .. }
            | Self::WorkflowNotFound { reason, .. }
            | Self::DefinitionNotFound { reason, .. }
            | Self::InstanceNotFound { reason, .. }
            | Self::StepNotFound { reason, .. }
            | Self::InvalidWorkflow { reason, .. }
            | Self::InvalidDefinition { reason, .. }
            | Self::InvalidStep { reason, .. }
            | Self::InvalidTrigger { reason, .. }
            | Self::InvalidTemplate { reason, .. }
            | Self::SchemaValidation { reason, .. }
            | Self::ExecutionFailed { reason, .. }
            | Self::StepExecutionFailed { reason, .. }
            | Self::DefinitionExecutionFailed { reason, .. }
            | Self::TemplateResolutionFailed { reason, .. }
            | Self::BindingMissing { reason, .. }
            | Self::ConditionEvaluationFailed { reason, .. }
            | Self::LoopExecutionFailed { reason, .. }
            | Self::ExternalCallFailed { reason, .. }
            | Self::PrimitiveDispatchFailed { reason, .. }
            | Self::Timeout { reason, .. }
            | Self::DefinitionNotActive { reason, .. }
            | Self::WorkflowAlreadyRunning { reason, .. }
            | Self::InvalidStateTransition { reason, .. }
            | Self::PermissionDenied { reason, .. }
            | Self::CircuitOpen { reason }
            | Self::CircuitHalfOpen { reason }
            | Self::Serialization { reason, .. }
            | Self::ResourcePolicyInvalid { reason, .. }
            | Self::Internal { reason, .. } => reason,
            Self::PayloadTooDeep { .. } => "JSON nesting exceeds the configured conversion limit",
            Self::PayloadTooLarge { .. } => "JSON size exceeds the configured conversion limit",
            Self::UnknownTransform { op, .. } => op,
            Self::SystemProtected => "System definition cannot be modified",
            Self::Waiting { .. } => "The answer to this step is not there yet",
            Self::Refused { said, .. } => said,
        }
    }

    /// Extract the `hint` field from any variant.
    pub fn hint(&self) -> &str {
        match self {
            Self::ReadError { hint, .. }
            | Self::TransactError { hint, .. }
            | Self::WorkflowNotFound { hint, .. }
            | Self::DefinitionNotFound { hint, .. }
            | Self::InstanceNotFound { hint, .. }
            | Self::StepNotFound { hint, .. }
            | Self::InvalidWorkflow { hint, .. }
            | Self::InvalidDefinition { hint, .. }
            | Self::InvalidStep { hint, .. }
            | Self::InvalidTrigger { hint, .. }
            | Self::InvalidTemplate { hint, .. }
            | Self::SchemaValidation { hint, .. }
            | Self::ExecutionFailed { hint, .. }
            | Self::StepExecutionFailed { hint, .. }
            | Self::DefinitionExecutionFailed { hint, .. }
            | Self::TemplateResolutionFailed { hint, .. }
            | Self::BindingMissing { hint, .. }
            | Self::ConditionEvaluationFailed { hint, .. }
            | Self::LoopExecutionFailed { hint, .. }
            | Self::ExternalCallFailed { hint, .. }
            | Self::PrimitiveDispatchFailed { hint, .. }
            | Self::Timeout { hint, .. }
            | Self::DefinitionNotActive { hint, .. }
            | Self::WorkflowAlreadyRunning { hint, .. }
            | Self::InvalidStateTransition { hint, .. }
            | Self::PermissionDenied { hint, .. }
            | Self::Serialization { hint, .. }
            | Self::UnknownTransform { hint, .. }
            | Self::Internal { hint, .. } => hint,
            Self::PayloadTooDeep { .. } => "Reduce payload nesting or select a smaller subtree",
            Self::PayloadTooLarge { .. } => "Reduce payload size or select a smaller subtree",
            Self::ResourcePolicyInvalid { .. } => {
                "Provide a positive policy no larger than the package ceiling"
            }
            Self::SystemProtected => "This is a system-protected definition and cannot be modified",
            Self::CircuitOpen { .. } => "Wait for circuit cooldown or check downstream health",
            Self::CircuitHalfOpen { .. } => {
                "Yield — orchestrator will reschedule after probe resolves"
            }
            Self::Waiting { .. } => "Run the definition again once the answer is there; earlier answers are kept by the host",
            Self::Refused { .. } => "Run it again with what the refusal asks for",
        }
    }

    /// Check if this error is recoverable.
    pub fn is_recoverable(&self) -> bool {
        matches!(
            self,
            Self::Timeout { .. }
                | Self::ExternalCallFailed { .. }
                | Self::TemplateResolutionFailed { .. }
        )
    }

    /// What a failed or waiting step keeps as its output, as data: the problems a check found, what the host said
    /// about a wait, or, when the step's answerer could not be reached at all, which dispatch it was and the words the
    /// host's side failed with. A dispatch failure decided nothing about the step itself, so a host that keeps the run
    /// reads `dispatch_failed` to tell "could not reach it" from "it failed" without parsing the message, and may run
    /// the definition again with the answers it kept. Null for every other error, whose message is the whole story.
    pub fn evidence(&self) -> serde_json::Value {
        match self {
            Self::Waiting { detail, .. } => detail.clone(),
            Self::PrimitiveDispatchFailed { primitive, reason, .. } => {
                serde_json::json!({ "dispatch_failed": { "dispatch": primitive, "reason": reason } })
            }
            _ => serde_json::Value::Null,
        }
    }

    /// Check if this error permits retry within `execute_step_with_retry`.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::ExecutionFailed { .. } | Self::ExternalCallFailed { .. } | Self::Timeout { .. }
        )
    }

    /// Check if this error is fatal (not retryable AND not a circuit event).
    pub fn is_fatal(&self) -> bool {
        !matches!(
            self,
            Self::CircuitOpen { .. } | Self::CircuitHalfOpen { .. }
        ) && !self.is_retryable()
    }
}

impl From<serde_json::Error> for WorkflowError {
    fn from(e: serde_json::Error) -> Self {
        WorkflowError::Serialization {
            reason: e.to_string(),
            hint: "Check that the JSON input is well-formed and matches the expected schema"
                .to_string(),
        }
    }
}

impl From<std::io::Error> for WorkflowError {
    fn from(e: std::io::Error) -> Self {
        WorkflowError::Internal {
            reason: e.to_string(),
            hint: "Check file system permissions and disk space".to_string(),
        }
    }
}

/// Workflow result type (Result alias with WorkflowError as error type)
pub type WorkflowResult<T> = Result<T, WorkflowError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_contains_reason_and_hint() {
        let err = WorkflowError::ReadError {
            reason: "test".to_string(),
            hint: "check db".to_string(),
        };
        let display = format!("{}", err);
        assert!(display.contains("test"));
        assert!(display.contains("check db"));
    }

    #[test]
    fn test_error_code_stable() {
        let err = WorkflowError::ReadError {
            reason: "x".to_string(),
            hint: "y".to_string(),
        };
        assert_eq!(err.code(), "READ_ERROR");
    }

    #[test]
    fn test_error_is_recoverable() {
        let timeout = WorkflowError::Timeout {
            step_id: "s1".to_string(),
            reason: "slow".to_string(),
            hint: "retry".to_string(),
        };
        assert!(timeout.is_recoverable());

        let read_err = WorkflowError::ReadError {
            reason: "x".to_string(),
            hint: "y".to_string(),
        };
        assert!(!read_err.is_recoverable());
    }

    #[test]
    fn a_dispatch_failure_keeps_which_dispatch_and_the_hosts_words_as_data() {
        let failed = WorkflowError::PrimitiveDispatchFailed {
            primitive: "ask:ai".to_string(),
            reason: "TypeError: The RPC receiver does not implement the method \"call\".".to_string(),
            hint: "Outside-work dispatch failed for 'ask:ai'".to_string(),
        };
        assert_eq!(
            failed.evidence(),
            serde_json::json!({ "dispatch_failed": {
                "dispatch": "ask:ai",
                "reason": "TypeError: The RPC receiver does not implement the method \"call\"."
            } })
        );
        let step_error = WorkflowError::StepExecutionFailed {
            step_id: "plan".to_string(),
            reason: "The RPC receiver does not implement the method".to_string(),
            hint: "x".to_string(),
        };
        assert_eq!(step_error.evidence(), serde_json::Value::Null, "a step's own failure is never a dispatch failure, whatever its words");
    }

    #[test]
    fn test_workflow_result_type_alias() {
        let ok: WorkflowResult<i32> = Ok(42);
        assert!(matches!(ok, Ok(42)));

        let err: WorkflowResult<i32> = Err(WorkflowError::SystemProtected);
        assert!(err.is_err());
    }

    #[test]
    fn test_from_serde_json_error() {
        let bad_json = "not json{";
        let result: Result<serde_json::Value, _> = serde_json::from_str(bad_json);
        let wf_err: WorkflowError = result.unwrap_err().into();
        assert_eq!(wf_err.code(), "SERIALIZATION");
    }
}
