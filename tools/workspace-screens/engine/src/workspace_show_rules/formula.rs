//! FormulaOwner adapter over the shared DATA rule compiler and injected
//! evaluator. This module adds no operator semantics or locale implementation.

use crate::{
    ecma_json::Value,
    rule_bindings::{self, BindingEvaluator, Error as BindingError, TextSemantics},
    workspace_show_rules::{Error, FormulaAnswer, FormulaOwner, Result},
};

/// Binds current operator DATA, the host's locale semantics, and its existing
/// formula evaluator to the show-rules formula boundary.
pub struct RuleFormulaOwner<'a, T, E> {
    operator_data: &'a Value,
    text: T,
    evaluator: E,
    limits: rule_bindings::Limits,
}

impl<'a, T, E> RuleFormulaOwner<'a, T, E> {
    /// `operator_data` must be the current formula-engine operator DATA value
    /// owned by the caller. Fields and rows are supplied per match call.
    pub fn new(
        operator_data: &'a Value,
        text: T,
        evaluator: E,
        limits: rule_bindings::Limits,
    ) -> Self {
        Self {
            operator_data,
            text,
            evaluator,
            limits,
        }
    }
}

fn map_error(error: BindingError) -> Error {
    let cause = error.cause();
    match error {
        BindingError::Invalid(_) => Error::Invalid(cause),
        BindingError::Bounds(_) => Error::Bounds(cause),
        BindingError::Unsupported(_) | BindingError::Evaluator(_) => Error::Unavailable(cause),
    }
}

impl<T: TextSemantics, E: BindingEvaluator> FormulaOwner for RuleFormulaOwner<'_, T, E> {
    fn matches(&mut self, tree: &Value, row: &Value, fields: &[Value]) -> Result<FormulaAnswer> {
        let compiled = rule_bindings::compile_rules(
            Some(tree),
            fields,
            self.operator_data,
            &mut self.text,
            self.limits,
        )
        .map_err(map_error)?;

        // The row-filter source treats a null binding as every row matching,
        // while returning unfinished rules separately as diagnostics.
        let value = compiled
            .evaluate(&mut self.evaluator, row)
            .map_err(map_error)?;
        // The canonical formula engine (tools/formula-engine/crates/formula-engine) matches only JSON true. Keep
        // that contract; other JSON values are valid evaluations but no match.
        let matches = matches!(value, Value::Bool(true));
        Ok(FormulaAnswer {
            matches,
            incomplete: compiled.incomplete,
        })
    }
}
