use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

pub const FORMULA_QUERY_PROTOCOL_VERSION: u16 = 1;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FormulaOperation {
    Analyze,
    Evaluate,
    Capabilities,
    ProjectSource,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormulaDiagnosticSeverity {
    Incomplete,
    Error,
    Warning,
    Info,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FormulaDependencyKind {
    Variable,
    Entity,
    Special,
    Function,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormulaCompletionState {
    Ready,
    Empty,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FormulaCompletionGroup {
    Functions,
    Variables,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FormulaCompletionKind {
    Function,
    Variable,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormulaLegacyProjectionState {
    Available,
    NeedsConversion,
    Unavailable,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum FormulaQueryRequest {
    Analyze(FormulaAnalyzeRequest),
    Evaluate(FormulaEvaluateRequest),
    Capabilities(FormulaCapabilitiesRequest),
    ProjectSource(FormulaProjectSourceRequest),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormulaAnalyzeRequest {
    pub protocol_version: u16,
    pub expression: String,
    pub cursor_offset_utf16: u32,
    pub request_token: String,
    pub source_revision: String,
    pub catalog_revision: String,
    pub registry_revision: String,
    pub expected_policy_revision: String,
    pub variables: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormulaEvaluateRequest {
    pub protocol_version: u16,
    pub expression: String,
    pub cursor_offset_utf16: u32,
    pub request_token: String,
    pub source_revision: String,
    pub catalog_revision: String,
    pub registry_revision: String,
    pub expected_policy_revision: String,
    pub variables: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormulaCapabilitiesRequest {
    pub protocol_version: u16,
    pub request_token: String,
    pub source_revision: String,
    pub catalog_revision: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub registry_revision: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub expected_policy_revision: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormulaProjectSourceRequest {
    pub protocol_version: u16,
    pub request_token: String,
    pub source_revision: String,
    pub catalog_revision: String,
    pub registry_revision: String,
    pub expected_policy_revision: String,
    pub legacy_request: Map<String, Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct FormulaSourceSpan {
    pub start_utf16: u32,
    pub end_utf16: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaDiagnostic {
    pub code: String,
    pub severity: FormulaDiagnosticSeverity,
    pub span: FormulaSourceSpan,
    pub title: String,
    pub cause: String,
    pub repair: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaDependency {
    pub kind: FormulaDependencyKind,
    pub name: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub span: Option<FormulaSourceSpan>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaEvaluationReadSet {
    pub variables: Vec<FormulaVariableRead>,
    pub entities: Vec<String>,
    pub specials: Vec<String>,
    pub functions: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaVariableRead {
    pub binding_key: String,
    pub root_name: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub span: Option<FormulaSourceSpan>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaCompletionItem {
    pub id: String,
    pub group: FormulaCompletionGroup,
    pub kind: FormulaCompletionKind,
    pub category: String,
    pub label: String,
    pub detail: String,
    pub insertion_text: String,
    pub replacement_span: FormulaSourceSpan,
    pub post_insert_caret_utf16: u32,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub signature: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub summary: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaCompletionContext {
    pub state: FormulaCompletionState,
    pub replacement_span: FormulaSourceSpan,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub active_argument: Option<u32>,
    pub items: Vec<FormulaCompletionItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaFunctionDescriptor {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub category: String,
    pub signature: String,
    pub summary: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormulaEvaluation {
    pub result: Value,
    pub evaluation_readset: FormulaEvaluationReadSet,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaLegacyProjection {
    pub state: FormulaLegacyProjectionState,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub expression: Option<String>,
    pub explanation: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FormulaQueryReply {
    pub protocol_version: u16,
    pub operation: FormulaOperation,
    pub request_token: String,
    pub source_revision: String,
    pub catalog_revision: String,
    pub registry_revision: String,
    pub policy_revision: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub source: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub canonical_expression: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub completion: Option<FormulaCompletionContext>,
    pub static_dependencies: Vec<FormulaDependency>,
    pub diagnostics: Vec<FormulaDiagnostic>,
    pub functions: Vec<FormulaFunctionDescriptor>,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub evaluation: Option<FormulaEvaluation>,
    #[serde(deserialize_with = "deserialize_present_option")]
    pub legacy_projection: Option<FormulaLegacyProjection>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormulaQueryPolicyKind {
    #[serde(rename = "formula-query-policy")]
    FormulaQueryPolicy,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaQueryPolicyEnvelope {
    pub kind: FormulaQueryPolicyKind,
    pub schema_version: u16,
    pub revision: String,
    pub limits: FormulaQueryPolicy,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FormulaQueryPolicy {
    pub max_source_utf16: u32,
    pub max_variables: u32,
    pub max_static_dependencies: u32,
    pub max_completion_items: u32,
    pub max_diagnostics: u32,
    pub max_preview_bytes: u32,
    pub max_solver_steps: u32,
    pub widening_after_steps: u32,
    pub max_traversal_depth: u32,
}

impl FormulaQueryPolicyEnvelope {
    pub fn validate(&self) -> Result<(), String> {
        if self.kind != FormulaQueryPolicyKind::FormulaQueryPolicy {
            return Err("kind must be formula-query-policy".to_string());
        }
        if self.schema_version != 1 {
            return Err("schema_version must be 1".to_string());
        }
        if self.revision.trim().is_empty() {
            return Err("revision must be non-empty".to_string());
        }
        self.limits.validate()
    }
}

impl FormulaQueryPolicy {
    pub fn validate(&self) -> Result<(), String> {
        validate_bound("max_source_utf16", self.max_source_utf16, 1, 1_048_576)?;
        validate_bound("max_variables", self.max_variables, 0, 1_000)?;
        validate_bound(
            "max_static_dependencies",
            self.max_static_dependencies,
            1,
            10_000,
        )?;
        validate_bound("max_completion_items", self.max_completion_items, 1, 500)?;
        validate_bound("max_diagnostics", self.max_diagnostics, 1, 500)?;
        validate_bound("max_preview_bytes", self.max_preview_bytes, 0, 1_048_576)?;
        validate_bound("max_solver_steps", self.max_solver_steps, 1, 1_000_000)?;
        validate_bound("widening_after_steps", self.widening_after_steps, 1, 10_000)?;
        if self.widening_after_steps > self.max_solver_steps {
            return Err("widening_after_steps must not exceed max_solver_steps".to_string());
        }
        validate_bound("max_traversal_depth", self.max_traversal_depth, 1, 128)
    }
}

impl FormulaQueryRequest {
    pub fn validate_transport_guards(&self) -> Result<(), String> {
        match self {
            Self::Analyze(request) => validate_required_guards(
                request.protocol_version,
                &request.request_token,
                &request.source_revision,
                &request.catalog_revision,
                Some(&request.registry_revision),
                Some(&request.expected_policy_revision),
            ),
            Self::Evaluate(request) => validate_required_guards(
                request.protocol_version,
                &request.request_token,
                &request.source_revision,
                &request.catalog_revision,
                Some(&request.registry_revision),
                Some(&request.expected_policy_revision),
            ),
            Self::Capabilities(request) => {
                validate_required_guards(
                    request.protocol_version,
                    &request.request_token,
                    &request.source_revision,
                    &request.catalog_revision,
                    request.registry_revision.as_deref(),
                    request.expected_policy_revision.as_deref(),
                )?;
                if request.registry_revision.as_deref() == Some("")
                    || request.expected_policy_revision.as_deref() == Some("")
                {
                    return Err("optional revisions cannot be blank".to_string());
                }
                Ok(())
            }
            Self::ProjectSource(request) => validate_required_guards(
                request.protocol_version,
                &request.request_token,
                &request.source_revision,
                &request.catalog_revision,
                Some(&request.registry_revision),
                Some(&request.expected_policy_revision),
            ),
        }
    }
}

fn validate_required_guards(
    protocol_version: u16,
    request_token: &str,
    source_revision: &str,
    catalog_revision: &str,
    registry_revision: Option<&str>,
    expected_policy_revision: Option<&str>,
) -> Result<(), String> {
    if protocol_version != FORMULA_QUERY_PROTOCOL_VERSION {
        return Err("protocol_version must be 1".to_string());
    }
    for (name, value) in [
        ("request_token", request_token),
        ("source_revision", source_revision),
        ("catalog_revision", catalog_revision),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{name} must be non-empty"));
        }
    }
    for (name, value) in [
        ("registry_revision", registry_revision),
        ("expected_policy_revision", expected_policy_revision),
    ] {
        if value.is_some_and(|value| value.trim().is_empty()) {
            return Err(format!("{name} must be non-empty when present"));
        }
    }
    Ok(())
}

fn validate_bound(name: &str, value: u32, min: u32, max: u32) -> Result<(), String> {
    if value < min || value > max {
        Err(format!("{name} must be in {min}..={max}"))
    } else {
        Ok(())
    }
}

fn deserialize_present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl Default for FormulaQueryPolicyEnvelope {
    fn default() -> Self {
        Self {
            kind: FormulaQueryPolicyKind::FormulaQueryPolicy,
            schema_version: 1,
            revision: "1".to_string(),
            limits: FormulaQueryPolicy::default(),
        }
    }
}

impl Default for FormulaQueryPolicy {
    fn default() -> Self {
        Self {
            max_source_utf16: 65_536,
            max_variables: 1_000,
            max_static_dependencies: 10_000,
            max_completion_items: 100,
            max_diagnostics: 100,
            max_preview_bytes: 65_536,
            max_solver_steps: 10_000,
            widening_after_steps: 100,
            max_traversal_depth: 64,
        }
    }
}
