//! Consumer controls using captured original renderer bytes and synthetic account
//! owners. These fixtures do not constitute an installed account or live mount.
use trillion_local::{mcp, mcp_apps as apps};
use content_crypto::advanced::blake3;

use apps::*;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
};

const ORIGINAL_DOCUMENT: &[u8] = include_bytes!("fixtures/mcp-app-resource/screen.html");
const ORIGINAL_RESOURCE: &[u8] = include_bytes!("fixtures/mcp-app-resource/resource.json");
const ORIGINAL_DOCUMENT_PIN: &str =
    "f84c201981f0233569623102d781a9738ebf181fa5d6d9c4a1822452d09daf22";
const CURRENT_DOCUMENT: &[u8] = include_bytes!("fixtures/mcp-app-resource-current-c/screen.html");
const CURRENT_RESOURCE: &[u8] = include_bytes!("fixtures/mcp-app-resource-current-c/resource.json");
const CURRENT_DOCUMENT_PIN: &str =
    "485722756f8558c0c0b4c25e6540a267642087323f5e865ed5f1e4363ff7b25f";
fn data() -> &'static [u8] {
    include_bytes!("fixtures/screen-view.json")
}
fn config() -> Config {
    Config::from_data(
        data(),
        &blake3::hash(data()).to_hex().to_string(),
        Names {
            show: "show_screen".into(),
            read: "screen_read".into(),
            screen_key: "trillion/screen".into(),
        },
    )
    .unwrap()
}
fn principal() -> mcp::Principal {
    mcp::Principal { kind: trillion_local::mcp::PrincipalKind::Person,
        account_id: "account:fixture".into(),
        sign_in: "key:fixture".into(),
        client_id: "client:fixture".into(),
    }
}
fn with_context<T>(f: impl FnOnce(Context<'_>) -> T) -> T {
    f(Context {
        principal: &principal(),
        bearer: b"fixture-only-secret",
        disclosure: &RequestDisclosure::default(),
    })
}
#[derive(Default)]
struct Fixture {
    guards: Mutex<Vec<Box<dyn FinalBodyCustody>>>,
    cancel_seen: Mutex<Option<std::sync::Arc<AtomicBool>>>,
    admissions: AtomicUsize,
    documents: AtomicUsize,
    calls: AtomicUsize,
    revoked: AtomicBool,
    current_document: AtomicBool,
    answer: Mutex<Option<WorkspaceAnswer>>,
    carried_key: Mutex<Option<String>>,
    seen: Mutex<Option<(String, String, Vec<u8>, bool, Option<String>, String)>>,
}
impl Owner for Fixture {
    fn admit_view(&self, ctx: &Context<'_>) -> Result<(), Failure> {
        assert_eq!(ctx.principal.account_id, "account:fixture");
        assert_eq!(ctx.bearer, b"fixture-only-secret");
        self.admissions.fetch_add(1, Ordering::SeqCst);
        if self.revoked.load(Ordering::SeqCst) {
            Err(Failure::unavailable(trillion_local::cause!(mcp_apps unavailable)))
        } else {
            Ok(())
        }
    }
    fn screen(&self, ctx: &Context<'_>, asked: &str, input: Value) -> Result<Screen, Failure> {
        assert_eq!(ctx.principal.account_id, "account:fixture");
        assert_eq!(ctx.bearer, b"fixture-only-secret");
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.revoked.load(Ordering::SeqCst) {
            return Err(Failure::unavailable(trillion_local::cause!(mcp_apps unavailable)));
        }
        Ok(Screen {
            id: "fixture.selected".into(),
            label: "Selected fixture".into(),
            address: Some(asked.into()),
            input,
            whole: false,
            focused: true,
        })
    }
    fn workspace(
        &self,
        ctx: &Context<'_>,
        request: WorkspaceRequest,
    ) -> Result<WorkspaceAnswer, Failure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(ctx.bearer, b"fixture-only-secret");
        assert!(!request.headers().contains_key("authorization"));
        assert!(!request.headers().contains_key("cookie"));
        assert!(!request.headers().contains_key("host"));
        *self.carried_key.lock().unwrap() = request
            .headers()
            .get("idempotency-key")
            .map(|value| value.to_str().unwrap().to_owned());
        assert_eq!(request.headers()["accept"], "application/json");
        assert_eq!(request.headers()["x-time-zone"], "America/Los_Angeles");
        self.seen.lock().unwrap().replace((
            request.path().into(),
            request.method().to_string(),
            request.body().to_vec(),
            request.patchable(),
            request.have().map(str::to_owned),
            ctx.principal.sign_in.clone(),
        ));
        if self.revoked.load(Ordering::SeqCst) {
            return Err(Failure::unavailable(trillion_local::cause!(mcp_apps unavailable)));
        }
        *self.cancel_seen.lock().unwrap() = Some(ctx.cancellation_flag());
        for guard in self.guards.lock().unwrap().drain(..) {
            ctx.retain_disclosure(guard)?;
        }
        Ok(self
            .answer
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| WorkspaceAnswer {
                status: 200,
                content_type: "application/json".into(),
                body: br#"{"z":1,"a":2}"#.to_vec(),
                request_key: None,
            }))
    }
    fn document(&self, _: &Context<'_>) -> Result<Document, Failure> {
        self.documents.fetch_add(1, Ordering::SeqCst);
        if self.revoked.load(Ordering::SeqCst) {
            return Err(Failure::unavailable(trillion_local::cause!(mcp_apps unavailable)));
        }
        let (bytes, pin, metadata) = if self.current_document.load(Ordering::SeqCst) {
            (CURRENT_DOCUMENT, CURRENT_DOCUMENT_PIN, CURRENT_RESOURCE)
        } else {
            (ORIGINAL_DOCUMENT, ORIGINAL_DOCUMENT_PIN, ORIGINAL_RESOURCE)
        };
        let resource: Value = serde_json::from_slice(metadata).unwrap();
        Document::from_pinned(bytes, pin, resource["_meta"].clone())
    }
}
fn request(path: &str) -> Value {
    json!({"path":path,"headers":{"x-time-zone":"America/Los_Angeles"}})
}
fn call(owner: &dyn Owner, input: Value) -> Result<Value, Failure> {
    with_context(|context| {
        config()
            .call_tool(owner, &context, "screen_read", input)
            .unwrap()
    })
}

#[test]
fn existing_host_metadata_and_original_document_contract_are_preserved() {
    let config = config();
    let tools = config.tools();
    assert_eq!(
        tools[0]["_meta"]["ui"]["resourceUri"],
        "ui://trillion/screen.html"
    );
    assert_eq!(
        tools[0]["_meta"]["openai/outputTemplate"],
        tools[0]["_meta"]["ui"]["resourceUri"]
    );
    assert_eq!(tools[1]["_meta"]["ui"]["visibility"], json!(["app"]));
    assert_eq!(tools[1]["_meta"]["openai/widgetAccessible"], true);
    assert_eq!(tools[1]["_meta"]["openai/visibility"], "private");
    assert_eq!(
        config.resources()[0]["mimeType"],
        "text/html;profile=mcp-app"
    );
    let answer = with_context(|ctx| {
        config
            .read_resource(&Fixture::default(), &ctx, "ui://trillion/screen.html")
            .unwrap()
            .unwrap()
    });
    assert!(ORIGINAL_DOCUMENT.len() > 65536);
    assert_eq!(
        answer["contents"][0]["text"].as_str().unwrap().as_bytes(),
        ORIGINAL_DOCUMENT
    );
    assert_eq!(
        answer["contents"][0]["_meta"]["ui"]["csp"]["resourceDomains"],
        json!(["https://trillion-screen-origin.invalid"])
    );
    let too_large = vec![b'x'; 1024 * 1024 + 1];
    assert!(Document::from_pinned(
        &too_large,
        &blake3::hash(&too_large).to_hex().to_string(),
        json!({})
    )
    .is_err());
}

/// Original screenFor returns null when a real row has no browser route.
/// The chat mounts by id/input; an absent browser link must remain absent.
#[test]
fn valid_screen_without_browser_address_preserves_null_without_inventing_route() {
    struct Selection(Option<String>);
    impl Owner for Selection {
        fn admit_view(&self, _: &Context<'_>) -> Result<(), Failure> {
            Ok(()) // Explicit synthetic fixture; not production authority.
        }
        fn screen(&self, _: &Context<'_>, _: &str, input: Value) -> Result<Screen, Failure> {
            Ok(Screen {
                id: "fixture.unrouted".into(),
                label: "Unrouted screen".into(),
                address: self.0.clone(),
                input,
                whole: false,
                focused: false,
            })
        }
        fn workspace(
            &self,
            _: &Context<'_>,
            _: WorkspaceRequest,
        ) -> Result<WorkspaceAnswer, Failure> {
            panic!("opening a selected screen must not dispatch workspace work")
        }
        fn document(&self, _: &Context<'_>) -> Result<Document, Failure> {
            panic!("opening a selected screen must not reread the document")
        }
    }
    let run = |address: Option<String>| {
        with_context(|ctx| {
            config()
                .call_tool(
                    &Selection(address),
                    &ctx,
                    "show_screen",
                    json!({"screen":"fixture.unrouted","input":{"draft":"retained"}}),
                )
                .unwrap()
        })
    };
    let result = run(None).unwrap();
    assert_eq!(result["_meta"]["trillion/screen"]["id"], "fixture.unrouted");
    assert_eq!(
        result["_meta"]["trillion/screen"]["input"],
        json!({"draft":"retained"})
    );
    for address in [
        &result["_meta"]["trillion/screen"]["address"],
        &result["structuredContent"]["address"],
        &result["structuredContent"]["open_path"],
    ] {
        assert_eq!(address, &Value::Null);
    }
    let valid = run(Some("/screen?draft=retained".into())).unwrap();
    assert_eq!(
        valid["structuredContent"]["open_path"],
        "/screen?draft=retained"
    );
    for address in [
        "",
        "relative",
        "https://other.invalid/screen",
        "//other.invalid/screen",
        "/screen\\escape",
        "/screen\rheader",
        "/screen\nheader",
    ] {
        assert_unavailable(run(Some(address.into())).unwrap_err());
    }
    assert_unavailable(run(Some(format!("/{}", "x".repeat(8192)))).unwrap_err());
}

#[test]
fn returned_owner_screen_opens_in_same_result_without_extra_discovery() {
    let owner = Fixture::default();
    let result = with_context(|ctx| {
        config()
            .call_tool(
                &owner,
                &ctx,
                "show_screen",
                json!({"screen":"/use/tool%3Afixture/row","input":{"row":"one","draft":{"z":1}}}),
            )
            .unwrap()
            .unwrap()
    });
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        result["_meta"]["trillion/screen"]["input"]["draft"],
        json!({"z":1})
    );
    assert_eq!(
        result["_meta"]["trillion/screen"]["presentation"],
        "focused"
    );
    assert_eq!(
        result["structuredContent"]["open_path"],
        "/use/tool%3Afixture/row"
    );
    assert!(!result.to_string().contains("fixture-only-secret"));
}

#[test]
fn changed_current_owner_refuses_instead_of_publishing_stale_screen_or_document() {
    let owner = Fixture::default();
    owner.revoked.store(true, Ordering::SeqCst);
    with_context(|ctx| {
        assert_unavailable(config()
                .call_tool(&owner, &ctx, "show_screen", json!({"screen":"/home"}))
                .unwrap()
                .unwrap_err());
        assert_unavailable(config()
                .read_resource(&owner, &ctx, "ui://trillion/screen.html")
                .unwrap()
                .unwrap_err());
    });
}

#[test]
fn body_bytes_route_query_and_authenticated_identity_reach_same_owner_once() {
    let owner = Fixture::default();
    let mut input = request("/work/api/records?after=a%2Fb&order=z");
    input["method"] = json!("post");
    input["text"] = json!("{\"until\":\"later\",\"reason\":\"keep order\"}");
    input["headers"]["Authorization"] = json!("forged");
    input["headers"]["cookie"] = json!("forged");
    input["headers"]["host"] = json!("other.invalid");
    input["headers"]["idempotency-key"] = json!("same-original-command");
    let result = call(&owner, input).unwrap();
    assert_eq!(result["structuredContent"]["text"], "{\"z\":1,\"a\":2}");
    let seen = owner.seen.lock().unwrap();
    let seen = seen.as_ref().unwrap();
    assert_eq!(seen.0, "/work/api/records?after=a%2Fb&order=z");
    assert_eq!(seen.1, "POST");
    assert_eq!(seen.2, br#"{"until":"later","reason":"keep order"}"#);
    assert_eq!(seen.5, "key:fixture");
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        owner.carried_key.lock().unwrap().as_deref(),
        Some("same-original-command")
    );
}

#[test]
fn excluded_routes_encodings_and_authority_fields_never_reach_workspace_owner() {
    let owner = Fixture::default();
    for path in [
        "https://other.invalid/work/api/records",
        "//other.invalid/work/api/records",
        "/work/api/account/keys",
        "/work/api/%61ccount/keys",
        "/work/api/%2e%2e/account/keys",
        "/work/api/../records",
        "/work/api/logins/x",
        "/work/api/devices/x",
        "/work/api//records",
        "/work/api/records#fragment",
    ] {
        assert_eq!(
            call(&owner, request(path)).unwrap()["structuredContent"]["status"],
            400,
            "accepted {path}"
        );
    }
    let mut input = request("/work/api/records");
    input["account_id"] = json!("another");
    assert_eq!(
        call(&owner, input).unwrap()["structuredContent"]["status"],
        400
    );
    assert_eq!(owner.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn ordinary_collection_route_and_full_patchable_reply_remain_usable() {
    let owner = Fixture::default();
    for path in [
        "/work/api/account",
        "/work/api/namespace/files/%2FFunnels%2Fsales.json",
        "/work/api/namespace/files/100%25done.txt",
    ] {
        assert_eq!(
            call(&owner, request(path)).unwrap()["structuredContent"]["status"],
            200
        );
        assert_eq!(owner.seen.lock().unwrap().as_ref().unwrap().0, path);
    }
    let mut input = request("/work/api/records/");
    input["patchable"] = json!(true);
    input["have"] = json!("old-view-identity");
    let result = call(&owner, input).unwrap();
    assert_eq!(result["structuredContent"]["text"], "{\"z\":1,\"a\":2}");
    assert!(result["structuredContent"].get("patch").is_none());
    let seen = owner.seen.lock().unwrap();
    assert!(seen.as_ref().unwrap().3);
    assert_eq!(
        seen.as_ref().unwrap().4.as_deref(),
        Some("old-view-identity")
    );
}

#[test]
fn binary_payload_and_base64_request_keep_exact_bytes() {
    let owner = Fixture::default();
    owner.answer.lock().unwrap().replace(WorkspaceAnswer {
        status: 206,
        content_type: "application/octet-stream".into(),
        body: vec![0, 255, 128, 1],
        request_key: None,
    });
    let mut input = request("/work/api/namespace/bytes/fixture");
    input["method"] = json!("PUT");
    input["base64"] = json!("AP+AAQ==");
    let result = call(&owner, input).unwrap();
    assert_eq!(result["structuredContent"]["base64"], "AP+AAQ==");
    assert_eq!(
        owner.seen.lock().unwrap().as_ref().unwrap().2,
        vec![0, 255, 128, 1]
    );
}

#[test]
fn head_discards_body_and_preserves_actual_status() {
    let owner = Fixture::default();
    owner.answer.lock().unwrap().replace(WorkspaceAnswer {
        status: 404,
        content_type: "text/plain".into(),
        body: b"missing".to_vec(),
        request_key: None,
    });
    let mut input = request("/work/api/records/fixture");
    input["method"] = json!("HEAD");
    input["text"] = json!("must not send");
    let result = call(&owner, input).unwrap();
    assert_eq!(result["structuredContent"]["status"], 404);
    assert!(result["structuredContent"].get("text").is_none());
    assert!(owner.seen.lock().unwrap().as_ref().unwrap().2.is_empty());
}

#[test]
fn bad_program_pin_or_credential_header_data_refuses_at_construction() {
    assert!(Config::from_data(
        data(),
        &"0".repeat(64),
        Names {
            show: "show".into(),
            read: "read".into(),
            screen_key: "screen".into()
        }
    )
    .is_err());
    let mut data: Value = serde_json::from_slice(data()).unwrap();
    data["reads"]["headers"] = json!(["authorization"]);
    let bytes = serde_json::to_vec(&data).unwrap();
    assert!(Config::from_data(
        &bytes,
        &blake3::hash(&bytes).to_hex().to_string(),
        Names {
            show: "show".into(),
            read: "read".into(),
            screen_key: "screen".into()
        }
    )
    .is_err());
    assert!(Document::from_pinned(b"fixture", &"0".repeat(64), json!({})).is_err());
}

#[test]
fn another_composition_uses_same_adapter_without_product_name_branch() {
    let config = Config::from_data(
        data(),
        &blake3::hash(data()).to_hex().to_string(),
        Names {
            show: "open_panel".into(),
            read: "panel_read".into(),
            screen_key: "example/panel".into(),
        },
    )
    .unwrap();
    assert_eq!(config.tools()[0]["name"], "open_panel");
    with_context(|ctx| {
        assert!(config
            .call_tool(
                &Fixture::default(),
                &ctx,
                "show_screen",
                json!({"screen":"/home"})
            )
            .is_none());
        assert!(config
            .read_resource(&Fixture::default(), &ctx, "ui://other/document")
            .is_none());
        let result = config
            .call_tool(
                &Fixture::default(),
                &ctx,
                "open_panel",
                json!({"screen":"/home"}),
            )
            .unwrap()
            .unwrap();
        assert!(result["_meta"].get("example/panel").is_some());
    });
}

#[test]
fn oversized_input_refuses_before_owner_and_oversized_result_stays_unknown() {
    let owner = Fixture::default();
    let mut input = request("/work/api/records");
    input["method"] = json!("POST");
    input["text"] = json!("x".repeat(65536));
    assert_eq!(
        call(&owner, input).unwrap()["structuredContent"]["status"],
        400
    );
    assert_eq!(owner.calls.load(Ordering::SeqCst), 0);
    owner.answer.lock().unwrap().replace(WorkspaceAnswer {
        status: 200,
        content_type: "text/plain".into(),
        body: vec![b'x'; 65536],
        request_key: Some("original-key".into()),
    });
    let result = call(&owner, request("/work/api/records")).unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["status"], 409);
    let failure: Value =
        serde_json::from_str(result["structuredContent"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(failure["outcome"], "unknown");
    assert_eq!(failure["request_key"], "original-key");
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn lost_large_reply_does_not_replay_committed_write_and_reopen_reads_same_fact() {
    struct SqlOwner {
        path: std::path::PathBuf,
        calls: AtomicUsize,
    }
    impl Owner for SqlOwner {
        fn admit_view(&self, _: &Context<'_>) -> Result<(), Failure> {
            Ok(()) // Explicit synthetic fixture; not production authority.
        }
        fn screen(&self, _: &Context<'_>, _: &str, _: Value) -> Result<Screen, Failure> {
            Err(Failure::unavailable(trillion_local::cause!(mcp_apps unavailable)))
        }
        fn document(&self, _: &Context<'_>) -> Result<Document, Failure> {
            Err(Failure::unavailable(trillion_local::cause!(mcp_apps unavailable)))
        }
        fn workspace(
            &self,
            _: &Context<'_>,
            request: WorkspaceRequest,
        ) -> Result<WorkspaceAnswer, Failure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let db = rusqlite::Connection::open(&self.path).unwrap();
            db.execute("UPDATE fixture SET body=?1", [request.body()])
                .unwrap();
            Ok(WorkspaceAnswer {
                status: 200,
                content_type: "text/plain".into(),
                body: vec![b'x'; 70000],
                request_key: Some("retained-command".into()),
            })
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("fixture.sqlite");
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE fixture(body BLOB); INSERT INTO fixture VALUES(X'');")
            .unwrap();
    }
    let owner = SqlOwner {
        path: path.clone(),
        calls: AtomicUsize::new(0),
    };
    let mut input = request("/work/api/records/fixture");
    input["method"] = json!("POST");
    input["text"] = json!("retained durable value");
    let result = call(&owner, input).unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["status"], 409);
    let failure: Value =
        serde_json::from_str(result["structuredContent"]["text"].as_str().unwrap()).unwrap();
    assert_eq!(failure["outcome"], "unknown");
    assert_eq!(failure["request_key"], "retained-command");
    let db = rusqlite::Connection::open(path).unwrap();
    let value: Vec<u8> = db
        .query_row("SELECT body FROM fixture", [], |r| r.get(0))
        .unwrap();
    assert_eq!(value, b"retained durable value");
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_authenticated_sdk_lists_calls_and_reads_same_apps_binding() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
        Router,
    };
    use mcp::{
        http::{
            axum_adapter::{route_table, Service},
            BearerAuthenticator,
        },
        Operation, OperationFailure, Principal, CallAnswerer,
    };
    use std::sync::Arc;
    use tower::ServiceExt;
    struct Auth;
    impl BearerAuthenticator for Auth {
        fn authenticate(&self, token: &[u8]) -> Option<Principal> {
            (token == b"fixture-only-secret").then(principal)
        }
    }
    struct Routes(Arc<Binding>, Arc<AtomicUsize>);
    impl CallAnswerer for Routes {
        fn mcp_apps(&self) -> Option<Arc<Binding>> {
            Some(self.0.clone())
        }
        fn invoke(&self, _: &Principal, _: Operation) -> Result<Value, OperationFailure> {
            panic!("resource invocation must retain the original bearer")
        }
        fn invoke_with_bearer(
            &self,
            principal: &Principal,
            bearer: &[u8],
            _: Operation,
        ) -> Result<Value, OperationFailure> {
            assert_eq!(principal.account_id, "account:fixture");
            assert_eq!(bearer, b"fixture-only-secret");
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"resource_still_available":true}))
        }
    }
    async fn rpc_response(
        app: Router,
        token: &str,
        version: &str,
        method: &str,
        mut params: Value,
        id: &str,
    ) -> axum::response::Response {
        if version == "2026-07-28" {
            params["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":version,
                "io.modelcontextprotocol/clientInfo":{"name":"apps-fixture","version":"1"},
                "io.modelcontextprotocol/clientCapabilities":{}});
        }
        let mut request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "mcp.example.test")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", version)
            .header("authorization", format!("Bearer {token}"));
        if version == "2026-07-28" {
            request = request.header("Mcp-Method", method);
            if let Some(name) = params
                .get("name")
                .or_else(|| params.get("uri"))
                .and_then(Value::as_str)
            {
                request = request.header("Mcp-Name", name);
            }
        }
        let response = app
            .oneshot(
                request
                    .body(Body::from(
                        json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        response
    }
    async fn rpc_id(
        app: Router,
        token: &str,
        version: &str,
        method: &str,
        params: Value,
        id: &str,
    ) -> (u16, Value) {
        let response = rpc_response(app, token, version, method, params, id).await;
        let status = response.status().as_u16();
        assert_eq!(response.headers()["cache-control"], "no-store");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-only-secret"));
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"not_json":true})),
        )
    }
    async fn rpc(
        app: Router,
        token: &str,
        version: &str,
        method: &str,
        params: Value,
    ) -> (u16, Value) {
        rpc_id(app, token, version, method, params, "apps-case").await
    }
    async fn private_view_refused(app: Router, owner: &Fixture, version: &str) {
        let operations_before = owner.calls.load(Ordering::SeqCst);
        let documents_before = owner.documents.load(Ordering::SeqCst);
        let admissions_before = owner.admissions.load(Ordering::SeqCst);
        let (_, tools) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/list",
            json!({}),
        )
        .await;
        let tools = tools["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "run_resource_operation");
        let (_, resources) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "resources/list",
            json!({}),
        )
        .await;
        assert_eq!(resources["result"]["resources"], json!([]));
        let (_, shown) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/call",
            json!({"name":"show_screen","arguments":{"screen":"/home"}}),
        )
        .await;
        assert_eq!(shown["result"]["isError"], true, "{shown}");
        assert!(shown["result"].get("_meta").is_none());
        let (_, read) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/call",
            json!({"name":"screen_read","arguments":request("/work/api/records")}),
        )
        .await;
        assert_eq!(read["result"]["isError"], false, "{read}");
        assert_eq!(read["result"]["structuredContent"]["status"], 409, "{read}");
        let denied: Value = serde_json::from_str(
            read["result"]["structuredContent"]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(denied["outcome"], "not_started");
        let (_, document) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "resources/read",
            json!({"uri":"ui://trillion/screen.html"}),
        )
        .await;
        assert!(document.get("error").is_some(), "{document}");
        assert!(document.get("result").is_none(), "{document}");
        assert_eq!(owner.calls.load(Ordering::SeqCst), operations_before);
        assert_eq!(owner.documents.load(Ordering::SeqCst), documents_before);
        assert_eq!(
            owner.admissions.load(Ordering::SeqCst),
            admissions_before + 5
        );
        // Refusing private presentation must not disable unrelated addressed
        // operations with their own real authority owner.
        let (_, resource) = rpc(app, "fixture-only-secret", version, "tools/call", json!({
            "name":"run_resource_operation","arguments":{"resource":"@own-records","operation":"workspace:read","request_key":"fixture-resource-request","input":{}}
        })).await;
        assert_eq!(resource["result"]["isError"], false, "{resource}");
        assert_eq!(
            resource["result"]["structuredContent"]["resource_still_available"], true,
            "{resource}"
        );
        assert_eq!(
            owner.admissions.load(Ordering::SeqCst),
            admissions_before + 5
        );
    }
    let owner = Arc::new(Fixture::default());
    let resource_calls = Arc::new(AtomicUsize::new(0));
    let binding = Arc::new(Binding {
        config: config(),
        owner: owner.clone(),
    });
    let app = route_table(
        Service::new(
            "mcp.example.test",
            Arc::new(Auth),
            Arc::new(Routes(binding, resource_calls.clone())),
        )
        .unwrap(),
    );
    // An initially refused private view is hidden before any successful
    // discovery or operation, even with a valid authenticated bearer.
    owner.revoked.store(true, Ordering::SeqCst);
    for version in ["2025-06-18", "2026-07-28"] {
        private_view_refused(app.clone(), &owner, version).await;
    }
    assert_eq!(resource_calls.load(Ordering::SeqCst), 2);
    owner.revoked.store(false, Ordering::SeqCst);
    for version in ["2025-06-18", "2026-07-28"] {
        let (status, list) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/list",
            json!({}),
        )
        .await;
        assert_eq!(status, 200, "{list}");
        let tools = list["result"]["tools"].as_array().unwrap();
        let show = tools.iter().find(|v| v["name"] == "show_screen").unwrap();
        assert_eq!(
            show["_meta"]["ui"]["resourceUri"],
            "ui://trillion/screen.html"
        );
        assert_eq!(
            tools.iter().find(|v| v["name"] == "screen_read").unwrap()["_meta"]["ui"]["visibility"],
            json!(["app"])
        );
        let (_,opened)=rpc(app.clone(),"fixture-only-secret",version,"tools/call",json!({"name":"show_screen","arguments":{"screen":"/home","input":{"selection":"one"}}})).await;
        assert_eq!(
            opened["result"]["_meta"]["trillion/screen"]["input"],
            json!({"selection":"one"}),
            "{opened}"
        );
        let (_, listed) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "resources/list",
            json!({}),
        )
        .await;
        assert_eq!(
            listed["result"]["resources"][0]["uri"], "ui://trillion/screen.html",
            "{listed}"
        );
        let (_, document) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "resources/read",
            json!({"uri":"ui://trillion/screen.html"}),
        )
        .await;
        assert_eq!(
            document["result"]["contents"][0]["mimeType"], "text/html;profile=mcp-app",
            "{document}"
        );
        assert_eq!(
            document["result"]["contents"][0]["text"]
                .as_str()
                .unwrap()
                .as_bytes(),
            ORIGINAL_DOCUMENT
        );
        if version == "2026-07-28" {
            assert_eq!(document["result"]["resultType"], "complete", "{document}");
        } else {
            assert!(document["result"].get("resultType").is_none(), "{document}");
        }
        assert_eq!(
            document["result"]["contents"][0]["_meta"]["ui"]["csp"]["resourceDomains"],
            json!(["https://trillion-screen-origin.invalid"])
        );
        // The current producer's complete document uses the same unchanged
        // authenticated host and resource path, without a shortened test page.
        owner.current_document.store(true, Ordering::SeqCst);
        let (_, current) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "resources/read",
            json!({"uri":"ui://trillion/screen.html"}),
        )
        .await;
        assert_eq!(
            current["result"]["contents"][0]["text"]
                .as_str()
                .unwrap()
                .as_bytes(),
            CURRENT_DOCUMENT
        );
        owner.current_document.store(false, Ordering::SeqCst);
        let (_, read) = rpc(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/call",
            json!({"name":"screen_read","arguments":request("/work/api/records")}),
        )
        .await;
        assert_eq!(
            read["result"]["structuredContent"]["text"], "{\"z\":1,\"a\":2}",
            "{read}"
        );
    }
    // The real HTTP/SDK path must move ALREADY bounded final bytes to a
    // single-use body guard. A guard collected inside SDK would poll early
    // and make the opposing late-withdrawal cases below fail.
    #[derive(Default)]
    struct GuardState {
        deny: AtomicBool,
        wrapped: AtomicUsize,
        polls: AtomicUsize,
        data_chunks: AtomicUsize,
    }
    struct TestCustody(Arc<GuardState>);
    struct TestBody {
        inner: Body,
        state: Arc<GuardState>,
        ingress: Arc<dyn Send + Sync>,
    }
    struct TestChunk {
        bytes: axum::body::Bytes,
        _ingress: Arc<dyn Send + Sync>,
    }
    impl AsRef<[u8]> for TestChunk {
        fn as_ref(&self) -> &[u8] {
            self.bytes.as_ref()
        }
    }
    impl http_body::Body for TestBody {
        type Data = axum::body::Bytes;
        type Error = std::io::Error;
        fn poll_frame(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
            let this = self.get_mut();
            this.state.polls.fetch_add(1, Ordering::SeqCst);
            if this.state.deny.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Some(Err(
                    std::io::ErrorKind::PermissionDenied.into()
                )));
            }
            match std::pin::Pin::new(&mut this.inner).poll_frame(cx) {
                std::task::Poll::Pending => std::task::Poll::Pending,
                std::task::Poll::Ready(None) => std::task::Poll::Ready(None),
                std::task::Poll::Ready(Some(Err(_))) => {
                    std::task::Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "MCP fixture body unavailable",
                    ))))
                }
                std::task::Poll::Ready(Some(Ok(chunk))) => match chunk.into_data() {
                    Ok(bytes) => {
                        this.state.data_chunks.fetch_add(1, Ordering::SeqCst);
                        std::task::Poll::Ready(Some(Ok(http_body::Frame::data(
                            axum::body::Bytes::from_owner(TestChunk { bytes, _ingress: this.ingress.clone() }),
                        ))))
                    }
                    Err(chunk) => std::task::Poll::Ready(Some(Ok(chunk))),
                },
            }
        }
    }
    impl FinalBodyCustody for TestCustody {
        fn finish(
            self: Box<Self>,
            body: Body,
            who: &Principal,
            bearer: zeroize::Zeroizing<Vec<u8>>,
            ingress: Arc<dyn Send + Sync>,
        ) -> Result<Body, trillion_local::refusal_cause::CodedError<()>> {
            assert_eq!(who, &principal());
            assert_eq!(bearer.as_slice(), b"fixture-only-secret");
            assert!(http_body::Body::size_hint(&body)
                .upper()
                .is_some_and(|length| length <= 65536));
            self.0.wrapped.fetch_add(1, Ordering::SeqCst);
            Ok(Body::new(TestBody {
                inner: body,
                state: self.0,
                ingress,
            }))
        }
    }
    for version in ["2025-06-18", "2026-07-28"] {
        let state = Arc::new(GuardState::default());
        owner
            .guards
            .lock()
            .unwrap()
            .push(Box::new(TestCustody(state.clone())));
        let response = rpc_response(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/call",
            json!({"name":"screen_read","arguments":request("/work/api/records")}),
            "guarded-original-id",
        )
        .await;
        assert_eq!(state.wrapped.load(Ordering::SeqCst), 1);
        assert_eq!(
            state.polls.load(Ordering::SeqCst),
            0,
            "SDK must not collect the guarded final Body"
        );
        assert!(
            !owner
                .cancel_seen
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .load(Ordering::SeqCst),
            "actual request witness survives into body custody"
        );
        state.deny.store(true, Ordering::SeqCst);
        assert!(to_bytes(response.into_body(), 65536).await.is_err());
        assert_eq!(state.polls.load(Ordering::SeqCst), 1);
        assert_eq!(state.data_chunks.load(Ordering::SeqCst), 0);

        let state = Arc::new(GuardState::default());
        owner
            .guards
            .lock()
            .unwrap()
            .push(Box::new(TestCustody(state.clone())));
        let response = rpc_response(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/call",
            json!({"name":"screen_read","arguments":request("/work/api/records")}),
            "guarded-original-id",
        )
        .await;
        assert_eq!(state.polls.load(Ordering::SeqCst), 0);
        let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["id"], "guarded-original-id");
        assert_eq!(
            result["result"]["structuredContent"]["text"],
            "{\"z\":1,\"a\":2}"
        );
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-only-secret"));
        // Collection may also poll for end-of-stream after the single data
        // chunk. Only pre-consumption polls must stay zero above.
        assert_eq!(state.data_chunks.load(Ordering::SeqCst), 1);
        drop(bytes);
        assert!(owner
            .cancel_seen
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst));

        let state = Arc::new(GuardState::default());
        owner.guards.lock().unwrap().extend([
            Box::new(TestCustody(state.clone())) as Box<dyn FinalBodyCustody>,
            Box::new(TestCustody(state.clone())),
        ]);
        let response = rpc_response(
            app.clone(),
            "fixture-only-secret",
            version,
            "tools/call",
            json!({"name":"screen_read","arguments":request("/work/api/records")}),
            "duplicate-guard",
        )
        .await;
        assert_eq!(state.wrapped.load(Ordering::SeqCst), 0);
        let (parts, body) = response.into_parts();
        assert!(!parts
            .headers
            .contains_key(axum::http::header::CONTENT_LENGTH));
        let hint = http_body::Body::size_hint(&body);
        assert_eq!(hint.lower(), 0);
        assert!(hint.upper().is_none(), "duplicate custody keeps length private");
        assert!(
            to_bytes(body, 65536).await.is_err(),
            "duplicate custody must not fall back to unguarded output"
        );
    }
    owner.answer.lock().unwrap().replace(WorkspaceAnswer {
        status: 200,
        content_type: "text/plain".into(),
        body: vec![b'x'; 40_000],
        request_key: Some("owner-original-command".into()),
    });
    let mut input = request("/work/api/records");
    input["method"] = json!("POST");
    input["text"] = json!("owner mutation");
    let (_, overflow) = rpc_id(
        app.clone(),
        "fixture-only-secret",
        "2025-06-18",
        "tools/call",
        json!({"name":"screen_read","arguments":input}),
        &"i".repeat(30_000),
    )
    .await;
    assert_eq!(overflow["result"]["isError"], false, "{overflow}");
    assert_eq!(
        overflow["result"]["structuredContent"]["status"], 409,
        "{overflow}"
    );
    let body: Value = serde_json::from_str(
        overflow["result"]["structuredContent"]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["outcome"], "unknown");
    assert_eq!(body["request_key"], "owner-original-command");
    assert_eq!(
        overflow["result"]["structuredContent"]["request_key"],
        "owner-original-command"
    );
    let before = owner.calls.load(Ordering::SeqCst);
    let admissions_before_bad_bearer = owner.admissions.load(Ordering::SeqCst);
    let (status, _) = rpc(
        app.clone(),
        "wrong-token",
        "2025-06-18",
        "tools/call",
        json!({"name":"show_screen","arguments":{"screen":"/home"}}),
    )
    .await;
    assert_eq!(status, 401);
    assert_eq!(owner.calls.load(Ordering::SeqCst), before);
    assert_eq!(
        owner.admissions.load(Ordering::SeqCst),
        admissions_before_bad_bearer
    );
    // Revocation after admitted discovery takes effect without a retained
    // Apps session or a restart. Guessed names/URIs cannot bypass it.
    owner.revoked.store(true, Ordering::SeqCst);
    for version in ["2025-06-18", "2026-07-28"] {
        private_view_refused(app.clone(), &owner, version).await;
    }
    assert_eq!(resource_calls.load(Ordering::SeqCst), 4);
}


fn assert_unavailable(failure: Failure) {
    assert_eq!((failure.code, failure.outcome_unknown, failure.request_key.as_deref()),
        ("screen_source_unavailable", false, None));
    assert!(!failure.cause().file().is_empty());
    assert!(failure.cause().line() > 0 && failure.cause().column() > 0);
}


#[test]
fn screen_failure_http_payload_retains_original_cause_without_private_request_values() {
    let first = Failure::unavailable(trillion_local::cause!(mcp_apps first_source));
    let second = Failure::unavailable(trillion_local::cause!(mcp_apps second_source));
    assert_ne!(first.cause(), second.cause());
    for failure in [first, second] {
        let cause = failure.cause();
        let result = config().failure_result(failure);
        let payload: Value = serde_json::from_str(result["structuredContent"]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload["failure_code"], "screen_source_unavailable");
        assert_eq!(payload["outcome"], "not_started");
        assert_eq!(payload["cause"], cause.id());
        assert!(!payload.to_string().contains("fixture-only-secret"));
    }
}
