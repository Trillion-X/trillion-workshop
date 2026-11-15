use trillion_local::ecma_json;
use ecma_json::{JsString, Value};
use std::{cell::RefCell, rc::Rc, time::Duration};
#[path = "support/workshop_data.rs"]
mod workshop_data;

use trillion_local::rule_bindings::evaluator as canonical_binding_evaluator;
use trillion_local::workspace_show_rules::formula;
use trillion_local::rule_bindings;
use trillion_local::workspace_show_rules;

use canonical_binding_evaluator::FormulaBindingEvaluator;
use formula::RuleFormulaOwner;
use rule_bindings::{BindingEvaluator, Error as BindingError, Limits, TextSemantics};
use workspace_show_rules::{Error, FormulaOwner};


fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}

struct NoLocale;
impl TextSemantics for NoLocale {
    fn to_locale_lowercase(&mut self, _: &JsString) -> rule_bindings::Result<JsString> {
        Err(trillion_local::cause!(BindingError::Unsupported))
    }

    fn trim_is_empty(&mut self, _: &JsString) -> rule_bindings::Result<bool> {
        Err(trillion_local::cause!(BindingError::Unsupported))
    }
}

struct ProbeEvaluator {
    bindings: Rc<RefCell<Vec<Value>>>,
    answer: rule_bindings::Result<Value>,
}
impl BindingEvaluator for ProbeEvaluator {
    fn evaluate(&mut self, binding: &Value, _: &Value) -> rule_bindings::Result<Value> {
        self.bindings.borrow_mut().push(binding.clone());
        self.answer.clone()
    }
}

fn probe(answer: rule_bindings::Result<Value>) -> (ProbeEvaluator, Rc<RefCell<Vec<Value>>>) {
    let bindings = Rc::new(RefCell::new(Vec::new()));
    (
        ProbeEvaluator {
            bindings: bindings.clone(),
            answer,
        },
        bindings,
    )
}

#[test]
fn choice_and_boolean_rules_use_the_supplied_kind_and_preserve_incomplete_rules() {
    let operators = workshop_data::rule_operators();
    let choice = json(
        r#"{"kind":"rule","field":"state","operator":"is_any_of","params":{"values":["ready"]}}"#,
    );
    let boolean = json(r#"{"kind":"rule","field":"state","operator":"is_true","params":{}}"#);
    let choice_fields = vec![json(r#"{"id":"state","kind":"choice"}"#)];
    let boolean_fields = vec![json(r#"{"id":"state","kind":"boolean"}"#)];
    let (evaluator, bindings) = probe(Ok(Value::Bool(true)));
    let mut owner = RuleFormulaOwner::new(&operators, NoLocale, evaluator, Limits::default());

    let accepted_choice = owner
        .matches(&choice, &json(r#"{"state":"ready"}"#), &choice_fields)
        .unwrap();
    assert!(accepted_choice.matches);
    assert!(accepted_choice.incomplete.is_empty());
    assert!(
        ecma_json::stringify(&bindings.borrow()[0], ecma_json::Limits::default())
            .unwrap()
            .contains("op:core.in_list")
    );

    let accepted_boolean = owner
        .matches(&boolean, &json(r#"{"state":true}"#), &boolean_fields)
        .unwrap();
    assert!(accepted_boolean.matches);
    assert!(accepted_boolean.incomplete.is_empty());

    // DATA compilation omits a rule whose declared kind does not fit. The
    // source row filter treats the resulting null binding as every row, while
    // retaining the original unfinished rule in its diagnostics.
    let crossed_boolean = owner
        .matches(&boolean, &json(r#"{"state":true}"#), &choice_fields)
        .unwrap();
    assert!(crossed_boolean.matches);
    assert_eq!(crossed_boolean.incomplete, vec![boolean.clone()]);
    let crossed_choice = owner
        .matches(&choice, &json(r#"{"state":"ready"}"#), &boolean_fields)
        .unwrap();
    assert!(crossed_choice.matches);
    assert_eq!(crossed_choice.incomplete, vec![choice.clone()]);
    assert_eq!(bindings.borrow().len(), 2); // incomplete-only trees skip evaluation
}

#[test]
fn full_incomplete_diagnostics_survive_alongside_a_ready_binding() {
    let operators = workshop_data::rule_operators();
    let unfinished = json(r#"{"kind":"rule","field":"missing","operator":"is_true","params":{}}"#);
    let tree = json(
        r#"{"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"active","operator":"is_true","params":{}},{"kind":"rule","field":"missing","operator":"is_true","params":{}}]}"#,
    );
    let fields = vec![json(r#"{"id":"active","kind":"boolean"}"#)];
    let (evaluator, bindings) = probe(Ok(Value::Bool(true)));
    let mut owner = RuleFormulaOwner::new(&operators, NoLocale, evaluator, Limits::default());
    let answer = owner
        .matches(&tree, &json(r#"{"active":true}"#), &fields)
        .unwrap();
    assert!(answer.matches);
    assert_eq!(answer.incomplete, vec![unfinished]);
    assert_eq!(bindings.borrow().len(), 1);
}

#[test]
fn evaluator_errors_and_unsupported_locale_semantics_refuse_instead_of_false() {
    let operators = workshop_data::rule_operators();
    let rule = json(r#"{"kind":"rule","field":"active","operator":"is_true","params":{}}"#);
    let fields = vec![json(r#"{"id":"active","kind":"boolean"}"#)];
    let (evaluator, _) = probe(Err(trillion_local::cause!(BindingError::Evaluator)));
    let mut owner = RuleFormulaOwner::new(&operators, NoLocale, evaluator, Limits::default());
    assert!(matches!(
        owner.matches(&rule, &json(r#"{"active":true}"#), &fields),
        Err(Error::Unavailable(_))
    ));

    let unicode =
        json(r#"{"kind":"rule","field":"name","operator":"contains","params":{"text":"İ"}}"#);
    let text_fields = vec![json(r#"{"id":"name","kind":"text"}"#)];
    let (evaluator, bindings) = probe(Ok(Value::Bool(true)));
    let mut owner = RuleFormulaOwner::new(&operators, NoLocale, evaluator, Limits::default());
    assert!(matches!(
        owner.matches(&unicode, &json(r#"{"name":"İ"}"#), &text_fields),
        Err(Error::Unavailable(_))
    ));
    assert!(bindings.borrow().is_empty());
}

#[test]
fn bounds_and_non_true_values_follow_the_existing_row_filter_contract() {
    let operators = workshop_data::rule_operators();
    let rule = json(r#"{"kind":"rule","field":"active","operator":"is_true","params":{}}"#);
    let fields = vec![json(r#"{"id":"active","kind":"boolean"}"#)];
    let (evaluator, _) = probe(Ok(Value::String("true".into())));
    let mut owner = RuleFormulaOwner::new(&operators, NoLocale, evaluator, Limits::default());
    let answer = owner
        .matches(&rule, &json(r#"{"active":true}"#), &fields)
        .unwrap();
    // The canonical row filter admits only JSON true; it does not apply JS
    // truthiness to arbitrary JSON results.
    assert!(!answer.matches);

    let (evaluator, bindings) = probe(Ok(Value::Bool(true)));
    let limits = Limits {
        nodes: 1,
        elapsed: Duration::from_secs(2),
        ..Limits::default()
    };
    let mut bounded = RuleFormulaOwner::new(&operators, NoLocale, evaluator, limits);
    assert!(matches!(
        bounded.matches(&rule, &json(r#"{"active":true}"#), &fields),
        Err(Error::Bounds(_))
    ));
    assert!(bindings.borrow().is_empty());
}

#[test]
fn canonical_binding_evaluator_proves_positive_and_nonmatch_results() {
    let operators = workshop_data::rule_operators();
    let choice = json(
        r#"{"kind":"rule","field":"state","operator":"is_any_of","params":{"values":["ready"]}}"#,
    );
    let choice_fields = vec![json(r#"{"id":"state","kind":"choice"}"#)];
    let mut owner = RuleFormulaOwner::new(
        &operators,
        NoLocale,
        FormulaBindingEvaluator,
        Limits::default(),
    );
    let positive = owner
        .matches(&choice, &json(r#"{"state":"ready"}"#), &choice_fields)
        .unwrap();
    assert!(positive.matches);
    assert!(positive.incomplete.is_empty());
    let negative = owner
        .matches(&choice, &json(r#"{"state":"other"}"#), &choice_fields)
        .unwrap();
    assert!(!negative.matches);
    assert!(negative.incomplete.is_empty());

    let boolean = json(r#"{"kind":"rule","field":"state","operator":"is_true","params":{}}"#);
    let wrong_schema = owner
        .matches(&boolean, &json(r#"{"state":true}"#), &choice_fields)
        .unwrap();
    assert!(wrong_schema.matches); // null binding is the row-filter all-rows result
    assert_eq!(wrong_schema.incomplete, vec![boolean]);
}
