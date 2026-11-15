//! Exercise the actual generic WorkshopRoute branch and ordinary current session admission with synthetic tools.
//! The existing route table names the fixture tool; no product route, listener or alternate executor is installed.
use super::*;

fn install_reply(f: &Fixture, result: Value) {
    // Integration tests link the library without main's composition root. Register the same
    // target binding as the real binary; a run still uses its ordinary sandbox and admission.
    #[cfg(tool_sandbox = "sbpl")]
    if let Some(binding) = computer_sandbox_sbpl::binding() {
        trillion_local::tool_runs::os::register(binding);
    }
    #[cfg(tool_sandbox = "landlock")]
    if let Some(binding) = computer_sandbox_landlock::binding() {
        trillion_local::tool_runs::os::register(binding);
    }
    let folder = f
        .records
        .parent()
        .unwrap()
        .join("workshop/tools/http-reply-fixture");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("tool-rows.json"), serde_json::to_vec(&json!({"records":[{"payload":{
        "kind":"ai-tool-descriptor", "id":"tool:answer-which-page-builds-may-keep-working",
        "label":"Synthetic response", "job":"Synthetic response transport control",
        "invoke":{"kind":"container","stdout":"json","argv":["sh","-c","printf '%s' \"$1\"","sh",result.to_string()]},
        "result_selector":"$"
    }}]})).unwrap()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn workshop_route_discloses_exact_text_download_bytes_and_safe_mime_headers() {
    let f = Fixture::new(&[]);
    let text = "BEGIN:VCALENDAR\r\nSUMMARY:Sample café\r\nEND:VCALENDAR\r\n";
    install_reply(
        &f,
        json!({"status":200,"body":text,"http":{"format":"text",
        "content_type":"text/calendar; charset=utf-8","download_name":"event.ics"}}),
    );
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/client-version", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/calendar; charset=utf-8"
    );
    assert_eq!(
        response.headers()[header::CONTENT_DISPOSITION],
        "attachment; filename=\"event.ics\""
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        response.headers()[header::X_CONTENT_TYPE_OPTIONS],
        "nosniff"
    );
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(bytes.as_ref(), text.as_bytes());
}

#[tokio::test(flavor = "multi_thread")]
async fn workshop_route_retains_legacy_json_encoding_and_empty_text_status() {
    for (result, expected_status, expected_type, expected_bytes) in [
        (
            json!({"status":201,"body":{"kept":true}}),
            StatusCode::CREATED,
            "application/json; charset=utf-8",
            b"{\"kept\":true}".as_slice(),
        ),
        (
            json!({"status":200,"body":"legacy JSON string"}),
            StatusCode::OK,
            "application/json; charset=utf-8",
            b"\"legacy JSON string\"".as_slice(),
        ),
        (
            json!({"status":204,"body":"","http":{"format":"text"}}),
            StatusCode::NO_CONTENT,
            "text/plain; charset=utf-8",
            b"".as_slice(),
        ),
    ] {
        let f = Fixture::new(&[]);
        install_reply(&f, result);
        let response = f
            .app
            .clone()
            .oneshot(request("GET", "/work/api/client-version", None))
            .await
            .unwrap();
        assert_eq!(response.status(), expected_status);
        assert_eq!(response.headers()[header::CONTENT_TYPE], expected_type);
        assert!(!response.headers().contains_key(header::CONTENT_DISPOSITION));
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        assert_eq!(bytes.as_ref(), expected_bytes);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn workshop_route_refuses_malformed_text_metadata_through_the_existing_bad_answer() {
    let f = Fixture::new(&[]);
    install_reply(
        &f,
        json!({"status":200,"body":"private fixture text","http":{"format":"text",
        "content_type":"text/plain\r\nSet-Cookie: injected"}}),
    );
    let response = f
        .app
        .clone()
        .oneshot(request("GET", "/work/api/client-version", None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/json; charset=utf-8"
    );
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    let failure: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(failure["error"].is_string());
    assert!(!String::from_utf8_lossy(&bytes).contains("private fixture text"));
}

