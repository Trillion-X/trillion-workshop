//! crates/composition-engine-core/src/bridge/data.rs
//!
//! Data Bridge — Abstract trait for EEAF data access.
//!
//! # Purpose
//! Provides a stable interface for reads and transactions with the EEAF
//! (Entity-Attribute-Fact Architecture) data layer. Platform adapters
//! implement this trait to bridge the composition engine to their data store.
//!
//! # Non-Negotiable Invariants
//! - No global state, no side effects beyond the trait methods.
//! - Small surface area. Zero knowledge of kernel internals.
//! - All methods are async (Rust Future-based).
//!
//! # Key Concepts
//! - execute_read: Query EEAF entities
//! - execute_transact: Create/update/delete EEAF entities
//! - subscribe: Subscribe to real-time updates (optional)
//!
//! # Security Considerations
//! - Does not construct SQL or execute arbitrary queries.
//! - All parameters are strongly typed.
//! - Idempotency key support for safe retries.
//!
//! Ported from: frontends/web/composition-engine/bridge/data.ts

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

// ============================================================================
// Types
// ============================================================================

/// Sort direction for order by clauses
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

/// Order by specification
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderBy {
    pub column: String,
    pub dir: SortDirection,
}

impl OrderBy {
    pub fn asc(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            dir: SortDirection::Asc,
        }
    }

    pub fn desc(column: impl Into<String>) -> Self {
        Self {
            column: column.into(),
            dir: SortDirection::Desc,
        }
    }
}

/// Filter condition for where clauses
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum FilterCondition {
    /// Equality: column = value
    Eq {
        column: String,
        value: serde_json::Value,
    },
    /// Not equal: column != value
    Ne {
        column: String,
        value: serde_json::Value,
    },
    /// Greater than: column > value
    Gt {
        column: String,
        value: serde_json::Value,
    },
    /// Greater than or equal: column >= value
    Gte {
        column: String,
        value: serde_json::Value,
    },
    /// Less than: column < value
    Lt {
        column: String,
        value: serde_json::Value,
    },
    /// Less than or equal: column <= value
    Lte {
        column: String,
        value: serde_json::Value,
    },
    /// In list: column IN (values)
    In {
        column: String,
        values: Vec<serde_json::Value>,
    },
    /// Is null: column IS NULL
    IsNull { column: String },
    /// Is not null: column IS NOT NULL
    IsNotNull { column: String },
    /// Like pattern: column LIKE pattern
    Like { column: String, pattern: String },
    /// Logical AND of conditions
    And { conditions: Vec<FilterCondition> },
    /// Logical OR of conditions
    Or { conditions: Vec<FilterCondition> },
}

impl FilterCondition {
    pub fn eq(column: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        Self::Eq {
            column: column.into(),
            value: value.into(),
        }
    }

    pub fn ne(column: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        Self::Ne {
            column: column.into(),
            value: value.into(),
        }
    }

    pub fn and(conditions: Vec<FilterCondition>) -> Self {
        Self::And { conditions }
    }

    pub fn or(conditions: Vec<FilterCondition>) -> Self {
        Self::Or { conditions }
    }
}

/// Read query parameters
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReadParams {
    /// Resource/table name (e.g., "entity", "attribute_fact")
    pub resource: String,
    /// Columns to select (None = all)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<Vec<String>>,
    /// Where clause filter
    #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterCondition>,
    /// Order by clauses
    #[serde(rename = "orderBy", skip_serializing_if = "Option::is_none")]
    pub order_by: Option<Vec<OrderBy>>,
    /// Limit results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Offset for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

impl ReadParams {
    pub fn new(resource: impl Into<String>) -> Self {
        Self {
            resource: resource.into(),
            ..Default::default()
        }
    }

    pub fn select(mut self, columns: Vec<String>) -> Self {
        self.select = Some(columns);
        self
    }

    pub fn filter(mut self, condition: FilterCondition) -> Self {
        self.filter = Some(condition);
        self
    }

    pub fn order_by(mut self, orders: Vec<OrderBy>) -> Self {
        self.order_by = Some(orders);
        self
    }

    pub fn limit(mut self, limit: u32) -> Self {
        self.limit = Some(limit);
        self
    }

    pub fn offset(mut self, offset: u32) -> Self {
        self.offset = Some(offset);
        self
    }
}

/// Transaction action type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransactAction {
    Create,
    Update,
    Delete,
}

/// Transaction parameters
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransactParams {
    /// Resource/table name
    pub resource: String,
    /// Action to perform
    pub action: TransactAction,
    /// Payload for create/update
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<HashMap<String, serde_json::Value>>,
    /// Entity ID for update/delete
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Idempotency key for safe retries
    #[serde(rename = "idempotencyKey", skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

impl TransactParams {
    pub fn create(resource: impl Into<String>) -> Self {
        Self {
            resource: resource.into(),
            action: TransactAction::Create,
            payload: None,
            id: None,
            idempotency_key: None,
        }
    }

    pub fn update(resource: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            resource: resource.into(),
            action: TransactAction::Update,
            payload: None,
            id: Some(id.into()),
            idempotency_key: None,
        }
    }

    pub fn delete(resource: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            resource: resource.into(),
            action: TransactAction::Delete,
            payload: None,
            id: Some(id.into()),
            idempotency_key: None,
        }
    }

    pub fn with_payload(mut self, payload: HashMap<String, serde_json::Value>) -> Self {
        self.payload = Some(payload);
        self
    }

    pub fn with_idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }
}

/// Read result
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadResult {
    /// Returned rows
    pub rows: Vec<serde_json::Value>,
    /// Total count (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// Transaction result
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransactResult {
    /// Created/updated entity ID
    pub id: String,
    /// Number of affected rows
    pub affected: u64,
}

/// Data bridge error
#[derive(Debug, Clone)]
pub struct DataBridgeError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for DataBridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for DataBridgeError {}

/// Result type for data bridge operations
pub type DataResult<T> = Result<T, DataBridgeError>;

// ============================================================================
// Subscription Types
// ============================================================================

/// Subscription callback type
pub type SubscriptionCallback = Box<dyn Fn(&serde_json::Value) + Send + Sync>;

/// Unsubscribe handle
pub type Unsubscribe = Box<dyn FnOnce() + Send>;

/// Subscription parameters
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscribeParams {
    /// Resource to subscribe to
    pub resource: String,
    /// Filter for subscription
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterCondition>,
}

// ============================================================================
// DataBridge Trait
// ============================================================================

/// Async result type alias
pub type AsyncDataResult<'a, T> = Pin<Box<dyn Future<Output = DataResult<T>> + Send + 'a>>;

/// Data Bridge trait — abstract interface for EEAF data access
///
/// Platform adapters implement this trait to bridge the composition engine
/// to their data store (e.g., libSQL, REST API, in-memory mock).
///
/// # Example Implementation
/// ```ignore
/// struct LibsqlDataBridge { /* ... */ }
///
/// impl DataBridge for LibsqlDataBridge {
///     fn execute_read(&self, params: &ReadParams) -> AsyncDataResult<'_, ReadResult> {
///         Box::pin(async move {
///             // Execute read against libSQL
///             Ok(ReadResult { rows: vec![], total: None })
///         })
///     }
///
///     fn execute_transact(&self, params: &TransactParams) -> AsyncDataResult<'_, TransactResult> {
///         Box::pin(async move {
///             // Execute transaction against libSQL
///             Ok(TransactResult { id: "new-id".into(), affected: 1 })
///         })
///     }
/// }
/// ```
pub trait DataBridge: Send + Sync {
    /// Execute a read query
    ///
    /// # Arguments
    /// * `params` - Read query parameters
    ///
    /// # Returns
    /// Read result with rows and optional total count
    fn execute_read(&self, params: &ReadParams) -> AsyncDataResult<'_, ReadResult>;

    /// Execute a transaction (create/update/delete)
    ///
    /// # Arguments
    /// * `params` - Transaction parameters
    ///
    /// # Returns
    /// Transaction result with affected ID and row count
    fn execute_transact(&self, params: &TransactParams) -> AsyncDataResult<'_, TransactResult>;

    /// Subscribe to real-time updates (optional)
    ///
    /// Default implementation returns None (not supported).
    fn subscribe(
        &self,
        _params: &SubscribeParams,
        _callback: SubscriptionCallback,
    ) -> Option<Unsubscribe> {
        None
    }
}

// ============================================================================
// In-Memory Implementation (for testing)
// ============================================================================

/// In-memory data bridge for testing
pub struct InMemoryDataBridge {
    data: std::sync::RwLock<HashMap<String, Vec<serde_json::Value>>>,
}

impl InMemoryDataBridge {
    pub fn new() -> Self {
        Self {
            data: std::sync::RwLock::new(HashMap::new()),
        }
    }

    /// Seed data for testing
    pub fn seed(&self, resource: &str, rows: Vec<serde_json::Value>) {
        let mut data = self.data.write().unwrap();
        data.insert(resource.to_string(), rows);
    }
}

impl Default for InMemoryDataBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl DataBridge for InMemoryDataBridge {
    fn execute_read(&self, params: &ReadParams) -> AsyncDataResult<'_, ReadResult> {
        let resource = params.resource.clone();
        let limit = params.limit;
        let offset = params.offset.unwrap_or(0);

        Box::pin(async move {
            let data = self.data.read().unwrap();
            let rows = data.get(&resource).cloned().unwrap_or_default();

            // Apply pagination
            let total = rows.len() as u64;
            let rows: Vec<_> = rows
                .into_iter()
                .skip(offset as usize)
                .take(limit.unwrap_or(u32::MAX) as usize)
                .collect();

            Ok(ReadResult {
                rows,
                total: Some(total),
            })
        })
    }

    fn execute_transact(&self, params: &TransactParams) -> AsyncDataResult<'_, TransactResult> {
        let resource = params.resource.clone();
        let action = params.action;
        let payload = params.payload.clone();
        let id = params.id.clone();

        Box::pin(async move {
            let mut data = self.data.write().unwrap();
            let rows = data.entry(resource).or_default();

            match action {
                TransactAction::Create => {
                    let new_id = format!("id-{}", rows.len() + 1);
                    let mut row = payload.unwrap_or_default();
                    row.insert("id".to_string(), serde_json::json!(new_id.clone()));
                    rows.push(serde_json::to_value(&row).unwrap());
                    Ok(TransactResult {
                        id: new_id,
                        affected: 1,
                    })
                }
                TransactAction::Update => {
                    let target_id = id.ok_or_else(|| DataBridgeError {
                        code: "MISSING_ID".to_string(),
                        message: "update requires id".to_string(),
                    })?;
                    // Find and update
                    let affected = rows
                        .iter_mut()
                        .filter(|r| r.get("id").and_then(|v| v.as_str()) == Some(&target_id))
                        .count() as u64;
                    Ok(TransactResult {
                        id: target_id,
                        affected,
                    })
                }
                TransactAction::Delete => {
                    let target_id = id.ok_or_else(|| DataBridgeError {
                        code: "MISSING_ID".to_string(),
                        message: "delete requires id".to_string(),
                    })?;
                    let len_before = rows.len();
                    rows.retain(|r| r.get("id").and_then(|v| v.as_str()) != Some(&target_id));
                    let affected = (len_before - rows.len()) as u64;
                    Ok(TransactResult {
                        id: target_id,
                        affected,
                    })
                }
            }
        })
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_in_memory_read() {
        let bridge = InMemoryDataBridge::new();
        bridge.seed(
            "entity",
            vec![
                serde_json::json!({"id": "1", "name": "Alice"}),
                serde_json::json!({"id": "2", "name": "Bob"}),
            ],
        );

        let params = ReadParams::new("entity");
        let result = bridge.execute_read(&params).await.unwrap();

        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.total, Some(2));
    }

    #[tokio::test]
    async fn test_in_memory_create() {
        let bridge = InMemoryDataBridge::new();

        let mut payload = HashMap::new();
        payload.insert("name".to_string(), serde_json::json!("Charlie"));

        let params = TransactParams::create("entity").with_payload(payload);
        let result = bridge.execute_transact(&params).await.unwrap();

        assert_eq!(result.id, "id-1");
        assert_eq!(result.affected, 1);

        // Verify it was created
        let read_result = bridge
            .execute_read(&ReadParams::new("entity"))
            .await
            .unwrap();
        assert_eq!(read_result.rows.len(), 1);
    }

    #[tokio::test]
    async fn test_in_memory_delete() {
        let bridge = InMemoryDataBridge::new();
        bridge.seed(
            "entity",
            vec![
                serde_json::json!({"id": "1", "name": "Alice"}),
                serde_json::json!({"id": "2", "name": "Bob"}),
            ],
        );

        let params = TransactParams::delete("entity", "1");
        let result = bridge.execute_transact(&params).await.unwrap();

        assert_eq!(result.affected, 1);

        // Verify deletion
        let read_result = bridge
            .execute_read(&ReadParams::new("entity"))
            .await
            .unwrap();
        assert_eq!(read_result.rows.len(), 1);
    }

    #[test]
    fn test_read_params_builder() {
        let params = ReadParams::new("entity")
            .select(vec!["id".into(), "name".into()])
            .filter(FilterCondition::eq("status", "active"))
            .order_by(vec![OrderBy::desc("created_at")])
            .limit(10)
            .offset(20);

        assert_eq!(params.resource, "entity");
        assert!(params.select.is_some());
        assert!(params.filter.is_some());
        assert!(params.order_by.is_some());
        assert_eq!(params.limit, Some(10));
        assert_eq!(params.offset, Some(20));
    }

    #[test]
    fn test_transact_params_builder() {
        let mut payload = HashMap::new();
        payload.insert("name".to_string(), serde_json::json!("Test"));

        let params = TransactParams::create("entity")
            .with_payload(payload)
            .with_idempotency_key("test-key-123");

        assert_eq!(params.resource, "entity");
        assert_eq!(params.action, TransactAction::Create);
        assert!(params.payload.is_some());
        assert_eq!(params.idempotency_key, Some("test-key-123".to_string()));
    }
}
