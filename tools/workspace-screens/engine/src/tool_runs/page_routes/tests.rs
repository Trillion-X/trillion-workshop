// src/tool_runs/page_routes/tests.rs
//
// The generic screen host's one screen and the Workshop routes' answer, ported from old trillion's tests at
// old-trillion-before-worker-retire: test/narrowed-screen-tree.test.mjs (whole), test/first-load-screen-routes.test.mjs
// (the screen host answering Get started, Progress, Plan and Connections from their reads), test/catalogue-screen-
// decision.test.mjs (the decision layout drawing every golden description, and the screen host's 404 and found and
// removed answers) and test/native-screen-host.test.mjs (a screen not in the catalogue is 404 {error: "Not found"},
// any other screen is its catalogue row as {surface}). Their screens are the tag's records/marketplace-screens.json
// rows, copied whole to tests/fixtures/screen-host/. Decision inputs and complete expected descriptions use
// engine-owned synthetic scenario text while retaining all seven branch cases. The evaluator is the real one
// (tools/formula-engine/crates/formula-engine).

use super::*;
use serde_json::json;

const SCREENS: &str = include_str!("../../../tests/fixtures/screen-host/marketplace-screens.json");
const DECISIONS: &str = include_str!("../../../tests/fixtures/screen-host/decision-descriptions.json");

fn screen_of(id: &str) -> Value {
    let rows: Value = serde_json::from_str(SCREENS).unwrap();
    let row = rows["tools"].as_array().unwrap().iter().find(|row| row["id"] == id).unwrap().clone();
    reads_screen(settings().unwrap(), &row).expect("a reads screen").clone()
}
fn ask(tool_id: &str, query: &str, browser: Value) -> ScreenAsk {
    ScreenAsk { tool_id: tool_id.into(), query: query_pairs(query).unwrap(), browser, account_id: "account-of-the-page".into() }
}
fn params(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[test]
fn a_deep_usage_row_opens_its_real_ancestor_chain_without_sibling_detail_or_charge_changes() {
    let s = settings().unwrap();
    let screen = json!({ "title": "Billing", "sections": [{ "id": "usage", "rows": [{ "id": "total", "title": "Usage", "detail": "$1.30", "children": [
        { "id": "storage", "title": "Storage", "children": [{ "id": "event", "title": "Observed source bytes", "detail": "$1.30", "actions": [{ "label": "Inspect" }] }] },
        { "id": "other", "title": "Other usage", "detail": "$9.00" },
    ] }] }] });
    let shown = narrowed_to(s, screen.clone(), &params(&[("show_row", "observed source bytes")]));
    let root = &shown["sections"][0]["rows"][0];
    assert_eq!(root["detail"], "$1.30");
    assert_eq!(root["starts_open"], true);
    assert_eq!(root["children"].as_array().unwrap().len(), 1);
    assert_eq!(root["children"][0]["starts_open"], true);
    assert_eq!(root["children"][0]["children"][0]["starts_open"], true);
    assert_eq!(root["children"][0]["children"][0]["actions"], json!([{ "label": "Inspect" }]));
    assert_eq!(screen["sections"][0]["rows"][0]["children"].as_array().unwrap().len(), 2, "the original description is not changed");
    assert_eq!(narrowed_to(s, screen.clone(), &params(&[("show_row", "no such detail")])), screen);
}

#[test]
fn a_narrowed_screen_keeps_the_section_asked_for_hides_its_header_and_says_it_is_narrowed() {
    let s = settings().unwrap();
    let screen = json!({ "title": "Account", "lead": "Your account.", "sections": [
        { "id": "logins", "rows": [{ "id": "login:1", "title": "Mail", "facts": { "user": "sam", "site": "https://www.Mail.example/in" } }], "catalog": {} },
        { "id": "other", "rows": [{ "id": "x", "title": "X" }] },
    ] });
    let section = narrowed_to(s, screen.clone(), &params(&[("show_section", " \"Logins\" ")]));
    assert_eq!(section["hide_header"], true);
    assert_eq!(section["narrowed"], json!({ "label": "Show all" }));
    assert!(section.get("lead").is_none());
    assert_eq!(section["sections"].as_array().unwrap().len(), 1);
    // A saved login is named by its site's host too, and one row shown drops its section's catalog.
    let row = narrowed_to(s, screen.clone(), &params(&[("show_row", "mail.example")]));
    assert_eq!(row["sections"][0]["rows"][0]["id"], "login:1");
    assert!(row["sections"][0].get("catalog").is_none());
    assert_eq!(narrowed_to(s, screen.clone(), &[]), screen, "an address that asks for nothing shows it as built");
}

#[test]
fn the_screen_host_answers_get_started_with_the_setup_reads_description_for_the_asking_browser() {
    let s = settings().unwrap();
    let description = json!({ "title": "Connect your AI to start", "lead": "Two steps.", "ready": false, "requirements": [], "sections": [] });
    let mut asked = Vec::new();
    let answer = describe(s, &screen_of("tool:get-started"),
        &ask("tool:get-started", "", json!({ "user_agent": "Mozilla/5.0 (iPhone)", "origin": "https://app.example" })),
        &mut |tool, input| { asked.push((tool.to_owned(), input.clone())); Ok(description.clone()) });
    assert_eq!(answer.status, 200);
    assert_eq!(answer.body["title"], description["title"]);
    assert_eq!(asked, vec![("tool:read-setup".to_owned(), json!({ "user_agent": "Mozilla/5.0 (iPhone)", "origin": "https://app.example" }))]);
}

#[test]
fn progress_plan_and_connections_each_pass_their_read_the_addresss_query_and_the_browsers_facts_and_answer_its_facts_whole() {
    let s = settings().unwrap();
    let browser = json!({ "user_agent": "Safari", "origin": "https://app.example", "visitor": "0123456789abcdef0123456789abcdef" });
    let cases = [
        ("tool:progress", "pursuit=p1", "tool:read-progress", json!({ "pursuit": "p1", "origin": "https://app.example" }), json!({ "kind": "pursuit", "id": "p1" })),
        ("tool:plan", "", "tool:read-plan", json!({ "visitor": "0123456789abcdef0123456789abcdef", "origin": "https://app.example" }), json!({ "offers": {}, "allowance": null })),
        ("tool:connections", "owned_after=c9", "tool:read-connections", json!({ "query": { "owned_after": "c9" }, "origin": "https://app.example" }), json!({ "lead": "Connect a service.", "sections": [] })),
    ];
    for (screen, query, tool, input, facts) in cases {
        let mut asked = Vec::new();
        let answer = describe(s, &screen_of(screen), &ask(screen, query, browser.clone()),
            &mut |id, given| { asked.push((id.to_owned(), given.clone())); Ok(facts.clone()) });
        assert_eq!(answer.status, 200, "{screen}");
        assert_eq!(asked, vec![(tool.to_owned(), input)], "{screen}");
        // The layout is one binding over the read, so its facts come whole, null fields too.
        assert_eq!(answer.body, facts, "{screen}");
    }
}

#[test]
fn look_is_a_reads_screen_with_no_reads_drawn_from_its_layout_alone() {
    let s = settings().unwrap();
    let screen = screen_of("tool:look");
    let answer = describe(s, &screen, &ask("tool:look", "", json!({})), &mut |_, _| panic!("Look reads nothing"));
    assert_eq!(answer.status, 200);
    assert_eq!(answer.body, screen["layout"]);
}

#[test]
fn the_decision_layout_draws_every_description_decision_screen_and_removed_decision_screen_drew() {
    let s = settings().unwrap();
    let screen = screen_of("tool:decision");
    let golden: Value = serde_json::from_str(DECISIONS).unwrap();
    for (index, one) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let context = json!({ "query": {}, "browser": {}, "reads": { "decision": one["facts"] } });
        assert_eq!(draw_layout(s, &screen["layout"], &context).unwrap(), one["description"], "case {index}");
    }
}

#[test]
fn a_decision_with_no_id_is_not_found_and_one_that_cannot_be_read_is_the_removed_decisions_screen() {
    let s = settings().unwrap();
    let screen = screen_of("tool:decision");
    let golden: Value = serde_json::from_str(DECISIONS).unwrap();
    let found_facts = golden["cases"][3]["facts"].clone();
    let mut read = |tool: &str, input: &Value| -> Result<Value, CodedError<String>> {
        assert_eq!(tool, "tool:read-decision");
        let id = input["id"].as_str().unwrap_or_default();
        Ok(if id == "case_1" { found_facts.clone() } else { json!({ "kind": "decision", "asked": !id.is_empty(), "found": false }) })
    };
    let none = describe(s, &screen, &ask("tool:decision", "", json!({})), &mut read);
    let missing_cause = crate::refusal_cause::Cause::from_wire(none.body["cause"].as_str().unwrap()).unwrap();
    assert_eq!(missing_cause.file(), "src/tool_runs/page_routes.rs");
    assert_eq!(none, Answer { status: 404, body: json!({ "error": "Not found", "cause": missing_cause.id() }) });
    assert_eq!(describe(s, &screen, &ask("tool:decision", "id=", json!({})), &mut read).status, 404);
    let found = describe(s, &screen, &ask("tool:decision", "id=case_1", json!({})), &mut read);
    assert_eq!(found.status, 200);
    assert_eq!(found.body["title"], golden["cases"][3]["description"]["title"]);
    let removed = describe(s, &screen, &ask("tool:decision", "id=case_2", json!({})), &mut read);
    assert_eq!(removed.status, 200);
    assert_eq!(removed.body["title"], "This decision is gone");
}

#[test]
fn a_read_that_fails_answers_502_with_its_words() {
    let s = settings().unwrap();
    let cause = crate::cause!(condition: synthetic_plan_read_refused);
    let answer = describe(s, &screen_of("tool:plan"), &ask("tool:plan", "", json!({})), &mut |_, _| Err(CodedError::with_cause("The plan could not be read.".to_owned(), cause.clone())));
    assert_eq!(answer, Answer { status: 502, body: json!({ "error": "The plan could not be read.", "cause": cause.id() }) });
}

#[test]
fn a_screen_id_is_its_tool_id_and_an_empty_or_nested_one_names_no_screen() {
    let s = settings().unwrap();
    assert_eq!(screen_tool_id(s, "tool%3Adrives").as_deref(), Some("tool:drives"));
    assert_eq!(screen_tool_id(s, "tool:drives").as_deref(), Some("tool:drives"));
    assert_eq!(screen_tool_id(s, "look").as_deref(), Some("tool:look"));
    assert_eq!(screen_tool_id(s, ""), None);
    assert_eq!(screen_tool_id(s, "a%2Fb"), None);
    assert_eq!(screen_tool_id(s, "a/b"), None);
}

#[test]
fn a_screen_not_in_the_catalogue_is_not_found_and_any_other_is_its_catalogue_row() {
    let s = settings().unwrap();
    let missing = surface_answer(s, None);
    let cause = crate::refusal_cause::Cause::from_wire(missing.body["cause"].as_str().unwrap()).unwrap();
    assert_eq!(cause.file(), "src/tool_runs/page_routes.rs");
    assert_eq!(missing, Answer { status: 404, body: json!({ "error": "Not found", "cause": cause.id() }) });
    let row = json!({ "id": "tool:private-screen", "surface_input": { "tool_id": "tool:private-screen" } });
    assert_eq!(surface_answer(s, Some(row.clone())), Answer { status: 200, body: json!({ "surface": row }) });
    // A row whose screen is not a reads screen is drawn by the catalogue, not here.
    assert!(reads_screen(s, &json!({ "id": "tool:x", "screen": { "kind": "module" } })).is_none());
}

#[test]
fn a_workshop_route_answers_its_tools_status_and_body_and_a_failed_run_502() {
    let s = settings().unwrap();
    let ran = run_result(s, &json!({ "tool": "tool:t", "exit_code": 0, "result": { "status": 201, "body": { "kept": true } }, "replayed": false }));
    assert_eq!(route_answer(s, ran, None), Answer { status: 201, body: json!({ "kept": true }) });
    let failed = run_result(s, &json!({ "tool": "tool:t", "exit_code": 1, "error": "no such case", "replayed": false }));
    let cause = failed.as_ref().unwrap_err().cause();
    assert_eq!(route_answer(s, failed, None), Answer { status: 502, body: json!({ "error": "no such case", "cause": cause.id() }) });
    for wrong in [json!({ "body": {} }), json!({ "status": 99, "body": {} }), json!({ "status": 200 }), json!("text")] {
        assert_eq!(route_answer(s, Ok(wrong.clone()), None).status, 502, "{wrong}");
    }
}

#[test]
fn a_query_reads_as_url_search_params_does() {
    let pairs = query_pairs("a=1&b=two+words&a=3&c").unwrap();
    assert_eq!(first(&pairs, "a"), Some("1"));
    assert_eq!(query_object(&pairs), json!({ "a": "3", "b": "two words", "c": "" }));
}

/// Round 2 contract B: a screen read's input binds the page's admitted account like any context field, and so may
/// the layout; the account is the one the owner admitted, never the address's.
#[test]
fn a_screen_read_binds_the_pages_admitted_account() {
    let s = settings().unwrap();
    let account = json!({"$kind": "binding", "select": {"from": "self", "path": ["account_id"]}});
    let screen = json!({"kind": "reads", "reads": [{"id": "setup", "tool": "tool:see-what-is-left-to-set-up",
        "input": {"account_id": account, "system": "mac"}}],
        "layout": {"title": "Get started", "for": account}});
    let mut asked = Vec::new();
    let answer = describe(s, &screen, &ask("tool:get-started", "account_id=someone-else", json!({})),
        &mut |tool, input| { asked.push((tool.to_owned(), input.clone())); Ok(json!({})) });
    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(asked, vec![("tool:see-what-is-left-to-set-up".to_owned(), json!({"account_id": "account-of-the-page", "system": "mac"}))]);
    assert_eq!(answer.body["for"], "account-of-the-page", "the query's account_id is not the account");
}

/// Round 2 contract B: a Workshop route tool's input carries the page's admitted account, set over anything the
/// request held.
#[test]
fn a_route_tools_input_carries_the_pages_admitted_account() {
    let s = settings().unwrap();
    let request = json!({"path": "/x", "method": "POST", "query": {}, "body": {"account_id": "b"}, "browser": {}, "account_id": "forged"});
    let given = with_account(s, request, "account-of-the-page");
    assert_eq!(given, json!({"path": "/x", "method": "POST", "query": {}, "body": {"account_id": "b"}, "browser": {}, "account_id": "account-of-the-page"}));
}

#[test]
fn layout_and_reads_refusals_keep_their_distinct_source_conditions() {
    let s = settings().unwrap();
    let layout = draw_layout(s, &json!({"$kind":"join","of":"synthetic-private-value"}), &json!({})).unwrap_err();
    let read_shape = described(s, &json!({"reads":"synthetic-private-value"}), &ask("tool:t", "", json!({})),
        &mut |_, _| unreachable!("invalid reads do not run a tool")).unwrap_err();
    assert_eq!(layout.code, read_shape.code);
    assert_ne!(layout.cause(), read_shape.cause());
    for error in [layout, read_shape] {
        assert_eq!(error.cause().file(), "src/tool_runs/page_routes.rs");
        assert!(!error.cause().id().contains("synthetic-private-value"));
    }
}

#[test]
fn a_rejected_http_reply_keeps_its_source_while_retaining_the_route_words() {
    let s = settings().unwrap();
    let cause = crate::cause!(condition: synthetic_http_reply_not_accepted);
    let reply = route_answer(s, Ok(Value::Null), Some(cause.clone()));
    assert_eq!(reply.status, 502);
    assert_eq!(reply.body, json!({"error":s.route.not_an_answer,"cause":cause.id()}));
}
