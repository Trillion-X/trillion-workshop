//! crates/composition-engine/src/binding/operators/core/map_to_nodes.rs
//!
//! MAP_TO_NODES operator - Template instantiation for repeater patterns.
//! Extracted from array.rs as the one composition-engine-specific operator
//! that has no ops-core equivalent (it needs evaluator access for eager evaluation).

use super::super::registry::{OperatorContext, OperatorResult};
use crate::binding::ast::{Diagnostic, DiagnosticCode, DiagnosticLevel};
use ops_core::OpValue;

pub fn op_map_to_nodes(
    input: &OpValue,
    args: Option<&OpValue>,
    ctx: &OperatorContext,
) -> OperatorResult {
    #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
    web_sys::console::log_1(&"[MAP_TO_NODES] op_map_to_nodes CALLED".into());

    let input_json = input.as_inner();

    let arr = match input_json {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Null => return Ok(OpValue::from(serde_json::json!([]))),
        _ => {
            return Err(Diagnostic {
                code: DiagnosticCode::EvalTypeMismatch,
                level: DiagnosticLevel::Error,
                message: "MAP_TO_NODES() requires pipeline value to be an array".to_string(),
                at: String::new(),
                data: None,
            })
        }
    };

    let args_json = args.map(|a| a.as_inner()).ok_or_else(|| Diagnostic {
        code: DiagnosticCode::OpArgsInvalid,
        level: DiagnosticLevel::Error,
        message: "MAP_TO_NODES() requires 'template' argument".to_string(),
        at: String::new(),
        data: None,
    })?;

    let template = args_json.get("template").ok_or_else(|| Diagnostic {
        code: DiagnosticCode::OpArgsInvalid,
        level: DiagnosticLevel::Error,
        message: "MAP_TO_NODES() requires 'template' argument".to_string(),
        at: String::new(),
        data: None,
    })?;

    let item_var = args_json
        .get("item_var")
        .and_then(|v| v.as_str())
        .unwrap_or("$item");
    let index_var = args_json
        .get("index_var")
        .and_then(|v| v.as_str())
        .unwrap_or("$index");

    #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
    web_sys::console::log_1(
        &format!(
            "[MAP_TO_NODES] has_resolver={} arr_len={} item_var={} vars_keys={:?}",
            ctx.has_resolver(),
            arr.len(),
            item_var,
            ctx.eval_ctx.vars.keys().collect::<Vec<_>>()
        )
        .into(),
    );

    // EAGER EVALUATION if resolver is available
    if ctx.has_resolver() {
        #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
        web_sys::console::log_1(&"[MAP_TO_NODES] Taking EAGER EVALUATION path".into());

        let mut result = Vec::with_capacity(arr.len());
        for (index, item) in arr.iter().enumerate() {
            let iter_ctx = ctx.with_iteration_vars(item.clone(), index, item_var, index_var);

            #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
            {
                let item_preview: String = serde_json::to_string(&item)
                    .unwrap_or_default()
                    .chars()
                    .take(100)
                    .collect();
                web_sys::console::log_1(
                    &format!(
                        "[MAP_TO_NODES] Item[{}] = {} vars_keys={:?}",
                        index,
                        item_preview,
                        iter_ctx.eval_ctx.vars.keys().collect::<Vec<_>>()
                    )
                    .into(),
                );
            }

            let resolved =
                iter_ctx
                    .evaluate_nested_bindings(template)
                    .ok_or_else(|| Diagnostic {
                        code: DiagnosticCode::BindingOperatorError,
                        level: DiagnosticLevel::Error,
                        message: "Failed to evaluate template bindings".to_string(),
                        at: String::new(),
                        data: None,
                    })?;

            #[cfg(all(target_arch = "wasm32", feature = "verbose-logging"))]
            {
                // Check if value binding still has unresolved $item
                let resolved_str = serde_json::to_string(&resolved).unwrap_or_default();
                let has_item_ref = resolved_str.contains("\"$item\"");
                web_sys::console::log_1(
                    &format!(
                        "[MAP_TO_NODES] Item[{}] resolved has_item_ref={} preview={}",
                        index,
                        has_item_ref,
                        resolved_str.chars().take(200).collect::<String>()
                    )
                    .into(),
                );
            }

            result.push(resolved);
        }
        return Ok(OpValue::from(serde_json::Value::Array(result)));
    }

    // Fallback: attach $vars (legacy, should not happen in normal operation)
    let mut result = Vec::with_capacity(arr.len());
    for (index, item) in arr.iter().enumerate() {
        let mut node = template.clone();
        if let serde_json::Value::Object(ref mut obj) = node {
            let mut vars = serde_json::Map::new();
            vars.insert(item_var.to_string(), item.clone());
            vars.insert(
                index_var.to_string(),
                serde_json::Value::Number(index.into()),
            );
            obj.insert("$vars".to_string(), serde_json::Value::Object(vars));
        }
        result.push(node);
    }

    Ok(OpValue::from(serde_json::Value::Array(result)))
}
