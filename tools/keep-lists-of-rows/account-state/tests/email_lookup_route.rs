//! The operator's email lookup at two places: `POST /a/<operator>/sign-in/email-address` answers 202 `{}` for an email,
//! held or not, at the place that holds the operator account (the same answer for every email, so it shows no account); a
//! place that does not hold it answers 503 `not_held`, which the forwarder passes on. Both places start from their
//! config with a product whose sign-up hosting section names the account the first one made.

#[path = "computer_forwarder/fake_time.rs"]
mod test_time;
// This test uses a part of the shared harness; the rest is for tests/computer_forwarder.rs.
#[allow(dead_code)]
#[path = "support/computer_harness.rs"]
mod computer_harness;
#[path = "support/installed_tools.rs"]
mod installed_tools;
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
};
use computer_harness::*;
use serde_json::{json, Value};
use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use tower::ServiceExt as _;
use trillion_local::native_entry::computer::{read_config, Computer};

fn form_post(executor: &Executor, app: &axum::Router, path: &str, form: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::HOST, "computer.test")
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(form.to_owned()))
        .unwrap();
    executor.block_on(async {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    })
}

/// The two synthetic places of one operator: the first holds the operator account it made, the second holds nothing. The
/// product's settings name the operator for both. Returns the operator's address, the product settings file, and each
/// place's config.
fn operator_places(dir: &Path) -> (String, PathBuf, PathBuf, PathBuf) {
    let computer_key = dir.join("computer-key");
    let holding = computer_config(&dir.join("place"), &computer_key);
    let (owner, address) = create(&holding);
    installed_tools::install(&dir.join("place/accounts").join(&owner));
    let lacking = computer_config(&dir.join("other-place"), &computer_key);

    let settings = dir.join("product-settings.json");
    let mut product: Value = serde_json::from_str(include_str!("fixtures/product-settings.json")).unwrap();
    product["sign_up_hosting"] = json!({"operator_account": address, "hosting_computers": [{"origin": "https://computer.test"}]});
    fs::write(&settings, product.to_string()).unwrap();
    (address, settings, holding, lacking)
}

/// Runs one place's lookup in a child process: the product settings are read once per process, and this test's process has
/// already read the fixture's settings while it made the operator account.
fn place_lookup(config_path: &Path, address: &str, settings: &Path, expected: &str) {
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "a_place_child_answers_the_operator_lookup", "--nocapture"])
        .env("EMAIL_LOOKUP_CONFIG", config_path)
        .env("EMAIL_LOOKUP_ADDRESS", address)
        .env("EMAIL_LOOKUP_EXPECTED", expected)
        .env("PRODUCT_SETTINGS", settings)
        .status()
        .unwrap();
    assert!(child.success(), "the place's lookup answer was not {expected} (its refusal is logged above)");
}

#[test]
fn an_operator_lookup_of_an_unindexed_email_answers_202_at_a_place_that_holds_the_operator() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (address, settings, holding, _lacking) = operator_places(dir.path());
    place_lookup(&holding, &address, &settings, "202");
}

#[test]
fn an_operator_lookup_at_a_place_that_does_not_hold_the_operator_answers_not_held() {
    let dir = tempfile::tempdir_in(canonical_temp()).unwrap();
    let (address, settings, _holding, lacking) = operator_places(dir.path());
    place_lookup(&lacking, &address, &settings, "not_held");
}

#[test]
fn a_place_child_answers_the_operator_lookup() {
    let (Some(config_path), Some(address), Some(expected)) = (
        std::env::var_os("EMAIL_LOOKUP_CONFIG"),
        std::env::var("EMAIL_LOOKUP_ADDRESS").ok(),
        std::env::var("EMAIL_LOOKUP_EXPECTED").ok(),
    ) else {
        return;
    };
    let computer = Arc::new(Computer::start(read_config(Path::new(&config_path)).unwrap()).unwrap_or_else(|error| panic!("{error}")));
    let app = computer.app();
    let executor = two_threads();
    let (status, body) = form_post(&executor, &app, &format!("/a/{address}/sign-in/email-address"), "email=nobody%40example.com");
    let refused = serde_json::from_str::<Value>(&body).ok().and_then(|value| value.get("refused").and_then(Value::as_str).map(str::to_owned));
    match expected.as_str() {
        "202" => assert_eq!((status, body.as_str()), (StatusCode::ACCEPTED, "{}"), "{body}"),
        "not_held" => assert_eq!((status, refused.as_deref()), (StatusCode::SERVICE_UNAVAILABLE, Some("not_held")), "{body}"),
        other => panic!("unknown expected answer {other}"),
    }
}
