// crates/workflow-core/src/domain/types.rs
//
// Purpose:
//   Canonical domain types for the workflow engine. These Rust structs are the
//   single source of truth for workflow concepts in code (Physics layer).
//   All application behavior (Society layer) lives as source-owned
//   configuration data delivered through workflow boundaries.
//
// Non-Negotiable Invariants:
//   1. Definition uses the open steps array model emitted by source owners.
//   2. Step kinds are plain strings, NOT enums — validation is separate
//      from parsing. Unknown kinds parse successfully; the executor validates.
//   3. Outside-work target names are opaque strings — the engine does NOT
//      enumerate what target names exist. Validation is the executor's job,
//      not the type system's.
//   4. No Society concepts in these types — they are pure Physics structures.
//   5. WaitCondition is the canonical temporal primitive. Everything temporal
//      (cron, timeout, deadline, retry, polling) is derived from its 3 variants.
//      The legacy `duration_secs` input field is supported for backward compatibility
//      via parse_wait_condition() in automation.rs.
//
// Key Concepts:
//   - Definition: A source-owned record with steps that compose registered
//     handlers and external work requests.
//   - Step: A single step within an action — primitive name + params
//   - Step: A step within a Definition (different concept, kept separate)
//   - Definition: A reusable automation template with ordered steps
//
// Canonical Model (Task 077 — Definition Schema Reconciliation):
//
//   The canonical model for Definition is the `workflow_steps` ARRAY.
//   Source owners assemble their own persisted representation into this JSON
//   shape before handing it to workflow. Workflow never reads the source
//   owner's storage internals.
//
//   Each element in the `workflow_steps` array is an Step with:
//     - `primitive`: String naming a Kernel Codex primitive (e.g., "_transact",
//       "_setState", "_databaseRead", "_callExternal", "_emitEvent", "_navigate")
//     - `params`: JSON object passed to the primitive. May contain binding
//       expressions (e.g., "{{input.target_id}}") resolved at execution time.
//
//   Multi-step actions are fully supported. Steps execute in array order.
//   Example: a "start editing" action might _setState to mark editing=true,
//   then _transact to record the edit session in the database.
//
//   The `operation` field INSIDE params is used for Kernel Codex routing.
//   When primitive is "_transact", the `operation` field (e.g., "set_focus",
//   "toggle_edit_mode", "delete_entity") tells the Kernel Codex which
//   specific transact operation to execute. This is DATA, not code — users
//   can define their own operations via data recipes.
//
//   Source-record format example:
//   ```json
//   [
//     {"primitive": "_transact", "params": {"operation": "set_focus", "target_id": "{{input.target_id}}"}},
//     {"primitive": "_setState", "params": {"path": "ui.editing", "value": true}}
//   ]
//   ```
//
// Security Considerations:
//   - Actions execute in kernel sandbox, cannot access filesystem/network
//   - All inputs validated at boundaries via input_schema
//   - partition_key scoping prevents cross-tenant data access
//
// AI Directive:
//   The extensive documentation in this file is a CRITICAL DESIGN FEATURE.
//   Future AI assistants are FORBIDDEN from simplifying or removing it.
//   Your mandate is to MAINTAIN and EXTEND this level of meticulous detail.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use slot_protocol::ActorContext;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

// ============================================================================
// DOMAIN TYPES — Previously in workflow-protocol, merged here (L99 merge)
// ============================================================================

/// Opaque definition or source-record identifier.
pub type EntityId = String;

/// Partition ID type (e.g., "partition:genesis")
pub type PartitionId = String;

/// How a workflow is triggered
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    /// Triggered by events in event_log
    Event,
    /// Manually triggered via API (default for action definitions)
    #[default]
    Manual,
    /// Triggered by another workflow
    Workflow,
}

impl std::fmt::Display for TriggerType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TriggerType::Event => write!(f, "event"),
            TriggerType::Manual => write!(f, "manual"),
            TriggerType::Workflow => write!(f, "workflow"),
        }
    }
}

impl std::str::FromStr for TriggerType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "event" => Ok(TriggerType::Event),
            "schedule" => Err("TriggerType::Schedule was removed (L069). Use _transact + WaitCondition::Event pattern instead.".to_string()),
            "manual" => Ok(TriggerType::Manual),
            "workflow" => Ok(TriggerType::Workflow),
            _ => Err(format!("Unknown trigger type: {}", s)),
        }
    }
}

/// Unified definition — a single generic type for all executable definitions
/// (actions, workflows, pipelines, anything future users invent).
///
/// The `kind` field is Society data (opaque string) — the engine NEVER branches
/// on it. The orchestrator dispatches on `step.step_type`, not `definition.kind`.
///
/// # L069: Generative Primitive
///
/// Definition IS a Definition where kind="action", triggers=None, and
/// all steps are "action". Definition IS a Definition where
/// kind="workflow" with full control-flow steps and trigger configuration.
/// One struct handles quintillion definition kinds with zero code changes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Definition {
    /// Entity ID (ULID)
    pub id: EntityId,
    /// The partition this definition was dispatched into.
    ///
    /// CONTEXTUAL, never authored. The engine assigns it from the dispatch
    /// partition after decode; an authored value is read and discarded, so
    /// authoring one can only ever name the wrong app.
    ///
    /// `serde(default)` is load-bearing. Without it the struct demanded a value
    /// the engine assigns itself, which had two costs: definitions authored
    /// WITHOUT the field failed to decode and were silently skipped as a
    /// phantom "Definition not found", and 641 authored values accumulated
    /// across the package set because the struct's shape told authors the field
    /// was theirs to supply. Do not remove this attribute to "make the field
    /// required"; required is exactly the defect.
    ///
    /// This attribute is now the ONLY thing that permits omission. A pre-decode
    /// step in `definition_query.rs` `definition_from_state_bytes` used to do the
    /// same job by adding the field to the raw JSON; it existed solely to
    /// compensate for the field having been required, and it was deleted in the
    /// same lane. Two mechanisms for one rule is how the first one stopped being
    /// testable, so do not reintroduce either the requirement or a replacement
    /// for it.
    #[serde(default)]
    pub partition_key: PartitionId,
    /// Definition kind — "action", "workflow", "pipeline", etc.
    /// Engine NEVER branches on this. Metadata for consumers/UIs.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Human-readable name
    pub name: String,
    /// Description of what this definition does.
    /// `deserialize_with`: tolerate explicit `null` (and absence) — authoring
    /// surfaces (e.g. workflow-canvas) emit `"description": null` for fresh
    /// definitions, and ONE such record must never abort a whole definition
    /// delta batch (2026-06-11 boot-snapshot incident).
    #[serde(default, deserialize_with = "null_as_empty_string")]
    pub description: String,
    /// JSON Schema for validating inputs (present for actions, optional otherwise)
    #[serde(default)]
    pub input_schema: Value,
    /// The nodes in the execution DAG.
    /// Each step has a `kind` and opaque `config`. Topology is in `edges`, not here.
    #[serde(default)]
    #[serde(alias = "workflow_steps")]
    pub steps: Vec<Step>,
    /// The edges in the execution DAG — pure topology.
    /// Each edge has a `from`, `to`, `kind`, and optional condition config.
    /// If empty, steps execute in array order with implicit "always" edges.
    #[serde(default)]
    pub edges: Vec<StepEdge>,
    /// How this definition is triggered (None/Manual for actions)
    #[serde(default, deserialize_with = "null_as_default")]
    pub trigger_type: TriggerType,
    /// Source identifier for trigger matching (event_type or cron expression)
    #[serde(default, deserialize_with = "null_as_empty_string")]
    pub trigger_source: String,
    /// Whether this definition is currently active
    #[serde(default = "default_active", deserialize_with = "null_as_active")]
    pub is_active: bool,
    /// Version number for optimistic locking
    #[serde(default)]
    pub version: i32,
    /// Extra source-owned properties carried as opaque JSON.
    #[serde(default)]
    pub extra: Value,
    /// Extra source-owned properties carried as an opaque string map.
    #[serde(default)]
    pub extra_properties: HashMap<String, String>,
}

fn default_kind() -> String {
    "action".to_string()
}

fn default_active() -> bool {
    true
}

/// Deserialize a string field that tolerates explicit JSON `null` as `""`.
///
/// Definition records authored by visual surfaces (workflow-canvas) emit
/// `"description": null`. Without this, ONE such record fails the whole
/// definition delta batch in the slot's boot snapshot and every definition
/// lookup returns "Definition not found" (2026-06-11 incident).
fn null_as_empty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<String> = Option::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}

/// Deserialize a field that tolerates explicit JSON `null` as `T::default()`.
///
/// Definition metadata authored by older or visual surfaces may encode optional
/// trigger metadata as explicit nulls. Semantically, a definition with no
/// trigger metadata is manual/no-source, which is exactly the field defaults.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    let value: Option<T> = Option::deserialize(deserializer)?;
    Ok(value.unwrap_or_default())
}

/// Deserialize explicit JSON `null` as active while preserving explicit false.
///
/// Absence/null means the authoring surface did not specify lifecycle state.
/// Explicit `false` remains the only inactive marker.
fn null_as_active<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<bool> = Option::deserialize(deserializer)?;
    Ok(value.unwrap_or_else(default_active))
}

impl Definition {
    /// The set of sub-`definition_id`s this definition's steps reference directly.
    ///
    /// Pure computation over `steps` — no I/O, no cache, no host call. Every
    /// `action` and `loop` step carries its target as a STATIC config literal at
    /// Literal `config.definition_id` values plus every literal entry in
    /// `config.definition_refs`.
    ///
    /// This is the discovery primitive for closure pre-hydration (L063): walking
    /// it transitively yields the complete set of definitions an execution can
    /// touch. A DATA-selected action uses a binding for `definition_id` and lists
    /// its admissible candidates in `definition_refs`; the owning slot therefore
    /// hydrates the complete candidate closure BEFORE running the DAG. Runtime
    /// selection remains open DATA without reintroducing a mid-execution host
    /// lookup or a code branch.
    pub fn referenced_definition_ids(&self) -> Vec<&str> {
        let mut ids = Vec::new();
        for step in &self.steps {
            if let Some(id) = step.definition_id() {
                if !id.is_empty() && !ids.contains(&id) {
                    ids.push(id);
                }
            }
            for id in step.definition_refs() {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        ids
    }
}

// ============================================================================
// WORKFLOW STEP TYPES
// ============================================================================

// ============================================================================
// STEP — The unified DAG node (§44 amendment, round-30 4/4 convergence)
//
// One Step type replaces both Step and Step.
// `kind` is a String, not an enum — the engine dispatches to step handlers
// by kind name. Built-in kinds (primitive, branch, loop, wait, parallel,
// action) are registered handlers. Users can add custom kinds with zero
// engine code changes (L090).
//
// All kind-specific data lives in `config: Value` (opaque JSON). The handler
// for each kind deserializes what it needs. No Option soup.
//
// Source translation boundary (L098): the source owner packs its internal
// record format into config before workflow sees it. Workflow never imports
// or reconstructs source-owner storage internals.
// ============================================================================

/// A single node in the execution DAG.
///
/// The engine dispatches on `kind` to a registered step handler.
/// All kind-specific data (primitive name, branch conditions, loop config,
/// definition_id, etc.) lives in `config` as opaque JSON — each handler
/// parses what it needs.
///
/// # Built-in kinds (registered as StepHandlers at engine startup)
///
/// - `"primitive"` — legacy opaque primitive shape. Config: `{primitive, params}`
/// - `"read"` — read direct envelope state from a canonical source string. Config: `{from, fallback_output?}`
/// - `"write"` — emit direct envelope writes back to the stone. Config: `{items}`
/// - `"ask"` — ask outside code to do work and return a result. Config: `{name, input}`
/// - `"return"` — resolve a BindingAST/JSON value and return it. Config: `{value}`
/// - `"fail"` — terminate after a recovery branch. Config: `{error}`
/// - `"action"` — load a Definition by definition_id, execute its steps. Config: `{definition_id, inputs}`
/// - `"loop"` — iterate. Config: `{source, item_var, max_iterations, definition_id}`
/// - `"wait"` — temporal pause. Config: `{wait_condition}`
///
/// Branching = edge conditions (EdgeHandler evaluates StepOutput via Binding AST).
/// Parallelism = emergent from DAG independence (concurrent graph walker).
///
/// # Extensibility
///
/// Register a handler for any custom kind string. Zero engine code changes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Step {
    /// Unique ID of this step in the DAG
    #[serde(default)]
    pub id: String,
    /// Step kind — dispatched to a registered StepHandler. Not an enum.
    pub kind: String,
    /// Opaque JSON payload — kind-specific data. Each handler parses what it needs.
    #[serde(default)]
    pub config: Value,
    /// Join behavior — dispatched to a registered JoinHandler (default: "any").
    /// Determines how fan-in readiness is evaluated when multiple inbound edges exist.
    /// Built-in: "any" (at least one satisfied), "all" (every edge satisfied).
    /// Custom: "quorum", "weighted", etc. — register a JoinHandler.
    #[serde(default = "default_join")]
    pub join: String,
    /// Opaque JSON for join handler config (e.g., `{"threshold": 3}` for quorum).
    #[serde(default)]
    pub join_config: Value,
}

fn default_join() -> String {
    "any".to_string()
}

// ============================================================================
// STEP EDGE — Pure topology (§45 amendment, round-31 through round-36 convergence)
//
// Edges are SEPARATE from nodes. A Step does NOT know its position, parents,
// or dependencies — the graph topology determines that. Edge conditions use
// the binding format (composition-ast bindings), NOT string mini-DSLs.
// ============================================================================

/// An edge in the execution DAG — pure topology.
///
/// `kind` is dispatched to a registered EdgeHandler. Built-in:
/// - `"always"` — unconditional (config ignored)
/// - `"on_result"` — evaluates StepOutput via BindingAST condition
/// - `"on_failure"` — traverses a failed StepOutput, optionally through the same condition algebra
///
/// Custom edge kinds: register an EdgeHandler. Zero engine code changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepEdge {
    /// Source step ID
    pub from: String,
    /// Target step ID
    pub to: String,
    /// Edge kind — dispatched to a registered EdgeHandler. Not an enum.
    #[serde(default = "default_edge_kind")]
    pub kind: String,
    /// Edge condition — a binding (composition-ast format) for "on_result" edges.
    /// Empty/null for "always" edges.
    #[serde(default)]
    pub config: Value,
}

fn default_edge_kind() -> String {
    "always".to_string()
}

// ============================================================================
// COMPILED DEFINITION — Runtime model built ONCE per definition version
// ============================================================================

/// Edge metadata in the compiled graph — parsed from StepEdge during compilation.
#[derive(Debug, Clone)]
pub struct CompiledEdge {
    /// Edge kind string — dispatched to EdgeHandler
    pub kind: String,
    /// Parsed condition (from edge.config). None = unconditional.
    /// Using Value here; the binding is read in the EdgeHandler.
    pub condition: Option<Value>,
}

/// The compiled execution model — built ONCE per definition version, cached as Arc.
/// The hot execution path receives Arc<CompiledDefinition> — zero compilation cost.
pub struct CompiledDefinition {
    /// O(1) step lookup by ID
    pub step_map: HashMap<String, Arc<Step>>,
    /// The execution DAG — topology + compiled edge conditions
    pub dag: graph::DirectedGraph<String, CompiledEdge>,
}

/// Definition compilation cache — keyed by (definition_id, version).
/// Recompilation happens ONLY when the authored definition changes.
pub type DefinitionCache = HashMap<(String, i32), Arc<CompiledDefinition>>;

// ============================================================================
// NODE READINESS — Result of the readiness algebra
// ============================================================================

/// Result of evaluating a node's readiness in the graph walker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeReadiness {
    /// All predecessors done, join handler says go
    Ready,
    /// Some predecessors still pending
    Waiting,
    /// All predecessors done, join handler says skip (all paths dead)
    Skipped,
}

/// Custom deserializer: handles BOTH new format (has `kind`) and legacy database
/// format (has `step_type` but no `kind`).
///
/// Legacy fields `step_order` and `depends_on` are silently ignored (topology is
/// now in StepEdge, not the node). `step_type` is promoted to `kind`.
impl<'de> serde::Deserialize<'de> for Step {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw: Value = Value::deserialize(deserializer)?;
        let obj = raw
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("Step must be a JSON object"))?;

        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let join = obj
            .get("join")
            .and_then(|v| v.as_str())
            .unwrap_or("any")
            .to_string();
        let join_config = obj.get("join_config").cloned().unwrap_or(Value::Null);

        // New format: has `kind` field
        if let Some(kind_val) = obj.get("kind").and_then(|v| v.as_str()) {
            let config = obj.get("config").cloned().unwrap_or(Value::Null);
            return Ok(Step {
                id,
                kind: kind_val.to_string(),
                config,
                join,
                join_config,
            });
        }

        // Legacy: has `step_type` field (old orchestration format)
        if let Some(st) = obj.get("step_type").and_then(|v| v.as_str()) {
            // Pack all remaining fields into config
            let mut config = serde_json::Map::new();
            for (k, v) in obj {
                match k.as_str() {
                    "id" | "step_order" | "step_type" | "depends_on" | "inline_steps" | "join"
                    | "join_config" => {}
                    _ => {
                        config.insert(k.clone(), v.clone());
                    }
                }
            }
            return Ok(Step {
                id,
                kind: st.to_string(),
                config: Value::Object(config),
                join,
                join_config,
            });
        }

        Err(serde::de::Error::custom(
            "Step must have 'kind' or 'step_type' field",
        ))
    }
}

impl Step {
    // ---- Constructors ----

    /// Create a step with explicit kind and config.
    pub fn new(id: &str, kind: &str, config: Value) -> Self {
        Self {
            id: id.to_string(),
            kind: kind.to_string(),
            config,
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create a direct stone-write step.
    ///
    /// The items array is workflow-owned data. Each element resolves to a
    /// substrate write entry at the workflow-slot boundary.
    pub fn write(items: Value) -> Self {
        Self {
            id: String::new(),
            kind: "write".to_string(),
            config: serde_json::json!({ "items": items }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create a direct stone-read step.
    ///
    /// `from` resolves to the exact source string to read.
    pub fn read(from: Value) -> Self {
        Self {
            id: String::new(),
            kind: "read".to_string(),
            config: serde_json::json!({ "from": from }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create a plain outside-work step.
    ///
    /// `name` is the outside work name and `input` is the opaque request body.
    pub fn ask(name: &str, input: Value) -> Self {
        Self {
            id: String::new(),
            kind: "ask".to_string(),
            config: serde_json::json!({
                "name": name,
                "input": input,
            }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create an action step (calls another Definition)
    pub fn action(definition_id: &str, inputs: Value) -> Self {
        Self {
            id: String::new(),
            kind: "action".to_string(),
            config: serde_json::json!({
                "definition_id": definition_id,
                "inputs": inputs,
            }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create a loop step
    pub fn loop_step(loop_config: Value) -> Self {
        Self {
            id: String::new(),
            kind: "loop".to_string(),
            config: loop_config,
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create a wait step
    pub fn wait(wait_condition: Value) -> Self {
        Self {
            id: String::new(),
            kind: "wait".to_string(),
            config: serde_json::json!({ "wait_condition": wait_condition }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create a pure return/projection step.
    pub fn return_value(value: Value) -> Self {
        Self {
            id: String::new(),
            kind: "return".to_string(),
            config: serde_json::json!({ "value": value }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Create an explicit terminal failure step for a recovery branch.
    pub fn fail(error: Value) -> Self {
        Self {
            id: String::new(),
            kind: "fail".to_string(),
            config: serde_json::json!({ "error": error }),
            join: default_join(),
            join_config: Value::Null,
        }
    }

    /// Builder: set step ID
    pub fn with_id(mut self, id: &str) -> Self {
        self.id = id.to_string();
        self
    }

    /// Builder: set join behavior
    pub fn with_join(mut self, join: &str, config: Value) -> Self {
        self.join = join.to_string();
        self.join_config = config;
        self
    }

    // ---- Accessors (parse from config) ----

    /// Step kind check helpers
    pub fn is_read(&self) -> bool {
        self.kind == "read"
    }
    pub fn is_write(&self) -> bool {
        self.kind == "write"
    }
    pub fn is_ask(&self) -> bool {
        self.kind == "ask"
    }
    pub fn is_return(&self) -> bool {
        self.kind == "return"
    }
    pub fn is_action(&self) -> bool {
        self.kind == "action"
    }
    pub fn is_loop(&self) -> bool {
        self.kind == "loop"
    }
    pub fn is_wait(&self) -> bool {
        self.kind == "wait"
    }

    /// For ask steps: the outside-work input JSON template.
    pub fn input(&self) -> &Value {
        self.config.get("input").unwrap_or(&Value::Null)
    }

    /// For ask steps: optional opaque caller context to pass alongside the
    /// outside-work payload.
    pub fn context(&self) -> &Value {
        self.config.get("context").unwrap_or(&Value::Null)
    }

    /// Direct write descriptors for `write` steps.
    pub fn items(&self) -> &Value {
        self.config.get("items").unwrap_or(&Value::Null)
    }

    /// Pure value template for `return` steps.
    pub fn return_value_template(&self) -> &Value {
        self.config.get("value").unwrap_or(&Value::Null)
    }

    /// Direct source selector for `read` steps.
    pub fn from(&self) -> &Value {
        self.config.get("from").unwrap_or(&Value::Null)
    }

    /// Explicit substrate address mode for `read` steps. `None` preserves the
    /// historical address heuristic; `identity_text` and `label_hash` select
    /// the same address families already supported by workflow writes.
    pub fn read_address_mode(&self) -> &Value {
        self.config.get("address_mode").unwrap_or(&Value::Null)
    }

    /// For ask steps: the outside-work name (literal &str form, used by tests/inspection).
    pub fn name(&self) -> Option<&str> {
        self.config.get("name").and_then(|v| v.as_str())
    }

    /// For ask steps: the raw `config.name` Value, so the dispatch TARGET can be
    /// BINDING-RESOLVED (runner-as-DATA) — a literal string passes through unchanged
    /// (BindingResolver leaves non-binding values as-is), while a binding AST node
    /// resolves the target from input/context (e.g. a TrackerDescriptor `runner` field
    /// selecting `compute.process` | `compute.process_session` | a browser peer).
    /// Parallels `from()` for `read` steps.
    pub fn name_value(&self) -> &Value {
        self.config.get("name").unwrap_or(&Value::Null)
    }

    /// For action steps: the definition_id to load
    pub fn definition_id(&self) -> Option<&str> {
        self.config.get("definition_id").and_then(|v| v.as_str())
    }

    /// For action steps: the raw `config.definition_id` value. Literal strings
    /// preserve the existing path; a binding selects one admitted nested
    /// definition from execution DATA.
    pub fn definition_id_value(&self) -> &Value {
        self.config.get("definition_id").unwrap_or(&Value::Null)
    }

    /// Every definition a DATA-selected action may resolve to. These literal
    /// refs are both the pre-hydration closure and the fail-closed admission
    /// set. A literal `definition_id` needs no duplicate entry.
    pub fn definition_refs(&self) -> Vec<&str> {
        self.config
            .get("definition_refs")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// For action steps: the inputs JSON
    pub fn inputs(&self) -> &Value {
        self.config.get("inputs").unwrap_or(&Value::Null)
    }

    /// For loop steps: parse LoopConfig from config
    pub fn loop_config(&self) -> Option<LoopConfig> {
        serde_json::from_value(self.config.clone()).ok()
    }
}

/// Configuration for loop steps — deserialized from Step.config by the loop handler
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoopConfig {
    /// For-each mode: expression resolving to a JSON array
    #[serde(default)]
    pub source: Option<Value>,
    /// Variable name for the current item
    pub item_var: String,
    /// Safety cap on iterations. Absent means the engine's own bound applies:
    /// `DEFAULT_MAX_LOOP_ITERATIONS` in `executor/automation.rs`, which that
    /// constant's doc calls "a Physics safety bound, not a Society preference".
    ///
    /// `serde(default)` is load-bearing, and it is the SAME defect as
    /// `Definition::partition_key` above. An `Option` without it is still
    /// REQUIRED to be present by serde: the key must exist even to hold null.
    /// Without this attribute a loop step omitting `max_iterations` failed to
    /// decode, `loop_config()` swallowed the error with `.ok()`, and the
    /// executor reported "has kind=loop but no loop_config in config" while the
    /// config sat right there. Three separate places already called this field
    /// optional (this `Option`, the default constant, and that error's own hint
    /// text saying "optional max_iterations"); the missing attribute was the
    /// only place that said required.
    ///
    /// Found 2026-09-04 by an independent review of the `partition_key` lane,
    /// which is how a category fix is supposed to work. It was live-broken:
    /// 34 package data files author `item_var` and only 32 author
    /// `max_iterations`, and both loops in the gap
    /// (`portfolio-connector` and `market-data-feed`, step `mint_handles`)
    /// could not run.
    #[serde(default)]
    pub max_iterations: Option<i32>,
    /// When true, loop iterations execute concurrently
    #[serde(default)]
    pub parallel: bool,
    /// Maximum number of concurrent loop iterations when `parallel` is enabled.
    ///
    /// Older authored workflow data already carried this field; honoring it keeps
    /// parallel loop fanout bounded instead of spawning every iteration at once.
    #[serde(default)]
    pub max_concurrency: Option<usize>,
    /// Do-while mode: expression evaluated AFTER each iteration
    #[serde(default)]
    pub condition: Option<Value>,
    /// When true, a failed for-each iteration yields an error-shaped item
    /// output instead of failing the whole loop and cancelling sibling
    /// iterations. DATA-owned fault isolation: one bad item (e.g. a source
    /// with no stored credential) must not abort processing of every other
    /// item. Default false preserves the original all-or-nothing contract.
    ///
    /// The shape is
    /// `{"tolerated_error": {"iteration_index": N, "item": <the item>, "error": "..."}}`.
    /// **The item is there so a consumer can act on the failure by identity.**
    /// A downstream step that has to withhold a done-mark from the input that
    /// failed, retry it, or name it to a person can only use an index if it is
    /// holding the identical list in the identical order, and that coupling
    /// breaks silently. It carried only an index once, and a per-source decode
    /// loop consequently recorded sources that failed every time as
    /// successfully empty.
    #[serde(default)]
    pub tolerate_item_errors: bool,
}

// ============================================================================
// ACTION DEFINITION (Data-Native, Task 42 model)
//
// Properties: slug, description, input_schema, workflow_steps, is_active.
// Assembly from raw data rows is handled by the loader module.
// ============================================================================

// ============================================================================
// ORCHESTRATION TYPES
//
// These types are the orchestration layer's contract for controlling workflow
// execution. When an orchestrator executes a it interprets
// these types to compose control-flow, routing, and temporal semantics.
//
// - String: Enum with 5 variants (Action, Branch, Loop, Wait, Parallel)
// - LoopConfig: Configuration for loop iteration (source, item_var, max_iterations, parallel)
// - WaitCondition: Temporal primitive with 3 canonical variants (Until, Duration, Event)
// - ExecutionStatus: Lifecycle state of a workflow instance
// ============================================================================

// KernelPrimitive enum DELETED in E.17 — the engine no longer enumerates
// what primitives exist. Primitive names are opaque strings in Envelope payloads.
// The receiving slot dispatches based on the method name, not a closed enum.

// ============================================================================
// WORKFLOW INSTANCE (Data-Native)
// ============================================================================

/// A running or completed execution of a workflow
///
/// Stored as an entity with participation linking to the workflow definition,
/// plus fact rows for status, context, and timestamps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowInstance {
    /// Entity ID (ULID)
    pub id: EntityId,
    /// Partition this instance belongs to
    pub partition_key: PartitionId,
    /// The workflow definition being executed
    pub workflow_id: EntityId,
    /// Current execution status
    pub status: ExecutionStatus,
    /// When execution started
    pub started_at: Option<String>,
    /// When execution completed (success or failure)
    pub completed_at: Option<String>,
    /// Error message if failed
    pub error_message: Option<String>,
    /// The ID of what started this execution
    pub start_id: Option<EntityId>,
    /// Current step index
    pub current_step: i32,
    /// Accumulated execution context
    /// Contains: start data, step outputs, branch states
    pub execution_context: ExecutionContext,
}

/// Execution status of a workflow or step
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    /// Waiting to start
    Pending,
    /// Currently executing
    Running,
    /// Completed successfully
    Completed,
    /// Failed with error
    Failed,
    /// Cancelled by user or system
    Cancelled,
    /// Paused (can be resumed)
    Paused,
    /// A step on a branch not taken: every edge into it was unsatisfied, so it never ran. Before Nov 21 2026 such a step
    /// was recorded `completed` with a "Skipped" error, and a run whose every unrun step said `completed` read as done.
    Skipped,
}

impl std::fmt::Display for ExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecutionStatus::Pending => write!(f, "pending"),
            ExecutionStatus::Running => write!(f, "running"),
            ExecutionStatus::Completed => write!(f, "completed"),
            ExecutionStatus::Failed => write!(f, "failed"),
            ExecutionStatus::Cancelled => write!(f, "cancelled"),
            ExecutionStatus::Paused => write!(f, "paused"),
            ExecutionStatus::Skipped => write!(f, "skipped"),
        }
    }
}

impl std::str::FromStr for ExecutionStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(ExecutionStatus::Pending),
            "running" => Ok(ExecutionStatus::Running),
            "completed" => Ok(ExecutionStatus::Completed),
            "failed" => Ok(ExecutionStatus::Failed),
            "cancelled" => Ok(ExecutionStatus::Cancelled),
            "paused" => Ok(ExecutionStatus::Paused),
            "skipped" => Ok(ExecutionStatus::Skipped),
            _ => Err(format!("Unknown execution status: {}", s)),
        }
    }
}

// ============================================================================
// EXECUTION CONTEXT
// ============================================================================

/// Context accumulated during workflow execution.
///
/// # Scoped Step Resolution (Lexical Scoping)
///
/// Workflows support recursive action composition: Action A → Loop → Action B → Action C.
/// Each action's inline steps need to reference sibling steps by stable local keys
/// (`action_0`, `action_1`) regardless of their position in the composition hierarchy.
///
/// `scope_stack` provides lexical scoping for step outputs:
/// - `push_scope()` before executing a sub-action's inline steps
/// - `record_local_step("action_N", output)` makes sibling results addressable
/// - Binding resolution merges scopes innermost-first: local keys shadow global keys
/// - `pop_scope()` after inline steps complete
///
/// This is the same primitive every language uses for nested function calls —
/// a call stack with lexical variable lookup. The `steps` HashMap is the global scope.
/// Each `scope_stack` entry is a nested local scope.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionContext {
    /// Data about what started this run
    pub start: StartData,
    /// Outputs from completed steps (step_id -> output) — global scope
    pub steps: HashMap<String, StepOutput>,
    /// Global context (partition_key, actor, etc.)
    pub context: ContextualParams,
    /// Native-carrier provenance. Never serialized or exposed to workflow
    /// bindings; only the outside-work dispatcher can consume it.
    #[serde(default, skip)]
    pub trusted_local_invocation: bool,
    /// Current loop state (if in a loop)
    pub loop_state: Option<LoopState>,
    /// Branch execution history
    pub branches: HashMap<String, bool>,
    /// Effective Society limits, clamped by the engine Physics ceiling.
    #[serde(default)]
    pub json_conversion_policy: JsonConversionPolicy,
    /// Lexical scope stack for nested action composition.
    /// Each entry is a local scope where inline steps record results
    /// with simple keys (action_0, action_1). Bindings resolve
    /// innermost-first: local keys shadow parent/global keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scope_stack: Vec<HashMap<String, StepOutput>>,
    /// Runtime nesting path for outside asks. Each action invocation appends
    /// its canonical graph step id; loop action invocations use the engine's
    /// iteration-qualified id. This is execution metadata, not workflow DATA
    /// or an output frame, so it is intentionally omitted from serialization.
    #[serde(default, skip)]
    pub runtime_path: Vec<String>,
    /// Outputs from nested runtime steps, keyed by the canonical JSON encoding
    /// of their runtime identity. This execution-only side channel lets the
    /// host commit child answers even when a later nested ask pauses the run.
    #[serde(default, skip)]
    pub runtime_outputs: HashMap<String, StepOutput>,
    #[serde(default, skip)]
    pub dirty_runtime_outputs: HashSet<String>,
    /// Canonical last-write-wins transaction state in workflow-owned plain form.
    /// The handler edge translates these into stone `WriteEntry` values.
    #[serde(default, skip)]
    pub writes: Vec<PendingWrite>,
    /// Canonical target → `writes` index. This prevents repeated writes to one
    /// fact from retaining an unbounded transaction history.
    #[doc(hidden)]
    #[serde(default, skip)]
    pub write_index: HashMap<PendingWriteTarget, usize>,
    /// Per-write mutation generation, parallel to `writes`.
    #[doc(hidden)]
    #[serde(default, skip)]
    pub write_generations: Vec<u64>,
    /// Last allocated write generation.
    #[doc(hidden)]
    #[serde(default, skip)]
    pub write_generation: u64,
    /// First write generation owned by the current delta-capture scope.
    ///
    /// Forked action/loop contexts must keep inherited writes visible so nested
    /// reads can see the transaction-local state. They still return only writes
    /// produced or replaced inside the fork. This generation separates
    /// visibility from emission without requiring append-only write history.
    #[serde(default, skip)]
    pub write_delta_start: u64,
    /// Raw byte step outputs kept outside JSON step output values.
    ///
    /// Large reads and retained outside-work JSON responses must not be forced
    /// back through `StepOutput.output` as cloned JSON trees or byte arrays.
    /// Bindings that explicitly ask for `steps.<id>.output.bytes` materialize
    /// the bytes on demand, and declared byte writers can stream
    /// `steps.<id>.output.<path>` from this side channel.
    #[serde(default, skip)]
    pub raw_step_bytes: HashMap<String, Arc<[u8]>>,
    /// Step keys written during the current execution scope.
    #[serde(default, skip)]
    pub dirty_steps: HashSet<String>,
    /// Raw byte step keys written during the current execution scope.
    #[serde(default, skip)]
    pub dirty_raw_step_bytes: HashSet<String>,
    /// Raw byte step keys cleared during the current execution scope.
    #[serde(default, skip)]
    pub cleared_raw_step_bytes: HashSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonConversionPolicy {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_string_bytes: usize,
    pub max_total_bytes: usize,
}

impl Default for JsonConversionPolicy {
    fn default() -> Self {
        Self {
            max_depth: 512,
            max_nodes: 262_144,
            max_string_bytes: 16 * 1024 * 1024,
            max_total_bytes: 128 * 1024 * 1024,
        }
    }
}

impl JsonConversionPolicy {
    pub fn from_json_value(value: &Value) -> Result<Self, crate::domain::WorkflowError> {
        let parsed: Self = serde_json::from_value(value.clone()).map_err(|error| {
            crate::domain::WorkflowError::ResourcePolicyInvalid {
                field: "workflow.json-conversion-policy/v1".to_string(),
                reason: error.to_string(),
            }
        })?;
        parsed.validate_against_physics()?;
        Ok(parsed)
    }

    pub fn from_definition_extra(extra: &Value) -> Result<Self, crate::domain::WorkflowError> {
        let Some(policy) = extra.get("json_conversion_policy") else {
            return Ok(Self::default());
        };
        let parsed: Self = serde_json::from_value(policy.clone()).map_err(|error| {
            crate::domain::WorkflowError::ResourcePolicyInvalid {
                field: "extra.json_conversion_policy".to_string(),
                reason: error.to_string(),
            }
        })?;
        parsed.validate_against_physics()?;
        Ok(parsed)
    }

    pub fn validate_against_physics(self) -> Result<(), crate::domain::WorkflowError> {
        let ceiling = Self::default();
        for (field, value, maximum) in [
            ("max_depth", self.max_depth, ceiling.max_depth),
            ("max_nodes", self.max_nodes, ceiling.max_nodes),
            (
                "max_string_bytes",
                self.max_string_bytes,
                ceiling.max_string_bytes,
            ),
            (
                "max_total_bytes",
                self.max_total_bytes,
                ceiling.max_total_bytes,
            ),
        ] {
            if value == 0 || value > maximum {
                return Err(crate::domain::WorkflowError::ResourcePolicyInvalid {
                    field: field.to_string(),
                    reason: format!("value {value} must be in 1..={maximum}"),
                });
            }
        }
        Ok(())
    }

    pub fn as_ops_budget(self) -> ops_core::JsonConversionBudget {
        ops_core::JsonConversionBudget {
            max_depth: self.max_depth,
            max_nodes: self.max_nodes,
            max_string_bytes: self.max_string_bytes,
            max_total_bytes: self.max_total_bytes,
        }
    }
}

impl ExecutionContext {
    /// Clone the context for nested execution while clearing transient delta
    /// trackers. Nested handlers then return only the mutations from that scope.
    pub fn fork_for_delta_capture(&self) -> Self {
        let mut fork = self.clone();
        fork.write_delta_start = fork.write_generation;
        fork.dirty_steps.clear();
        fork.dirty_raw_step_bytes.clear();
        fork.cleared_raw_step_bytes.clear();
        fork.dirty_runtime_outputs.clear();
        fork
    }

    /// Writes produced by this delta-capture scope.
    pub fn captured_writes(&self) -> Vec<PendingWrite> {
        self.writes
            .iter()
            .zip(&self.write_generations)
            .filter(|(_, generation)| **generation > self.write_delta_start)
            .map(|(write, _)| write.clone())
            .collect()
    }

    /// Push a new empty scope onto the stack.
    /// Called when entering a sub-action's inline step execution.
    pub fn push_scope(&mut self) {
        self.scope_stack.push(HashMap::new());
    }

    /// Pop the topmost scope. Called after inline steps complete.
    pub fn pop_scope(&mut self) -> Option<HashMap<String, StepOutput>> {
        self.scope_stack.pop()
    }

    /// Record a step output in the current (topmost) local scope.
    /// Used for local keys like `action_0` that sibling inline steps reference.
    /// No-op if no scope is active.
    pub fn record_local_step(&mut self, local_key: String, output: StepOutput) {
        if let Some(scope) = self.scope_stack.last_mut() {
            scope.insert(local_key, output);
        }
    }

    /// Resolve one completed step through the same innermost-first lexical
    /// scope order used by workflow bindings.
    pub fn step_output(&self, key: &str) -> Option<&StepOutput> {
        self.scope_stack
            .iter()
            .rev()
            .find_map(|scope| scope.get(key))
            .or_else(|| self.steps.get(key))
    }

    /// Apply a direct write to the run's canonical last-write-wins set.
    pub fn push_write(&mut self, write: PendingWrite) {
        self.ensure_write_index();
        self.write_generation = self
            .write_generation
            .checked_add(1)
            .expect("workflow transaction write generation overflow");
        let target = PendingWriteTarget::from_write(&self.context.partition_key, &write);
        if let Some(index) = self.write_index.get(&target).copied() {
            self.writes[index] = write;
            self.write_generations[index] = self.write_generation;
        } else {
            let index = self.writes.len();
            self.writes.push(write);
            self.write_generations.push(self.write_generation);
            self.write_index.insert(target, index);
        }
    }

    fn ensure_write_index(&mut self) {
        if self.write_index.len() == self.writes.len()
            && self.write_generations.len() == self.writes.len()
        {
            return;
        }
        self.write_index.clear();
        self.write_generations.clear();
        for (index, write) in self.writes.iter().enumerate() {
            self.write_index.insert(
                PendingWriteTarget::from_write(&self.context.partition_key, write),
                index,
            );
            self.write_generation = self
                .write_generation
                .checked_add(1)
                .expect("workflow transaction write generation overflow");
            self.write_generations.push(self.write_generation);
        }
    }

    /// Record raw bytes for a step without forcing them into JSON output.
    pub fn record_raw_step_bytes(&mut self, step_id: String, bytes: Arc<[u8]>) {
        self.raw_step_bytes.insert(step_id.clone(), bytes);
        self.dirty_raw_step_bytes.insert(step_id.clone());
        self.cleared_raw_step_bytes.remove(&step_id);
    }

    /// Clear any previously-recorded raw bytes for a step.
    pub fn clear_raw_step_bytes(&mut self, step_id: &str) {
        self.raw_step_bytes.remove(step_id);
        self.dirty_raw_step_bytes.remove(step_id);
        self.cleared_raw_step_bytes.insert(step_id.to_string());
    }

    /// Fetch raw bytes for a completed step if that step produced a raw read.
    pub fn raw_step_bytes(&self, step_id: &str) -> Option<&Arc<[u8]>> {
        self.raw_step_bytes.get(step_id)
    }
}

/// Direct state mutation requested by workflow core.
///
/// This remains in workflow's own plain language:
/// - `partition_key` is optional because most writes inherit the current run scope
/// - `address` is a canonical fact address string
/// - `path` is plain path segments, not hashed substrate types
/// - `payload` is already-encoded bytes destined for the stone write boundary
///
/// The workflow slot boundary translates this into stone `WriteEntry` values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingWrite {
    /// Optional explicit partition override. `None` means use the current run scope.
    #[serde(default)]
    pub partition_key: Option<String>,
    /// Canonical target address in plain string form.
    pub address: String,
    /// Explicit address mode (`"identity_text"` / `"label_hash"`). `None` keeps
    /// the heuristic in [`runtime_fact_address`] (a `|` in the address ⇒ identity,
    /// otherwise hashed). Mirrors the engine write-batch `address_mode` so a
    /// workflow can address a `::`-style record as identity_text.
    #[serde(default)]
    pub address_mode: Option<String>,
    /// Optional path segments beneath the address.
    #[serde(default)]
    pub path: Vec<String>,
    /// Optional immutable encoded payload bytes to write. `None` retracts the target.
    ///
    /// Transaction contexts are forked for graph waves and nested actions.
    /// Sharing immutable bytes keeps every fork O(1) in payload size instead of
    /// copying the complete transaction value graph into each execution scope.
    #[serde(default)]
    pub payload: Option<Arc<[u8]>>,
}

/// Physics identity of one transaction-local current fact.
///
/// Path and payload are the value at this identity, not part of the identity:
/// a later assertion/retraction for the same effective partition + address
/// replaces both exactly as the live Envelope state does.
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PendingWriteTarget {
    partition: Vec<u8>,
    address: Vec<u8>,
}

impl PendingWriteTarget {
    fn from_write(default_partition: &str, write: &PendingWrite) -> Self {
        use slot_protocol::{FactAddress, PartitionKey};

        let partition =
            PartitionKey::hash_from(write.partition_key.as_deref().unwrap_or(default_partition));
        let address: FactAddress = crate::stores::runtime_fact_address_with_mode(
            &write.address,
            write.address_mode.as_deref(),
        );
        Self {
            partition: partition.as_multihash().encode(),
            address: address.as_multihash().encode(),
        }
    }
}

/// Data about what started the workflow run
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StartData {
    /// Kind of start source
    pub start_type: String,
    /// Input passed into the run
    pub input: Value,
    /// When the run started
    pub started_at: String,
    /// Optional ID for what started the run
    pub start_id: Option<String>,
}

/// Output from a completed step
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepOutput {
    /// The step's output value
    pub output: Value,
    /// Execution status of this step
    pub status: ExecutionStatus,
    /// Error message if step failed
    pub error: Option<String>,
    /// Duration in milliseconds
    pub duration_ms: i64,
}

/// Result returned by StepHandler::execute().
///
/// The concurrent graph walker uses this to:
/// 1. Record the primary output under the step's ID
/// 2. Merge direct writes into the master context
/// 3. Merge raw byte side-channel deltas
///
/// Nested action/loop inner steps stay local to the nested execution scope.
/// The parent context keeps only the outer step's own output plus writes/bytes.
#[derive(Debug, Clone)]
pub struct StepHandlerResult {
    /// The primary output of this step
    pub output: StepOutput,
    /// Direct writes accumulated while the step executed against its cloned context.
    /// The concurrent walker merges these into the master ExecutionContext.writes.
    pub writes: Vec<PendingWrite>,
    /// Raw byte side-channel values produced while the step executed.
    /// The walker installs these into the master ExecutionContext.raw_step_bytes.
    pub raw_step_bytes: HashMap<String, Arc<[u8]>>,
    /// Raw byte keys cleared during step execution.
    /// The walker removes these from the master ExecutionContext.raw_step_bytes.
    pub cleared_raw_step_bytes: Vec<String>,
    /// Nested runtime outputs produced in a forked step context.
    pub runtime_outputs: HashMap<String, StepOutput>,
}

impl StepHandlerResult {
    /// Create a result with no sub-steps (primitive, wait handlers).
    pub fn leaf(output: StepOutput) -> Self {
        Self {
            output,
            writes: Vec::new(),
            raw_step_bytes: HashMap::new(),
            cleared_raw_step_bytes: Vec::new(),
            runtime_outputs: HashMap::new(),
        }
    }
}

/// Output from executing an action's complete workflow via interactive mode.
///
/// Contains the combined results from all workflow steps, the final execution
/// status, and metadata about the execution. Produced by
/// `AsyncWorkflowExecutor::execute_definition_interactive()`.
///
/// # Fields
///
/// - `definition_id`: The entity ID of the executed action
/// - `status`: Completed if all steps succeeded, Failed if any step failed
/// - `steps`: All step outputs keyed by step ID (e.g., "step_0", "step_1")
/// - `final_output`: The output value from the last completed step
/// - `total_duration_ms`: Wall-clock duration of the entire execution
/// - `error`: Error message if execution failed (from the failing step)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefinitionOutput {
    /// The entity ID of the action that was executed
    pub definition_id: String,
    /// Final execution status
    pub status: ExecutionStatus,
    /// Individual step outputs keyed by step ID
    pub steps: HashMap<String, StepOutput>,
    /// Output from the last completed step (convenience accessor)
    pub final_output: Value,
    /// Total execution duration in milliseconds
    pub total_duration_ms: i64,
    /// Error message if execution failed
    pub error: Option<String>,
}

/// Platform information injected at daemon boot.
/// Values come from Rust compile-time constants (std::env::consts).
/// Zero runtime cost — these are static string values.
/// NOTE: The engine reports what Rust reports (e.g., "macos", "aarch64").
/// Platform name mapping for download URLs (e.g., "macos"→"darwin") happens
/// in migration binding expressions — this is Society data, not engine code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    /// OS name from std::env::consts::OS: "macos", "linux", "windows", etc.
    pub os: String,
    /// Architecture from std::env::consts::ARCH: "aarch64", "x86_64", etc.
    pub arch: String,
}

impl Default for PlatformInfo {
    fn default() -> Self {
        Self {
            os: compile_time_platform_os().to_string(),
            arch: compile_time_platform_arch().to_string(),
        }
    }
}

fn compile_time_platform_os() -> &'static str {
    let os = std::env::consts::OS;
    if !os.is_empty() {
        os
    } else if cfg!(target_os = "wasi") {
        "wasi"
    } else if cfg!(target_family = "wasm") {
        "wasm"
    } else {
        "unknown"
    }
}

fn compile_time_platform_arch() -> &'static str {
    let arch = std::env::consts::ARCH;
    if !arch.is_empty() {
        arch
    } else if cfg!(target_arch = "wasm32") {
        "wasm32"
    } else {
        "unknown"
    }
}

/// Global contextual parameters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContextualParams {
    /// Actor who triggered the workflow
    pub actor: ActorContext,
    /// Partition ID
    pub partition_key: String,
    /// Organization ID
    pub organization_id: String,
    /// Platform information (OS, architecture)
    pub platform: PlatformInfo,
}

/// State for loop iteration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopState {
    /// Variable name for the current item in the formula context.
    /// From `LoopConfig.item_var` — e.g. "component" → `loop.component.name`.
    pub item_var: String,
    /// Current item being processed
    pub item: Value,
    /// Current index (0-based)
    pub index: i32,
    /// Total number of items
    pub total: i32,
    /// Whether this is the first item
    pub first: bool,
    /// Whether this is the last item
    pub last: bool,
    /// What the previous pass of a do-while body returned (null before the first, and in for-each loops), so the
    /// loop's condition can read what the body just said (`loop.last_output.held`).
    #[serde(default)]
    pub last_output: Value,
}

// ============================================================================
// TEMPORAL PRIMITIVES
// ============================================================================

/// The 3 irreducible temporal primitives for workflow suspension.
///
/// Every temporal pattern (cron, timeout, deadline, retry, polling, debounce,
/// rate-limiting, etc.) is derived from combinations of these 3 variants.
/// There is no 4th primitive — this is a closed set.
///
/// # The 3 Irreducible Foundations
///
/// - **T1 `Until`** — Suspend until absolute wall-clock time. The foundation:
///   `Duration` is syntactic sugar (converted to `Until(now + d)` at execution).
///   Absolute time survives process crashes; a duration offset does not.
///
/// - **T2 `Event`** — Suspend until a matching event arrives.
///   The only way to react to the external world. Already implemented as EventPoller.
///
/// - **T3 `Race`** — Suspend on multiple conditions simultaneously.
///   First to resolve wins, others are cancelled. This is the composition
///   primitive: without it, every complex temporal pattern requires ad-hoc polling.
///
/// # Derivation Examples
///
/// ```text
/// sleep(d)          = wait_until(now() + d)                          [T1]
/// cron(expr)        = loop { wait_until(next(expr)); work() }         [T1]
/// timeout(act, d)   = race([act_as_event, wait_until(now() + d)])     [T1+T3]
/// deadline(act, dt) = race([act_as_event, wait_until(dt)])            [T1+T3]
/// retry(act, pol)   = loop { try act; wait_until(now()+backoff) }     [T1]
/// poll(check, d)    = loop { if check() break; wait_until(now()+d) }  [T1]
/// ```
///
/// # Serde Format
///
/// Uses `#[serde(tag = "type", rename_all = "snake_case")]` so JSON looks like:
/// `{ "type": "until", "datetime": "2026-03-01T09:00:00Z" }`
/// `{ "type": "duration", "secs": 60 }`
/// `{ "type": "event", "event_type": "payment.received" }`
/// `{ "type": "race", "conditions": [...] }`
///
/// # Backward Compatibility
///
/// Legacy `{ "duration_secs": N }` input format is handled by
/// `parse_wait_condition()` in `automation.rs` — not by this enum's Deserialize impl.
/// This keeps the enum clean while preserving backward compatibility at the executor layer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WaitCondition {
    /// T1: Suspend until absolute wall-clock time (ISO 8601 / RFC 3339).
    ///
    /// This is the foundational temporal primitive. All duration-based waits
    /// are converted to `Until` at execution time, ensuring the target time
    /// is persisted durably and survives process restarts.
    Until {
        /// ISO 8601 / RFC 3339 datetime string, e.g. "2026-03-01T09:00:00Z"
        datetime: String,
    },

    /// T1 convenience: Suspend for N seconds.
    ///
    /// Converted to `Until(now() + secs)` at execution for durability.
    /// Stored as-is in workflow definitions for human readability.
    Duration {
        /// Number of seconds to wait (no global cap — per-step responsibility)
        secs: u64,
    },

    /// T2: Suspend until a matching event arrives.
    ///
    /// Leverages the existing EventPoller infrastructure. The step suspends
    /// until an event with matching kind (and optional filter) is
    /// written to the EventStore.
    Event {
        /// Event type to match (e.g., "payment.received", "inventory.restocked")
        event_type: String,
        /// Optional JSON filter applied against the event payload.
        /// If None, any event with matching event_type resolves the wait.
        #[serde(skip_serializing_if = "Option::is_none")]
        filter: Option<serde_json::Value>,
    },

    /// T3: Suspend on multiple conditions simultaneously.
    ///
    /// Evaluates all child conditions concurrently. The first to resolve wins;
    /// all others are cancelled. Returns the winner index (0-based) and its result.
    ///
    /// This is the composition primitive. Common patterns:
    /// - `race([event, duration])` → timeout pattern
    /// - `race([event, until(deadline)])` → deadline pattern
    /// - `race([event_a, event_b])` → first-of-N events
    Race {
        /// Conditions to evaluate concurrently. Must have at least 2 elements.
        conditions: Vec<WaitCondition>,
    },
}

// ============================================================================
// REQUEST/RESPONSE TYPES
// ============================================================================

/// Request to create a new workflow definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkflowRequest {
    /// Optional custom ID (ULID generated if not provided)
    pub id: Option<EntityId>,
    /// Partition to create workflow in
    pub partition_key: PartitionId,
    /// Human-readable name
    pub name: String,
    /// Description
    pub description: String,
    /// Trigger type
    pub trigger_type: TriggerType,
    /// Trigger source (event_type or cron expression)
    pub trigger_source: String,
    /// Whether to activate immediately
    pub is_active: bool,
    /// Steps to include
    pub steps: Vec<CreateStepRequest>,
}

/// Request to create a workflow step
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateStepRequest {
    /// Step type
    pub step_type: String,
    /// Action ID (for action steps)
    pub definition_id: Option<EntityId>,
    /// Input template
    pub inputs: Value,
    /// Branch conditions
    pub conditions: Option<Value>,
    /// Parent branch
    pub parent_branch: Option<String>,
    /// Loop configuration
    pub loop_config: Option<LoopConfig>,
}

/// Request to create a new definition (matches Task 42 data model)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDefinitionRequest {
    /// Optional custom ID (entity ID, e.g., "action:editor:myAction")
    pub id: Option<EntityId>,
    /// Partition to create action in
    pub partition_key: PartitionId,
    /// Human-readable name / slug
    pub name: String,
    /// Description of what the action does
    pub description: String,
    /// JSON Schema for validating inputs
    pub input_schema: Value,
    /// Ordered sequence of workflow steps
    pub steps: Vec<Step>,
    /// Whether to activate immediately
    pub is_active: bool,
}

/// Request to trigger a workflow manually
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerWorkflowRequest {
    /// Workflow definition ID
    pub workflow_id: EntityId,
    /// Input data (becomes trigger.payload)
    pub input: Value,
    /// Actor context
    pub actor: ActorContext,
}

/// Query parameters for listing workflows
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkflowQuery {
    /// Filter by partition
    pub partition_key: Option<PartitionId>,
    /// Filter by active status
    pub is_active: Option<bool>,
    /// Filter by trigger type
    pub trigger_type: Option<TriggerType>,
    /// Pagination limit
    pub limit: Option<u32>,
    /// Pagination offset
    pub offset: Option<u32>,
}

/// Query parameters for listing workflow instances
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstanceQuery {
    /// Filter by partition
    pub partition_key: Option<PartitionId>,
    /// Filter by workflow definition
    pub workflow_id: Option<EntityId>,
    /// Filter by status
    pub status: Option<ExecutionStatus>,
    /// Pagination limit
    pub limit: Option<u32>,
    /// Pagination offset
    pub offset: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_action(id: &str, steps: Vec<Step>) -> Definition {
        Definition {
            id: id.to_string(),
            partition_key: "partition:test".to_string(),
            name: id.to_string(),
            description: format!("Test action {}", id),
            input_schema: json!({}),
            steps,
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        }
    }

    #[test]
    fn test_empty_workflow_steps_is_valid() {
        let action = make_action("action:noop", vec![]);

        assert!(action.steps.is_empty());

        let json = serde_json::to_value(&action).expect("serialize");
        assert_eq!(json["steps"].as_array().expect("array").len(), 0);

        let parsed: Definition = serde_json::from_value(json).expect("deserialize empty steps");
        assert!(parsed.steps.is_empty());
    }

    #[test]
    fn definition_tolerates_null_trigger_metadata() {
        let parsed: Definition = serde_json::from_value(json!({
            "id": "action:research-add",
            "partition_key": "runtime-partition",
            "kind": "workflow-definition",
            "name": "research-add",
            "description": "Adds a research item.",
            "input_schema": {},
            "steps": [],
            "edges": [],
            "trigger_type": null,
            "trigger_source": null,
            "is_active": true,
            "version": 1,
            "extra": {},
            "extra_properties": {}
        }))
        .expect("null trigger metadata decodes as defaults");

        assert_eq!(parsed.trigger_type, TriggerType::Manual);
        assert_eq!(parsed.trigger_source, "");
    }

    #[test]
    fn definition_defaults_missing_active_state_to_active() {
        let parsed: Definition = serde_json::from_value(json!({
            "id": "action:enrich-link-preview",
            "partition_key": "runtime-partition",
            "kind": "action",
            "name": "enrich-link-preview",
            "description": "Build a link preview.",
            "input_schema": {},
            "steps": []
        }))
        .expect("missing is_active decodes as active");

        assert!(parsed.is_active);

        let inactive: Definition = serde_json::from_value(json!({
            "id": "action:inactive",
            "partition_key": "runtime-partition",
            "kind": "action",
            "name": "inactive",
            "description": "Inactive action.",
            "input_schema": {},
            "steps": [],
            "is_active": false
        }))
        .expect("explicit false decodes");

        assert!(!inactive.is_active);
    }

    #[test]
    fn test_plain_workflow_step_kinds_roundtrip() {
        let steps = vec![
            Step::read(serde_json::json!("state::definition::records")).with_id("read_definitions"),
            Step::ask(
                "test-query-target",
                serde_json::json!({
                    "operation": "test-query",
                    "in": "test:item",
                    "select": ["item_id", "content"],
                    "where": {
                        "all": [
                            {"field": "kind", "eq": "example"},
                            {"field": "item_id", "eq": "item:test"}
                        ]
                    }
                }),
            )
            .with_id("ask_example"),
            Step::ask(
                "compute.process",
                serde_json::json!({"argv": ["./tool", "--version"]}),
            )
            .with_id("run_tool"),
            Step::write(serde_json::json!([
                {
                    "address": "record:item|item:test",
                    "path": ["content"],
                    "payload": {"content": "abc123"}
                }
            ]))
            .with_id("record_hash"),
        ];

        let json = serde_json::to_string(&steps).expect("serialize");
        let parsed: Vec<Step> = serde_json::from_str(&json).expect("deserialize");

        assert!(parsed[0].is_read());
        assert_eq!(
            parsed[0].from(),
            &serde_json::json!("state::definition::records")
        );

        assert!(parsed[1].is_ask());
        assert_eq!(parsed[1].name(), Some("test-query-target"));
        assert_eq!(parsed[1].input()["operation"], "test-query");

        assert!(parsed[2].is_ask());
        assert_eq!(parsed[2].name(), Some("compute.process"));

        assert!(parsed[3].is_write());
        assert_eq!(parsed[3].items()[0]["address"], "record:item|item:test");
    }

    #[test]
    fn test_definition_roundtrip() {
        let original = Definition {
            id: "action:editor:set_property".to_string(),
            partition_key: "partition:genesis".to_string(),
            name: "setProperty".to_string(),
            description: "Sets a property on the selected node".to_string(),
            input_schema: serde_json::json!({"target_property": "string"}),
            steps: vec![Step::write(serde_json::json!([{
                "address": "record:item|item:test",
                "path": ["content"],
                "payload": {"content": "{{input.target_property}}"}
            }]))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };

        // First roundtrip
        let json1 = serde_json::to_string(&original).expect("serialize 1");
        let parsed: Definition = serde_json::from_str(&json1).expect("deserialize");

        // Verify structural equality
        assert_eq!(original, parsed);

        // Second roundtrip — output must be identical
        let json2 = serde_json::to_string(&parsed).expect("serialize 2");
        assert_eq!(json1, json2, "roundtrip must produce identical JSON");
    }

    #[test]
    fn test_load_plain_database_format() {
        let db_json = serde_json::json!({
            "id": "action:example:query",
            "partition_key": "partition:genesis",
            "name": "queryExample",
            "description": "Queries matching example rows",
            "input_schema": {"item_id": "string"},
            "steps": [
                {
                    "kind": "ask",
                    "config": {
                        "name": "test-query-target",
                        "input": {
                            "operation": "test-query",
                            "in": "test:item",
                            "select": ["item_id", "content_hash"],
                            "where": {
                                "all": [
                                    {"field": "kind", "eq": "example"},
                                    {"field": "item_id", "eq": "{{input.item_id}}"}
                                ]
                            }
                        }
                    }
                }
            ],
            "is_active": true
        });

        let action: Definition =
            serde_json::from_value(db_json).expect("plain definition must parse");

        assert_eq!(action.id, "action:example:query");
        assert_eq!(action.name, "queryExample");
        assert_eq!(action.steps.len(), 1);
        assert!(action.steps[0].is_ask());
        assert_eq!(action.steps[0].name(), Some("test-query-target"));
    }

    #[test]
    fn test_legacy_step_type_still_promotes_to_kind() {
        let db_json = serde_json::json!({
            "id": "action:test:legacy",
            "partition_key": "partition:test",
            "name": "legacy",
            "description": "Legacy step_type shape",
            "input_schema": {},
            "steps": [
                {
                    "step_type": "ask",
                    "name": "compute.process",
                    "input": {"argv": ["./tool", "--version"]}
                }
            ],
            "is_active": true
        });

        let action: Definition =
            serde_json::from_value(db_json).expect("legacy step_type must parse");
        assert_eq!(action.steps.len(), 1);
        assert!(action.steps[0].is_ask());
        assert_eq!(action.steps[0].name(), Some("compute.process"));
    }

    #[test]
    fn test_legacy_primitive_shape_is_rejected() {
        let db_json = serde_json::json!({
            "id": "action:test:legacy-primitive",
            "partition_key": "partition:test",
            "name": "legacyPrimitive",
            "description": "Deleted primitive shape",
            "input_schema": {},
            "steps": [
                {"primitive": "_transact", "params": {"operation": "set_focus"}}
            ],
            "is_active": true
        });

        let err = serde_json::from_value::<Definition>(db_json)
            .expect_err("legacy primitive shape must fail");
        assert!(err
            .to_string()
            .contains("Step must have 'kind' or 'step_type' field"));
    }

    #[test]
    fn test_create_definition_request_new_model() {
        let request = CreateDefinitionRequest {
            id: Some("action:custom:myAction".to_string()),
            partition_key: "partition:genesis".to_string(),
            name: "myAction".to_string(),
            description: "Custom user action".to_string(),
            input_schema: serde_json::json!({"value": "string"}),
            steps: vec![Step::write(serde_json::json!([{
                "address": "record:item|item:test",
                "path": ["content"],
                "payload": {"content": "{{input.value}}"}
            }]))],
            is_active: true,
        };

        let json = serde_json::to_value(&request).expect("serialize");
        assert_eq!(json["id"], "action:custom:myAction");
        assert_eq!(json["is_active"], true);

        let steps = json["steps"].as_array().expect("array");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["kind"], "write");
    }

    #[test]
    fn test_definition_complex_binding_ast() {
        let action = Definition {
            id: "action:editor:set_property".to_string(),
            partition_key: "partition:genesis".to_string(),
            name: "setProperty".to_string(),
            description: "Sets a property on the selected node via plain write".to_string(),
            input_schema: serde_json::json!({"target_property": "string"}),
            steps: vec![Step::write(serde_json::json!([{
                "address": {"$kind": "binding", "select": {"from": "state", "path": "selected_node"}},
                "path": [{"$kind": "binding", "select": {"from": "payload", "path": "target_property"}}],
                "payload": {
                    "content": {"$kind": "binding", "select": {"from": "event", "path": "value"}}
                }
            }]))],
            is_active: true,
            extra_properties: Default::default(),
            ..Default::default()
        };

        // Roundtrip must preserve binding AST structure
        let json = serde_json::to_string(&action).expect("serialize");
        let parsed: Definition = serde_json::from_str(&json).expect("deserialize");

        let binding = &parsed.steps[0].items()[0]["address"];
        assert_eq!(binding["$kind"], "binding");
        assert_eq!(binding["select"]["from"], "state");
        assert_eq!(binding["select"]["path"], "selected_node");
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn test_platform_info_populated() {
        let params = ContextualParams::default();
        assert!(
            !params.platform.os.is_empty(),
            "platform.os must not be empty"
        );
        assert!(
            !params.platform.arch.is_empty(),
            "platform.arch must not be empty"
        );
    }

    #[test]
    fn test_platform_info_serializes_to_context() {
        let params = ContextualParams::default();
        let json = serde_json::to_value(&params).unwrap();
        assert!(json["platform"]["os"].is_string());
        assert!(json["platform"]["arch"].is_string());
    }
}
