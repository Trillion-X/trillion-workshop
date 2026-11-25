//! External-source compatibility fixture captured from the current public API.
//! Exhaustive construction and matching deliberately omit Default struct spread
//! and wildcard match arms, so extra fields/variants fail this consumer.
use workflow_core::{ExecutionContext, WorkflowError};
#[test]
fn legacy_exhaustive_context_and_error_consumers_still_compile() {
    let context = ExecutionContext {
        start: Default::default(),
        steps: Default::default(),
        context: Default::default(),
        trusted_local_invocation: Default::default(),
        loop_state: Default::default(),
        branches: Default::default(),
        json_conversion_policy: Default::default(),
        scope_stack: Default::default(),
        runtime_path: Default::default(),
        runtime_outputs: Default::default(),
        dirty_runtime_outputs: Default::default(),
        writes: Default::default(),
        write_index: Default::default(),
        write_generations: Default::default(),
        write_generation: Default::default(),
        write_delta_start: Default::default(),
        raw_step_bytes: Default::default(),
        dirty_steps: Default::default(),
        dirty_raw_step_bytes: Default::default(),
        cleared_raw_step_bytes: Default::default(),
    };
    assert!(context.steps.is_empty());
    fn legacy_match(error: WorkflowError) -> &'static str {
        match error {
            WorkflowError::ReadError { .. } => "ReadError",
            WorkflowError::TransactError { .. } => "TransactError",
            WorkflowError::WorkflowNotFound { .. } => "WorkflowNotFound",
            WorkflowError::DefinitionNotFound { .. } => "DefinitionNotFound",
            WorkflowError::InstanceNotFound { .. } => "InstanceNotFound",
            WorkflowError::StepNotFound { .. } => "StepNotFound",
            WorkflowError::InvalidWorkflow { .. } => "InvalidWorkflow",
            WorkflowError::InvalidDefinition { .. } => "InvalidDefinition",
            WorkflowError::InvalidStep { .. } => "InvalidStep",
            WorkflowError::InvalidTrigger { .. } => "InvalidTrigger",
            WorkflowError::InvalidTemplate { .. } => "InvalidTemplate",
            WorkflowError::SchemaValidation { .. } => "SchemaValidation",
            WorkflowError::ExecutionFailed { .. } => "ExecutionFailed",
            WorkflowError::StepExecutionFailed { .. } => "StepExecutionFailed",
            WorkflowError::DefinitionExecutionFailed { .. } => "DefinitionExecutionFailed",
            WorkflowError::TemplateResolutionFailed { .. } => "TemplateResolutionFailed",
            WorkflowError::BindingMissing { .. } => "BindingMissing",
            WorkflowError::ConditionEvaluationFailed { .. } => "ConditionEvaluationFailed",
            WorkflowError::LoopExecutionFailed { .. } => "LoopExecutionFailed",
            WorkflowError::ExternalCallFailed { .. } => "ExternalCallFailed",
            WorkflowError::PrimitiveDispatchFailed { .. } => "PrimitiveDispatchFailed",
            WorkflowError::Timeout { .. } => "Timeout",
            WorkflowError::DefinitionNotActive { .. } => "DefinitionNotActive",
            WorkflowError::WorkflowAlreadyRunning { .. } => "WorkflowAlreadyRunning",
            WorkflowError::InvalidStateTransition { .. } => "InvalidStateTransition",
            WorkflowError::PermissionDenied { .. } => "PermissionDenied",
            WorkflowError::SystemProtected => "SystemProtected",
            WorkflowError::CircuitOpen { .. } => "CircuitOpen",
            WorkflowError::CircuitHalfOpen { .. } => "CircuitHalfOpen",
            WorkflowError::Serialization { .. } => "Serialization",
            WorkflowError::UnknownTransform { .. } => "UnknownTransform",
            WorkflowError::PayloadTooDeep { .. } => "PayloadTooDeep",
            WorkflowError::PayloadTooLarge { .. } => "PayloadTooLarge",
            WorkflowError::ResourcePolicyInvalid { .. } => "ResourcePolicyInvalid",
            WorkflowError::Waiting { .. } => "Waiting",
            WorkflowError::Refused { .. } => "Refused",
            WorkflowError::Internal { .. } => "Internal",
        }
    }
    assert_eq!(legacy_match(WorkflowError::SystemProtected), "SystemProtected");
}
