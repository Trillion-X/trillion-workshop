//! crates/composition-engine-core/src/bridge/journal.rs
//!
//! Journal Bridge — Abstract trait for bitemporal journal operations.
//!
//! # Purpose
//! Provides an append-only interface for recording UI events in a bitemporal
//! journal. Enables undo/redo operations by tracking state changes over time.
//! Enforces first-writer-wins via idempotency keys.
//!
//! # Non-Negotiable Invariants
//! - No retries or backoff here; responsibility of the caller.
//! - Does not interpret payloads; opaque pass-through.
//! - Append-only semantics (no direct updates to history).
//!
//! # Key Concepts
//! - JournalEntry: A single recorded event with branch ID, record ID, operation, and value
//! - Branch: Isolated timeline (e.g., `workspace:ui`, `document:123`)
//! - Head: Latest entry in a branch (for optimistic concurrency)
//!
//! # Security Considerations
//! - Avoids logging sensitive values.
//! - Does not construct SQL. Server handles authorization.
//!
//! Ported from: frontends/web/composition-engine/bridge/journal.ts

use super::data::{DataBridge, DataBridgeError, DataResult, TransactParams};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;

// ============================================================================
// Types
// ============================================================================

/// Journal entry to append
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalAppend {
    /// Branch identifier (e.g., "workspace:ui", "document:123")
    #[serde(rename = "branchId")]
    pub branch_id: String,
    /// Record identifier (e.g., entity ID being modified)
    #[serde(rename = "recordId")]
    pub record_id: String,
    /// Operation type (e.g., "UPDATE", "CREATE", "DELETE")
    pub op: String,
    /// Operation value/payload
    pub value: serde_json::Value,
    /// Expected head for optimistic concurrency (optional)
    #[serde(rename = "ifMatchHead", skip_serializing_if = "Option::is_none")]
    pub if_match_head: Option<String>,
    /// Idempotency key for first-writer-wins (optional)
    #[serde(rename = "idemKey", skip_serializing_if = "Option::is_none")]
    pub idem_key: Option<String>,
}

impl JournalAppend {
    pub fn new(
        branch_id: impl Into<String>,
        record_id: impl Into<String>,
        op: impl Into<String>,
    ) -> Self {
        Self {
            branch_id: branch_id.into(),
            record_id: record_id.into(),
            op: op.into(),
            value: serde_json::Value::Null,
            if_match_head: None,
            idem_key: None,
        }
    }

    pub fn with_value(mut self, value: serde_json::Value) -> Self {
        self.value = value;
        self
    }

    pub fn with_if_match_head(mut self, head: impl Into<String>) -> Self {
        self.if_match_head = Some(head.into());
        self
    }

    pub fn with_idem_key(mut self, key: impl Into<String>) -> Self {
        self.idem_key = Some(key.into());
        self
    }
}

/// Result of journal append
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalAppendResult {
    /// ID of the created journal entry
    pub id: String,
    /// New head after append
    pub head: String,
}

/// Journal entry (full record from database)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub id: String,
    #[serde(rename = "branchId")]
    pub branch_id: String,
    #[serde(rename = "recordId")]
    pub record_id: String,
    pub op: String,
    pub value: serde_json::Value,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Previous entry ID (for chain traversal)
    #[serde(rename = "prevId", skip_serializing_if = "Option::is_none")]
    pub prev_id: Option<String>,
}

/// Undo/redo state for a branch
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct UndoRedoState {
    /// Current position in history (entry ID)
    pub current: Option<String>,
    /// Whether undo is available
    pub can_undo: bool,
    /// Whether redo is available
    pub can_redo: bool,
    /// Undo stack (entry IDs)
    pub undo_stack: Vec<String>,
    /// Redo stack (entry IDs)
    pub redo_stack: Vec<String>,
}

// ============================================================================
// JournalBridge Trait
// ============================================================================

/// Async result type alias for journal operations
pub type AsyncJournalResult<'a, T> = Pin<Box<dyn Future<Output = DataResult<T>> + Send + 'a>>;

/// Journal Bridge trait — abstract interface for bitemporal journal operations
///
/// Platform adapters implement this trait to provide undo/redo functionality
/// backed by their data store.
///
/// # Example Implementation
/// ```ignore
/// struct LibsqlJournalBridge { data: Arc<dyn DataBridge> }
///
/// impl JournalBridge for LibsqlJournalBridge {
///     fn append(&self, entry: &JournalAppend) -> AsyncJournalResult<'_, JournalAppendResult> {
///         Box::pin(async move {
///             // Append to journal table via DataBridge
///             Ok(JournalAppendResult { id: "entry-1".into(), head: "entry-1".into() })
///         })
///     }
///     // ... other methods
/// }
/// ```
pub trait JournalBridge: Send + Sync {
    /// Append a new entry to the journal
    ///
    /// # Arguments
    /// * `entry` - Journal entry to append
    ///
    /// # Returns
    /// Result with created entry ID and new head
    fn append(&self, entry: &JournalAppend) -> AsyncJournalResult<'_, JournalAppendResult>;

    /// Get current head for a branch
    ///
    /// # Arguments
    /// * `branch_id` - Branch identifier
    ///
    /// # Returns
    /// Head entry ID (or None if branch is empty)
    fn get_head(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<String>>;

    /// Get a journal entry by ID
    ///
    /// # Arguments
    /// * `id` - Entry ID
    ///
    /// # Returns
    /// Journal entry if found
    fn get_entry(&self, id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>>;

    /// Get history for a branch (most recent first)
    ///
    /// # Arguments
    /// * `branch_id` - Branch identifier
    /// * `limit` - Maximum entries to return
    ///
    /// # Returns
    /// List of journal entries
    fn get_history(&self, branch_id: &str, limit: u32)
        -> AsyncJournalResult<'_, Vec<JournalEntry>>;

    /// Get undo/redo state for a branch
    ///
    /// # Arguments
    /// * `branch_id` - Branch identifier
    ///
    /// # Returns
    /// Current undo/redo state
    fn get_undo_redo_state(&self, branch_id: &str) -> AsyncJournalResult<'_, UndoRedoState>;

    /// Perform undo operation
    ///
    /// # Arguments
    /// * `branch_id` - Branch identifier
    ///
    /// # Returns
    /// The entry that was undone (to replay its inverse)
    fn undo(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>>;

    /// Perform redo operation
    ///
    /// # Arguments
    /// * `branch_id` - Branch identifier
    ///
    /// # Returns
    /// The entry that was redone (to replay)
    fn redo(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>>;
}

// ============================================================================
// In-Memory Implementation (for testing)
// ============================================================================

/// In-memory journal bridge for testing
pub struct InMemoryJournalBridge {
    entries: std::sync::RwLock<Vec<JournalEntry>>,
    heads: std::sync::RwLock<std::collections::HashMap<String, String>>,
    undo_positions: std::sync::RwLock<std::collections::HashMap<String, usize>>,
}

impl InMemoryJournalBridge {
    pub fn new() -> Self {
        Self {
            entries: std::sync::RwLock::new(Vec::new()),
            heads: std::sync::RwLock::new(std::collections::HashMap::new()),
            undo_positions: std::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }
}

impl Default for InMemoryJournalBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl JournalBridge for InMemoryJournalBridge {
    fn append(&self, entry: &JournalAppend) -> AsyncJournalResult<'_, JournalAppendResult> {
        let entry_clone = entry.clone();
        Box::pin(async move {
            let mut entries = self.entries.write().unwrap();
            let mut heads = self.heads.write().unwrap();

            // Check if_match_head for optimistic concurrency
            if let Some(expected_head) = &entry_clone.if_match_head {
                let current_head = heads.get(&entry_clone.branch_id);
                if current_head != Some(expected_head) {
                    return Err(DataBridgeError {
                        code: "HEAD_MISMATCH".to_string(),
                        message: format!(
                            "Expected head {} but found {:?}",
                            expected_head, current_head
                        ),
                    });
                }
            }

            // Create new entry
            let new_id = format!("entry-{}", entries.len() + 1);
            let prev_id = heads.get(&entry_clone.branch_id).cloned();

            let journal_entry = JournalEntry {
                id: new_id.clone(),
                branch_id: entry_clone.branch_id.clone(),
                record_id: entry_clone.record_id,
                op: entry_clone.op,
                value: entry_clone.value,
                created_at: chrono::Utc::now().to_rfc3339(),
                prev_id,
            };

            entries.push(journal_entry);
            heads.insert(entry_clone.branch_id, new_id.clone());

            Ok(JournalAppendResult {
                id: new_id.clone(),
                head: new_id,
            })
        })
    }

    fn get_head(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<String>> {
        let branch_id = branch_id.to_string();
        Box::pin(async move {
            let heads = self.heads.read().unwrap();
            Ok(heads.get(&branch_id).cloned())
        })
    }

    fn get_entry(&self, id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>> {
        let id = id.to_string();
        Box::pin(async move {
            let entries = self.entries.read().unwrap();
            Ok(entries.iter().find(|e| e.id == id).cloned())
        })
    }

    fn get_history(
        &self,
        branch_id: &str,
        limit: u32,
    ) -> AsyncJournalResult<'_, Vec<JournalEntry>> {
        let branch_id = branch_id.to_string();
        Box::pin(async move {
            let entries = self.entries.read().unwrap();
            let mut history: Vec<_> = entries
                .iter()
                .filter(|e| e.branch_id == branch_id)
                .cloned()
                .collect();
            history.reverse(); // Most recent first
            history.truncate(limit as usize);
            Ok(history)
        })
    }

    fn get_undo_redo_state(&self, branch_id: &str) -> AsyncJournalResult<'_, UndoRedoState> {
        let branch_id = branch_id.to_string();
        Box::pin(async move {
            let entries = self.entries.read().unwrap();
            let positions = self.undo_positions.read().unwrap();

            let branch_entries: Vec<_> = entries
                .iter()
                .filter(|e| e.branch_id == branch_id)
                .collect();

            let position = positions
                .get(&branch_id)
                .copied()
                .unwrap_or(branch_entries.len());

            Ok(UndoRedoState {
                current: branch_entries
                    .get(position.saturating_sub(1))
                    .map(|e| e.id.clone()),
                can_undo: position > 0,
                can_redo: position < branch_entries.len(),
                undo_stack: branch_entries[..position]
                    .iter()
                    .map(|e| e.id.clone())
                    .collect(),
                redo_stack: branch_entries[position..]
                    .iter()
                    .map(|e| e.id.clone())
                    .collect(),
            })
        })
    }

    fn undo(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>> {
        let branch_id = branch_id.to_string();
        Box::pin(async move {
            let entries = self.entries.read().unwrap();
            let mut positions = self.undo_positions.write().unwrap();

            let branch_entries: Vec<_> = entries
                .iter()
                .filter(|e| e.branch_id == branch_id)
                .cloned()
                .collect();

            let position = positions
                .get(&branch_id)
                .copied()
                .unwrap_or(branch_entries.len());

            if position > 0 {
                let new_position = position - 1;
                positions.insert(branch_id, new_position);
                Ok(Some(branch_entries[new_position].clone()))
            } else {
                Ok(None)
            }
        })
    }

    fn redo(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>> {
        let branch_id = branch_id.to_string();
        Box::pin(async move {
            let entries = self.entries.read().unwrap();
            let mut positions = self.undo_positions.write().unwrap();

            let branch_entries: Vec<_> = entries
                .iter()
                .filter(|e| e.branch_id == branch_id)
                .cloned()
                .collect();

            let position = positions
                .get(&branch_id)
                .copied()
                .unwrap_or(branch_entries.len());

            if position < branch_entries.len() {
                positions.insert(branch_id, position + 1);
                Ok(Some(branch_entries[position].clone()))
            } else {
                Ok(None)
            }
        })
    }
}

// ============================================================================
// DataBridge-based Implementation
// ============================================================================

use std::sync::Arc;

/// Journal bridge backed by DataBridge
///
/// Uses the DataBridge trait to persist journal entries to the underlying
/// data store (e.g., libSQL).
pub struct DataBridgeJournal {
    data: Arc<dyn DataBridge>,
}

impl DataBridgeJournal {
    pub fn new(data: Arc<dyn DataBridge>) -> Self {
        Self { data }
    }
}

impl JournalBridge for DataBridgeJournal {
    fn append(&self, entry: &JournalAppend) -> AsyncJournalResult<'_, JournalAppendResult> {
        let data = Arc::clone(&self.data);
        let entry = entry.clone();

        Box::pin(async move {
            let mut payload = std::collections::HashMap::new();
            payload.insert("branch_id".to_string(), serde_json::json!(entry.branch_id));
            payload.insert("record_id".to_string(), serde_json::json!(entry.record_id));
            payload.insert("op".to_string(), serde_json::json!(entry.op));
            payload.insert("value_json".to_string(), entry.value);

            if let Some(head) = entry.if_match_head {
                payload.insert("if_match_head".to_string(), serde_json::json!(head));
            }

            let mut params = TransactParams::create("journal").with_payload(payload);
            if let Some(key) = entry.idem_key {
                params = params.with_idempotency_key(key);
            }

            let result = data.execute_transact(&params).await?;

            Ok(JournalAppendResult {
                id: result.id.clone(),
                head: result.id,
            })
        })
    }

    fn get_head(&self, branch_id: &str) -> AsyncJournalResult<'_, Option<String>> {
        let data = Arc::clone(&self.data);
        let branch_id = branch_id.to_string();

        Box::pin(async move {
            use super::data::{FilterCondition, OrderBy, ReadParams};

            let params = ReadParams::new("journal")
                .filter(FilterCondition::eq("branch_id", branch_id))
                .order_by(vec![OrderBy::desc("created_at")])
                .limit(1);

            let result = data.execute_read(&params).await?;

            Ok(result
                .rows
                .first()
                .and_then(|r| r.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())))
        })
    }

    fn get_entry(&self, id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>> {
        let data = Arc::clone(&self.data);
        let id = id.to_string();

        Box::pin(async move {
            use super::data::{FilterCondition, ReadParams};

            let params = ReadParams::new("journal")
                .filter(FilterCondition::eq("id", id))
                .limit(1);

            let result = data.execute_read(&params).await?;

            Ok(result
                .rows
                .first()
                .and_then(|r| serde_json::from_value(r.clone()).ok()))
        })
    }

    fn get_history(
        &self,
        branch_id: &str,
        limit: u32,
    ) -> AsyncJournalResult<'_, Vec<JournalEntry>> {
        let data = Arc::clone(&self.data);
        let branch_id = branch_id.to_string();

        Box::pin(async move {
            use super::data::{FilterCondition, OrderBy, ReadParams};

            let params = ReadParams::new("journal")
                .filter(FilterCondition::eq("branch_id", branch_id))
                .order_by(vec![OrderBy::desc("created_at")])
                .limit(limit);

            let result = data.execute_read(&params).await?;

            Ok(result
                .rows
                .into_iter()
                .filter_map(|r| serde_json::from_value(r).ok())
                .collect())
        })
    }

    fn get_undo_redo_state(&self, _branch_id: &str) -> AsyncJournalResult<'_, UndoRedoState> {
        // Simplified implementation - real one would track cursor position
        Box::pin(async move { Ok(UndoRedoState::default()) })
    }

    fn undo(&self, _branch_id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>> {
        // Simplified - real implementation would manage cursor and return entry
        Box::pin(async move { Ok(None) })
    }

    fn redo(&self, _branch_id: &str) -> AsyncJournalResult<'_, Option<JournalEntry>> {
        // Simplified - real implementation would manage cursor and return entry
        Box::pin(async move { Ok(None) })
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_in_memory_append() {
        let journal = InMemoryJournalBridge::new();

        let entry = JournalAppend::new("workspace:ui", "node-1", "UPDATE")
            .with_value(serde_json::json!({"x": 100, "y": 200}));

        let result = journal.append(&entry).await.unwrap();
        assert_eq!(result.id, "entry-1");
        assert_eq!(result.head, "entry-1");
    }

    #[tokio::test]
    async fn test_in_memory_head() {
        let journal = InMemoryJournalBridge::new();

        // Initially no head
        let head = journal.get_head("workspace:ui").await.unwrap();
        assert!(head.is_none());

        // After append, head is set
        let entry = JournalAppend::new("workspace:ui", "node-1", "UPDATE");
        journal.append(&entry).await.unwrap();

        let head = journal.get_head("workspace:ui").await.unwrap();
        assert_eq!(head, Some("entry-1".to_string()));
    }

    #[tokio::test]
    async fn test_in_memory_history() {
        let journal = InMemoryJournalBridge::new();

        // Append multiple entries
        for i in 1..=5 {
            let entry = JournalAppend::new("workspace:ui", format!("node-{}", i), "UPDATE");
            journal.append(&entry).await.unwrap();
        }

        let history = journal.get_history("workspace:ui", 3).await.unwrap();
        assert_eq!(history.len(), 3);
        // Most recent first
        assert_eq!(history[0].id, "entry-5");
        assert_eq!(history[1].id, "entry-4");
        assert_eq!(history[2].id, "entry-3");
    }

    #[tokio::test]
    async fn test_in_memory_undo_redo() {
        let journal = InMemoryJournalBridge::new();

        // Append entries
        for i in 1..=3 {
            let entry = JournalAppend::new("workspace:ui", format!("node-{}", i), "UPDATE");
            journal.append(&entry).await.unwrap();
        }

        // Initial state
        let state = journal.get_undo_redo_state("workspace:ui").await.unwrap();
        assert!(state.can_undo);
        assert!(!state.can_redo);

        // Undo
        let undone = journal.undo("workspace:ui").await.unwrap();
        assert!(undone.is_some());
        assert_eq!(undone.unwrap().id, "entry-3");

        // Now can redo
        let state = journal.get_undo_redo_state("workspace:ui").await.unwrap();
        assert!(state.can_redo);

        // Redo
        let redone = journal.redo("workspace:ui").await.unwrap();
        assert!(redone.is_some());
        assert_eq!(redone.unwrap().id, "entry-3");
    }

    #[tokio::test]
    async fn test_optimistic_concurrency() {
        let journal = InMemoryJournalBridge::new();

        // First append
        let entry1 = JournalAppend::new("workspace:ui", "node-1", "UPDATE");
        journal.append(&entry1).await.unwrap();

        // Append with wrong head should fail
        let entry2 =
            JournalAppend::new("workspace:ui", "node-2", "UPDATE").with_if_match_head("wrong-head");
        let result = journal.append(&entry2).await;
        assert!(result.is_err());

        // Append with correct head should succeed
        let entry3 =
            JournalAppend::new("workspace:ui", "node-3", "UPDATE").with_if_match_head("entry-1");
        let result = journal.append(&entry3).await;
        assert!(result.is_ok());
    }
}
