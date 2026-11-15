//! Evaluation Context Management for the Formula Engine
//!
//! This module provides the EvaluationContext struct that manages:
//! - Variable bindings and scope handling
//! - Scope context and metadata
//! - ReadSet tracking for dependency analysis
//! - Security context and permission validation
//!
//! ## Architecture
//!
//! The EvaluationContext serves as the "environment" for formula evaluation:
//! - Variables: Named values available during evaluation
//! - Scope: Current scope metadata and settings
//! - ReadSet: Tracks all data dependencies discovered during evaluation
//! - Security: Permission checks and access control
//!
//! ## Usage
//!
//! ```rust
//! use formula_core::{EvaluationContext, Value};
//!
//! let mut context = EvaluationContext::new();
//! context.set_variable("x", Value::number(42.0));
//! context.set_partition_key("partition_123");
//!
//! // During evaluation, dependencies are automatically tracked
//! context.with_readset(|readset| { /* access readset here */ }); // All data accessed
//! ```

use crate::types::Value;
use chrono::{DateTime, TimeZone, Utc};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

// Constants for default values
const DEFAULT_TIMEZONE: &str = "UTC";
const DEFAULT_LOCALE: &str = "en-US";
const DEFAULT_DETERMINISM_LEVEL: &str = "strict";
const DEFAULT_FLOAT_MODE: &str = "strict";

/// Errors that can occur during context validation
#[derive(Debug, Clone, PartialEq)]
pub enum ContextValidationError {
    SecurityViolation {
        message: String,
        context: String,
    },
    InvalidConfiguration {
        field: String,
        message: String,
    },
    ResourceLimit {
        resource: String,
        limit: usize,
        current: usize,
    },
}

impl std::fmt::Display for ContextValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContextValidationError::SecurityViolation { message, context } => {
                write!(f, "Security violation in {}: {}", context, message)
            }
            ContextValidationError::InvalidConfiguration { field, message } => {
                write!(f, "Invalid configuration for '{}': {}", field, message)
            }
            ContextValidationError::ResourceLimit {
                resource,
                limit,
                current,
            } => {
                write!(
                    f,
                    "Resource limit exceeded for '{}': {} > {} (limit)",
                    resource, current, limit
                )
            }
        }
    }
}

impl std::error::Error for ContextValidationError {}

/// Caller-provided inputs required to create a complete evaluation context.
///
/// A named input struct keeps the constructor explicit without relying on
/// argument position across thirteen independent values.
#[derive(Debug, Clone)]
pub struct EvaluationContextInput {
    pub data: Value,
    pub actor_id: String,
    pub partition_key: String,
    pub owner_id: Option<String>,
    pub actor_permissions: Vec<String>,
    pub deterministic_now: DateTime<Utc>,
    pub user_timezone: String,
    pub locale: String,
    pub determinism_level: String,
    pub float_mode: String,
    pub execution_seed: u64,
    pub scope_metadata: HashMap<String, Value>,
    pub max_traversal_depth: usize,
}

/// Evaluation context that manages variables, scope, and dependency tracking  
#[derive(Debug)]
pub struct EvaluationContext {
    // Core Data & Actor Info (PRIVATE FIELDS with public getters for encapsulation)
    /// The full data context (e.g., entity data) the formula can access.
    data: Value,
    /// The identity of the user or system initiating the evaluation.
    actor_id: String,
    /// The scope ID for strict tenant isolation in cache keys.
    partition_key: String,
    /// A sorted and deduplicated list of permission strings for cache security fingerprinting.
    /// INVARIANT: This vector MUST be sorted and deduplicated before hashing.
    actor_permissions: Vec<String>,

    // Determinism & Environment Controls (PRIVATE FIELDS with public getters for encapsulation)
    /// The single, deterministic timestamp for this entire transaction.
    /// Any call to NOW() or TODAY() within the formula will use this value.
    deterministic_now: DateTime<Utc>,
    /// The user's preferred IANA timezone string (e.g., "America/New_York").
    user_timezone: String,
    /// The user's locale string for internationalization-aware calculations.
    locale: String,
    /// The determinism level: "strict", "timebound", or "stochastic_fixed_seed".
    determinism_level: String,
    /// The floating-point mode: "strict" (rust_decimal) or "fast" (f64).
    float_mode: String,
    /// Seed for PRNG in stochastic mode - MUST be included in cache key.
    execution_seed: u64,

    // Existing private fields from original implementation
    /// Variable bindings (name -> value)
    variables: HashMap<String, Value>,
    /// Scope context information
    scope: ScopeContext,
    /// ReadSet tracking for dependency analysis
    readset: RefCell<ReadSet>,
    /// Security context for permission checks
    security: SecurityContext,
    /// Data binding resolver for external data access
    data_resolver: Box<dyn DataBindingResolver>,
    /// Holds a reference to the special scope profile entity, represented as a Value.
    scope_profile: Option<Value>,
}

// Manual Clone implementation needed because of Box<dyn Trait>
impl Clone for EvaluationContext {
    fn clone(&self) -> Self {
        Self {
            // Public amendment fields
            data: self.data.clone(),
            actor_id: self.actor_id.clone(),
            partition_key: self.partition_key.clone(),
            actor_permissions: self.actor_permissions.clone(),
            deterministic_now: self.deterministic_now,
            user_timezone: self.user_timezone.clone(),
            locale: self.locale.clone(),
            determinism_level: self.determinism_level.clone(),
            float_mode: self.float_mode.clone(),
            execution_seed: self.execution_seed,
            // Original private fields
            variables: self.variables.clone(),
            scope: self.scope.clone(),
            readset: self.readset.clone(),
            security: self.security.clone(),
            data_resolver: self.data_resolver.clone_box(),
            scope_profile: self.scope_profile.clone(),
        }
    }
}

/// Scope-specific context information
#[derive(Debug, Clone)]
pub struct ScopeContext {
    /// Scope ID
    pub partition_key: Option<String>,
    /// Owner ID
    pub owner_id: Option<String>,
    /// Scope metadata
    pub metadata: HashMap<String, Value>,
}

/// ReadSet tracks all data dependencies discovered during evaluation
#[derive(Debug, Clone, Default)]
pub struct ReadSet {
    /// Variable names that were accessed
    variables: HashSet<String>,
    /// Entity references that were accessed (entity.attribute)
    entity_references: HashSet<String>,
    /// Special references that were accessed (@, @@, $scope)
    special_references: HashSet<String>,
    /// Function calls that were made
    function_calls: HashSet<String>,
}

/// Data binding resolver trait for external data access
pub trait DataBindingResolver: Send + Sync + std::fmt::Debug {
    /// Resolve an entity reference to its data
    fn resolve_entity(&self, entity_path: &str) -> Option<Value>;

    /// Check if an entity reference exists and is accessible
    fn can_access_entity(&self, entity_path: &str, user_id: Option<&str>) -> bool;

    /// Clone method for trait objects
    fn clone_box(&self) -> Box<dyn DataBindingResolver>;
}

/// Default data binding resolver (returns None for all bindings)
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultDataBindingResolver;

impl DataBindingResolver for DefaultDataBindingResolver {
    fn resolve_entity(&self, _entity_path: &str) -> Option<Value> {
        None
    }

    fn can_access_entity(&self, _entity_path: &str, _user_id: Option<&str>) -> bool {
        false
    }

    fn clone_box(&self) -> Box<dyn DataBindingResolver> {
        Box::new(*self)
    }
}

/// Security context for permission validation
#[derive(Debug, Clone, Default)]
pub struct SecurityContext {
    /// User ID for permission checks
    pub user_id: Option<String>,
    /// Available permissions/capabilities
    pub permissions: HashSet<String>,
    /// Maximum allowed depth for traversals
    pub max_traversal_depth: usize,
}

impl EvaluationContext {
    /// Create a new evaluation context
    pub fn new() -> Self {
        Self {
            // Public amendment fields - initialize with placeholder/empty values
            data: Value(serde_json::Value::Null),
            actor_id: String::new(),
            partition_key: String::new(),
            actor_permissions: Vec::new(),
            deterministic_now: chrono::Utc.timestamp_opt(0, 0).single().unwrap(), // Fixed Unix epoch for reproducible tests
            user_timezone: DEFAULT_TIMEZONE.to_string(),
            locale: DEFAULT_LOCALE.to_string(),
            determinism_level: DEFAULT_DETERMINISM_LEVEL.to_string(),
            float_mode: DEFAULT_FLOAT_MODE.to_string(),
            execution_seed: 0,
            // Original private fields
            variables: HashMap::new(),
            scope: ScopeContext::new(),
            readset: RefCell::new(ReadSet::default()),
            security: SecurityContext::new(),
            data_resolver: Box::new(DefaultDataBindingResolver),
            scope_profile: None,
        }
    }

    /// Create a complete evaluation context from caller-provided data.
    /// This is the primary constructor that enforces provision of all required fields.
    pub fn from_input(input: EvaluationContextInput) -> Self {
        let mut ctx = Self::new();

        // Populate amendment fields
        ctx.data = input.data;
        ctx.actor_id = input.actor_id.clone();
        ctx.partition_key = input.partition_key.clone();
        ctx.actor_permissions = input.actor_permissions;
        ctx.deterministic_now = input.deterministic_now;
        ctx.user_timezone = input.user_timezone;
        ctx.locale = input.locale;
        ctx.determinism_level = input.determinism_level;
        ctx.float_mode = input.float_mode;
        ctx.execution_seed = input.execution_seed;

        // CRITICAL: Initialize original private structs completely and consistently
        ctx.scope.partition_key = Some(input.partition_key);
        ctx.scope.owner_id = input.owner_id;
        ctx.scope.metadata = input.scope_metadata;

        ctx.security.user_id = Some(input.actor_id);
        ctx.security.permissions = ctx.actor_permissions.iter().cloned().collect(); // Single source of truth
        ctx.security.max_traversal_depth = input.max_traversal_depth;

        ctx
    }

    /// Create a context with just scope and optional user ID (for tests)
    pub fn with_scope(partition_key: String, user_id: Option<String>) -> Self {
        let mut ctx = Self::new();
        ctx.partition_key = partition_key.clone();
        ctx.scope.partition_key = Some(partition_key);
        if let Some(uid) = user_id {
            ctx.actor_id = uid.clone();
            ctx.security.user_id = Some(uid);
        }
        ctx
    }

    // Variable Management

    /// Set a variable value
    pub fn set_variable<S: Into<String>>(&mut self, name: S, value: Value) {
        self.variables.insert(name.into(), value);
    }

    /// Get a variable value, returning None if not found
    pub fn get_variable(&self, name: &str) -> Option<&Value> {
        self.variables.get(name)
    }

    /// Look up a variable value and track it in the ReadSet
    pub fn lookup_variable(&mut self, name: &str) -> Option<Value> {
        // Track the variable access
        self.readset.borrow_mut().variables.insert(name.to_string());

        // Return the value if it exists
        self.variables.get(name).cloned()
    }

    /// Check if a variable exists
    pub fn has_variable(&self, name: &str) -> bool {
        self.variables.contains_key(name)
    }

    /// Get all variable names
    pub fn get_variable_names(&self) -> Vec<String> {
        self.variables.keys().cloned().collect()
    }

    /// Look up a value within the `data` object.
    /// NOTE: This is a placeholder for a more complex data lookup mechanism.
    pub fn lookup_in_data(&self, name: &str) -> Option<Value> {
        if let Value(serde_json::Value::Object(map)) = &self.data {
            return map.get(name).map(|v| Value(v.clone()));
        }
        None
    }

    /// Record a data read access in the ReadSet using interior mutability.
    pub fn record_read(&self, path: &str) {
        self.readset
            .borrow_mut()
            .entity_references
            .insert(path.to_string());
    }

    // Scope Context Management

    /// Set scope ID
    pub fn set_partition_key<S: Into<String>>(&mut self, partition_key: S) {
        self.scope.partition_key = Some(partition_key.into());
    }

    /// Get scope ID
    pub fn get_partition_key(&self) -> Option<&String> {
        self.scope.partition_key.as_ref()
    }

    /// Set owner ID
    pub fn set_owner_id<S: Into<String>>(&mut self, owner_id: S) {
        self.scope.owner_id = Some(owner_id.into());
    }

    /// Get owner ID
    pub fn get_owner_id(&self) -> Option<&String> {
        self.scope.owner_id.as_ref()
    }

    /// Get data context
    pub fn get_data(&self) -> &Value {
        &self.data
    }

    /// Get actor ID
    pub fn get_actor_id(&self) -> &str {
        &self.actor_id
    }

    /// Get actor permissions
    pub fn get_actor_permissions(&self) -> &[String] {
        &self.actor_permissions
    }

    /// Get deterministic timestamp
    pub fn get_deterministic_now(&self) -> &DateTime<Utc> {
        &self.deterministic_now
    }

    /// Get user timezone
    pub fn get_user_timezone(&self) -> &str {
        &self.user_timezone
    }

    /// Get locale
    pub fn get_locale(&self) -> &str {
        &self.locale
    }

    /// Get determinism level
    pub fn get_determinism_level(&self) -> &str {
        &self.determinism_level
    }

    /// Get float mode
    pub fn get_float_mode(&self) -> &str {
        &self.float_mode
    }

    /// Get execution seed
    pub fn get_execution_seed(&self) -> u64 {
        self.execution_seed
    }

    /// Set scope metadata
    pub fn set_scope_metadata<S: Into<String>>(&mut self, key: S, value: Value) {
        self.scope.metadata.insert(key.into(), value);
    }

    /// Get scope metadata
    pub fn get_scope_metadata(&self, key: &str) -> Option<&Value> {
        self.scope.metadata.get(key)
    }

    /// Sets the scope profile for the current evaluation.
    /// The profile is expected to be a Value::Object.
    pub fn set_scope_profile(&mut self, profile: Value) {
        self.scope_profile = Some(profile);
    }

    /// Gets a reference to the current scope profile value.
    pub fn get_scope_profile(&self) -> Option<&Value> {
        self.scope_profile.as_ref()
    }

    // ReadSet and Dependency Tracking

    /// Provides safe, read-only access to the current ReadSet via a closure.
    /// This is the architecturally pure way to handle RefCell borrowing.
    pub fn with_readset<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&ReadSet) -> R,
    {
        f(&self.readset.borrow())
    }

    /// Returns a clone (snapshot) of the current ReadSet.
    pub fn get_readset_snapshot(&self) -> ReadSet {
        self.readset.borrow().clone()
    }

    /// Alias for get_readset_snapshot for backwards compatibility
    pub fn get_readset(&self) -> ReadSet {
        self.get_readset_snapshot()
    }

    /// Clear the ReadSet (start fresh tracking)
    pub fn clear_readset(&mut self) {
        *self.readset.borrow_mut() = ReadSet::default();
    }

    /// Track an entity reference access
    pub fn track_entity_reference(&mut self, entity_path: String) {
        self.readset
            .borrow_mut()
            .entity_references
            .insert(entity_path);
    }

    /// Track a special reference access
    pub fn track_special_reference(&mut self, reference: String) {
        self.readset
            .borrow_mut()
            .special_references
            .insert(reference);
    }

    /// Track a function call
    pub fn track_function_call(&mut self, function_name: String) {
        self.readset
            .borrow_mut()
            .function_calls
            .insert(function_name);
    }

    // Security Context Management

    /// Set user ID for security context
    pub fn set_user_id<S: Into<String>>(&mut self, user_id: S) {
        self.security.user_id = Some(user_id.into());
    }

    /// Get user ID
    pub fn get_user_id(&self) -> Option<&String> {
        self.security.user_id.as_ref()
    }

    /// Add a permission/capability
    pub fn add_permission<S: Into<String>>(&mut self, permission: S) {
        self.security.permissions.insert(permission.into());
    }

    /// Check if a permission is available
    pub fn has_permission(&self, permission: &str) -> bool {
        self.security.permissions.contains(permission)
    }

    /// Set maximum traversal depth
    pub fn set_max_traversal_depth(&mut self, depth: usize) {
        self.security.max_traversal_depth = depth;
    }

    /// Get maximum traversal depth
    pub fn get_max_traversal_depth(&self) -> usize {
        self.security.max_traversal_depth
    }

    /// Get all permissions as a sorted vector (for secure cache key generation)
    pub fn get_all_permissions(&self) -> Vec<String> {
        let mut permissions: Vec<_> = self.security.permissions.iter().cloned().collect();
        permissions.sort();
        permissions
    }

    /// Get scope metadata as a sorted vector of key-value pairs (for secure cache key generation)
    pub fn get_scope_metadata_sorted(&self) -> Vec<(String, &Value)> {
        let mut metadata: Vec<_> = self
            .scope
            .metadata
            .iter()
            .map(|(k, v)| (k.clone(), v))
            .collect();
        metadata.sort_by(|a, b| a.0.cmp(&b.0));
        metadata
    }

    /// Clear the injected $scope variable to force a refresh on next evaluation.
    ///
    /// Call this after updating scope context (id, owner, metadata) to ensure
    /// the next evaluation gets the fresh scope data.
    pub fn clear_scope_special(&mut self) {
        self.variables.remove("$scope");
    }

    /// Ensure special references are present in the variables map.
    ///
    /// Currently we **only** auto-inject `$scope` from the runtime
    /// scope context. We do **not** auto-inject `@` or `@@` to avoid
    /// masking missing-current-entity bugs.
    pub fn inject_specials_if_missing(&mut self) {
        // If `$scope` already provided by caller, keep it.
        if self.variables.contains_key("$scope") {
            return;
        }

        // Decide if we have enough data to justify injecting
        let has_id = self.scope.partition_key.is_some();
        let has_owner = self.scope.owner_id.is_some();
        let has_meta = !self.scope.metadata.is_empty();
        let has_profile = self.scope_profile.is_some();

        if !(has_id || has_owner || has_meta || has_profile) {
            // No meaningful scope data → do NOT inject.
            return;
        }

        let mut scope_object = JsonMap::new();

        if let Some(id) = self.scope.partition_key.clone() {
            scope_object.insert("id".to_string(), JsonValue::String(id));
        }
        if let Some(owner) = self.scope.owner_id.clone() {
            scope_object.insert("owner_id".to_string(), JsonValue::String(owner));
        }
        if !self.scope.metadata.is_empty() {
            let mut meta = JsonMap::new();
            for (k, v) in &self.scope.metadata {
                meta.insert(k.clone(), v.0.clone()); // Value -> serde_json::Value
            }
            scope_object.insert("metadata".to_string(), JsonValue::Object(meta));
        }
        if let Some(profile) = &self.scope_profile {
            scope_object.insert("profile".to_string(), profile.0.clone());
        }

        // Inject assembled object
        self.set_variable(
            "$scope",
            crate::types::Value(JsonValue::Object(scope_object)),
        );
    }

    // Data Binding Resolution

    /// Resolve an entity reference using the data binding resolver
    pub fn resolve_entity_data(&mut self, entity_path: &str) -> Option<Value> {
        // Track the entity reference access
        self.readset
            .borrow_mut()
            .entity_references
            .insert(entity_path.to_string());

        // Check if user has permission to access this entity
        let user_id = self.security.user_id.as_deref();
        if !self.data_resolver.can_access_entity(entity_path, user_id) {
            return None;
        }

        // Resolve the entity data
        self.data_resolver.resolve_entity(entity_path)
    }

    /// Resolve scope data binding
    pub fn resolve_scope_binding(&mut self, key: &str) -> Option<Value> {
        // Check scope metadata
        self.scope.metadata.get(key).cloned()
    }

    /// Check if an entity reference is accessible
    pub fn can_access_entity(&self, entity_path: &str) -> bool {
        let user_id = self.security.user_id.as_deref();
        self.data_resolver.can_access_entity(entity_path, user_id)
    }

    /// Set a custom data resolver (for testing or custom integrations)
    pub fn set_data_resolver(&mut self, resolver: Box<dyn DataBindingResolver>) {
        self.data_resolver = resolver;
    }

    // Context Validation and Security Checks

    /// Validate the entire context for security and consistency
    pub fn validate_context(&self) -> Result<(), Vec<ContextValidationError>> {
        let mut errors = Vec::new();

        // Security validation
        if let Err(mut security_errors) = self.validate_security() {
            errors.append(&mut security_errors);
        }

        // Scope validation
        if let Err(mut scope_errors) = self.validate_scope() {
            errors.append(&mut scope_errors);
        }

        // Variable validation
        if let Err(mut variable_errors) = self.validate_variables() {
            errors.append(&mut variable_errors);
        }

        // Dependency validation
        if let Err(mut dependency_errors) = self.validate_dependencies() {
            errors.append(&mut dependency_errors);
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Validate security context and permissions
    pub fn validate_security(&self) -> Result<(), Vec<ContextValidationError>> {
        let mut errors = Vec::new();

        // Check for valid user ID if permissions are set
        if !self.security.permissions.is_empty() && self.security.user_id.is_none() {
            errors.push(ContextValidationError::SecurityViolation {
                message: "Permissions set but no user ID provided".to_string(),
                context: "security_context".to_string(),
            });
        }

        // Validate traversal depth limits
        if self.security.max_traversal_depth == 0 {
            errors.push(ContextValidationError::InvalidConfiguration {
                field: "max_traversal_depth".to_string(),
                message: "Maximum traversal depth cannot be zero".to_string(),
            });
        }

        if self.security.max_traversal_depth > 1000 {
            errors.push(ContextValidationError::SecurityViolation {
                message: "Maximum traversal depth exceeds safety limit (1000)".to_string(),
                context: "security_limits".to_string(),
            });
        }

        // Validate permission format
        for permission in &self.security.permissions {
            if !Self::is_valid_permission_format(permission) {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "permissions".to_string(),
                    message: format!("Invalid permission format: '{}'", permission),
                });
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Validate scope context configuration
    pub fn validate_scope(&self) -> Result<(), Vec<ContextValidationError>> {
        let mut errors = Vec::new();

        // Check scope ID format if present
        if let Some(partition_key) = &self.scope.partition_key {
            if partition_key.trim().is_empty() {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "partition_key".to_string(),
                    message: "Scope ID cannot be empty".to_string(),
                });
            }
            if partition_key.len() > 255 {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "partition_key".to_string(),
                    message: "Scope ID exceeds maximum length (255)".to_string(),
                });
            }
        }

        // Check owner ID format if present
        if let Some(owner_id) = &self.scope.owner_id {
            if owner_id.trim().is_empty() {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "owner_id".to_string(),
                    message: "Owner ID cannot be empty".to_string(),
                });
            }
            if owner_id.len() > 255 {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "owner_id".to_string(),
                    message: "Owner ID exceeds maximum length (255)".to_string(),
                });
            }
        }

        // Validate scope metadata size
        if self.scope.metadata.len() > 100 {
            errors.push(ContextValidationError::ResourceLimit {
                resource: "scope_metadata".to_string(),
                limit: 100,
                current: self.scope.metadata.len(),
            });
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Validate variables and their values
    pub fn validate_variables(&self) -> Result<(), Vec<ContextValidationError>> {
        let mut errors = Vec::new();

        // Check variable count limits
        if self.variables.len() > 1000 {
            errors.push(ContextValidationError::ResourceLimit {
                resource: "variables".to_string(),
                limit: 1000,
                current: self.variables.len(),
            });
        }

        // Validate variable names
        for name in self.variables.keys() {
            if name.trim().is_empty() {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "variable_name".to_string(),
                    message: "Variable name cannot be empty".to_string(),
                });
            }
            if name.len() > 100 {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "variable_name".to_string(),
                    message: format!("Variable name '{}' exceeds maximum length (100)", name),
                });
            }
            if !Self::is_valid_variable_name(name) {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "variable_name".to_string(),
                    message: format!("Invalid variable name format: '{}'", name),
                });
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Validate dependency tracking limits and consistency
    pub fn validate_dependencies(&self) -> Result<(), Vec<ContextValidationError>> {
        let mut errors = Vec::new();

        // Check ReadSet size limits
        let total_deps = self.readset.borrow().total_dependencies();
        if total_deps > 10000 {
            errors.push(ContextValidationError::ResourceLimit {
                resource: "total_dependencies".to_string(),
                limit: 10000,
                current: total_deps,
            });
        }

        // Validate entity reference format
        for entity_ref in self.readset.borrow().get_entity_references() {
            if !Self::is_valid_entity_reference(entity_ref) {
                errors.push(ContextValidationError::InvalidConfiguration {
                    field: "entity_reference".to_string(),
                    message: format!("Invalid entity reference format: '{}'", entity_ref),
                });
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// Check if a permission string has valid format
    fn is_valid_permission_format(permission: &str) -> bool {
        // Permission format: action:resource or simple name
        // Examples: "entity:read", "function:call", "admin"
        if permission.is_empty() || permission.len() > 50 {
            return false;
        }

        // Check for valid characters (alphanumeric, colon, underscore)
        permission
            .chars()
            .all(|c| c.is_alphanumeric() || c == ':' || c == '_')
    }

    /// Check if a variable name has valid format
    pub(crate) fn is_valid_variable_name(name: &str) -> bool {
        // System special: we intentionally allow "$scope" to live in the variables map.
        // NOTE: Do NOT allow "@" or "@@" here — those are syntactic specials handled by the evaluator,
        // not variables. Allowing them here would create ambiguity and break special resolution.
        if name == "$scope" {
            return true;
        }

        if name.is_empty() || name.len() > 100 {
            return false;
        }

        // Must start with letter or underscore, followed by alphanumeric or underscore
        let mut chars = name.chars();
        if let Some(first_char) = chars.next() {
            if !first_char.is_alphabetic() && first_char != '_' {
                return false;
            }
        }

        chars.all(|c| c.is_alphanumeric() || c == '_')
    }

    /// Check if an entity reference has valid format
    fn is_valid_entity_reference(entity_ref: &str) -> bool {
        if entity_ref.is_empty() || entity_ref.len() > 200 {
            return false;
        }

        // Entity reference format: entity.property or entity[index]
        // Allow alphanumeric, underscore, dot, brackets, and quotes
        entity_ref.chars().all(|c| {
            c.is_alphanumeric()
                || c == '_'
                || c == '.'
                || c == '['
                || c == ']'
                || c == '"'
                || c == '\''
                || c == '@'
                || c == '$' // Special references
        })
    }

    /// Perform security check for a specific operation
    pub fn check_operation_permission(
        &self,
        operation: &str,
    ) -> Result<(), ContextValidationError> {
        match operation {
            "entity:read" => {
                if !self.security.can_read_entities() {
                    return Err(ContextValidationError::SecurityViolation {
                        message: "Permission denied: entity read access required".to_string(),
                        context: operation.to_string(),
                    });
                }
            }
            "function:call" => {
                if !self.security.can_call_functions() {
                    return Err(ContextValidationError::SecurityViolation {
                        message: "Permission denied: function call access required".to_string(),
                        context: operation.to_string(),
                    });
                }
            }
            "scope:admin" => {
                if !self.security.is_admin() {
                    return Err(ContextValidationError::SecurityViolation {
                        message: "Permission denied: admin access required".to_string(),
                        context: operation.to_string(),
                    });
                }
            }
            _ => {
                if !self.has_permission(operation) {
                    return Err(ContextValidationError::SecurityViolation {
                        message: format!("Permission denied: '{}' access required", operation),
                        context: operation.to_string(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Check traversal depth limits for safety
    pub fn check_traversal_depth(
        &self,
        current_depth: usize,
    ) -> Result<(), ContextValidationError> {
        if current_depth > self.security.max_traversal_depth {
            return Err(ContextValidationError::ResourceLimit {
                resource: "traversal_depth".to_string(),
                limit: self.security.max_traversal_depth,
                current: current_depth,
            });
        }
        Ok(())
    }

    // Context Manipulation

    /// Clone the context for nested evaluation
    pub fn clone_for_nested(&self) -> Self {
        // Clone everything but start with a fresh ReadSet for the nested evaluation
        let cloned = self.clone();
        *cloned.readset.borrow_mut() = ReadSet::default();
        cloned
    }

    /// Merge ReadSet from a nested context back into this context
    pub fn merge_readset(&mut self, other: &ReadSet) {
        let mut readset = self.readset.borrow_mut();
        readset.variables.extend(other.variables.iter().cloned());
        readset
            .entity_references
            .extend(other.entity_references.iter().cloned());
        readset
            .special_references
            .extend(other.special_references.iter().cloned());
        readset
            .function_calls
            .extend(other.function_calls.iter().cloned());
    }

    /// Create a summary of all dependencies for debugging
    pub fn dependency_summary(&self) -> String {
        let mut summary = Vec::new();

        let readset = self.readset.borrow();
        if !readset.variables.is_empty() {
            summary.push(format!("Variables: {:?}", readset.variables));
        }
        if !readset.entity_references.is_empty() {
            summary.push(format!("Entities: {:?}", readset.entity_references));
        }
        if !readset.special_references.is_empty() {
            summary.push(format!("Special: {:?}", readset.special_references));
        }
        if !readset.function_calls.is_empty() {
            summary.push(format!("Functions: {:?}", readset.function_calls));
        }

        if summary.is_empty() {
            "No dependencies".to_string()
        } else {
            summary.join(", ")
        }
    }

    /// Serialize context for debugging (without sensitive data)
    pub fn debug_info(&self) -> HashMap<String, serde_json::Value> {
        let mut info = HashMap::new();

        // Basic info
        info.insert(
            "variable_count".to_string(),
            serde_json::Value::Number(serde_json::Number::from(self.variables.len())),
        );

        if let Some(partition_key) = &self.scope.partition_key {
            info.insert(
                "partition_key".to_string(),
                serde_json::Value::String(partition_key.clone()),
            );
        }

        if let Some(user_id) = &self.security.user_id {
            info.insert(
                "user_id".to_string(),
                serde_json::Value::String(user_id.clone()),
            );
        }

        info.insert(
            "permission_count".to_string(),
            serde_json::Value::Number(serde_json::Number::from(self.security.permissions.len())),
        );

        info.insert(
            "dependencies".to_string(),
            serde_json::Value::String(self.dependency_summary()),
        );

        info
    }
}

impl Default for EvaluationContext {
    fn default() -> Self {
        Self::new()
    }
}

impl ScopeContext {
    /// Create a new scope context
    pub fn new() -> Self {
        Self {
            partition_key: None,
            owner_id: None,
            metadata: HashMap::new(),
        }
    }
}

impl Default for ScopeContext {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadSet {
    /// Create a new empty ReadSet
    pub fn new() -> Self {
        Self::default()
    }

    /// Get all variables accessed
    pub fn get_variables(&self) -> &HashSet<String> {
        &self.variables
    }

    /// Get all entity references accessed
    pub fn get_entity_references(&self) -> &HashSet<String> {
        &self.entity_references
    }

    /// Get all special references accessed
    pub fn get_special_references(&self) -> &HashSet<String> {
        &self.special_references
    }

    /// Get all function calls made
    pub fn get_function_calls(&self) -> &HashSet<String> {
        &self.function_calls
    }

    /// Check if any dependencies were discovered
    pub fn has_dependencies(&self) -> bool {
        !self.variables.is_empty()
            || !self.entity_references.is_empty()
            || !self.special_references.is_empty()
            || !self.function_calls.is_empty()
    }

    /// Get total dependency count
    pub fn total_dependencies(&self) -> usize {
        self.variables.len()
            + self.entity_references.len()
            + self.special_references.len()
            + self.function_calls.len()
    }
}

impl SecurityContext {
    /// Create a new security context with default settings
    pub fn new() -> Self {
        Self {
            user_id: None,
            permissions: HashSet::new(),
            max_traversal_depth: 50, // Default depth limit
        }
    }

    /// Create a security context with specific user and permissions
    pub fn for_user<S: Into<String>>(user_id: S, permissions: Vec<String>) -> Self {
        let mut context = Self::new();
        context.user_id = Some(user_id.into());
        context.permissions = permissions.into_iter().collect();
        context
    }

    /// Check if this context has admin permissions
    pub fn is_admin(&self) -> bool {
        self.permissions.contains("admin") || self.permissions.contains("scope:admin")
    }

    /// Check if this context can read entities
    pub fn can_read_entities(&self) -> bool {
        self.permissions.contains("entity:read") || self.is_admin()
    }

    /// Check if this context can call functions
    pub fn can_call_functions(&self) -> bool {
        self.permissions.contains("function:call") || self.is_admin()
    }

    /// Returns true if the current principal has the given permission string.
    pub fn has(&self, perm: &str) -> bool {
        self.permissions.contains(perm)
    }
}

// === DEBUG SERIALIZATION SUPPORT ===

#[derive(Debug, Serialize)]
struct ReadSetSnapshot {
    variables: BTreeSet<String>,
    entity_references: BTreeSet<String>,
    special_references: BTreeSet<String>,
    function_calls: BTreeSet<String>,
}

impl From<&ReadSet> for ReadSetSnapshot {
    fn from(rs: &ReadSet) -> Self {
        // convert HashSet -> BTreeSet for stable ordering
        Self {
            variables: rs.variables.iter().cloned().collect(),
            entity_references: rs.entity_references.iter().cloned().collect(),
            special_references: rs.special_references.iter().cloned().collect(),
            function_calls: rs.function_calls.iter().cloned().collect(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ScopeContextSnapshot {
    partition_key: Option<String>,
    owner_id: Option<String>,
    // Use BTreeMap for stable key order in debug output
    metadata: BTreeMap<String, Value>,
}

impl From<&ScopeContext> for ScopeContextSnapshot {
    fn from(w: &ScopeContext) -> Self {
        Self {
            partition_key: w.partition_key.clone(),
            owner_id: w.owner_id.clone(),
            metadata: w
                .metadata
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
struct SecurityContextSnapshot {
    user_id: Option<String>,
    // Stable order
    permissions: BTreeSet<String>,
    max_traversal_depth: usize,
}

impl From<&SecurityContext> for SecurityContextSnapshot {
    fn from(s: &SecurityContext) -> Self {
        Self {
            user_id: s.user_id.clone(),
            permissions: s.permissions.iter().cloned().collect(),
            max_traversal_depth: s.max_traversal_depth,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ContextSnapshot {
    schema_version: &'static str,
    // Stable order
    variables: BTreeMap<String, Value>,
    scope: ScopeContextSnapshot,
    readset: ReadSetSnapshot,
    security: SecurityContextSnapshot,
    scope_profile: Option<Value>,
    data_resolver_type: String,
}

impl From<&EvaluationContext> for ContextSnapshot {
    fn from(ctx: &EvaluationContext) -> Self {
        // Stable variables
        let mut vars = BTreeMap::new();
        for (k, v) in ctx.variables.iter() {
            vars.insert(k.clone(), v.clone());
        }

        // Dynamic type name of the resolver (no Debug string hacks)
        let data_resolver_type = std::any::type_name_of_val(&*ctx.data_resolver).to_string();

        Self {
            schema_version: "v1",
            variables: vars,
            scope: (&ctx.scope).into(),
            readset: (&*ctx.readset.borrow()).into(),
            security: (&ctx.security).into(),
            scope_profile: ctx.scope_profile.clone(),
            data_resolver_type,
        }
    }
}

// ---- Convenience methods on EvaluationContext ----
impl EvaluationContext {
    /// Create a debug JSON snapshot of the current context state.
    ///
    /// This is useful for debugging formula evaluation issues and understanding
    /// the complete state of the evaluation context at any point in time.
    ///
    /// Returns `Result` to expose serialization errors - use `to_debug_json_lossy()`
    /// if you need a guaranteed String output.
    pub fn to_debug_json(&self) -> serde_json::Result<String> {
        let snapshot: ContextSnapshot = self.into();
        serde_json::to_string_pretty(&snapshot)
    }

    /// Create a debug JSON snapshot, returning a fallback string on serialization errors.
    ///
    /// This is a convenience method when you need guaranteed String output and don't
    /// want to handle serialization errors. Prefer `to_debug_json()` in tests and
    /// when you care about serialization failures.
    pub fn to_debug_json_lossy(&self) -> String {
        self.to_debug_json()
            .unwrap_or_else(|_| "<debug-serialize-error>".to_string())
    }

    /// Create a redacted debug JSON snapshot with sensitive variables masked.
    ///
    /// The `redact` function determines which variable names should be redacted.
    /// Redacted variables will show "[REDACTED]" instead of their actual values.
    ///
    /// Returns `Result` to expose serialization errors.
    pub fn to_debug_json_redacted<F>(&self, mut redact: F) -> serde_json::Result<String>
    where
        F: FnMut(&str) -> bool,
    {
        let mut snapshot: ContextSnapshot = self.into();

        // Redact sensitive variables
        for (var_name, value) in snapshot.variables.iter_mut() {
            if redact(var_name) {
                *value = Value::string("[REDACTED]");
            }
        }

        serde_json::to_string_pretty(&snapshot)
    }

    /// Create a redacted debug JSON snapshot, returning a fallback string on errors.
    ///
    /// Convenience method for `to_debug_json_redacted()` when you need guaranteed String output.
    pub fn to_debug_json_redacted_lossy<F>(&self, redact: F) -> String
    where
        F: FnMut(&str) -> bool,
    {
        self.to_debug_json_redacted(redact)
            .unwrap_or_else(|_| "<debug-serialize-error>".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Debug, Clone)]
    struct TestDataResolver {
        entities: HashMap<String, Value>,
        requires_user: bool,
    }

    impl TestDataResolver {
        fn new() -> Self {
            let mut entities = HashMap::new();
            entities.insert("user.name".to_string(), Value::string("John Doe"));
            entities.insert("user.age".to_string(), Value::number(30.0));
            Self {
                entities,
                requires_user: false,
            }
        }

        fn requiring_user() -> Self {
            Self {
                requires_user: true,
                ..Self::new()
            }
        }
    }

    impl DataBindingResolver for TestDataResolver {
        fn resolve_entity(&self, entity_path: &str) -> Option<Value> {
            self.entities.get(entity_path).cloned()
        }

        fn can_access_entity(&self, entity_path: &str, user_id: Option<&str>) -> bool {
            self.entities.contains_key(entity_path) && (!self.requires_user || user_id.is_some())
        }

        fn clone_box(&self) -> Box<dyn DataBindingResolver> {
            Box::new(self.clone())
        }
    }

    #[test]
    fn test_context_creation() {
        let context = EvaluationContext::new();
        assert!(context.get_variable_names().is_empty());
        assert!(context.get_partition_key().is_none());
        context.with_readset(|readset| assert!(!readset.has_dependencies()));
    }

    #[test]
    fn test_variable_management() {
        let mut context = EvaluationContext::new();

        // Set and get variable
        context.set_variable("x", Value::number(42.0));
        assert_eq!(context.get_variable("x"), Some(&Value::number(42.0)));
        assert!(context.has_variable("x"));

        // Variable doesn't exist
        assert_eq!(context.get_variable("y"), None);
        assert!(!context.has_variable("y"));

        // List variable names
        let names = context.get_variable_names();
        assert_eq!(names.len(), 1);
        assert!(names.contains(&"x".to_string()));
    }

    #[test]
    fn test_variable_lookup_tracking() {
        let mut context = EvaluationContext::new();
        context.set_variable("x", Value::number(42.0));

        // Lookup should track in ReadSet
        let value = context.lookup_variable("x");
        assert_eq!(value, Some(Value::number(42.0)));
        context.with_readset(|readset| assert!(readset.get_variables().contains("x")));

        // Lookup non-existent variable
        let missing = context.lookup_variable("missing");
        assert_eq!(missing, None);
        context.with_readset(|readset| assert!(readset.get_variables().contains("missing")));
    }

    #[test]
    fn test_scope_context() {
        let mut context = EvaluationContext::new();

        // Set scope info
        context.set_partition_key("partition_123");
        context.set_owner_id("user_456");
        context.set_scope_metadata("name", Value::string("Test Scope"));

        // Verify scope info
        assert_eq!(
            context.get_partition_key(),
            Some(&"partition_123".to_string())
        );
        assert_eq!(context.get_owner_id(), Some(&"user_456".to_string()));
        assert_eq!(
            context.get_scope_metadata("name"),
            Some(&Value::string("Test Scope"))
        );
    }

    #[test]
    fn test_readset_tracking() {
        let mut context = EvaluationContext::new();

        // Track different types of dependencies
        context.track_entity_reference("user.name".to_string());
        context.track_special_reference("@current_user".to_string());
        context.track_function_call("SUM".to_string());

        context.with_readset(|readset| {
            assert!(readset.get_entity_references().contains("user.name"));
            assert!(readset.get_special_references().contains("@current_user"));
            assert!(readset.get_function_calls().contains("SUM"));
            assert!(readset.has_dependencies());
            assert_eq!(readset.total_dependencies(), 3);
        });
    }

    #[test]
    fn test_security_context() {
        let mut context = EvaluationContext::new();

        // Set security info
        context.set_user_id("user_123");
        context.add_permission("entity:read");
        context.add_permission("function:call");
        context.set_max_traversal_depth(25);

        // Verify security context
        assert_eq!(context.get_user_id(), Some(&"user_123".to_string()));
        assert!(context.has_permission("entity:read"));
        assert!(context.has_permission("function:call"));
        assert!(!context.has_permission("admin"));
        assert_eq!(context.get_max_traversal_depth(), 25);
    }

    #[test]
    fn test_context_cloning() {
        let mut context = EvaluationContext::new();
        context.set_variable("x", Value::number(42.0));
        context.set_partition_key("partition_123");
        context.track_entity_reference("test.entity".to_string());

        // Clone for nested evaluation
        let nested = context.clone_for_nested();
        assert_eq!(nested.get_variable("x"), Some(&Value::number(42.0)));
        assert_eq!(
            nested.get_partition_key(),
            Some(&"partition_123".to_string())
        );
        nested.with_readset(|readset| assert!(!readset.has_dependencies())); // Fresh ReadSet
    }

    #[test]
    fn test_readset_merging() {
        let mut parent_context = EvaluationContext::new();
        let mut child_context = EvaluationContext::new();

        // Add dependencies to child
        child_context.track_entity_reference("child.entity".to_string());
        child_context.track_function_call("CHILD_FUNC".to_string());

        // Merge child dependencies into parent
        let child_readset = child_context.get_readset_snapshot();
        parent_context.merge_readset(&child_readset);

        parent_context.with_readset(|readset| {
            assert!(readset.get_entity_references().contains("child.entity"));
            assert!(readset.get_function_calls().contains("CHILD_FUNC"));
        });
    }

    #[test]
    fn test_dependency_summary() {
        let mut context = EvaluationContext::new();

        // No dependencies
        assert_eq!(context.dependency_summary(), "No dependencies");

        // Add some dependencies
        context.track_entity_reference("user.name".to_string());
        context.track_function_call("SUM".to_string());

        let summary = context.dependency_summary();
        assert!(summary.contains("Entities"));
        assert!(summary.contains("Functions"));
        assert!(summary.contains("user.name"));
        assert!(summary.contains("SUM"));
    }

    #[test]
    fn test_debug_info() {
        let mut context = EvaluationContext::with_scope(
            "partition_123".to_string(),
            Some("user_456".to_string()),
        );
        context.set_variable("x", Value::number(42.0));
        context.set_user_id("user_789");
        context.add_permission("entity:read");
        context.track_function_call("TEST_FUNC".to_string());

        let debug_info = context.debug_info();

        assert!(debug_info.contains_key("variable_count"));
        assert!(debug_info.contains_key("partition_key"));
        assert!(debug_info.contains_key("user_id"));
        assert!(debug_info.contains_key("permission_count"));
        assert!(debug_info.contains_key("dependencies"));

        assert_eq!(
            debug_info["partition_key"],
            serde_json::Value::String("partition_123".to_string())
        );
        assert_eq!(
            debug_info["user_id"],
            serde_json::Value::String("user_789".to_string())
        );
    }

    #[test]
    fn test_security_context_permissions() {
        let security = SecurityContext::for_user(
            "user_123",
            vec![
                "entity:read".to_string(),
                "function:call".to_string(),
                "admin".to_string(),
            ],
        );

        assert!(security.is_admin());
        assert!(security.can_read_entities());
        assert!(security.can_call_functions());

        let limited_security =
            SecurityContext::for_user("user_456", vec!["entity:read".to_string()]);

        assert!(!limited_security.is_admin());
        assert!(limited_security.can_read_entities());
        assert!(!limited_security.can_call_functions());
    }

    #[test]
    fn test_data_binding_resolution() {
        let mut context = EvaluationContext::new();
        context.set_data_resolver(Box::new(TestDataResolver::new()));

        let entity_data = context.resolve_entity_data("user.name");
        assert_eq!(entity_data, Some(Value::string("John Doe")));

        let missing = context.resolve_entity_data("user.profile");
        assert_eq!(missing, None);

        // Verify ReadSet tracking
        context.with_readset(|readset| {
            assert!(readset.get_entity_references().contains("user.name"));
            assert!(readset.get_entity_references().contains("user.profile"));
        });
    }

    #[test]
    fn test_scope_binding_resolution() {
        let mut context = EvaluationContext::new();

        // Set scope metadata
        context.set_scope_metadata("theme", Value::string("dark"));

        // Test scope binding resolution
        let theme = context.resolve_scope_binding("theme");
        assert_eq!(theme, Some(Value::string("dark")));

        // Test non-existent binding
        let missing = context.resolve_scope_binding("missing");
        assert_eq!(missing, None);
    }

    #[test]
    fn test_entity_access_permission() {
        let context = EvaluationContext::new();

        // Default resolver denies all access
        assert!(!context.can_access_entity("user.profile"));
        assert!(!context.can_access_entity("scope.settings"));
    }

    #[test]
    fn test_entity_access_permission_with_resolver_and_user_context() {
        let mut anonymous = EvaluationContext::new();
        anonymous.set_data_resolver(Box::new(TestDataResolver::requiring_user()));
        assert!(!anonymous.can_access_entity("user.name"));
        assert_eq!(anonymous.resolve_entity_data("user.name"), None);

        let mut authenticated = EvaluationContext::new();
        authenticated.set_user_id("user_123");
        authenticated.set_data_resolver(Box::new(TestDataResolver::requiring_user()));
        assert!(authenticated.can_access_entity("user.name"));
        assert_eq!(
            authenticated.resolve_entity_data("user.name"),
            Some(Value::string("John Doe"))
        );
    }

    #[test]
    fn test_context_validation_security() {
        let mut context = EvaluationContext::new();

        // Add permissions without user ID - should fail validation
        context.add_permission("entity:read");

        let validation_result = context.validate_context();
        assert!(validation_result.is_err());

        let errors = validation_result.unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(matches!(
            errors[0],
            ContextValidationError::SecurityViolation { .. }
        ));

        // Add user ID - should pass
        context.set_user_id("user_123");
        let validation_result = context.validate_context();
        assert!(validation_result.is_ok());
    }

    #[test]
    fn test_context_validation_resource_limits() {
        let mut context = EvaluationContext::new();

        // Test max traversal depth limits
        context.set_max_traversal_depth(0);
        let validation_result = context.validate_security();
        assert!(validation_result.is_err());

        context.set_max_traversal_depth(2000); // Exceeds limit
        let validation_result = context.validate_security();
        assert!(validation_result.is_err());

        context.set_max_traversal_depth(100); // Within limits
        let validation_result = context.validate_security();
        assert!(validation_result.is_ok());
    }

    #[test]
    fn test_context_validation_invalid_configuration() {
        let mut context = EvaluationContext::new();

        // Test invalid scope ID
        context.set_partition_key("  "); // Empty after trim
        let validation_result = context.validate_scope();
        assert!(validation_result.is_err());

        // Test invalid variable names
        context.set_variable("", Value::string("test")); // Empty name
        context.set_variable("123invalid", Value::string("test")); // Invalid start
        let validation_result = context.validate_variables();
        assert!(validation_result.is_err());

        let errors = validation_result.unwrap_err();
        assert!(errors.len() >= 2); // At least 2 validation errors
    }

    #[test]
    fn test_permission_format_validation() {
        assert!(EvaluationContext::is_valid_permission_format("entity:read"));
        assert!(EvaluationContext::is_valid_permission_format("admin"));
        assert!(EvaluationContext::is_valid_permission_format(
            "function:call"
        ));

        assert!(!EvaluationContext::is_valid_permission_format(""));
        assert!(!EvaluationContext::is_valid_permission_format(
            "invalid@permission"
        ));
        assert!(!EvaluationContext::is_valid_permission_format(
            &"x".repeat(100)
        )); // Too long
    }

    #[test]
    fn test_variable_name_validation() {
        assert!(EvaluationContext::is_valid_variable_name("valid_var"));
        assert!(EvaluationContext::is_valid_variable_name("_private"));
        assert!(EvaluationContext::is_valid_variable_name("var123"));

        assert!(!EvaluationContext::is_valid_variable_name(""));
        assert!(!EvaluationContext::is_valid_variable_name("123invalid"));
        assert!(!EvaluationContext::is_valid_variable_name("invalid-name"));
        assert!(!EvaluationContext::is_valid_variable_name(&"x".repeat(200))); // Too long
    }

    #[test]
    fn test_entity_reference_validation() {
        assert!(EvaluationContext::is_valid_entity_reference("user.name"));
        assert!(EvaluationContext::is_valid_entity_reference("entity[0]"));
        assert!(EvaluationContext::is_valid_entity_reference(
            "@current_entity"
        ));
        assert!(EvaluationContext::is_valid_entity_reference("$scope"));

        assert!(!EvaluationContext::is_valid_entity_reference(""));
        assert!(!EvaluationContext::is_valid_entity_reference(
            &"x".repeat(300)
        )); // Too long
    }

    #[test]
    fn test_operation_permission_checks() {
        let mut context = EvaluationContext::new();
        context.set_user_id("user_123");

        // Should fail without permissions
        let result = context.check_operation_permission("entity:read");
        assert!(result.is_err());

        // Should succeed with permission
        context.add_permission("entity:read");
        let result = context.check_operation_permission("entity:read");
        assert!(result.is_ok());

        // Admin should have all permissions
        context.add_permission("admin");
        let result = context.check_operation_permission("function:call");
        assert!(result.is_ok());
    }

    #[test]
    fn test_traversal_depth_checks() {
        let mut context = EvaluationContext::new();
        context.set_max_traversal_depth(10);

        // Should pass within limit
        let result = context.check_traversal_depth(5);
        assert!(result.is_ok());

        // Should fail beyond limit
        let result = context.check_traversal_depth(15);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            ContextValidationError::ResourceLimit { .. }
        ));
    }

    #[test]
    fn test_validation_error_display() {
        let error = ContextValidationError::SecurityViolation {
            message: "Test violation".to_string(),
            context: "test_context".to_string(),
        };
        let display = format!("{}", error);
        assert!(display.contains("Security violation"));
        assert!(display.contains("test_context"));
        assert!(display.contains("Test violation"));

        let error = ContextValidationError::ResourceLimit {
            resource: "test_resource".to_string(),
            limit: 100,
            current: 150,
        };
        let display = format!("{}", error);
        assert!(display.contains("Resource limit exceeded"));
        assert!(display.contains("test_resource"));
        assert!(display.contains("150"));
        assert!(display.contains("100"));
    }

    #[test]
    fn test_custom_data_resolver_injection() {
        let mut context = EvaluationContext::new();
        context.set_data_resolver(Box::new(TestDataResolver::new()));

        let name = context.resolve_entity_data("user.name");
        assert_eq!(name, Some(Value::string("John Doe")));

        let missing = context.resolve_entity_data("user.age");
        assert_eq!(missing, Some(Value::number(30.0)));
    }

    // === Context Serialization Tests ===

    #[test]
    fn test_context_snapshot_deterministic_ordering() {
        let mut context = EvaluationContext::new();

        // Add variables in non-alphabetical order
        context.set_variable("zebra", Value::string("last"));
        context.set_variable("apple", Value::string("first"));
        context.set_variable("beta", Value::string("middle"));

        // Add some readset entries
        context.track_entity_reference("entity_c".to_string());
        context.track_entity_reference("entity_a".to_string());
        context.track_entity_reference("entity_b".to_string());

        // Generate snapshot multiple times
        let snapshot1 = context.to_debug_json().unwrap();
        let snapshot2 = context.to_debug_json().unwrap();

        // Should be identical due to deterministic ordering
        assert_eq!(snapshot1, snapshot2);

        // Parse JSON to verify structure
        let parsed: serde_json::Value = serde_json::from_str(&snapshot1).unwrap();

        // Verify variables are in alphabetical order
        let variables = parsed["variables"].as_object().unwrap();
        let keys: Vec<&str> = variables.keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, vec!["apple", "beta", "zebra"]);
    }

    #[test]
    fn test_context_snapshot_complete_structure() {
        let mut context = EvaluationContext::new();

        // Set up context with various data
        context.set_variable("user_input", Value::string("test"));
        context.set_variable("api_key", Value::string("secret123"));
        context.track_entity_reference("user123".to_string());

        // Set explicit security settings for predictable testing
        context.set_max_traversal_depth(100);

        let snapshot_json = context.to_debug_json().unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();

        // Verify all required fields are present
        assert!(snapshot["schema_version"].is_string());
        assert!(snapshot["variables"].is_object());
        assert!(snapshot["scope"].is_object());
        assert!(snapshot["readset"].is_object());
        assert!(snapshot["security"].is_object());
        assert!(snapshot["scope_profile"].is_object() || snapshot["scope_profile"].is_null());
        assert!(snapshot["data_resolver_type"].is_string());

        // Verify specific values
        assert_eq!(snapshot["schema_version"], "v1");
        assert_eq!(snapshot["variables"]["user_input"], "test");
        assert_eq!(snapshot["variables"]["api_key"], "secret123");

        // Verify security context (explicit value we set)
        assert_eq!(snapshot["security"]["max_traversal_depth"], 100);

        // Verify readset structure
        assert!(snapshot["readset"]["entity_references"].is_array());
        assert_eq!(snapshot["readset"]["entity_references"][0], "user123");
    }

    #[test]
    fn test_context_redacted_serialization() {
        let mut context = EvaluationContext::new();

        // Add sensitive variables
        context.set_variable("api_key", Value::string("secret123"));
        context.set_variable("password", Value::string("mypassword"));
        context.set_variable("token", Value::string("bearer_abc"));
        context.set_variable("public_data", Value::string("not_sensitive"));

        let redacted_json = context
            .to_debug_json_redacted(|var_name| {
                var_name.to_lowercase().contains("key")
                    || var_name.to_lowercase().contains("password")
                    || var_name.to_lowercase().contains("token")
            })
            .unwrap();
        let redacted: serde_json::Value = serde_json::from_str(&redacted_json).unwrap();

        // Verify sensitive variables are redacted
        assert_eq!(redacted["variables"]["api_key"], "[REDACTED]");
        assert_eq!(redacted["variables"]["password"], "[REDACTED]");
        assert_eq!(redacted["variables"]["token"], "[REDACTED]");

        // Verify non-sensitive variables are preserved
        assert_eq!(redacted["variables"]["public_data"], "not_sensitive");

        // Verify other fields are not affected
        assert!(redacted["scope"].is_object());
        assert!(redacted["readset"].is_object());
        assert!(redacted["security"].is_object());
    }

    #[test]
    fn test_empty_context_serialization() {
        let context = EvaluationContext::new();

        let snapshot_json = context.to_debug_json().unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();

        // Verify empty collections serialize correctly
        assert_eq!(snapshot["variables"], serde_json::json!({}));
        assert_eq!(
            snapshot["readset"]["entity_references"],
            serde_json::json!([])
        );

        // Other fields should still be present
        assert!(snapshot["scope"].is_object());
        assert!(snapshot["security"].is_object());
    }

    #[test]
    fn test_complex_value_serialization() {
        let mut context = EvaluationContext::new();

        // Add complex values
        context.set_variable("array", Value::from(serde_json::json!([1, 2, 3])));
        context.set_variable(
            "object",
            Value::from(serde_json::json!({
                "nested": {
                    "key": "value"
                },
                "number": 42
            })),
        );
        context.set_variable(
            "entity_ref",
            Value::from(serde_json::json!({"$ent_ref": "user123"})),
        );

        let snapshot_json = context.to_debug_json().unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();

        // Verify complex values serialize correctly
        assert_eq!(snapshot["variables"]["array"], serde_json::json!([1, 2, 3]));
        assert_eq!(snapshot["variables"]["object"]["nested"]["key"], "value");
        assert_eq!(snapshot["variables"]["object"]["number"], 42);
        assert_eq!(snapshot["variables"]["entity_ref"]["$ent_ref"], "user123");
    }

    #[test]
    fn test_security_context_serialization() {
        let mut context = EvaluationContext::new();

        // Set user and permissions
        context.set_user_id("test_user");
        context.add_permission("entity:read");
        context.set_max_traversal_depth(25);

        let snapshot_json = context.to_debug_json().unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();

        // Verify security context fields
        assert_eq!(snapshot["security"]["max_traversal_depth"], 25);
        assert_eq!(snapshot["security"]["user_id"], "test_user");
        assert!(snapshot["security"]["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::Value::String("entity:read".to_string())));
    }

    #[test]
    fn test_json_validity_and_parsing() {
        let mut context = EvaluationContext::new();

        // Add various data to ensure comprehensive serialization
        context.set_variable("test", Value::string("value"));
        context.track_entity_reference("entity1".to_string());

        // Test both regular and redacted serialization
        let regular_json = context.to_debug_json().unwrap();
        let redacted_json = context.to_debug_json_redacted(|_| false).unwrap();

        // Verify JSON is valid and parseable
        let _regular_parsed: serde_json::Value =
            serde_json::from_str(&regular_json).expect("Regular JSON should be valid");
        let _redacted_parsed: serde_json::Value =
            serde_json::from_str(&redacted_json).expect("Redacted JSON should be valid");

        // Verify JSON is properly formatted (contains expected structure)
        assert!(regular_json.contains("variables"));
        assert!(regular_json.contains("scope"));
        assert!(regular_json.contains("readset"));
        assert!(regular_json.contains("security"));
        assert!(regular_json.contains("scope_profile"));
        assert!(regular_json.contains("data_resolver_type"));
    }

    #[test]
    fn test_large_context_serialization_performance() {
        let mut context = EvaluationContext::new();

        // Add many variables to test performance
        for i in 0..100 {
            context.set_variable(format!("var_{:04}", i), Value::number(i as f64));
            context.track_entity_reference(format!("entity_{:04}", i));
        }

        // Should complete without hanging or crashing
        let snapshot_json = context.to_debug_json().unwrap();

        // Verify the JSON is still valid
        let _parsed: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();

        // Verify it contains the expected number of variables
        let parsed: serde_json::Value = serde_json::from_str(&snapshot_json).unwrap();
        assert_eq!(parsed["variables"].as_object().unwrap().len(), 100);
        assert_eq!(
            parsed["readset"]["entity_references"]
                .as_array()
                .unwrap()
                .len(),
            100
        );
    }
}

#[cfg(test)]
pub mod test_support {
    use super::ReadSet;
    use std::collections::HashSet;

    pub fn readset(
        variables: &[&str],
        entities: &[&str],
        specials: &[&str],
        functions: &[&str],
    ) -> ReadSet {
        ReadSet {
            variables: variables
                .iter()
                .map(|s| s.to_string())
                .collect::<HashSet<_>>(),
            entity_references: entities
                .iter()
                .map(|s| s.to_string())
                .collect::<HashSet<_>>(),
            special_references: specials
                .iter()
                .map(|s| s.to_string())
                .collect::<HashSet<_>>(),
            function_calls: functions
                .iter()
                .map(|s| s.to_string())
                .collect::<HashSet<_>>(),
        }
    }
}
