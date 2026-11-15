//! Pure human-formula analyze/evaluate/capabilities/project-source protocol.

use crate::compiler::{Compiler, CostAwareOptimizer, ExecutionPlan, InMemoryCache};
use crate::deps::{collect_dependencies_static, DependencyKey};
use crate::rules::registry::RuleRegistry;
use crate::{AstNode, EvaluationContext, Expression, Literal, Solver, SolverBudget, Value};
use formula_ast::lexer::{Lexer, Token, TokenType};
use formula_ast::parser::{ParseError, Parser};
use formula_ast::{
    FormulaAnalyzeRequest, FormulaCapabilitiesRequest, FormulaCompletionContext,
    FormulaCompletionGroup, FormulaCompletionItem, FormulaCompletionKind, FormulaCompletionState,
    FormulaDependency, FormulaDependencyKind, FormulaDiagnostic, FormulaDiagnosticSeverity,
    FormulaEvaluateRequest, FormulaEvaluation, FormulaEvaluationReadSet, FormulaFunctionDescriptor,
    FormulaLegacyProjection, FormulaLegacyProjectionState, FormulaOperation,
    FormulaProjectSourceRequest, FormulaQueryPolicy, FormulaQueryReply, FormulaSourceSpan,
    FormulaVariableRead, FORMULA_QUERY_PROTOCOL_VERSION,
};
use serde_json::{Map, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormulaTraversalDepthError {
    pub limit: u32,
    pub actual: u32,
}

pub fn validate_formula_traversal_depth(
    ast: &AstNode,
    max_traversal_depth: u32,
) -> Result<(), FormulaTraversalDepthError> {
    fn visit(expression: &Expression, limit: u32) -> Result<u32, FormulaTraversalDepthError> {
        let child_depth = match expression {
            Expression::MemberAccess(member) => {
                let depth = visit(&member.object, limit)?.saturating_add(1);
                if depth > limit {
                    return Err(FormulaTraversalDepthError {
                        limit,
                        actual: depth,
                    });
                }
                return Ok(depth);
            }
            Expression::IndexAccess(index) => {
                let depth = visit(&index.array, limit)?.saturating_add(1);
                if depth > limit {
                    return Err(FormulaTraversalDepthError {
                        limit,
                        actual: depth,
                    });
                }
                visit(&index.index, limit)?;
                return Ok(depth);
            }
            Expression::Binary(binary) => {
                visit(&binary.left, limit)?;
                visit(&binary.right, limit)?;
                0
            }
            Expression::Unary(unary) => {
                visit(&unary.expr, limit)?;
                0
            }
            Expression::FunctionCall(call) => {
                for argument in &call.args {
                    visit(argument, limit)?;
                }
                0
            }
            Expression::Lambda(lambda) => {
                visit(&lambda.body, limit)?;
                0
            }
            Expression::Literal(Literal::Array(items)) => {
                for item in items {
                    visit(item, limit)?;
                }
                0
            }
            Expression::Literal(Literal::Object(fields)) => {
                for (_, value) in fields {
                    visit(value, limit)?;
                }
                0
            }
            Expression::Literal(_)
            | Expression::Identifier(_)
            | Expression::VersionedIdentifier { .. } => 0,
        };
        Ok(child_depth)
    }

    match ast {
        AstNode::Expression(expression) => visit(expression, max_traversal_depth).map(|_| ()),
    }
}

pub fn analyze_formula_query(
    request: &FormulaAnalyzeRequest,
    policy: &FormulaQueryPolicy,
    policy_revision: &str,
) -> FormulaQueryReply {
    let registry = RuleRegistry::with_builtin_rules();
    let mut reply = base_reply(
        FormulaOperation::Analyze,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        registry.revision(),
        policy_revision,
    );

    if let Some(diagnostic) = validate_analyze_request(request, policy, &registry) {
        reply.source = Some(request.expression.clone());
        reply.diagnostics.push(diagnostic);
        reply.completion = Some(error_completion(request.cursor_offset_utf16));
        return reply;
    }

    let parsed = parse_authored_formula(&request.expression, policy.max_traversal_depth);
    reply.source = Some(request.expression.clone());
    reply.canonical_expression = parsed.canonical_expression.clone();
    reply.static_dependencies = parsed.static_dependencies;
    reply.diagnostics = parsed.diagnostics;
    enforce_static_dependency_limit(
        &mut reply.static_dependencies,
        &mut reply.diagnostics,
        policy.max_static_dependencies,
        &request.expression,
    );
    reply.completion = Some(completion_context(
        &request.expression,
        request.cursor_offset_utf16,
        &registry,
        &request.variables,
        policy.max_completion_items,
        !reply.diagnostics.is_empty(),
    ));
    truncate_diagnostics(&mut reply.diagnostics, policy.max_diagnostics);
    reply
}

pub fn evaluate_formula_query(
    request: &FormulaEvaluateRequest,
    policy: &FormulaQueryPolicy,
    policy_revision: &str,
) -> FormulaQueryReply {
    let registry = RuleRegistry::with_builtin_rules();
    let mut reply = base_reply(
        FormulaOperation::Evaluate,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        registry.revision(),
        policy_revision,
    );
    reply.source = Some(request.expression.clone());

    if let Some(diagnostic) = validate_evaluate_request(request, policy, &registry) {
        reply.diagnostics.push(diagnostic);
        return reply;
    }

    let parsed = parse_authored_formula(&request.expression, policy.max_traversal_depth);
    reply.canonical_expression = parsed.canonical_expression.clone();
    reply.static_dependencies = parsed.static_dependencies.clone();
    reply.diagnostics = parsed.diagnostics;
    enforce_static_dependency_limit(
        &mut reply.static_dependencies,
        &mut reply.diagnostics,
        policy.max_static_dependencies,
        &request.expression,
    );
    let Some(ast) = parsed.ast else {
        truncate_diagnostics(&mut reply.diagnostics, policy.max_diagnostics);
        return reply;
    };
    if !reply.diagnostics.is_empty() {
        truncate_diagnostics(&mut reply.diagnostics, policy.max_diagnostics);
        return reply;
    }

    let missing_variables: Vec<_> = reply
        .static_dependencies
        .iter()
        .filter(|dependency| dependency.kind == FormulaDependencyKind::Variable)
        .filter(|dependency| !request.variables.contains_key(&dependency.name))
        .collect();
    if let Some(missing) = missing_variables.first() {
        reply.diagnostics.push(diagnostic(
            "binding.missing",
            FormulaDiagnosticSeverity::Error,
            missing
                .span
                .clone()
                .unwrap_or_else(|| whole_source_span(&request.expression)),
            "Missing value",
            format!("No value was supplied for `{}`.", missing.name),
            "Supply the referenced value before evaluating.",
        ));
        return reply;
    }

    for function in reply
        .static_dependencies
        .iter()
        .filter(|dependency| dependency.kind == FormulaDependencyKind::Function)
    {
        if registry.get(&function.name).is_none() {
            reply.diagnostics.push(diagnostic(
                "function.unknown",
                FormulaDiagnosticSeverity::Error,
                function
                    .span
                    .clone()
                    .unwrap_or_else(|| whole_source_span(&request.expression)),
                "Unknown function",
                format!(
                    "`{}` is not in the Formula function registry.",
                    function.name
                ),
                "Choose a function returned by capabilities.",
            ));
            return reply;
        }
    }

    let readset = collect_bound_formula_reads(&ast, &request.expression, &request.variables);
    match evaluate_formula_query_with_readset(&ast, &request.variables, policy, readset) {
        Ok(evaluation) => {
            let preview_bytes = serde_json::to_vec(&evaluation.result)
                .map(|bytes| bytes.len())
                .unwrap_or(usize::MAX);
            if policy.max_preview_bytes == 0 || preview_bytes > policy.max_preview_bytes as usize {
                reply.diagnostics.push(diagnostic(
                    "preview.suppressed",
                    FormulaDiagnosticSeverity::Warning,
                    whole_source_span(&request.expression),
                    "Result preview suppressed",
                    format!(
                        "The serialized result uses {preview_bytes} bytes; the owner preview limit is {}.",
                        policy.max_preview_bytes
                    ),
                    "Increase the owner preview limit or return a smaller value.",
                ));
            } else {
                reply.evaluation = Some(evaluation);
            }
        }
        Err((code, cause)) => reply.diagnostics.push(diagnostic(
            code,
            FormulaDiagnosticSeverity::Error,
            whole_source_span(&request.expression),
            "Formula could not be evaluated",
            cause,
            "Review the formula and its supplied values.",
        )),
    }
    truncate_diagnostics(&mut reply.diagnostics, policy.max_diagnostics);
    reply
}

pub fn formula_capabilities(
    request: &FormulaCapabilitiesRequest,
    policy: &FormulaQueryPolicy,
    policy_revision: &str,
) -> FormulaQueryReply {
    let registry = RuleRegistry::with_builtin_rules();
    let mut reply = base_reply(
        FormulaOperation::Capabilities,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        registry.revision(),
        policy_revision,
    );
    if let Some(diagnostic) = validate_capabilities_request(request, policy, &registry) {
        reply.diagnostics.push(diagnostic);
        return reply;
    }
    reply.functions = registry.function_descriptors();
    reply
}

pub fn project_formula_source(
    request: &FormulaProjectSourceRequest,
    policy: &FormulaQueryPolicy,
    policy_revision: &str,
) -> FormulaQueryReply {
    let registry = RuleRegistry::with_builtin_rules();
    let mut reply = base_reply(
        FormulaOperation::ProjectSource,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        registry.revision(),
        policy_revision,
    );
    if let Some(diagnostic) = validate_project_source_request(request, policy, &registry) {
        reply.diagnostics.push(diagnostic);
        return reply;
    }

    reply.legacy_projection = Some(project_legacy_request(
        &request.legacy_request,
        policy.max_traversal_depth,
    ));
    reply
}

pub fn collect_bound_formula_reads(
    ast: &AstNode,
    authored_source: &str,
    variables: &Map<String, JsonValue>,
) -> FormulaEvaluationReadSet {
    let mut roots = Vec::new();
    match ast {
        AstNode::Expression(expression) => {
            collect_variable_roots(expression, &mut vec![BTreeSet::new()], &mut roots)
        }
    }

    let token_index = source_token_index(authored_source);
    let mut root_counts = BTreeMap::<String, usize>::new();
    for root in &roots {
        *root_counts.entry(root.clone()).or_default() += 1;
    }
    let mut source_spans = BTreeMap::<String, Vec<FormulaSourceSpan>>::new();
    for token in &token_index {
        if let TokenType::Identifier(name) = &token.token.token_type {
            source_spans
                .entry(name.clone())
                .or_default()
                .push(token.span.clone());
        }
    }
    let mut used = BTreeMap::<String, usize>::new();
    let mut variable_reads = Vec::new();
    for root in roots {
        if !variables.contains_key(&root) {
            continue;
        }
        let spans = source_spans.get(&root);
        let span = if spans.map(Vec::len) == root_counts.get(&root).copied() {
            let index = used.entry(root.clone()).or_default();
            let span = spans.and_then(|items| items.get(*index)).cloned();
            *index += 1;
            span
        } else {
            None
        };
        variable_reads.push(FormulaVariableRead {
            binding_key: root.clone(),
            root_name: root,
            span,
        });
    }
    variable_reads.sort_by(|left, right| {
        (&left.binding_key, &left.root_name, &left.span).cmp(&(
            &right.binding_key,
            &right.root_name,
            &right.span,
        ))
    });
    variable_reads.dedup();

    let dependencies = collect_dependencies_static(ast);
    let mut entities = BTreeSet::new();
    for value in variables.values() {
        collect_entity_refs(value, &mut entities);
    }
    FormulaEvaluationReadSet {
        variables: variable_reads,
        entities: entities.into_iter().collect(),
        specials: dependencies
            .iter()
            .filter_map(|dependency| match dependency {
                DependencyKey::Special(name) => Some(name.clone()),
                _ => None,
            })
            .collect(),
        functions: dependencies
            .iter()
            .filter_map(|dependency| match dependency {
                DependencyKey::Func(name) => Some(name.to_uppercase()),
                _ => None,
            })
            .collect(),
    }
}

pub fn evaluate_formula_query_with_readset(
    ast: &AstNode,
    variables: &Map<String, JsonValue>,
    policy: &FormulaQueryPolicy,
    evaluation_readset: FormulaEvaluationReadSet,
) -> Result<FormulaEvaluation, (&'static str, String)> {
    let mut context = EvaluationContext::new();
    for (name, value) in variables {
        context.set_variable(name.clone(), Value::from(value.clone()));
    }
    context.set_max_traversal_depth(policy.max_traversal_depth as usize);
    context
        .validate_context()
        .map_err(|errors| ("context.invalid", format!("{errors:?}")))?;

    let compiler = Compiler::new(
        Box::new(InMemoryCache::new()),
        CostAwareOptimizer::new(Vec::new(), 1_000),
    );
    let plan = compiler
        .compile(ast, &context)
        .map_err(|error| ("compile.failed", error.to_string()))?;
    let mut manifold = match plan {
        ExecutionPlan::Manifold(manifold) => manifold,
        ExecutionPlan::Bytecode(_) => {
            return Err((
                "compile.cache_unsupported",
                "The human query path requires a manifold execution plan.".to_string(),
            ))
        }
    };
    let mut solver = Solver::new();
    let result = solver
        .solve_with_budget(
            &mut manifold,
            &context,
            SolverBudget {
                max_steps: policy.max_solver_steps,
                widening_after_steps: policy.widening_after_steps,
            },
        )
        .map_err(|error| {
            let code = if error.contains("budget_exhausted") {
                "budget_exhausted"
            } else {
                "solve.failed"
            };
            (code, error)
        })?;
    Ok(FormulaEvaluation {
        result: result.value.into_inner(),
        evaluation_readset,
    })
}

fn parse_authored_formula(source: &str, max_traversal_depth: u32) -> ParsedFormula {
    if source.trim().is_empty() {
        return ParsedFormula {
            ast: Some(AstNode::Expression(Expression::Literal(Literal::Null))),
            canonical_expression: None,
            static_dependencies: Vec::new(),
            diagnostics: Vec::new(),
        };
    }

    let token_index = source_token_index(source);
    let formula_markers: Vec<_> = token_index
        .iter()
        .filter(|token| token.token.token_type == TokenType::FormulaStart)
        .collect();
    if formula_markers.len() > 1 {
        return ParsedFormula::failure(diagnostic(
            "syntax.duplicate_start",
            FormulaDiagnosticSeverity::Error,
            formula_markers[1].span.clone(),
            "Extra formula marker",
            "A formula can start with `=` only once.",
            "Remove the extra `=`.",
        ));
    }
    if formula_markers.len() == 1
        && token_index.iter().all(|token| {
            matches!(
                token.token.token_type,
                TokenType::FormulaStart | TokenType::Eof
            )
        })
    {
        return ParsedFormula::failure(diagnostic(
            "syntax.incomplete",
            FormulaDiagnosticSeverity::Incomplete,
            formula_markers[0].span.clone(),
            "Keep typing",
            "The formula marker has no expression yet.",
            "Type a value, reference, or function after `=`.",
        ));
    }

    let mut parser = Parser::new();
    let ast = match parser.parse(source) {
        Ok(ast) => ast,
        Err(error) => {
            let span = parse_error_span(source, &error, &token_index);
            return ParsedFormula::failure(diagnostic(
                "syntax.invalid",
                FormulaDiagnosticSeverity::Error,
                span,
                "Formula syntax needs attention",
                error.to_string(),
                "Correct the highlighted expression.",
            ));
        }
    };

    if let Err(errors) = ast.validate_with(&formula_ast::ValidationConfig::default(), None) {
        return ParsedFormula::failure(diagnostic(
            "ast.depth_exceeded",
            FormulaDiagnosticSeverity::Error,
            whole_source_span(source),
            "Formula is too deeply nested",
            format!("{errors:?}"),
            "Reduce nested expression depth.",
        ));
    }
    if let Err(error) = validate_formula_traversal_depth(&ast, max_traversal_depth) {
        return ParsedFormula::failure(diagnostic(
            "traversal_depth_exceeded",
            FormulaDiagnosticSeverity::Error,
            nth_access_span(source, error.actual).unwrap_or_else(|| whole_source_span(source)),
            "Reference is too deeply nested",
            format!(
                "Traversal depth {} exceeds the owner limit {}.",
                error.actual, error.limit
            ),
            "Use a shallower member or index path.",
        ));
    }

    let dependencies = static_dependencies(&ast, source, &token_index);
    ParsedFormula {
        canonical_expression: Some(format!("={ast}")),
        ast: Some(ast),
        static_dependencies: dependencies,
        diagnostics: Vec::new(),
    }
}

fn validate_analyze_request(
    request: &FormulaAnalyzeRequest,
    policy: &FormulaQueryPolicy,
    registry: &RuleRegistry,
) -> Option<FormulaDiagnostic> {
    validate_common(
        request.protocol_version,
        &request.expression,
        request.cursor_offset_utf16,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        &request.registry_revision,
        &request.expected_policy_revision,
        policy,
        registry,
    )
    .or_else(|| validate_variable_bindings(&request.expression, &request.variables, policy))
}

fn validate_evaluate_request(
    request: &FormulaEvaluateRequest,
    policy: &FormulaQueryPolicy,
    registry: &RuleRegistry,
) -> Option<FormulaDiagnostic> {
    validate_common(
        request.protocol_version,
        &request.expression,
        request.cursor_offset_utf16,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        &request.registry_revision,
        &request.expected_policy_revision,
        policy,
        registry,
    )
    .or_else(|| validate_variable_bindings(&request.expression, &request.variables, policy))
}

fn validate_variable_bindings(
    expression: &str,
    variables: &Map<String, JsonValue>,
    policy: &FormulaQueryPolicy,
) -> Option<FormulaDiagnostic> {
    if variables.len() > policy.max_variables as usize {
        return Some(diagnostic(
            "variables.limit_exceeded",
            FormulaDiagnosticSeverity::Error,
            whole_source_span(expression),
            "Too many supplied values",
            format!(
                "{} values exceed the owner limit {}.",
                variables.len(),
                policy.max_variables
            ),
            "Remove unused supplied values.",
        ));
    }
    variables
        .keys()
        .find(|name| !EvaluationContext::is_valid_variable_name(name))
        .map(|name| {
            diagnostic(
                "variables.invalid_name",
                FormulaDiagnosticSeverity::Error,
                whole_source_span(expression),
                "A supplied value has an invalid name",
                format!("{name:?} cannot be written as a Formula variable."),
                "Supply values with names that start with a letter or underscore and contain only letters, numbers, or underscores.",
            )
        })
}

#[allow(clippy::too_many_arguments)]
fn validate_common(
    protocol_version: u16,
    expression: &str,
    cursor_offset_utf16: u32,
    request_token: &str,
    source_revision: &str,
    catalog_revision: &str,
    registry_revision: &str,
    expected_policy_revision: &str,
    policy: &FormulaQueryPolicy,
    registry: &RuleRegistry,
) -> Option<FormulaDiagnostic> {
    let source_span = whole_source_span(expression);
    let invalid = if protocol_version != FORMULA_QUERY_PROTOCOL_VERSION {
        Some(("protocol.version", "protocol_version must be 1"))
    } else if request_token.trim().is_empty() {
        Some(("request.token", "request_token must be non-empty"))
    } else if source_revision.trim().is_empty() {
        Some((
            "request.source_revision",
            "source_revision must be non-empty",
        ))
    } else if catalog_revision.trim().is_empty() {
        Some((
            "request.catalog_revision",
            "catalog_revision must be non-empty",
        ))
    } else if registry_revision.trim().is_empty() {
        Some((
            "request.registry_revision",
            "registry_revision must be non-empty",
        ))
    } else if expected_policy_revision.trim().is_empty() {
        Some((
            "request.policy_revision",
            "expected_policy_revision must be non-empty",
        ))
    } else if expression.encode_utf16().count() > policy.max_source_utf16 as usize {
        Some((
            "source.limit_exceeded",
            "expression exceeds max_source_utf16",
        ))
    } else if cursor_offset_utf16 > expression.encode_utf16().count() as u32 {
        Some((
            "cursor.out_of_bounds",
            "cursor_offset_utf16 is outside expression",
        ))
    } else if registry_revision != registry.revision() {
        Some(("owner.registry_changed", "registry_revision is stale"))
    } else {
        None
    };
    invalid.map(|(code, cause)| {
        diagnostic(
            code,
            FormulaDiagnosticSeverity::Error,
            source_span,
            "Formula request rejected",
            cause,
            "Refresh Formula capabilities and retry with current revisions.",
        )
    })
}

fn validate_capabilities_request(
    request: &FormulaCapabilitiesRequest,
    _policy: &FormulaQueryPolicy,
    registry: &RuleRegistry,
) -> Option<FormulaDiagnostic> {
    let invalid = if request.protocol_version != FORMULA_QUERY_PROTOCOL_VERSION {
        Some(("protocol.version", "protocol_version must be 1"))
    } else if request.request_token.trim().is_empty() {
        Some(("request.token", "request_token must be non-empty"))
    } else if request.source_revision.trim().is_empty() {
        Some((
            "request.source_revision",
            "source_revision must be non-empty",
        ))
    } else if request.catalog_revision.trim().is_empty() {
        Some((
            "request.catalog_revision",
            "catalog_revision must be non-empty",
        ))
    } else if request
        .registry_revision
        .as_deref()
        .is_some_and(str::is_empty)
    {
        Some((
            "request.registry_revision",
            "registry_revision cannot be blank",
        ))
    } else if request
        .expected_policy_revision
        .as_deref()
        .is_some_and(str::is_empty)
    {
        Some((
            "request.policy_revision",
            "expected_policy_revision cannot be blank",
        ))
    } else if request
        .registry_revision
        .as_ref()
        .is_some_and(|revision| revision != &registry.revision())
    {
        Some(("owner.registry_changed", "registry_revision is stale"))
    } else {
        None
    };
    invalid.map(|(code, cause)| {
        diagnostic(
            code,
            FormulaDiagnosticSeverity::Error,
            FormulaSourceSpan {
                start_utf16: 0,
                end_utf16: 0,
            },
            "Capabilities request rejected",
            cause,
            "Retry with a bootstrap capabilities request.",
        )
    })
}

fn validate_project_source_request(
    request: &FormulaProjectSourceRequest,
    policy: &FormulaQueryPolicy,
    registry: &RuleRegistry,
) -> Option<FormulaDiagnostic> {
    validate_common(
        request.protocol_version,
        "",
        0,
        &request.request_token,
        &request.source_revision,
        &request.catalog_revision,
        &request.registry_revision,
        &request.expected_policy_revision,
        policy,
        registry,
    )
}

fn project_legacy_request(
    legacy: &Map<String, JsonValue>,
    max_traversal_depth: u32,
) -> FormulaLegacyProjection {
    if let Some(JsonValue::String(source)) = legacy.get("expression") {
        let parsed = parse_authored_formula(source, max_traversal_depth);
        if parsed.diagnostics.is_empty() {
            return FormulaLegacyProjection {
                state: FormulaLegacyProjectionState::Available,
                expression: parsed.canonical_expression,
                explanation: "This structured formula has an equivalent human formula.".to_string(),
            };
        }
    }
    if let Some(value) = legacy.get("expression") {
        if let Ok(ast) = serde_json::from_value::<AstNode>(value.clone()) {
            if ast
                .validate_with(&formula_ast::ValidationConfig::default(), None)
                .is_ok()
                && validate_formula_traversal_depth(&ast, max_traversal_depth).is_ok()
            {
                return FormulaLegacyProjection {
                    state: FormulaLegacyProjectionState::NeedsConversion,
                    expression: Some(format!("={ast}")),
                    explanation:
                        "A human formula preview is available and requires explicit conversion."
                            .to_string(),
                };
            }
        }
    }
    FormulaLegacyProjection {
        state: FormulaLegacyProjectionState::Unavailable,
        expression: None,
        explanation: "This structured formula cannot be represented as human source.".to_string(),
    }
}

fn base_reply(
    operation: FormulaOperation,
    request_token: &str,
    source_revision: &str,
    catalog_revision: &str,
    registry_revision: String,
    policy_revision: &str,
) -> FormulaQueryReply {
    FormulaQueryReply {
        protocol_version: FORMULA_QUERY_PROTOCOL_VERSION,
        operation,
        request_token: request_token.to_string(),
        source_revision: source_revision.to_string(),
        catalog_revision: catalog_revision.to_string(),
        registry_revision,
        policy_revision: policy_revision.to_string(),
        source: None,
        canonical_expression: None,
        completion: None,
        static_dependencies: Vec::new(),
        diagnostics: Vec::new(),
        functions: Vec::new(),
        evaluation: None,
        legacy_projection: None,
    }
}

fn static_dependencies(
    ast: &AstNode,
    source: &str,
    token_index: &[SourceToken],
) -> Vec<FormulaDependency> {
    let dependencies = collect_dependencies_static(ast);
    let mut result: Vec<_> = dependencies
        .into_iter()
        .map(|dependency| {
            let (kind, name) = match dependency {
                DependencyKey::Var(name) => (FormulaDependencyKind::Variable, name),
                DependencyKey::Entity(name) => (FormulaDependencyKind::Entity, name),
                DependencyKey::Special(name) => (FormulaDependencyKind::Special, name),
                DependencyKey::Func(name) => (FormulaDependencyKind::Function, name.to_uppercase()),
            };
            let matching: Vec<_> = token_index
                .iter()
                .filter(|token| token_matches_dependency(&token.token.token_type, kind, &name))
                .collect();
            FormulaDependency {
                kind,
                name,
                span: (matching.len() == 1).then(|| matching[0].span.clone()),
            }
        })
        .collect();
    if result.len() > 10_000 {
        result.truncate(10_000);
    }
    result.sort_by(|left, right| {
        (&left.kind, &left.name, &left.span).cmp(&(&right.kind, &right.name, &right.span))
    });
    let _ = source;
    result
}

fn token_matches_dependency(token: &TokenType, kind: FormulaDependencyKind, name: &str) -> bool {
    match (kind, token) {
        (
            FormulaDependencyKind::Variable | FormulaDependencyKind::Function,
            TokenType::Identifier(found),
        ) => found.eq_ignore_ascii_case(name),
        (FormulaDependencyKind::Special, TokenType::At) => name == "@",
        (FormulaDependencyKind::Special, TokenType::DoubleAt) => name == "@@",
        (FormulaDependencyKind::Special, TokenType::Scope) => name == "$scope",
        _ => false,
    }
}

fn completion_context(
    source: &str,
    cursor_utf16: u32,
    registry: &RuleRegistry,
    variables: &Map<String, JsonValue>,
    max_items: u32,
    has_error: bool,
) -> FormulaCompletionContext {
    let span = replacement_span(source, cursor_utf16);
    let prefix = utf16_slice(source, span.start_utf16, cursor_utf16).to_uppercase();
    let mut items = registry
        .function_descriptors()
        .into_iter()
        .filter(|descriptor| {
            prefix.is_empty()
                || descriptor.name.to_uppercase().starts_with(&prefix)
                || descriptor
                    .aliases
                    .iter()
                    .any(|alias| alias.to_uppercase().starts_with(&prefix))
        })
        .map(|descriptor| function_completion_item(descriptor, span.clone()))
        .chain(
            variables
                .iter()
                .filter(|(name, _)| {
                    name.as_str() != "$scope"
                        && (prefix.is_empty() || name.to_uppercase().starts_with(&prefix))
                })
                .map(|(name, value)| variable_completion_item(name, value, span.clone())),
        )
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        let left_exact = left.label.to_uppercase().starts_with(&prefix);
        let right_exact = right.label.to_uppercase().starts_with(&prefix);
        (
            !left_exact,
            left.group,
            left.category.as_str(),
            left.label.to_uppercase(),
            left.id.as_str(),
        )
            .cmp(&(
                !right_exact,
                right.group,
                right.category.as_str(),
                right.label.to_uppercase(),
                right.id.as_str(),
            ))
    });
    items.truncate(max_items as usize);
    FormulaCompletionContext {
        state: if has_error {
            FormulaCompletionState::Error
        } else if items.is_empty() {
            FormulaCompletionState::Empty
        } else {
            FormulaCompletionState::Ready
        },
        replacement_span: span,
        active_argument: active_argument(source, cursor_utf16),
        items,
    }
}

fn function_completion_item(
    descriptor: FormulaFunctionDescriptor,
    replacement_span: FormulaSourceSpan,
) -> FormulaCompletionItem {
    let insertion_text = format!("{}(", descriptor.name);
    FormulaCompletionItem {
        id: descriptor.id,
        group: FormulaCompletionGroup::Functions,
        kind: FormulaCompletionKind::Function,
        category: descriptor.category.clone(),
        label: descriptor.name,
        detail: format!("{} · {}", descriptor.category, descriptor.signature),
        post_insert_caret_utf16: replacement_span.start_utf16
            + insertion_text.encode_utf16().count() as u32,
        insertion_text,
        replacement_span,
        signature: Some(descriptor.signature),
        summary: Some(descriptor.summary),
    }
}

fn variable_completion_item(
    name: &str,
    value: &JsonValue,
    replacement_span: FormulaSourceSpan,
) -> FormulaCompletionItem {
    let category = variable_value_category(value);
    let insertion_text = name.to_string();
    FormulaCompletionItem {
        id: stable_variable_completion_id(name),
        group: FormulaCompletionGroup::Variables,
        kind: FormulaCompletionKind::Variable,
        category: category.to_string(),
        label: name.to_string(),
        detail: format!("Available {category} value"),
        post_insert_caret_utf16: replacement_span.start_utf16
            + insertion_text.encode_utf16().count() as u32,
        insertion_text,
        replacement_span,
        signature: None,
        summary: Some(format!("Use the available {category} value named {name}.")),
    }
}

fn variable_value_category(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "empty",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "text",
        JsonValue::Array(_) => "list",
        JsonValue::Object(_) => "object",
    }
}

fn stable_variable_completion_id(name: &str) -> String {
    let mut id = String::with_capacity("formula.variable.".len() + name.len() * 2);
    id.push_str("formula.variable.");
    for byte in name.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(id, "{byte:02x}");
    }
    id
}

fn error_completion(cursor_utf16: u32) -> FormulaCompletionContext {
    FormulaCompletionContext {
        state: FormulaCompletionState::Error,
        replacement_span: FormulaSourceSpan {
            start_utf16: cursor_utf16,
            end_utf16: cursor_utf16,
        },
        active_argument: None,
        items: Vec::new(),
    }
}

fn replacement_span(source: &str, cursor_utf16: u32) -> FormulaSourceSpan {
    let cursor_char = utf16_to_char_offset(source, cursor_utf16);
    let chars: Vec<_> = source.chars().collect();
    let mut start = cursor_char.min(chars.len());
    while start > 0 && (chars[start - 1].is_alphanumeric() || chars[start - 1] == '_') {
        start -= 1;
    }
    let mut end = cursor_char.min(chars.len());
    while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
        end += 1;
    }
    FormulaSourceSpan {
        start_utf16: char_to_utf16(source, start),
        end_utf16: char_to_utf16(source, end),
    }
}

fn active_argument(source: &str, cursor_utf16: u32) -> Option<u32> {
    let cursor = utf16_to_char_offset(source, cursor_utf16);
    let mut depth = 0_u32;
    let mut argument = 0_u32;
    let mut found_call = false;
    for character in source.chars().take(cursor) {
        match character {
            '(' => {
                depth += 1;
                argument = 0;
                found_call = true;
            }
            ')' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    found_call = false;
                }
            }
            ',' if depth > 0 => argument += 1,
            _ => {}
        }
    }
    found_call.then_some(argument)
}

fn collect_variable_roots(
    expression: &Expression,
    locals: &mut Vec<BTreeSet<String>>,
    roots: &mut Vec<String>,
) {
    let is_local = |name: &str, locals: &[BTreeSet<String>]| {
        locals.iter().rev().any(|scope| scope.contains(name))
    };
    match expression {
        Expression::Identifier(name) => {
            if !matches!(name.as_str(), "@" | "@@" | "$scope") && !is_local(name, locals) {
                roots.push(name.clone());
            }
        }
        Expression::VersionedIdentifier { name, .. } => {
            if !is_local(name, locals) {
                roots.push(name.clone());
            }
        }
        Expression::Binary(binary) => {
            collect_variable_roots(&binary.left, locals, roots);
            collect_variable_roots(&binary.right, locals, roots);
        }
        Expression::Unary(unary) => collect_variable_roots(&unary.expr, locals, roots),
        Expression::FunctionCall(call) => {
            for argument in &call.args {
                collect_variable_roots(argument, locals, roots);
            }
        }
        Expression::MemberAccess(member) => collect_variable_roots(&member.object, locals, roots),
        Expression::IndexAccess(index) => {
            collect_variable_roots(&index.array, locals, roots);
            collect_variable_roots(&index.index, locals, roots);
        }
        Expression::Lambda(lambda) => {
            locals.push(lambda.parameters.iter().cloned().collect());
            collect_variable_roots(&lambda.body, locals, roots);
            locals.pop();
        }
        Expression::Literal(Literal::Array(items)) => {
            for item in items {
                collect_variable_roots(item, locals, roots);
            }
        }
        Expression::Literal(Literal::Object(fields)) => {
            for (_, value) in fields {
                collect_variable_roots(value, locals, roots);
            }
        }
        Expression::Literal(_) => {}
    }
}

fn collect_entity_refs(value: &JsonValue, entities: &mut BTreeSet<String>) {
    match value {
        JsonValue::Object(object) => {
            if let Some(JsonValue::String(reference)) = object.get("$ent_ref") {
                entities.insert(reference.clone());
            }
            for value in object.values() {
                collect_entity_refs(value, entities);
            }
        }
        JsonValue::Array(values) => {
            for value in values {
                collect_entity_refs(value, entities);
            }
        }
        _ => {}
    }
}

struct ParsedFormula {
    ast: Option<AstNode>,
    canonical_expression: Option<String>,
    static_dependencies: Vec<FormulaDependency>,
    diagnostics: Vec<FormulaDiagnostic>,
}

impl ParsedFormula {
    fn failure(diagnostic: FormulaDiagnostic) -> Self {
        Self {
            ast: None,
            canonical_expression: None,
            static_dependencies: Vec::new(),
            diagnostics: vec![diagnostic],
        }
    }
}

#[derive(Clone)]
struct SourceToken {
    token: Token,
    span: FormulaSourceSpan,
}

fn source_token_index(source: &str) -> Vec<SourceToken> {
    Lexer::new(source)
        .filter_map(Result::ok)
        .map(|token| {
            let start = token.position.offset;
            let end = token_char_end(source, start, &token.token_type);
            SourceToken {
                span: FormulaSourceSpan {
                    start_utf16: char_to_utf16(source, start),
                    end_utf16: char_to_utf16(source, end),
                },
                token,
            }
        })
        .collect()
}

fn token_char_end(source: &str, start: usize, token: &TokenType) -> usize {
    let fixed = match token {
        TokenType::Eq
        | TokenType::NotEq
        | TokenType::Lte
        | TokenType::Gte
        | TokenType::And
        | TokenType::Or
        | TokenType::Arrow
        | TokenType::DoubleAt
        | TokenType::LBrace => Some(2),
        TokenType::Scope => Some(6),
        TokenType::Eof => Some(0),
        TokenType::Identifier(name) => Some(name.chars().count()),
        _ => None,
    };
    if let Some(length) = fixed {
        return start + length;
    }
    match token {
        TokenType::String(_) => {
            let chars: Vec<_> = source.chars().collect();
            let mut cursor = start + 1;
            let mut escaped = false;
            while cursor < chars.len() {
                let character = chars[cursor];
                cursor += 1;
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    break;
                }
            }
            cursor
        }
        TokenType::Number(_) => {
            source
                .chars()
                .skip(start)
                .take_while(|character| {
                    character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-')
                })
                .count()
                + start
        }
        _ => start + 1,
    }
}

fn parse_error_span(source: &str, error: &ParseError, tokens: &[SourceToken]) -> FormulaSourceSpan {
    let (line, column) = match error {
        ParseError::LexerError(error) => match error {
            formula_ast::lexer::LexerError::UnexpectedCharacter { line, column, .. }
            | formula_ast::lexer::LexerError::UnknownEscapeSequence { line, column, .. }
            | formula_ast::lexer::LexerError::InvalidNumberFormat { line, column, .. }
            | formula_ast::lexer::LexerError::InvalidUnicodeEscapeSequence {
                line, column, ..
            } => (*line, *column),
            formula_ast::lexer::LexerError::UnterminatedStringLiteral {
                start_line,
                start_column,
            }
            | formula_ast::lexer::LexerError::UnterminatedBlockComment {
                start_line,
                start_column,
            } => (*start_line, *start_column),
        },
        ParseError::UnexpectedToken { line, column, .. }
        | ParseError::UnexpectedEof { line, column }
        | ParseError::InvalidLiteral { line, column, .. }
        | ParseError::InvalidFunction { line, column } => (*line, *column),
        ParseError::MultipleErrors { errors } => {
            return errors
                .first()
                .map(|error| parse_error_span(source, error, tokens))
                .unwrap_or_else(|| whole_source_span(source))
        }
    };
    tokens
        .iter()
        .find(|token| token.token.position.line == line && token.token.position.column == column)
        .map(|token| token.span.clone())
        .unwrap_or_else(|| {
            let start = line_column_to_char_offset(source, line, column);
            FormulaSourceSpan {
                start_utf16: char_to_utf16(source, start),
                end_utf16: char_to_utf16(source, (start + 1).min(source.chars().count())),
            }
        })
}

fn nth_access_span(source: &str, actual_depth: u32) -> Option<FormulaSourceSpan> {
    let tokens = source_token_index(source);
    let accesses: Vec<_> = tokens
        .iter()
        .filter(|token| matches!(token.token.token_type, TokenType::Dot | TokenType::LBracket))
        .collect();
    accesses
        .get(actual_depth.saturating_sub(1) as usize)
        .map(|token| token.span.clone())
}

fn whole_source_span(source: &str) -> FormulaSourceSpan {
    FormulaSourceSpan {
        start_utf16: 0,
        end_utf16: source.encode_utf16().count() as u32,
    }
}

fn diagnostic(
    code: impl Into<String>,
    severity: FormulaDiagnosticSeverity,
    span: FormulaSourceSpan,
    title: impl Into<String>,
    cause: impl Into<String>,
    repair: impl Into<String>,
) -> FormulaDiagnostic {
    FormulaDiagnostic {
        code: code.into(),
        severity,
        span,
        title: title.into(),
        cause: cause.into(),
        repair: repair.into(),
    }
}

fn truncate_diagnostics(diagnostics: &mut Vec<FormulaDiagnostic>, max: u32) {
    diagnostics.truncate(max as usize);
}

fn enforce_static_dependency_limit(
    dependencies: &mut Vec<FormulaDependency>,
    diagnostics: &mut Vec<FormulaDiagnostic>,
    max: u32,
    source: &str,
) {
    if dependencies.len() <= max as usize {
        return;
    }
    let actual = dependencies.len();
    dependencies.truncate(max as usize);
    diagnostics.push(diagnostic(
        "dependencies.limit_exceeded",
        FormulaDiagnosticSeverity::Error,
        whole_source_span(source),
        "Too many formula dependencies",
        format!("{actual} dependencies exceed the owner limit {max}."),
        "Reduce the number of distinct references.",
    ));
}

fn char_to_utf16(source: &str, char_offset: usize) -> u32 {
    source
        .chars()
        .take(char_offset)
        .map(char::len_utf16)
        .sum::<usize>() as u32
}

fn utf16_to_char_offset(source: &str, utf16_offset: u32) -> usize {
    let mut units = 0_u32;
    for (index, character) in source.chars().enumerate() {
        if units >= utf16_offset {
            return index;
        }
        units += character.len_utf16() as u32;
        if units > utf16_offset {
            return index + 1;
        }
    }
    source.chars().count()
}

fn utf16_slice(source: &str, start_utf16: u32, end_utf16: u32) -> String {
    let start = utf16_to_char_offset(source, start_utf16);
    let end = utf16_to_char_offset(source, end_utf16);
    source
        .chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

fn line_column_to_char_offset(source: &str, line: usize, column: usize) -> usize {
    let mut current_line = 1;
    let mut current_column = 1;
    for (index, character) in source.chars().enumerate() {
        if current_line == line && current_column == column {
            return index;
        }
        if character == '\n' {
            current_line += 1;
            current_column = 1;
        } else {
            current_column += 1;
        }
    }
    source.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use formula_ast::{FormulaQueryPolicy, FormulaQueryPolicyEnvelope};
    use serde_json::json;

    fn capabilities() -> FormulaQueryReply {
        formula_capabilities(
            &FormulaCapabilitiesRequest {
                protocol_version: 1,
                request_token: "cap-1".to_string(),
                source_revision: "source-1".to_string(),
                catalog_revision: "catalog-1".to_string(),
                registry_revision: None,
                expected_policy_revision: None,
            },
            &FormulaQueryPolicy::default(),
            "1",
        )
    }

    fn analyze_request(expression: &str) -> FormulaAnalyzeRequest {
        FormulaAnalyzeRequest {
            protocol_version: 1,
            expression: expression.to_string(),
            cursor_offset_utf16: expression.encode_utf16().count() as u32,
            request_token: "analyze-1".to_string(),
            source_revision: "source-1".to_string(),
            catalog_revision: "catalog-1".to_string(),
            registry_revision: capabilities().registry_revision,
            expected_policy_revision: "1".to_string(),
            variables: Map::new(),
        }
    }

    fn project_source_request_with_expression(
        expression: JsonValue,
    ) -> FormulaProjectSourceRequest {
        FormulaProjectSourceRequest {
            protocol_version: FORMULA_QUERY_PROTOCOL_VERSION,
            request_token: "project-source-1".to_string(),
            source_revision: "source-1".to_string(),
            catalog_revision: "catalog-1".to_string(),
            registry_revision: capabilities().registry_revision,
            expected_policy_revision: "1".to_string(),
            legacy_request: Map::from_iter([("expression".to_string(), expression)]),
        }
    }

    fn project_source_request(expression: &str) -> FormulaProjectSourceRequest {
        project_source_request_with_expression(JsonValue::String(expression.to_string()))
    }

    fn member_path(depth: u32) -> String {
        format!("=root{}", ".member".repeat(depth as usize))
    }

    fn project_source_with_limit(expression: &str, max_traversal_depth: u32) -> FormulaQueryReply {
        project_formula_source(
            &project_source_request(expression),
            &FormulaQueryPolicy {
                max_traversal_depth,
                ..FormulaQueryPolicy::default()
            },
            "1",
        )
    }

    #[test]
    fn project_source_enforces_owner_traversal_limit_one() {
        let accepted = project_source_with_limit(&member_path(1), 1);
        assert!(accepted.diagnostics.is_empty());
        assert_eq!(
            accepted.legacy_projection.unwrap().state,
            FormulaLegacyProjectionState::Available
        );

        let rejected = project_source_with_limit(&member_path(2), 1);
        assert!(rejected.diagnostics.is_empty());
        assert_eq!(
            rejected.legacy_projection.unwrap().state,
            FormulaLegacyProjectionState::Unavailable
        );
    }

    #[test]
    fn project_source_enforces_owner_traversal_limit_sixty_four() {
        let accepted = project_source_with_limit(&member_path(64), 64);
        assert!(accepted.diagnostics.is_empty());
        assert_eq!(
            accepted.legacy_projection.unwrap().state,
            FormulaLegacyProjectionState::Available
        );

        let rejected = project_source_with_limit(&member_path(128), 64);
        assert!(rejected.diagnostics.is_empty());
        assert_eq!(
            rejected.legacy_projection.unwrap().state,
            FormulaLegacyProjectionState::Unavailable
        );
    }

    #[test]
    fn project_source_enforces_owner_traversal_limit_one_hundred_twenty_eight() {
        let accepted = project_source_with_limit(&member_path(128), 128);
        assert!(accepted.diagnostics.is_empty());
        let projection = accepted.legacy_projection.unwrap();
        assert_eq!(projection.state, FormulaLegacyProjectionState::Available);
        assert!(projection.expression.is_some());
    }

    #[test]
    fn project_source_applies_owner_traversal_limit_to_structured_legacy_ast() {
        let ast = Parser::new().parse(&member_path(128)).unwrap();
        let request = project_source_request_with_expression(serde_json::to_value(ast).unwrap());

        let rejected = project_formula_source(
            &request,
            &FormulaQueryPolicy {
                max_traversal_depth: 64,
                ..FormulaQueryPolicy::default()
            },
            "1",
        );
        assert_eq!(
            rejected.legacy_projection.unwrap().state,
            FormulaLegacyProjectionState::Unavailable
        );

        let accepted = project_formula_source(
            &request,
            &FormulaQueryPolicy {
                max_traversal_depth: 128,
                ..FormulaQueryPolicy::default()
            },
            "1",
        );
        assert_eq!(
            accepted.legacy_projection.unwrap().state,
            FormulaLegacyProjectionState::NeedsConversion
        );
    }

    #[test]
    fn analyzes_human_formula_dependencies_completion_and_canonical_source() {
        let reply = analyze_formula_query(
            &analyze_request("=A1+B1"),
            &FormulaQueryPolicy::default(),
            "1",
        );
        assert!(reply.diagnostics.is_empty());
        assert_eq!(reply.canonical_expression.as_deref(), Some("=A1 + B1"));
        assert_eq!(
            reply
                .static_dependencies
                .iter()
                .map(|dependency| dependency.name.as_str())
                .collect::<Vec<_>>(),
            ["A1", "B1"]
        );
        assert!(reply.completion.is_some());
    }

    #[test]
    fn analyze_completion_is_owner_authoritative_for_functions_and_variables() {
        let mut request = analyze_request("=S");
        request.variables = Map::from_iter([
            ("Sales".to_string(), json!(42)),
            ("Summary".to_string(), json!("ready")),
            ("Unrelated".to_string(), json!(true)),
        ]);
        let reply = analyze_formula_query(&request, &FormulaQueryPolicy::default(), "1");
        assert!(reply.diagnostics.is_empty(), "{:?}", reply.diagnostics);
        let completion = reply.completion.unwrap();
        assert_eq!(completion.state, FormulaCompletionState::Ready);
        assert!(completion.items.iter().any(|item| {
            item.group == FormulaCompletionGroup::Functions
                && item.kind == FormulaCompletionKind::Function
                && item.signature.is_some()
                && item.summary.is_some()
        }));
        let sales = completion
            .items
            .iter()
            .find(|item| item.label == "Sales")
            .unwrap();
        assert_eq!(sales.id, "formula.variable.53616c6573");
        assert_eq!(sales.group, FormulaCompletionGroup::Variables);
        assert_eq!(sales.kind, FormulaCompletionKind::Variable);
        assert_eq!(sales.category, "number");
        assert_eq!(sales.insertion_text, "Sales");
        assert_eq!(
            sales.replacement_span,
            FormulaSourceSpan {
                start_utf16: 1,
                end_utf16: 2,
            }
        );
        assert_eq!(sales.post_insert_caret_utf16, 6);
        assert_eq!(sales.signature, None);
        assert!(sales.summary.as_deref().unwrap().contains("Sales"));
        assert!(completion.items.iter().any(|item| {
            item.label == "Summary"
                && item.kind == FormulaCompletionKind::Variable
                && item.category == "text"
        }));
        assert!(!completion
            .items
            .iter()
            .any(|item| item.label == "Unrelated"));

        request
            .variables
            .insert("Sales".to_string(), json!({"changed": true}));
        let changed = analyze_formula_query(&request, &FormulaQueryPolicy::default(), "1")
            .completion
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.label == "Sales")
            .unwrap();
        assert_eq!(changed.id, sales.id);
        assert_eq!(changed.category, "object");
    }

    #[test]
    fn analyze_and_evaluate_share_the_owner_variable_limit() {
        let mut request = analyze_request("=A1");
        request.variables =
            Map::from_iter([("A1".to_string(), json!(1)), ("B1".to_string(), json!(2))]);
        let reply = analyze_formula_query(
            &request,
            &FormulaQueryPolicy {
                max_variables: 1,
                ..FormulaQueryPolicy::default()
            },
            "1",
        );
        assert_eq!(reply.diagnostics[0].code, "variables.limit_exceeded");
        assert_eq!(
            reply.completion.unwrap().state,
            FormulaCompletionState::Error
        );

        request.variables = Map::from_iter([("not-a-variable".to_string(), json!(1))]);
        let reply = analyze_formula_query(&request, &FormulaQueryPolicy::default(), "1");
        assert_eq!(reply.diagnostics[0].code, "variables.invalid_name");
        assert_eq!(
            reply.completion.unwrap().state,
            FormulaCompletionState::Error
        );
    }

    #[test]
    fn utf16_spans_and_completion_include_the_authored_marker() {
        let source = "=\"😀\"+A1";
        let reply = analyze_formula_query(
            &analyze_request(source),
            &FormulaQueryPolicy::default(),
            "1",
        );
        assert!(reply.diagnostics.is_empty());
        assert_eq!(
            reply.static_dependencies[0].span,
            Some(FormulaSourceSpan {
                start_utf16: 6,
                end_utf16: 8,
            })
        );
        assert_eq!(
            reply.completion.unwrap().replacement_span,
            FormulaSourceSpan {
                start_utf16: 6,
                end_utf16: 8,
            }
        );
    }

    #[test]
    fn evaluates_through_compiler_and_solver_with_conservative_readset() {
        let registry_revision = capabilities().registry_revision;
        let request = FormulaEvaluateRequest {
            protocol_version: 1,
            expression: "=A1+B1".to_string(),
            cursor_offset_utf16: 6,
            request_token: "evaluate-1".to_string(),
            source_revision: "source-1".to_string(),
            catalog_revision: "catalog-1".to_string(),
            registry_revision,
            expected_policy_revision: "1".to_string(),
            variables: Map::from_iter([("A1".to_string(), json!(2)), ("B1".to_string(), json!(3))]),
        };
        let reply = evaluate_formula_query(&request, &FormulaQueryPolicy::default(), "1");
        assert!(reply.diagnostics.is_empty(), "{:?}", reply.diagnostics);
        assert_eq!(reply.evaluation.unwrap().result, json!(5.0));
    }

    #[test]
    fn member_index_and_short_circuit_reads_never_omit_bound_roots() {
        let mut parser = Parser::new();
        let ast = parser
            .parse("=IF(false, customer.total, rows[index])")
            .unwrap();
        let variables = Map::from_iter([
            ("customer".to_string(), json!({"total": 5})),
            ("rows".to_string(), json!([1, 2])),
            ("index".to_string(), json!(0)),
        ]);
        let reads = collect_bound_formula_reads(
            &ast,
            "=IF(false, customer.total, rows[index])",
            &variables,
        );
        assert_eq!(
            reads
                .variables
                .iter()
                .map(|read| read.root_name.as_str())
                .collect::<Vec<_>>(),
            ["customer", "index", "rows"]
        );
    }

    #[test]
    fn canonical_readset_fixtures_lock_member_index_and_conservative_branches() {
        for (source, variables, fixture) in [
            (
                "=customer.total",
                Map::from_iter([("customer".to_string(), json!({"total":5}))]),
                include_str!("../tests/fixtures/readset-member-root-v1.json"),
            ),
            (
                "=rows[index]",
                Map::from_iter([
                    ("rows".to_string(), json!([1, 2])),
                    ("index".to_string(), json!(0)),
                ]),
                include_str!("../tests/fixtures/readset-index-roots-v1.json"),
            ),
            (
                "=IF(false, customer.total, rows[index])",
                Map::from_iter([
                    ("customer".to_string(), json!({"total":5})),
                    ("rows".to_string(), json!([1, 2])),
                    ("index".to_string(), json!(0)),
                ]),
                include_str!("../tests/fixtures/readset-short-circuit-conservative-v1.json"),
            ),
        ] {
            let ast = Parser::new().parse(source).unwrap();
            let readset = collect_bound_formula_reads(&ast, source, &variables);
            assert_eq!(
                serde_json::to_string(&readset).unwrap(),
                fixture.trim_end(),
                "{source}"
            );
        }
    }

    #[test]
    fn preview_and_dependency_limits_are_owner_enforced() {
        let registry_revision = capabilities().registry_revision;
        let request = FormulaEvaluateRequest {
            protocol_version: 1,
            expression: "=A1+B1".to_string(),
            cursor_offset_utf16: 6,
            request_token: "evaluate-limits".to_string(),
            source_revision: "source-1".to_string(),
            catalog_revision: "catalog-1".to_string(),
            registry_revision,
            expected_policy_revision: "1".to_string(),
            variables: Map::from_iter([("A1".to_string(), json!(2)), ("B1".to_string(), json!(3))]),
        };
        let no_preview = FormulaQueryPolicy {
            max_preview_bytes: 0,
            ..FormulaQueryPolicy::default()
        };
        let reply = evaluate_formula_query(&request, &no_preview, "1");
        assert!(reply.evaluation.is_none());
        assert_eq!(reply.diagnostics[0].code, "preview.suppressed");

        let one_dependency = FormulaQueryPolicy {
            max_static_dependencies: 1,
            ..FormulaQueryPolicy::default()
        };
        let reply = evaluate_formula_query(&request, &one_dependency, "1");
        assert!(reply.evaluation.is_none());
        assert_eq!(reply.static_dependencies.len(), 1);
        assert_eq!(reply.diagnostics[0].code, "dependencies.limit_exceeded");
    }

    #[test]
    fn traversal_limits_apply_to_member_index_and_mixed_paths() {
        for expression in ["=root.a.b", "=root[0][1]", "=root.a[0].b"] {
            let mut request = analyze_request(expression);
            let policy = FormulaQueryPolicy {
                max_traversal_depth: 1,
                ..FormulaQueryPolicy::default()
            };
            request.cursor_offset_utf16 = expression.encode_utf16().count() as u32;
            let reply = analyze_formula_query(&request, &policy, "1");
            assert_eq!(reply.diagnostics[0].code, "traversal_depth_exceeded");
        }
    }

    #[test]
    fn capabilities_are_registry_derived() {
        let reply = capabilities();
        assert!(!reply.functions.is_empty());
        assert_eq!(
            reply.registry_revision,
            RuleRegistry::with_builtin_rules().revision()
        );
    }

    #[test]
    fn structured_errors_distinguish_null_evaluation() {
        let mut request = analyze_request("=");
        let reply = analyze_formula_query(&request, &FormulaQueryPolicy::default(), "1");
        assert_eq!(reply.diagnostics[0].code, "syntax.incomplete");
        request.expression = "==A1".to_string();
        request.cursor_offset_utf16 = 4;
        let reply = analyze_formula_query(&request, &FormulaQueryPolicy::default(), "1");
        assert_eq!(reply.diagnostics[0].code, "syntax.invalid");
        assert!(reply.evaluation.is_none());
    }

    #[test]
    fn owner_policy_defaults_validate() {
        FormulaQueryPolicyEnvelope::default().validate().unwrap();
    }
}
