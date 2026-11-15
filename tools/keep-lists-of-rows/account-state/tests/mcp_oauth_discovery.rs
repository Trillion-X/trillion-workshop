//! Unauthenticated client discovery through the public forwarder's Gateway HTTP adapter.
//! These requests carry no token, reach no Mac and bind no listener.
use std::sync::Arc;
use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}};
use tower::ServiceExt;
use trillion_local::{mcp::http::axum_adapter, forwarder::gateway::Gateway};

fn gateway() -> axum::Router {
    let gateway = Arc::new(Gateway::with_door(
        "mcp.example.test", "https://mcp.example.test", std::sync::Arc::new(OneThousand),
    ).unwrap());
    axum_adapter::route_table(gateway.http_service().unwrap())
}

#[tokio::test]
async fn canonical_gateway_advertises_oauth_discovery_in_challenge() {
    let response = gateway().oneshot(Request::builder().method("POST").uri("/mcp")
        .header("Host", "mcp.example.test")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .body(Body::from("{}" )).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["www-authenticate"],
        "Bearer resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource/mcp\", scope=\"records tools\"",
        "an unauthenticated client must discover the door's own sign-in without a pre-supplied bearer");
}

#[tokio::test]
async fn canonical_gateway_serves_public_resource_metadata_with_exact_host() {
    let path = "/.well-known/oauth-protected-resource/mcp";
    let response = gateway().oneshot(Request::builder().uri(path)
        .header("Host", "mcp.example.test").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK,
        "the canonical MCP resource must publish its public discovery document");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    let metadata: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(metadata["resource"], "https://mcp.example.test/mcp");
    assert_eq!(metadata["authorization_servers"], serde_json::json!(["https://mcp.example.test"]));
    assert_eq!(metadata["scopes_supported"], serde_json::json!(["records", "tools"]));
    assert_eq!(metadata["bearer_methods_supported"], serde_json::json!(["header"]));
    for hosts in [vec!["other.example.test"], vec!["mcp.example.test", "mcp.example.test"]] {
        let mut request = Request::builder().uri(path);
        for host in hosts { request = request.header("Host", host); }
        let refused = gateway().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(refused.status(), StatusCode::MISDIRECTED_REQUEST,
            "discovery must retain the configured unique public Host boundary");
    }
}

#[tokio::test]
async fn the_root_form_of_the_resource_metadata_is_the_same_document() {
    let mut bodies = Vec::new();
    for path in ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"] {
        let response = gateway().oneshot(Request::builder().uri(path)
            .header("Host", "mcp.example.test").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        bodies.push(to_bytes(response.into_body(), 4096).await.unwrap());
    }
    assert_eq!(bodies[0], bodies[1], "a client that falls back to the root form reads the same metadata");
    let refused = gateway().oneshot(Request::builder().uri("/.well-known/oauth-protected-resource")
        .header("Host", "other.example.test").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(refused.status(), StatusCode::MISDIRECTED_REQUEST, "the root form keeps the public Host boundary");
}

#[test]
fn discovery_configuration_refuses_non_origins_and_invalid_scope_tokens() {
    for issuer in ["http://mcp.example.test", "https://name:synthetic@example.com", "https://mcp.example.test/authorize", "https://mcp.example.test/?query=1"] {
        let gateway = Arc::new(Gateway::with_door(
            "mcp.example.test", "https://mcp.example.test", std::sync::Arc::new(OneThousand),
        ).unwrap());
        assert!(gateway.http_service().unwrap().with_oauth_issuer(issuer, &["decisions"]).is_err());
    }
    for scopes in [vec![], vec!["read write"], vec!["bad\"scope"], vec!["bad\\scope"]] {
        let gateway = Arc::new(Gateway::with_door(
            "mcp.example.test", "https://mcp.example.test", std::sync::Arc::new(OneThousand),
        ).unwrap());
        assert!(gateway.http_service().unwrap().with_oauth_issuer("https://mcp.example.test", &scopes).is_err());
    }
}

/// A clock that reads 1000 ms: the proofs and windows these tests check are against that time.
struct OneThousand;
impl trillion_local::storage::time_source::Clock for OneThousand {
    fn now_ms(&self) -> i64 {
        1_000
    }
}
