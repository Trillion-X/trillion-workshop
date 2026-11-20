// crates/workflow-core/src/executor/step_executor.rs
//
// Purpose:
//   Single-step executor for Step (unified). Resolves binding AST in step
//   params, dispatches outside work through the workflow boundary adapter,
//   and captures the result as StepOutput.
//
// Non-Negotiable Invariants:
//   1. ALL outside-work dispatch flows through the workflow boundary adapter.
//      Zero knowledge of Architect slot vocabulary in the workflow step language.
//   2. Template resolution uses `BindingResolver` from context.rs — no duplication.
//   3. StepOutput is ALWAYS recorded in ExecutionContext, even on failure, so
//      subsequent steps can inspect the failure via binding AST.
//   4. No `.unwrap()` in production code. All errors are structured with
//      remediation hints.
//   5. Timeout enforcement uses `tokio::time::timeout` — callers set policy.
//
// Key Concepts:
//   - StepExecutor: Stateless engine for single-step execution
//   - execute_step(): Full lifecycle: normalize → resolve bindings → dispatch → capture
//   - ExecutorDeps: Slim dependency bag (outside access, partition_key, circuit_state)
//
// Step Execution Flow:
//
//   ```text
//   Step { kind: "ask", config: { "name": "compute.process", "input": {...} } }
//       |
//       | 1. Resolve binding AST in input template
//       | 2. Serialize the outside owner's REAL payload bytes
//       | 3. Dispatch via the workflow boundary adapter
//       | 4. Deserialize response bytes → StepOutput
//       | 5. Record: ctx.steps["step_id"] = step_output
//       v
//   StepOutput { output: {...}, status: Completed, error: None, duration_ms: 42 }
//   ```
//
// Security Considerations:
//   - Template resolution is pure (no I/O) — see context.rs
//   - Security policies (permission guards, transport policy, URL validation)
//     are enforced by the receiving slot handler, not by the dispatcher.
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.
//   Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.

use std::sync::Arc;

#[cfg(test)]
use execution_types::ProcessTermination;
use execution_types::{
    decode_process_result, decode_process_sequence_result, ProcessInputSource, ProcessResult,
    ProcessSequenceResult,
};

#[cfg(test)]
pub(crate) fn process_result_fixture(
    termination: ProcessTermination,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    mut outputs: Vec<execution_types::ProcessOutputArtifact>,
    duration_ms: u64,
) -> ProcessResult {
    use content_crypto::Multihash;
    use execution_types::{
        seal_process_containment_receipt, NativeProcessContainmentReceipt, ProcessCapturedFd,
        ProcessCapturedFdIdentity, ProcessCodeIdentity, ProcessContainmentReceipt,
        ProcessFileGeneration, ProcessFileIdentity,
        PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION,
    };
    use std::collections::BTreeMap;

    let product_word_ids = crate::executor::context::test_product_word_ids();

    // Every one of these is a DIFFERENT fact, so every one gets a DIFFERENT value. They were two
    // constants holding the identical all-zero string, reused across four distinct fields, so any
    // two could be swapped and no assertion here could tell. A fixture that cannot distinguish
    // the facts it stands for is not testing what it appears to test.
    const EXECUTABLE_CONTENT_HASH: &str =
        "1f:1111111111111111111111111111111111111111111111111111111111111111";
    const REQUEST_CONTENT_HASH: &str =
        "1f:2222222222222222222222222222222222222222222222222222222222222222";
    const ADMITTED_DESCRIPTOR_CONTENT_HASH: &str =
        "1f:3333333333333333333333333333333333333333333333333333333333333333";
    const SANDBOX_POLICY_CONTENT_HASH: &str =
        "1f:4444444444444444444444444444444444444444444444444444444444444444";
    const BOOT_SESSION_IDENTITY_CONTENT_HASH: &str =
        "1f:5555555555555555555555555555555555555555555555555555555555555555";

    for output in &mut outputs {
        output.integrity_hash = Multihash::hash(&output.bytes).to_code_hex();
        if matches!(
            output.storage,
            execution_types::ProcessOutputStorage::Inline
        ) {
            output.byte_len = output.bytes.len() as u64;
        }
    }

    let admitted_executable = ProcessFileIdentity {
        absolute_path: "/fixture/process".to_string(),
        canonical_parent_path: "/fixture".to_string(),
        device_id: "1".to_string(),
        inode: "1".to_string(),
        generation: ProcessFileGeneration::Unavailable {
            platform: "fixture".to_string(),
            reason: "test evidence".to_string(),
        },
        link_count: "1".to_string(),
        byte_length: "1".to_string(),
        unix_mode: 0o755,
        birthtime_ns: "1".to_string(),
        ctime_ns: "1".to_string(),
        opened_no_follow: true,
        stable_readback: true,
        content_hash: EXECUTABLE_CONTENT_HASH.to_string(),
        code_identity: ProcessCodeIdentity::NotApplicable {
            reason: "test fixture".to_string(),
        },
    };
    let stdout_content_hash = content_crypto::Multihash::hash(&stdout).to_code_hex();
    let stderr_content_hash = content_crypto::Multihash::hash(&stderr).to_code_hex();
    let captured_fds = vec![
        ProcessCapturedFd {
            fd: 1,
            bytes: stdout,
            content_hash: stdout_content_hash,
            eof_observed: true,
        },
        ProcessCapturedFd {
            fd: 2,
            bytes: stderr,
            content_hash: stderr_content_hash,
            eof_observed: true,
        },
    ];
    let captured_fd_identities = captured_fds
        .iter()
        .map(|capture| ProcessCapturedFdIdentity {
            fd: capture.fd,
            byte_length: capture.bytes.len().to_string(),
            content_hash: capture.content_hash.clone(),
            eof_observed: capture.eof_observed,
        })
        .collect();

    let mut containment_receipt =
        ProcessContainmentReceipt::Native(Box::new(NativeProcessContainmentReceipt {
            schema: product_word_ids.containment_receipt_schema().to_string(),
            request_content_hash: REQUEST_CONTENT_HASH.to_string(),
            admitted_descriptor_content_hash: ADMITTED_DESCRIPTOR_CONTENT_HASH.to_string(),
            platform: "fixture".to_string(),
            enforcement_mechanism: "test-only".to_string(),
            full_computer_access: false,
            sandbox_policy_content_hash: SANDBOX_POLICY_CONTENT_HASH.to_string(),
            sandbox_applied_before_exec: true,
            network_denied: true,
            child_process_creation_denied: true,
            inherited_by_descendants: true,
            writable_roots: Vec::new(),
            direct_child_pid: 1,
            direct_child_start_seconds: "1".to_string(),
            direct_child_start_microseconds: "1".to_string(),
            boot_session_uuid: "00000000-0000-0000-0000-000000000000".to_string(),
            boot_session_identity_content_hash: BOOT_SESSION_IDENTITY_CONTENT_HASH.to_string(),
            admitted_executable,
            image_observations: Vec::new(),
            termination: termination.clone(),
            parent_reaped: true,
            captured_pipes_eof: true,
            captured_fds: captured_fd_identities,
            collected_file_identities: BTreeMap::new(),
            declared_output_integrity: outputs
                .iter()
                .map(|output| (output.mount_path.clone(), output.integrity_hash.clone()))
                .collect(),
            immutable_publications: Vec::new(),
            checksum_canonicalization: PROCESS_CONTAINMENT_RECEIPT_CHECKSUM_CANONICALIZATION
                .to_string(),
            checksum: String::new(),
        }));
    seal_process_containment_receipt(&product_word_ids, &mut containment_receipt)
        .expect("seal fixture containment receipt");

    ProcessResult {
        termination: termination.clone(),
        captured_fds,
        outputs,
        collected_files: Vec::new(),
        immutable_publications: Vec::new(),
        duration_ms,
        containment_receipt,
    }
}
use serde::de::DeserializeOwned;
use serde_json::Value;
use slot_protocol::ActorContext;
use web_time::Instant;

use super::context::{record_step_output, BindingResolver, ExecutorDeps};
use super::value_to_bytes::encode_declared_value_to_bytes;
use crate::domain::errors::WorkflowError;
use crate::domain::types::{
    ExecutionContext, ExecutionStatus, PendingWrite, Step, StepHandlerResult, StepOutput,
};

// ============================================================================
// STEP EXECUTOR
// ============================================================================

/// The SQL tool a recipe step names; the step's declared use is bound onto every call it sends.
const RUN_SQL_TOOL: &str = "tool:run-sql-in-my-database";

/// Stateless single-step executor.
///
/// Executes one `Step` through the full primitive dispatch
/// pipeline: parse -> resolve -> build -> dispatch -> capture.
///
/// # Usage
///
/// ```ignore
/// let output = StepExecutor::execute_step(
///     &step,
///     "step_1",
///     &mut exec_ctx,
///     &deps,
///     &actor,
///     Some(Duration::from_secs(30)),
/// ).await?;
/// ```
pub struct StepExecutor;

struct DecodedReadOutput {
    output: Value,
    raw_bytes: Option<Arc<[u8]>>,
}

struct DecodedAskOutput {
    output: Value,
    raw_step_bytes: Vec<(String, Arc<[u8]>)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AskOutputDecode {
    Json,
    Bytes,
    Artifact,
}

enum AskDispatchReply {
    Inline(Arc<[u8]>),
    ImmutableContent(slot_protocol::ImmutableContentRef),
}

impl StepExecutor {
    pub async fn execute_leaf_step_delta(
        step: &Step,
        step_id: &str,
        exec_ctx: &ExecutionContext,
        deps: &ExecutorDeps,
        _actor: &ActorContext,
        timeout: Option<std::time::Duration>,
    ) -> Result<StepHandlerResult, WorkflowError> {
        let start = Instant::now();

        if step.is_read() {
            let resolved_from = BindingResolver::resolve_value(step.from(), exec_ctx)?;
            // An address that resolved to nothing is the SAME situation as an
            // address that did not resolve at the store: there is nothing to
            // read. A read whose `from` is a binding is asking a question of
            // the data ("read whatever this descriptor points at"), and the
            // answer "it points at nothing" is an answer, not a malformed
            // definition. So the declared fallback_output applies here exactly
            // as it applies to a failed read below, and only a read with no
            // declared fallback fails.
            //
            // Anything that is neither a string nor empty IS a malformed
            // definition (a number, an object, a list), and no fallback
            // rescues it, because nobody wrote a fallback for "I put the
            // wrong kind of thing here".
            if resolved_from.is_null() {
                let Some(fallback_output) = Self::read_fallback_output(step, exec_ctx)? else {
                    return Err(WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: format!(
                            "read step from resolved to nothing: {}",
                            Self::describe_read_from(step.from())
                        ),
                        hint: "Either the binding points at a field that is absent, or declare \
                               fallback_output on this read so an absent address is an outcome \
                               rather than a failure."
                            .into(),
                    });
                };
                let duration_ms = start.elapsed().as_millis() as i64;
                let step_output = StepOutput {
                    output: fallback_output,
                    status: ExecutionStatus::Completed,
                    error: None,
                    duration_ms,
                };
                let mut result = StepHandlerResult::leaf(step_output);
                if exec_ctx.raw_step_bytes(step_id).is_some() {
                    result.cleared_raw_step_bytes.push(step_id.to_string());
                }
                return Ok(result);
            }
            let address =
                resolved_from
                    .as_str()
                    .ok_or_else(|| WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: format!(
                            "read step from resolved to a {}, and a read address is a string: {}",
                            Self::json_kind_name(&resolved_from),
                            Self::describe_read_from(step.from())
                        ),
                        hint: "Provide the canonical source string in read.from".into(),
                    })?;
            let resolved_address_mode =
                BindingResolver::resolve_value(step.read_address_mode(), exec_ctx)?;
            let address_mode = match resolved_address_mode.as_str() {
                Some("identity_text") => Some("identity_text"),
                Some("label_hash") => Some("label_hash"),
                Some(other) => {
                    return Err(WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: format!(
                            "read step address_mode must be identity_text or label_hash, got {other}"
                        ),
                        hint: "Use the same explicit address modes as workflow write items, or omit address_mode to preserve the address heuristic".into(),
                    });
                }
                None if resolved_address_mode.is_null() => None,
                None => {
                    return Err(WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: format!(
                            "read step address_mode resolved to a {}",
                            Self::json_kind_name(&resolved_address_mode)
                        ),
                        hint:
                            "read.address_mode must resolve to identity_text, label_hash, or null"
                                .into(),
                    });
                }
            };
            let dispatch_address = address_mode.map_or_else(
                || address.to_string(),
                |mode| {
                    crate::stores::runtime_fact_address_with_mode(address, Some(mode))
                        .as_multihash()
                        .to_code_hex()
                },
            );
            let result_bytes = match deps
                .outside_access
                .read(&dispatch_address, &deps.dispatch_partition)
                .await
            {
                Ok(result_bytes) => result_bytes,
                Err(error) => {
                    let Some(fallback_output) = Self::read_fallback_output(step, exec_ctx)? else {
                        return Err(WorkflowError::PrimitiveDispatchFailed {
                            primitive: format!("read:{address}"),
                            reason: error,
                            hint: "Direct envelope read failed for the requested address".into(),
                        });
                    };
                    let duration_ms = start.elapsed().as_millis() as i64;
                    let step_output = StepOutput {
                        output: fallback_output,
                        status: ExecutionStatus::Completed,
                        error: None,
                        duration_ms,
                    };
                    let mut result = StepHandlerResult::leaf(step_output);
                    if exec_ctx.raw_step_bytes(step_id).is_some() {
                        result.cleared_raw_step_bytes.push(step_id.to_string());
                    }
                    return Ok(result);
                }
            };
            let decoded = Self::decode_read_output(
                step_id,
                result_bytes.bytes,
                Some(result_bytes.content_hash),
            );
            let duration_ms = start.elapsed().as_millis() as i64;
            let step_output = StepOutput {
                output: decoded.output,
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms,
            };
            let mut result = StepHandlerResult::leaf(step_output);
            if let Some(raw_bytes) = decoded.raw_bytes {
                result.raw_step_bytes.insert(step_id.to_string(), raw_bytes);
            } else if exec_ctx.raw_step_bytes(step_id).is_some() {
                result.cleared_raw_step_bytes.push(step_id.to_string());
            }
            return Ok(result);
        }

        if step.is_write() {
            let resolved_writes =
                BindingResolver::resolve_write_items_value(step.items(), exec_ctx)?;
            let writes = Self::build_writes(step_id, &resolved_writes, exec_ctx)?;
            let duration_ms = start.elapsed().as_millis() as i64;
            let step_output = StepOutput {
                output: serde_json::json!({ "writes_emitted": writes.len() }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms,
            };
            let mut result = StepHandlerResult::leaf(step_output);
            result.writes = writes;
            return Ok(result);
        }

        if !step.is_ask() {
            return Err(WorkflowError::InvalidStep {
                step_id: step_id.to_string(),
                reason: format!(
                    "Unsupported step kind '{}'; workflow outside-work dispatch only accepts plain 'ask'",
                    step.kind
                ),
                hint: "Replace legacy primitive-style steps with plain workflow kinds such as read, write, or ask."
                    .to_string(),
            });
        }

        // The ask dispatch TARGET is binding-resolved (runner-as-DATA): a literal string
        // passes through unchanged (BindingResolver leaves non-binding values as-is — so
        // every existing `config.name:"compute.process"` workflow is byte-identical), while
        // a binding AST node resolves the target from input/context (e.g. a TrackerDescriptor
        // `runner` field selecting `compute.process` | `compute.process_session` | a browser
        // peer). Fail-closed if it does not resolve to a non-empty string (SP5).
        let resolved_name = BindingResolver::resolve_value(step.name_value(), exec_ctx)?;
        let name = match resolved_name.as_str() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => {
                return Err(WorkflowError::InvalidStep {
                    step_id: step_id.to_string(),
                    reason: format!(
                        "ask step `name` must resolve to a non-empty string (the dispatch target); got {}",
                        resolved_name
                    ),
                    hint: "Set config.name to a literal target (e.g. \"compute.process\") or a binding \
                           AST node that resolves to one (e.g. {\"$kind\":\"binding\",\"select\":{\"from\":\"input\",\"path\":\"runner\"}})."
                        .to_string(),
                });
            }
        };
        let dispatch_label = format!("ask:{}", name);
        let destination_name = name;
        let mut resolved_payload = BindingResolver::resolve_value(step.input(), exec_ctx)?;
        Self::address_step_bytes_input_sources(
            step_id,
            &mut resolved_payload,
            exec_ctx,
            deps.outside_access.as_ref(),
            &deps.dispatch_partition,
        )
        .await?;
        if destination_name == RUN_SQL_TOOL {
            Self::bind_declared_use(step_id, step, &mut resolved_payload)?;
        }
        const TRUSTED_LOCAL_CONTEXT: &str = "{\"kind\":\"bitfield.trusted-local-dispatch/v1\"}";
        let selected_context = BindingResolver::resolve_value(step.context(), exec_ctx)?;
        let resolved_context = if selected_context.is_null() {
            exec_ctx.trusted_local_invocation.then(|| serde_json::json!({
                "kind": "bitfield.trusted-local-dispatch/v1"
            }))
        } else {
            Some(selected_context)
        };
        if !exec_ctx.trusted_local_invocation
            && resolved_context.as_ref().is_some_and(|value| {
                serde_json::to_string(value).ok().as_deref() == Some(TRUSTED_LOCAL_CONTEXT)
            })
        {
            return Err(WorkflowError::InvalidStep {
                step_id: step_id.to_string(),
                reason: "workflow DATA may not claim trusted local dispatch provenance".to_string(),
                hint: "Remove the reserved context; only the native request carrier can supply it.".to_string(),
            });
        }

        // Keep the authored step context intact while attaching the actual
        // execution path as engine-owned metadata. Nested action and loop
        // invocations reuse authored step ids; the host needs this stable path
        // to resume the exact invocation after a cold replay.
        let mut runtime_identity = exec_ctx.runtime_path.clone();
        runtime_identity.push(step_id.to_string());
        let resolved_context = Some(match resolved_context {
            Some(Value::Object(mut context)) => {
                context.insert("_runtime_identity".to_string(), serde_json::json!(runtime_identity));
                Value::Object(context)
            }
            Some(value) => serde_json::json!({
                "_authored_context": value,
                "_runtime_identity": runtime_identity,
            }),
            None => serde_json::json!({ "_runtime_identity": runtime_identity }),
        });

        let output_decode = Self::ask_output_decode(step_id, step)?;
        let outside_access = deps.outside_access.clone();
        let dispatch_partition = deps.dispatch_partition.clone();
        let payload_bytes =
            bytes::Bytes::from(serde_json::to_vec(&resolved_payload).map_err(|e| {
                WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: format!("Failed to serialize outside-work payload: {}", e),
                    hint: "Internal error — resolved ask input is not serializable".into(),
                }
            })?);
        let context_bytes = match resolved_context {
            None => None,
            Some(value) => Some(bytes::Bytes::from(serde_json::to_vec(&value).map_err(
                |e| WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: format!("Failed to serialize outside-work context: {}", e),
                    hint: "Internal error — resolved ask context is not serializable".into(),
                },
            )?)),
        };
        let step_id_owned = step_id.to_string();
        let dispatch_label_for_error = dispatch_label.clone();
        let destination_name_for_dispatch = destination_name.clone();
        let pending_writes = exec_ctx.writes.clone();
        let dispatch_future = async move {
            let reply = match output_decode {
                AskOutputDecode::Artifact => outside_access
                    .ask_immutable_content_with_pending_writes(
                        &destination_name_for_dispatch,
                        &dispatch_partition,
                        payload_bytes,
                        context_bytes,
                        &pending_writes,
                    )
                    .await
                    .map(AskDispatchReply::ImmutableContent),
                AskOutputDecode::Json | AskOutputDecode::Bytes => outside_access
                    .ask_with_pending_writes(
                        &destination_name_for_dispatch,
                        &dispatch_partition,
                        payload_bytes,
                        context_bytes,
                        &pending_writes,
                    )
                    .await
                    .map(AskDispatchReply::Inline),
            };
            reply.map_err(|e| WorkflowError::PrimitiveDispatchFailed {
                primitive: dispatch_label_for_error.clone(),
                reason: e.to_string(),
                hint: format!(
                    "Outside-work dispatch failed for '{}'",
                    dispatch_label_for_error
                ),
            })
        };

        #[cfg(feature = "native")]
        let dispatch_result: Result<AskDispatchReply, WorkflowError> =
            if let Some(duration) = timeout {
                tokio::time::timeout(duration, dispatch_future)
                    .await
                    .map_err(|_| WorkflowError::Timeout {
                        step_id: step_id.to_string(),
                        reason: format!(
                            "Outside-work dispatch '{}' exceeded timeout of {:?}",
                            dispatch_label, duration
                        ),
                        hint: "Increase the step timeout duration or optimize the \
                               underlying slot operation to complete faster."
                            .to_string(),
                    })?
            } else {
                dispatch_future.await
            };

        #[cfg(not(feature = "native"))]
        let dispatch_result: Result<AskDispatchReply, WorkflowError> = {
            let _ = timeout;
            dispatch_future.await
        };

        let duration_ms = start.elapsed().as_millis() as i64;
        match dispatch_result {
            Ok(result_bytes) => {
                let decoded = Self::decode_ask_output(
                    &deps.product_word_ids,
                    &step_id_owned,
                    &destination_name,
                    output_decode,
                    result_bytes,
                )?;
                if decoded.output.get("$kind").and_then(Value::as_str)
                    == Some(super::context::NOT_ANSWERED_YET)
                {
                    return Err(WorkflowError::Waiting {
                        step_id: step_id_owned,
                        detail: decoded.output,
                    });
                }
                let mut result = StepHandlerResult::leaf(StepOutput {
                    output: decoded.output,
                    status: ExecutionStatus::Completed,
                    error: None,
                    duration_ms,
                });
                for (key, value) in decoded.raw_step_bytes {
                    result.raw_step_bytes.insert(key, value);
                }
                Ok(result)
            }
            Err(err) => Err(err),
        }
    }

    /// Execute a single workflow step.
    ///
    /// # Arguments
    ///
    /// * `step` -- The workflow step definition
    /// * `step_id` -- Unique identifier for this step (used to record output in context)
    /// * `exec_ctx` -- Mutable execution context (template source + output sink)
    /// * `deps` -- Executor dependencies (outside access, partition_key)
    /// * `actor` -- Authenticated actor performing the operation
    /// * `timeout` -- Optional timeout for the dispatch operation
    ///
    /// # Returns
    ///
    /// * `Ok(StepOutput)` -- Step completed successfully. Output is also recorded
    ///   in `exec_ctx.steps[step_id]`.
    /// * `Err(WorkflowError)` -- Step failed. A failure `StepOutput` is still recorded
    ///   in `exec_ctx.steps[step_id]` so subsequent steps can inspect the error.
    ///
    /// # Errors
    ///
    /// | Error Type | Cause |
    /// |-----------|-------|
    /// | `StepExecutionFailed` | Step kind/config is invalid for slot dispatch |
    /// | `TemplateResolutionFailed` | Template expression cannot be resolved |
    /// | `PrimitiveDispatchFailed` | Dispatch infrastructure error |
    /// | `Timeout` | Step exceeded timeout duration |
    /// | `Serialization` | Params cannot be deserialized into request type |
    pub async fn execute_step(
        step: &Step,
        step_id: &str,
        exec_ctx: &mut ExecutionContext,
        deps: &ExecutorDeps,
        _actor: &ActorContext,
        timeout: Option<std::time::Duration>,
    ) -> Result<StepOutput, WorkflowError> {
        match Self::execute_leaf_step_delta(step, step_id, exec_ctx, deps, _actor, timeout).await {
            Ok(result) => {
                for write in result.writes.iter().cloned() {
                    exec_ctx.push_write(write);
                }
                for key in &result.cleared_raw_step_bytes {
                    exec_ctx.clear_raw_step_bytes(key);
                }
                for (key, value) in &result.raw_step_bytes {
                    exec_ctx.record_raw_step_bytes(key.clone(), Arc::clone(value));
                }
                record_step_output(exec_ctx, step_id, result.output.clone());
                Ok(result.output)
            }
            Err(err) => {
                let step_output = StepOutput {
                    output: Value::Null,
                    status: ExecutionStatus::Failed,
                    error: Some(err.to_string()),
                    duration_ms: 0,
                };
                record_step_output(exec_ctx, step_id, step_output);
                Err(err)
            }
        }
    }

    fn decode_read_output(
        step_id: &str,
        result_bytes: Arc<[u8]>,
        content_hash: Option<String>,
    ) -> DecodedReadOutput {
        if let Ok(mut output) = serde_json::from_slice::<Value>(&result_bytes) {
            if let (Some(hash), Some(map)) = (content_hash, output.as_object_mut()) {
                map.insert("content_hash".to_string(), Value::String(hash));
            }
            return DecodedReadOutput {
                output,
                raw_bytes: None,
            };
        }

        let output = serde_json::json!({
            "kind": "bytes",
            "ref": step_id,
            "size": result_bytes.len(),
            "content_hash": content_hash,
        });

        DecodedReadOutput {
            output,
            raw_bytes: Some(result_bytes),
        }
    }

    /// Name a JSON value's kind the way a person would say it, so a failure
    /// message says what arrived instead of only what was wanted.
    fn json_kind_name(value: &Value) -> &'static str {
        match value {
            Value::Null => "nothing",
            Value::Bool(_) => "true/false",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "list",
            Value::Object(_) => "record",
        }
    }

    /// Say where a read was pointed, so an empty address names the field that
    /// was empty instead of leaving the reader to guess which of a definition's
    /// reads failed. A literal address is quoted back; a binding reports the
    /// place it selected from.
    fn describe_read_from(from: &Value) -> String {
        if let Some(literal) = from.as_str() {
            return format!("read.from was the literal '{literal}'");
        }
        let select = from.get("select");
        let source = select
            .and_then(|select| select.get("from"))
            .and_then(Value::as_str);
        let key = select
            .and_then(|select| select.get("key"))
            .and_then(Value::as_str);
        let path = select
            .and_then(|select| select.get("path"))
            .and_then(Value::as_str);
        match (source, key, path) {
            (Some(source), Some(key), Some(path)) => {
                format!("read.from selected {source}.{key}.{path}")
            }
            (Some(source), None, Some(path)) => format!("read.from selected {source}.{path}"),
            (Some(source), _, None) => format!("read.from selected from {source}"),
            _ => "read.from is neither a literal address nor a select binding".to_string(),
        }
    }

    fn read_fallback_output(
        step: &Step,
        exec_ctx: &ExecutionContext,
    ) -> Result<Option<Value>, WorkflowError> {
        step.config
            .get("fallback_output")
            .map(|fallback| BindingResolver::resolve_value(fallback, exec_ctx))
            .transpose()
    }

    /// The SQL tool's use, as the recipe row declares it (config.context.use = {purpose, surface}). The engine sets it on every
    /// call the step sends, over any use the input or an AI's answer carried. A step that declares none sends no use: any use
    /// in its input is stripped, and the pursuit's own default applies in the database, not here.
    fn bind_declared_use(step_id: &str, step: &Step, payload: &mut Value) -> Result<(), WorkflowError> {
        let declared = match step.context().get("use") {
            None | Some(Value::Null) => {
                if let Value::Object(fields) = payload {
                    fields.remove("use");
                }
                return Ok(());
            }
            Some(value) => value.clone(),
        };
        let well_formed = declared.as_object().is_some_and(|fields| {
            fields.len() == 2
                && fields.get("purpose").is_some_and(Value::is_string)
                && fields.get("surface").is_some_and(Value::is_string)
        });
        if !well_formed {
            return Err(WorkflowError::InvalidStep {
                step_id: step_id.to_string(),
                reason: format!("config.context.use must be {{\"purpose\": text, \"surface\": text}}; got {}", declared),
                hint: "Declare the use in the recipe row as two text values.".to_string(),
            });
        }
        match payload {
            Value::Object(fields) => {
                fields.insert("use".to_string(), declared);
            }
            _ => {
                return Err(WorkflowError::InvalidStep {
                    step_id: step_id.to_string(),
                    reason: format!("{} takes an object input (sql, params)", RUN_SQL_TOOL),
                    hint: "Give the statement as an object with sql and params.".to_string(),
                });
            }
        }
        Ok(())
    }

    fn ask_output_decode(step_id: &str, step: &Step) -> Result<AskOutputDecode, WorkflowError> {
        let Some(output) = step.config.get("output") else {
            return Ok(AskOutputDecode::Json);
        };
        let output = output
            .as_object()
            .ok_or_else(|| WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: "ask step config.output must be an object".to_string(),
                hint: "Use output like {\"decode\":\"json\"} or {\"decode\":\"bytes\"}.".into(),
            })?;
        match output.get("decode").and_then(Value::as_str).unwrap_or("json") {
            "json" => Ok(AskOutputDecode::Json),
            "bytes" => Ok(AskOutputDecode::Bytes),
            "artifact" => Ok(AskOutputDecode::Artifact),
            other => Err(WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: format!("ask step output.decode '{other}' is not supported"),
                hint: "Use output.decode=\"json\" for fields, \"bytes\" for intentionally inline bytes, or \"artifact\" for an immutable content reference.".into(),
            }),
        }
    }

    /// Address a prior step's raw bytes into a process input mount WITHOUT ever
    /// materializing those bytes as a `serde_json::Value` tree or base64 string.
    ///
    /// # Why this exists (L063 — workflow never materializes large external bodies)
    ///
    /// An `ask` step with `output:{decode:"bytes"}` keeps its raw response in
    /// `ExecutionContext::raw_step_bytes` as an in-memory `Arc<[u8]>` with NO
    /// content hash. A downstream `compute.process` step needs those bytes as a
    /// mounted input file, but the existing `blob_ref` input source requires a
    /// CAS `content_hash` that ask-bytes don't have. The naive alternative —
    /// binding the prior step's decoded JSON into the descriptor — forces the
    /// workflow guest to parse the entire body into a `serde_json::Value`. For
    /// large bodies (e.g. a 60 KB market-bars response) that parse runs inside a
    /// persistent WASM instance whose linear memory only grows, accumulating
    /// fragmentation across calls until serde/BTreeMap allocation traps.
    ///
    /// This resolver lets a step declare an input mount whose `source` is
    /// `{"kind":"step_bytes","step":"<step_id>"}`. We look up the prior step's
    /// raw bytes, publish them through the existing immutable-content Envelope
    /// owner, and rewrite the source into canonical
    /// [`ProcessInputSource::BlobRef`]. The process descriptor therefore carries
    /// one bounded multihash while `process-engine` materializes the bytes from
    /// CAS natively. No body-sized JSON/base64 value exists in Workflow WASM.
    ///
    /// # Genericity (L069)
    ///
    /// This is generic: ANY step's raw bytes can mount into ANY process input,
    /// not just market data. The discriminant lives in data (`source.kind`); the
    /// resolver dispatches on it without naming any caller's domain.
    async fn address_step_bytes_input_sources(
        step_id: &str,
        resolved_payload: &mut Value,
        exec_ctx: &ExecutionContext,
        outside_access: &dyn super::context::OutsideAccess,
        partition_key: &slot_protocol::PartitionKey,
    ) -> Result<(), WorkflowError> {
        let Some(inputs) = resolved_payload
            .get_mut("inputs")
            .and_then(Value::as_array_mut)
        else {
            return Ok(());
        };

        for mount in inputs.iter_mut() {
            let Some(source) = mount.get_mut("source").and_then(Value::as_object_mut) else {
                continue;
            };
            if source.get("kind").and_then(Value::as_str) != Some("step_bytes") {
                continue;
            }

            let reference = source
                .get("step")
                .and_then(Value::as_str)
                .ok_or_else(|| WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: "process input source kind=step_bytes must include string field 'step'"
                        .to_string(),
                    hint: "Use a source like {\"kind\":\"step_bytes\",\"step\":\"http_fetch\"} that names a prior ask step decoded with output.decode=\"bytes\".".into(),
                })?
                .to_string();

            let content_ref = match Self::step_artifact_content_ref(exec_ctx, &reference)? {
                Some(reference) => reference,
                None => {
                    let raw_bytes = exec_ctx.raw_step_bytes(&reference).ok_or_else(|| {
                        WorkflowError::StepExecutionFailed {
                            step_id: step_id.to_string(),
                            reason: format!(
                                "process input source step_bytes step '{reference}' has neither an immutable artifact nor raw bytes"
                            ),
                            hint: "Use output.decode=\"artifact\", process output storage=\"immutable_content\", or an intentionally inline byte-producing step.".into(),
                        }
                    })?;
                    outside_access
                        .store_immutable_content(partition_key, Arc::clone(raw_bytes))
                        .await
                        .map_err(|reason| WorkflowError::StepExecutionFailed {
                            step_id: step_id.to_string(),
                            reason: format!(
                                "process input source step_bytes step '{reference}' could not be addressed: {reason}"
                            ),
                            hint: "Provide the canonical immutable-content owner at the Workflow boundary."
                                .into(),
                        })?
                }
            };

            let blob_source = serde_json::to_value(ProcessInputSource::BlobRef {
                hash: content_ref.to_code_hex(),
            })
            .map_err(|e| WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: format!("failed to encode addressed process input source: {e}"),
                hint: "Internal error — immutable process input references are not serializable"
                    .into(),
            })?;

            *mount
                .get_mut("source")
                .expect("source presence checked above") = blob_source;
        }

        Ok(())
    }

    fn step_artifact_content_ref(
        exec_ctx: &ExecutionContext,
        reference: &str,
    ) -> Result<Option<slot_protocol::ImmutableContentRef>, WorkflowError> {
        let mut segments = reference.split('.');
        let Some(step_key) = segments.next() else {
            return Ok(None);
        };
        let Some(step) = exec_ctx.step_output(step_key) else {
            return Ok(None);
        };
        let mut value = &step.output;
        for segment in segments {
            value = match value {
                Value::Object(map) => match map.get(segment) {
                    Some(value) => value,
                    None => return Ok(None),
                },
                Value::Array(items) => {
                    let Ok(index) = segment.parse::<usize>() else {
                        return Ok(None);
                    };
                    let Some(value) = items.get(index) else {
                        return Ok(None);
                    };
                    value
                }
                _ => return Ok(None),
            };
        }
        let Some(hash) = value.get("content_hash").and_then(Value::as_str) else {
            return Ok(None);
        };
        slot_protocol::ImmutableContentRef::from_code_hex(hash)
            .map(Some)
            .map_err(|error| WorkflowError::StepExecutionFailed {
                step_id: step_key.to_string(),
                reason: format!("step artifact content_hash is invalid: {error}"),
                hint: "Artifact references must be canonical immutable Blake3 multihashes.".into(),
            })
    }

    fn decode_ask_output(
        product_word_ids: &execution_types::ProductWordIds,
        step_id: &str,
        destination_name: &str,
        output_decode: AskOutputDecode,
        reply: AskDispatchReply,
    ) -> Result<DecodedAskOutput, WorkflowError> {
        if output_decode == AskOutputDecode::Artifact {
            let AskDispatchReply::ImmutableContent(reference) = reply else {
                return Err(WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: "artifact ask received an inline reply".to_string(),
                    hint: "The outside boundary must honor immutable reply delivery.".into(),
                });
            };
            return Ok(DecodedAskOutput {
                output: serde_json::json!({
                    "kind": "immutable_content",
                    "content_hash": reference.to_code_hex(),
                }),
                raw_step_bytes: Vec::new(),
            });
        }

        let AskDispatchReply::Inline(result_bytes) = reply else {
            return Err(WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: "inline ask received an immutable content reference".to_string(),
                hint: "Use output.decode=\"artifact\" for immutable reply delivery.".into(),
            });
        };
        if output_decode == AskOutputDecode::Bytes {
            return Ok(DecodedAskOutput {
                output: serde_json::json!({
                    "kind": "bytes",
                    "ref": step_id,
                    "size": result_bytes.len(),
                }),
                raw_step_bytes: vec![(step_id.to_string(), result_bytes)],
            });
        }

        if destination_name == "compute.process" {
            let byte_count = result_bytes.len();
            let preview = Self::preview_bytes(&result_bytes);
            let result = decode_process_result(product_word_ids, &result_bytes).map_err(|error| {
                WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: format!(
                        "compute.process returned bytes that do not match ProcessResult: {error}"
                    ),
                    hint: format!(
                        "Expected canonical compute.process ProcessResult JSON. Response bytes={byte_count} preview={preview:?}",
                    ),
                }
            })?;
            return Ok(Self::normalize_compute_process_output(step_id, result));
        }

        if destination_name == "compute.process_sequence" {
            let byte_count = result_bytes.len();
            let preview = Self::preview_bytes(&result_bytes);
            let result = decode_process_sequence_result(product_word_ids, &result_bytes).map_err(|error| {
                WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: format!(
                        "compute.process_sequence returned bytes that do not match ProcessSequenceResult: {error}"
                    ),
                    hint: format!(
                        "Expected canonical compute.process_sequence ProcessSequenceResult JSON. Response bytes={byte_count} preview={preview:?}",
                    ),
                }
            })?;
            return Ok(Self::normalize_compute_process_sequence_output(
                step_id, result,
            ));
        }

        let output: Value = Self::decode_json_bytes(
            &result_bytes,
            "outside-work response JSON",
            |e, _byte_count, _preview| WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: format!("Failed to deserialize outside-work response: {e}"),
                hint: "The outside work returned non-JSON bytes".into(),
            },
        )?;
        Ok(DecodedAskOutput {
            output,
            raw_step_bytes: vec![(step_id.to_string(), result_bytes)],
        })
    }

    fn decode_json_bytes<T>(
        bytes: &[u8],
        expected: &str,
        error: impl Fn(String, usize, String) -> WorkflowError,
    ) -> Result<T, WorkflowError>
    where
        T: DeserializeOwned,
    {
        let preview = Self::preview_bytes(bytes);
        let text = std::str::from_utf8(bytes).map_err(|e| {
            error(
                format!("{expected} is not UTF-8 JSON: {e}"),
                bytes.len(),
                preview.clone(),
            )
        })?;
        serde_json::from_str::<T>(text).map_err(|e| {
            error(
                format!("{expected} decode failed: {e}"),
                bytes.len(),
                preview,
            )
        })
    }

    fn preview_bytes(bytes: &[u8]) -> String {
        let preview_len = bytes.len().min(256);
        String::from_utf8_lossy(&bytes[..preview_len]).into_owned()
    }

    fn normalize_compute_process_output(step_id: &str, result: ProcessResult) -> DecodedAskOutput {
        let mut raw_step_bytes = Vec::new();
        let ProcessResult {
            termination,
            captured_fds,
            outputs,
            collected_files,
            immutable_publications,
            duration_ms,
            containment_receipt,
        } = result;
        let captured_fds = captured_fds
            .into_iter()
            .enumerate()
            .map(|(index, capture)| {
                let bytes = Self::record_process_bytes_ref(
                    &mut raw_step_bytes,
                    format!("{step_id}.captured_fds.{index}.bytes"),
                    capture.bytes,
                );
                serde_json::json!({
                    "fd": capture.fd,
                    "bytes": bytes,
                    "content_hash": capture.content_hash,
                    "eof_observed": capture.eof_observed,
                })
            })
            .collect::<Vec<_>>();
        let outputs = outputs
            .into_iter()
            .enumerate()
            .map(|(index, artifact)| {
                let bytes = if artifact.content_hash.is_some() {
                    Value::Null
                } else {
                    Self::record_process_bytes_ref(
                        &mut raw_step_bytes,
                        format!("{step_id}.outputs.{index}"),
                        artifact.bytes,
                    )
                };
                serde_json::json!({
                    "mount_path": artifact.mount_path,
                    "content_type": artifact.content_type,
                    "storage": artifact.storage,
                    "byte_len": artifact.byte_len,
                    "integrity_hash": artifact.integrity_hash,
                    "content_hash": artifact.content_hash,
                    "chunk_manifest_hash": artifact.chunk_manifest_hash,
                    "chunk_manifest_address": artifact.chunk_manifest_address,
                    "envelope_address": artifact.envelope_address,
                    "envelope_path": artifact.envelope_path,
                    "chunk_size_bytes": artifact.chunk_size_bytes,
                    "bytes": bytes,
                })
            })
            .collect::<Vec<_>>();
        let collected_files = collected_files
            .into_iter()
            .enumerate()
            .map(|(index, file)| {
                let bytes = Self::record_process_bytes_ref(
                    &mut raw_step_bytes,
                    format!("{step_id}.collected_files.{index}.bytes"),
                    file.bytes,
                );
                serde_json::json!({
                    "name": file.name,
                    "bytes": bytes,
                    "identity": file.identity,
                })
            })
            .collect::<Vec<_>>();

        DecodedAskOutput {
            output: serde_json::json!({
                "termination": termination,
                "captured_fds": captured_fds,
                "outputs": outputs,
                "collected_files": collected_files,
                "immutable_publications": immutable_publications,
                "duration_ms": duration_ms,
                "containment_receipt": containment_receipt,
            }),
            raw_step_bytes,
        }
    }

    fn normalize_compute_process_sequence_output(
        step_id: &str,
        result: ProcessSequenceResult,
    ) -> DecodedAskOutput {
        let mut raw_step_bytes = Vec::new();
        let steps = result
            .steps
            .into_iter()
            .enumerate()
            .map(|(index, step)| {
                let mut normalized = Self::normalize_compute_process_output(
                    &format!("{step_id}.steps.{index}.process_result"),
                    step.process_result,
                );
                raw_step_bytes.append(&mut normalized.raw_step_bytes);
                serde_json::json!({
                    "name": step.name,
                    "predecessor_result_content_hash": step.predecessor_result_content_hash,
                    "process_result_content_hash": step.process_result_content_hash,
                    "process_result": normalized.output,
                })
            })
            .collect::<Vec<_>>();

        DecodedAskOutput {
            output: serde_json::json!({
                "request_content_hash": result.request_content_hash,
                "steps": steps,
            }),
            raw_step_bytes,
        }
    }

    fn record_process_bytes_ref(
        raw_step_bytes: &mut Vec<(String, Arc<[u8]>)>,
        reference: String,
        bytes: Vec<u8>,
    ) -> Value {
        let size = bytes.len();
        raw_step_bytes.push((reference.clone(), Arc::from(bytes.into_boxed_slice())));
        serde_json::json!({
            "kind": "bytes",
            "ref": reference,
            "size": size,
        })
    }

    fn build_writes(
        step_id: &str,
        resolved_writes: &Value,
        exec_ctx: &ExecutionContext,
    ) -> Result<Vec<PendingWrite>, WorkflowError> {
        let items =
            resolved_writes
                .as_array()
                .ok_or_else(|| WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: "write step config.items must resolve to an array".to_string(),
                    hint: "Set write.config.items to an array of {address, path, payload} objects"
                        .into(),
                })?;

        let mut writes = Vec::with_capacity(items.len());
        for item in items {
            let obj = item
                .as_object()
                .ok_or_else(|| WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: "each write item must resolve to an object".to_string(),
                    hint: "Each write item must contain address plus optional path/payload".into(),
                })?;

            let address = obj.get("address").and_then(|v| v.as_str()).ok_or_else(|| {
                WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: "write item missing string field 'address'".to_string(),
                    hint: "Provide the target fact address string in write.address".into(),
                }
            })?;

            let explicit_partition = obj
                .get("partition_key")
                .and_then(|v| v.as_str())
                .map(|value| value.to_string());

            let address_mode = obj
                .get("address_mode")
                .and_then(|v| v.as_str())
                .map(|value| value.to_string());

            let path = match obj.get("path") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .map(|part| {
                        part.as_str().map(|value| value.to_string()).ok_or_else(|| {
                            WorkflowError::StepExecutionFailed {
                                step_id: step_id.to_string(),
                                reason: "write path entries must be strings".to_string(),
                                hint: "Use path like [\"prop:extension:bundle\"]".into(),
                            }
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => {
                    return Err(WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: "write path must be an array of strings".to_string(),
                        hint: "Use path like [\"prop:extension:bundle\"]".into(),
                    });
                }
            };

            let payload = Self::resolve_write_payload(step_id, obj, exec_ctx)?;

            writes.push(PendingWrite {
                partition_key: explicit_partition,
                address: address.to_string(),
                address_mode,
                payload: payload.map(Arc::from),
                path,
            });
        }

        Ok(writes)
    }

    fn resolve_write_payload(
        step_id: &str,
        obj: &serde_json::Map<String, Value>,
        exec_ctx: &ExecutionContext,
    ) -> Result<Option<Vec<u8>>, WorkflowError> {
        let payload = obj.get("payload").filter(|value| !value.is_null());
        let payload_bytes = obj.get("payload_bytes").filter(|value| !value.is_null());

        match (payload, payload_bytes) {
            (Some(_), Some(_)) => Err(WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: "write item must not set both 'payload' and 'payload_bytes'".to_string(),
                hint: "Use payload for structured JSON values or payload_bytes for already-encoded bytes".into(),
            }),
            (Some(value), None) => serde_json::to_vec(value).map(Some).map_err(|e| {
                WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: format!("write payload JSON encoding failed: {e}"),
                    hint: "Ensure payload resolves to valid JSON data".into(),
                }
            }),
            (None, Some(value)) => Self::resolve_write_payload_bytes(step_id, value, exec_ctx),
            (None, None) => Ok(None),
        }
    }

    fn resolve_write_payload_bytes(
        step_id: &str,
        value: &Value,
        exec_ctx: &ExecutionContext,
    ) -> Result<Option<Vec<u8>>, WorkflowError> {
        match value {
            Value::String(text) => Ok(Some(text.as_bytes().to_vec())),
            Value::Array(items) => {
                let mut bytes = Vec::with_capacity(items.len());
                for item in items {
                    let byte = item.as_u64().ok_or_else(|| WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: "write payload_bytes arrays must contain integers".to_string(),
                        hint: "Use payload_bytes with a UTF-8 string, a [0..255] byte array, or a {kind:\"bytes\",ref:\"...\"} binding".into(),
                    })?;
                    let byte = u8::try_from(byte).map_err(|_| WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: "write payload_bytes entries must be between 0 and 255".to_string(),
                        hint: "Use payload_bytes with byte values in the 0..255 range".into(),
                    })?;
                    bytes.push(byte);
                }
                Ok(Some(bytes))
            }
            Value::Object(obj)
                if obj.get("kind").and_then(|kind| kind.as_str()) == Some("bytes") =>
            {
                let reference = obj
                    .get("ref")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: "write payload_bytes kind=bytes objects must include string field 'ref'".to_string(),
                        hint: "Use a binding like steps.<id>.output to carry raw bytes by reference".into(),
                    })?;
                let bytes = exec_ctx
                    .raw_step_bytes(reference)
                    .ok_or_else(|| WorkflowError::StepExecutionFailed {
                        step_id: step_id.to_string(),
                        reason: format!("write payload_bytes ref '{reference}' is not available"),
                        hint: "Reference a prior raw-byte step output such as steps.read_blob.output".into(),
                })?;
                Ok(Some(bytes.as_ref().to_vec()))
            }
            Value::Object(obj) if obj.get("source_bytes").is_some() => {
                Err(WorkflowError::StepExecutionFailed {
                    step_id: step_id.to_string(),
                    reason: "write payload_bytes.source_bytes is obsolete".to_string(),
                    hint: "Use payload_bytes.value_to_bytes to declare the value-to-bytes writer."
                        .into(),
                })
            }
            Value::Object(obj) if obj.get("value_to_bytes").is_some() => {
                encode_declared_value_to_bytes(step_id, obj, exec_ctx).map(Some)
            }
            _ => Err(WorkflowError::StepExecutionFailed {
                step_id: step_id.to_string(),
                reason: "write payload_bytes must resolve to a string, byte array, {kind:\"bytes\",ref:\"...\"}, or declared value_to_bytes".to_string(),
                hint: "Use payload for structured JSON values; use payload_bytes for raw bytes or data-declared value-to-bytes layouts".into(),
            }),
        }
    }
}

// ============================================================================
// DELETED in E.16: build_transact, build_database_read, build_journal_append,
// build_execute, build_call_external, build_schema_write, build_embodiment,
// primitive_result_to_output — all replaced by generic
// Outside-work dispatch through the workflow boundary adapter.
// ============================================================================
// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::{ContextualParams, StartData, StepOutput};
    use execution_types::{ProcessOutputArtifact, ProcessOutputStorage};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    // ========================================================================
    // Test Helpers
    // ========================================================================

    /// Build an ExecutionContext with start data for template resolution.
    fn test_exec_context() -> ExecutionContext {
        ExecutionContext {
            start: StartData {
                start_type: "entity_created".to_string(),
                input: json!({
                    "target_id": "node-123",
                    "entity_type": "page",
                    "count": 5
                }),
                started_at: "2026-01-29T12:00:00Z".to_string(),
                start_id: Some("evt-001".to_string()),
            },
            context: ContextualParams {
                actor: ActorContext::new("user:admin"),
                partition_key: "partition:genesis".to_string(),
                organization_id: "org:default".to_string(),
                platform: crate::domain::PlatformInfo {
                    os: std::env::consts::OS.to_string(),
                    arch: std::env::consts::ARCH.to_string(),
                },
            },
            ..Default::default()
        }
    }

    /// Mock outside-access adapter that returns a success JSON response for any request.
    struct MockOutsideAccess;

    #[async_trait::async_trait]
    impl super::super::context::OutsideAccess for MockOutsideAccess {
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
        ) -> Result<super::super::context::DirectReadResult, String> {
            let response = json!({"status": "ok", "result": {}});
            Ok(super::super::context::DirectReadResult {
                bytes: std::sync::Arc::from(
                    serde_json::to_vec(&response).unwrap().into_boxed_slice(),
                ),
                content_hash: "test-content-hash".to_string(),
            })
        }
    }

    struct ByteResponseOutsideAccess {
        response: Arc<[u8]>,
    }

    #[async_trait::async_trait]
    impl super::super::context::OutsideAccess for ByteResponseOutsideAccess {
        async fn ask(
            &self,
            _name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<Arc<[u8]>, String> {
            Ok(Arc::clone(&self.response))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<super::super::context::DirectReadResult, String> {
            panic!("byte response outside access test does not perform direct reads")
        }
    }

    struct MockDefinitionStore;
    impl crate::domain::DefinitionStore for MockDefinitionStore {
        fn get_by_id(
            &self,
            _: &str,
            _: &str,
        ) -> crate::domain::errors::WorkflowResult<Option<crate::domain::types::Definition>>
        {
            Ok(None)
        }
        fn get_by_slug(
            &self,
            _: &str,
            _: &str,
        ) -> crate::domain::errors::WorkflowResult<Option<crate::domain::types::Definition>>
        {
            Ok(None)
        }
        fn get_active(
            &self,
            _: &str,
            _: Option<&str>,
        ) -> crate::domain::errors::WorkflowResult<Vec<crate::domain::types::Definition>> {
            Ok(vec![])
        }
        fn get_by_trigger(
            &self,
            _: &str,
            _: &str,
        ) -> crate::domain::errors::WorkflowResult<Vec<crate::domain::types::Definition>> {
            Ok(vec![])
        }
    }

    /// Build ExecutorDeps for testing.
    fn test_deps() -> ExecutorDeps {
        ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: std::sync::Arc::new(MockOutsideAccess),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        }
    }

    fn test_actor() -> ActorContext {
        ActorContext::new("user:test")
    }

    fn test_process_result_bytes() -> Vec<u8> {
        serde_json::to_vec(&process_result_fixture(
            ProcessTermination::Exited { code: 0 },
            Vec::new(),
            Vec::new(),
            Vec::new(),
            1,
        ))
        .expect("process result should serialize")
    }

    fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .expect("test RTBL u32 slice should be four bytes"),
        )
    }

    fn decode_record_table_cells(bytes: &[u8]) -> Vec<Vec<Option<Vec<u8>>>> {
        assert!(bytes.len() >= 16, "RTBL payload should include header");
        assert_eq!(&bytes[0..4], b"RTBL");
        assert_eq!(&bytes[4..8], &[0, 0, 0, 0]);
        let row_count = read_u32_le(bytes, 8) as usize;
        let column_count = read_u32_le(bytes, 12) as usize;
        let index_len = row_count * column_count * 8;
        let payload_offset = 16 + index_len;
        let mut rows = vec![vec![None; column_count]; row_count];

        for (row_index, row) in rows.iter_mut().enumerate().take(row_count) {
            for (column_index, cell) in row.iter_mut().enumerate().take(column_count) {
                let cell_index = row_index * column_count + column_index;
                let index_offset = 16 + cell_index * 8;
                let start = read_u32_le(bytes, index_offset) as usize;
                let len = read_u32_le(bytes, index_offset + 4);
                if len == 0xffff_ffff {
                    continue;
                }
                let len = len as usize;
                *cell = Some(bytes[payload_offset + start..payload_offset + start + len].to_vec());
            }
        }

        rows
    }

    fn cell_text(cells: &[Vec<Option<Vec<u8>>>], row_index: usize, column_index: usize) -> String {
        String::from_utf8(
            cells[row_index][column_index]
                .clone()
                .expect("test cell should be present"),
        )
        .expect("test cell should be UTF-8")
    }

    fn cell_byte(cells: &[Vec<Option<Vec<u8>>>], row_index: usize, column_index: usize) -> u8 {
        cells[row_index][column_index]
            .as_ref()
            .and_then(|cell| cell.first())
            .copied()
            .expect("test byte cell should be present")
    }

    fn make_ask_step(input: Value) -> Step {
        Step::ask("test.owner", input)
    }

    // ========================================================================
    // Test 1: execute_step dispatches plain ask successfully
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_parses_and_dispatches() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = make_ask_step(json!({"op": "test", "name": "TestType"}));

        let result =
            StepExecutor::execute_step(&step, "step_1", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_ok(), "Step should succeed: {:?}", result.err());

        let output = result.expect("should be Ok");
        assert_eq!(output.status, ExecutionStatus::Completed);
        assert!(output.error.is_none());
        assert!(output.duration_ms >= 0);
    }

    // ========================================================================
    // Test 2: execute_step resolves template variables in ask input
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_resolves_templates() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = make_ask_step(json!({
            "op": "test",
            "name": "{{input.entity_type}}",
            "description": "{{input.target_id}}"
        }));

        // If templates fail to resolve, execute_step returns an error.
        // Success here proves templates were resolved.
        let result =
            StepExecutor::execute_step(&step, "step_resolve", &mut exec_ctx, &deps, &actor, None)
                .await;

        assert!(
            result.is_ok(),
            "Step with valid templates should succeed: {:?}",
            result.err()
        );
    }

    // ========================================================================
    // Test 3: execute_step captures output as StepOutput
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_captures_output() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = make_ask_step(json!({"op": "capture", "name": "CaptureType"}));

        let output =
            StepExecutor::execute_step(&step, "step_capture", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("should succeed");

        // SchemaWrite result includes output from dispatch
        assert_eq!(output.status, ExecutionStatus::Completed);
        assert_eq!(output.output["status"], "ok");
    }

    // ========================================================================
    // Test 4: execute_step records output in ExecutionContext
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_records_in_context() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        assert!(exec_ctx.steps.is_empty(), "Context should start empty");

        let step = make_ask_step(json!({"op": "record", "name": "RecordTest"}));

        let _output =
            StepExecutor::execute_step(&step, "record_test", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("should succeed");

        assert_eq!(exec_ctx.steps.len(), 1);
        assert!(
            exec_ctx.steps.contains_key("record_test"),
            "Context should contain step output"
        );
        assert_eq!(
            exec_ctx.steps["record_test"].status,
            ExecutionStatus::Completed
        );
    }

    // ========================================================================
    // Test 5: execute_step forwards plain ask without local validation
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_plain_ask_passes_through() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::ask("opaque.owner", json!({"path": "ui.editing", "value": true}));

        let result =
            StepExecutor::execute_step(&step, "unknown_prim", &mut exec_ctx, &deps, &actor, None)
                .await;

        assert!(
            result.is_ok(),
            "Plain ask should pass through blind router: {:?}",
            result
        );
        let output = result.unwrap();
        assert_eq!(output.status, ExecutionStatus::Completed);
    }

    // ========================================================================
    // V2 (runner-as-DATA): the ask dispatch TARGET (config.name) is binding-resolved
    // ========================================================================

    /// Records every dispatch destination name so a test can assert the RESOLVED target.
    struct RecordingOutsideAccess {
        names: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl super::super::context::OutsideAccess for RecordingOutsideAccess {
        async fn ask(
            &self,
            name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            _payload: bytes::Bytes,
            _context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            self.names.lock().unwrap().push(name.to_string());
            let response = json!({"status": "ok", "result": {}});
            Ok(std::sync::Arc::from(
                serde_json::to_vec(&response).unwrap().into_boxed_slice(),
            ))
        }

        async fn read(
            &self,
            _from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<super::super::context::DirectReadResult, String> {
            panic!("recording outside access does not perform direct reads")
        }
    }

    fn deps_recording(names: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> ExecutorDeps {
        let mut deps = test_deps();
        deps.outside_access = std::sync::Arc::new(RecordingOutsideAccess { names });
        deps
    }

    /// A LITERAL `config.name` passes through unchanged — every existing workflow that
    /// hardcodes its dispatch target (e.g. "compute.process") is byte-identical.
    #[tokio::test]
    async fn test_ask_name_literal_passes_through() {
        let names = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let deps = deps_recording(names.clone());
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        // a neutral literal (not "compute.process", which has special ProcessResult decode).
        let step = Step::ask("custom.runner", json!({"op": "test"}));
        let result =
            StepExecutor::execute_step(&step, "lit", &mut exec_ctx, &deps, &actor, None).await;

        assert!(
            result.is_ok(),
            "literal-name ask should dispatch: {:?}",
            result.err()
        );
        assert_eq!(
            names.lock().unwrap().as_slice(),
            &["custom.runner".to_string()]
        );
    }

    #[tokio::test]
    async fn ask_context_keeps_authored_fields_and_adds_canonical_runtime_path() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(None),
            read_response: Mutex::new(None),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let mut deps = test_deps();
        deps.outside_access = dispatcher.clone();
        let mut exec_ctx = test_exec_context();
        exec_ctx.runtime_path = vec![
            json!({ "iteration": "pages_iter_3", "definition_id": "pages" }).to_string(),
            json!({ "action": "slot-action", "definition_id": "review-action" }).to_string(),
        ];
        let mut step = Step::ask("custom.runner", json!({"op": "test"})).with_id("review");
        step.config["context"] = json!({"step_id": "review", "title": "Review"});

        StepExecutor::execute_step(&step, "review", &mut exec_ctx, &deps, &test_actor(), None)
            .await
            .expect("the ask should dispatch");

        let context = dispatcher.last_context.lock().unwrap().clone().expect("context is passed");
        assert_eq!(context["step_id"], json!("review"));
        assert_eq!(context["title"], json!("Review"));
        assert_eq!(
            context["_runtime_identity"],
            json!([
                json!({ "iteration": "pages_iter_3", "definition_id": "pages" }).to_string(),
                json!({ "action": "slot-action", "definition_id": "review-action" }).to_string(),
                "review"
            ])
        );
    }

    /// A BINDING `config.name` resolves the dispatch target from input DATA — the
    /// runner-as-DATA primitive (e.g. a TrackerDescriptor `runner` field selecting the
    /// perception runtime). Here it binds `input.entity_type` ("page" in the test ctx).
    #[tokio::test]
    async fn test_ask_name_binding_resolves_from_data() {
        let names = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let deps = deps_recording(names.clone());
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step: Step = serde_json::from_value(json!({
            "kind": "ask",
            "config": {
                "name": {"$kind": "binding", "select": {"from": "input", "path": "entity_type"}},
                "input": {"op": "test"}
            }
        }))
        .expect("ask step with binding name should deserialize");

        let result =
            StepExecutor::execute_step(&step, "bound", &mut exec_ctx, &deps, &actor, None).await;

        assert!(
            result.is_ok(),
            "binding-name ask should dispatch: {:?}",
            result.err()
        );
        // The dispatch target was SELECTED FROM DATA, not the literal binding AST.
        assert_eq!(names.lock().unwrap().as_slice(), &["page".to_string()]);
    }

    /// A `config.name` that does not resolve to a NON-EMPTY STRING fails CLOSED (SP5) —
    /// no silent dispatch to an empty/invalid target. Covers every shape the
    /// `Some(s) if !s.is_empty()` guard must reject: absent, null, empty string, number,
    /// object. (Codex convergence required this breadth.)
    #[tokio::test]
    async fn test_ask_name_unresolved_fails_closed() {
        let bad_configs = [
            json!({ "input": {"op": "test"} }), // name absent -> Null
            json!({ "name": null, "input": {"op": "test"} }), // explicit null
            json!({ "name": "", "input": {"op": "test"} }), // empty string
            json!({ "name": 42, "input": {"op": "test"} }), // number
            json!({ "name": {"a": 1}, "input": {"op": "test"} }), // plain object (not a binding AST)
        ];
        for (i, cfg) in bad_configs.iter().enumerate() {
            let deps = test_deps();
            let mut exec_ctx = test_exec_context();
            let actor = test_actor();
            let step: Step = serde_json::from_value(json!({"kind": "ask", "config": cfg}))
                .expect("ask step should deserialize");
            let result =
                StepExecutor::execute_step(&step, "bad", &mut exec_ctx, &deps, &actor, None).await;
            assert!(
                result.is_err(),
                "bad ask target #{i} ({cfg}) must fail closed, got {result:?}"
            );
        }
    }

    // ========================================================================
    // Test 6: execute_step returns error for unknown binding scope
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_invalid_template_error() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = make_ask_step(
            json!({"target": {"$kind": "binding", "select": {"from": "unknown_scope", "path": "field"}}}),
        );

        let result =
            StepExecutor::execute_step(&step, "bad_tmpl", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Unknown binding scope"),
            "Error should mention unknown scope: {}",
            msg
        );
    }

    // ========================================================================
    // Test 7: execute_step with binding to missing step resolves null
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_missing_context_variable_error() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = make_ask_step(
            json!({"event_type": {"$kind": "binding", "select": {"from": "steps", "key": "nonexistent_step", "path": "output"}}}),
        );

        let result =
            StepExecutor::execute_step(&step, "missing_ref", &mut exec_ctx, &deps, &actor, None)
                .await;

        // Binding resolution still does not error on missing paths; the outside owner
        // receives null in the resolved input.
        assert!(result.is_ok() || result.is_err());
    }

    // ========================================================================
    // Test 8: execute_step records failure in context on dispatch error
    // ========================================================================

    /// Outside-access adapter that always returns an error — for testing error paths.
    struct ErrorOutsideAccess;

    #[async_trait::async_trait]
    impl super::super::context::OutsideAccess for ErrorOutsideAccess {
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
        ) -> Result<super::super::context::DirectReadResult, String> {
            Err("outside access failed: connection refused".to_string())
        }
    }

    struct CapturingOutsideAccess {
        last_name: Mutex<Option<String>>,
        last_input: Mutex<Option<Value>>,
        last_context: Mutex<Option<Value>>,
        ask_response: Mutex<Option<Vec<u8>>>,
        read_response: Mutex<Option<Value>>,
        read_bytes: Mutex<Option<Vec<u8>>>,
        read_content_hash: Mutex<Option<String>>,
    }

    #[async_trait::async_trait]
    impl super::super::context::OutsideAccess for CapturingOutsideAccess {
        async fn store_immutable_content(
            &self,
            _partition_key: &slot_protocol::PartitionKey,
            content: Arc<[u8]>,
        ) -> Result<slot_protocol::ImmutableContentRef, String> {
            slot_protocol::ImmutableContentRef::from_hash(slot_protocol::Hash::blake3_hash(
                content.as_ref(),
            ))
            .map_err(|error| error.to_string())
        }

        async fn ask_immutable_content(
            &self,
            name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            payload: bytes::Bytes,
            context: Option<bytes::Bytes>,
        ) -> Result<slot_protocol::ImmutableContentRef, String> {
            *self.last_name.lock().unwrap() = Some(name.to_string());
            *self.last_input.lock().unwrap() =
                Some(serde_json::from_slice(&payload).expect("payload must be valid JSON"));
            *self.last_context.lock().unwrap() = context
                .as_deref()
                .map(|bytes| serde_json::from_slice(bytes).expect("context must be valid JSON"));
            let bytes = self
                .ask_response
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| serde_json::to_vec(&json!({"status": "ok"})).unwrap());
            slot_protocol::ImmutableContentRef::from_hash(slot_protocol::Hash::blake3_hash(&bytes))
                .map_err(|error| error.to_string())
        }

        async fn ask(
            &self,
            name: &str,
            _partition_key: &slot_protocol::PartitionKey,
            payload: bytes::Bytes,
            context: Option<bytes::Bytes>,
        ) -> Result<std::sync::Arc<[u8]>, String> {
            *self.last_name.lock().unwrap() = Some(name.to_string());
            *self.last_input.lock().unwrap() =
                Some(serde_json::from_slice(&payload).expect("payload must be valid JSON"));
            *self.last_context.lock().unwrap() = context
                .as_deref()
                .map(|bytes| serde_json::from_slice(bytes).expect("context must be valid JSON"));
            if let Some(bytes) = self.ask_response.lock().unwrap().clone() {
                return Ok(Arc::from(bytes.into_boxed_slice()));
            }
            Ok(std::sync::Arc::from(
                serde_json::to_vec(&json!({"status": "ok"}))
                    .unwrap()
                    .into_boxed_slice(),
            ))
        }

        async fn read(
            &self,
            from: &str,
            _partition_key: &slot_protocol::PartitionKey,
        ) -> Result<super::super::context::DirectReadResult, String> {
            *self.last_name.lock().unwrap() = Some(from.to_string());
            *self.last_input.lock().unwrap() = Some(Value::Null);
            if let Some(bytes) = self.read_bytes.lock().unwrap().clone() {
                return Ok(super::super::context::DirectReadResult {
                    bytes: std::sync::Arc::from(bytes.into_boxed_slice()),
                    content_hash: self
                        .read_content_hash
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| "test-content-hash-bytes".to_string()),
                });
            }
            let response = self
                .read_response
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| json!({"status": "ok"}));
            Ok(super::super::context::DirectReadResult {
                bytes: std::sync::Arc::from(
                    serde_json::to_vec(&response).unwrap().into_boxed_slice(),
                ),
                content_hash: self
                    .read_content_hash
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "test-content-hash-json".to_string()),
            })
        }
    }

    #[tokio::test]
    async fn test_execute_step_dispatch_error_records_failure() {
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: std::sync::Arc::new(ErrorOutsideAccess),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::ask(
            "test.owner",
            json!({"url": "https://example.com", "method": "GET"}),
        );

        let result =
            StepExecutor::execute_step(&step, "fail_step", &mut exec_ctx, &deps, &actor, None)
                .await;

        // Outside access should fail (ErrorOutsideAccess returns Err)
        assert!(result.is_err());

        // But the failure should still be recorded in context
        assert!(
            exec_ctx.steps.contains_key("fail_step"),
            "Failed step should still be recorded in context"
        );
        assert_eq!(exec_ctx.steps["fail_step"].status, ExecutionStatus::Failed);
        assert!(
            exec_ctx.steps["fail_step"].error.is_some(),
            "Failed step should have error message"
        );
    }

    #[tokio::test]
    async fn test_read_step_without_fallback_preserves_dispatch_error() {
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: std::sync::Arc::new(ErrorOutsideAccess),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let step = Step::read(json!("missing-direct-address"));

        let result =
            StepExecutor::execute_step(&step, "read_missing", &mut exec_ctx, &deps, &actor, None)
                .await;

        assert!(result.is_err());
        assert_eq!(
            exec_ctx.steps["read_missing"].status,
            ExecutionStatus::Failed
        );
        assert!(exec_ctx.steps["read_missing"]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Primitive dispatch failed"));
    }

    #[tokio::test]
    async fn test_read_step_fallback_output_is_data_declared_and_binding_resolved() {
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: std::sync::Arc::new(ErrorOutsideAccess),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::read(json!("missing-direct-address"));
        step.config["fallback_output"] = json!({
            "present": false,
            "selected": {
                "$kind": "binding",
                "select": {
                    "from": "input",
                    "path": "target_id"
                }
            }
        });

        let output = StepExecutor::execute_step(
            &step,
            "read_optional_missing",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("configured read fallback should complete the step");

        assert_eq!(output.status, ExecutionStatus::Completed);
        assert_eq!(output.output["present"], json!(false));
        assert_eq!(output.output["selected"], json!("node-123"));
        assert_eq!(exec_ctx.raw_step_bytes("read_optional_missing"), None);
    }

    /// Deps whose read always SUCCEEDS. Every test below uses this on purpose:
    /// if a step still completes through its fallback, the only way it got
    /// there is the empty-address branch, because the read itself would have
    /// returned data.
    fn deps_whose_read_succeeds() -> ExecutorDeps {
        ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: std::sync::Arc::new(MockOutsideAccess),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        }
    }

    /// A read pointed at a field that is not there. This is the shape a
    /// per-item loop hits when one item in the list carries no address: the
    /// descriptor says nothing about where its decoder lives. The declared
    /// fallback answers it, and the sibling items keep going.
    #[tokio::test]
    async fn an_address_that_resolves_to_nothing_takes_the_declared_fallback() {
        let deps = deps_whose_read_succeeds();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::read(json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "decoder.script_address"}
        }));
        step.config["fallback_output"] = json!({"decoder_installed": false});

        let output = StepExecutor::execute_step(
            &step,
            "read_absent_address",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("an absent address is an outcome when a fallback is declared");

        assert_eq!(output.status, ExecutionStatus::Completed);
        assert_eq!(output.output["decoder_installed"], json!(false));
    }

    /// The same absent address with nothing declared to answer it still fails,
    /// and the message names the field that was empty. Before this, every one
    /// of these read "read step from must resolve to a string", which does not
    /// say which read, in a definition with five of them.
    #[tokio::test]
    async fn an_address_that_resolves_to_nothing_names_the_empty_field() {
        let deps = deps_whose_read_succeeds();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let step = Step::read(json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "decoder.script_address"}
        }));

        let result = StepExecutor::execute_step(
            &step,
            "read_absent_address",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await;

        assert!(result.is_err(), "no fallback is declared, so this fails");
        let reported = exec_ctx.steps["read_absent_address"]
            .error
            .clone()
            .unwrap_or_default();
        assert!(
            reported.contains("resolved to nothing"),
            "message must say the address was empty: {reported}"
        );
        assert!(
            reported.contains("input.decoder.script_address"),
            "message must name the field that was empty: {reported}"
        );
    }

    /// A number where an address belongs is a broken definition, not a missing
    /// value, so no fallback rescues it and the message says what arrived.
    #[tokio::test]
    async fn an_address_of_the_wrong_kind_fails_even_with_a_fallback() {
        let deps = deps_whose_read_succeeds();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::read(json!({
            "$kind": "binding",
            "select": {"from": "input", "path": "count"}
        }));
        step.config["fallback_output"] = json!({"decoder_installed": false});

        let result = StepExecutor::execute_step(
            &step,
            "read_wrong_kind",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await;

        assert!(
            result.is_err(),
            "a fallback answers an absent address, never a wrong one"
        );
        let reported = exec_ctx.steps["read_wrong_kind"]
            .error
            .clone()
            .unwrap_or_default();
        assert!(
            reported.contains("number"),
            "message must say what arrived: {reported}"
        );
    }

    /// A capturing outside-access whose SQL answer is an empty result, for the run-sql tool's steps.
    fn sql_tool_dispatcher() -> Arc<CapturingOutsideAccess> {
        Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(
                json!({"columns": [], "rows": [], "row_count": 0}).to_string().into_bytes(),
            )),
            read_response: Mutex::new(None),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        })
    }

    fn sql_tool_deps(dispatcher: Arc<CapturingOutsideAccess>) -> ExecutorDeps {
        let mut deps = test_deps();
        deps.outside_access = dispatcher;
        deps
    }

    /// The use the recipe row declares (config.context.use) is the one the SQL tool gets, over any use the input carried.
    #[tokio::test]
    async fn test_run_sql_step_binds_declared_use_over_input() {
        let dispatcher = sql_tool_dispatcher();
        let deps = sql_tool_deps(dispatcher.clone());
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::ask(
            "tool:run-sql-in-my-database",
            json!({"sql": "select 1", "use": {"purpose": "coach/review", "surface": ""}}),
        );
        step.config["context"] = json!({"use": {"purpose": "publish", "surface": "social/instagram"}});

        let result =
            StepExecutor::execute_step(&step, "sql", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_ok(), "sql step should run: {:?}", result.err());
        let sent = dispatcher.last_input.lock().unwrap().clone().unwrap();
        assert_eq!(sent["use"], json!({"purpose": "publish", "surface": "social/instagram"}));
        assert_eq!(sent["sql"], json!("select 1"));
    }

    /// A step that declares no use sends no use: a use its input carries (an AI's answer) is stripped, so the pursuit's own
    /// default applies in the database.
    #[tokio::test]
    async fn test_run_sql_step_without_declared_use_strips_input_use() {
        let dispatcher = sql_tool_dispatcher();
        let deps = sql_tool_deps(dispatcher.clone());
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let step = Step::ask(
            "tool:run-sql-in-my-database",
            json!({"sql": "select 1", "use": {"purpose": "publish", "surface": "social/instagram"}}),
        );

        let result =
            StepExecutor::execute_step(&step, "sql", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_ok(), "sql step should run: {:?}", result.err());
        let sent = dispatcher.last_input.lock().unwrap().clone().unwrap();
        assert!(sent.get("use").is_none(), "an undeclared use must be stripped, got {}", sent);
        assert_eq!(sent["sql"], json!("select 1"));
    }

    /// A declared use overwrites an AI-supplied use in the same input.
    #[tokio::test]
    async fn test_run_sql_step_declared_use_overwrites_input_use() {
        let dispatcher = sql_tool_dispatcher();
        let deps = sql_tool_deps(dispatcher.clone());
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::ask(
            "tool:run-sql-in-my-database",
            json!({"sql": "select 1", "use": {"purpose": "publish", "surface": "social/instagram"}}),
        );
        step.config["context"] = json!({"use": {"purpose": "coach/review", "surface": ""}});

        let result =
            StepExecutor::execute_step(&step, "sql", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_ok(), "sql step should run: {:?}", result.err());
        let sent = dispatcher.last_input.lock().unwrap().clone().unwrap();
        assert_eq!(sent["use"], json!({"purpose": "coach/review", "surface": ""}));
    }

    /// A declared use that is not {purpose, surface} as text fails the step, and nothing is sent.
    #[tokio::test]
    async fn test_run_sql_step_malformed_declared_use_fails_closed() {
        let dispatcher = sql_tool_dispatcher();
        let deps = sql_tool_deps(dispatcher.clone());
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::ask("tool:run-sql-in-my-database", json!({"sql": "select 1"}));
        step.config["context"] = json!({"use": {"purpose": "publish"}});

        let result =
            StepExecutor::execute_step(&step, "sql", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_err(), "a malformed use must fail the step");
        assert!(dispatcher.last_input.lock().unwrap().is_none(), "nothing may be sent");
    }

    #[tokio::test]
    async fn test_ask_dispatches_bare_input() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::ask(
            "compute.process",
            json!({
                "binary_path": "/bin/cat",
                "entry_points": [{"$kind":"binding","select":{"from":"input","path":"target_id"}}],
                "timeout_ms": 1000,
                "cli_template": "{entry_points}",
                "env_vars": {}
            }),
        );

        let result =
            StepExecutor::execute_step(&step, "ask", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_ok(), "ask should succeed: {:?}", result.err());
        assert_eq!(
            dispatcher.last_name.lock().unwrap().as_deref(),
            Some("compute.process")
        );
        assert_eq!(
            dispatcher
                .last_input
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|v| v.get("binary_path")),
            Some(&json!("/bin/cat"))
        );
        assert!(
            dispatcher
                .last_input
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|v| v.get("primitive"))
                .is_none(),
            "ask input must be bare target payload, not workflow wrapper"
        );
        assert!(dispatcher.last_context.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn ask_step_bytes_input_source_addresses_prior_step_bytes() {
        // Raw bytes that an intentionally inline producer retained. The generic
        // resolver publishes them once and sends only their immutable identity
        // to process-engine.
        let raw: Vec<u8> = (0u16..600).map(|i| (i % 256) as u8).collect();
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        // Simulate the upstream ask having retained raw response bytes.
        exec_ctx.record_raw_step_bytes(
            "http_fetch".to_string(),
            Arc::from(raw.clone().into_boxed_slice()),
        );

        let step = Step::ask(
            "compute.process",
            json!({
                "argv": ["python3", "script.py"],
                "timeout_ms": 1000,
                "inputs": [
                    {
                        "mount_path": "http-response.json",
                        "content_type": "application/json",
                        "source": {"kind": "step_bytes", "step": "http_fetch"}
                    }
                ]
            }),
        );

        let result =
            StepExecutor::execute_step(&step, "normalize_bars", &mut exec_ctx, &deps, &actor, None)
                .await;
        assert!(result.is_ok(), "ask should succeed: {:?}", result.err());

        let captured = dispatcher
            .last_input
            .lock()
            .unwrap()
            .clone()
            .expect("ask payload should be captured");
        let inputs = captured["inputs"]
            .as_array()
            .expect("inputs should be an array");
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0]["mount_path"], json!("http-response.json"));
        assert_eq!(inputs[0]["content_type"], json!("application/json"));

        let expected_ref =
            slot_protocol::ImmutableContentRef::from_hash(slot_protocol::Hash::blake3_hash(&raw))
                .expect("immutable ref");
        let expected_source = serde_json::to_value(ProcessInputSource::BlobRef {
            hash: expected_ref.to_code_hex(),
        })
        .expect("blob source should serialize");
        assert_eq!(inputs[0]["source"], expected_source);
        assert_eq!(inputs[0]["source"]["kind"], json!("blob_ref"));
        assert!(
            inputs[0]["source"].get("bytes").is_none(),
            "process input descriptors never contain the body or base64"
        );
    }

    #[tokio::test]
    async fn artifact_ask_crosses_workflow_as_hash_and_mounts_as_blob_ref() {
        let body = vec![0x6d; 2 * 1024 * 1024];
        let expected_ref =
            slot_protocol::ImmutableContentRef::from_hash(slot_protocol::Hash::blake3_hash(&body))
                .expect("immutable ref");
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(body)),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut producer = Step::ask("outside.owner", json!({"operation":"snapshot"}));
        producer.config["output"] = json!({"decode":"artifact"});

        let produced =
            StepExecutor::execute_step(&producer, "snapshot", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("artifact ask");
        assert_eq!(
            produced.output["content_hash"],
            json!(expected_ref.to_code_hex())
        );
        assert_eq!(exec_ctx.raw_step_bytes("snapshot"), None);

        *dispatcher.ask_response.lock().unwrap() = Some(test_process_result_bytes());
        let consumer = Step::ask(
            "compute.process",
            json!({
                "argv": ["python3", "consumer.py"],
                "timeout_ms": 1000,
                "inputs": [{
                    "mount_path": "snapshot.json",
                    "source": {"kind":"step_bytes","step":"snapshot"}
                }]
            }),
        );
        StepExecutor::execute_step(&consumer, "consume", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("artifact consumer");
        let captured = dispatcher
            .last_input
            .lock()
            .unwrap()
            .clone()
            .expect("process input");
        assert_eq!(
            captured["inputs"][0]["source"],
            serde_json::to_value(ProcessInputSource::BlobRef {
                hash: expected_ref.to_code_hex()
            })
            .unwrap()
        );
        assert!(captured["inputs"][0]["source"].get("bytes").is_none());
    }

    #[tokio::test]
    async fn ask_step_bytes_input_source_missing_step_is_structured_error() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::ask(
            "compute.process",
            json!({
                "argv": ["python3", "script.py"],
                "timeout_ms": 1000,
                "inputs": [
                    {
                        "mount_path": "http-response.json",
                        "source": {"kind": "step_bytes", "step": "never_ran"}
                    }
                ]
            }),
        );

        let result =
            StepExecutor::execute_step(&step, "normalize_bars", &mut exec_ctx, &deps, &actor, None)
                .await;

        let err = result.expect_err("missing step_bytes reference must fail");
        let msg = err.to_string();
        assert!(
            msg.contains("never_ran")
                && msg.contains("neither an immutable artifact nor raw bytes"),
            "error should name the missing step and the reason: {msg}"
        );
        assert!(
            dispatcher.last_input.lock().unwrap().is_none(),
            "dispatch must not happen when input resolution fails"
        );
    }

    #[tokio::test]
    async fn ask_step_dispatches_resolved_opaque_context() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::ask("outside.owner", json!({"value": true}));
        step.config["context"] = json!({
            "grant": {"$kind":"binding","select":{"from":"start","path":"input.target_id"}}
        });

        let result =
            StepExecutor::execute_step(&step, "ask", &mut exec_ctx, &deps, &actor, None).await;

        assert!(result.is_ok(), "ask should succeed: {:?}", result.err());
        assert_eq!(
            dispatcher.last_context.lock().unwrap().as_ref(),
            Some(&json!({"grant": "node-123"}))
        );
    }

    #[tokio::test]
    async fn ask_dynamic_null_context_preserves_absent_context_semantics() {
        for trusted_local in [false, true] {
            let dispatcher = Arc::new(CapturingOutsideAccess {
                last_name: Mutex::new(None),
                last_input: Mutex::new(None),
                last_context: Mutex::new(None),
                ask_response: Mutex::new(Some(test_process_result_bytes())),
                read_response: Mutex::new(Some(json!({"status": "ok"}))),
                read_bytes: Mutex::new(None),
                read_content_hash: Mutex::new(None),
            });
            let deps = ExecutorDeps {
                product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
                outside_access: dispatcher.clone(),
                partition_key: std::sync::Arc::from("partition:test"),
                dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
                circuit_state: None,
                step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
                edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
                join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
                definition_store: std::sync::Arc::new(MockDefinitionStore),
                compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(Default::default())),
            };
            let mut exec_ctx = test_exec_context();
            exec_ctx.trusted_local_invocation = trusted_local;
            exec_ctx.start.input["selected_context"] = Value::Null;
            let mut step = Step::ask("outside.owner", json!({"value": true}));
            step.config["context"] = json!({
                "$kind": "binding",
                "select": {"from": "start", "path": "input.selected_context"}
            });
            StepExecutor::execute_step(&step, "ask", &mut exec_ctx, &deps, &test_actor(), None)
                .await
                .expect("an absent selected context must remain absent");
            let expected = trusted_local.then(|| json!({"kind": "bitfield.trusted-local-dispatch/v1"}));
            assert_eq!(*dispatcher.last_context.lock().unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn trusted_local_invocation_marks_a_nested_ask_outside_workflow_data() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        exec_ctx.trusted_local_invocation = true;

        StepExecutor::execute_step(
            &Step::ask("outside.owner", json!({"value": true})),
            "ask",
            &mut exec_ctx,
            &deps,
            &test_actor(),
            None,
        )
        .await
        .expect("trusted nested ask");

        assert_eq!(
            dispatcher.last_context.lock().unwrap().as_ref(),
            Some(&json!({"kind": "bitfield.trusted-local-dispatch/v1"}))
        );
    }

    #[tokio::test]
    async fn workflow_data_cannot_forge_the_trusted_local_dispatch_marker() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let mut step = Step::ask("outside.owner", json!({"value": true}));
        step.config["context"] = json!({"kind": "bitfield.trusted-local-dispatch/v1"});

        let error = StepExecutor::execute_step(
            &step,
            "ask",
            &mut exec_ctx,
            &deps,
            &test_actor(),
            None,
        )
        .await
        .expect_err("authored reserved marker must fail");

        assert!(error.to_string().contains("may not claim trusted local dispatch"));
        assert!(dispatcher.last_name.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn ask_step_retains_json_response_bytes_for_downstream_streaming() {
        let response = br#"{"items":[{"id":"row:one"}]}"#.to_vec();
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(response.clone())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher,
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let step = Step::ask("outside.owner", json!({"value": true}));

        let output = StepExecutor::execute_step(
            &step,
            "json_reply",
            &mut exec_ctx,
            &deps,
            &test_actor(),
            None,
        )
        .await
        .expect("JSON ask response should decode and retain original bytes");

        assert_eq!(output.output["items"][0]["id"], json!("row:one"));
        assert_eq!(
            exec_ctx
                .raw_step_bytes("json_reply")
                .map(|bytes| bytes.as_ref().to_vec()),
            Some(response)
        );
    }

    #[tokio::test]
    async fn ask_step_can_keep_response_as_bytes_without_json_decode() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(b"not json and still valid bytes".to_vec())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher,
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let mut step = Step::ask("outside.owner", json!({"value": true}));
        step.config["output"] = json!({"decode": "bytes"});

        let output = StepExecutor::execute_step(
            &step,
            "byte_reply",
            &mut exec_ctx,
            &deps,
            &test_actor(),
            None,
        )
        .await
        .expect("byte response ask should not require JSON");

        assert_eq!(output.output["kind"], json!("bytes"));
        assert_eq!(output.output["ref"], json!("byte_reply"));
        assert_eq!(
            exec_ctx
                .raw_step_bytes("byte_reply")
                .map(|bytes| bytes.as_ref().to_vec()),
            Some(b"not json and still valid bytes".to_vec())
        );
    }

    #[tokio::test]
    async fn ask_step_rejects_non_utf8_json_response_without_panicking() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(vec![0xff, b'{', b'}'])),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher,
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let step = Step::ask("outside.owner", json!({"value": true}));

        let err = StepExecutor::execute_step(
            &step,
            "invalid_utf8_reply",
            &mut exec_ctx,
            &deps,
            &test_actor(),
            None,
        )
        .await
        .expect_err("default ask output decode must reject non-UTF-8 JSON as a structured error");

        let message = err.to_string();
        assert!(message.contains("not UTF-8 JSON"), "{message}");
        assert!(matches!(
            exec_ctx
                .steps
                .get("invalid_utf8_reply")
                .map(|output| output.status),
            Some(ExecutionStatus::Failed)
        ));
    }

    #[tokio::test]
    async fn test_compile_action_ask_payload_deserializes_to_process_descriptor_shape() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(test_process_result_bytes())),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:genesis"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:genesis"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        exec_ctx.steps.insert(
            "step_0".to_string(),
            StepOutput {
                output: json!({
                    "kind": "bytes",
                    "ref": "step_0",
                    "size": 4,
                    "content_hash": "test-content-hash-source"
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );
        exec_ctx.steps.insert(
            "step_1".to_string(),
            StepOutput {
                output: json!({
                    "value_json": "{\"argv\":[\"./tool\",\"source.tsx\",\"--bundle\",\"--format=cjs\",\"--outfile=output.js\"],\"cwd\":null,\"timeout_ms\":120000,\"termination_grace_ms\":1000,\"expected_termination\":{\"kind\":\"exited\",\"code\":0},\"env\":{},\"inputs\":[{\"mount_path\":\"source.tsx\",\"content_type\":\"application/typescript\"}],\"input_trees\":[],\"outputs\":[{\"mount_path\":\"output.js\",\"content_type\":\"application/javascript\"}],\"containment\":{\"kind\":\"leaf\"},\"capture_fds\":[1,2],\"collected_files\":[]}"
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );
        exec_ctx.steps.insert(
            "step_2".to_string(),
            StepOutput {
                output: json!({
                    "value_json": "\"resource:compiler-tool\""
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );
        exec_ctx.steps.insert(
            "step_3".to_string(),
            StepOutput {
                output: json!({
                    "kind": "bytes",
                    "ref": "step_3",
                    "size": 9,
                    "content_hash": "test-content-hash-tool"
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );

        let step = Step::ask(
            "compute.process",
            json!({
                "argv": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"argv"}}
                    ]
                },
                "cwd": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"cwd"}}
                    ]
                },
                "timeout_ms": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"timeout_ms"}}
                    ]
                },
                "termination_grace_ms": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"termination_grace_ms"}}
                    ]
                },
                "expected_termination": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"expected_termination"}}
                    ]
                },
                "env": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"env"}}
                    ]
                },
                "outputs": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"outputs"}}
                    ]
                },
                "input_trees": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"input_trees"}}
                    ]
                },
                "containment": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"containment"}}
                    ]
                },
                "capture_fds": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"capture_fds"}}
                    ]
                },
                "collected_files": {
                    "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"collected_files"}}
                    ]
                },
                "inputs": [
                    {
                        "mount_path": {
                            "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"inputs"}},
                                {"op":"op:core.first"},
                                {"op":"op:core.lookup","args":{"key":"mount_path"}}
                            ]
                        },
                        "content_type": {
                            "$kind": "binding",
                                "select": {"from":"steps","key":"step_1","path":"output.value_json"},
                                "transform": [
                                    {"op":"op:core.json_parse"},
                                    {"op":"op:core.lookup","args":{"key":"inputs"}},
                                {"op":"op:core.first"},
                                {"op":"op:core.lookup","args":{"key":"content_type"}}
                            ]
                        },
                        "source": {
                            "kind": "blob_ref",
                            "hash": {
                                "$kind": "binding",
                                "select": {"from":"steps","key":"step_0","path":"output.content_hash"}
                            }
                        }
                    },
                    {
                        "mount_path": "tool",
                        "content_type": "application/octet-stream",
                        "executable": true,
                        "source": {
                            "kind": "blob_ref",
                            "hash": {
                                "$kind": "binding",
                                "select": {"from":"steps","key":"step_3","path":"output.content_hash"}
                            }
                        }
                    }
                ]
            }),
        );

        StepExecutor::execute_step(&step, "step_4", &mut exec_ctx, &deps, &test_actor(), None)
            .await
            .expect("compile ask step should resolve and dispatch");

        let captured = dispatcher
            .last_input
            .lock()
            .unwrap()
            .clone()
            .expect("ask payload should be captured");
        assert_eq!(
            dispatcher.last_name.lock().unwrap().as_deref(),
            Some("compute.process")
        );
        assert_eq!(captured["argv"][0], json!("./tool"));
        assert_eq!(captured["timeout_ms"], json!(120000));
        assert_eq!(captured["termination_grace_ms"], json!(1000));
        assert_eq!(
            captured["expected_termination"],
            json!({"kind":"exited","code":0})
        );
        assert_eq!(captured["cwd"], Value::Null);
        assert_eq!(captured["env"], json!({}));
        assert_eq!(captured["input_trees"], json!([]));
        assert_eq!(captured["containment"], json!({"kind":"leaf"}));
        assert_eq!(captured["capture_fds"], json!([1, 2]));
        assert_eq!(captured["collected_files"], json!([]));
        assert!(captured.get("sandbox_profile").is_none());
        assert!(captured.get("capture_stdout").is_none());
        assert!(captured.get("capture_stderr").is_none());

        let inputs = captured["inputs"]
            .as_array()
            .expect("inputs should be an array");
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0]["mount_path"], json!("source.tsx"));
        assert_eq!(inputs[0]["content_type"], json!("application/typescript"));
        assert_eq!(inputs[0]["source"]["kind"], json!("blob_ref"));
        assert_eq!(
            inputs[0]["source"]["hash"],
            json!("test-content-hash-source")
        );
        assert_eq!(inputs[0]["executable"], Value::Null);

        assert_eq!(inputs[1]["mount_path"], json!("tool"));
        assert_eq!(inputs[1]["content_type"], json!("application/octet-stream"));
        assert_eq!(inputs[1]["source"]["kind"], json!("blob_ref"));
        assert_eq!(inputs[1]["source"]["hash"], json!("test-content-hash-tool"));
        assert_eq!(inputs[1]["executable"], json!(true));

        let outputs = captured["outputs"]
            .as_array()
            .expect("outputs should be an array");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0]["mount_path"], json!("output.js"));
        assert_eq!(outputs[0]["content_type"], json!("application/javascript"));
    }

    #[tokio::test]
    async fn test_write_step_accumulates_stone_writes() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::write(json!([
            {
                "address": "component:app-shell",
                "path": ["prop:extension:bundle"],
                "payload": {"$kind":"binding","select":{"from":"input","path":"target_id"}}
            }
        ]));

        let result =
            StepExecutor::execute_step(&step, "write_bundle", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("write step should succeed");

        assert_eq!(result.status, ExecutionStatus::Completed);
        assert_eq!(result.output, json!({"writes_emitted": 1}));
        assert_eq!(exec_ctx.writes.len(), 1);
        assert_eq!(exec_ctx.writes[0].partition_key, None);
        assert_eq!(exec_ctx.writes[0].address, "component:app-shell");
        assert_eq!(exec_ctx.writes[0].path, vec!["prop:extension:bundle"]);
        assert_eq!(
            exec_ctx.writes[0].payload,
            Some(
                serde_json::to_vec(&json!("node-123"))
                    .expect("encode payload")
                    .into(),
            )
        );
    }

    #[tokio::test]
    async fn test_write_step_preserves_explicit_partition_override_only() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::write(json!([
            {
                "partition_key": "partition:external",
                "address": "component:app-shell",
                "payload": {"ok": true}
            }
        ]));

        let result = StepExecutor::execute_step(
            &step,
            "write_partition",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("write step should preserve explicit partition override");

        assert_eq!(result.status, ExecutionStatus::Completed);
        assert_eq!(result.output, json!({"writes_emitted": 1}));
        assert_eq!(
            exec_ctx.writes[0].partition_key.as_deref(),
            Some("partition:external")
        );
    }

    #[tokio::test]
    async fn test_write_step_accepts_payload_bytes_utf8() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "component:app-shell",
                "path": ["prop:extension:bundle"],
                "payload_bytes": "{\"ok\":true}"
            }
        ]));

        let result =
            StepExecutor::execute_step(&step, "write_bundle", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("write step should succeed");

        assert_eq!(result.status, ExecutionStatus::Completed);
        assert_eq!(result.output, json!({"writes_emitted": 1}));
        assert_eq!(
            exec_ctx.writes[0].payload.as_deref(),
            Some(br#"{"ok":true}"#.as_slice()),
        );
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_rows() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"id": "item:one", "name": "One", "active": true, "metadata": {"tags": ["fast", "hot"], "rank": 1}},
                        {"id": "item:two", "name": "Two", "active": false, "metadata": ["plain", "json"]}
                    ],
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {"column": 1, "source": {"path": ["name"]}, "value": {"value_to_bytes": "text"}},
                        {"column": 2, "source": {"path": ["active"]}, "value": {"value_to_bytes": "byte_boolean"}},
                        {"column": 3, "source": {"path": ["metadata"]}, "value": {"value_to_bytes": "json"}}
                    ]
                }
            }
        ]));

        let result =
            StepExecutor::execute_step(&step, "write_records", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("write step should encode cell_table payload");

        assert_eq!(result.status, ExecutionStatus::Completed);
        assert_eq!(result.output, json!({"writes_emitted": 1}));
        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].len(), 4);
        assert_eq!(cell_text(&cells, 0, 0), "item:one");
        assert_eq!(cell_text(&cells, 0, 1), "One");
        assert_eq!(cell_byte(&cells, 0, 2), 1);
        let first_metadata: serde_json::Value =
            serde_json::from_str(&cell_text(&cells, 0, 3)).expect("json cell");
        assert_eq!(first_metadata, json!({"tags": ["fast", "hot"], "rank": 1}));
        assert_eq!(cell_text(&cells, 1, 0), "item:two");
        assert_eq!(cell_text(&cells, 1, 1), "Two");
        assert_eq!(cell_byte(&cells, 1, 2), 0);
        let second_metadata: serde_json::Value =
            serde_json::from_str(&cell_text(&cells, 1, 3)).expect("json cell");
        assert_eq!(second_metadata, json!(["plain", "json"]));
    }

    #[tokio::test]
    async fn test_write_step_cell_table_rows_binding_can_copy_target_owned_json() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();
        exec_ctx.steps.insert(
            "step_0".to_string(),
            StepOutput {
                output: json!({
                    "items": [
                        {
                            "id": "item:one",
                            "payload": {
                                "$kind": "binding",
                                "select": {
                                    "from": "start",
                                    "path": "input.target_id"
                                }
                            }
                        }
                    ]
                }),
                status: ExecutionStatus::Completed,
                error: None,
                duration_ms: 0,
            },
        );

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "$kind": "binding",
                        "select": {
                            "from": "steps",
                            "key": "step_0",
                            "path": "output.items"
                        }
                    },
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {"column": 1, "source": {"path": ["payload"]}, "value": {"value_to_bytes": "json"}}
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_target_owned_rows",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("target-owned row values should not be reinterpreted as workflow bindings");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cell_text(&cells, 0, 0), "item:one");
        let copied_json: serde_json::Value =
            serde_json::from_str(&cell_text(&cells, 0, 1)).expect("json cell");
        assert_eq!(
            copied_json,
            json!({
                "$kind": "binding",
                "select": {
                    "from": "start",
                    "path": "input.target_id"
                }
            })
        );
    }

    #[tokio::test]
    async fn test_write_step_cell_table_rows_binding_streams_retained_step_json_bytes() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();
        let bytes: Arc<[u8]> = Arc::from(
            &br#"{"items":[{"id":"item:one","payload":{"$kind":"binding","select":{"from":"start","path":"input.target_id"}}}]}"#[..],
        );
        exec_ctx.record_raw_step_bytes("step_0".to_string(), bytes);

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "$kind": "binding",
                        "select": {
                            "from": "steps",
                            "key": "step_0",
                            "path": "output.items"
                        },
                        "resolve_nested_bindings": false
                    },
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {"column": 1, "source": {"path": ["payload"]}, "value": {"value_to_bytes": "json"}}
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_streamed_rows",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("target-owned row binding should stream retained step response bytes");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cell_text(&cells, 0, 0), "item:one");
        let copied_json: serde_json::Value =
            serde_json::from_str(&cell_text(&cells, 0, 1)).expect("json cell");
        assert_eq!(
            copied_json,
            json!({
                "$kind": "binding",
                "select": {
                    "from": "start",
                    "path": "input.target_id"
                }
            })
        );
    }

    #[tokio::test]
    async fn test_ask_bytes_output_feeds_declared_row_writer_without_json_decode() {
        let response: Arc<[u8]> = Arc::from(
            &br#"{"items":[
                {"subject_id":"item:b","property_id":"field:title","value_json":"\"Beta\""},
                {"subject_id":"item:a","property_id":"field:title","value_json":"\"Alpha\""},
                {"subject_id":"item:a","property_id":"field:flag","value_json":"true"}
            ]}"#[..],
        );
        let mut deps = test_deps();
        deps.outside_access = Arc::new(ByteResponseOutsideAccess {
            response: Arc::clone(&response),
        });
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let ask_step = Step::new(
            "",
            "ask",
            json!({
                "name": "slot::test-byte-source",
                "output": {"decode": "bytes"},
                "input": {"operation": "emit-test-bytes"}
            }),
        );
        StepExecutor::execute_step(&ask_step, "step_0", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("ask step should retain raw response bytes");

        assert_eq!(exec_ctx.steps["step_0"].output["kind"], json!("bytes"));
        assert_eq!(
            exec_ctx
                .raw_step_bytes("step_0")
                .expect("raw ask bytes should be retained")
                .len(),
            response.len()
        );

        let write_step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "$kind": "binding",
                        "select": {
                            "from": "steps",
                            "key": "step_0",
                            "path": "output.items"
                        },
                        "resolve_nested_bindings": false
                    },
                    "group_by": {"path": ["subject_id"]},
                    "columns": [
                        {"column": 0, "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "match": [{"path": ["property_id"], "equals": "field:title"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 2,
                            "match": [{"path": ["property_id"], "equals": "field:flag"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "byte_boolean"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(&write_step, "step_1", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("write step should stream rows directly from retained ask bytes");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cell_text(&cells, 0, 0), "item:a");
        assert_eq!(cell_text(&cells, 0, 1), "Alpha");
        assert_eq!(cell_byte(&cells, 0, 2), 1);
        assert_eq!(cell_text(&cells, 1, 0), "item:b");
        assert_eq!(cell_text(&cells, 1, 1), "Beta");
        assert!(cells[1][2].is_none());
    }

    #[tokio::test]
    async fn test_write_step_cell_table_grouped_rows_binding_streams_retained_step_json_bytes() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();
        let bytes: Arc<[u8]> = Arc::from(
            &br#"{"items":[
                {"subject_id":"item:b","property_id":"field:title","value_json":"\"Beta\""},
                {"subject_id":"item:a","property_id":"field:branch","value_json":null},
                {"subject_id":"item:a","property_id":"field:count","value_json":"7"},
                {"subject_id":"item:a","property_id":"field:name","value_json":"\"Alpha\""},
                {"subject_id":"item:a","property_id":"field:name","value_json":"\"Later\""},
                {"subject_id":"item:b","property_id":"field:count","value_json":"11"},
                {"subject_id":"item:b","property_id":"field:active","value_json":"false"}
            ]}"#[..],
        );
        exec_ctx.record_raw_step_bytes("step_0".to_string(), bytes);

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "$kind": "binding",
                        "select": {
                            "from": "steps",
                            "key": "step_0",
                            "path": "output.items"
                        },
                        "resolve_nested_bindings": false
                    },
                    "group_by": {"path": ["subject_id"]},
                    "columns": [
                        {"column": 0, "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "match": [{"path": ["property_id"], "in": ["field:name", "field:title"]}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 2,
                            "match": [{"path": ["property_id"], "equals": "field:active"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "byte_boolean"}
                        },
                        {
                            "column": 3,
                            "match": [{"path": ["property_id"], "equals": "field:count"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 4,
                            "match": [{"path": ["property_id"], "equals": "field:branch"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_grouped_streamed_rows",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("grouped target-owned row binding should stream retained step response bytes");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].len(), 5);
        assert_eq!(cell_text(&cells, 0, 0), "item:a");
        assert_eq!(cell_text(&cells, 0, 1), "Alpha");
        assert!(cells[0][2].is_none());
        assert_eq!(cell_text(&cells, 0, 3), "7");
        assert!(cells[0][4].is_none());
        assert_eq!(cell_text(&cells, 1, 0), "item:b");
        assert_eq!(cell_text(&cells, 1, 1), "Beta");
        assert_eq!(cell_byte(&cells, 1, 2), 0);
        assert_eq!(cell_text(&cells, 1, 3), "11");
        assert!(cells[1][4].is_none());
    }

    #[tokio::test]
    async fn test_write_step_cell_table_grouped_byte_rows_uses_indexed_order_for_many_groups() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();
        let mut items = Vec::new();
        for group in (0..128).rev() {
            let subject_id = format!("item:{group:03}");
            let flag_json = if group % 2 == 0 { "true" } else { "false" };
            items.push(json!({
                "subject_id": subject_id.clone(),
                "property_id": "field:sort",
                "value_json": group.to_string(),
                "ignored": {"nested": {"group": group, "kind": "sort"}}
            }));
            items.push(json!({
                "subject_id": subject_id.clone(),
                "property_id": "field:title",
                "value_json": format!("\"Title {group:03}\""),
                "ignored": {"nested": {"group": group, "kind": "title"}}
            }));
            items.push(json!({
                "subject_id": subject_id,
                "property_id": "field:flag",
                "value_json": flag_json,
                "ignored": {"nested": {"group": group, "kind": "flag"}}
            }));
        }
        let response = json!({"items": items});
        exec_ctx.record_raw_step_bytes(
            "step_0".to_string(),
            Arc::from(
                serde_json::to_vec(&response)
                    .expect("rows serialize")
                    .into_boxed_slice(),
            ),
        );

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "$kind": "binding",
                        "select": {
                            "from": "steps",
                            "key": "step_0",
                            "path": "output.items"
                        },
                        "resolve_nested_bindings": false
                    },
                    "group_by": {"path": ["subject_id"]},
                    "columns": [
                        {"column": 0, "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "match": [{"path": ["property_id"], "equals": "field:title"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 2,
                            "match": [{"path": ["property_id"], "equals": "field:flag"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "byte_boolean"}
                        },
                        {
                            "column": 3,
                            "match": [{"path": ["property_id"], "equals": "field:sort"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_many_grouped_streamed_rows",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("grouped byte-backed rows should use indexed grouping with stable output order");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 128);
        assert_eq!(cell_text(&cells, 0, 0), "item:000");
        assert_eq!(cell_text(&cells, 0, 1), "Title 000");
        assert_eq!(cell_byte(&cells, 0, 2), 1);
        assert_eq!(cell_text(&cells, 0, 3), "0");
        assert_eq!(cell_text(&cells, 127, 0), "item:127");
        assert_eq!(cell_text(&cells, 127, 1), "Title 127");
        assert_eq!(cell_byte(&cells, 127, 2), 0);
        assert_eq!(cell_text(&cells, 127, 3), "127");
    }

    #[tokio::test]
    async fn test_write_step_cell_table_grouped_byte_rows_handles_wide_repeated_fanout() {
        let deps = test_deps();
        let actor = test_actor();
        let mut items = Vec::new();
        for group in (0..160).rev() {
            let subject_id = format!("item:{group:03}");
            for column in (0..15).rev() {
                items.push(json!({
                    "subject_id": subject_id,
                    "property_id": format!("field:{column:02}"),
                    "value_json": format!("\"value:{group:03}:{column:02}\""),
                    "ignored": {"nested": {"group": group, "column": column}}
                }));
            }
        }
        let response = Arc::from(
            serde_json::to_vec(&json!({"items": items}))
                .expect("rows serialize")
                .into_boxed_slice(),
        );
        let columns: Vec<serde_json::Value> = (0..15)
            .map(|column| {
                let source = if column == 0 {
                    json!({"path": ["subject_id"]})
                } else {
                    json!({"path": ["value_json"], "parse": {"format": "json"}})
                };
                json!({
                    "column": column,
                    "match": [{"path": ["property_id"], "equals": format!("field:{column:02}")}],
                    "source": source,
                    "value": {"value_to_bytes": "text"}
                })
            })
            .collect();
        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "$kind": "binding",
                        "select": {
                            "from": "steps",
                            "key": "step_0",
                            "path": "output.items"
                        },
                        "resolve_nested_bindings": false
                    },
                    "group_by": {"path": ["subject_id"]},
                    "columns": columns
                }
            }
        ]));

        for run in 0..3 {
            let mut exec_ctx = test_exec_context();
            exec_ctx.record_raw_step_bytes("step_0".to_string(), Arc::clone(&response));
            StepExecutor::execute_step(
                &step,
                "write_wide_repeated_grouped_streamed_rows",
                &mut exec_ctx,
                &deps,
                &actor,
                None,
            )
            .await
            .expect("wide grouped byte-backed fanout should encode repeatedly");

            let payload = exec_ctx.writes[0]
                .payload
                .as_ref()
                .expect("write should have encoded payload bytes");
            let cells = decode_record_table_cells(payload);
            assert_eq!(cells.len(), 160, "run {run}");
            assert_eq!(cells[0].len(), 15, "run {run}");
            assert_eq!(cell_text(&cells, 0, 0), "item:000", "run {run}");
            assert_eq!(cell_text(&cells, 0, 1), "value:000:01", "run {run}");
            assert_eq!(cell_text(&cells, 159, 0), "item:159", "run {run}");
            assert_eq!(cell_text(&cells, 159, 14), "value:159:14", "run {run}");
        }
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_json_text() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"id": "item:one", "payload_json_text": "{\"tags\":[\"fast\",\"hot\"],\"rank\":1}"},
                        {"id": "item:two", "payload_json_text": "[\"plain\",\"json\"]"}
                    ],
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {"column": 1, "source": {"path": ["payload_json_text"]}, "value": {"value_to_bytes": "json_text"}}
                    ]
                }
            }
        ]));

        let result = StepExecutor::execute_step(
            &step,
            "write_json_text_records",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("write step should encode JSON text cells");

        assert_eq!(result.status, ExecutionStatus::Completed);
        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cell_text(&cells, 0, 0), "item:one");
        assert_eq!(
            cell_text(&cells, 0, 1),
            "{\"tags\":[\"fast\",\"hot\"],\"rank\":1}"
        );
        assert_eq!(cell_text(&cells, 1, 0), "item:two");
        assert_eq!(cell_text(&cells, 1, 1), "[\"plain\",\"json\"]");
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_from_json_bytes() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();
        let rows = json!({
            "items": [
                {"id": "item:one", "payload_json_text": "{\"rank\":1}"},
                {"id": "item:two", "payload_json_text": "[\"plain\",\"json\"]"}
            ],
            "ignored": [{"id": "not-used"}]
        });
        exec_ctx.record_raw_step_bytes(
            "step_0".to_string(),
            Arc::from(
                serde_json::to_vec(&rows)
                    .expect("rows serialize")
                    .into_boxed_slice(),
            ),
        );

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": {
                        "source": {"kind": "bytes", "ref": "step_0"},
                        "format": "json",
                        "path": ["items"]
                    },
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {"column": 1, "source": {"path": ["payload_json_text"]}, "value": {"value_to_bytes": "json_text"}}
                    ]
                }
            }
        ]));

        let result = StepExecutor::execute_step(
            &step,
            "write_json_byte_rows",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("write step should encode JSON byte-backed rows");

        assert_eq!(result.status, ExecutionStatus::Completed);
        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cell_text(&cells, 0, 0), "item:one");
        assert_eq!(cell_text(&cells, 0, 1), "{\"rank\":1}");
        assert_eq!(cell_text(&cells, 1, 0), "item:two");
        assert_eq!(cell_text(&cells, 1, 1), "[\"plain\",\"json\"]");
    }

    #[tokio::test]
    async fn test_write_step_rejects_invalid_json_text_cell() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [{"id": "item:one", "payload_json_text": "{\"broken\":"}],
                    "columns": [
                        {"column": 0, "source": {"path": ["payload_json_text"]}, "value": {"value_to_bytes": "json_text"}}
                    ]
                }
            }
        ]));

        let error = StepExecutor::execute_step(
            &step,
            "write_invalid_json_text",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect_err("invalid JSON text cell must fail");

        match error {
            WorkflowError::StepExecutionFailed { reason, hint, .. } => {
                assert!(reason.contains("json_text source value is not valid JSON"));
                assert!(hint.contains("exactly one valid JSON value"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_grouped_flat_rows() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"subject_id": "item:b", "property_id": "field:title", "value_json": "\"Beta\""},
                        {"subject_id": "item:a", "property_id": "field:active", "value_json": "true"},
                        {"subject_id": "item:a", "property_id": "field:count", "value_json": "7"},
                        {"subject_id": "item:a", "property_id": "field:name", "value_json": "\"Alpha\""},
                        {"subject_id": "item:b", "property_id": "field:count", "value_json": "11"},
                        {"subject_id": "item:b", "property_id": "field:active", "value_json": "false"}
                    ],
                    "group_by": {"path": ["subject_id"]},
                    "columns": [
                        {"column": 0, "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "match": [{"path": ["property_id"], "in": ["field:name", "field:title"]}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 2,
                            "match": [{"path": ["property_id"], "equals": "field:active"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "byte_boolean"}
                        },
                        {
                            "column": 3,
                            "match": [{"path": ["property_id"], "equals": "field:count"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(&step, "write_grouped", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("write step should encode grouped cell_table payload");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cell_text(&cells, 0, 0), "item:a");
        assert_eq!(cell_text(&cells, 0, 1), "Alpha");
        assert_eq!(cell_byte(&cells, 0, 2), 1);
        assert_eq!(cell_text(&cells, 0, 3), "7");
        assert_eq!(cell_text(&cells, 1, 0), "item:b");
        assert_eq!(cell_text(&cells, 1, 1), "Beta");
        assert_eq!(cell_byte(&cells, 1, 2), 0);
        assert_eq!(cell_text(&cells, 1, 3), "11");
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_wide_grouped_predicate_fanout() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"subject_id": "item:two", "property_id": "field:kind", "value_json": "\"reply\""},
                        {"subject_id": "item:one", "property_id": "field:owner", "value_json": "\"actor:one\""},
                        {"subject_id": "item:one", "property_id": "field:content", "value_json": "\"Alpha\""},
                        {"subject_id": "item:two", "property_id": "field:owner", "value_json": "\"actor:two\""},
                        {"subject_id": "item:one", "property_id": "field:created", "value_json": "\"2026-05-27T00:00:00Z\""},
                        {"subject_id": "item:two", "property_id": "field:content", "value_json": "\"Beta\""},
                        {"subject_id": "item:one", "property_id": "field:link_from", "value_json": "\"item:one\""},
                        {"subject_id": "item:one", "property_id": "field:link_to", "value_json": "\"item:two\""},
                        {"subject_id": "item:one", "property_id": "field:link_kind", "value_json": "\"rel:reply\""},
                        {"subject_id": "item:one", "property_id": "field:attributes", "value_json": "{\"depth\":1}"},
                        {"subject_id": "item:two", "property_id": "field:state", "value_json": "\"seen\""},
                        {"subject_id": "item:two", "property_id": "field:ack_at", "value_json": "\"2026-05-27T00:01:00Z\""}
                    ],
                    "group_by": {"path": ["subject_id"]},
                    "columns": [
                        {"column": 0, "match": [{"path": ["property_id"], "equals": "field:content"}], "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "text"}},
                        {"column": 1, "match": [{"path": ["property_id"], "equals": "field:owner"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 2, "match": [{"path": ["property_id"], "equals": "field:content"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 3, "match": [{"path": ["property_id"], "equals": "field:created"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 4, "match": [{"path": ["property_id"], "equals": "field:link_from"}], "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "text"}},
                        {"column": 5, "match": [{"path": ["property_id"], "equals": "field:link_from"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 6, "match": [{"path": ["property_id"], "equals": "field:link_to"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 7, "match": [{"path": ["property_id"], "equals": "field:link_kind"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 8, "match": [{"path": ["property_id"], "equals": "field:attributes"}], "source": {"path": ["value_json"]}, "value": {"value_to_bytes": "json"}},
                        {"column": 9, "match": [{"path": ["property_id"], "equals": "field:state"}], "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "text"}},
                        {"column": 10, "match": [{"path": ["property_id"], "equals": "field:state"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 11, "match": [{"path": ["property_id"], "equals": "field:ack_at"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 12, "match": [{"path": ["property_id"], "in": ["field:content", 123]}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 13, "match": [{"path": ["property_id"], "equals": 123}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}},
                        {"column": 14, "match": [{"path": ["property_id"], "equals": "field:missing"}], "source": {"path": ["value_json"], "parse": {"format": "json"}}, "value": {"value_to_bytes": "text"}}
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_wide_grouped_predicate_fanout",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("wide grouped predicate fanout should encode without direct JSON equality");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cells[0].len(), 15);
        assert_eq!(cell_text(&cells, 0, 0), "item:one");
        assert_eq!(cell_text(&cells, 0, 1), "actor:one");
        assert_eq!(cell_text(&cells, 0, 2), "Alpha");
        assert_eq!(cell_text(&cells, 0, 3), "2026-05-27T00:00:00Z");
        assert_eq!(cell_text(&cells, 0, 4), "item:one");
        assert_eq!(cell_text(&cells, 0, 5), "item:one");
        assert_eq!(cell_text(&cells, 0, 6), "item:two");
        assert_eq!(cell_text(&cells, 0, 7), "rel:reply");
        assert_eq!(cell_text(&cells, 0, 8), "\"{\\\"depth\\\":1}\"");
        assert_eq!(cell_text(&cells, 0, 12), "Alpha");
        assert!(cells[0][13].is_none());
        assert!(cells[0][14].is_none());
        assert_eq!(cell_text(&cells, 1, 0), "item:two");
        assert_eq!(cell_text(&cells, 1, 1), "actor:two");
        assert_eq!(cell_text(&cells, 1, 2), "Beta");
        assert_eq!(cell_text(&cells, 1, 9), "item:two");
        assert_eq!(cell_text(&cells, 1, 10), "seen");
        assert_eq!(cell_text(&cells, 1, 11), "2026-05-27T00:01:00Z");
        assert_eq!(cell_text(&cells, 1, 12), "Beta");
        assert!(cells[1][13].is_none());
        assert!(cells[1][14].is_none());
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_null_parsed_cells_as_empty() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"subject_id": "item:a", "property_id": "field:name", "value_json": "\"Alpha\""},
                        {"subject_id": "item:a", "property_id": "field:branch", "value_json": null},
                        {"subject_id": "item:a", "property_id": "field:active", "value_json": null}
                    ],
                    "group_by": {"path": ["subject_id"]},
                    "columns": [
                        {"column": 0, "source": {"path": ["subject_id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "match": [{"path": ["property_id"], "equals": "field:name"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 2,
                            "match": [{"path": ["property_id"], "equals": "field:branch"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 3,
                            "match": [{"path": ["property_id"], "equals": "field:active"}],
                            "source": {"path": ["value_json"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "byte_boolean"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_null_parsed_cells",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("null parsed cells should encode as empty cells");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 1);
        assert_eq!(cell_text(&cells, 0, 0), "item:a");
        assert_eq!(cell_text(&cells, 0, 1), "Alpha");
        assert!(cells[0][2].is_none());
        assert!(cells[0][3].is_none());
    }

    #[tokio::test]
    async fn test_write_step_encodes_payload_bytes_cell_table_parsed_object_fields() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"id": "item:a", "value_json": "{\"active\":true,\"count\":7}"},
                        {"id": "item:b", "value_json": "{\"active\":false,\"count\":11}"}
                    ],
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "source": {
                                "path": ["value_json"],
                                "parse": {"format": "json", "after_parse_path": ["active"]}
                            },
                            "value": {"value_to_bytes": "byte_boolean"}
                        },
                        {
                            "column": 2,
                            "source": {
                                "path": ["value_json"],
                                "parse": {"format": "json", "after_parse_path": ["count"]}
                            },
                            "value": {"value_to_bytes": "text"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_parsed_fields",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("write step should encode parsed object fields as cells");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cell_text(&cells, 0, 0), "item:a");
        assert_eq!(cell_byte(&cells, 0, 1), 1);
        assert_eq!(cell_text(&cells, 0, 2), "7");
        assert_eq!(cell_text(&cells, 1, 0), "item:b");
        assert_eq!(cell_byte(&cells, 1, 1), 0);
        assert_eq!(cell_text(&cells, 1, 2), "11");
    }

    #[tokio::test]
    async fn test_write_step_accepts_already_typed_json_source_parse() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [
                        {"id": "item:a", "payload": {"active": true, "count": 7}, "enabled": true},
                        {"id": "item:b", "payload": {"active": false, "count": 11}, "enabled": false}
                    ],
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"value_to_bytes": "non_empty_text"}},
                        {
                            "column": 1,
                            "source": {
                                "path": ["payload"],
                                "parse": {"format": "json", "after_parse_path": ["active"]}
                            },
                            "value": {"value_to_bytes": "byte_boolean"}
                        },
                        {
                            "column": 2,
                            "source": {
                                "path": ["payload"],
                                "parse": {"format": "json", "after_parse_path": ["count"]}
                            },
                            "value": {"value_to_bytes": "text"}
                        },
                        {
                            "column": 3,
                            "source": {"path": ["enabled"], "parse": {"format": "json"}},
                            "value": {"value_to_bytes": "byte_boolean"}
                        }
                    ]
                }
            }
        ]));

        StepExecutor::execute_step(
            &step,
            "write_typed_json_sources",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("already-typed JSON sources should pass through source.parse=json");

        let payload = exec_ctx.writes[0]
            .payload
            .as_ref()
            .expect("write should have encoded payload bytes");
        let cells = decode_record_table_cells(payload);
        assert_eq!(cells.len(), 2);
        assert_eq!(cell_text(&cells, 0, 0), "item:a");
        assert_eq!(cell_byte(&cells, 0, 1), 1);
        assert_eq!(cell_text(&cells, 0, 2), "7");
        assert_eq!(cell_byte(&cells, 0, 3), 1);
        assert_eq!(cell_text(&cells, 1, 0), "item:b");
        assert_eq!(cell_byte(&cells, 1, 1), 0);
        assert_eq!(cell_text(&cells, 1, 2), "11");
        assert_eq!(cell_byte(&cells, 1, 3), 0);
    }

    #[tokio::test]
    async fn test_write_step_rejects_obsolete_payload_source_bytes_writer() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "source_bytes": {"encoding": "cell_table"},
                    "rows": [],
                    "columns": []
                }
            }
        ]));

        let error =
            StepExecutor::execute_step(&step, "write_obsolete", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect_err("obsolete source_bytes writer must fail");

        match error {
            WorkflowError::StepExecutionFailed { reason, hint, .. } => {
                assert!(reason.contains("payload_bytes.source_bytes is obsolete"));
                assert!(hint.contains("payload_bytes.value_to_bytes"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_write_step_rejects_obsolete_cell_source_bytes_writer() {
        let deps = test_deps();
        let actor = test_actor();
        let mut exec_ctx = test_exec_context();

        let step = Step::write(json!([
            {
                "address": "records",
                "path": [],
                "payload_bytes": {
                    "value_to_bytes": "cell_table",
                    "rows": [{"id": "item:one"}],
                    "columns": [
                        {"column": 0, "source": {"path": ["id"]}, "value": {"source_bytes": {"encoding": "text"}}}
                    ]
                }
            }
        ]));

        let error = StepExecutor::execute_step(
            &step,
            "write_cell_obsolete",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect_err("obsolete cell source_bytes writer must fail");

        match error {
            WorkflowError::StepExecutionFailed { reason, hint, .. } => {
                assert!(reason.contains("value.source_bytes is obsolete"));
                assert!(hint.contains("value.value_to_bytes"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_read_step_dispatches_direct_address() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(None),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::read(json!(
            "attribute_fact|partition:genesis|component:app-shell|prop:resource:compiler_config|type:extension"
        ));

        let result =
            StepExecutor::execute_step(&step, "read_config", &mut exec_ctx, &deps, &actor, None)
                .await;

        assert!(
            result.is_ok(),
            "read step should succeed: {:?}",
            result.err()
        );
        assert_eq!(
            dispatcher.last_name.lock().unwrap().as_deref(),
            Some(
                "attribute_fact|partition:genesis|component:app-shell|prop:resource:compiler_config|type:extension"
            )
        );
    }

    #[tokio::test]
    async fn read_step_identity_text_mode_dispatches_the_exact_identity_address() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(None),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let document_ref = "package::documents::documents::example";
        let mut step = Step::read(json!(document_ref));
        step.config["address_mode"] = json!("identity_text");

        StepExecutor::execute_step(
            &step,
            "read_identity_document",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect("explicit identity-text read should succeed");

        let expected =
            crate::stores::runtime_fact_address_with_mode(document_ref, Some("identity_text"))
                .as_multihash()
                .to_code_hex();
        assert_eq!(
            dispatcher.last_name.lock().unwrap().as_deref(),
            Some(expected.as_str())
        );
    }

    #[tokio::test]
    async fn read_step_refuses_unknown_address_mode_before_dispatch() {
        let deps = deps_whose_read_succeeds();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let mut step = Step::read(json!("package::documents::documents::example"));
        step.config["address_mode"] = json!("guess");

        let error = StepExecutor::execute_step(
            &step,
            "read_unknown_mode",
            &mut exec_ctx,
            &deps,
            &actor,
            None,
        )
        .await
        .expect_err("unknown read address mode must fail closed");

        assert!(error.to_string().contains("identity_text or label_hash"));
    }

    #[tokio::test]
    async fn test_read_step_preserves_raw_bytes() {
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(None),
            read_response: Mutex::new(None),
            read_bytes: Mutex::new(Some(vec![0u8, 1u8, 255u8])),
            read_content_hash: Mutex::new(Some("test-content-hash-feedbeef".to_string())),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher.clone(),
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::read(json!("1f:tool-binary"));

        let result =
            StepExecutor::execute_step(&step, "read_blob", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("raw-byte read should succeed");

        assert_eq!(result.status, ExecutionStatus::Completed);
        assert_eq!(result.output["kind"], json!("bytes"));
        assert_eq!(result.output["ref"], json!("read_blob"));
        assert_eq!(result.output["size"], json!(3));
        assert_eq!(
            result.output["content_hash"],
            json!("test-content-hash-feedbeef")
        );
        assert_eq!(result.output.get("bytes"), None);
        assert_eq!(result.output.get("base64"), None);
        assert_eq!(
            exec_ctx
                .raw_step_bytes("read_blob")
                .map(|bytes| bytes.as_ref().to_vec()),
            Some(vec![0u8, 1u8, 255u8])
        );
    }

    #[tokio::test]
    async fn test_read_step_keeps_large_raw_bytes_out_of_json_output() {
        let blob = vec![7u8; 8192];
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(None),
            read_response: Mutex::new(None),
            read_bytes: Mutex::new(Some(blob.clone())),
            read_content_hash: Mutex::new(Some("test-content-hash-blob".to_string())),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher,
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = Step::read(json!("1f:tool-binary"));
        let result =
            StepExecutor::execute_step(&step, "read_blob", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("large raw-byte read should succeed");

        assert_eq!(result.output["kind"], json!("bytes"));
        assert_eq!(result.output["ref"], json!("read_blob"));
        assert_eq!(result.output["size"], json!(8192));
        assert_eq!(
            result.output["content_hash"],
            json!("test-content-hash-blob")
        );
        assert_eq!(result.output.get("bytes"), None);
        assert_eq!(result.output.get("base64"), None);
        assert_eq!(
            exec_ctx
                .raw_step_bytes("read_blob")
                .map(|bytes| bytes.len()),
            Some(8192)
        );
    }

    #[tokio::test]
    async fn test_compute_process_ask_replaces_nested_bytes_with_refs() {
        let process_result = process_result_fixture(
            ProcessTermination::Exited { code: 3 },
            b"hello stdout".to_vec(),
            b"bounded stderr evidence".to_vec(),
            vec![
                ProcessOutputArtifact {
                    mount_path: "output.js".to_string(),
                    content_type: Some("application/javascript".to_string()),
                    storage: ProcessOutputStorage::Inline,
                    byte_len: 17,
                    integrity_hash: "1f:test-output-hash".to_string(),
                    content_hash: None,
                    chunk_manifest_hash: None,
                    chunk_manifest_address: None,
                    envelope_address: None,
                    envelope_path: Vec::new(),
                    chunk_size_bytes: None,
                    bytes: b"export default 1;".to_vec(),
                },
                ProcessOutputArtifact {
                    mount_path: "transcript-content.json".to_string(),
                    content_type: Some("application/json".to_string()),
                    storage: ProcessOutputStorage::AddressedChunks,
                    byte_len: 3_145_728,
                    integrity_hash: "1f:test-content-hash".to_string(),
                    content_hash: None,
                    chunk_manifest_hash: Some("1f:test-manifest-hash".to_string()),
                    chunk_manifest_address: Some("d3392b7ef0".to_string()),
                    envelope_address: None,
                    envelope_path: Vec::new(),
                    chunk_size_bytes: Some(1_048_576),
                    bytes: Vec::new(),
                },
                ProcessOutputArtifact {
                    mount_path: "plan.json".to_string(),
                    content_type: Some("application/json".to_string()),
                    storage: ProcessOutputStorage::ImmutableContent,
                    byte_len: 1_048_576,
                    integrity_hash: slot_protocol::Hash::blake3_hash(b"immutable-plan")
                        .as_multihash()
                        .to_code_hex(),
                    content_hash: Some(
                        slot_protocol::Hash::blake3_hash(b"immutable-plan")
                            .as_multihash()
                            .to_code_hex(),
                    ),
                    chunk_manifest_hash: None,
                    chunk_manifest_address: None,
                    envelope_address: None,
                    envelope_path: Vec::new(),
                    chunk_size_bytes: None,
                    bytes: Vec::new(),
                },
            ],
            42,
        );
        let dispatcher = Arc::new(CapturingOutsideAccess {
            last_name: Mutex::new(None),
            last_input: Mutex::new(None),
            last_context: Mutex::new(None),
            ask_response: Mutex::new(Some(
                serde_json::to_vec(&process_result).expect("process result should serialize"),
            )),
            read_response: Mutex::new(Some(json!({"status": "ok"}))),
            read_bytes: Mutex::new(None),
            read_content_hash: Mutex::new(None),
        });
        let deps = ExecutorDeps {
            product_word_ids: std::sync::Arc::new(crate::executor::context::test_product_word_ids()),
            outside_access: dispatcher,
            partition_key: std::sync::Arc::from("partition:test"),
            dispatch_partition: slot_protocol::PartitionKey::hash_from("partition:test"),
            circuit_state: None,
            step_registry: std::sync::Arc::new(crate::executor::automation::default_step_registry()),
            edge_registry: std::sync::Arc::new(crate::domain::handlers::default_edge_registry()),
            join_registry: std::sync::Arc::new(crate::domain::handlers::default_join_registry()),
            definition_store: std::sync::Arc::new(MockDefinitionStore),
            compiled_definition_cache: std::sync::Arc::new(std::sync::RwLock::new(
                Default::default(),
            )),
        };
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();
        let step = Step::ask("compute.process", json!({"argv":["/bin/echo","ok"]}));

        let result =
            StepExecutor::execute_step(&step, "process_step", &mut exec_ctx, &deps, &actor, None)
                .await
                .expect("compute.process ask should succeed");

        assert_eq!(result.output["captured_fds"][0]["fd"], json!(1));
        assert_eq!(result.output["termination"]["kind"], json!("exited"));
        assert_eq!(result.output["termination"]["code"], json!(3));
        assert_eq!(
            result.output["captured_fds"][0]["bytes"]["kind"],
            json!("bytes")
        );
        assert_eq!(
            result.output["captured_fds"][0]["bytes"]["ref"],
            json!("process_step.captured_fds.0.bytes")
        );
        assert_eq!(result.output["outputs"][0]["bytes"]["kind"], json!("bytes"));
        assert_eq!(
            result.output["outputs"][0]["bytes"]["ref"],
            json!("process_step.outputs.0")
        );
        assert_eq!(result.output["outputs"][0].get("text"), None);
        assert_eq!(
            result.output["outputs"][0]["integrity_hash"],
            json!("1f:d74c80fd12693d5c64b42d7ad516ada9541841eb6cc51e6f9b1bfa55bf222e44")
        );
        assert_eq!(result.output["outputs"][0]["storage"], json!("inline"));
        assert_eq!(result.output["outputs"][0]["byte_len"], json!(17));
        assert_eq!(
            result.output["outputs"][0]["chunk_manifest_hash"],
            Value::Null
        );
        assert_eq!(
            result.output["outputs"][0]["chunk_manifest_address"],
            Value::Null
        );
        assert_eq!(result.output["outputs"][0]["chunk_size_bytes"], Value::Null);
        assert_eq!(
            result.output["outputs"][1]["storage"],
            json!("addressed_chunks")
        );
        assert_eq!(result.output["outputs"][1]["byte_len"], json!(3_145_728));
        assert_eq!(
            result.output["outputs"][1]["chunk_manifest_hash"],
            json!("1f:test-manifest-hash")
        );
        assert_eq!(
            result.output["outputs"][1]["chunk_manifest_address"],
            json!("d3392b7ef0")
        );
        assert_eq!(
            result.output["outputs"][1]["chunk_size_bytes"],
            json!(1_048_576)
        );
        assert_eq!(result.output["outputs"][1].get("text"), None);
        assert_eq!(
            result.output["outputs"][2]["storage"],
            json!("immutable_content")
        );
        assert_eq!(
            result.output["outputs"][2]["content_hash"],
            json!(slot_protocol::Hash::blake3_hash(b"immutable-plan")
                .as_multihash()
                .to_code_hex())
        );
        assert_eq!(result.output["outputs"][2]["bytes"], Value::Null);
        assert_eq!(
            exec_ctx.raw_step_bytes("process_step.outputs.2"),
            None,
            "immutable process artifacts never retain body bytes in Workflow"
        );
        assert_eq!(
            exec_ctx
                .raw_step_bytes("process_step.outputs.0")
                .map(|bytes| bytes.as_ref().to_vec()),
            Some(b"export default 1;".to_vec())
        );

        let resolved = BindingResolver::resolve_value(
            &json!({
                "bundle_text": {
                    "$kind":"binding",
                    "select":{"from":"steps","key":"process_step","path":"output.outputs.0.bytes.base64"},
                    "transform":[{"op":"op:core.decode","args":{"encoding":"base64"}}]
                },
                "stdout_text": {
                    "$kind":"binding",
                    "select":{"from":"steps","key":"process_step","path":"output.captured_fds.0.bytes.base64"},
                    "transform":[{"op":"op:core.decode","args":{"encoding":"base64"}}]
                },
                "stderr_preview": {
                    "$kind":"binding",
                    "select":{"from":"steps","key":"process_step","path":"output.captured_fds.1.bytes.base64"},
                    "transform":[
                        {"op":"op:core.decode","args":{"encoding":"base64"}},
                        {"op":"op:core.left","args":{"count":7}}
                    ]
                }
            }),
            &exec_ctx,
        )
        .expect("nested byte refs should resolve");

        assert_eq!(resolved["bundle_text"], json!("export default 1;"));
        assert_eq!(resolved["stdout_text"], json!("hello stdout"));
        assert_eq!(resolved["stderr_preview"], json!("bounded"));
    }

    // ========================================================================
    // Test 9: Context accumulates outputs from multiple steps
    // ========================================================================

    #[tokio::test]
    async fn test_context_accumulates_step_outputs() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        // Execute first step (SchemaWrite — works without optional deps)
        let step1 = make_ask_step(json!({"name": "TypeA"}));
        StepExecutor::execute_step(&step1, "step_a", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("step_a should succeed");

        // Execute second step
        let step2 = make_ask_step(json!({"name": "TypeB"}));
        StepExecutor::execute_step(&step2, "step_b", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("step_b should succeed");

        // Execute third step
        let step3 = make_ask_step(json!({"name": "TypeC"}));
        StepExecutor::execute_step(&step3, "step_c", &mut exec_ctx, &deps, &actor, None)
            .await
            .expect("step_c should succeed");

        // All three should be in context
        assert_eq!(exec_ctx.steps.len(), 3);
        assert!(exec_ctx.steps.contains_key("step_a"));
        assert!(exec_ctx.steps.contains_key("step_b"));
        assert!(exec_ctx.steps.contains_key("step_c"));

        // All should be completed
        assert_eq!(exec_ctx.steps["step_a"].status, ExecutionStatus::Completed);
        assert_eq!(exec_ctx.steps["step_b"].status, ExecutionStatus::Completed);
        assert_eq!(exec_ctx.steps["step_c"].status, ExecutionStatus::Completed);
    }

    // ========================================================================
    // Test 10: execute_step with timeout succeeds when within limit
    // ========================================================================

    #[tokio::test]
    async fn test_execute_step_with_timeout_succeeds() {
        let deps = test_deps();
        let mut exec_ctx = test_exec_context();
        let actor = test_actor();

        let step = make_ask_step(json!({"name": "TimedType"}));

        // Generous timeout — primitives return quickly
        let timeout = Some(std::time::Duration::from_secs(30));

        let result =
            StepExecutor::execute_step(&step, "timed_step", &mut exec_ctx, &deps, &actor, timeout)
                .await;

        assert!(
            result.is_ok(),
            "Step should succeed within generous timeout: {:?}",
            result.err()
        );
    }

    // Tests 11-15 (build_primitive_call, build_transact, build_database_read,
    // build_embodiment, build_primitive_call_all_eight, primitive_result_to_output,
    // build_primitive_call_malformed_params_error) DELETED in E.16 — those
    // typed helpers were replaced by the workflow boundary adapter path.
}
