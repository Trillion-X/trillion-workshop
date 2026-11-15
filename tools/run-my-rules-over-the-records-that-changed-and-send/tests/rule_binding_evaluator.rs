//! Native-owned executable controls after the module and dependency are mounted.
use trillion_local::{
    ecma_json::{JsString, Object, Value},
    rule_bindings::evaluator::FormulaBindingEvaluator,
    rule_bindings::{BindingEvaluator, Error},
};

fn binding() -> Value {
    let mut root = Object::new();
    root.insert("$kind".into(), Value::String("binding".into()));
    let mut select = Object::new();
    select.insert("from".into(), Value::String("self".into()));
    select.insert(
        "path".into(),
        Value::Array(vec![Value::String("kind".into())]),
    );
    root.insert("select".into(), Value::Object(select));
    root.insert(
        "transform".into(),
        Value::Array(vec![{
            let mut step = Object::new();
            step.insert("op".into(), Value::String("op:core.in_list".into()));
            let mut args = Object::new();
            args.insert(
                "values".into(),
                Value::Array(vec![Value::String("pursuit".into())]),
            );
            step.insert("args".into(), Value::Object(args));
            Value::Object(step)
        }]),
    );
    Value::Object(root)
}
fn row(kind: &str) -> Value {
    let mut o = Object::new();
    o.insert("kind".into(), Value::String(kind.into()));
    Value::Object(o)
}

#[test]
fn uses_the_existing_formula_binding_evaluator() {
    let mut evaluator = FormulaBindingEvaluator;
    assert_eq!(
        evaluator.evaluate(&binding(), &row("pursuit")).unwrap(),
        Value::Bool(true)
    );
    assert_eq!(
        evaluator.evaluate(&binding(), &row("decision")).unwrap(),
        Value::Bool(false)
    );
}

#[test]
fn refuses_surrogates_nonfinite_numbers_and_oversized_inputs() {
    let mut evaluator = FormulaBindingEvaluator;
    let lone = Value::String(JsString::from_units(vec![0xd800]));
    assert_eq!(
        evaluator.evaluate(&binding(), &lone),
        Err(trillion_local::cause!(Error::Unsupported))
    );
    assert_eq!(
        evaluator.evaluate(&binding(), &Value::Number(f64::INFINITY)),
        Err(trillion_local::cause!(Error::Unsupported))
    );
    assert_eq!(
        evaluator.evaluate(
            &binding(),
            &Value::String("x".repeat(9 * 1024 * 1024).into())
        ),
        Err(trillion_local::cause!(Error::Bounds))
    );
}

#[test]
fn evaluator_diagnostics_are_discarded() {
    let mut evaluator = FormulaBindingEvaluator;
    let private = Value::String("private-user-value".into());
    let error = evaluator.evaluate(&private, &row("pursuit")).unwrap_err();
    assert_eq!(error, trillion_local::cause!(Error::Evaluator));
    assert!(!format!("{error:?} {error}").contains("private-user-value"));
}
