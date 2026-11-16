use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::process_types::ProcessDescriptor;
use crate::ExecutionError;
use crate::ProductWordIds;
use crate::ProcessWorkspaceExecutionBindings;

/// Canonical addressed feed label for current process-session snapshots.
pub const PROCESS_SESSIONS_FEED_LABEL: &str = "process-sessions";

/// Canonical addressed feed label for ordered process-session events.
pub const PROCESS_SESSION_EVENTS_FEED_LABEL: &str = "process-session-events";
/// Address label for the per-session event STREAM: the append lane where each
/// event lands once as a version-3 delta. Distinct from the events-feed
/// address, which holds the bounded version-2 HEAD projection — one address,
/// one record type.
pub const PROCESS_SESSION_EVENT_STREAM_LABEL: &str = "process-session-event-stream";

/// Address label for the per-session terminal output record: the authoritative
/// full accumulated output, written once at session termination after both
/// output EOF and child exit are known.
pub const PROCESS_SESSION_TERMINAL_OUTPUT_LABEL: &str = "process-session-terminal-output";
/// Address label for one current task-surface isolation observation, keyed by
/// process session plus bootstrap identity.
pub const PROCESS_SESSION_SURFACE_OBSERVATION_LABEL: &str =
    "process-session-surface-isolation-observation";
/// Durable per-partition owner record mapping one start idempotency key to the
/// exact admitted session descriptor and session identity.
pub const PROCESS_SESSION_START_IDEMPOTENCY_LABEL: &str = "process-session-start-idempotency";

/// Idempotency keys are opaque caller-owned identities. The engine hashes them
/// before persistence/addressing, but bounds their ingress size so one request
/// cannot create unbounded allocation or log amplification.
pub const PROCESS_SESSION_IDEMPOTENCY_KEY_MAX_BYTES: usize = 512;

/// Persistent OS subprocess session descriptor.
///
/// This is the canonical start payload for an interactive process session. It
/// wraps one portable [`ProcessDescriptor`] with declarative session settings;
/// later commands address the created session rather than replacing its
/// admitted process intent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionDescriptor {
    /// Canonical portable execution intent. It contains no native executable,
    /// absolute working directory, caller-selected sandbox profile, or
    /// inherited environment. The process owner alone may admit it.
    pub process: ProcessDescriptor,
    /// Host-private argument and environment bindings resolved by the process
    /// owner only after the portable descriptor and workspace are admitted.
    #[serde(default, skip_serializing_if = "is_default_workspace_bindings")]
    pub workspace_bindings: ProcessWorkspaceExecutionBindings,
    /// Initial session settings.
    #[serde(default)]
    pub session_settings: ProcessSessionSettings,
    /// Optional owner declaration enabling short-lived task-surface observation
    /// publication by the exact realm that receives this session's unpersisted
    /// publication token. Ordinary process sessions leave this absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_isolation_publication: Option<ProcessSessionSurfaceIsolationPublication>,
}

impl ProcessSessionDescriptor {
    pub fn validate(&self, word_ids: &ProductWordIds) -> Result<(), ExecutionError> {
        self.process.validate(word_ids)?;
        self.workspace_bindings.validate()?;
        self.session_settings.validate()?;
        if let Some(publication) = &self.surface_isolation_publication {
            publication.validate()?;
            if self.process.argv.first() != Some(&publication.runtime_alias) {
                return Err(ExecutionError::InvalidDescriptor {
                    field: "surface_isolation_publication.runtime_alias".into(),
                    reason: "must match the admitted process runtime alias".into(),
                });
            }
        }
        Ok(())
    }
}

/// Declared identity and lifetime ceiling for observations published by one
/// mounted task-surface owner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionSurfaceIsolationPublication {
    pub provider_id: String,
    pub runtime_alias: String,
    pub maximum_lifetime_ms: u64,
}

impl ProcessSessionSurfaceIsolationPublication {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        validate_bounded_identity(
            &self.provider_id,
            "surface_isolation_publication.provider_id",
        )?;
        validate_bounded_identity(
            &self.runtime_alias,
            "surface_isolation_publication.runtime_alias",
        )?;
        if self.maximum_lifetime_ms == 0 || self.maximum_lifetime_ms > 300_000 {
            return Err(ExecutionError::InvalidDescriptor {
                field: "surface_isolation_publication.maximum_lifetime_ms".into(),
                reason: "must be between 1 and 300000".into(),
            });
        }
        Ok(())
    }
}

fn is_default_workspace_bindings(bindings: &ProcessWorkspaceExecutionBindings) -> bool {
    bindings == &ProcessWorkspaceExecutionBindings::default()
}

/// Mutable settings for a persistent subprocess session.
///
/// A text-capable interactive authority uses these settings to configure its
/// presentation surface without changing the portable process intent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionSettings {
    #[serde(default)]
    pub text_grid: Option<ProcessSessionTextGrid>,
}

impl ProcessSessionSettings {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if let Some(text_grid) = &self.text_grid {
            text_grid.validate()?;
        }
        Ok(())
    }
}

/// Size of a grid-shaped text surface attached to a subprocess session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionTextGrid {
    pub columns: u16,
    pub rows: u16,
}

impl ProcessSessionTextGrid {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.columns == 0 {
            return Err(ExecutionError::InvalidDescriptor {
                field: "session_settings.text_grid.columns".into(),
                reason: "must be > 0".into(),
            });
        }
        if self.rows == 0 {
            return Err(ExecutionError::InvalidDescriptor {
                field: "session_settings.text_grid.rows".into(),
                reason: "must be > 0".into(),
            });
        }
        Ok(())
    }
}

/// One persistent session command appended after start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionCommand {
    WriteInputBytes {
        #[serde(with = "slot_protocol::json_bytes")]
        bytes: Vec<u8>,
    },
    UpdateSessionSettings {
        settings: ProcessSessionSettings,
    },
    SendProcessSignal {
        signal: ProcessSessionSignal,
    },
    EndSession,
}

/// Portable signal intent for a persistent subprocess session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionSignal {
    Interrupt,
    Terminate,
    Kill,
}

/// Canonical request payload for the persistent subprocess-session target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionRequest {
    StartSession {
        /// Heap indirection keeps the command/reply protocol compact while
        /// preserving the canonical JSON shape of the session-start payload.
        descriptor: Box<ProcessSessionDescriptor>,
        /// Optional owner-scoped retry identity. When present, the process
        /// owner durably admits exactly one descriptor/session for this key:
        /// identical retries return the same session and conflicting retries
        /// fail closed. Legacy callers may omit it while they migrate.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        idempotency_key: Option<String>,
    },
    AppendSessionCommand {
        session_id: String,
        command: ProcessSessionCommand,
    },
    PublishSurfaceIsolationObservation {
        session_id: String,
        publisher_token: String,
        /// Boxed for the same compact-protocol reason as `StartSession`; the
        /// JSON shape is unchanged.
        observation: Box<ProcessSessionSurfaceIsolationObservation>,
    },
    RevokeSurfaceIsolationObservation {
        session_id: String,
        publisher_token: String,
        bootstrap_identity: String,
        lifecycle_revision: String,
    },
    ReadSession {
        session_id: String,
    },
}

/// Canonical reply payload for the persistent subprocess-session target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionResponse {
    SessionStarted {
        session_id: String,
        snapshot: ProcessSessionSnapshot,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        surface_observation_publisher_token: Option<String>,
    },
    SessionStartRejected {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        existing_session_id: Option<String>,
    },
    CommandAccepted {
        session_id: String,
        command_number: u64,
        snapshot: ProcessSessionSnapshot,
    },
    CommandRejected {
        session_id: String,
        reason: String,
        snapshot: Option<ProcessSessionSnapshot>,
    },
    SessionRead {
        session_id: String,
        snapshot: ProcessSessionSnapshot,
    },
    SurfaceIsolationObservationPublished {
        session_id: String,
        binding: ProcessSessionSurfaceIsolationBinding,
        snapshot: ProcessSessionSnapshot,
    },
    SurfaceIsolationObservationRevoked {
        session_id: String,
        bootstrap_identity: String,
        snapshot: ProcessSessionSnapshot,
    },
}

/// Exact short-lived owner observation. The process-session owner accepts this
/// only with the unpersisted token returned to the realm that started the
/// declared session, then validates all current session/config/time bindings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionSurfaceIsolationObservation {
    pub kind: String,
    pub version: u32,
    pub bootstrap_identity: String,
    pub task_ref: String,
    pub provider_id: String,
    pub runtime_alias: String,
    pub process_session_id: String,
    pub provider_session_id: String,
    pub lifecycle_state: String,
    pub lifecycle_revision: String,
    pub revoked: bool,
    pub observed_at_ms: u64,
    pub valid_until_ms: u64,
    pub surface_identity: String,
    pub page_identity: String,
    pub pointer_identity: String,
    pub keyboard_identity: String,
    pub input_focus_identity: String,
    pub independent_pointer: bool,
    pub independent_keyboard: bool,
    pub visible_on_personal_display: bool,
}

/// Current snapshot pointer for one task/bootstrap-scoped observation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionSurfaceIsolationBinding {
    pub bootstrap_identity: String,
    pub task_ref: String,
    pub provider_session_id: String,
    pub lifecycle_revision: String,
    pub observation_ref: String,
    pub observation_hash: String,
    pub valid_until_ms: u64,
}

/// Validate an opaque process-session start idempotency key at the owner
/// boundary. The value is never interpreted as Society vocabulary.
pub fn validate_process_session_idempotency_key(key: &str) -> Result<(), ExecutionError> {
    if key.trim().is_empty() {
        return Err(ExecutionError::InvalidDescriptor {
            field: "idempotency_key".into(),
            reason: "must not be empty or whitespace".into(),
        });
    }
    if key.len() > PROCESS_SESSION_IDEMPOTENCY_KEY_MAX_BYTES {
        return Err(ExecutionError::InvalidDescriptor {
            field: "idempotency_key".into(),
            reason: format!(
                "must be at most {PROCESS_SESSION_IDEMPOTENCY_KEY_MAX_BYTES} UTF-8 bytes"
            ),
        });
    }
    if key.chars().any(char::is_control) {
        return Err(ExecutionError::InvalidDescriptor {
            field: "idempotency_key".into(),
            reason: "must not contain control characters".into(),
        });
    }
    Ok(())
}

/// Current derived snapshot of one persistent subprocess session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionSnapshot {
    pub session_id: String,
    #[serde(default)]
    pub event_feed_address: String,
    /// Address of the per-event delta append lane (version-3 records). The
    /// feed address above carries the bounded HEAD; live subscribers tail
    /// THIS address for output events.
    #[serde(default)]
    pub event_stream_address: String,
    pub state: ProcessSessionState,
    /// The same portable process intent accepted at session start. Session
    /// projections never expose host-private admitted paths or policy data.
    pub process: ProcessDescriptor,
    pub session_settings: ProcessSessionSettings,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub command_count: u64,
    pub event_count: u64,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub failure_reason: Option<String>,
    /// Address where the authoritative full terminal output is stored at session
    /// termination. Written once when both output EOF and child exit are known.
    #[serde(default)]
    pub terminal_output_address: String,
    /// Bounded current task/bootstrap-scoped surface observations. Consumers
    /// must select an exact bootstrap identity and recheck `valid_until_ms`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface_isolation_observations: Vec<ProcessSessionSurfaceIsolationBinding>,
}

fn validate_bounded_identity(value: &str, field: &str) -> Result<(), ExecutionError> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(ExecutionError::InvalidDescriptor {
            field: field.into(),
            reason: "must be nonempty, at most 512 bytes, and contain no control characters".into(),
        });
    }
    Ok(())
}

/// Derived lifecycle state of a persistent subprocess session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionState {
    Running,
    Exited,
    Failed,
}

/// Aggregate addressed feed of current process-session snapshots.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionsFeed {
    #[serde(default)]
    pub sessions: Vec<ProcessSessionSnapshot>,
}

pub const PROCESS_SESSIONS_FEED_CELL_TABLE_COLUMN_COUNT: u32 = 15;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProcessSessionsFeedCodecError {
    #[error("invalid process-sessions feed bytes: {reason}")]
    InvalidFormat { reason: String },
}

pub fn encode_process_sessions_feed(
    feed: &ProcessSessionsFeed,
) -> Result<Vec<u8>, ProcessSessionsFeedCodecError> {
    let column_count = PROCESS_SESSIONS_FEED_CELL_TABLE_COLUMN_COUNT;
    let row_count = checked_record_table_u32(feed.sessions.len(), "row_count")?;
    let mut cells =
        Vec::<Option<Vec<u8>>>::with_capacity(feed.sessions.len() * column_count as usize);

    for snapshot in &feed.sessions {
        cells.push(Some(snapshot.session_id.as_bytes().to_vec()));
        cells.push(Some(snapshot.event_feed_address.as_bytes().to_vec()));
        cells.push(Some(
            process_session_state_text(&snapshot.state)
                .as_bytes()
                .to_vec(),
        ));
        cells.push(Some(json_cell(&snapshot.process.argv, "argv")?));
        cells.push(Some(json_cell(&snapshot.process.cwd, "cwd")?));
        cells.push(Some(json_cell(
            &snapshot.session_settings,
            "session_settings",
        )?));
        cells.push(Some(json_cell(&snapshot.started_at_ms, "started_at_ms")?));
        cells.push(Some(json_cell(&snapshot.updated_at_ms, "updated_at_ms")?));
        cells.push(Some(json_cell(&snapshot.command_count, "command_count")?));
        cells.push(Some(json_cell(&snapshot.event_count, "event_count")?));
        cells.push(Some(json_cell(&snapshot.exit_code, "exit_code")?));
        cells.push(Some(json_cell(&snapshot.failure_reason, "failure_reason")?));
        // Appended column (12): existing consumers project columns by index
        // from DATA descriptors — appending keeps every published projection
        // valid; new consumers opt in with one DATA field row.
        cells.push(Some(snapshot.event_stream_address.as_bytes().to_vec()));
        // Appended column (13): authoritative full terminal output address
        cells.push(Some(snapshot.terminal_output_address.as_bytes().to_vec()));
        // Appended column (14): bounded current task-surface bindings. This is
        // the durable restart source for exact observation cleanup.
        cells.push(Some(json_cell(
            &snapshot.surface_isolation_observations,
            "surface_isolation_observations",
        )?));
    }

    encode_record_table(row_count, column_count, &cells)
}

/// Decode only the restart-critical surface bindings for one exact session.
/// Historical 14-column feeds predate these bindings and decode as empty.
pub fn decode_process_session_surface_isolation_bindings(
    bytes: &[u8],
    session_id: &str,
) -> Result<Option<Vec<ProcessSessionSurfaceIsolationBinding>>, ProcessSessionsFeedCodecError> {
    const HEADER_LEN: usize = 16;
    const INDEX_LEN: usize = 8;
    if bytes.len() < HEADER_LEN
        || bytes[0..5] != [0x52, 0x54, 0x42, 0x4c, 1]
        || bytes[5..8] != [0, 0, 0]
    {
        return Err(ProcessSessionsFeedCodecError::InvalidFormat {
            reason: "record-table header is invalid".into(),
        });
    }
    let row_count = u32::from_le_bytes(bytes[8..12].try_into().expect("bounded header"));
    let column_count = u32::from_le_bytes(bytes[12..16].try_into().expect("bounded header"));
    if !(14..=PROCESS_SESSIONS_FEED_CELL_TABLE_COLUMN_COUNT).contains(&column_count) {
        return Err(ProcessSessionsFeedCodecError::InvalidFormat {
            reason: format!("unsupported process-sessions column count {column_count}"),
        });
    }
    let cell_count =
        checked_record_table_usize_mul(row_count as usize, column_count as usize, "cell_count")?;
    let index_len = checked_record_table_usize_mul(cell_count, INDEX_LEN, "index")?;
    let payload_offset = checked_record_table_usize_add(HEADER_LEN, index_len, "payload_offset")?;
    if payload_offset > bytes.len() {
        return Err(ProcessSessionsFeedCodecError::InvalidFormat {
            reason: "record-table index exceeds the payload".into(),
        });
    }

    let cell = |row: u32, column: u32| -> Result<Option<&[u8]>, ProcessSessionsFeedCodecError> {
        let cell_index = checked_record_table_usize_add(
            checked_record_table_usize_mul(row as usize, column_count as usize, "cell_index")?,
            column as usize,
            "cell_index",
        )?;
        let index_offset = checked_record_table_usize_add(
            HEADER_LEN,
            checked_record_table_usize_mul(cell_index, INDEX_LEN, "cell_index_offset")?,
            "cell_index_offset",
        )?;
        let index_end = checked_record_table_usize_add(index_offset, INDEX_LEN, "cell_index_end")?;
        if index_end > payload_offset {
            return Err(ProcessSessionsFeedCodecError::InvalidFormat {
                reason: "record-table cell index is out of bounds".into(),
            });
        }
        let offset = u32::from_le_bytes(
            bytes[index_offset..index_offset + 4]
                .try_into()
                .expect("bounded cell offset"),
        ) as usize;
        let length = u32::from_le_bytes(
            bytes[index_offset + 4..index_end]
                .try_into()
                .expect("bounded cell length"),
        );
        if length == u32::MAX {
            return Ok(None);
        }
        let start = checked_record_table_usize_add(payload_offset, offset, "cell_start")?;
        let end = checked_record_table_usize_add(start, length as usize, "cell_end")?;
        if end > bytes.len() {
            return Err(ProcessSessionsFeedCodecError::InvalidFormat {
                reason: "record-table cell payload is out of bounds".into(),
            });
        }
        Ok(Some(&bytes[start..end]))
    };

    let mut found = None;
    for row in 0..row_count {
        let Some(id_bytes) = cell(row, 0)? else {
            return Err(ProcessSessionsFeedCodecError::InvalidFormat {
                reason: "process-session identity cell is null".into(),
            });
        };
        let id = std::str::from_utf8(id_bytes).map_err(|error| {
            ProcessSessionsFeedCodecError::InvalidFormat {
                reason: format!("process-session identity is not UTF-8: {error}"),
            }
        })?;
        if id != session_id {
            continue;
        }
        if found.is_some() {
            return Err(ProcessSessionsFeedCodecError::InvalidFormat {
                reason: "process-session identity appears more than once".into(),
            });
        }
        let bindings = if column_count == 14 {
            Vec::new()
        } else {
            let Some(binding_bytes) = cell(row, 14)? else {
                return Err(ProcessSessionsFeedCodecError::InvalidFormat {
                    reason: "surface isolation bindings cell is null".into(),
                });
            };
            let bindings: Vec<ProcessSessionSurfaceIsolationBinding> =
                serde_json::from_slice(binding_bytes).map_err(|error| {
                    ProcessSessionsFeedCodecError::InvalidFormat {
                        reason: format!("surface isolation bindings JSON decode failed: {error}"),
                    }
                })?;
            if bindings.len() > 16 {
                return Err(ProcessSessionsFeedCodecError::InvalidFormat {
                    reason: "surface isolation bindings exceed 16 entries".into(),
                });
            }
            bindings
        };
        found = Some(bindings);
    }
    Ok(found)
}

fn json_cell<T: Serialize>(
    value: &T,
    field: &str,
) -> Result<Vec<u8>, ProcessSessionsFeedCodecError> {
    serde_json::to_vec(value).map_err(|error| ProcessSessionsFeedCodecError::InvalidFormat {
        reason: format!("{field} JSON encode failed: {error}"),
    })
}

fn process_session_state_text(state: &ProcessSessionState) -> &'static str {
    match state {
        ProcessSessionState::Running => "running",
        ProcessSessionState::Exited => "exited",
        ProcessSessionState::Failed => "failed",
    }
}

fn encode_record_table(
    row_count: u32,
    column_count: u32,
    cells: &[Option<Vec<u8>>],
) -> Result<Vec<u8>, ProcessSessionsFeedCodecError> {
    const HEADER_LEN: usize = 16;
    const INDEX_LEN: usize = 8;
    const NULL_CELL_LENGTH: u32 = u32::MAX;

    let expected_cells = row_count as usize * column_count as usize;
    if cells.len() != expected_cells {
        return Err(ProcessSessionsFeedCodecError::InvalidFormat {
            reason: format!(
                "cell count {} did not match expected {expected_cells}",
                cells.len()
            ),
        });
    }

    let index_byte_len = checked_record_table_usize_mul(cells.len(), INDEX_LEN, "index")?;
    let payload_byte_len = cells.iter().try_fold(0usize, |sum, cell| {
        checked_record_table_usize_add(sum, cell.as_ref().map_or(0, Vec::len), "payload")
    })?;
    let total_len = checked_record_table_usize_add(
        HEADER_LEN,
        checked_record_table_usize_add(index_byte_len, payload_byte_len, "total")?,
        "total",
    )?;
    let mut out = vec![0u8; total_len];
    out[0..5].copy_from_slice(&[0x52, 0x54, 0x42, 0x4c, 1]);
    out[8..12].copy_from_slice(&row_count.to_le_bytes());
    out[12..16].copy_from_slice(&column_count.to_le_bytes());

    let payload_offset = HEADER_LEN + index_byte_len;
    let mut payload_cursor = 0usize;
    for (cell_index, cell) in cells.iter().enumerate() {
        let index_offset = HEADER_LEN + cell_index * INDEX_LEN;
        match cell {
            Some(bytes) => {
                out[index_offset..index_offset + 4].copy_from_slice(
                    &checked_record_table_u32(payload_cursor, "cell_offset")?.to_le_bytes(),
                );
                out[index_offset + 4..index_offset + 8].copy_from_slice(
                    &checked_record_table_u32(bytes.len(), "cell_length")?.to_le_bytes(),
                );
                out[payload_offset + payload_cursor..payload_offset + payload_cursor + bytes.len()]
                    .copy_from_slice(bytes);
                payload_cursor += bytes.len();
            }
            None => {
                out[index_offset..index_offset + 4].copy_from_slice(&0u32.to_le_bytes());
                out[index_offset + 4..index_offset + 8]
                    .copy_from_slice(&NULL_CELL_LENGTH.to_le_bytes());
            }
        }
    }
    Ok(out)
}

fn checked_record_table_u32(
    value: usize,
    field: &str,
) -> Result<u32, ProcessSessionsFeedCodecError> {
    u32::try_from(value).map_err(|_| ProcessSessionsFeedCodecError::InvalidFormat {
        reason: format!("{field} exceeds u32"),
    })
}

fn checked_record_table_usize_add(
    left: usize,
    right: usize,
    field: &str,
) -> Result<usize, ProcessSessionsFeedCodecError> {
    left.checked_add(right)
        .ok_or_else(|| ProcessSessionsFeedCodecError::InvalidFormat {
            reason: format!("{field} byte length overflow"),
        })
}

fn checked_record_table_usize_mul(
    left: usize,
    right: usize,
    field: &str,
) -> Result<usize, ProcessSessionsFeedCodecError> {
    left.checked_mul(right)
        .ok_or_else(|| ProcessSessionsFeedCodecError::InvalidFormat {
            reason: format!("{field} byte length overflow"),
        })
}

/// Addressed sequence of ordered events for a process session.
///
/// A process session's event history is identity-scoped to that session. Events
/// from unrelated sessions are different histories, not variants inside one
/// shared object.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionEventsFeed {
    #[serde(default)]
    pub events: Vec<ProcessSessionEvent>,
}

/// One recorded event inside a persistent subprocess session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionEvent {
    pub session_id: String,
    pub event_number: u64,
    pub recorded_at_ms: u64,
    #[serde(flatten)]
    pub kind: ProcessSessionEventKind,
}

/// Recorded event kinds for persistent subprocess sessions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionEventKind {
    OutputBytes {
        stream: ProcessSessionOutputStream,
        #[serde(with = "slot_protocol::json_bytes")]
        bytes: Vec<u8>,
    },
    SessionStateChanged {
        state: ProcessSessionState,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(default)]
        failure_reason: Option<String>,
    },
    CommandRejected {
        reason: String,
    },
}

/// Output stream identity for a persistent subprocess session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ProcessSessionOutputStream {
    Display,
    Stdout,
    Stderr,
}

/// Versioned binary codec for the hot process-session events feed.
///
/// This feed is read on the pushed exact-address lane by browser consumers that
/// often only need to hand borrowed output bytes directly to a terminal surface.
/// JSON plus base64 would force two fake decode steps on that hot lane. The
/// canonical owner contract therefore uses a compact binary wire format here
/// while the broader snapshot feed stays JSON-shaped for generic inspection.
///
/// VERSION HISTORY:
/// - Version 1 (legacy, decode-only): full vector of every event in one payload.
///   Correctness required re-encoding all prior bytes per event — O(N) RAM and
///   O(N²) durable bytes. Nothing writes it anymore; the decoder stays so
///   historical log entries remain readable.
/// - Version 2: constant-size HEAD record at the per-session head address —
///   the bounded projection over log-owned history.
/// - Version 3: single-event delta at the per-session event feed address —
///   the log journal IS the history; each payload carries only the new event.
///
/// The leading version byte makes every payload self-identifying: a reader
/// never guesses which codec applies.
pub const PROCESS_SESSION_EVENTS_FEED_BINARY_VERSION: u8 = 1;
pub const PROCESS_SESSION_EVENTS_FEED_HEAD_BINARY_VERSION: u8 = 2;
pub const PROCESS_SESSION_EVENT_DELTA_BINARY_VERSION: u8 = 3;

const PROCESS_SESSION_EVENT_KIND_OUTPUT_BYTES: u8 = 0;
const PROCESS_SESSION_EVENT_KIND_SESSION_STATE_CHANGED: u8 = 1;
const PROCESS_SESSION_EVENT_KIND_COMMAND_REJECTED: u8 = 2;

const PROCESS_SESSION_OUTPUT_STREAM_DISPLAY: u8 = 0;
const PROCESS_SESSION_OUTPUT_STREAM_STDOUT: u8 = 1;
const PROCESS_SESSION_OUTPUT_STREAM_STDERR: u8 = 2;

const PROCESS_SESSION_STATE_RUNNING: u8 = 0;
const PROCESS_SESSION_STATE_EXITED: u8 = 1;
const PROCESS_SESSION_STATE_FAILED: u8 = 2;

/// HEAD record for bounded projection of a process-session event stream.
///
/// The event history is append-only in the log (per-event delta writes at the
/// event-stream address). The HEAD record is a constant-size projection
/// overwritten per event, holding:
/// - Session identity and current state
/// - Last event number and cumulative byte totals for diagnostics
/// - Terminal result (if ended)
/// - The event-stream address (wire hex) where per-event deltas live —
///   readers discover it here instead of constructing addresses by hand
///
/// This separates history ownership (the log) from live-state projection (RAM),
/// eliminating O(N) memory growth as events accumulate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionEventHead {
    pub session_id: String,
    pub event_stream_address: String,
    pub state: ProcessSessionState,
    pub last_event_number: u64,
    pub total_event_count: u64,
    pub bytes_written: u64,
    /// Bounded suffix of observed output. This lets a late subscriber recover
    /// startup handshakes without replaying an unbounded event history. The
    /// terminal-output address remains the authoritative complete byte stream.
    #[serde(default, with = "slot_protocol::json_bytes")]
    pub output_tail: Vec<u8>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub failure_reason: Option<String>,
}

/// One delta-mode event write for a process-session event stream.
///
/// Per-event deltas are written to the log's event-stream address. Each delta
/// is a single event, not a cumulative snapshot. The log owns history losslessly;
/// the HEAD record is the bounded projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProcessSessionEventDelta {
    pub session_id: String,
    pub event_number: u64,
    pub recorded_at_ms: u64,
    #[serde(flatten)]
    pub kind: ProcessSessionEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProcessSessionEventsFeedCodecError {
    #[error("invalid process-session-events feed bytes: {reason}")]
    InvalidFormat { reason: String },
}

pub fn encode_process_session_events_feed(
    feed: &ProcessSessionEventsFeed,
) -> Result<Vec<u8>, ProcessSessionEventsFeedCodecError> {
    let mut session_indexes = HashMap::<String, u32>::new();
    let mut session_ids = Vec::<String>::new();
    for event in &feed.events {
        if session_indexes.contains_key(&event.session_id) {
            continue;
        }
        let index = checked_u32_len(session_ids.len(), "session_id_count")?;
        session_indexes.insert(event.session_id.clone(), index);
        session_ids.push(event.session_id.clone());
    }

    let mut bytes = Vec::new();
    bytes.push(PROCESS_SESSION_EVENTS_FEED_BINARY_VERSION);
    push_u32(
        &mut bytes,
        checked_u32_len(session_ids.len(), "session_id_count")?,
    );
    for session_id in &session_ids {
        push_string(&mut bytes, session_id, "session_id")?;
    }
    push_u32(
        &mut bytes,
        checked_u32_len(feed.events.len(), "event_count")?,
    );
    for event in &feed.events {
        let Some(&session_index) = session_indexes.get(&event.session_id) else {
            return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!("missing session index for {}", event.session_id),
            });
        };
        push_u32(&mut bytes, session_index);
        push_u64(&mut bytes, event.event_number);
        push_u64(&mut bytes, event.recorded_at_ms);
        match &event.kind {
            ProcessSessionEventKind::OutputBytes {
                stream,
                bytes: output,
            } => {
                bytes.push(PROCESS_SESSION_EVENT_KIND_OUTPUT_BYTES);
                bytes.push(encode_output_stream(stream));
                push_len_prefixed_bytes(&mut bytes, output, "output_bytes")?;
            }
            ProcessSessionEventKind::SessionStateChanged {
                state,
                exit_code,
                failure_reason,
            } => {
                bytes.push(PROCESS_SESSION_EVENT_KIND_SESSION_STATE_CHANGED);
                bytes.push(encode_state(state));
                push_optional_i32(&mut bytes, *exit_code);
                push_optional_string(&mut bytes, failure_reason.as_deref(), "failure_reason")?;
            }
            ProcessSessionEventKind::CommandRejected { reason } => {
                bytes.push(PROCESS_SESSION_EVENT_KIND_COMMAND_REJECTED);
                push_string(&mut bytes, reason, "command_rejected.reason")?;
            }
        }
    }
    Ok(bytes)
}

pub fn decode_process_session_events_feed(
    bytes: &[u8],
) -> Result<ProcessSessionEventsFeed, ProcessSessionEventsFeedCodecError> {
    let mut cursor = ProcessSessionEventsFeedCursor::new(bytes);
    let version = cursor.read_u8("version")?;
    if version != PROCESS_SESSION_EVENTS_FEED_BINARY_VERSION {
        return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
            reason: format!(
                "unsupported version {version}; expected {PROCESS_SESSION_EVENTS_FEED_BINARY_VERSION}"
            ),
        });
    }

    let session_count = cursor.read_u32("session_id_count")? as usize;
    let mut session_ids = Vec::with_capacity(session_count);
    for _ in 0..session_count {
        session_ids.push(cursor.read_string("session_id")?);
    }

    let event_count = cursor.read_u32("event_count")? as usize;
    let mut events = Vec::with_capacity(event_count);
    for _ in 0..event_count {
        let session_index = cursor.read_u32("session_index")? as usize;
        let Some(session_id) = session_ids.get(session_index) else {
            return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!("session_index {session_index} out of bounds"),
            });
        };
        let event_number = cursor.read_u64("event_number")?;
        let recorded_at_ms = cursor.read_u64("recorded_at_ms")?;
        let kind_tag = cursor.read_u8("kind")?;
        let kind = match kind_tag {
            PROCESS_SESSION_EVENT_KIND_OUTPUT_BYTES => {
                let stream = decode_output_stream(cursor.read_u8("output_stream")?)?;
                let output = cursor.read_len_prefixed_bytes("output_bytes")?.to_vec();
                ProcessSessionEventKind::OutputBytes {
                    stream,
                    bytes: output,
                }
            }
            PROCESS_SESSION_EVENT_KIND_SESSION_STATE_CHANGED => {
                let state = decode_state(cursor.read_u8("state")?)?;
                let exit_code = cursor.read_optional_i32("exit_code")?;
                let failure_reason = cursor.read_optional_string("failure_reason")?;
                ProcessSessionEventKind::SessionStateChanged {
                    state,
                    exit_code,
                    failure_reason,
                }
            }
            PROCESS_SESSION_EVENT_KIND_COMMAND_REJECTED => {
                let reason = cursor.read_string("command_rejected.reason")?;
                ProcessSessionEventKind::CommandRejected { reason }
            }
            other => {
                return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                    reason: format!("unknown event kind tag {other}"),
                });
            }
        };
        events.push(ProcessSessionEvent {
            session_id: session_id.clone(),
            event_number,
            recorded_at_ms,
            kind,
        });
    }

    cursor.finish()?;
    Ok(ProcessSessionEventsFeed { events })
}

fn checked_u32_len(len: usize, field: &str) -> Result<u32, ProcessSessionEventsFeedCodecError> {
    u32::try_from(len).map_err(|_| ProcessSessionEventsFeedCodecError::InvalidFormat {
        reason: format!("{field} exceeds u32"),
    })
}

fn push_u32(buf: &mut Vec<u8>, value: u32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(buf: &mut Vec<u8>, value: u64) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(buf: &mut Vec<u8>, value: i32) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn push_len_prefixed_bytes(
    buf: &mut Vec<u8>,
    bytes: &[u8],
    field: &str,
) -> Result<(), ProcessSessionEventsFeedCodecError> {
    push_u32(buf, checked_u32_len(bytes.len(), field)?);
    buf.extend_from_slice(bytes);
    Ok(())
}

fn push_string(
    buf: &mut Vec<u8>,
    value: &str,
    field: &str,
) -> Result<(), ProcessSessionEventsFeedCodecError> {
    push_len_prefixed_bytes(buf, value.as_bytes(), field)
}

fn push_optional_i32(buf: &mut Vec<u8>, value: Option<i32>) {
    match value {
        Some(value) => {
            buf.push(1);
            push_i32(buf, value);
        }
        None => buf.push(0),
    }
}

fn push_optional_string(
    buf: &mut Vec<u8>,
    value: Option<&str>,
    field: &str,
) -> Result<(), ProcessSessionEventsFeedCodecError> {
    match value {
        Some(value) => {
            buf.push(1);
            push_string(buf, value, field)?;
        }
        None => buf.push(0),
    }
    Ok(())
}

fn encode_output_stream(stream: &ProcessSessionOutputStream) -> u8 {
    match stream {
        ProcessSessionOutputStream::Display => PROCESS_SESSION_OUTPUT_STREAM_DISPLAY,
        ProcessSessionOutputStream::Stdout => PROCESS_SESSION_OUTPUT_STREAM_STDOUT,
        ProcessSessionOutputStream::Stderr => PROCESS_SESSION_OUTPUT_STREAM_STDERR,
    }
}

fn decode_output_stream(
    tag: u8,
) -> Result<ProcessSessionOutputStream, ProcessSessionEventsFeedCodecError> {
    match tag {
        PROCESS_SESSION_OUTPUT_STREAM_DISPLAY => Ok(ProcessSessionOutputStream::Display),
        PROCESS_SESSION_OUTPUT_STREAM_STDOUT => Ok(ProcessSessionOutputStream::Stdout),
        PROCESS_SESSION_OUTPUT_STREAM_STDERR => Ok(ProcessSessionOutputStream::Stderr),
        other => Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
            reason: format!("unknown output stream tag {other}"),
        }),
    }
}

fn encode_state(state: &ProcessSessionState) -> u8 {
    match state {
        ProcessSessionState::Running => PROCESS_SESSION_STATE_RUNNING,
        ProcessSessionState::Exited => PROCESS_SESSION_STATE_EXITED,
        ProcessSessionState::Failed => PROCESS_SESSION_STATE_FAILED,
    }
}

fn decode_state(tag: u8) -> Result<ProcessSessionState, ProcessSessionEventsFeedCodecError> {
    match tag {
        PROCESS_SESSION_STATE_RUNNING => Ok(ProcessSessionState::Running),
        PROCESS_SESSION_STATE_EXITED => Ok(ProcessSessionState::Exited),
        PROCESS_SESSION_STATE_FAILED => Ok(ProcessSessionState::Failed),
        other => Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
            reason: format!("unknown process session state tag {other}"),
        }),
    }
}

// =============================================================================
// V2 HEAD RECORD CODEC (bounded projection over log-owned history)
// =============================================================================

/// Encode the HEAD record for a process-session event stream (V2).
///
/// The HEAD is a constant-size projection written to the main feed address.
/// It holds session identity, state, event counts, and cursor for replay.
pub fn encode_process_session_event_head(
    head: &ProcessSessionEventHead,
) -> Result<Vec<u8>, ProcessSessionEventsFeedCodecError> {
    let mut bytes = vec![PROCESS_SESSION_EVENTS_FEED_HEAD_BINARY_VERSION];
    push_string(&mut bytes, &head.session_id, "session_id")?;
    push_string(
        &mut bytes,
        &head.event_stream_address,
        "event_stream_address",
    )?;
    bytes.push(encode_state(&head.state));
    push_u64(&mut bytes, head.last_event_number);
    push_u64(&mut bytes, head.total_event_count);
    push_u64(&mut bytes, head.bytes_written);
    push_optional_i32(&mut bytes, head.exit_code);
    push_optional_string(&mut bytes, head.failure_reason.as_deref(), "failure_reason")?;
    push_len_prefixed_bytes(&mut bytes, &head.output_tail, "output_tail")?;
    Ok(bytes)
}

/// Decode the HEAD record for a process-session event stream (V2).
pub fn decode_process_session_event_head(
    bytes: &[u8],
) -> Result<ProcessSessionEventHead, ProcessSessionEventsFeedCodecError> {
    let mut cursor = ProcessSessionEventsFeedCursor::new(bytes);
    let version = cursor.read_u8("version")?;
    if version != PROCESS_SESSION_EVENTS_FEED_HEAD_BINARY_VERSION {
        return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
            reason: format!(
                "unsupported version {version}; expected {PROCESS_SESSION_EVENTS_FEED_HEAD_BINARY_VERSION}"
            ),
        });
    }

    let session_id = cursor.read_string("session_id")?;
    let event_stream_address = cursor.read_string("event_stream_address")?;
    let state = decode_state(cursor.read_u8("state")?)?;
    let last_event_number = cursor.read_u64("last_event_number")?;
    let total_event_count = cursor.read_u64("total_event_count")?;
    let bytes_written = cursor.read_u64("bytes_written")?;
    let exit_code = cursor.read_optional_i32("exit_code")?;
    let failure_reason = cursor.read_optional_string("failure_reason")?;

    let output_tail = if cursor.remaining().is_empty() {
        Vec::new()
    } else {
        cursor.read_len_prefixed_bytes("output_tail")?.to_vec()
    };
    cursor.finish()?;
    Ok(ProcessSessionEventHead {
        session_id,
        event_stream_address,
        state,
        last_event_number,
        total_event_count,
        bytes_written,
        output_tail,
        exit_code,
        failure_reason,
    })
}

/// Encode a single event delta for the event-stream address (V2).
///
/// Per-event deltas are appended to the log at the event-stream address.
/// Each delta is independent and can be decoded in isolation.
pub fn encode_process_session_event_delta(
    delta: &ProcessSessionEventDelta,
) -> Result<Vec<u8>, ProcessSessionEventsFeedCodecError> {
    let mut bytes = vec![PROCESS_SESSION_EVENT_DELTA_BINARY_VERSION];
    push_string(&mut bytes, &delta.session_id, "session_id")?;
    push_u64(&mut bytes, delta.event_number);
    push_u64(&mut bytes, delta.recorded_at_ms);
    match &delta.kind {
        ProcessSessionEventKind::OutputBytes {
            stream,
            bytes: output,
        } => {
            bytes.push(PROCESS_SESSION_EVENT_KIND_OUTPUT_BYTES);
            bytes.push(encode_output_stream(stream));
            push_len_prefixed_bytes(&mut bytes, output, "output_bytes")?;
        }
        ProcessSessionEventKind::SessionStateChanged {
            state,
            exit_code,
            failure_reason,
        } => {
            bytes.push(PROCESS_SESSION_EVENT_KIND_SESSION_STATE_CHANGED);
            bytes.push(encode_state(state));
            push_optional_i32(&mut bytes, *exit_code);
            push_optional_string(&mut bytes, failure_reason.as_deref(), "failure_reason")?;
        }
        ProcessSessionEventKind::CommandRejected { reason } => {
            bytes.push(PROCESS_SESSION_EVENT_KIND_COMMAND_REJECTED);
            push_string(&mut bytes, reason, "command_rejected.reason")?;
        }
    }
    Ok(bytes)
}

/// Decode a single event delta from the event-stream address (V2).
pub fn decode_process_session_event_delta(
    bytes: &[u8],
) -> Result<ProcessSessionEventDelta, ProcessSessionEventsFeedCodecError> {
    let mut cursor = ProcessSessionEventsFeedCursor::new(bytes);
    let version = cursor.read_u8("version")?;
    if version != PROCESS_SESSION_EVENT_DELTA_BINARY_VERSION {
        return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
            reason: format!(
                "unsupported version {version}; expected {PROCESS_SESSION_EVENT_DELTA_BINARY_VERSION}"
            ),
        });
    }

    let session_id = cursor.read_string("session_id")?;
    let event_number = cursor.read_u64("event_number")?;
    let recorded_at_ms = cursor.read_u64("recorded_at_ms")?;
    let kind_tag = cursor.read_u8("kind")?;
    let kind = match kind_tag {
        PROCESS_SESSION_EVENT_KIND_OUTPUT_BYTES => {
            let stream = decode_output_stream(cursor.read_u8("output_stream")?)?;
            let output = cursor.read_len_prefixed_bytes("output_bytes")?.to_vec();
            ProcessSessionEventKind::OutputBytes {
                stream,
                bytes: output,
            }
        }
        PROCESS_SESSION_EVENT_KIND_SESSION_STATE_CHANGED => {
            let state = decode_state(cursor.read_u8("state")?)?;
            let exit_code = cursor.read_optional_i32("exit_code")?;
            let failure_reason = cursor.read_optional_string("failure_reason")?;
            ProcessSessionEventKind::SessionStateChanged {
                state,
                exit_code,
                failure_reason,
            }
        }
        PROCESS_SESSION_EVENT_KIND_COMMAND_REJECTED => {
            let reason = cursor.read_string("command_rejected.reason")?;
            ProcessSessionEventKind::CommandRejected { reason }
        }
        other => {
            return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!("unknown event kind tag {other}"),
            });
        }
    };

    cursor.finish()?;
    Ok(ProcessSessionEventDelta {
        session_id,
        event_number,
        recorded_at_ms,
        kind,
    })
}

struct ProcessSessionEventsFeedCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ProcessSessionEventsFeedCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn finish(&self) -> Result<(), ProcessSessionEventsFeedCodecError> {
        if self.offset == self.bytes.len() {
            return Ok(());
        }
        Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
            reason: format!(
                "trailing bytes after decode: {}",
                self.bytes.len().saturating_sub(self.offset)
            ),
        })
    }

    fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.offset..]
    }

    fn read_u8(&mut self, field: &str) -> Result<u8, ProcessSessionEventsFeedCodecError> {
        let bytes = self.read_exact(1, field)?;
        Ok(bytes[0])
    }

    fn read_u32(&mut self, field: &str) -> Result<u32, ProcessSessionEventsFeedCodecError> {
        let bytes = self.read_exact(4, field)?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_u64(&mut self, field: &str) -> Result<u64, ProcessSessionEventsFeedCodecError> {
        let bytes = self.read_exact(8, field)?;
        Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_i32(&mut self, field: &str) -> Result<i32, ProcessSessionEventsFeedCodecError> {
        let bytes = self.read_exact(4, field)?;
        Ok(i32::from_le_bytes(bytes.try_into().unwrap()))
    }

    fn read_len_prefixed_bytes(
        &mut self,
        field: &str,
    ) -> Result<&'a [u8], ProcessSessionEventsFeedCodecError> {
        let len = self.read_u32(field)? as usize;
        self.read_exact(len, field)
    }

    fn read_string(&mut self, field: &str) -> Result<String, ProcessSessionEventsFeedCodecError> {
        let bytes = self.read_len_prefixed_bytes(field)?;
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|error| ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!("{field} is not valid utf-8: {error}"),
            })
    }

    fn read_optional_i32(
        &mut self,
        field: &str,
    ) -> Result<Option<i32>, ProcessSessionEventsFeedCodecError> {
        match self.read_u8(field)? {
            0 => Ok(None),
            1 => Ok(Some(self.read_i32(field)?)),
            other => Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!("{field} optional flag must be 0 or 1, got {other}"),
            }),
        }
    }

    fn read_optional_string(
        &mut self,
        field: &str,
    ) -> Result<Option<String>, ProcessSessionEventsFeedCodecError> {
        match self.read_u8(field)? {
            0 => Ok(None),
            1 => Ok(Some(self.read_string(field)?)),
            other => Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!("{field} optional flag must be 0 or 1, got {other}"),
            }),
        }
    }

    fn read_exact(
        &mut self,
        len: usize,
        field: &str,
    ) -> Result<&'a [u8], ProcessSessionEventsFeedCodecError> {
        let end = self.offset.saturating_add(len);
        if end > self.bytes.len() {
            return Err(ProcessSessionEventsFeedCodecError::InvalidFormat {
                reason: format!(
                    "{field} overruns payload at offset {} requesting {} bytes from total {}",
                    self.offset,
                    len,
                    self.bytes.len()
                ),
            });
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product_word_ids::example_product_word_ids;
    use crate::process_types::{
        ProcessContainmentRequest, ProcessTermination, DEFAULT_PROCESS_TERMINATION_GRACE_MS,
    };
    use serde::Deserialize;
    use slot_protocol::FactAddress;
    use std::collections::BTreeMap;

    #[derive(Debug, Deserialize)]
    struct ProcessSessionFeedContract {
        feeds: Vec<ProcessSessionFeedRecord>,
    }

    #[derive(Debug, Deserialize)]
    struct ProcessSessionFeedRecord {
        key: String,
        label: String,
        address_mode: String,
        address_hex: Option<String>,
        address_field: Option<String>,
    }

    fn hex_encode(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
        out
    }

    fn descriptor() -> ProcessSessionDescriptor {
        ProcessSessionDescriptor {
            process: ProcessDescriptor {
                argv: vec!["session-shell".into(), "-lc".into(), "echo hello".into()],
                cwd: None,
                timeout_ms: 5_000,
                termination_grace_ms: DEFAULT_PROCESS_TERMINATION_GRACE_MS,
                expected_termination: Some(ProcessTermination::Exited { code: 0 }),
                env: BTreeMap::new(),
                inputs: Vec::new(),
                input_trees: Vec::new(),
                outputs: Vec::new(),
                private_volume: None,
                readable_private_volumes: Vec::new(),
                network_access: crate::ProcessNetworkAccess::Denied,
                containment: ProcessContainmentRequest::Leaf,
                capture_fds: vec![1, 2],
                collected_files: Vec::new(),
            },
            workspace_bindings: ProcessWorkspaceExecutionBindings::default(),
            session_settings: ProcessSessionSettings {
                text_grid: Some(ProcessSessionTextGrid {
                    columns: 80,
                    rows: 24,
                }),
            },
            surface_isolation_publication: None,
        }
    }

    #[test]
    fn session_descriptor_rejects_empty_argv() {
        let mut bad = descriptor();
        bad.process.argv.clear();
        assert!(matches!(
            bad.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { field, .. }) if field == "argv[0]"
        ));
    }

    #[test]
    fn session_descriptor_rejects_zero_text_grid() {
        let mut bad = descriptor();
        bad.session_settings.text_grid = Some(ProcessSessionTextGrid {
            columns: 0,
            rows: 24,
        });
        assert!(matches!(
            bad.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { field, .. }) if field == "session_settings.text_grid.columns"
        ));
    }

    #[test]
    fn surface_publication_must_name_the_admitted_runtime() {
        let mut bad = descriptor();
        bad.surface_isolation_publication = Some(ProcessSessionSurfaceIsolationPublication {
            provider_id: "browsing-surface-provider".into(),
            runtime_alias: "different-runtime".into(),
            maximum_lifetime_ms: 5_000,
        });
        assert!(matches!(
            bad.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { field, .. })
                if field == "surface_isolation_publication.runtime_alias"
        ));

        let mut valid = descriptor();
        valid.surface_isolation_publication = Some(ProcessSessionSurfaceIsolationPublication {
            provider_id: "browsing-surface-provider".into(),
            runtime_alias: "session-shell".into(),
            maximum_lifetime_ms: 5_000,
        });
        valid
            .validate(&example_product_word_ids())
            .expect("declared runtime matches admitted runtime");
    }

    #[test]
    fn session_descriptor_rejects_absolute_working_directory() {
        let mut valid = descriptor();
        valid.process.cwd = Some(
            std::env::temp_dir()
                .join("architect-process-session-cwd")
                .to_string_lossy()
                .into_owned(),
        );

        assert!(matches!(
            valid.validate(&example_product_word_ids()),
            Err(ExecutionError::InvalidDescriptor { field, .. }) if field == "cwd"
        ));
    }

    #[test]
    fn session_request_strictly_rejects_retired_native_fields() {
        let value = serde_json::json!({
            "operation": "start_session",
            "descriptor": {
                "process": serde_json::to_value(descriptor().process).expect("process JSON"),
                "session_settings": { "text_grid": { "columns": 80, "rows": 24 } },
                "sandbox_profile": "relaxed"
            }
        });

        assert!(serde_json::from_value::<ProcessSessionRequest>(value).is_err());
    }

    #[test]
    fn session_start_idempotency_key_is_optional_and_round_trips_when_present() {
        let legacy = ProcessSessionRequest::StartSession {
            descriptor: Box::new(descriptor()),
            idempotency_key: None,
        };
        let legacy_json = serde_json::to_value(&legacy).expect("legacy start JSON");
        assert!(legacy_json.get("idempotency_key").is_none());

        let keyed = ProcessSessionRequest::StartSession {
            descriptor: Box::new(descriptor()),
            idempotency_key: Some("founder-action:FOG-019:claim-1".into()),
        };
        let keyed_json = serde_json::to_value(&keyed).expect("keyed start JSON");
        assert_eq!(
            serde_json::from_value::<ProcessSessionRequest>(keyed_json)
                .expect("decode keyed start"),
            keyed
        );
    }

    #[test]
    fn session_start_idempotency_key_validation_rejects_ambiguous_values() {
        for invalid in ["", "   ", "line\nbreak"] {
            assert!(validate_process_session_idempotency_key(invalid).is_err());
        }
        assert!(validate_process_session_idempotency_key(
            &"x".repeat(PROCESS_SESSION_IDEMPOTENCY_KEY_MAX_BYTES + 1)
        )
        .is_err());
        validate_process_session_idempotency_key("source-action:123/correlation:456")
            .expect("bounded opaque key");
    }

    #[test]
    fn machine_readable_feed_contract_matches_rust_constants() {
        let raw = std::fs::read_to_string(format!(
            "{}/contracts/process-session-feed-contract.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .expect("read machine-readable process-session feed contract");
        let parsed: ProcessSessionFeedContract =
            serde_json::from_str(&raw).expect("parse machine-readable feed contract JSON");

        let expected = [
            (
                "PROCESS_SESSIONS",
                PROCESS_SESSIONS_FEED_LABEL,
                "label_hash",
                Some(hex_encode(
                    &FactAddress::hash_from(PROCESS_SESSIONS_FEED_LABEL)
                        .as_multihash()
                        .encode(),
                )),
                None,
            ),
            (
                "PROCESS_SESSION_EVENTS",
                PROCESS_SESSION_EVENTS_FEED_LABEL,
                "process_session",
                None,
                Some("event_feed_address"),
            ),
            (
                "PROCESS_SESSION_EVENT_STREAM",
                PROCESS_SESSION_EVENT_STREAM_LABEL,
                "process_session",
                None,
                Some("event_stream_address"),
            ),
            (
                "PROCESS_SESSION_TERMINAL_OUTPUT",
                PROCESS_SESSION_TERMINAL_OUTPUT_LABEL,
                "process_session",
                None,
                Some("terminal_output_address"),
            ),
            (
                "PROCESS_SESSION_SURFACE_OBSERVATION",
                PROCESS_SESSION_SURFACE_OBSERVATION_LABEL,
                "process_session_bootstrap",
                None,
                Some("surface_isolation_observations[].observation_ref"),
            ),
            (
                "PROCESS_SESSION_START_IDEMPOTENCY",
                PROCESS_SESSION_START_IDEMPOTENCY_LABEL,
                "idempotency_key",
                None,
                Some("idempotency_key"),
            ),
        ];

        assert_eq!(
            parsed.feeds.len(),
            expected.len(),
            "machine-readable contract must enumerate the same number of feeds as the Rust API"
        );

        for (
            index,
            (
                expected_key,
                expected_label,
                expected_address_mode,
                expected_address_hex,
                expected_field,
            ),
        ) in expected.iter().enumerate()
        {
            let record = &parsed.feeds[index];
            assert_eq!(&record.key, expected_key);
            assert_eq!(&record.label, expected_label);
            assert_eq!(&record.address_mode, expected_address_mode);
            assert_eq!(&record.address_hex, expected_address_hex);
            assert_eq!(record.address_field.as_deref(), *expected_field);
        }
    }

    #[test]
    fn process_session_events_feed_binary_round_trips_all_event_kinds() {
        let feed = ProcessSessionEventsFeed {
            events: vec![
                ProcessSessionEvent {
                    session_id: "session-a".into(),
                    event_number: 1,
                    recorded_at_ms: 11,
                    kind: ProcessSessionEventKind::OutputBytes {
                        stream: ProcessSessionOutputStream::Display,
                        bytes: vec![1, 2, 3, 4],
                    },
                },
                ProcessSessionEvent {
                    session_id: "session-b".into(),
                    event_number: 7,
                    recorded_at_ms: 12,
                    kind: ProcessSessionEventKind::SessionStateChanged {
                        state: ProcessSessionState::Exited,
                        exit_code: Some(0),
                        failure_reason: None,
                    },
                },
                ProcessSessionEvent {
                    session_id: "session-a".into(),
                    event_number: 8,
                    recorded_at_ms: 13,
                    kind: ProcessSessionEventKind::CommandRejected {
                        reason: "stdin closed".into(),
                    },
                },
                ProcessSessionEvent {
                    session_id: "session-a".into(),
                    event_number: 9,
                    recorded_at_ms: 14,
                    kind: ProcessSessionEventKind::SessionStateChanged {
                        state: ProcessSessionState::Failed,
                        exit_code: None,
                        failure_reason: Some("timeout".into()),
                    },
                },
            ],
        };

        let encoded = encode_process_session_events_feed(&feed).expect("encode feed");
        let decoded = decode_process_session_events_feed(&encoded).expect("decode feed");

        assert_eq!(decoded, feed);
    }

    #[test]
    fn process_sessions_feed_encodes_record_table_snapshots() {
        let feed = ProcessSessionsFeed {
            sessions: vec![ProcessSessionSnapshot {
                session_id: "session-a".into(),
                event_feed_address: "event-address-a".into(),
                event_stream_address: "event-stream-address-a".into(),
                state: ProcessSessionState::Running,
                process: ProcessDescriptor {
                    argv: vec!["codex".into(), "--ask".into()],
                    cwd: Some("work/project".into()),
                    timeout_ms: 5_000,
                    termination_grace_ms: DEFAULT_PROCESS_TERMINATION_GRACE_MS,
                    expected_termination: Some(ProcessTermination::Exited { code: 0 }),
                    env: BTreeMap::new(),
                    inputs: Vec::new(),
                    input_trees: Vec::new(),
                    outputs: Vec::new(),
                    private_volume: None,
                    readable_private_volumes: Vec::new(),
                    network_access: crate::ProcessNetworkAccess::Denied,
                    containment: ProcessContainmentRequest::Leaf,
                    capture_fds: vec![1, 2],
                    collected_files: Vec::new(),
                },
                session_settings: ProcessSessionSettings {
                    text_grid: Some(ProcessSessionTextGrid {
                        columns: 120,
                        rows: 40,
                    }),
                },
                started_at_ms: 11,
                updated_at_ms: 12,
                command_count: 2,
                event_count: 3,
                exit_code: None,
                failure_reason: None,
                terminal_output_address: "terminal-output-address-a".into(),
                surface_isolation_observations: vec![ProcessSessionSurfaceIsolationBinding {
                    bootstrap_identity: format!("sha256:{}", "a".repeat(64)),
                    task_ref: "task:feed-proof".into(),
                    provider_session_id: "provider-session:feed-proof".into(),
                    lifecycle_revision: "lifecycle:feed-proof".into(),
                    observation_ref: "observation-address-a".into(),
                    observation_hash: format!("1f:{}", "b".repeat(64)),
                    valid_until_ms: 99,
                }],
            }],
        };

        let encoded = encode_process_sessions_feed(&feed).expect("encode process-sessions feed");

        assert_eq!(&encoded[0..5], &[0x52, 0x54, 0x42, 0x4c, 1]);
        assert_eq!(u32::from_le_bytes(encoded[8..12].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(encoded[12..16].try_into().unwrap()),
            PROCESS_SESSIONS_FEED_CELL_TABLE_COLUMN_COUNT
        );
        assert_eq!(record_table_cell_text(&encoded, 0, 0), "session-a");
        assert_eq!(record_table_cell_text(&encoded, 0, 1), "event-address-a");
        assert_eq!(record_table_cell_text(&encoded, 0, 2), "running");
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&record_table_cell_text(&encoded, 0, 3))
                .expect("argv JSON"),
            vec!["codex".to_string(), "--ask".to_string()]
        );
        assert_eq!(
            serde_json::from_str::<String>(&record_table_cell_text(&encoded, 0, 4))
                .expect("cwd JSON"),
            "work/project"
        );
        assert_eq!(
            serde_json::from_str::<u64>(&record_table_cell_text(&encoded, 0, 6))
                .expect("started_at_ms JSON"),
            11
        );
        assert!(
            serde_json::from_str::<Option<i32>>(&record_table_cell_text(&encoded, 0, 10))
                .expect("exit_code JSON")
                .is_none()
        );
        // Column 12 is APPENDED so published index-addressed projections stay
        // valid without edits; new consumers opt in with one DATA field row.
        assert_eq!(
            record_table_cell_text(&encoded, 0, 12),
            "event-stream-address-a"
        );
        // Column 13 is APPENDED for terminal output address (authoritative full output)
        assert_eq!(
            record_table_cell_text(&encoded, 0, 13),
            "terminal-output-address-a"
        );
        let encoded_bindings = serde_json::from_str::<Vec<ProcessSessionSurfaceIsolationBinding>>(
            &record_table_cell_text(&encoded, 0, 14),
        )
        .expect("surface isolation bindings JSON");
        assert_eq!(
            encoded_bindings,
            feed.sessions[0].surface_isolation_observations
        );
        assert_eq!(
            decode_process_session_surface_isolation_bindings(&encoded, "session-a")
                .expect("decode current surface bindings"),
            Some(feed.sessions[0].surface_isolation_observations.clone())
        );
        assert_eq!(
            decode_process_session_surface_isolation_bindings(&encoded, "missing-session")
                .expect("missing session is not malformed"),
            None
        );
    }

    fn record_table_cell_text(bytes: &[u8], row: u32, column: u32) -> String {
        const HEADER_LEN: usize = 16;
        const INDEX_LEN: usize = 8;
        let column_count = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        let cell_index = (row * column_count + column) as usize;
        let index_offset = HEADER_LEN + cell_index * INDEX_LEN;
        let offset =
            u32::from_le_bytes(bytes[index_offset..index_offset + 4].try_into().unwrap()) as usize;
        let len = u32::from_le_bytes(
            bytes[index_offset + 4..index_offset + 8]
                .try_into()
                .unwrap(),
        ) as usize;
        let row_count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let payload_offset = HEADER_LEN + row_count * column_count as usize * INDEX_LEN;
        std::str::from_utf8(&bytes[payload_offset + offset..payload_offset + offset + len])
            .expect("cell utf-8")
            .to_string()
    }

    #[test]
    fn process_session_events_feed_binary_rejects_unknown_version() {
        let mut encoded = encode_process_session_events_feed(&ProcessSessionEventsFeed::default())
            .expect("encode empty feed");
        encoded[0] = PROCESS_SESSION_EVENTS_FEED_BINARY_VERSION.wrapping_add(1);

        assert!(matches!(
            decode_process_session_events_feed(&encoded),
            Err(ProcessSessionEventsFeedCodecError::InvalidFormat { reason })
                if reason.contains("unsupported version")
        ));
    }
}
