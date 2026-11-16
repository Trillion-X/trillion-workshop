//! crates/composition-ast/src/binding/ast.rs
//!
//! # Canonical, Framework-Agnostic Binding AST for the Universal UI Kernel
//!
//! This module defines the machine types, diagnostics, and error codes that govern
//! how bindings are declared, validated, logged, and executed during the Context-Compute phase.
//!
//! ## Purpose
//!
//! Provide the pure, portable AST types for the binding system. These types are:
//! - **Serializable**: Full serde support for JSON/MessagePack/etc.
//! - **Hashable**: Can be used as cache keys for binding evaluation memoization.
//! - **Deterministic**: Same input always produces same output.
//! - **Platform-Agnostic**: Works on WASM, native, any future platform.
//!
//! ## Non-Negotiable Invariants
//!
//! 1. **Bindings are pure declarative data.** No functions, no closures, no host-specific constructs.
//! 2. **Keys and operator names are normalized and validated.** No dynamic evaluation or "any" escapes.
//! 3. **Diagnostics are structured, machine-readable, and stable.** No stringly-typed errors.
//! 4. **This module is dependency-free, portable, and deterministic.**
//! 5. **SelectSource::Routing is the ONLY way to query routing state.** No Society-polluted ambient.focused_id.
//! 6. **Nested bindings enable DRY patterns.** Resolve once in ambient, use as key via nested binding.
//!
//! ## Key Concepts
//!
//! | Concept | Description |
//! |---------|-------------|
//! | `Binding` | Pure declaration: select input, apply transforms, provide default |
//! | `SelectSource` | Where to read data: self, ambient, dataSource, vars, literal, fsm, **routing** |
//! | `SelectKey` | Static string OR nested binding for runtime-resolved keys |
//! | `TransformStep` | Pure operator invocation with frozen arguments |
//! | `OperatorKey` | Stable identifier: `op:<namespace>.<name>[.<variant>]` |
//! | `Diagnostics` | Structured results for validation, evaluation, and observability |
//!
//! ## Security Considerations
//!
//! - **No dynamic code execution**: Operator set is explicit and closed. No `eval()` or equivalent.
//! - **Path traversal is bounded**: Nested binding keys use full binding evaluation with safeguards.
//! - **No external I/O**: All data comes from the evaluation context provided by the host.
//! - **Type-safe deserialization**: Serde validates structure; invalid JSON fails fast.
//!
//! ## AI Assistant Directive
//!
//! **CRITICAL: The extensive, granular documentation in this codebase is a critical design feature.**
//! **You are FORBIDDEN from simplifying or removing it.**
//! **Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.**
//!
//! Ported from: frontends/web/composition-engine/binding/ast.ts

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

// In composition-ast: scene_index uses serde_json::Value (generic).
// composition-engine extends this with serde_json::Value for O(1) typed lookups.

// ============================================================================
// Primitive Type Aliases
// ============================================================================

/// Stable operator key format: `op:<namespace>(.<subns>)*.<name>(.<variant>)*`
/// Example: "op:core.math.add", "op:text.format.uppercase"
pub type OperatorKey = String;

/// JSON Pointer-like location for precise diagnostics.
/// Empty string = root, otherwise "/path/to/field"
pub type JsonPointer = String;

/// Frozen Path segment: string for object keys, number for arrays.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

impl From<&str> for PathSegment {
    fn from(s: &str) -> Self {
        PathSegment::Key(s.to_string())
    }
}

impl From<String> for PathSegment {
    fn from(s: String) -> Self {
        PathSegment::Key(s)
    }
}

impl From<usize> for PathSegment {
    fn from(i: usize) -> Self {
        PathSegment::Index(i)
    }
}

/// Frozen, canonical path representation used by the kernel.
pub type Path = Vec<PathSegment>;

// ============================================================================
// Enums
// ============================================================================

/// Approved sources for initial selection. Host provides actual data payloads.
///
/// # Sources
///
/// | Source      | Description                                           | Example Path                   |
/// |-------------|-------------------------------------------------------|--------------------------------|
/// | `self`      | The immediate property holder                         | `"name"`                       |
/// | `ambient`   | Host-provided ambient context                         | `"theme"`, `"sys_primary_origin"` |
/// | `dataSource`| Per-node data source payloads                         | key: `"user"`, path: `"name"` |
/// | `vars`      | Kernel variables bag                                  | `"counter"`                    |
/// | `literal`   | Inline value from `value` field                       | N/A (uses `value` field)       |
/// | `fsm`       | FSM state context                                     | `"fsm:editor:mode"`            |
/// | `routing`   | Routing state - Map<OriginID, TargetID>               | key: nested binding            |
///
/// # Routing Source (NEW)
///
/// The `routing` source enables bindings to query the kernel's routing state.
/// This is the Physics-correct way to determine where input origins are routed.
///
/// ## Usage Patterns
///
/// **Static path lookup:**
/// ```json
/// { "from": "routing", "path": "keyboard:0" }
/// ```
///
/// **Dynamic key lookup (nested binding resolves first, result used as key):**
/// ```json
/// { "from": "routing", "key": { "$kind": "binding", "select": { "from": "ambient", "key": "sys_primary_origin" } } }
/// ```
///
/// The dynamic key pattern:
/// 1. Resolves `ambient.sys_primary_origin` to get an OriginID (e.g., `"origin:host:text:0"`)
/// 2. Uses that OriginID as a key to look up `routing.routes[origin_id]`
/// 3. Returns the target node ID or null if no route exists
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SelectSource {
    /// Use the immediate property holder as input
    #[default]
    #[serde(rename = "self", alias = "input")]
    SelfSource,
    /// Read from host-provided ambient context (e.g., session, theme)
    Ambient,
    /// Read from per-node dataSource payloads
    DataSource,
    /// Read from kernel variables bag
    Vars,
    /// Inline value from `value` field
    Literal,
    /// Read from FSM state context (e.g., fsm.editor:mode)
    Fsm,
    /// Read from routing state - Map<OriginID, TargetID>
    ///
    /// Supports both static path lookup and dynamic key lookup via nested bindings.
    /// This is the 1000x Physics-correct way to query "where is origin X routed?"
    Routing,
    /// Read from kernel state (e.g., selected_node, focused_element)
    ///
    /// The kernel maintains ephemeral state that is not persisted but is
    /// available during binding evaluation. This includes:
    /// - selected_node: The currently focused/selected node ID
    /// - Other runtime state as needed
    State,
    /// Read directly from live scene tree by ID(s).
    ///
    /// # Purpose
    ///
    /// The `scene` source enables pull-based access to the scene tree during binding
    /// evaluation. This is the **1000x Physics-correct** way to query node data:
    /// - Scene tree IS the canonical source of truth
    /// - No copying to `state.selected_node` (which creates stale cache)
    /// - Multi-select native: accepts String (one ID) OR Array (multiple IDs)
    ///
    /// # Usage Patterns
    ///
    /// **Single node lookup (String key):**
    /// ```json
    /// { "from": "scene", "key": "node:text-block-1" }
    /// ```
    /// Returns: The full node JSON or null if not found.
    ///
    /// **Multiple node lookup (Array key):**
    /// ```json
    /// { "from": "scene", "key": ["node:a", "node:b", "node:c"] }
    /// ```
    /// Returns: Array of nodes (null for missing IDs).
    ///
    /// **Dynamic key from routing (nested binding):**
    /// ```json
    /// {
    ///   "from": "scene",
    ///   "key": { "$kind": "binding", "select": { "from": "routing", "key": { "$kind": "binding", "select": { "from": "ambient", "path": "session_text_origin" } } } }
    /// }
    /// ```
    /// Returns: The node currently focused by the text origin route.
    ///
    /// **With path traversal:**
    /// ```json
    /// { "from": "scene", "key": "node:text-block-1", "path": "style.padding" }
    /// ```
    /// Returns: The padding value from the node's style.
    ///
    /// # Canonical Single Source of Truth
    ///
    /// Scene tree is THE truth. Bindings query it directly. No copying. No staleness.
    Scene,
    /// Read from action execution context (target_id, input, position, payload)
    ///
    /// The kernel provides execution context during action workflow evaluation:
    /// - `context.target_id` - Node ID being acted upon
    /// - `context.input` - Action input payload from trigger
    /// - `context.input.target_id` - Common nested pattern
    /// - `context.position.{x,y}` - Pointer coordinates
    /// - `context.payload` - Trigger payload (e.g., `{tab: "container"}`)
    ///
    /// This source is ONLY available during action execution.
    /// Projector returns Null (context doesn't exist at projection time).
    ///
    /// # Usage
    /// ```json
    /// { "from": "context", "path": "input.target_id" }
    /// { "from": "context", "path": "position.x" }
    /// { "from": "context", "path": "payload.tab" }
    /// ```
    Context,
}

impl SelectSource {
    /// Returns all valid source string names as they appear in JSON.
    /// This is the CANONICAL source of truth for valid source names.
    /// Validators MUST use this instead of hardcoded lists.
    pub fn all_names() -> &'static [&'static str] {
        // These MUST match the serde rename attributes above
        &[
            "self",
            "ambient",
            "dataSource",
            "vars",
            "literal",
            "fsm",
            "routing",
            "state",
            "scene",
            "context",
        ]
    }

    /// Returns true if this source can ONLY be resolved at kernel runtime.
    ///
    /// # 1000x Pedigree: CANONICAL SINGLE SOURCE OF TRUTH
    ///
    /// This method is THE CANONICAL definition of "runtime-only" sources.
    /// All evaluators (projector, composition-engine, operators) MUST use this
    /// method instead of hardcoding source lists.
    ///
    /// ## Runtime-Only Sources
    ///
    /// | Source    | Why Runtime-Only                                      |
    /// |-----------|-------------------------------------------------------|
    /// | `Fsm`     | FSM state only exists after kernel FSM registration   |
    /// | `Routing` | Routes only exist after input events set them         |
    /// | `State`   | Kernel state only available via set_state() at runtime|
    /// | `Scene`   | Scene index only built during kernel compute phase    |
    /// | `Context` | Action context only exists during execute_action()    |
    ///
    /// ## Static Sources (NOT runtime-only)
    ///
    /// | Source      | Available At                                |
    /// |-------------|---------------------------------------------|
    /// | `SelfSource`| Always (the input value)                    |
    /// | `Ambient`   | Projection time (host-provided context)     |
    /// | `DataSource`| Projection time (entity data)               |
    /// | `Vars`      | Projection time (iteration variables)       |
    /// | `Literal`   | Projection time (inline values)             |
    ///
    /// ## Usage
    ///
    /// ```ignore
    /// // Projector sets preserve_runtime_bindings = true
    /// // Evaluator checks: if ctx.preserve_runtime_bindings && source.is_runtime_only() { return AST }
    /// ```
    ///
    /// ## Non-Negotiable Invariants
    ///
    /// 1. **Single Definition**: This method is THE ONLY place that defines runtime sources.
    /// 2. **All Evaluators Use This**: Projector, composition-engine, operators - all call this.
    /// 3. **Adding New Sources**: If you add a new SelectSource, decide here if it's runtime-only.
    pub fn is_runtime_only(&self) -> bool {
        matches!(
            self,
            SelectSource::Fsm
                | SelectSource::Routing
                | SelectSource::State
                | SelectSource::Scene
                | SelectSource::Context
        )
    }
}

/// Diagnostic severity levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Error,
    Warn,
    Info,
}

/// Canonical error/diagnostic codes emitted by validation and runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiagnosticCode {
    BindingSchemaInvalid,
    BindingUnknownField,
    BindingEmptyPipeline,
    BindingInvalid,
    BindingForbiddenType,
    BindingSelectInvalid,
    BindingTransformInvalid,
    BindingOperatorNotFound,
    BindingOperatorError,
    SelectSourceInvalid,
    SelectKeyRequired,
    PathInvalid,
    PathMissing,
    PathAccessDenied,
    OpKeyInvalid,
    OpNotFound,
    OpArgsInvalid,
    EvalTypeMismatch,
    EvalUnsafeValue,
}

// ============================================================================
// Diagnostics and Error Shapes
// ============================================================================

/// Structured diagnostic payload for validation and evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub level: DiagnosticLevel,
    pub message: String,
    /// Location within the Binding object or blueprint, JSON Pointer.
    pub at: JsonPointer,
    /// Optional machine data to aid automated remediation or tooling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

impl Diagnostic {
    /// Create a new error diagnostic
    pub fn error(code: DiagnosticCode, message: impl Into<String>, at: impl Into<String>) -> Self {
        Self {
            code,
            level: DiagnosticLevel::Error,
            message: message.into(),
            at: at.into(),
            data: None,
        }
    }

    /// Create a new warning diagnostic
    pub fn warn(code: DiagnosticCode, message: impl Into<String>, at: impl Into<String>) -> Self {
        Self {
            code,
            level: DiagnosticLevel::Warn,
            message: message.into(),
            at: at.into(),
            data: None,
        }
    }

    /// Create a new info diagnostic
    pub fn info(code: DiagnosticCode, message: impl Into<String>, at: impl Into<String>) -> Self {
        Self {
            code,
            level: DiagnosticLevel::Info,
            message: message.into(),
            at: at.into(),
            data: None,
        }
    }

    /// Add data to the diagnostic
    pub fn with_data(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        let data = self.data.get_or_insert_with(HashMap::new);
        data.insert(key.into(), value);
        self
    }
}

/// Machine-readable error object for thrown exceptions at module boundaries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BindingErrorPayload {
    pub code: DiagnosticCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, serde_json::Value>>,
}

// ============================================================================
// AST: Select and Bindings
// ============================================================================

/// Kind discriminator for Binding objects.
pub const BINDING_KIND: &str = "binding";

/// BindingSelect: declares the origin and path to read the initial input value.
///
/// - from:
///    - "self": use the immediate property holder as input
///    - "ambient": read from host-provided ambient context (e.g., session, theme)
///    - "vars": read from kernel variables bag
///    - "literal": inline value from `value` field
///    - "dataSource": read from per-node dataSource payloads
/// - key: optional selector key for dataSource lookups
/// - path: optional path into the source payload
/// - value: inline value when from="literal"
/// - required: if true and value is absent, validator may raise hard error
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingSelect {
    /// Source of the selection (now includes 'dataSource' and 'routing').
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<SelectSource>,
    /// Optional selector key for dataSource and routing lookups.
    ///
    /// For `dataSource`: a static string key like `"user"`
    /// For `routing`: can be static `"keyboard:0"` or a nested binding that resolves to the key
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<SelectKey>,
    /// Path within the chosen source payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathInput>,
    /// Inline literal when from="literal".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// If true and the selected value is absent, validator may raise a hard error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

impl<'de> Deserialize<'de> for BindingSelect {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut obj = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;

        fn take_optional<T, E>(
            obj: &mut serde_json::Map<String, serde_json::Value>,
            field: &str,
        ) -> Result<Option<T>, E>
        where
            T: serde::de::DeserializeOwned,
            E: serde::de::Error,
        {
            match obj.remove(field) {
                Some(value) if value.is_null() => Ok(None),
                Some(value) => serde_json::from_value(value).map(Some).map_err(E::custom),
                None => Ok(None),
            }
        }

        Ok(Self {
            from: take_optional(&mut obj, "from")?,
            key: take_optional(&mut obj, "key")?,
            path: take_optional(&mut obj, "path")?,
            // `Option<Value>` normally collapses JSON null into None. That is
            // wrong for literal bindings: `{ "from": "literal", "value": null }`
            // is an explicit seed value and must round-trip as present null.
            value: obj.remove("value"),
            required: take_optional(&mut obj, "required")?,
        })
    }
}

/// A key for select lookups - can be either a static string or a nested binding.
///
/// # Purpose
///
/// SelectKey is the **1000x union type** that enables both compile-time known keys
/// and runtime-resolved keys through a single, elegant interface. Serde's `untagged`
/// deserializer handles both transparently.
///
/// # Non-Negotiable Invariants
///
/// 1. **Untagged union**: JSON `"string"` → Static, JSON `{"$kind": "binding", ...}` → Dynamic.
/// 2. **Static keys are passed through as-is** - No resolution needed.
/// 3. **Dynamic keys require recursive evaluation** - The nested binding is evaluated first.
/// 4. **ONE syntax for dynamic resolution** - Canonical binding format, no `$ref` shorthand.
///
/// # Static Key
///
/// Used for simple lookups where the key is known at compile time:
/// ```json
/// { "from": "routing", "key": "keyboard:0" }
/// ```
///
/// # Dynamic Key
///
/// Used when the key must be resolved from context at runtime:
/// ```json
/// { "from": "routing", "key": { "$kind": "binding", "select": { "from": "ambient", "path": "sys_primary_origin" } } }
/// ```
///
/// # Why This Design (1000x Reasoning)
///
/// 1. **ONE SYNTAX**: Canonical binding format everywhere, no `$ref` shorthand.
/// 2. **Composable**: Nested bindings can have transforms, defaults, etc.
/// 3. **Type Safety**: Enum variants prevent mixing static/dynamic at compile time.
/// 4. **Seamless JSON**: `#[serde(untagged)]` means clean JSON without type discriminators.
///
/// # Security Considerations
///
/// - **Static keys**: No security concerns - literal strings.
/// - **Dynamic keys**: Full binding evaluation with all its safeguards.
///
/// # Helper Methods
///
/// - `SelectKey::static_key("x")` - Create static key
/// - `SelectKey::dynamic_binding(binding)` - Create dynamic key from binding
/// - `.is_static()` / `.is_dynamic()` - Type checks
/// - `.as_static()` / `.as_dynamic()` - Safe accessors
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SelectKey {
    /// A static string key (e.g., "keyboard:0", "user")
    Static(String),
    /// A nested binding that resolves to the key value at runtime
    Dynamic(Box<Binding>),
}

impl SelectKey {
    /// Create a static key
    pub fn static_key(key: impl Into<String>) -> Self {
        SelectKey::Static(key.into())
    }

    /// Create a dynamic key from a binding
    pub fn dynamic_binding(binding: Binding) -> Self {
        SelectKey::Dynamic(Box::new(binding))
    }

    /// Create a dynamic key that reads from ambient with the given path.
    /// This is a convenience method for the common pattern of reading a key from ambient.
    pub fn from_ambient(path: impl Into<String>) -> Self {
        SelectKey::Dynamic(Box::new(Binding::new().with_select(BindingSelect {
            from: Some(SelectSource::Ambient),
            path: Some(PathInput::String(path.into())),
            ..Default::default()
        })))
    }

    /// Check if this is a static key
    pub fn is_static(&self) -> bool {
        matches!(self, SelectKey::Static(_))
    }

    /// Check if this is a dynamic key
    pub fn is_dynamic(&self) -> bool {
        matches!(self, SelectKey::Dynamic(_))
    }

    /// Get the static key value if this is a static key
    pub fn as_static(&self) -> Option<&str> {
        match self {
            SelectKey::Static(s) => Some(s),
            SelectKey::Dynamic(_) => None,
        }
    }

    /// Get the dynamic binding if this is a dynamic key
    pub fn as_dynamic(&self) -> Option<&Binding> {
        match self {
            SelectKey::Static(_) => None,
            SelectKey::Dynamic(b) => Some(b),
        }
    }
}

impl std::fmt::Display for SelectKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SelectKey::Static(s) => write!(f, "{}", s),
            SelectKey::Dynamic(binding) => {
                // Serialize the nested binding to show the dynamic key source
                write!(
                    f,
                    "binding:{}",
                    serde_json::to_string(binding.as_ref()).unwrap_or_default()
                )
            }
        }
    }
}

/// Path input can be either a string (dotted notation) or an array of segments
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathInput {
    String(String),
    Array(Path),
}

impl PathInput {
    /// Convert to a Path array
    pub fn to_path(&self) -> Result<Path, String> {
        match self {
            PathInput::Array(p) => Ok(p.clone()),
            PathInput::String(s) => crate::binding::path::parse_path(s),
        }
    }
}

/// Select: declares the origin and path to read the initial input value.
///
/// - source:
///    - "self": use the immediate property holder as input
///    - "ambient": read from host-provided ambient context (e.g., session, theme)
///    - "dataSource": read from named data source payload resolved by the host
/// - key: required when source = "dataSource" (e.g., "userProfile", "orders")
/// - path: optional path into the source payload; if omitted, the entire payload is used
/// - required: if true, missing path yields an error; otherwise it yields `None`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Select {
    pub source: SelectSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

/// TransformStep: a single, pure operator invocation.
///
/// - op: a stable OperatorKey validated by regex
/// - args: frozen argument bag; operator-specific validation occurs at runtime
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransformStep {
    pub op: OperatorKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<HashMap<String, serde_json::Value>>,
}

impl TransformStep {
    /// Create a new transform step
    pub fn new(op: impl Into<String>) -> Self {
        Self {
            op: op.into(),
            args: None,
        }
    }

    /// Add arguments to the transform step
    pub fn with_args(mut self, args: HashMap<String, serde_json::Value>) -> Self {
        self.args = Some(args);
        self
    }

    /// Add a single argument
    pub fn with_arg(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        let args = self.args.get_or_insert_with(HashMap::new);
        args.insert(key.into(), value);
        self
    }
}

/// Binding metadata for tooling and observability
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct BindingMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Binding: a declarative pipeline that selects an input then applies transforms.
///
/// - $kind = "binding": stable discriminator for fast guards
/// - select: optional; if omitted, defaults to { from: "self" }
/// - transform: optional; if omitted, the pipeline is identity
/// - default: fallback value when result is undefined or path missing
/// - meta: optional metadata for tooling; not used by the evaluator
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    #[serde(rename = "$kind")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<BindingSelect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<Vec<TransformStep>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<BindingMeta>,
}

impl Default for Binding {
    fn default() -> Self {
        Self {
            kind: BINDING_KIND.to_string(),
            select: None,
            transform: None,
            default: None,
            meta: None,
        }
    }
}

impl Binding {
    /// Create a new binding
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the select configuration
    pub fn with_select(mut self, select: BindingSelect) -> Self {
        self.select = Some(select);
        self
    }

    /// Set the transform pipeline
    pub fn with_transform(mut self, transform: Vec<TransformStep>) -> Self {
        self.transform = Some(transform);
        self
    }

    /// Add a transform step to the pipeline
    pub fn add_transform(mut self, step: TransformStep) -> Self {
        let transform = self.transform.get_or_insert_with(Vec::new);
        transform.push(step);
        self
    }

    /// Set the default value
    pub fn with_default(mut self, default: serde_json::Value) -> Self {
        self.default = Some(default);
        self
    }

    /// Set metadata
    pub fn with_meta(mut self, meta: BindingMeta) -> Self {
        self.meta = Some(meta);
        self
    }
}

// ============================================================================
// Evaluation Context and Result Shape
// ============================================================================

/// EvaluationContext: pure data envelope provided by the Host.
/// No I/O, no methods. Evaluator reads from here only.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingEvaluationContext {
    /// Data visible as "ambient" source.
    pub ambient: HashMap<String, serde_json::Value>,
    /// Data sources visible under "dataSource" source keyed by "select.key".
    pub data_sources: HashMap<String, serde_json::Value>,
    /// Kernel variables bag visible under "vars" source.
    pub vars: HashMap<String, serde_json::Value>,
    /// FSM state context visible under "fsm" source.
    pub fsm: HashMap<String, serde_json::Value>,
    /// Routing state visible under "routing" source.
    ///
    /// Maps origin ID strings to target node ID strings.
    /// Example: `{ "keyboard:0": "text-input-1", "pointer:1": "button-a" }`
    ///
    /// This is the Physics-correct way to query routing state.
    /// Bindings can use static paths or dynamic keys to look up routes.
    pub routing: HashMap<String, String>,
    /// Kernel state visible under "state" source.
    ///
    /// Ephemeral kernel state that is available during binding evaluation.
    /// Example: `{ "selected_node": "node:text-block-1", "focused_element": "input:name" }`
    ///
    /// This state is not persisted but is maintained by the kernel during runtime.
    pub state: HashMap<String, serde_json::Value>,
    /// Scene tree index visible under "scene" source.
    ///
    /// # Purpose
    ///
    /// O(1) lookup of scene nodes by ID. Built by `compute.rs` before binding evaluation,
    /// then injected here for bindings to query. This is the **canonical pull-based**
    /// architecture - scene tree IS the truth, bindings read directly from it.
    ///
    /// # Why Option<Arc<...>>
    ///
    /// - `Option`: Scene index may not be available (e.g., bindings evaluated outside compute)
    /// - `Arc`: Built once in compute, shared across all binding evaluations (cheap cloning)
    ///
    /// # Contents
    ///
    /// Maps node ID strings to typed node entries. Entries are converted to JSON
    /// on-demand during SelectSource::Scene binding lookups — O(1) per lookup
    /// instead of O(n) upfront conversion. Task 202.
    #[serde(skip)]
    pub scene_index: Option<Arc<HashMap<String, serde_json::Value>>>,
    /// Action execution context visible under "context" source.
    ///
    /// # Purpose
    ///
    /// Provides access to action execution data during workflow step evaluation.
    /// This is populated by the kernel during `execute_action()`.
    ///
    /// # Contents
    ///
    /// - `target_id` - Node ID being acted upon
    /// - `input` - Action input payload from trigger
    /// - `position` - Pointer coordinates {x, y}
    /// - `payload` - Trigger payload
    ///
    /// # Example
    /// ```json
    /// {
    ///   "target_id": "node:text-block-1",
    ///   "input": {"target_id": "node:text-block-1"},
    ///   "position": {"x": 100.0, "y": 200.0},
    ///   "payload": {"tab": "container"}
    /// }
    /// ```
    #[serde(default)]
    pub context: serde_json::Value,
    /// Optional self value used when source = "self" or when select omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub self_value: Option<serde_json::Value>,
    /// Optional time for deterministic operators (epoch ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now: Option<i64>,
    /// Optional locale for deterministic formatting in pure ops.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Optional kernel version for conformance-sensitive ops.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_version: Option<String>,
    /// If true, bindings with runtime-only sources are returned as AST instead of evaluated.
    ///
    /// # 1000x Pedigree: TWO-PHASE BINDING EVALUATION
    ///
    /// This flag enables the canonical two-phase binding pattern:
    ///
    /// ## Phase 1: Projection Time (preserve_runtime_bindings = true)
    ///
    /// The projector evaluates bindings at entity load time. Runtime sources
    /// (FSM, Routing, State, Scene, Context) are NOT available yet, so bindings
    /// that select from these sources are preserved as AST for later evaluation.
    ///
    /// ## Phase 2: Kernel Tick (preserve_runtime_bindings = false)
    ///
    /// The kernel evaluates preserved bindings during compute. Runtime sources
    /// are now available (scene_index built, FSMs registered, routes set), so
    /// bindings can be fully resolved.
    ///
    /// ## Usage
    ///
    /// ```ignore
    /// // Projector creates context with flag = true
    /// let ctx = BindingEvaluationContext::new().with_preserve_runtime_bindings(true);
    ///
    /// // Evaluator checks before evaluating:
    /// if ctx.preserve_runtime_bindings && binding.select.from.is_runtime_only() {
    ///     return serde_json::to_value(binding); // Return AST, don't evaluate
    /// }
    /// ```
    ///
    /// ## Non-Negotiable Invariants
    ///
    /// 1. **Default is false**: Kernel evaluation resolves everything.
    /// 2. **Projector sets true**: Load-time evaluation preserves runtime bindings.
    /// 3. **Propagates through operators**: map_to_nodes etc. inherit this flag.
    #[serde(default)]
    pub preserve_runtime_bindings: bool,
}

impl BindingEvaluationContext {
    /// Create a new empty context
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the self value
    pub fn with_self(mut self, value: serde_json::Value) -> Self {
        self.self_value = Some(value);
        self
    }

    /// Add ambient data
    pub fn with_ambient(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.ambient.insert(key.into(), value);
        self
    }

    /// Add data source
    pub fn with_data_source(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.data_sources.insert(key.into(), value);
        self
    }

    /// Add variable
    pub fn with_var(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.vars.insert(key.into(), value);
        self
    }

    /// Set the current timestamp
    pub fn with_now(mut self, now: i64) -> Self {
        self.now = Some(now);
        self
    }

    /// Set the locale
    pub fn with_locale(mut self, locale: impl Into<String>) -> Self {
        self.locale = Some(locale.into());
        self
    }

    /// Add a routing entry (origin_id -> target_id)
    ///
    /// # Arguments
    /// * `origin_id` - The origin ID string (e.g., "keyboard:0", "pointer:1")
    /// * `target_id` - The target node ID string
    ///
    /// # Example
    /// ```ignore
    /// let ctx = BindingEvaluationContext::new()
    ///     .with_route("keyboard:0", "text-input-1")
    ///     .with_route("pointer:1", "button-a");
    /// ```
    pub fn with_route(
        mut self,
        origin_id: impl Into<String>,
        target_id: impl Into<String>,
    ) -> Self {
        self.routing.insert(origin_id.into(), target_id.into());
        self
    }

    /// Set all routes from a HashMap
    ///
    /// # Arguments
    /// * `routes` - A HashMap of origin_id -> target_id mappings
    pub fn with_routes(mut self, routes: HashMap<String, String>) -> Self {
        self.routing = routes;
        self
    }

    /// Add kernel state entry
    ///
    /// # Arguments
    /// * `key` - The state key (e.g., "selected_node", "focused_element")
    /// * `value` - The state value
    ///
    /// # Example
    /// ```ignore
    /// let ctx = BindingEvaluationContext::new()
    ///     .with_state("selected_node", serde_json::json!("node:text-block-1"));
    /// ```
    pub fn with_state(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.state.insert(key.into(), value);
        self
    }

    /// Set the scene index for pull-based node lookups.
    ///
    /// # Purpose
    ///
    /// Enables `SelectSource::Scene` bindings to query nodes directly from the
    /// live scene tree. This is the **canonical single source of truth** pattern:
    /// scene tree IS the truth, bindings read from it, no copying.
    ///
    /// # Task 202: Lazy Conversion Architecture
    ///
    /// The scene index stores `serde_json::Value` values (typed Rust structs) instead
    /// of `serde_json::Value`. Entries are converted to JSON on-demand during
    /// `SelectSource::Scene` binding lookups via `entry.to_json_value()`.
    /// This eliminates the O(n) `typed_to_json_scene_index()` upfront conversion
    /// that ran on EVERY compute pass. Now only looked-up entries pay the
    /// serialization cost — O(lookup_count) instead of O(scene_size).
    ///
    /// # Arguments
    /// * `index` - HashMap of node ID → serde_json::Value, wrapped in Arc for cheap sharing
    pub fn with_scene_index(mut self, index: Arc<HashMap<String, serde_json::Value>>) -> Self {
        self.scene_index = Some(index);
        self
    }

    /// Set the action execution context.
    ///
    /// # Purpose
    ///
    /// Enables `SelectSource::Context` bindings to access action execution data
    /// during workflow step evaluation.
    ///
    /// # Arguments
    /// * `context` - JSON object containing target_id, input, position, payload
    ///
    /// # Example
    /// ```ignore
    /// let ctx = BindingEvaluationContext::new()
    ///     .with_context(serde_json::json!({
    ///         "target_id": "node:text-block-1",
    ///         "input": {"target_id": "node:text-block-1"},
    ///         "position": {"x": 100.0, "y": 200.0},
    ///         "payload": {"tab": "container"}
    ///     }));
    /// ```
    pub fn with_context(mut self, context: serde_json::Value) -> Self {
        self.context = context;
        self
    }

    /// Set the preserve_runtime_bindings flag.
    ///
    /// # Purpose
    ///
    /// When true, bindings that select from runtime-only sources (FSM, Routing,
    /// State, Scene, Context) are returned as AST instead of being evaluated.
    /// This enables two-phase evaluation where the projector preserves bindings
    /// for the kernel to evaluate later when runtime state is available.
    ///
    /// # Arguments
    /// * `preserve` - Whether to preserve runtime bindings as AST
    ///
    /// # Example
    /// ```ignore
    /// // Projector context - preserves runtime bindings
    /// let ctx = BindingEvaluationContext::new()
    ///     .with_preserve_runtime_bindings(true);
    ///
    /// // Kernel context - evaluates everything
    /// let ctx = BindingEvaluationContext::new()
    ///     .with_preserve_runtime_bindings(false); // default
    /// ```
    pub fn with_preserve_runtime_bindings(mut self, preserve: bool) -> Self {
        self.preserve_runtime_bindings = preserve;
        self
    }
}

/// Result envelope for binding evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingResult {
    pub value: serde_json::Value,
    pub diagnostics: Vec<Diagnostic>,
    /// List of fully-qualified access paths (e.g., "dataSource.user.orders[3].total").
    pub accessed_paths: Vec<String>,
    /// True when result is safe to cache for the tick.
    pub cacheable: bool,
}

impl Default for BindingResult {
    fn default() -> Self {
        Self {
            value: serde_json::Value::Null,
            diagnostics: Vec::new(),
            accessed_paths: Vec::new(),
            cacheable: true,
        }
    }
}

impl BindingResult {
    /// Create a new result with a value
    pub fn ok(value: serde_json::Value) -> Self {
        Self {
            value,
            ..Default::default()
        }
    }

    /// Create a result with an error
    pub fn err(diagnostic: Diagnostic) -> Self {
        Self {
            value: serde_json::Value::Null,
            diagnostics: vec![diagnostic],
            accessed_paths: Vec::new(),
            cacheable: false,
        }
    }

    /// Add a diagnostic to the result
    pub fn with_diagnostic(mut self, diagnostic: Diagnostic) -> Self {
        self.diagnostics.push(diagnostic);
        self
    }

    /// Add an accessed path
    pub fn with_accessed_path(mut self, path: impl Into<String>) -> Self {
        self.accessed_paths.push(path.into());
        self
    }

    /// Set cacheability
    pub fn with_cacheable(mut self, cacheable: bool) -> Self {
        self.cacheable = cacheable;
        self
    }
}

// ============================================================================
// Runtime-safe Type Guards and Validation
// ============================================================================

/// Minimal structural check to identify a Binding-like object safely.
pub fn is_binding(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(obj) => obj
            .get("$kind")
            .and_then(|v| v.as_str())
            .map(|s| s == BINDING_KIND)
            .unwrap_or(false),
        _ => false,
    }
}

/// Regex pattern enforcing OperatorKey policy (lowercase, digits, dot/colon/underscore/hyphen).
pub const OPERATOR_KEY_PATTERN: &str = r"^op:[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$";

/// Fast validation for operator keys; returns a Diagnostic on failure instead of panicking.
pub fn validate_operator_key(key: &str, at: &str) -> Option<Diagnostic> {
    use regex::Regex;

    lazy_static::lazy_static! {
        static ref OPERATOR_KEY_REGEX: Regex = Regex::new(OPERATOR_KEY_PATTERN).unwrap();
    }

    if !OPERATOR_KEY_REGEX.is_match(key) {
        return Some(
            Diagnostic::error(
                DiagnosticCode::OpKeyInvalid,
                format!(
                    "Invalid operator key: \"{}\". Expected format: op:<namespace>.<name>",
                    key
                ),
                at,
            )
            .with_data("key", serde_json::json!(key)),
        );
    }
    None
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_binding_creation() {
        let binding = Binding::new()
            .with_select(BindingSelect {
                from: Some(SelectSource::DataSource),
                key: Some(SelectKey::static_key("user")),
                path: Some(PathInput::String("profile.name".to_string())),
                ..Default::default()
            })
            .with_transform(vec![TransformStep::new("op:text.uppercase")])
            .with_default(serde_json::json!("Unknown"));

        assert_eq!(binding.kind, "binding");
        assert!(binding.select.is_some());
        assert!(binding.transform.is_some());
        assert_eq!(binding.transform.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn test_is_binding() {
        let binding_json = serde_json::json!({
            "$kind": "binding",
            "select": { "from": "self" }
        });
        assert!(is_binding(&binding_json));

        let not_binding = serde_json::json!({
            "kind": "something_else"
        });
        assert!(!is_binding(&not_binding));

        let not_object = serde_json::json!("string");
        assert!(!is_binding(&not_object));
    }

    #[test]
    fn test_validate_operator_key() {
        // Valid keys
        assert!(validate_operator_key("op:core.math.add", "").is_none());
        assert!(validate_operator_key("op:text.format", "").is_none());
        assert!(validate_operator_key("op:a1", "").is_none());

        // Invalid keys
        assert!(validate_operator_key("core.math.add", "").is_some()); // Missing "op:"
        assert!(validate_operator_key("op:", "").is_some()); // Empty namespace
        assert!(validate_operator_key("op:UPPERCASE", "").is_some()); // Uppercase
    }

    #[test]
    fn test_diagnostic_builder() {
        let diag = Diagnostic::error(
            DiagnosticCode::PathMissing,
            "Key 'name' not found",
            "/select/path",
        )
        .with_data("key", serde_json::json!("name"))
        .with_data("path", serde_json::json!(["user", "profile"]));

        assert_eq!(diag.code, DiagnosticCode::PathMissing);
        assert_eq!(diag.level, DiagnosticLevel::Error);
        assert!(diag.data.is_some());
        assert_eq!(diag.data.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn test_transform_step_builder() {
        let step = TransformStep::new("op:math.add")
            .with_arg("value", serde_json::json!(10))
            .with_arg("precision", serde_json::json!(2));

        assert_eq!(step.op, "op:math.add");
        assert!(step.args.is_some());
        assert_eq!(step.args.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn test_binding_result() {
        let result = BindingResult::ok(serde_json::json!("Hello"))
            .with_accessed_path("dataSource.user.name")
            .with_cacheable(true);

        assert_eq!(result.value, serde_json::json!("Hello"));
        assert_eq!(result.accessed_paths.len(), 1);
        assert!(result.cacheable);
    }

    #[test]
    fn test_select_source_serialization() {
        let select = BindingSelect {
            from: Some(SelectSource::DataSource),
            key: Some(SelectKey::static_key("user")),
            ..Default::default()
        };

        let json = serde_json::to_string(&select).unwrap();
        assert!(json.contains("dataSource"));
    }

    #[test]
    fn test_literal_null_select_value_round_trips_as_present_value() {
        let binding: Binding = serde_json::from_value(serde_json::json!({
            "$kind": "binding",
            "select": { "from": "literal", "value": null }
        }))
        .unwrap();

        let select = binding.select.as_ref().unwrap();
        assert_eq!(select.value, Some(serde_json::Value::Null));

        let round_tripped = serde_json::to_value(&binding).unwrap();
        let select_object = round_tripped
            .get("select")
            .and_then(|value| value.as_object())
            .unwrap();
        assert!(select_object.contains_key("value"));
        assert!(select_object.get("value").unwrap().is_null());
    }

    #[test]
    fn test_path_segment() {
        let key: PathSegment = "name".into();
        let index: PathSegment = 0usize.into();

        assert_eq!(key, PathSegment::Key("name".to_string()));
        assert_eq!(index, PathSegment::Index(0));
    }
}
