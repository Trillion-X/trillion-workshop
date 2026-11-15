use ecma_json::{JsString, Value};
use trillion_local::ecma_json;
#[path = "support/workshop_data.rs"]
mod workshop_data;

use trillion_local::rule_bindings;


use trillion_local::workspace_show_rules;
use workspace_show_rules::{
    Authority, ClockFacts, ClockOwner, CurrentOwner, FormulaAnswer, FormulaOwner, GivenContext,
    Limits, ShowRules,
};

fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(key)),
        _ => None,
    }
}

struct Owner {
    record: Option<Value>,
    given: Option<GivenContext>,
    failure: bool,
    bad_edit_reply: bool,
    current_checks: usize,
    record_reads: usize,
    context_reads: usize,
    revoke_at: usize,
}
impl CurrentOwner for Owner {
    fn assert_current(&mut self) -> workspace_show_rules::Result<()> {
        self.current_checks += 1;
        if self.failure || self.current_checks >= self.revoke_at {
            Err(trillion_local::cause!(workspace_show_rules::Error::Unavailable))
        } else {
            Ok(())
        }
    }
    fn authority(&mut self) -> workspace_show_rules::Result<Authority> {
        Ok(Authority::Personal)
    }
    fn personal_record(&mut self, _: &str) -> workspace_show_rules::Result<Option<Value>> {
        self.record_reads += 1;
        Ok(self.record.clone())
    }
    fn given_context(
        &mut self,
        _: Option<&str>,
    ) -> workspace_show_rules::Result<Option<GivenContext>> {
        self.context_reads += 1;
        Ok(self.given.clone())
    }
    fn thing_facts(
        &mut self,
        declarations: &[Value],
        thing: &Value,
        _: i64,
    ) -> workspace_show_rules::Result<Value> {
        let mut row = json("{}");
        if let Value::Object(obj) = &mut row {
            for fact in declarations {
                if let Some(Value::String(id)) = get(fact, "id") {
                    let key = id.to_rust_string().unwrap();
                    if let Some(value) = get(thing, &key) {
                        obj.insert(id.clone(), value.clone());
                    } else {
                        obj.insert(id.clone(), Value::Null);
                    }
                }
            }
        }
        Ok(row)
    }
    fn edit_rules_now(
        &mut self,
        _: Option<&Value>,
        _: Authority,
        _: i64,
    ) -> workspace_show_rules::Result<Value> {
        if self.bad_edit_reply {
            Ok(json(r#"{"wrong":[]}"#))
        } else {
            Ok(json(r#"{"rules":[{"id":"edit-owner","effect":"allow"}]}"#))
        }
    }
    fn attribute_fields(&mut self, _: Option<&Value>) -> workspace_show_rules::Result<Value> {
        Ok(json(r#"[{"id":"cohorts","kind":"tags"}]"#))
    }
    fn controls(&mut self) -> workspace_show_rules::Result<Value> {
        Ok(json(r#"[{"path":"sidebar.position"}]"#))
    }
    fn operators(&mut self) -> workspace_show_rules::Result<Value> {
        Ok(json(r#"["is_any_of","is_true"]"#))
    }
}

struct Formula {
    answer: bool,
    calls: usize,
    incomplete: bool,
}
impl FormulaOwner for Formula {
    fn matches(
        &mut self,
        _: &Value,
        _: &Value,
        _: &[Value],
    ) -> workspace_show_rules::Result<FormulaAnswer> {
        self.calls += 1;
        Ok(FormulaAnswer {
            matches: self.answer,
            incomplete: if self.incomplete {
                vec![json(r#"{"reason":"unfinished"}"#)]
            } else {
                Vec::new()
            },
        })
    }
}

struct SchemaFormula {
    seen_fields: Vec<Vec<Value>>,
}
struct NoText;
impl rule_bindings::TextSemantics for NoText {
    fn to_locale_lowercase(&mut self, _: &JsString) -> rule_bindings::Result<JsString> {
        Err(trillion_local::cause!(rule_bindings::Error::Unsupported))
    }
    fn trim_is_empty(&mut self, _: &JsString) -> rule_bindings::Result<bool> {
        Err(trillion_local::cause!(rule_bindings::Error::Unsupported))
    }
}
impl FormulaOwner for SchemaFormula {
    fn matches(
        &mut self,
        tree: &Value,
        _: &Value,
        fields: &[Value],
    ) -> workspace_show_rules::Result<FormulaAnswer> {
        self.seen_fields.push(fields.to_vec());
        let operators = workshop_data::rule_operators();
        let mut text = NoText;
        let compiled = rule_bindings::compile_rules(
            Some(tree),
            fields,
            &operators,
            &mut text,
            rule_bindings::Limits::default(),
        )
        .map_err(|error| match error {
            rule_bindings::Error::Bounds(_) => trillion_local::cause!(workspace_show_rules::Error::Bounds),
            rule_bindings::Error::Invalid(_) => trillion_local::cause!(workspace_show_rules::Error::Invalid),
            rule_bindings::Error::Unsupported(_) | rule_bindings::Error::Evaluator(_) => {
                trillion_local::cause!(workspace_show_rules::Error::Unavailable)
            }
        })?;
        Ok(FormulaAnswer {
            matches: compiled.binding.is_some(),
            incomplete: compiled.incomplete,
        })
    }
}

struct Clock;
impl ClockOwner for Clock {
    fn now_ms(&mut self) -> workspace_show_rules::Result<i64> {
        Ok(1_800_000_000_000)
    }
    fn time_of(&mut self, value: &Value) -> workspace_show_rules::Result<Option<i64>> {
        Ok(match value {
            Value::Number(n) if n.is_finite() => Some(*n as i64),
            Value::String(s) => s.to_rust_string().ok().and_then(|s| {
                chrono::DateTime::parse_from_rfc3339(&s)
                    .ok()
                    .map(|d| d.timestamp_millis())
                    .or_else(|| {
                        chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                            .ok()
                            .and_then(|d| d.and_hms_opt(0, 0, 0))
                            .map(|d| d.and_utc().timestamp_millis())
                    })
            }),
            _ => None,
        })
    }
    fn date_parse(&mut self, value: &Value) -> workspace_show_rules::Result<Option<i64>> {
        let Value::String(s) = value else {
            return Ok(None);
        };
        Ok(s.to_rust_string().ok().and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(&s)
                .ok()
                .map(|d| d.timestamp_millis())
                .or_else(|| {
                    chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                        .ok()
                        .and_then(|d| d.and_hms_opt(0, 0, 0))
                        .map(|d| d.and_utc().timestamp_millis())
                })
        }))
    }
    fn facts(&mut self, _: i64, _: Option<&str>) -> workspace_show_rules::Result<ClockFacts> {
        Ok(ClockFacts {
            hour: Some(9),
            minute: Some(15),
            weekday: Some("monday".into()),
        })
    }
    fn next_turn(
        &mut self,
        now: i64,
        turns: &str,
        _: Option<&str>,
    ) -> workspace_show_rules::Result<Option<i64>> {
        Ok((turns == "hour").then_some(now + 45 * 60_000))
    }
    fn rule_turn(
        &mut self,
        _: i64,
        _: &Value,
        _: &[Value],
        _: &Value,
        _: Option<&str>,
    ) -> workspace_show_rules::Result<Option<i64>> {
        Ok(None)
    }
}

fn data() -> Value {
    json(
        r#"{
      "record":"show-rules",
      "starting_rules":[{"id":"all-hide","subject":"notice","effect":"hide","label":"Starting","when":null}],
      "types":[{"id":"shipped","label":"Shipped","rules":[{"id":"loud","subject":"notice","effect":"hide","when":null}]}],
      "effects":[{"id":"hide","strength":2},{"id":"silence","strength":1},{"id":"show","strength":3,"shows":true}],
      "subjects":{"notice":{"label":"Notices","facts":[{"id":"kind","kind":"choice","path":["kind"]}],"change_fields":[{"path":["required"],"authority":"operator"}]}},
      "moment_facts":[{"id":"hour","kind":"number","from_time":"hour","turns":"hour"}],
      "quick":[{"id":"hour","label":"An hour"}],
      "edit_authority":{"actions":["change_rule"],"effects":[{"id":"allow"}],"facts":[{"id":"account_owner"}]}
    }"#,
    )
}

fn make<'a, F: FormulaOwner>(
    data: &'a Value,
    owner: &'a mut Owner,
    formula: &'a mut F,
    clock: &'a mut Clock,
) -> ShowRules<'a, Owner, F, Clock> {
    ShowRules {
        data,
        owner,
        formula,
        clock,
        limits: Limits::default(),
    }
}

#[test]
fn read_keeps_every_rule_profiles_and_data_supplied_operators_controls() {
    let data = data();
    let mut owner = Owner {
        record: Some(json(
            r#"{"starting":{"all-hide":{"on":false}},"types":[{"id":"parent","label":"Parent","rules":[{"id":"quiet","subject":"notice","effect":"silence","when":null}]}],"in_use":["parent"],"rules":[{"id":"mine","subject":"notice","effect":"hide","on":true}]}"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .unwrap();
    assert_eq!(
        get(&answer, "operators"),
        Some(&json(r#"["is_any_of","is_true"]"#))
    );
    assert_eq!(
        get(&answer, "controls"),
        Some(&json(r#"[{"path":"sidebar.position"}]"#))
    );
    let rules = get(&answer, "rules").unwrap();
    if let Value::Array(rules) = rules {
        assert_eq!(rules.len(), 3);
        assert_eq!(get(&rules[0], "on"), Some(&Value::Bool(false)));
        assert_eq!(get(&rules[1], "id"), Some(&json(r#""mine""#)));
        assert_eq!(get(&rules[2], "id"), Some(&json(r#""type:parent:quiet""#)));
    } else {
        panic!("rules should be an array");
    }
}

#[test]
fn strongest_show_wins_and_only_active_rules_are_decided() {
    let data = data();
    let mut owner = Owner {
        record: Some(json(
            r#"{"types":[{"id":"parent","label":"Parent","rules":[{"id":"quiet","subject":"notice","effect":"silence","when":null}]}],"in_use":["parent"],"rules":[{"id":"mine","subject":"notice","effect":"show","when":{"kind":"group","combinator":"and","negate":false,"rules":[]}}]}"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide("notice", &json(r#"{"kind":"message"}"#), &json("{}"), None)
        .unwrap();
    assert_eq!(get(&answer, "hidden"), Some(&Value::Bool(false)));
    assert_eq!(get(&answer, "silenced"), Some(&Value::Bool(false)));
    assert_eq!(
        get(&answer, "rules").and_then(|v| if let Value::Array(a) = v {
            Some(a.len())
        } else {
            None
        }),
        Some(3)
    );
    assert_eq!(formula.calls, 1); // only the rule with a condition calls the formula owner
}

#[test]
fn given_audience_uses_current_context_and_unavailable_source_never_means_empty() {
    let data = data();
    let mut owner = Owner {
        record: None,
        given: Some(GivenContext {
            giver: json(
                r#"{"rules":[{"id":"for-account","label":"Assigned","subject":"notice","effect":"hide","audience":{"kind":"group","rules":[]}}]}"#,
            ),
            facts: json(r#"{"cohorts":[]}"#),
            space_types: vec![],
            audience_fields: vec![json(r#"{"id":"account_id","kind":"choice"}"#)],
        }),
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide("notice", &json("{}"), &json("{}"), None)
        .unwrap();
    assert_eq!(get(&answer, "hidden"), Some(&Value::Bool(true)));
    assert!(get(&answer, "rules")
        .and_then(|v| if let Value::Array(a) = v {
            a.iter()
                .find(|r| get(r, "id") == Some(&json(r#""given:for-account""#)))
                .and_then(|r| get(r, "given"))
        } else {
            None
        })
        .is_some());
    owner.failure = true;
    assert!(make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .is_err());
}

#[test]
fn subject_and_audience_receive_their_own_declarations_for_the_same_field_id() {
    let data = data();
    let subject_tree = json(
        r#"{"kind":"rule","field":"kind","operator":"is_any_of","params":{"values":["item"]}}"#,
    );
    let audience_tree = json(r#"{"kind":"rule","field":"kind","operator":"is_true","params":{}}"#);
    let own = json(
        r#"{"id":"subject-hide","subject":"notice","effect":"hide","when":{"kind":"rule","field":"kind","operator":"is_any_of","params":{"values":["item"]}}}"#,
    );
    let giver = json(
        r#"{"rules":[{"id":"audience-show","subject":"notice","effect":"show","audience":{"kind":"rule","field":"kind","operator":"is_true","params":{}}}]}"#,
    );
    let audience_fields = vec![
        json(r#"{"id":"account_id","kind":"choice"}"#),
        json(r#"{"id":"kind","kind":"boolean"}"#),
    ];
    let mut owner = Owner {
        record: Some(json(&format!(
            r#"{{"rules":[{}]}}"#,
            ecma_json::stringify(&own, ecma_json::Limits::default()).unwrap()
        ))),
        given: Some(GivenContext {
            giver,
            facts: json(r#"{"account_id":"person-1","kind":true,"cohorts":[]}"#),
            space_types: vec![],
            audience_fields: audience_fields.clone(),
        }),
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = SchemaFormula {
        seen_fields: Vec::new(),
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide("notice", &json(r#"{"kind":"item"}"#), &json("{}"), None)
        .unwrap();

    assert_eq!(get(&answer, "hidden"), Some(&Value::Bool(false)));
    let subject_fields = vec![
        json(r#"{"id":"kind","kind":"choice"}"#),
        json(r#"{"id":"hour","kind":"number"}"#),
    ];
    // Canonical givenRules runs before showDecision's per-subject conditions.
    assert_eq!(
        formula.seen_fields,
        vec![audience_fields.clone(), subject_fields.clone()]
    );

    // The same field ID has incompatible kinds. Each tree is incomplete under
    // the other source's schema, so forwarding either schema to both calls
    // would refuse or omit one side of this hide/show result.
    let operators = workshop_data::rule_operators();
    let mut text = NoText;
    let crossed_audience = rule_bindings::compile_rules(
        Some(&audience_tree),
        &subject_fields,
        &operators,
        &mut text,
        rule_bindings::Limits::default(),
    )
    .unwrap();
    assert_eq!(crossed_audience.incomplete, vec![audience_tree]);
    let crossed_subject = rule_bindings::compile_rules(
        Some(&subject_tree),
        &audience_fields,
        &operators,
        &mut text,
        rule_bindings::Limits::default(),
    )
    .unwrap();
    assert_eq!(crossed_subject.incomplete, vec![subject_tree]);
}

#[test]
fn missing_or_malformed_current_audience_fields_refuse_matching() {
    for fields in [vec![], vec![json(r#"{"id":"kind"}"#)]] {
        let data = data();
        let mut owner = Owner {
            record: None,
            given: Some(GivenContext {
                giver: json(
                    r#"{"rules":[{"id":"aimed","subject":"notice","effect":"hide","audience":{"kind":"rule","field":"kind","operator":"is_true","params":{}}}]}"#,
                ),
                facts: json(r#"{"kind":true,"cohorts":[]}"#),
                space_types: vec![],
                audience_fields: fields.clone(),
            }),
            failure: false,
            bad_edit_reply: false,
            current_checks: 0,
            record_reads: 0,
            context_reads: 0,
            revoke_at: usize::MAX,
        };
        let mut formula = Formula {
            answer: true,
            calls: 0,
            incomplete: false,
        };
        let mut clock = Clock;
        assert!(make(&data, &mut owner, &mut formula, &mut clock)
            .decide("notice", &json("{}"), &json("{}"), None)
            .is_err());
        assert_eq!(formula.calls, 0);
    }
}

#[test]
fn strict_missing_facts_and_final_revocation_refuse_disclosure() {
    let mut data = data();
    let mut owner = Owner {
        record: None,
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: 2,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    assert!(make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .is_err());
    // A strict declared subject refuses a missing field even when the injected
    // formula owner says the tree matches.
    let Value::Object(root) = &mut data else {
        unreachable!()
    };
    let subjects = root.get(&"subjects".into()).unwrap().clone();
    let Value::Object(mut subjects) = subjects else {
        unreachable!()
    };
    let Value::Object(mut notice) = subjects.get(&"notice".into()).unwrap().clone() else {
        unreachable!()
    };
    notice.insert("strict_facts".into(), Value::Bool(true));
    subjects.insert("notice".into(), Value::Object(notice));
    root.insert("subjects".into(), Value::Object(subjects));
    let mut owner = Owner {
        record: Some(json(
            r#"{"starting":{"all-hide":{"on":false}},"rules":[{"id":"strict","subject":"notice","effect":"hide","when":{"kind":"group","combinator":"and","negate":false,"rules":[{"kind":"rule","field":"kind","operator":"is_any_of","params":{"values":["x"]}}]}}]}"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide("notice", &json("{}"), &json("{}"), None)
        .unwrap();
    assert_eq!(get(&answer, "hidden"), Some(&Value::Bool(false)));
    assert_eq!(formula.calls, 0);
}

#[test]
fn null_until_is_unbounded_while_date_only_rfc3339_and_numeric_expiries_are_applied() {
    let data = data();
    let mut owner = Owner {
        record: Some(json(
            r#"{"starting":{"all-hide":{"on":false}},"rules":[
          {"id":"null","subject":"notice","effect":"hide","until":null},
          {"id":"date-future","subject":"notice","effect":"hide","until":"2027-02-01"},
          {"id":"rfc-future","subject":"notice","effect":"hide","until":"2027-02-01T00:00:00Z"},
          {"id":"number-future","subject":"notice","effect":"hide","until":1800000001000},
          {"id":"date-expired","subject":"notice","effect":"hide","until":"2027-01-01"},
          {"id":"number-zero","subject":"notice","effect":"hide","until":0}] }"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide("notice", &json("{}"), &json("{}"), None)
        .unwrap();
    let ids: Vec<_> = match get(&answer, "rules").unwrap() {
        Value::Array(rows) => rows
            .iter()
            .filter_map(|r| {
                get(r, "id").and_then(|v| {
                    if let Value::String(s) = v {
                        s.to_rust_string().ok()
                    } else {
                        None
                    }
                })
            })
            .collect(),
        _ => panic!("rules should be an array"),
    };
    assert_eq!(
        ids,
        vec![
            "null".to_string(),
            "date-future".to_string(),
            "rfc-future".to_string(),
            "number-future".to_string()
        ]
    );
}

#[test]
fn read_uses_nullish_type_defaults_and_array_only_in_use() {
    let data = data();
    let mut owner = Owner {
        record: Some(json(
            r#"{"types":[{"id":"parent","label":null,"inherits":null,"rules":null}],"in_use":"not-an-array"}"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .unwrap();
    assert_eq!(get(&answer, "in_use"), Some(&json("[]")));
    let ty = match get(&answer, "types").unwrap() {
        Value::Array(rows) => rows
            .iter()
            .find(|row| get(row, "id") == Some(&json(r#""parent""#)))
            .unwrap(),
        _ => panic!("types should be an array"),
    };
    assert_eq!(get(ty, "label"), Some(&json(r#""parent""#)));
    assert_eq!(get(ty, "inherits"), Some(&json("[]")));
    assert_eq!(get(ty, "rules"), Some(&json("[]")));
}

#[test]
fn read_matches_source_falsy_until_filter_and_date_only_expiration() {
    let data = data();
    let mut owner = Owner {
        record: Some(json(
            r#"{"starting":{"all-hide":{"on":false}},"rules":[
          {"id":"null","until":null},
          {"id":"empty","until":""},
          {"id":"zero","until":0},
          {"id":"false","until":false},
          {"id":"expired","until":"2027-01-01"}] }"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .unwrap();
    // Original everyRule lists disabled rules with on:false so they can still
    // be edited. Disabling a starting rule must not remove it from this read.
    let Value::Array(rows) = get(&answer, "rules").unwrap() else {
        panic!("rules should be an array")
    };
    assert_eq!(get(&rows[0], "id"), Some(&json(r#""all-hide""#)));
    assert_eq!(get(&rows[0], "on"), Some(&Value::Bool(false)));
    let ids: Vec<_> = match get(&answer, "rules").unwrap() {
        Value::Array(rows) => rows
            .iter()
            .filter_map(|r| {
                get(r, "id").and_then(|v| {
                    if let Value::String(s) = v {
                        s.to_rust_string().ok()
                    } else {
                        None
                    }
                })
            })
            .collect(),
        _ => panic!("rules should be an array"),
    };
    assert_eq!(
        ids,
        vec![
            "all-hide".to_string(),
            "null".to_string(),
            "empty".to_string(),
            "zero".to_string(),
            "false".to_string()
        ]
    );
}

#[test]
fn malformed_edit_owner_and_unrepresentable_profile_identity_refuse_instead_of_disappearing() {
    let data = data();
    let mut owner = Owner {
        record: None,
        given: None,
        failure: false,
        bad_edit_reply: true,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    assert!(make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .is_err());

    let mut record = json("{}");
    if let Value::Object(object) = &mut record {
        object.insert(
            "in_use".into(),
            Value::Array(vec![Value::String(JsString::from_units(vec![0xD800]))]),
        );
    }
    let mut owner = Owner {
        record: Some(record),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    assert!(make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .is_err());
}

#[test]
fn inherited_edit_policy_uses_the_same_type_and_audience_family_without_show_rules() {
    let context = GivenContext {
        giver: json(
            r#"{"types":[{"id":"team","label":"Team","edit_rules":[{"id":"inherited","effect":"allow"}],"rules":[{"id":"ordinary","effect":"hide"}]}],"edit_rules":[{"id":"aimed","effect":"deny","audience":{"kind":"group","combinator":"and","negate":false,"rules":[]}},{"id":"disabled","on":false,"audience":{}}],"rules":[{"id":"not-edit","audience":{}}]}"#,
        ),
        facts: json(r#"{"cohorts":["team"]}"#),
        space_types: Vec::new(),
        audience_fields: vec![json(r#"{"id":"cohorts","kind":"tags"}"#)],
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let rules = workspace_show_rules::current_given_edit_rules(
        &data(),
        Some(&context),
        &mut formula,
        Default::default(),
    )
    .unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(
        get(&rules[0], "id"),
        Some(&json(r#""type:team:inherited""#))
    );
    assert_eq!(get(&rules[0], "given"), Some(&json(r#""Team""#)));
    assert_eq!(get(&rules[1], "id"), Some(&json(r#""given:aimed""#)));
    assert!(get(&rules[1], "audience").is_none());
    assert_eq!(formula.calls, 1);
    formula.incomplete = true;
    assert!(matches!(
        workspace_show_rules::current_given_edit_rules(
            &data(),
            Some(&context),
            &mut formula,
            Default::default()
        ),
        Err(workspace_show_rules::Error::Unavailable(_))
    ));
}

#[test]
fn selected_rule_phase_uses_shared_engine_without_unrelated_record_reads() {
    let data = data();
    let mut owner = Owner {
        record: Some(json(
            r#"{"rules":[{"id":"unrelated","subject":"notice","effect":"hide"}]}"#,
        )),
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let phase = json(
        r#"[{"id":"operator:one","subject":"notice","effect":"show","when":{"kind":"group","combinator":"and","negate":false,"rules":[]}}]"#,
    );
    let Value::Array(phase) = phase else {
        unreachable!()
    };
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide_selected_rules(
            "notice",
            &json(r#"{"kind":"message"}"#),
            &json("{}"),
            &phase,
            1_800_000_000_000,
        )
        .unwrap();
    assert_eq!(get(&answer, "hidden"), Some(&Value::Bool(false)));
    assert_eq!(
        get(&answer, "rules").and_then(|v| if let Value::Array(a) = v {
            Some(a.len())
        } else {
            None
        }),
        Some(1)
    );
    assert_eq!(
        formula.calls, 1,
        "the same formula owner actually evaluated selected rules"
    );
    assert_eq!(owner.record_reads, 0);
    assert_eq!(owner.context_reads, 0);
    assert_eq!(
        owner.current_checks, 2,
        "current source required before and after output"
    );
}
#[test]
fn selected_rules_keep_recovery_currentness_and_exact_source_clock() {
    let data = data();
    let mut owner = Owner {
        record: None,
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    };
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let rules = vec![json(
        r#"{"id":"phase","subject":"notice","effect":"hide","until":101}"#,
    )];
    // Clock::now_ms is far later; a selected source phase supplies one shared
    // now for all setup candidates, matching the original source composition.
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .decide_selected_rules("notice", &json("{}"), &json("{}"), &rules, 100)
        .unwrap();
    assert_eq!(get(&answer, "hidden"), Some(&Value::Bool(true)));
    assert_eq!(get(&answer, "next_change_at"), Some(&Value::Number(101.0)));
    owner.current_checks = 0;
    owner.revoke_at = 2;
    assert!(make(&data, &mut owner, &mut formula, &mut clock)
        .decide_selected_rules("notice", &json("{}"), &json("{}"), &rules, 100)
        .is_err());
}

fn owner_with(record: Option<Value>) -> Owner {
    Owner {
        record,
        given: None,
        failure: false,
        bad_edit_reply: false,
        current_checks: 0,
        record_reads: 0,
        context_reads: 0,
        revoke_at: usize::MAX,
    }
}

fn rule_ids(answer: &Value) -> Vec<String> {
    match get(answer, "rules") {
        Some(Value::Array(rules)) => rules
            .iter()
            .filter_map(|rule| match get(rule, "id") {
                Some(Value::String(id)) => id.to_rust_string().ok(),
                _ => None,
            })
            .collect(),
        _ => panic!("rules should be an array"),
    }
}

/// Old trillion 190f72754e: show-rules.json ships no `types` and typesOf(record) reads only the record, so a
/// `types` block in the DATA is never offered nor applied, even when the record's in_use names it.
#[test]
fn shipped_data_types_are_ignored() {
    let data = data();
    let mut owner = owner_with(Some(json(r#"{"in_use":["shipped"]}"#)));
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let answer = make(&data, &mut owner, &mut formula, &mut clock)
        .read()
        .unwrap();
    assert!(!rule_ids(&answer).iter().any(|id| id.starts_with("type:shipped:")));
    assert_eq!(get(&answer, "types"), Some(&json("[]")));
}

/// A type kept in a person's own record applies to that keeper only, and only while in_use names it.
#[test]
fn kept_type_applies_to_its_keeper_only_while_in_use_names_it() {
    let data = data();
    let kept = r#""types":[{"id":"parent","label":"Parent","rules":[{"id":"quiet","subject":"notice","effect":"silence","when":null}]}]"#;
    let mut formula = Formula {
        answer: true,
        calls: 0,
        incomplete: false,
    };
    let mut clock = Clock;
    let mut read = |record: Option<Value>| {
        let mut owner = owner_with(record);
        rule_ids(
            &make(&data, &mut owner, &mut formula, &mut clock)
                .read()
                .unwrap(),
        )
    };
    let on = read(Some(json(&format!(r#"{{{kept},"in_use":["parent"]}}"#))));
    assert!(on.iter().any(|id| id == "type:parent:quiet"));
    let off = read(Some(json(&format!(r#"{{{kept},"in_use":[]}}"#))));
    assert!(!off.iter().any(|id| id.starts_with("type:parent:")));
    let other = read(Some(json(r#"{"in_use":["parent"]}"#)));
    assert!(!other.iter().any(|id| id.starts_with("type:parent:")));
}
