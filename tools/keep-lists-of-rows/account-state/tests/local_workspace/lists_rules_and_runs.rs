//! A list runs on formula fields, trigger rules and workflow runs (src/rule_bindings/rules_and_runs.rs): through the
//! account's one records write and its generic records read, a list's formula field is worked out when its row is read, a row write fires the account's rule rows,
//! the rule starts a workflow whose run is a row, and the person goes on with the run by writing its row. Ported
//! from Trillion's tests of a list's formula column (the `seconds` column), of a rule that fires on a change it
//! matches, and of a run that waits for an answer and goes on once answered. Every record word is synthetic fixture
//! text.
use super::*;

async fn write(f: &Fixture, key: &str, records: Value) -> (StatusCode, Value) {
    write_input(f,key,json!({"records":records})).await
}

async fn write_input(f: &Fixture, key: &str, input: Value) -> (StatusCode,Value) {
    let mut post = request("POST", "/work/api/records", Some(&input.to_string()));
    post.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    post.headers_mut().insert("x-trillion-request-key", key.parse().unwrap());
    let response = f.app.clone().oneshot(post).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn read_back(f: &Fixture, operation: &str, input: Value) -> Value {
    let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("input", &input.to_string()).finish();
    let response = f.app.clone().oneshot(request("GET", &format!("/work/api/door/{operation}?{query}"), None)).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    assert_eq!(status, StatusCode::OK, "{operation}: {answer}");
    answer
}

fn calls_list() -> Value {
    let seconds = json!({ "$kind": "binding", "select": { "from": "self", "path": ["minutes"] }, "transform": [{ "op": "op:core.mul", "args": { "value": 60 } }, { "op": "op:core.to_number" }] });
    json!({ "id": "list:calls", "type": "list", "value": {
        "id": "calls", "label": "Calls", "row_type": "calls", "title_field": "name",
        "fields": [
            { "id": "name", "label": "Name", "kind": "text" },
            { "id": "stage", "label": "Stage", "kind": "text" },
            { "id": "minutes", "label": "Minutes", "kind": "number" },
            { "id": "seconds", "label": "Seconds", "kind": "formula", "derive": { "request": { "binding": seconds } } }
        ]
    }})
}

/// The trigger rule: a call row whose stage becomes won starts the `thank` workflow with its minutes.
fn won_rule() -> Value {
    json!({ "id": "trigger-rule:call-won", "type": "trigger-rule", "value": {
        "id": "call-won",
        "match_condition": { "conditions": [{ "$bind": { "select": { "from": "change", "path": "stage" }, "transform": [{ "op": "op:core.equals", "args": { "value": "won" } }] } }] },
        "dispatch": {
            "target": "workflow:start",
            "output_template": {
                "rule_id": "call-won",
                "record_id": { "$bind": { "select": { "from": "envelope", "path": "address_text" } } },
                "content": { "$bind": { "select": { "from": "change", "path": "stage" } } },
                "then": { "workflow_id": "thank" },
                "input": { "minutes": { "$bind": { "select": { "from": "change", "path": "minutes" } } } }
            }
        }
    }})
}

/// A workflow that asks for a thank-you, then returns that it was thanked.
fn thank_recipe() -> Value {
    json!({ "id": "workflow-recipe:thank", "type": "workflow-recipe", "value": { "definition": {
        "id": "thank", "name": "Thank", "kind": "workflow", "is_active": true, "version": 1,
        "steps": [
            { "id": "thank", "kind": "ask", "config": { "name": "ai", "input": {}, "context": { "step_id": "thank" } } },
            { "id": "done", "kind": "return", "config": { "value": { "thanked": true } } }
        ],
        "edges": [{ "from": "thank", "to": "done", "kind": "always" }]
    }}})
}

#[tokio::test]
async fn a_list_computes_its_formula_field_fires_its_rule_and_runs_the_workflow_the_rule_starts() {
    let f = records_write_controls::started_fixture();
    let (status, answer) = write(&f, "lists-rules-setup", json!([calls_list(), won_rule(), thank_recipe()])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");

    // A row the rule does not match: its formula field is worked out on read, nothing fires.
    let (status, answer) = write(&f, "lists-rules-open", json!([{ "id": "record:calls:bo", "type": "record:calls", "value": { "name": "Bo Chen", "stage": "open", "minutes": 12 } }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let row = read_back(&f, "records:read", json!({ "id": "record:calls:bo" })).await;
    assert_eq!(row["value"]["minutes"], 12, "{row}");
    assert_eq!(row["computed"], json!({ "seconds": 720 }), "{row}");
    assert!(row["value"].get("seconds").is_none(), "a computed value is never kept in the row: {row}");
    let page = read_back(&f, "records:list", json!({ "type": "record:calls" })).await;
    assert_eq!(page["records"][0]["computed"], json!({ "seconds": 720 }), "{page}");
    let runs = read_back(&f, "records:list", json!({ "type": "workflow-run" })).await;
    assert_eq!(runs["records"], json!([]), "{runs}");

    // The row becomes won: the rule fires and starts its workflow, which waits for its one ask.
    let (status, answer) = write(&f, "lists-rules-won", json!([{ "id": "record:calls:bo", "type": "record:calls", "value": { "name": "Bo Chen", "stage": "won", "minutes": 15 } }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let row = read_back(&f, "records:read", json!({ "id": "record:calls:bo" })).await;
    assert_eq!(row["computed"], json!({ "seconds": 900 }), "{row}");
    let outcomes = read_back(&f, "records:list", json!({ "type": "trigger-dispatch-outcome" })).await;
    let fired = &outcomes["records"][0];
    assert!(fired["id"].as_str().unwrap().starts_with("rule-run:"), "{outcomes}");
    assert_eq!(fired["value"]["rule_id"], "call-won", "{outcomes}");
    assert_eq!(fired["value"]["status"], "succeeded", "{outcomes}");
    let run_id = fired["value"]["started"]["run_id"].as_str().expect("the outcome names the run it started").to_string();
    let run = read_back(&f, "records:read", json!({ "id": format!("workflow-run:{run_id}") })).await;
    assert_eq!(run["value"]["workflow_id"], "thank", "{run}");
    assert_eq!(run["value"]["started_by"], "call-won", "{run}");
    assert_eq!(run["value"]["input"], json!({ "minutes": 15 }), "{run}");
    assert_eq!(run["value"]["state"], "working", "{run}");
    assert_eq!(run["value"]["waiting"][0]["step_id"], "thank", "{run}");

    // The same change again starts no second run (one run per workflow and send).
    let (status, _) = write(&f, "lists-rules-won-again", json!([{ "id": "record:calls:bo", "type": "record:calls", "value": { "name": "Bo Chen", "stage": "won", "minutes": 15 } }])).await;
    assert_eq!(status, StatusCode::OK);
    let runs = read_back(&f, "records:list", json!({ "type": "workflow-run" })).await;
    assert_eq!(runs["records"].as_array().unwrap().len(), 1, "{runs}");

    // The person answers the ask by writing the run's row: the run goes on and finishes.
    let mut answered = run["value"].clone();
    answered["answers"] = json!({ "thank": { "text": "Thanks, Bo" } });
    let (status, answer) = write(&f, "lists-rules-answer", json!([{ "id": format!("workflow-run:{run_id}"), "type": "workflow-run", "value": answered }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = read_back(&f, "records:read", json!({ "id": format!("workflow-run:{run_id}") })).await;
    assert_eq!(run["value"]["state"], "finished", "{run}");
    assert_eq!(run["value"]["status"], "completed", "{run}");
    assert_eq!(run["value"]["waiting"], json!([]), "{run}");
    assert_eq!(run["value"]["steps"]["thank"]["output"], json!({ "text": "Thanks, Bo" }), "{run}");
}

#[tokio::test]
async fn a_scoped_rule_uses_only_its_local_recipe_and_missing_closure_rolls_back_the_row() {
    ADMIT_APART.with(|apart| apart.set(true));
    let f = records_write_controls::canonical_started_fixture();
    let scope = |id,create| json!({"id":id,"incarnation":"first","generation":1,"create":create});
    let input = |context,records| json!({"scope":context,"records":records});
    // A matching primary recipe must never stand in for A's missing local one.
    assert_eq!(write(&f,"primary-recipe",json!([thank_recipe()])).await.0,StatusCode::OK);
    for (id,with_recipe) in [("a",false),("b",true)] {
        let mut records = vec![calls_list(),won_rule()];
        if with_recipe { records.push(thank_recipe()); }
        let (status,value) = write_input(&f,&format!("create-rule-scope-{id}"),input(scope(id,true),json!(records))).await;
        assert_eq!(status,StatusCode::OK,"{value}");
    }
    let row = json!({"id":"record:calls:same","type":"record:calls","value":{"name":"Synthetic","stage":"won","minutes":2}});
    let (status,value) = write_input(&f,"missing-local-recipe",input(scope("a",false),json!([row.clone()]))).await;
    assert_ne!(status,StatusCode::OK,"a missing local mutable dependency must refuse the whole scoped command: {value}");
    let a = read_back(&f,"records:read",json!({"scope":scope("a",false),"id":"record:calls:same"})).await;
    assert!(a["value"].is_null(),"the first record effect rolled back: {a}");
    let (status,value) = write_input(&f,"complete-local-recipe",input(scope("b",false),json!([row]))).await;
    assert_eq!(status,StatusCode::OK,"{value}");
    let runs = read_back(&f,"records:list",json!({"scope":scope("b",false),"type":"workflow-run"})).await;
    assert_eq!(runs["records"].as_array().unwrap().len(),1,"{runs}");
    assert_eq!(runs["records"][0]["value"]["workflow_id"],"thank");
    let a_runs = read_back(&f,"records:list",json!({"scope":scope("a",false),"type":"workflow-run"})).await;
    assert_eq!(a_runs["records"],json!([]));
}

/// A kept type's row: `wanted` says the person wants the type in use. Synthetic fixture words.
fn type_row(id: &str, type_id: &str) -> Value {
    json!({ "id": format!("record:types:{id}"), "type": "record:types", "value": { "type_id": type_id, "wanted": true } })
}

/// A trigger rule: a type row that is wanted starts `workflow_id` with the type it names.
fn wanted_rule(rule_id: &str, workflow_id: &str) -> Value {
    json!({ "id": format!("trigger-rule:{rule_id}"), "type": "trigger-rule", "value": {
        "id": rule_id,
        "match_condition": { "conditions": [{ "$bind": { "select": { "from": "change", "path": "wanted" }, "transform": [{ "op": "op:core.equals", "args": { "value": true } }] } }] },
        "dispatch": {
            "target": "workflow:start",
            "output_template": {
                "rule_id": rule_id,
                "record_id": { "$bind": { "select": { "from": "envelope", "path": "address_text" } } },
                "content": { "$bind": { "select": { "from": "change", "path": "type_id" } } },
                "then": { "workflow_id": workflow_id },
                "input": { "type": { "$bind": { "select": { "from": "change", "path": "type_id" } } } }
            }
        }
    }})
}

/// A workflow whose one step writes the account's own `target` record (an ask named the records write): it puts the
/// run's input type into the record's `in_use`, as `record_type`, optionally only if the record is still `expected`.
fn use_type_recipe(workflow_id: &str, target: &str, record_type: &str, expected: Option<Value>) -> Value {
    let mut write = json!({ "id": target, "type": record_type, "add": { "in_use": [{ "$kind": "binding", "select": { "from": "input", "path": "type" } }] } });
    if let Some(expected) = expected { write["expected"] = expected; }
    json!({ "id": format!("workflow-recipe:{workflow_id}"), "type": "workflow-recipe", "value": { "definition": {
        "id": workflow_id, "name": "Use a type", "kind": "workflow", "is_active": true, "version": 1,
        "steps": [
            { "id": "use", "kind": "ask", "config": { "name": "records:write", "input": { "records": [write] }, "context": { "step_id": "use" } } },
            { "id": "done", "kind": "return", "config": { "value": { "used": true } } }
        ],
        "edges": [{ "from": "use", "to": "done", "kind": "always" }]
    }}})
}

async fn run_of(f: &Fixture, rule_id: &str) -> Value {
    let runs = read_back(f, "records:list", json!({ "type": "workflow-run" })).await;
    let mut found: Vec<Value> = runs["records"].as_array().unwrap().iter().filter(|run| run["value"]["started_by"] == rule_id).cloned().collect();
    assert_eq!(found.len(), 1, "one run of {rule_id}: {runs}");
    found.remove(0)
}

/// Trillion workflows.mjs answerFromTool (a run_tool step whose tool's effect is a records write), here a step that
/// writes the account's own records on the same held transaction once the run passes: a rule fires on a row change
/// and starts the workflow, whose step switches a kept type in use in the show-rules record; the record reads back
/// with it; a second run asking the identical write changes nothing; and a write over a record that is no longer what
/// the step read is refused, leaving that run failed with its reason and the record as it was.
#[tokio::test]
async fn a_rule_starts_a_workflow_whose_step_writes_the_show_rules_record() {
    let f = records_write_controls::started_fixture();
    let show_rules = json!({ "id": "show-rules", "type": "show-rules", "value": { "in_use": [] } });
    let (status, answer) = write(&f, "step-write-setup", json!([show_rules, wanted_rule("use-wanted", "use-type"),
        use_type_recipe("use-type", "show-rules", "show-rules", None)])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");

    let (status, answer) = write(&f, "step-write-calls", json!([type_row("calls", "calls")])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = run_of(&f, "use-wanted").await;
    assert_eq!(run["value"]["state"], "finished", "{run}");
    assert_eq!(run["value"]["wrote"], json!(["show-rules"]), "{run}");
    let record = read_back(&f, "records:read", json!({ "id": "show-rules" })).await;
    assert_eq!(record["value"]["in_use"], json!(["calls"]), "{record}");

    // A second row naming the same type starts a second run asking the identical write: nothing changes.
    let (status, answer) = write(&f, "step-write-calls-again", json!([type_row("calls-again", "calls")])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let runs = read_back(&f, "records:list", json!({ "type": "workflow-run" })).await;
    let runs = runs["records"].as_array().unwrap();
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert!(runs.iter().all(|run| run["value"]["state"] == "finished"), "{runs:?}");
    assert!(runs.iter().any(|run| run["value"]["wrote"] == json!([])), "the identical write wrote nothing: {runs:?}");
    let again = read_back(&f, "records:read", json!({ "id": "show-rules" })).await;
    assert_eq!(again, record, "the record is as it was");

    // A step that writes only if the record is still what it read (in_use empty) is refused now: its run fails
    // with the reason, and nothing of it is written (the first rule's run, on the same row, still adds the type).
    let (status, answer) = write(&f, "step-write-stale-setup", json!([wanted_rule("use-stale", "use-stale"),
        use_type_recipe("use-stale", "show-rules", "show-rules", Some(json!({ "type": "show-rules", "value": { "in_use": [] } })))])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (status, answer) = write(&f, "step-write-stale", json!([type_row("deals", "deals")])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let stale = run_of(&f, "use-stale").await;
    assert_eq!(stale["value"]["state"], "failed", "{stale}");
    assert_eq!(stale["value"]["error"], "The record show-rules is not what the step read; nothing was written.", "{stale}");
    let after = read_back(&f, "records:read", json!({ "id": "show-rules" })).await;
    assert_eq!(after["value"]["in_use"], json!(["calls", "deals"]), "{after}");
}

/// Trillion automations.mjs `then = { tool_id, input }`: a rule's send to a tool is no longer only recorded. It is
/// kept once per tool and send as the row the wake runner takes (src/wake.rs `sends`), with the send's input, and the
/// rule's outcome names it.
#[tokio::test]
async fn a_rules_send_to_a_tool_is_kept_for_the_wake_runner() {
    let f = records_write_controls::started_fixture();
    let mut rule = wanted_rule("tell-wanted", "unused");
    rule["value"]["dispatch"]["output_template"]["then"] = json!({ "tool_id": "tool:tell" });
    let (status, answer) = write(&f, "tool-send-setup", json!([rule])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    for key in ["tool-send-calls", "tool-send-calls-again"] {
        let (status, answer) = write(&f, key, json!([type_row("calls", "calls")])).await;
        assert_eq!(status, StatusCode::OK, "{answer}");
    }
    let sends = read_back(&f, "records:list", json!({ "type": "rule-tool-send" })).await;
    let sends = sends["records"].as_array().unwrap();
    assert_eq!(sends.len(), 1, "once per tool and send: {sends:?}");
    assert!(sends[0]["id"].as_str().unwrap().starts_with("rule-send:"), "{sends:?}");
    assert_eq!(sends[0]["value"]["tool_id"], "tool:tell", "{sends:?}");
    assert_eq!(sends[0]["value"]["input"], json!({ "type": "calls" }), "{sends:?}");
    assert_eq!(sends[0]["value"]["rule_id"], "tell-wanted", "{sends:?}");
    let outcomes = read_back(&f, "records:list", json!({ "type": "trigger-dispatch-outcome" })).await;
    assert!(outcomes["records"].as_array().unwrap().iter().any(|outcome| outcome["value"]["started"]["send"] == sends[0]["id"]), "{outcomes}");
    let runs = read_back(&f, "records:list", json!({ "type": "workflow-run" })).await;
    assert_eq!(runs["records"], json!([]), "{runs}");
}

/// Trillion's store handed every records write to its automations, a run_tool step's write too: a rule fires on a
/// workflow's own write. A wanted type row starts `mark`, whose step sets a call row's stage to won; that write is
/// handed to the rules again, and the won rule's send to a tool is kept for the wake runner.
#[tokio::test]
async fn a_rule_fires_on_a_workflows_own_write() {
    let f = records_write_controls::started_fixture();
    let mark = json!({ "id": "workflow-recipe:mark", "type": "workflow-recipe", "value": { "definition": {
        "id": "mark", "name": "Mark a call won", "kind": "workflow", "is_active": true, "version": 1,
        "steps": [
            { "id": "mark", "kind": "ask", "config": { "name": "records:write", "input": { "records": [
                { "id": "record:calls:bo", "type": "record:calls", "set": { "name": "Bo", "stage": "won", "minutes": 3 } }] }, "context": { "step_id": "mark" } } },
            { "id": "done", "kind": "return", "config": { "value": { "marked": true } } }
        ],
        "edges": [{ "from": "mark", "to": "done", "kind": "always" }]
    }}});
    let mut tell = won_rule();
    tell["value"]["dispatch"]["output_template"]["then"] = json!({ "tool_id": "tool:tell" });
    let (status, answer) = write(&f, "own-write-setup", json!([wanted_rule("mark-wanted", "mark"), mark, tell])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (status, answer) = write(&f, "own-write-calls", json!([type_row("calls", "calls")])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = run_of(&f, "mark-wanted").await;
    assert_eq!(run["value"]["state"], "finished", "{run}");
    assert_eq!(run["value"]["wrote"], json!(["record:calls:bo"]), "{run}");
    let sends = read_back(&f, "records:list", json!({ "type": "rule-tool-send" })).await;
    let sends = sends["records"].as_array().unwrap();
    assert_eq!(sends.len(), 1, "the won rule fired on the step's write: {sends:?}");
    assert_eq!(sends[0]["value"]["rule_id"], "call-won", "{sends:?}");
    assert_eq!(sends[0]["value"]["input"], json!({ "minutes": 3 }), "{sends:?}");
}


/// Old customer-database-resource.mjs opened its own list/record owner without
/// PersonStore's watcher. A new complete history does not inherit another
/// history's automation rules merely because both belong to one account.
#[tokio::test]
async fn an_independent_history_does_not_inherit_another_historys_rule_watcher() {
    ADMIT_APART.with(|apart| apart.set(true));
    let f=records_write_controls::canonical_started_fixture();
    let (status,value)=write(&f,"primary-rule-owner",json!([calls_list(),won_rule(),thank_recipe()])).await;
    assert_eq!(status,StatusCode::OK,"{value}");
    let scope=json!({"id":"independent-history","incarnation":"first","generation":1,"create":true});
    let row=json!({"id":"record:calls:same","type":"record:calls","value":{"name":"Synthetic","stage":"won","minutes":2}});
    let (status,value)=write_input(&f,"independent-rule-owner",json!({"scope":scope,"records":[calls_list(),row]})).await;
    assert_eq!(status,StatusCode::OK,"{value}");
    let scope=json!({"id":"independent-history","incarnation":"first","generation":1});
    let scoped_runs=read_back(&f,"records:list",json!({"scope":scope,"type":"workflow-run"})).await;
    assert_eq!(scoped_runs["records"],json!([]),"primary rules cannot silently acquire a different history");
    let primary_runs=read_back(&f,"records:list",json!({"type":"workflow-run"})).await;
    assert_eq!(primary_runs["records"],json!([]));
    let scoped_row=read_back(&f,"records:read",json!({"scope":scope,"id":"record:calls:same"})).await;
    assert_eq!(scoped_row["value"]["stage"],"won");
}

/// Old trillion src/placed-lists.mjs invariant 1: one store answers for a list's rows, its home. Once a list's rows sit
/// in a history of their own and the primary holds its `home:` row (records-routes.json `_homes`), a page call that names
/// no scope reads and writes that history; `scope: null` names the primary and may only remove there.
#[tokio::test]
async fn a_list_with_a_home_is_read_and_written_there_by_a_call_that_names_no_scope() {
    ADMIT_APART.with(|apart| apart.set(true));
    let f = records_write_controls::canonical_started_fixture();
    let create = json!({"id":"list-calls","incarnation":"first","generation":1,"create":true});
    let scope = json!({"id":"list-calls","incarnation":"first","generation":1});
    let row = json!({"id":"record:calls:moved","type":"record:calls","value":{"name":"Synthetic","stage":"open","minutes":2}});
    let (status, value) = write_input(&f, "home-rows", json!({"scope": create, "records": [row, calls_list()]})).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let primary = read_back(&f, "records:list", json!({"type": "record:calls"})).await;
    assert_eq!(primary["records"], json!([]), "before its home row the list is read in the primary");

    let home = json!({"id": "home:record:calls", "type": "home", "value": {"kind": "record:calls", "scope": scope}});
    let (status, value) = write(&f, "home-row", json!([home])).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let homed = read_back(&f, "records:list", json!({"type": "record:calls"})).await;
    assert_eq!(homed["records"][0]["id"], "record:calls:moved", "{homed}");
    assert_eq!(homed["scope"]["id"], "list-calls", "{homed}");

    let new_row = json!({"id":"record:calls:after","type":"record:calls","value":{"name":"Later","stage":"open","minutes":3}});
    let (status, value) = write(&f, "home-write", json!([new_row])).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let there = read_back(&f, "records:read", json!({"scope": scope, "id": "record:calls:after", "type": "record:calls"})).await;
    assert_eq!(there["value"]["name"], "Later", "a write naming no scope lands in the home");
    let left = read_back(&f, "records:list", json!({"scope": null, "type": "record:calls"})).await;
    assert_eq!(left["records"], json!([]), "nothing of the kind is written to the primary");

    let (status, _) = write_input(&f, "home-primary-write", json!({"scope": null, "records": [{"id":"record:calls:back","type":"record:calls","value":{"name":"Back"}}]})).await;
    assert_ne!(status, StatusCode::OK, "the primary takes only removals of a homed kind");
}

/// A workflow whose one ask is answered by an AI (`agent:`), then returns what that AI answered.
fn hand_over_recipe() -> Value {
    json!({ "id": "workflow-recipe:hand-over", "type": "workflow-recipe", "value": { "definition": {
        "id": "hand-over", "name": "Hand over", "kind": "workflow", "is_active": true, "version": 1,
        "steps": [
            { "id": "handle", "kind": "ask", "config": { "name": "agent:", "input": { "do": "Write the caller a thank-you note", "arrived": { "$kind": "binding", "values": ["input", "minutes"] } }, "context": { "step_id": "handle" } } },
            { "id": "done", "kind": "return", "config": { "value": { "handed": true } } }
        ],
        "edges": [{ "from": "handle", "to": "done", "kind": "always" }]
    }}})
}

#[tokio::test]
async fn an_ask_answered_by_an_ai_becomes_one_job_and_the_run_goes_on_when_an_ai_finishes_it() {
    let f = records_write_controls::started_fixture();
    let rule = { let mut rule = won_rule(); rule["value"]["dispatch"]["output_template"]["then"] = json!({ "workflow_id": "hand-over" }); rule };
    let (status, answer) = write(&f, "hand-setup", json!([calls_list(), rule, hand_over_recipe()])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (status, answer) = write(&f, "hand-won", json!([{ "id": "record:calls:bo", "type": "record:calls", "value": { "name": "Bo Chen", "stage": "won", "minutes": 15 } }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let outcomes = read_back(&f, "records:list", json!({ "type": "trigger-dispatch-outcome" })).await;
    let run_id = outcomes["records"][0]["value"]["started"]["run_id"].as_str().unwrap().to_string();
    let run = read_back(&f, "records:read", json!({ "id": format!("workflow-run:{run_id}") })).await;
    assert_eq!(run["value"]["state"], "working", "{run}");
    let jobs = read_back(&f, "records:list", json!({ "type": "ai-job" })).await;
    assert_eq!(jobs["records"].as_array().unwrap().len(), 1, "one job for the one ask: {jobs}");
    let job = &jobs["records"][0];
    assert_eq!(job["value"]["status"], "waiting", "{jobs}");
    assert_eq!(job["value"]["to"], Value::Null, "{jobs}");
    assert_eq!(job["value"]["run_id"], run_id, "{jobs}");
    assert!(job["value"]["job"].as_str().unwrap().starts_with("Write the caller a thank-you note"), "{jobs}");
    assert_eq!(run["value"]["handoffs"]["handle"], job["id"], "{run}");

    // The same change again hands nothing over twice.
    let (status, _) = write(&f, "hand-won-again", json!([{ "id": "record:calls:bo", "type": "record:calls", "value": { "name": "Bo Chen", "stage": "won", "minutes": 15 } }])).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read_back(&f, "records:list", json!({ "type": "ai-job" })).await["records"].as_array().unwrap().len(), 1);

    // An AI takes the job and finishes it: the run goes on with its result and finishes.
    let mut taken = job["value"].clone();
    taken["status"] = json!("done");
    taken["result"] = json!("Thanks, Bo");
    let (status, answer) = write(&f, "hand-finish", json!([{ "id": job["id"], "type": "ai-job", "value": taken }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = read_back(&f, "records:read", json!({ "id": format!("workflow-run:{run_id}") })).await;
    assert_eq!(run["value"]["state"], "finished", "{run}");
    assert_eq!(run["value"]["steps"]["handle"]["output"], json!({ "result": "Thanks, Bo" }), "{run}");
}

#[tokio::test]
async fn a_job_that_ends_failed_fails_the_run_and_a_recipe_that_cannot_be_read_says_why() {
    let f = records_write_controls::started_fixture();
    let rule = { let mut rule = won_rule(); rule["value"]["dispatch"]["output_template"]["then"] = json!({ "workflow_id": "hand-over" }); rule };
    let broken = json!({ "id": "workflow-recipe:hand-over", "type": "workflow-recipe", "value": { "definition": "{not json" } });
    let (status, answer) = write(&f, "bad-setup", json!([calls_list(), rule, broken])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let (status, answer) = write(&f, "bad-won", json!([{ "id": "record:calls:bo", "type": "record:calls", "value": { "name": "Bo Chen", "stage": "won", "minutes": 15 } }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let runs = read_back(&f, "records:list", json!({ "type": "workflow-run" })).await;
    let run = &runs["records"][0]["value"];
    assert_eq!(run["state"], "failed", "{runs}");
    assert!(run["error"].as_str().unwrap().contains("cannot be read as a definition"), "{runs}");

    let (status, answer) = write(&f, "ok-recipe", json!([hand_over_recipe(), { "id": "record:calls:cy", "type": "record:calls", "value": { "name": "Cy", "stage": "won", "minutes": 20 } }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let jobs = read_back(&f, "records:list", json!({ "type": "ai-job" })).await;
    let job = &jobs["records"][0];
    let mut failed = job["value"].clone();
    failed["status"] = json!("failed");
    failed["summary"] = json!("no one could");
    let (status, answer) = write(&f, "job-failed", json!([{ "id": job["id"], "type": "ai-job", "value": failed }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = read_back(&f, "records:read", json!({ "id": format!("workflow-run:{}", job["value"]["run_id"].as_str().unwrap()) })).await;
    assert_eq!(run["value"]["state"], "failed", "{run}");
    assert!(run["value"]["error"].as_str().unwrap().contains("no one could"), "{run}");
}

/// The account's installed tools ship one made-up recipe, listed by a row source the way the Workshop's
/// `source:workflow-recipes` lists its recipes: ordered steps, the first a step the person's AI does. Synthetic words.
fn ship_made_up_recipe(f: &Fixture) {
    let folder = f.records.parent().unwrap().join("workshop").join("tools").join("made-up-recipes");
    std::fs::create_dir_all(&folder).unwrap();
    let source = json!({ "records": [{ "payload": { "kind": "tool-row-source", "id": "source:made-up-recipes",
        "list": { "records": { "package": "made-up-recipes", "kind": "workflow-recipe", "file": "recipes" } } } }] });
    std::fs::write(folder.join("tool-rows.json"), source.to_string()).unwrap();
    std::fs::create_dir_all(folder.join("recipes")).unwrap();
    let recipes = json!({ "records": [{ "payload": { "kind": "workflow-recipe", "id": "workflow:made-up-shipped", "label": "A made-up shipped recipe", "job": "Say the input back",
        "steps": [
            { "id": "say", "title": "Say it", "do": "Say the input back", "submit": { "type": "object" } },
            { "id": "after", "title": "After", "do": "Then this", "submit": { "type": "object" } }
        ] } }] });
    std::fs::write(folder.join("recipes").join("made-up.json"), recipes.to_string()).unwrap();
}

/// A person starts a run of `workflow_id` by writing its row; the run as it is read back.
async fn start_run(f: &Fixture, row: &str, workflow_id: &str, input: Value) -> Value {
    let (status, answer) = write(f, &format!("start-{row}"), json!([{ "id": format!("workflow-run:{row}"), "type": "workflow-run",
        "value": { "workflow_id": workflow_id, "input": input, "answers": {} } }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    read_back(f, "records:read", json!({ "id": format!("workflow-run:{row}") })).await
}

#[tokio::test]
async fn a_recipe_the_deploy_ships_runs_on_an_account_that_holds_no_recipe_row_and_is_never_written() {
    let f = records_write_controls::started_fixture();
    ship_made_up_recipe(&f);
    let run = start_run(&f, "shipped-1", "workflow:made-up-shipped", json!({ "text": "hello" })).await;
    assert_eq!(run["value"]["state"], "working", "{run}");
    assert_eq!(run["value"]["waiting"][0]["step_id"], "say", "{run}");
    assert_eq!(run["value"]["waiting"][0]["asks"], "ai", "{run}");
    let recipes = read_back(&f, "records:list", json!({ "type": "workflow-recipe" })).await;
    assert_eq!(recipes["records"], json!([]), "a shipped recipe is read, never written: {recipes}");

    // The account's own row of the id is the recipe, not the shipped one.
    let own = json!({ "id": "workflow-recipe:workflow:made-up-shipped", "type": "workflow-recipe", "value": { "definition": {
        "steps": [{ "id": "mine", "kind": "ask", "config": { "name": "ai", "input": {} } }], "edges": [] } } });
    let (status, answer) = write(&f, "own-recipe", json!([own])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = start_run(&f, "shipped-2", "workflow:made-up-shipped", json!({})).await;
    assert_eq!(run["value"]["waiting"][0]["step_id"], "mine", "{run}");
}

/// The person's lists of workflows and of their steps, as list rows hold them: nested values are JSON text.
fn workflow_lists() -> Value {
    json!([
        { "id": "list:workflows", "type": "list", "value": { "id": "workflows", "label": "Workflows", "row_type": "workflow-recipe", "title_field": "title",
            "fields": [{ "id": "title", "kind": "text" }, { "id": "recipe", "kind": "text" }, { "id": "definition", "kind": "text" }, { "id": "job", "kind": "text" }] } },
        { "id": "list:workflow-steps", "type": "list", "value": { "id": "workflow-steps", "label": "Workflow steps", "row_type": "workflow-step", "title_field": "title",
            "fields": [{ "id": "title", "kind": "text" }, { "id": "recipe", "kind": "tags" }, { "id": "step", "kind": "text" }, { "id": "position", "kind": "number" },
                { "id": "do", "kind": "text" }, { "id": "submit", "kind": "text" }, { "id": "checks", "kind": "text" }, { "id": "run_tool", "kind": "text" }] } }
    ])
}

#[tokio::test]
async fn a_recipe_row_whose_definition_is_json_text_runs() {
    let f = records_write_controls::started_fixture();
    let definition = json!({ "steps": [{ "id": "hand", "kind": "ask", "config": { "name": "agent:", "input": { "do": { "$kind": "binding", "values": ["input", "job"] } }, "context": { "title": "Hand it on" } } }], "edges": [] });
    let mut records = workflow_lists().as_array().unwrap().clone();
    records.push(json!({ "id": "record:workflow-recipe:made-up-text", "type": "record:workflow-recipe",
        "value": { "title": "Made up", "recipe": "workflow:made-up-text", "definition": definition.to_string(), "job": "Hand it on" } }));
    let (status, answer) = write(&f, "text-recipe", Value::Array(records)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = start_run(&f, "text-1", "workflow:made-up-text", json!({ "job": "say hello" })).await;
    assert_eq!(run["value"]["state"], "working", "{run}");
    assert_eq!(run["value"]["waiting"][0]["step_id"], "hand", "{run}");
    assert_eq!(run["value"]["waiting"][0]["asks"], "agent:", "{run}");
    assert_eq!(run["value"]["waiting"][0]["input"], json!({ "do": "say hello" }), "{run}");
}

#[tokio::test]
async fn a_recipe_row_with_no_definition_runs_its_step_rows_in_their_order() {
    let f = records_write_controls::started_fixture();
    let step = |name: &str, recipe: &str, position: u64| json!({ "id": format!("record:workflow-step:{recipe}--{name}"), "type": "record:workflow-step",
        "value": { "title": name, "recipe": [recipe], "step": name, "position": position, "do": format!("Do {name}"), "submit": "{\"type\":\"object\"}", "checks": "", "run_tool": "" } });
    let mut records = workflow_lists().as_array().unwrap().clone();
    records.push(json!({ "id": "record:workflow-recipe:made-up-steps", "type": "record:workflow-recipe",
        "value": { "title": "Made up", "recipe": "workflow:made-up-steps", "definition": "", "job": "Two steps" } }));
    // Written out of order, and beside a step of another recipe whose name starts the same.
    records.extend([step("second", "made-up-steps", 2), step("first", "made-up-steps", 1), step("other", "made-up-steps-too", 1)]);
    let (status, answer) = write(&f, "step-recipe", Value::Array(records)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = start_run(&f, "steps-1", "workflow:made-up-steps", json!({})).await;
    assert_eq!(run["value"]["state"], "working", "{run}");
    assert_eq!(run["value"]["waiting"][0]["step_id"], "first", "{run}");
    assert_eq!(run["value"]["waiting"][0]["input"]["do"], "Do first", "{run}");

    // Answered, it goes on to the second step, never to the other recipe's.
    let mut answered = run["value"].clone();
    answered["answers"] = json!({ "first": { "done": true } });
    let (status, answer) = write(&f, "steps-1-answer", json!([{ "id": "workflow-run:steps-1", "type": "workflow-run", "value": answered }])).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = read_back(&f, "records:read", json!({ "id": "workflow-run:steps-1" })).await;
    assert_eq!(run["value"]["waiting"][0]["step_id"], "second", "{run}");
}

#[tokio::test]
async fn a_recipe_row_that_cannot_be_read_fails_its_run_with_what_is_wrong() {
    let f = records_write_controls::started_fixture();
    let mut records = workflow_lists().as_array().unwrap().clone();
    records.push(json!({ "id": "record:workflow-recipe:made-up-bad", "type": "record:workflow-recipe",
        "value": { "title": "Made up", "recipe": "workflow:made-up-bad", "definition": "{not json", "job": "Broken" } }));
    let (status, answer) = write(&f, "bad-recipe", Value::Array(records)).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let run = start_run(&f, "bad-1", "workflow:made-up-bad", json!({})).await;
    assert_eq!(run["value"]["state"], "failed", "{run}");
    assert!(run["value"]["error"].as_str().is_some_and(|error| error.contains("not JSON")), "the run says what is wrong, not that the workflow is missing: {run}");
}
