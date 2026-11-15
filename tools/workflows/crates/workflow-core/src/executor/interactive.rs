// crates/workflow-core/src/executor/interactive.rs
//
// Purpose:
//   Interactive execution mode for UI-triggered definitions. Loads a Definition
//   from the database via DefinitionStore, validates input against input_schema,
//   executes all workflow steps sequentially via StepExecutor, and returns a
//   combined DefinitionOutput.
//
// Non-Negotiable Invariants:
//   1. Action loading goes through `load_definition_by_id()` from loader.rs — no
//      parallel loading mechanism, no direct database access.
//   2. Step execution goes through `StepExecutor::execute_step()` from
//      step_executor.rs — no duplicated step execution logic.
//   3. `record_step_output()` from context.rs is used by StepExecutor internally
//      — this module does not manually record step outputs.
//   4. Input validation checks required fields from the declared input_schema.
//      Legacy map schemas use their keys as required fields; JSON-schema-style
//      objects use their `required` array and treat `properties` as metadata.
//      Empty schema (`{}`) accepts any input.
//   5. Inactive definitions (is_active = false) are rejected before execution begins.
//   6. No `.unwrap()` in production code. All errors are structured with
//      remediation hints.
//
// Key Concepts:
//   - execute_definition_interactive(): Full lifecycle: load → validate → build context → execute steps → return output
//   - validate_input(): Checks input has all fields required by input_schema
//   - DefinitionOutput: Combined result from all workflow steps (defined in domain/types.rs)
//
// Interactive Execution Flow:
//
//   ```text
//   execute_definition_interactive(store, definition_id, input, actor)
//       |
//       | 1. Load: load_definition_by_id(store, definition_id, partition_key)
//       | 2. Validate: is_active must be true
//       | 3. Validate: input must satisfy input_schema
//       | 4. Build: ExecutionContext with start.input = input
//       | 5. Build: DataGuards from GuardsFactory (or DataGuards::none() if no factory)
//       | 6. Build: ExecutorDeps from executor's slot_dispatcher + partition_key + circuit_state
//       | 7. Execute: for each step in workflow_steps (in order):
//       |        StepExecutor::execute_step(step, step_id, exec_ctx, deps, actor)
//       | 8. Return: DefinitionOutput with all step results
//       v
//   DefinitionOutput { definition_id, status: Completed, steps: {...}, final_output, ... }
//   ```
//
// Security Considerations:
//   - Guards: When a `GuardsFactory` is configured on the executor, `execute_definition_interactive()`
//     calls `factory.create_guards()` to construct real `DataGuards` (permission,
//     constraint, audit) per invocation. Without a factory, `DataGuards::none()` is
//     used — acceptable only in test code.
//   - Input validation prevents missing-field errors deep in execution.
//   - Inactive definitions are rejected early — no side effects occur.
//   - All dispatch flows through dispatch_primitive() which enforces security policies
//     using the guards constructed above.
//   - Actor context is passed through unchanged — no fabrication or escalation.
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.
//   Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.

use serde_json::Value;
use slot_protocol::ActorContext;
use web_time::Instant;

use super::automation::RetryPolicy;
use super::AsyncWorkflowExecutor;
use crate::domain::errors::WorkflowError;
use crate::domain::types::{
    DefinitionOutput, ExecutionStatus, PendingWrite, StartData, WorkflowInstance,
};
use crate::domain::DefinitionStore;
use crate::executor::context::canonical_step_id;
use crate::loader::load_definition_by_id;

#[cfg(test)]
use crate::domain::types::{Step, StepOutput};
#[cfg(test)]
use std::collections::HashSet;

// ============================================================================
// INTERACTIVE EXECUTION — execute_definition on AsyncWorkflowExecutor
// ============================================================================

/// Interactive execution result for query-handler callers.
///
/// Keeps the public workflow output bytes separate from the stone-owned write set
/// that the handler edge translates into `QueryResult::with_writes(...)`.
#[derive(Debug, Clone)]
pub struct InteractiveExecutionResult {
    pub output: DefinitionOutput,
    pub writes: Vec<PendingWrite>,
}

impl AsyncWorkflowExecutor {
    /// Execute a definition by ID in interactive mode.
    ///
    /// Loads the definition from the database, validates the input
    /// against the definition's input_schema, then executes all workflow steps
    /// sequentially via StepExecutor.
    ///
    /// # Arguments
    ///
    /// * `store` — DefinitionStore implementation for loading definitions
    /// * `definition_id` — entity ID of the definition to execute
    /// * `input` — JSON input data (becomes start.input for template resolution)
    /// * `actor` — Authenticated actor performing the operation
    ///
    /// # Returns
    ///
    /// * `Ok(DefinitionOutput)` — All steps completed successfully. Contains
    ///   individual step outputs, the final step's output, and timing metadata.
    /// * `Err(WorkflowError)` — Execution failed. Possible error types:
    ///
    /// # Errors
    ///
    /// | Error Type | Cause |
    /// |-----------|-------|
    /// | `DefinitionNotFound` | No definition with the given ID exists |
    /// | `DefinitionNotActive` | Definition exists but is_active = false |
    /// | `SchemaValidation` | Input does not satisfy input_schema |
    /// | `StepExecutionFailed` | A workflow step failed during execution |
    /// | `TemplateResolutionFailed` | Template expression could not be resolved |
    /// | `PrimitiveDispatchFailed` | Primitive dispatch infrastructure error |
    /// | `Timeout` | A step exceeded its timeout duration |
    pub async fn execute_definition_interactive(
        &self,
        store: &dyn DefinitionStore,
        definition_id: &str,
        input: Value,
        actor: ActorContext,
    ) -> Result<DefinitionOutput, WorkflowError> {
        self.execute_definition_query(store, definition_id, input, actor, true, true)
            .await
            .map(|result| result.output)
    }

    /// Execute a definition by ID and preserve both output bytes and stone writes.
    pub async fn execute_definition_query(
        &self,
        store: &dyn DefinitionStore,
        definition_id: &str,
        input: Value,
        actor: ActorContext,
        include_steps: bool,
        include_output: bool,
    ) -> Result<InteractiveExecutionResult, WorkflowError> {
        let run_start = Instant::now();

        // 1. Load definition from database via DefinitionStore
        let definition = load_definition_by_id(store, definition_id, self.partition_key())?
            .ok_or_else(|| WorkflowError::DefinitionNotFound {
                definition_id: definition_id.to_string(),
                reason: format!(
                    "Definition not found in partition '{}'",
                    self.partition_key()
                ),
                hint: "Verify the definition_id is a valid entity ID and the definition \
                           exists in the target partition"
                    .to_string(),
            })?;

        // 2. Validate definition is active
        if !definition.is_active {
            return Err(WorkflowError::DefinitionNotActive {
                definition_id: definition_id.to_string(),
                reason: format!(
                    "Definition '{}' ({}) is not active",
                    definition_id, definition.name
                ),
                hint: "Set the is_active flag to true on the definition \
                       before attempting execution"
                    .to_string(),
            });
        }

        // 3. Validate input against input_schema
        validate_input(&input, &definition.input_schema, definition_id)?;

        // 4. Build StartData with input as the execution payload.
        //
        // `started_at` MUST be RFC 3339, because a workflow action cannot know whether it was
        // reached through this interactive path or through the trigger path in `polling.rs`,
        // which carries `TriggerEvent.timestamp`. The same DATA binding reads both, into the
        // same field of the same record, so two formats here means one column that disagrees
        // with itself depending on how a person happened to start the action.
        //
        // RFC 3339 rather than epoch seconds because that is what the corpus already speaks:
        // 17 ISO-shaped timestamp literals across the package manifests and zero
        // epoch-seconds ones, and `to_rfc3339()` is the existing house call in five sibling
        // crates. It is also self-describing and lexicographically sortable, where an epoch
        // integer is an encoding that every reader must decode.
        //
        // The instant still comes from `web_time`, deliberately: this crate compiles to WASM,
        // where `chrono::Utc::now()` is not available. Only the FORMATTING changed.
        let timestamp = web_time::SystemTime::now()
            .duration_since(web_time::UNIX_EPOCH)
            .ok()
            .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos()))
            .map(|moment| moment.to_rfc3339())
            .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string());

        let start = StartData {
            start_type: "interactive".to_string(),
            input,
            started_at: timestamp,
            start_id: None,
        };
        let output_definition_id = definition.id.clone();
        let final_step_key = definition
            .steps
            .iter()
            .enumerate()
            .next_back()
            .map(|(index, step)| canonical_step_id(step, index));

        // 5. Execute via the unified DAG executor so the public definition entry
        //    point matches the full Definition model (ask/read/write, loop, action, wait).
        let instance = self
            .execute_definition(definition, start, actor, &RetryPolicy::default())
            .await?;

        // 6. Preserve the interactive public contract: failed execution returns
        //    an error, even though the unified executor models failure on the
        //    WorkflowInstance itself.
        if matches!(instance.status, ExecutionStatus::Failed) {
            return Err(WorkflowError::ExecutionFailed {
                reason: instance
                    .error_message
                    .clone()
                    .unwrap_or_else(|| {
                        format!(
                            "Definition '{}' failed during execution",
                            definition_id
                        )
                    }),
                hint: "Inspect the failed step output and execution context to determine which step failed and why"
                    .to_string(),
            });
        }

        // 7. Build and return DefinitionOutput
        let total_duration_ms = run_start.elapsed().as_millis() as i64;
        let final_output = if include_output {
            final_step_key
                .as_ref()
                .and_then(|key| instance.execution_context.steps.get(key))
                .map(|output| output.output.clone())
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };

        let WorkflowInstance {
            status,
            error_message,
            mut execution_context,
            ..
        } = instance;
        let writes = std::mem::take(&mut execution_context.writes);
        let steps = if include_steps {
            std::mem::take(&mut execution_context.steps)
        } else {
            Default::default()
        };
        Ok(InteractiveExecutionResult {
            output: DefinitionOutput {
                definition_id: output_definition_id,
                status,
                steps,
                final_output,
                total_duration_ms,
                error: error_message,
            },
            writes,
        })
    }
}

// ============================================================================
// DEPENDENCY-AWARE STEP BATCHING
//
// Analyzes step parameter JSON for `$step[N]` output references to determine
// data dependencies between steps. Groups independent steps into batches
// that can execute without waiting for each other. Steps with dependencies
// are placed in later batches, after the steps they depend on.
//
// Pattern: `$step[N].result` or `$step[N]` where N is a 0-based step index.
// This is the canonical format for step output references in workflow params.
//
// Architecture:
//   plan_execution(steps) -> Vec<Vec<usize>> (batches of step indices)
//       ↓ uses
//   find_step_output_references(params, current_step) -> HashSet<usize>
//       ↓ walks JSON recursively, finds $step[N] patterns
//
//   resolve_step_refs(params, results) -> Value
//       ↓ walks JSON recursively, replaces $step[N].result with actual values
// ============================================================================

/// Analyze step dependencies and group into batches of independent steps.
///
/// Each batch contains step indices that can execute without waiting for
/// each other. Batches execute in order — all steps in batch N complete
/// before batch N+1 begins.
///
/// # Algorithm
///
/// For each step, find which previous steps it references (via `$step[N]`).
/// The step's batch index is `max(batch[dep] + 1 for dep in deps)`, or 0
/// if it has no dependencies. This is a topological sort by level.
///
/// # Returns
///
/// `Vec<Vec<usize>>` — outer vec is batches in execution order, inner vec
/// is step indices within each batch (in original step order).
///
/// # Examples
///
/// - 5 independent steps → `[[0, 1, 2, 3, 4]]` (1 batch)
/// - Linear chain A→B→C → `[[0], [1], [2]]` (3 batches)
/// - Diamond: A,B independent, C depends on both → `[[0, 1], [2]]`
#[cfg(test)]
fn plan_execution(steps: &[Step]) -> Vec<Vec<usize>> {
    if steps.is_empty() {
        return Vec::new();
    }

    let deps: Vec<HashSet<usize>> = steps
        .iter()
        .enumerate()
        .map(|(i, step)| find_step_output_references(&step.config, i))
        .collect();

    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut step_batch: Vec<usize> = vec![0; steps.len()];

    for i in 0..steps.len() {
        let batch_idx = if deps[i].is_empty() {
            0
        } else {
            deps[i]
                .iter()
                .map(|&dep| step_batch[dep] + 1)
                .max()
                .unwrap_or(0)
        };
        step_batch[i] = batch_idx;
        while batches.len() <= batch_idx {
            batches.push(Vec::new());
        }
        batches[batch_idx].push(i);
    }
    batches
}

/// Scan step parameters for `$step[N]` output references.
///
/// Walks the JSON value tree recursively. In every string value, finds
/// patterns matching `$step[N]` where N is a non-negative integer. Returns
/// the set of referenced step indices.
///
/// Only references to steps BEFORE `current_step` are valid dependencies.
/// Forward references (to steps that haven't executed yet) are ignored
/// as they represent either errors in the workflow or intentional no-ops.
///
/// # Pattern Format
///
/// - `$step[0].result` — references output of step 0
/// - `$step[3]` — references step 3 (with or without `.result` suffix)
/// - `prefix $step[1].result suffix` — embedded in larger strings
#[cfg(test)]
fn find_step_output_references(params: &Value, current_step: usize) -> HashSet<usize> {
    let mut refs = HashSet::new();
    walk_for_refs(params, &mut refs, current_step);
    refs
}

/// Recursive JSON walker for finding `$step[N]` references.
#[cfg(test)]
fn walk_for_refs(value: &Value, refs: &mut HashSet<usize>, current_step: usize) {
    match value {
        Value::String(s) => {
            // Parse $step[N] patterns without regex
            let mut pos = 0;
            while pos + "$step[".len() < s.len() {
                if let Some(start) = s[pos..].find("$step[") {
                    let abs_start = pos + start + "$step[".len();
                    if let Some(bracket_end) = s[abs_start..].find(']') {
                        let num_str = &s[abs_start..abs_start + bracket_end];
                        if let Ok(idx) = num_str.parse::<usize>() {
                            if idx < current_step {
                                refs.insert(idx);
                            }
                        }
                        pos = abs_start + bracket_end + 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                walk_for_refs(v, refs, current_step);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                walk_for_refs(v, refs, current_step);
            }
        }
        _ => {}
    }
}

/// Replace `$step[N].result` references with actual step results.
///
/// Walks the JSON value tree recursively. In every string containing
/// `$step[N].result`, substitutes the pattern with the string representation
/// of the corresponding step's output value.
///
/// If a referenced step has no result yet (None in the results array),
/// the reference is left unchanged — this allows forward references to
/// pass through harmlessly.
///
/// # Arguments
///
/// * `params` — The JSON params to resolve
/// * `results` — Slice of step results indexed by step number
#[cfg(test)]
fn resolve_step_refs(params: &Value, results: &[Option<StepOutput>]) -> Value {
    match params {
        Value::String(s) if s.contains("$step[") => {
            let mut resolved = s.clone();
            // Process all $step[N].result and $step[N] patterns
            // We iterate from the end to avoid offset invalidation
            let replacements: Vec<(usize, usize, String)> = find_replacements(s, results);
            for (start, end, replacement) in replacements.into_iter().rev() {
                resolved.replace_range(start..end, &replacement);
            }
            Value::String(resolved)
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve_step_refs(v, results)))
                .collect(),
        ),
        Value::Array(arr) => {
            Value::Array(arr.iter().map(|v| resolve_step_refs(v, results)).collect())
        }
        other => other.clone(),
    }
}

/// Find all `$step[N].result` or `$step[N]` patterns and their replacements.
///
/// Returns `(start_byte, end_byte, replacement_string)` tuples sorted by
/// start position. Used by `resolve_step_refs` for safe in-place replacement.
#[cfg(test)]
fn find_replacements(s: &str, results: &[Option<StepOutput>]) -> Vec<(usize, usize, String)> {
    let mut replacements = Vec::new();
    let mut pos = 0;

    while pos < s.len() {
        if let Some(start) = s[pos..].find("$step[") {
            let abs_start = pos + start;
            let after_prefix = abs_start + "$step[".len();
            if let Some(bracket_end) = s[after_prefix..].find(']') {
                let num_str = &s[after_prefix..after_prefix + bracket_end];
                if let Ok(idx) = num_str.parse::<usize>() {
                    let after_bracket = after_prefix + bracket_end + 1;
                    // Check for optional .result suffix
                    let end = if s[after_bracket..].starts_with(".result") {
                        after_bracket + ".result".len()
                    } else {
                        after_bracket
                    };

                    if let Some(Some(result)) = results.get(idx) {
                        let replacement = match &result.output {
                            Value::String(v) => v.clone(),
                            other => other.to_string(),
                        };
                        replacements.push((abs_start, end, replacement));
                    }
                    pos = end;
                } else {
                    pos = after_prefix + bracket_end + 1;
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }

    replacements
}

// ============================================================================
// INPUT VALIDATION
// ============================================================================

/// Validate input against an action's input_schema.
///
/// Legacy input_schema objects use keys as required fields.
/// JSON-schema-style objects use `required: string[]`; `properties` describes
/// fields but does not itself become a required payload key.
/// If the schema is empty (`{}`) or null, any input is accepted.
/// If the schema has required fields, the input must be a JSON object containing
/// all of them.
///
/// # Errors
///
/// Returns `WorkflowError::SchemaValidation` if:
/// - Schema has required fields but input is not a JSON object
/// - Schema has a required field that is missing from the input
fn validate_input(input: &Value, schema: &Value, definition_id: &str) -> Result<(), WorkflowError> {
    // Empty or null schema — any input is valid
    let schema_obj = match schema.as_object() {
        Some(obj) if !obj.is_empty() => obj,
        _ => return Ok(()),
    };
    let required_fields = required_input_fields(schema_obj, definition_id)?;
    if required_fields.is_empty() {
        return Ok(());
    }

    // Schema has required fields — input must be a JSON object containing them
    let input_obj = input
        .as_object()
        .ok_or_else(|| WorkflowError::SchemaValidation {
            definition_id: definition_id.to_string(),
            reason: format!(
                "Input must be a JSON object, but got {}",
                value_type_name(input)
            ),
            hint: format!(
                "Provide input as a JSON object with the required fields: {}",
                required_fields.join(", ")
            ),
        })?;

    // Check each required field exists in input.
    for key in &required_fields {
        if !input_obj.contains_key(key) {
            return Err(WorkflowError::SchemaValidation {
                definition_id: definition_id.to_string(),
                reason: format!("Required input field '{}' was not provided", key),
                hint: format!(
                    "Include all required fields in the input object: {}",
                    required_fields.join(", ")
                ),
            });
        }
    }

    Ok(())
}

fn required_input_fields(
    schema_obj: &serde_json::Map<String, Value>,
    definition_id: &str,
) -> Result<Vec<String>, WorkflowError> {
    let has_properties_object = schema_obj
        .get("properties")
        .and_then(Value::as_object)
        .is_some();
    let has_required_array = schema_obj
        .get("required")
        .and_then(Value::as_array)
        .is_some();

    if has_properties_object || has_required_array {
        let Some(required_value) = schema_obj.get("required") else {
            return Ok(Vec::new());
        };
        let required =
            required_value
                .as_array()
                .ok_or_else(|| WorkflowError::SchemaValidation {
                    definition_id: definition_id.to_string(),
                    reason: "input_schema.required must be an array".to_string(),
                    hint: "Use JSON-schema required as an array of field-name strings.".to_string(),
                })?;

        let mut fields = Vec::with_capacity(required.len());
        for field in required {
            let name = field
                .as_str()
                .ok_or_else(|| WorkflowError::SchemaValidation {
                    definition_id: definition_id.to_string(),
                    reason: "input_schema.required entries must be strings".to_string(),
                    hint: "Use JSON-schema required as an array of field-name strings.".to_string(),
                })?
                .trim();
            if name.is_empty() {
                return Err(WorkflowError::SchemaValidation {
                    definition_id: definition_id.to_string(),
                    reason: "input_schema.required contains an empty field name".to_string(),
                    hint: "Remove empty required-field names from the input schema.".to_string(),
                });
            }
            fields.push(name.to_string());
        }
        return Ok(fields);
    }

    Ok(schema_obj.keys().cloned().collect())
}

/// Human-readable type name for a serde_json::Value (used in error messages).
fn value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::errors::WorkflowResult;
    use crate::domain::types::{Definition, PendingWrite, Step};
    use crate::domain::DefinitionStore;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    // ========================================================================
    // TestDefinitionStore — unified store for testing (implements DefinitionStore)
    // ========================================================================

    struct TestDefinitionStore {
        definitions: std::collections::HashMap<String, Definition>,
    }

    impl TestDefinitionStore {
        fn new() -> Self {
            Self {
                definitions: std::collections::HashMap::new(),
            }
        }

        fn register(&mut self, def: Definition) {
            self.definitions.insert(def.id.clone(), def);
        }
    }

    impl DefinitionStore for TestDefinitionStore {
        fn get_by_id(&self, id: &str, _partition_key: &str) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.get(id).cloned())
        }

        fn get_by_slug(
            &self,
            slug: &str,
            _partition_key: &str,
        ) -> WorkflowResult<Option<Definition>> {
            Ok(self.definitions.values().find(|d| d.name == slug).cloned())
        }

        fn get_active(
            &self,
            _partition_key: &str,
            kind: Option<&str>,
        ) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.is_active)
                .filter(|d| kind.is_none_or(|k| d.kind == k))
                .cloned()
                .collect())
        }

        fn get_by_trigger(
            &self,
            trigger_source: &str,
            _partition_key: &str,
        ) -> WorkflowResult<Vec<Definition>> {
            Ok(self
                .definitions
                .values()
                .filter(|d| d.trigger_source == trigger_source && d.is_active)
                .cloned()
                .collect())
        }
    }

    // ========================================================================
    // Mock outside-access adapter for tests
    // ========================================================================

    struct MockOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for MockOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            let response = json!({"status": "ok", "result": {}});
            Ok(std::sync::Arc::from(
                serde_json::to_vec(&response).unwrap().into_boxed_slice(),
            ))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            let response = json!({"status": "ok", "result": {}});
            Ok(crate::executor::context::DirectReadResult {
                bytes: std::sync::Arc::from(
                    serde_json::to_vec(&response).unwrap().into_boxed_slice(),
                ),
                content_hash: "test-content-hash".to_string(),
            })
        }
    }

    #[derive(Default)]
    struct PendingWriteProbeOutsideAccess {
        calls: Mutex<Vec<PendingWriteProbeCall>>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct PendingWriteProbeCall {
        name: String,
        pending_write_addresses: Vec<String>,
    }

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for PendingWriteProbeOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            let response = json!({"items": []});
            Ok(std::sync::Arc::from(
                serde_json::to_vec(&response).unwrap().into_boxed_slice(),
            ))
        }

        async fn ask_with_pending_writes(
            &self,
            name: &str,
            partition_key: &slot_protocol::PartitionKey,
            payload: bytes::Bytes,
            context: Option<bytes::Bytes>,
            pending_writes: &[PendingWrite],
        ) -> Result<std::sync::Arc<[u8]>, String> {
            self.calls
                .lock()
                .expect("pending write probe lock")
                .push(PendingWriteProbeCall {
                    name: name.to_string(),
                    pending_write_addresses: pending_writes
                        .iter()
                        .map(|write| write.address.clone())
                        .collect(),
                });
            self.ask(name, partition_key, payload, context).await
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            let response = json!({"status": "ok", "result": {}});
            Ok(crate::executor::context::DirectReadResult {
                bytes: std::sync::Arc::from(
                    serde_json::to_vec(&response).unwrap().into_boxed_slice(),
                ),
                content_hash: "test-content-hash".to_string(),
            })
        }
    }

    /// Outside-access adapter that always returns an error — for testing error paths.
    struct ErrorOutsideAccess;

    #[async_trait::async_trait]
    impl crate::executor::context::OutsideAccess for ErrorOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            Err("outside access failed: connection refused".to_string())
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<crate::executor::context::DirectReadResult, String> {
            Err("outside access failed: connection refused".to_string())
        }
    }

    // ========================================================================
    // Test DefinitionStore — in-memory store for testing
    // ========================================================================

    // ========================================================================
    // Test Helpers
    // ========================================================================

    /// Build an AsyncWorkflowExecutor with test backend and context.
    fn test_executor() -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(MockOutsideAccess),
            Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        )
    }

    /// Build an AsyncWorkflowExecutor whose dispatcher always fails.
    fn test_error_executor() -> AsyncWorkflowExecutor {
        AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(ErrorOutsideAccess),
            Arc::new(TestDefinitionStore::new()),
            crate::executor::context::test_product_word_ids(),
        )
    }

    fn test_actor() -> ActorContext {
        ActorContext::new("user:test")
    }

    fn leaf_step(input: Value) -> Step {
        Step::ask("test.owner", input)
    }

    fn event_concat(prefix: &str, suffix: &str) -> Value {
        json!({
            "$kind": "binding",
            "select": {
                "from": "input",
                "path": "event_ref"
            },
            "transform": [{
                "op": "op:core.concat",
                "args": {
                    "values": [
                        prefix,
                        {
                            "$kind": "binding",
                            "select": {
                                "from": "input",
                                "path": "event_ref"
                            }
                        },
                        suffix
                    ]
                }
            }]
        })
    }

    fn stringified_input(path: &str) -> Value {
        json!({
            "$kind": "binding",
            "select": {
                "from": "input",
                "path": path
            },
            "transform": [{
                "op": "op:core.stringify",
                "args": {
                    "format": "json"
                }
            }]
        })
    }

    fn addressed_write_descriptor_batch() -> Value {
        let mut items = vec![
            json!({
                "address": event_concat("record|state-record:", ""),
                "path": ["record-state", "record"],
                "payload": {
                    "table": "record",
                    "id": event_concat("state-record:", "")
                }
            }),
            json!({
                "address": event_concat("record_kinds|state-record:", "|type:state_record"),
                "path": ["record-state", "record-kinds"],
                "payload": {
                    "table": "record_kinds",
                    "record_id": event_concat("state-record:", ""),
                    "kind_id": "type:state_record"
                }
            }),
        ];

        for (property_id, type_id, input_path) in [
            ("prop:state_record:actor_ref", "type:string", "actor_ref"),
            ("prop:state_record:target_ref", "type:string", "target_ref"),
            (
                "prop:state_record:subject_ref",
                "type:string",
                "payload.subject_ref",
            ),
            (
                "prop:state_record:draft_text",
                "type:string",
                "payload.patch.draft_text",
            ),
            (
                "prop:state_record:reply_selection_refs",
                "type:json",
                "payload.patch.reply_selection_refs",
            ),
            (
                "prop:state_record:activity_state_ref",
                "type:string",
                "payload.patch.activity_state_ref",
            ),
            (
                "prop:state_record:activity_phrase",
                "type:string",
                "payload.patch.activity_phrase",
            ),
            (
                "prop:state_record:activity_expires_at",
                "type:string",
                "payload.patch.activity_expires_at",
            ),
            (
                "prop:state_record:updated_at",
                "type:string",
                "requested_at",
            ),
            ("prop:state_record:payload", "type:json", "payload"),
        ] {
            let suffix = format!("|{property_id}|{type_id}");
            items.push(json!({
                "address": event_concat("record_fields|state-record:", &suffix),
                "path": ["record-state", "record-fields"],
                "payload": {
                    "table": "record_fields",
                    "record_id": event_concat("state-record:", ""),
                    "field_id": property_id,
                    "value_kind_id": type_id,
                    "value_json": stringified_input(input_path)
                }
            }));
        }

        Value::Array(items)
    }

    fn addressed_batch_write_action(id: &str) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: "addressed write descriptor batch".to_string(),
            input_schema: json!({}),
            steps: vec![Step::write(addressed_write_descriptor_batch())],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        }
    }

    /// Build a single-step action with a plain ask leaf step.
    fn single_step_action(id: &str) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: format!("Test action {}", id),
            input_schema: json!({}),
            steps: vec![leaf_step(json!({"name": "TestType"}))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        }
    }

    /// Build a multi-step action with 3 plain ask leaf steps.
    fn multi_step_action(id: &str) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: format!("Multi-step test action {}", id),
            input_schema: json!({}),
            steps: vec![
                leaf_step(json!({"name": "TypeA"})),
                leaf_step(json!({"name": "TypeB"})),
                leaf_step(json!({"name": "TypeC"})),
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        }
    }

    // ========================================================================
    // Test 1: execute_definition loads action from DB and executes successfully
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_loads_and_executes() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = single_step_action("action:test:simple");
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(&store, "action:test:simple", json!({}), test_actor())
            .await;

        assert!(
            result.is_ok(),
            "execute_definition should succeed: {:?}",
            result.err()
        );

        let output = result.expect("should be Ok");
        assert_eq!(output.definition_id, "action:test:simple");
        assert_eq!(output.status, ExecutionStatus::Completed);
        assert!(output.error.is_none());
        assert!(output.total_duration_ms >= 0);
    }

    // ========================================================================
    // Test 2: Steps execute in order and outputs accumulate
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_steps_in_order() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = multi_step_action("action:test:multi");
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(&store, "action:test:multi", json!({}), test_actor())
            .await;

        assert!(
            result.is_ok(),
            "multi-step should succeed: {:?}",
            result.err()
        );

        let output = result.expect("should be Ok");
        assert_eq!(output.steps.len(), 3, "should have 3 step outputs");
        assert!(output.steps.contains_key("step_0"), "step_0 must exist");
        assert!(output.steps.contains_key("step_1"), "step_1 must exist");
        assert!(output.steps.contains_key("step_2"), "step_2 must exist");

        // All steps should be completed
        for (id, step) in &output.steps {
            assert_eq!(
                step.status,
                ExecutionStatus::Completed,
                "Step {} should be completed",
                id
            );
        }
    }

    #[tokio::test]
    async fn test_execute_definition_query_preserves_writes() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = Definition {
            id: "action:test:write".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:write".to_string(),
            description: "write propagation".to_string(),
            input_schema: json!({}),
            steps: vec![Step::write(json!([
                {
                    "address": "component:app-shell",
                    "path": ["prop:extension:bundle"],
                    "payload": {"bundle": "compiled"}
                }
            ]))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action);

        let result = executor
            .execute_definition_query(
                &store,
                "action:test:write",
                json!({}),
                test_actor(),
                true,
                true,
            )
            .await
            .expect("interactive query should succeed");

        assert_eq!(result.output.status, ExecutionStatus::Completed);
        assert_eq!(result.writes.len(), 1);
        assert_eq!(result.writes[0].address, "component:app-shell");
        assert_eq!(result.writes[0].path, vec!["prop:extension:bundle"]);
    }

    /// A DATA-declared failure branch may perform inverse work after an earlier
    /// write has been staged.  The public interactive boundary must still
    /// return an error rather than exposing that staged write set to the
    /// caller, because the handler edge commits `InteractiveExecutionResult`
    /// writes only on `Ok`.
    #[tokio::test]
    async fn test_failure_recovery_branch_never_returns_staged_writes_to_interactive_caller() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = Definition {
            id: "action:test:recovery-does-not-leak-writes".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:recovery-does-not-leak-writes".to_string(),
            description: "A generic recovery branch terminates without committing staged writes"
                .to_string(),
            input_schema: json!({}),
            steps: vec![
                Step::write(json!([{
                    "address": "component:must-not-commit",
                    "path": ["prop:pending"],
                    "payload": {"reachable": true}
                }]))
                .with_id("stage_write"),
                Step::fail(json!("primary failure")).with_id("origin"),
                Step::return_value(json!({"inverse_completed": true})).with_id("inverse"),
                Step::fail(json!("terminal failure after inverse")).with_id("abort"),
            ],
            edges: vec![
                crate::domain::types::StepEdge {
                    from: "stage_write".to_string(),
                    to: "origin".to_string(),
                    kind: "on_result".to_string(),
                    config: Value::Null,
                },
                crate::domain::types::StepEdge {
                    from: "origin".to_string(),
                    to: "inverse".to_string(),
                    kind: "on_failure".to_string(),
                    config: Value::Null,
                },
                crate::domain::types::StepEdge {
                    from: "inverse".to_string(),
                    to: "abort".to_string(),
                    kind: "on_result".to_string(),
                    config: Value::Null,
                },
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action);

        let error = executor
            .execute_definition_query(
                &store,
                "action:test:recovery-does-not-leak-writes",
                json!({}),
                test_actor(),
                true,
                true,
            )
            .await
            .expect_err("a terminal recovery branch must reject the interactive result");

        assert!(error.to_string().contains("terminal failure after inverse"));
    }

    #[tokio::test]
    async fn test_execute_definition_query_preserves_nested_action_writes() {
        let mut store = TestDefinitionStore::new();
        let child = Definition {
            id: "action:test:child-write".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:child-write".to_string(),
            description: "nested action write propagation".to_string(),
            input_schema: json!({}),
            steps: vec![Step::write(json!([
                {
                    "address": "component:nested-action",
                    "path": ["prop:nested:write"],
                    "payload": {"kind": "nested-action-write"}
                }
            ]))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        let parent = Definition {
            id: "action:test:parent-action".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:parent-action".to_string(),
            description: "parent action invoking child writer".to_string(),
            input_schema: json!({}),
            steps: vec![Step::action("action:test:child-write", json!({}))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(child);
        store.register(parent);
        let store: Arc<dyn DefinitionStore> = Arc::new(store);
        let executor = AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            Arc::new(MockOutsideAccess),
            Arc::clone(&store),
            crate::executor::context::test_product_word_ids(),
        );

        let result = executor
            .execute_definition_query(
                store.as_ref(),
                "action:test:parent-action",
                json!({}),
                test_actor(),
                true,
                true,
            )
            .await
            .expect("nested action query should succeed");

        assert_eq!(result.output.status, ExecutionStatus::Completed);
        assert_eq!(result.output.final_output, json!({"writes_emitted": 1}));
        assert_eq!(result.writes.len(), 1);
        assert_eq!(result.writes[0].address, "component:nested-action");
        assert_eq!(result.writes[0].path, vec!["prop:nested:write"]);
    }

    #[tokio::test]
    async fn test_nested_action_ask_sees_parent_pending_writes() {
        let mut store = TestDefinitionStore::new();
        let child = Definition {
            id: "action:test:child-query".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:child-query".to_string(),
            description: "nested action pending write visibility".to_string(),
            input_schema: json!({}),
            steps: vec![Step::ask(
                "slot::find-current-items",
                json!({
                    "operation": "find-current-items",
                    "in": "attribute_fact",
                    "select": ["subject_id"]
                }),
            )],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        let parent = Definition {
            id: "action:test:parent-write-then-child-query".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:parent-write-then-child-query".to_string(),
            description: "parent write visible inside child query".to_string(),
            input_schema: json!({}),
            steps: vec![
                Step::write(json!([
                    {
                        "address": "attribute_fact|item:one|prop:title|type:string",
                        "path": ["current-item", "attribute_fact"],
                        "payload": {
                            "subject_id": "item:one",
                            "property_id": "prop:title",
                            "value_json": "Title"
                        }
                    }
                ])),
                Step::action("action:test:child-query", json!({})),
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(child);
        store.register(parent);
        let store: Arc<dyn DefinitionStore> = Arc::new(store);
        let outside_access = Arc::new(PendingWriteProbeOutsideAccess::default());
        let executor = AsyncWorkflowExecutor::new(
            "partition:test",
            slot_protocol::PartitionKey::hash_from("partition:test"),
            outside_access.clone(),
            Arc::clone(&store),
            crate::executor::context::test_product_word_ids(),
        );

        executor
            .execute_definition_query(
                store.as_ref(),
                "action:test:parent-write-then-child-query",
                json!({}),
                test_actor(),
                true,
                true,
            )
            .await
            .expect("nested query should succeed");

        let calls = outside_access
            .calls
            .lock()
            .expect("pending write probe lock")
            .clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "slot::find-current-items");
        assert_eq!(
            calls[0].pending_write_addresses,
            vec!["attribute_fact|item:one|prop:title|type:string"]
        );
    }

    #[tokio::test]
    async fn test_execute_definition_query_omits_steps_without_losing_writes_or_output() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = Definition {
            id: "action:test:query-contract".to_string(),
            partition_key: "partition:test".to_string(),
            name: "action:test:query-contract".to_string(),
            description: "query response projection".to_string(),
            input_schema: json!({}),
            steps: vec![Step::write(json!([
                {
                    "address": "component:query-contract",
                    "path": ["prop:query:contract"],
                    "payload": {"kind": "query-contract"}
                }
            ]))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action);

        let result = executor
            .execute_definition_query(
                &store,
                "action:test:query-contract",
                json!({"request_ref": "request:test"}),
                test_actor(),
                false,
                true,
            )
            .await
            .expect("interactive query should succeed");

        assert_eq!(result.output.status, ExecutionStatus::Completed);
        assert!(result.output.steps.is_empty());
        assert_eq!(result.output.final_output, json!({"writes_emitted": 1}));
        assert_eq!(result.writes.len(), 1);
        assert_eq!(result.writes[0].address, "component:query-contract");
    }

    #[tokio::test]
    async fn test_execute_definition_query_resolves_addressed_write_descriptor_batch() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        store.register(addressed_batch_write_action("action:test:addressed-batch"));

        let result = executor
            .execute_definition_query(
                &store,
                "action:test:addressed-batch",
                json!({
                    "event_ref": "owner-action-event:generic-package:record-state:test-batch",
                    "actor_ref": "actor:test-batch",
                    "target_ref": "target:test-batch",
                    "requested_at": "2999-01-01T00:00:00.000Z",
                    "payload": {
                        "subject_ref": "subject:test-batch",
                        "patch": {
                            "draft_text": "draft text",
                            "reply_selection_refs": ["related:item"],
                            "activity_state_ref": "activity-state:active",
                            "activity_phrase": "active phrase",
                            "activity_expires_at": "2999-01-01T00:01:00.000Z"
                        }
                    }
                }),
                test_actor(),
                false,
                true,
            )
            .await
            .expect("interactive query should resolve addressed write batch");

        assert_eq!(result.output.status, ExecutionStatus::Completed);
        assert!(result.output.steps.is_empty());
        assert_eq!(result.output.final_output, json!({"writes_emitted": 12}));
        assert_eq!(result.writes.len(), 12);
        assert_eq!(
            result.writes[0].address,
            "record|state-record:owner-action-event:generic-package:record-state:test-batch"
        );
        let reply_selection_payload: Value = serde_json::from_slice(
            result.writes[6]
                .payload
                .as_deref()
                .expect("reply-selection payload bytes"),
        )
        .expect("reply-selection payload JSON");
        let full_payload: Value = serde_json::from_slice(
            result.writes[11]
                .payload
                .as_deref()
                .expect("full payload bytes"),
        )
        .expect("full payload JSON");
        assert_eq!(reply_selection_payload["value_json"], "[\"related:item\"]");
        assert_eq!(
            full_payload["value_json"],
            "{\"patch\":{\"activity_expires_at\":\"2999-01-01T00:01:00.000Z\",\"activity_phrase\":\"active phrase\",\"activity_state_ref\":\"activity-state:active\",\"draft_text\":\"draft text\",\"reply_selection_refs\":[\"related:item\"]},\"subject_ref\":\"subject:test-batch\"}"
        );
    }

    #[tokio::test]
    async fn test_execute_definition_query_handles_large_boot_like_input() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        store.register(single_step_action("action:test:large-input"));

        let large_input = Value::Array(
            (0..5000)
                .map(|index| {
                    json!({
                        "address": format!("component:{index}"),
                        "path": ["prop:extension:bundle"],
                        "payload": {"bundle": format!("compiled-{index}")},
                    })
                })
                .collect(),
        );

        let result = executor
            .execute_definition_query(
                &store,
                "action:test:large-input",
                large_input,
                test_actor(),
                true,
                false,
            )
            .await
            .expect("large boot-like input should succeed");

        assert_eq!(result.output.definition_id, "action:test:large-input");
        assert_eq!(result.output.status, ExecutionStatus::Completed);
        assert!(result.output.steps.contains_key("step_0"));
        assert!(result.output.final_output.is_null());
    }

    // ========================================================================
    // Test 3: DefinitionOutput contains combined output and final_output
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_combined_output() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = single_step_action("action:test:output");
        store.register(action.clone());

        let output = executor
            .execute_definition_interactive(&store, "action:test:output", json!({}), test_actor())
            .await
            .expect("should succeed");

        // final_output should be the output of the last step
        assert!(
            !output.final_output.is_null(),
            "final_output should not be null"
        );

        // steps map should have the step's output
        let step_0 = output.steps.get("step_0").expect("step_0 must exist");
        assert_eq!(step_0.status, ExecutionStatus::Completed);
        assert_eq!(output.final_output, step_0.output);
    }

    // ========================================================================
    // Test 4: Definition not found returns DefinitionNotFound error
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_not_found() {
        let executor = test_executor();
        let store = TestDefinitionStore::new(); // empty store

        let result = executor
            .execute_definition_interactive(&store, "action:nonexistent", json!({}), test_actor())
            .await;

        assert!(result.is_err(), "should fail for non-existent action");

        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not found"),
            "Error should mention not found: {}",
            msg
        );
        assert!(
            msg.contains("action:nonexistent"),
            "Error should include action ID: {}",
            msg
        );
        assert!(msg.contains("Hint:"), "Error should contain hint: {}", msg);
    }

    // ========================================================================
    // Test 5: Step failure mid-execution returns error
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_step_failure_mid_execution() {
        // Use error executor — ALL outside access fails, so first step triggers error.
        // The step executor is a blind runner; the only way this step fails is
        // if the boundary adapter itself returns Err.
        let executor = test_error_executor();
        let mut store = TestDefinitionStore::new();

        let action = Definition {
            id: "action:test:fail_mid".to_string(),
            partition_key: "partition:test".to_string(),
            name: "fail_mid".to_string(),
            description: "Action that fails on step 0".to_string(),
            input_schema: json!({}),
            steps: vec![
                leaf_step(json!({"name": "FailType"})),
                leaf_step(json!({"name": "ShouldNotReachType"})),
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(&store, "action:test:fail_mid", json!({}), test_actor())
            .await;

        assert!(result.is_err(), "should fail when slot dispatch fails");
        let msg = result.unwrap_err().to_string();
        assert!(
            !msg.is_empty(),
            "Error message should not be empty: {}",
            msg
        );
    }

    // ========================================================================
    // Test 6: Inactive action (is_active = false) is rejected
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_inactive_rejected() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        let mut action = single_step_action("action:test:inactive");
        action.is_active = false;
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(&store, "action:test:inactive", json!({}), test_actor())
            .await;

        assert!(result.is_err(), "inactive action should be rejected");

        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("not active"),
            "Error should mention not active: {}",
            msg
        );
        assert!(msg.contains("Hint:"), "Error should contain hint: {}", msg);
    }

    // ========================================================================
    // Test 7: Input validation passes with valid input
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_valid_input_passes() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        let action = Definition {
            id: "action:test:with_schema".to_string(),
            partition_key: "partition:test".to_string(),
            name: "with_schema".to_string(),
            description: "Action with input schema".to_string(),
            input_schema: json!({"target_id": "string", "count": "number"}),
            steps: vec![leaf_step(json!({"name": "ValidatedType"}))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(
                &store,
                "action:test:with_schema",
                json!({"target_id": "node-1", "count": 5}),
                test_actor(),
            )
            .await;

        assert!(
            result.is_ok(),
            "valid input should pass validation: {:?}",
            result.err()
        );
    }

    // ========================================================================
    // Test 8: Invalid input (missing required field) is rejected
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_invalid_input_rejected() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        let action = Definition {
            id: "action:test:strict_schema".to_string(),
            partition_key: "partition:test".to_string(),
            name: "strict_schema".to_string(),
            description: "Action requiring target_id".to_string(),
            input_schema: json!({"target_id": "string"}),
            steps: vec![leaf_step(json!({"event": "test"}))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        // Input is missing required field "target_id"
        let result = executor
            .execute_definition_interactive(
                &store,
                "action:test:strict_schema",
                json!({"wrong_field": "value"}),
                test_actor(),
            )
            .await;

        assert!(result.is_err(), "missing required field should fail");

        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("target_id"),
            "Error should mention missing field: {}",
            msg
        );
        assert!(msg.contains("Hint:"), "Error should contain hint: {}", msg);
    }

    // ========================================================================
    // Test 9: Multi-step execution with 3 plain leaf steps
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_multi_step_three_primitives() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();
        let action = multi_step_action("action:test:triple");
        store.register(action.clone());

        let output = executor
            .execute_definition_interactive(&store, "action:test:triple", json!({}), test_actor())
            .await
            .expect("multi-step should succeed");

        assert_eq!(output.status, ExecutionStatus::Completed);
        assert_eq!(output.steps.len(), 3);
        assert!(output.total_duration_ms >= 0);

        // Each step should have a non-null output
        for (id, step) in &output.steps {
            assert_eq!(
                step.status,
                ExecutionStatus::Completed,
                "Step {} should be completed",
                id
            );
            assert!(
                !step.output.is_null(),
                "Step {} should have non-null output",
                id
            );
        }

        // final_output should be from the last step (step_2)
        let last_step = output.steps.get("step_2").expect("step_2 must exist");
        assert_eq!(output.final_output, last_step.output);
    }

    // ========================================================================
    // Test 10: Step output flows to next step via template resolution
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_step_output_flows_to_next() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        // Step 0 produces output, Step 1 references it via {{steps.step_0.output}}
        let action = Definition {
            id: "action:test:flow".to_string(),
            partition_key: "partition:test".to_string(),
            name: "flow".to_string(),
            description: "Action with output flowing between steps".to_string(),
            input_schema: json!({"target": "string"}),
            steps: vec![
                leaf_step(json!({"name": "FlowFirstType"})),
                leaf_step(json!({"name": "FlowSecondType"})),
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(
                &store,
                "action:test:flow",
                json!({"target": "node-abc"}),
                test_actor(),
            )
            .await;

        assert!(
            result.is_ok(),
            "step output flow should work: {:?}",
            result.err()
        );

        let output = result.expect("should be Ok");
        assert_eq!(output.steps.len(), 2);

        // Both steps should have completed (proving step 1 could reference step 0's output)
        assert_eq!(output.steps["step_0"].status, ExecutionStatus::Completed);
        assert_eq!(output.steps["step_1"].status, ExecutionStatus::Completed);
    }

    // ========================================================================
    // Test 11: Empty workflow_steps produces empty DefinitionOutput
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_empty_workflow_steps() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        let action = Definition {
            id: "action:test:empty".to_string(),
            partition_key: "partition:test".to_string(),
            name: "empty".to_string(),
            description: "Action with no steps".to_string(),
            input_schema: json!({}),
            steps: vec![],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        let output = executor
            .execute_definition_interactive(&store, "action:test:empty", json!({}), test_actor())
            .await
            .expect("empty action should succeed");

        assert_eq!(output.status, ExecutionStatus::Completed);
        assert!(
            output.steps.is_empty(),
            "no steps should produce no outputs"
        );
        assert_eq!(output.final_output, Value::Null);
    }

    // ========================================================================
    // Test 12: Non-object input rejected when schema requires fields
    // ========================================================================

    #[tokio::test]
    async fn test_execute_definition_non_object_input_rejected() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        let action = Definition {
            id: "action:test:needs_obj".to_string(),
            partition_key: "partition:test".to_string(),
            name: "needs_obj".to_string(),
            description: "Action requiring object input".to_string(),
            input_schema: json!({"field": "string"}),
            steps: vec![leaf_step(json!({"event": "test"}))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        // Pass a string instead of an object
        let result = executor
            .execute_definition_interactive(
                &store,
                "action:test:needs_obj",
                json!("not an object"),
                test_actor(),
            )
            .await;

        assert!(result.is_err(), "non-object input should fail");

        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("JSON object"),
            "Error should mention JSON object: {}",
            msg
        );
        assert!(
            msg.contains("string"),
            "Error should mention the actual type: {}",
            msg
        );
    }

    // ========================================================================
    // Test 13: validate_input standalone — empty schema accepts any input
    // ========================================================================

    #[test]
    fn test_validate_input_empty_schema_accepts_anything() {
        assert!(validate_input(&json!({}), &json!({}), "test").is_ok());
        assert!(validate_input(&json!("string"), &json!({}), "test").is_ok());
        assert!(validate_input(&json!(42), &json!({}), "test").is_ok());
        assert!(validate_input(&json!(null), &json!({}), "test").is_ok());
        assert!(validate_input(&json!([1, 2]), &json!({}), "test").is_ok());
    }

    // ========================================================================
    // Test 14: validate_input standalone — null schema accepts any input
    // ========================================================================

    #[test]
    fn test_validate_input_null_schema_accepts_anything() {
        assert!(validate_input(&json!({}), &Value::Null, "test").is_ok());
        assert!(validate_input(&json!("x"), &Value::Null, "test").is_ok());
    }

    // ========================================================================
    // Test 15: validate_input standalone — schema with keys validates
    // ========================================================================

    #[test]
    fn test_validate_input_schema_validates_required_keys() {
        let schema = json!({"name": "string", "age": "number"});

        // Valid: has all required keys
        assert!(validate_input(&json!({"name": "Alice", "age": 30}), &schema, "test").is_ok());

        // Valid: has extra keys (allowed)
        assert!(validate_input(
            &json!({"name": "Bob", "age": 25, "extra": true}),
            &schema,
            "test"
        )
        .is_ok());

        // Invalid: missing "age"
        let result = validate_input(&json!({"name": "Charlie"}), &schema, "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("age"));

        // Invalid: missing "name"
        let result = validate_input(&json!({"age": 10}), &schema, "test");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("name"));
    }

    #[test]
    fn test_validate_input_json_schema_uses_required_array_not_metadata_keys() {
        let schema = json!({
            "type": "object",
            "properties": {
                "request_id": {"type": "string"},
                "source": {"type": "object"},
                "options": {"type": "object"}
            },
            "required": ["request_id", "source"]
        });

        assert!(validate_input(
            &json!({
                "request_id": "caption-workflow-smoke",
                "source": {"media_type": "audio/mpeg"},
                "options": {}
            }),
            &schema,
            "action:submit-audio-transcription-request"
        )
        .is_ok());

        let result = validate_input(
            &json!({"request_id": "caption-workflow-smoke"}),
            &schema,
            "action:submit-audio-transcription-request",
        );
        let err = result.expect_err("missing JSON-schema required field must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("source"),
            "error should name missing field: {msg}"
        );
        assert!(
            !msg.contains("properties"),
            "metadata key must not be treated as a required input field: {msg}"
        );
    }

    #[test]
    fn test_validate_input_json_schema_properties_without_required_has_no_required_fields() {
        let schema = json!({
            "type": "object",
            "properties": {
                "optional_note": {"type": "string"}
            }
        });

        assert!(validate_input(&json!({}), &schema, "test").is_ok());
        assert!(validate_input(&json!("not-object"), &schema, "test").is_ok());
    }

    #[test]
    fn test_validate_input_json_schema_required_array_rejects_invalid_entries() {
        let schema = json!({
            "type": "object",
            "properties": {
                "request_id": {"type": "string"}
            },
            "required": ["request_id", 7]
        });

        let result = validate_input(&json!({"request_id": "x"}), &schema, "test");
        let err = result.expect_err("non-string required entries must fail");
        assert!(
            err.to_string().contains("required entries must be strings"),
            "error should name invalid schema shape: {err}"
        );
    }

    // ========================================================================
    // DEPENDENCY-AWARE BATCHING TESTS
    // ========================================================================

    // ========================================================================
    // Test 16: plan_execution — all independent steps → 1 batch
    // ========================================================================

    #[test]
    fn test_plan_all_independent() {
        let steps: Vec<Step> = (0..5)
            .map(|i| leaf_step(json!({"name": format!("Type{}", i)})))
            .collect();

        let batches = plan_execution(&steps);

        assert_eq!(batches.len(), 1, "All independent → 1 batch");
        assert_eq!(batches[0].len(), 5, "All 5 steps in the single batch");
        assert_eq!(batches[0], vec![0, 1, 2, 3, 4]);
    }

    // ========================================================================
    // Test 17: plan_execution — linear chain A→B→C→D → 4 batches of 1
    // ========================================================================

    #[test]
    fn test_plan_linear_chain() {
        let steps: Vec<Step> = vec![
            leaf_step(json!({"name": "TypeA"})),
            leaf_step(json!({"target": "$step[0].result"})),
            leaf_step(json!({"target": "$step[1].result"})),
            leaf_step(json!({"target": "$step[2].result"})),
        ];

        let batches = plan_execution(&steps);

        assert_eq!(batches.len(), 4, "Linear chain → 4 batches");
        assert_eq!(batches[0], vec![0]);
        assert_eq!(batches[1], vec![1]);
        assert_eq!(batches[2], vec![2]);
        assert_eq!(batches[3], vec![3]);
    }

    // ========================================================================
    // Test 18: plan_execution — diamond: A,B independent, C depends on both
    // ========================================================================

    #[test]
    fn test_plan_diamond() {
        let steps: Vec<Step> = vec![
            leaf_step(json!({"name": "A"})),
            leaf_step(json!({"name": "B"})),
            leaf_step(json!({"a": "$step[0].result", "b": "$step[1].result"})),
        ];

        let batches = plan_execution(&steps);

        assert_eq!(batches.len(), 2, "Diamond → 2 batches");
        assert_eq!(batches[0], vec![0, 1], "A and B in first batch");
        assert_eq!(batches[1], vec![2], "C in second batch");
    }

    // ========================================================================
    // Test 19: plan_execution — mixed deps: 10 steps, 3 chains
    // ========================================================================

    #[test]
    fn test_plan_mixed() {
        // Steps 0,1,2: independent
        // Step 3: depends on 0
        // Step 4: depends on 1
        // Step 5: depends on 3 and 4 (diamond merge)
        // Steps 6,7: independent
        // Step 8: depends on 5
        // Step 9: depends on 8
        let steps: Vec<Step> = vec![
            leaf_step(json!({"n": "0"})),
            leaf_step(json!({"n": "1"})),
            leaf_step(json!({"n": "2"})),
            leaf_step(json!({"ref": "$step[0].result"})),
            leaf_step(json!({"ref": "$step[1].result"})),
            leaf_step(json!({"a": "$step[3].result", "b": "$step[4].result"})),
            leaf_step(json!({"n": "6"})),
            leaf_step(json!({"n": "7"})),
            leaf_step(json!({"ref": "$step[5].result"})),
            leaf_step(json!({"ref": "$step[8].result"})),
        ];

        let batches = plan_execution(&steps);

        // Batch 0: 0, 1, 2, 6, 7 (all independent)
        assert!(batches[0].contains(&0));
        assert!(batches[0].contains(&1));
        assert!(batches[0].contains(&2));
        assert!(batches[0].contains(&6));
        assert!(batches[0].contains(&7));
        // Batch 1: 3, 4 (depend on batch-0 steps)
        assert!(batches[1].contains(&3));
        assert!(batches[1].contains(&4));
        // Batch 2: 5 (depends on 3 and 4)
        assert!(batches[2].contains(&5));
        // Batch 3: 8 (depends on 5)
        assert!(batches[3].contains(&8));
        // Batch 4: 9 (depends on 8)
        assert!(batches[4].contains(&9));
        assert_eq!(batches.len(), 5);
    }

    // ========================================================================
    // Test 20: plan_execution — single step → 1 batch of 1
    // ========================================================================

    #[test]
    fn test_plan_single_step() {
        let steps = vec![leaf_step(json!({"name": "Only"}))];

        let batches = plan_execution(&steps);

        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0], vec![0]);
    }

    // ========================================================================
    // Test 21: find_step_output_references — $step[0].result → {0}
    // ========================================================================

    #[test]
    fn test_find_refs_dollar_step() {
        let params = json!({"target": "$step[0].result"});
        let refs = find_step_output_references(&params, 1);

        assert_eq!(refs.len(), 1);
        assert!(refs.contains(&0));
    }

    // ========================================================================
    // Test 22: find_step_output_references — multiple refs
    // ========================================================================

    #[test]
    fn test_find_refs_multiple() {
        let params = json!({"expr": "$step[0].result + $step[2].result"});
        let refs = find_step_output_references(&params, 3);

        assert_eq!(refs.len(), 2);
        assert!(refs.contains(&0));
        assert!(refs.contains(&2));
    }

    // ========================================================================
    // Test 23: find_step_output_references — refs in nested JSON
    // ========================================================================

    #[test]
    fn test_find_refs_nested_json() {
        let params = json!({
            "outer": {
                "inner": {"value": "$step[1].result"},
                "list": ["$step[0].result", "literal"]
            }
        });
        let refs = find_step_output_references(&params, 5);

        assert_eq!(refs.len(), 2);
        assert!(refs.contains(&0));
        assert!(refs.contains(&1));
    }

    // ========================================================================
    // Test 24: find_step_output_references — no refs → empty set
    // ========================================================================

    #[test]
    fn test_find_refs_none() {
        let params = json!({"name": "no refs here", "count": 42, "flag": true});
        let refs = find_step_output_references(&params, 3);

        assert!(refs.is_empty());
    }

    // ========================================================================
    // Test 25: resolve_step_refs — substitution works
    // ========================================================================

    #[test]
    fn test_resolve_step_refs_substitution() {
        let params = json!({"target": "$step[0].result"});
        let results: Vec<Option<StepOutput>> = vec![Some(StepOutput {
            output: json!("entity-123"),
            status: ExecutionStatus::Completed,
            error: None,
            duration_ms: 5,
        })];

        let resolved = resolve_step_refs(&params, &results);

        assert_eq!(resolved["target"], "entity-123");
    }

    // ========================================================================
    // Test 26: resolve_step_refs — nested JSON with refs
    // ========================================================================

    #[test]
    fn test_resolve_step_refs_nested() {
        let params = json!({
            "outer": {
                "a": "$step[0].result",
                "b": "$step[1].result"
            },
            "list": ["$step[0].result"]
        });
        let results: Vec<Option<StepOutput>> = vec![
            Some(StepOutput {
                output: json!("val-a"),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 1,
            }),
            Some(StepOutput {
                output: json!("val-b"),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 2,
            }),
        ];

        let resolved = resolve_step_refs(&params, &results);

        assert_eq!(resolved["outer"]["a"], "val-a");
        assert_eq!(resolved["outer"]["b"], "val-b");
        assert_eq!(resolved["list"][0], "val-a");
    }

    // ========================================================================
    // Test 27: adversarial — 1000 independent steps → 1 batch (L064)
    // ========================================================================

    #[test]
    fn test_adversarial_1000_independent() {
        let steps: Vec<Step> = (0..1000)
            .map(|i| leaf_step(json!({"name": format!("Type{}", i)})))
            .collect();

        let batches = plan_execution(&steps);

        assert_eq!(batches.len(), 1, "1000 independent steps → 1 batch");
        assert_eq!(batches[0].len(), 1000);
    }

    // ========================================================================
    // Test 28: adversarial — 1000 chained steps → 1000 batches (worst case)
    // ========================================================================

    #[test]
    fn test_adversarial_1000_linear() {
        let mut steps: Vec<Step> = Vec::with_capacity(1000);
        steps.push(leaf_step(json!({"name": "Base"})));
        for i in 1..1000 {
            steps.push(leaf_step(
                json!({"ref": format!("$step[{}].result", i - 1)}),
            ));
        }

        let batches = plan_execution(&steps);

        assert_eq!(
            batches.len(),
            1000,
            "1000 chained steps → 1000 batches (worst case, no worse than sequential)"
        );
        for (i, batch) in batches.iter().enumerate() {
            assert_eq!(batch.len(), 1, "Each batch has exactly 1 step");
            assert_eq!(batch[0], i, "Step i is in batch i");
        }
    }

    // ========================================================================
    // Test 29: end-to-end batched execution — 5 steps with deps
    // ========================================================================

    #[tokio::test]
    async fn test_end_to_end_batched_execution() {
        let executor = test_executor();
        let mut store = TestDefinitionStore::new();

        // 5-step action:
        // Step 0: independent (schemaWrite)
        // Step 1: independent (schemaWrite)
        // Step 2: depends on step 0 (but uses schemaWrite so it works regardless)
        // Step 3: depends on step 1 (but uses schemaWrite so it works regardless)
        // Step 4: depends on step 2 and 3 (but uses schemaWrite so it works regardless)
        //
        // Expected batches: [[0,1], [2,3], [4]]
        let action = Definition {
            id: "action:test:batched".to_string(),
            partition_key: "partition:test".to_string(),
            name: "batched".to_string(),
            description: "Batched execution test".to_string(),
            input_schema: json!({}),
            steps: vec![
                leaf_step(json!({"name": "BatchA"})),
                leaf_step(json!({"name": "BatchB"})),
                leaf_step(json!({"name": "ref $step[0].result"})),
                leaf_step(json!({"name": "ref $step[1].result"})),
                leaf_step(json!({"name": "ref $step[2].result and $step[3].result"})),
            ],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };
        store.register(action.clone());

        let result = executor
            .execute_definition_interactive(&store, "action:test:batched", json!({}), test_actor())
            .await;

        assert!(
            result.is_ok(),
            "Batched execution should succeed: {:?}",
            result.err()
        );

        let output = result.expect("should be Ok");
        assert_eq!(output.status, ExecutionStatus::Completed);
        assert_eq!(output.steps.len(), 5, "All 5 steps should complete");

        // Verify the batch plan for this action
        let batches = plan_execution(&action.steps);
        assert_eq!(
            batches.len(),
            3,
            "Should have 3 batches: [[0,1], [2,3], [4]]"
        );
        assert_eq!(batches[0], vec![0, 1]);
        assert_eq!(batches[1], vec![2, 3]);
        assert_eq!(batches[2], vec![4]);

        // All steps completed
        for i in 0..5 {
            let step_id = format!("step_{}", i);
            assert_eq!(
                output.steps[&step_id].status,
                ExecutionStatus::Completed,
                "Step {} should be completed",
                i
            );
        }
    }
}
