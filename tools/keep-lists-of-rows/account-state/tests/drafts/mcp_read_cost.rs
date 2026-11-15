// Complete synthetic selected-owner MCP reads. This observes current code;
// it neither changes product behavior nor asserts a desired cost.
use super::*;
use crate::{
    scan::ReadWork,
    sqlite_work::{Observation, StatementSnapshot, WorkMeter},
};
use std::{collections::BTreeMap, sync::Mutex};
use tower::ServiceExt;

fn difference(before: &ReadWork, after: &ReadWork) -> ReadWork {
    ReadWork {
        sql_statements: after
            .sql_statements
            .checked_sub(before.sql_statements)
            .unwrap(),
        sqlite_scan_visits: after
            .sqlite_scan_visits
            .checked_sub(before.sqlite_scan_visits)
            .unwrap(),
        fullscan_steps: after
            .fullscan_steps
            .checked_sub(before.fullscan_steps)
            .unwrap(),
        vm_steps: after.vm_steps.checked_sub(before.vm_steps).unwrap(),
        rows_returned: after
            .rows_returned
            .checked_sub(before.rows_returned)
            .unwrap(),
        rows_written: after.rows_written.checked_sub(before.rows_written).unwrap(),
    }
}
fn add(to: &mut ReadWork, value: &ReadWork) {
    to.sql_statements += value.sql_statements;
    to.sqlite_scan_visits += value.sqlite_scan_visits;
    to.fullscan_steps += value.fullscan_steps;
    to.vm_steps += value.vm_steps;
    to.rows_returned += value.rows_returned;
    to.rows_written += value.rows_written;
}
fn same(a: &ReadWork, b: &ReadWork) {
    assert_eq!(
        serde_json::to_value(a).unwrap(),
        serde_json::to_value(b).unwrap()
    );
}
fn family(template: &str) -> &'static str {
    let sql = template.to_ascii_lowercase();
    if sql.contains("sqlite_schema") || sql.contains("sqlite_master") {
        "schema_catalogue"
    } else if sql.contains("policy_directory") {
        "policy_directory"
    } else if sql.contains("account_control_state") {
        "gate_state"
    } else if sql.contains("account_control_usage") {
        "sign_in_usage"
    } else if sql.contains("_mf_entries") {
        "credential_kv_index"
    } else if sql.contains("workspace_records") {
        "workspace_records"
    } else if sql.trim_start().starts_with("pragma") {
        "connection_and_schema_pragmas"
    } else if ["begin", "commit", "rollback", "savepoint", "release"]
        .iter()
        .any(|s| sql.trim_start().starts_with(s))
    {
        "transaction_boundaries"
    } else {
        "other_unclassified"
    }
}
struct Probe {
    meter: WorkMeter,
    aggregate: Observation,
    statements: StatementSnapshot,
}
impl Probe {
    fn new(owner: &crate::native_boot::SelectedAccount) -> Self {
        // Wholly synthetic fixture; idle handles; only unexpanded SQL source
        // is inspected. Nothing is enabled on an original/live account.
        let meter = unsafe { owner.owner.enable_fixture_sql_attribution(512).unwrap() };
        let aggregate = meter.snapshot().unwrap();
        let statements = meter.fixture_statement_snapshot().unwrap();
        assert!(statements.complete);
        Self {
            meter,
            aggregate,
            statements,
        }
    }
    fn stage(&mut self, name: &str) -> Value {
        let aggregate = self.meter.snapshot().unwrap();
        let statements = self.meter.fixture_statement_snapshot().unwrap();
        assert_eq!(aggregate.active_statements, 0);
        assert!(
            statements.complete,
            "bounded statement capture must reconcile"
        );
        let total = difference(&self.aggregate.work, &aggregate.work);
        same(&total, &difference(&self.statements.work, &statements.work));
        let mut families: BTreeMap<&str, ReadWork> = BTreeMap::new();
        let mut sum = ReadWork::default();
        for row in &statements.statements {
            let zero = ReadWork::default();
            let before = self
                .statements
                .statements
                .iter()
                .find(|p| p.sql_template == row.sql_template)
                .map(|p| &p.work)
                .unwrap_or(&zero);
            let delta = difference(before, &row.work);
            add(
                families.entry(family(&row.sql_template)).or_default(),
                &delta,
            );
            add(&mut sum, &delta);
        }
        let unmatched = difference(
            &self.statements.unattributed_work,
            &statements.unattributed_work,
        );
        add(&mut sum, &unmatched);
        let schema_row_events = statements
            .unattributed_row_events
            .checked_sub(self.statements.unattributed_row_events)
            .unwrap();
        sum.rows_returned += schema_row_events;
        same(&sum, &total);
        let result = json!({
            "stage":name, "total":total, "redacted_query_families":families,
            "unmatched_statement_work":unmatched, "unmatched_schema_row_events":schema_row_events,
            "active_statements":aggregate.active_statements,
            "live_connections_before":self.aggregate.live_connections,
            "live_connections_after":aggregate.live_connections,
            "all_six_counters_reconcile":true
        });
        self.aggregate = aggregate;
        self.statements = statements;
        result
    }
}
fn rpc_request(
    fixture: &Fixture,
    protocol: &str,
    method: &str,
    params: Value,
) -> axum::http::Request<axum::body::Body> {
    let body = json!({"jsonrpc":"2.0","id":"cost-handshake","method":method,"params":params});
    axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Authorization", format!("Bearer {}", fixture.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol)
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}
fn one_label_request(
    fixture: &Fixture,
    key: &str,
    protocol: &str,
) -> axum::http::Request<axum::body::Body> {
    let mut body = json!({"jsonrpc":"2.0","id":key,"method":"tools/call","params":{
        "name":"run_resource_operation","arguments":{"address":"@own-records","method":"workspace:read",
        "request_key":key,"input":{"selection":{"labels":["saved-board"]}}}}});
    if protocol >= "2026-07-28" {
        body["params"]["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion":protocol,
            "io.modelcontextprotocol/clientInfo":{"name":"synthetic-whole-read-cost","version":"1"},
            "io.modelcontextprotocol/clientCapabilities":{}
        });
    }
    axum::http::Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("Host", "127.0.0.1:28788")
        .header("Authorization", format!("Bearer {}", fixture.token))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", protocol)
        .header("Mcp-Method", "tools/call")
        .header("Mcp-Name", "run_resource_operation")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn whole_mcp_single_record_cost_first_and_subsequent() {
    for protocol in ["2025-06-18", "2026-07-28"] {
        for initial_gate_state in ["already_admitted", "first_use_not_registered"] {
            let fixture = Fixture::new();
            if initial_gate_state == "first_use_not_registered" {
                for file in ["own.sqlite", "use.sqlite"] {
                    change_gate(&fixture, file, |state| {
                        state["sign_ins"] = json!({});
                    });
                }
                Connection::open(fixture.root.join("use.sqlite"))
                    .unwrap()
                    .execute("DELETE FROM account_control_usage", [])
                    .unwrap();
            }
            let selected = fixture.selected();
            // This is all work recorded since the actual selected source created
            // its meter. Synthetic fixture construction precedes that meter.
            let preparation = selected.sql_work().unwrap();
            assert_eq!(preparation.active_statements, 0);
            let preparation_report = json!({"stage":"selected_owner_preparation_since_meter_creation",
            "total":preparation.work,"observer_families":preparation.families,
            "live_connections":preparation.live_connections,
            "unmatched_schema_row_events":preparation.unattributed_row_events,
            "fixture_construction_sql_included":false,
            "pre_meter_sql_measured":false});
            let mut probe = Probe::new(&selected);
            let owner = Arc::new(Mutex::new(selected));
            let app =
                crate::native_boot::mcp_local::route_table(owner.clone(), "127.0.0.1:28788".into())
                    .unwrap();
            let mut stages = vec![probe.stage("router_construction")];
            if protocol == "2025-06-18" {
                let response = app.clone().oneshot(rpc_request(&fixture, protocol, "initialize", json!({
                "protocolVersion":protocol,"capabilities":{},"clientInfo":{"name":"synthetic-whole-read-cost","version":"1"}
            }))).await.unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::OK);
                let bytes = axum::body::to_bytes(response.into_body(), 65_536)
                    .await
                    .unwrap();
                let reply: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(reply["result"]["protocolVersion"], protocol);
                stages.push(probe.stage("legacy_initialize_request_and_consumed_body"));
            }
            let before_state = state(&fixture);
            for (index, key) in [
                "whole-read-first",
                "whole-read-subsequent",
                "whole-read-third",
            ]
            .iter()
            .enumerate()
            {
                let response = app
                    .clone()
                    .oneshot(one_label_request(&fixture, key, protocol))
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::OK);
                stages.push(probe.stage(&format!(
                    "read_{index}_authentication_operation_and_response_preparation"
                )));
                let (parts, body) = response.into_parts();
                assert!(
                    !parts
                        .headers
                        .contains_key(axum::http::header::CONTENT_LENGTH)
                );
                let bytes = axum::body::to_bytes(body, 65_536).await.unwrap();
                stages.push(probe.stage(&format!(
                    "read_{index}_actual_body_consumption_and_final_source_fence"
                )));
                let reply: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(reply["id"], *key);
                let result = &reply["result"]["structuredContent"];
                assert_eq!(result["status"], 200);
                assert_eq!(result["request_key"], *key);
                let canonical: Value =
                    serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
                assert_eq!(
                    canonical["records"],
                    json!({"saved-board":{"items":["kept"]}})
                );
                assert!(!String::from_utf8_lossy(&bytes).contains(&fixture.token));
                assert_eq!(
                    state(&fixture),
                    before_state,
                    "read keeps stored payload, record log and command journal unchanged"
                );
            }
            eprintln!(
                "WHOLE_MCP_SINGLE_RECORD_COST {}",
                json!({
                    "kind":"whole-mcp-single-record-cost/v1","protocol":protocol,
                    "initial_gate_state":initial_gate_state,
                    "scope":"current actual selected-owner axum/RMCP HTTP handler and consumed response body on a synthetic local one-label fixture; no real account, cloud, original app or provider bill",
                    "transport":"in-process HTTP service via tower oneshot; no TCP/TLS socket, DNS or remote connection measured",
                    "preparation":preparation_report,"stages":stages,
                    "modern_handshake":"2026-07-28 embeds stateless metadata in each call; no initialize request is issued",
                    "query_family_names_only":true
                })
            );
        }
    }
}
