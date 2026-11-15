// Raw selected-Mac connection cases for parent currentness. These are not HTTP
// or rmcp client tests; the message contains only the original nm_ request key.
use super::*;
use super::current_state as state;
use crate::{
    native_boot::{forwarder_connection::SelectedMacDispatcher, mcp_selected_personal::oauth_authority::OAuthAuthority},
    resource_authority::{InvokeMessage, Route},
};
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};

fn selected_now_ms() -> i64 { i64::try_from(millis()).unwrap() }

fn selected_message(fixture: &Fixture, route: &Route, request_key: &str) -> Vec<u8> {
    serde_json::to_vec(&InvokeMessage { person_present: None,
        request_id: request_key.to_owned(),
        operation_resource: None,
        account_id: route.account_id.clone(),
        device_id: route.device_id.clone(),
        resource_address: route.resource_address.clone(),
        generation: route.generation.clone(),
        operation: "workspace:write".into(),
        input: input(),
        request_key: request_key.to_owned(),
        client_authorization: fixture.token.clone(),
        deadline_at_ms: selected_now_ms() + 10_000,
    }).unwrap()
}

fn selected_dispatcher(
    fixture: &Fixture,
    authority: Arc<OAuthAuthority>,
    parent_current: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent,
) -> SelectedMacDispatcher {
    fixture.prepare_current_own_records();
    SelectedMacDispatcher::new_with_oauth(
        Arc::new(Mutex::new(fixture.selected())), route(), authority, parent_current, selected_now_ms,
    ).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selected_nm_write_withholds_result_when_parent_withdraws_at_final_custody() {
    let calibration = Fixture::new();
    let calibration_issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&calibration));
    let calibration_calls = Arc::new(AtomicUsize::new(0));
    let count_callback = {
        let calls = calibration_calls.clone();
        Arc::new(move || { calls.fetch_add(1, Ordering::AcqRel); true })
    };
    let dispatcher = selected_dispatcher(&calibration, calibration_issuer.authority.clone(), count_callback);
    let calibration_bytes = dispatcher.dispatch(&selected_message(&calibration, &route(), "nm-parent-calibration"))
        .await.unwrap();
    assert!(String::from_utf8_lossy(calibration_bytes.as_ref()).contains("written"));
    let successful_checks = calibration_calls.load(Ordering::Acquire);
    assert!(successful_checks > 2, "parent currentness must cover operation and retained output");

    let fixture = Fixture::new();
    let issuer = Arc::new(super::oauth_test_support::SyntheticOAuthIssuer::new(&fixture));
    fixture.prepare_current_own_records();
    let calls = Arc::new(AtomicUsize::new(0));
    let parent_current = {
        let calls = calls.clone();
        Arc::new(move || calls.fetch_add(1, Ordering::AcqRel) + 1 < successful_checks)
    };
    let before = state(&fixture);
    let dispatcher = selected_dispatcher(&fixture, issuer.authority.clone(), parent_current);
    let result = dispatcher.dispatch(&selected_message(&fixture, &route(), "nm-parent-withheld"))
        .await;
    assert!(result.is_err(), "withdrawn parent currentness must block protected result release");
    let after = state(&fixture);
    assert!(after.0.contains("written"), "the original write committed before final withdrawal");
    assert!(after.1 > before.1, "the original journal records the durable commit");
    assert_eq!(after.2, before.2 + 1, "withholding the result must not replay the command");
    assert_eq!(calls.load(Ordering::Acquire), successful_checks,
        "withdrawal should be observed at the calibrated final custody boundary");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_selected_nm_write_works_without_gateway_or_hosting_credential() {
    let fixture = Fixture::new();
    fixture.prepare_current_own_records();
    let before = state(&fixture);
    let dispatcher = SelectedMacDispatcher::new(
        Arc::new(Mutex::new(fixture.selected())), route(), selected_now_ms,
    ).unwrap();
    let result = dispatcher.dispatch(&selected_message(&fixture, &route(), "nm-direct-local-write"))
        .await.unwrap();
    assert!(String::from_utf8_lossy(result.as_ref()).contains("written"));
    assert_eq!(state(&fixture).2, before.2 + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_personal_nm_dispatcher_requires_parent_current_without_oauth() {
    let fixture = Fixture::new();
    fixture.prepare_current_own_records();
    let before = state(&fixture);
    let withdrawn: crate::native_boot::mcp_selected_personal::oauth_policy_witness::ParentConnectionCurrent =
        Arc::new(|| false);
    let dispatcher = SelectedMacDispatcher::new_with_parent_current(
        Arc::new(Mutex::new(fixture.selected())), route(), withdrawn, selected_now_ms,
    ).unwrap();
    let result = dispatcher.dispatch(&selected_message(&fixture, &route(), "nm-parent-required"))
        .await.unwrap();
    let refusal: serde_json::Value = serde_json::from_slice(result.as_ref()).unwrap();
    assert_eq!(refusal["state"], "refused");
    assert_eq!(refusal["code"], "resource_connection_withdrawn");
    assert_eq!(state(&fixture).2, before.2, "withdrawn parent must prevent the write");
}
