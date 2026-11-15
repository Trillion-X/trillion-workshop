//! # Journal Projector
//!
//! Projects journal entries into ExecutionContext — the memoization index.
//! On recovery, reads all journal entries for a workflow and rebuilds
//! ctx.steps so the executor can skip completed steps (cursor-based resume).

use crate::domain::journal::{CborValue, JournalEntry, StatePayload, WorkflowJournalRecord};
use crate::domain::types::{ExecutionStatus, StepOutput};
use std::collections::HashMap;

/// Projects journal entries into a step output map (memoization index).
pub struct JournalProjector;

impl JournalProjector {
    /// Build step outputs from journal entries.
    ///
    /// Scans entries and extracts StepCompleted/StepFailed into a HashMap
    /// that can be merged into ExecutionContext.steps.
    pub fn project_steps(entries: &[WorkflowJournalRecord]) -> HashMap<String, StepOutput> {
        let mut steps = HashMap::new();

        for record in entries {
            match &record.payload.entry {
                JournalEntry::StepCompleted {
                    step_id,
                    output,
                    duration_ns,
                } => {
                    let value = cbor_to_json_value(&output.value);
                    steps.insert(
                        step_id.clone(),
                        StepOutput {
                            output: value,
                            status: ExecutionStatus::Completed,
                            error: None,
                            duration_ms: (duration_ns / 1_000_000) as i64,
                        },
                    );
                }
                JournalEntry::StepFailed { step_id, error, .. } => {
                    steps.insert(
                        step_id.clone(),
                        StepOutput {
                            output: serde_json::Value::Null,
                            status: ExecutionStatus::Failed,
                            error: Some(error.message.clone()),
                            duration_ms: 0,
                        },
                    );
                }
                _ => {} // Other entry types don't contribute to step outputs
            }
        }

        steps
    }

    /// Recover materialized execution state from a Snapshot entry.
    ///
    /// Extracts the ExecutionState from a snapshot and returns the step results.
    /// Returns None if the snapshot uses an external reference (not yet loaded).
    pub fn project_snapshot(payload: &StatePayload) -> Option<HashMap<String, StepOutput>> {
        match payload {
            StatePayload::Inline(state) => {
                let mut steps = HashMap::new();
                for (step_id, output) in &state.step_results {
                    let value = cbor_to_json_value(&output.value);
                    steps.insert(
                        step_id.clone(),
                        StepOutput {
                            output: value,
                            status: ExecutionStatus::Completed,
                            error: None,
                            duration_ms: 0,
                        },
                    );
                }
                Some(steps)
            }
            StatePayload::External(_) => None, // External ref not yet loaded
        }
    }
}

/// Convert CborValue to serde_json::Value for template resolution compatibility.
fn cbor_to_json_value(cbor: &CborValue) -> serde_json::Value {
    match cbor {
        CborValue::Null => serde_json::Value::Null,
        CborValue::Bool(b) => serde_json::Value::Bool(*b),
        CborValue::Integer(n) => serde_json::json!(*n),
        CborValue::Float(f) => serde_json::json!(*f),
        CborValue::Text(s) => {
            // Try parsing as JSON first (step outputs are JSON-serialized text)
            serde_json::from_str(s).unwrap_or_else(|_| serde_json::Value::String(s.clone()))
        }
        CborValue::Bytes(b) => {
            serde_json::Value::String(b.iter().map(|byte| format!("{:02x}", byte)).collect())
        }
        CborValue::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(cbor_to_json_value).collect())
        }
        CborValue::Map(entries) => {
            let obj: serde_json::Map<String, serde_json::Value> = entries
                .iter()
                .map(|(k, v)| (k.clone(), cbor_to_json_value(v)))
                .collect();
            serde_json::Value::Object(obj)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::journal::{
        CborValue, DurabilityErrorCode, ErrorAction, ExecutionState, ExternalRef, JournalEntry,
        KeyType, LeaseBinding, PrimitivePermissions, StatePayload, StepError,
        StepOutput as JournalStepOutput, WorkflowEnvelope, WorkflowJournalRecord,
    };
    use crate::domain::journal::{ChangeAuthor, Timestamp, GENESIS_HASH};
    use chrono::Utc;

    fn make_lease_binding() -> LeaseBinding {
        LeaseBinding {
            lease_id: "lease-1".to_string(),
            device_id: "device-1".to_string(),
            user_id: "user-1".to_string(),
            expires_at: 2000,
            max_offline_ticks: 100,
            journal_key_type: KeyType::Software,
            primitive_permissions: PrimitivePermissions::default(),
        }
    }

    fn make_record(entry: JournalEntry) -> WorkflowJournalRecord {
        WorkflowJournalRecord {
            id: "rec-test".to_string(),
            timestamp: Timestamp::from_datetime(Utc::now()),
            actor: ChangeAuthor {
                actor_id: "user-1".to_string(),
            },
            prev_hash: GENESIS_HASH.to_string(),
            payload: WorkflowEnvelope {
                local_seq: 1,
                workflow_id: "wf-1".to_string(),
                hlc: 1000,
                lease_binding: make_lease_binding(),
                entry,
            },
        }
    }

    #[test]
    fn test_project_empty() {
        let steps = JournalProjector::project_steps(&[]);
        assert!(steps.is_empty());
    }

    #[test]
    fn test_project_step_completed() {
        let entries = vec![make_record(JournalEntry::StepCompleted {
            step_id: "step_1".to_string(),
            output: JournalStepOutput {
                value: CborValue::Text(r#"{"id":"abc"}"#.to_string()),
            },
            duration_ns: 150_000_000, // 150 ms
        })];
        let steps = JournalProjector::project_steps(&entries);
        assert_eq!(steps.len(), 1);
        let step = &steps["step_1"];
        assert_eq!(step.status, ExecutionStatus::Completed);
        assert_eq!(step.duration_ms, 150);
        assert_eq!(step.output, serde_json::json!({"id": "abc"}));
    }

    #[test]
    fn test_project_step_failed() {
        let entries = vec![make_record(JournalEntry::StepFailed {
            step_id: "step_fail".to_string(),
            error: StepError {
                code: DurabilityErrorCode::ResourceExhausted,
                message: "out of memory".to_string(),
                remediation: None,
            },
            action: ErrorAction::Abort,
        })];
        let steps = JournalProjector::project_steps(&entries);
        assert_eq!(steps.len(), 1);
        let step = &steps["step_fail"];
        assert_eq!(step.status, ExecutionStatus::Failed);
        assert_eq!(step.error, Some("out of memory".to_string()));
    }

    #[test]
    fn test_project_ignores_non_step_entries() {
        let entries = vec![make_record(JournalEntry::VersionChange {
            old_definition_id: "def-v1".to_string(),
            new_definition_id: "def-v2".to_string(),
        })];
        let steps = JournalProjector::project_steps(&entries);
        assert!(steps.is_empty());
    }

    #[test]
    fn test_last_writer_wins() {
        let entries = vec![
            make_record(JournalEntry::StepCompleted {
                step_id: "step_1".to_string(),
                output: JournalStepOutput {
                    value: CborValue::Text("\"old\"".to_string()),
                },
                duration_ns: 100_000_000,
            }),
            make_record(JournalEntry::StepCompleted {
                step_id: "step_1".to_string(),
                output: JournalStepOutput {
                    value: CborValue::Text("\"new\"".to_string()),
                },
                duration_ns: 200_000_000,
            }),
        ];
        let steps = JournalProjector::project_steps(&entries);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps["step_1"].output, serde_json::json!("new"));
        assert_eq!(steps["step_1"].duration_ms, 200);
    }

    #[test]
    fn test_cbor_to_json_primitives() {
        assert_eq!(
            cbor_to_json_value(&CborValue::Null),
            serde_json::Value::Null
        );
        assert_eq!(
            cbor_to_json_value(&CborValue::Bool(true)),
            serde_json::json!(true)
        );
        assert_eq!(
            cbor_to_json_value(&CborValue::Integer(42)),
            serde_json::json!(42)
        );
        assert_eq!(
            cbor_to_json_value(&CborValue::Float(1.25)),
            serde_json::json!(1.25)
        );
        assert_eq!(
            cbor_to_json_value(&CborValue::Text("hello".to_string())),
            serde_json::json!("hello")
        );
    }

    #[test]
    fn test_cbor_to_json_array() {
        let arr = CborValue::Array(vec![
            CborValue::Integer(1),
            CborValue::Bool(true),
            CborValue::Text("item".to_string()),
        ]);
        let result = cbor_to_json_value(&arr);
        assert_eq!(result, serde_json::json!([1, true, "item"]));
    }

    #[test]
    fn test_cbor_to_json_map() {
        let map = CborValue::Map(vec![
            ("key1".to_string(), CborValue::Text("value1".to_string())),
            ("key2".to_string(), CborValue::Integer(42)),
        ]);
        let result = cbor_to_json_value(&map);
        assert_eq!(result, serde_json::json!({"key1": "value1", "key2": 42}));
    }

    #[test]
    fn test_project_snapshot_inline() {
        let state = ExecutionState {
            step_results: vec![(
                "step_1".to_string(),
                JournalStepOutput {
                    value: CborValue::Text("\"result\"".to_string()),
                },
            )]
            .into_iter()
            .collect(),
            idempotency_map: Default::default(),
            cursor: 1000,
            speculative_depth: 0,
        };
        let payload = StatePayload::Inline(state);
        let steps = JournalProjector::project_snapshot(&payload).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps["step_1"].output, serde_json::json!("result"));
    }

    #[test]
    fn test_project_snapshot_external() {
        let ext_ref = ExternalRef {
            hash: [1u8; 32],
            size_bytes: 1024,
            media_type: "application/json".to_string(),
        };
        let payload = StatePayload::External(ext_ref);
        let result = JournalProjector::project_snapshot(&payload);
        assert!(result.is_none());
    }

    #[test]
    fn test_duration_ns_to_ms_conversion() {
        let entries = vec![make_record(JournalEntry::StepCompleted {
            step_id: "step_1".to_string(),
            output: JournalStepOutput {
                value: CborValue::Integer(42),
            },
            duration_ns: 5_000_000, // 5 ms
        })];
        let steps = JournalProjector::project_steps(&entries);
        assert_eq!(steps["step_1"].duration_ms, 5);
    }
}
