// tests/workspace_current_frontend.rs
//
// Purpose: Consume the separately pinned current frontend through the real Rust route table.
// Non-Negotiable Invariants: Preserve the historical fixture and unavailable producer source binding.
// Key Concepts: Independent Python asset-tree and tar-body oracles; after-build source custody.
// Security Considerations: Read public code and copied declared sources only; synthetic sessions confer no real account authority.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    response::Response,
};
use content_crypto::advanced::blake3;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tower::ServiceExt;
use trillion_local::workspace::*;

const FILES: &str = "8a2fc361978922174c9590e7dd1b647521886a41dc4b59e2fb71e39de66b0f7d";
// Whole built/assets root, including the workspace directory row. The workspace
// subtree has a different identity and must not be substituted here.
const ASSETS: &str = "1f06041037bd840f063aef1743ced50abb942df4fd5d5adea7fc371695181693";
const MODULES: &str = "fd30c9e90ac85aa4247c993e93c4befd8e899a27a918cc501809aec2e4924d5e";
const INPUTS: &str = "28ecfe0d647ff68af1a15c1de949f7682d1d8d398b5f152a78d4bda3a7dadde9";
const LEDGER: &str = "f43216815479d8cdae920f0eb4e5836bca44b5dc3adcef34c22dec3c945fc448";
const PRODUCER: &str = "782f5f50b811b8e462ec2ad684038e3fefd16e950ca9484de2786c0ed75cf81c";

fn pinned(path: impl AsRef<Path>, identity: &str) -> Vec<u8> {
    let bytes = fs::read(path.as_ref()).unwrap();
    assert_eq!(
        blake3::hash(&bytes).to_hex().as_str(),
        identity,
        "{}",
        path.as_ref().display()
    );
    bytes
}

struct FixtureSession;
impl CurrentSession for FixtureSession {
    fn current(
        &self,
        head: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        let allowed = head
            .headers
            .get(header::COOKIE)
            .is_some_and(|v| v == "fixture-session=yes");
        Box::pin(async move {
            if !allowed {
                return Err(trillion_local::cause!(WorkspaceError::Unauthorized));
            }
            Ok(WorkspaceSession {
                account_id: "fixture-account".into(),
                session_id: "fixture-session".into(),
            })
        })
    }
}
struct UnavailableOperations;
impl WorkspaceOperations for UnavailableOperations {
    fn page(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })
    }
    fn invoke(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequest,
        _: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })
    }
}

#[tokio::test]
#[ignore = "requires exact current frontend and after-build custody capsule; run in shared native queue"]
async fn actual_current_frontend_and_after_build_custody_are_consumed() {
    let owner = PathBuf::from(std::env::var_os("RETIRED_SNAPSHOT_ROOT").expect("RETIRED_SNAPSHOT_ROOT test setting"));
    let candidate = std::env::var_os("TRILLION_CURRENT_FRONTEND")
        .map(PathBuf::from)
        .unwrap_or_else(|| owner.join(".local/workspace-admin-policy-init-20261025/frontend"));
    let custody = std::env::var_os("TRILLION_CURRENT_FRONTEND_CUSTODY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            owner.join(".local/rust-frontend-contract-20261025/current-frontend-custody")
        });
    let declared: Vec<String> = serde_json::from_slice(&pinned(
        candidate.join("built/workspace.inputs.json"),
        INPUTS,
    ))
    .unwrap();
    assert_eq!(
        pinned(custody.join("workspace.inputs.json"), INPUTS),
        fs::read(candidate.join("built/workspace.inputs.json")).unwrap()
    );
    assert_eq!(declared.len(), 6164);
    let ledger = pinned(custody.join("source-ledger.ndjson"), LEDGER);
    let rows = std::str::from_utf8(&ledger)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), declared.len());
    let mut categories = BTreeMap::<&str, usize>::new();
    let mut unique = BTreeSet::new();
    for (name, row) in declared.iter().zip(&rows) {
        assert_eq!(row["path"].as_str(), Some(name.as_str()));
        let rel = Path::new(name);
        assert!(!rel.is_absolute() && rel.components().all(|c| matches!(c, Component::Normal(_))));
        assert!(unique.insert(name));
        let bytes = pinned(
            custody.join("source").join(rel),
            row["blake3"].as_str().unwrap(),
        );
        assert_eq!(bytes.len() as u64, row["bytes"].as_u64().unwrap());
        *categories
            .entry(if name.starts_with("node_modules/") {
                "dependency"
            } else {
                "project"
            })
            .or_default() += 1;
    }
    assert_eq!(
        categories,
        BTreeMap::from([("dependency", 3221), ("project", 2943)])
    );
    // This checks captured bytes, not a claim that the compiler consumed them.
    let producer: Value = serde_json::from_slice(&pinned(
        candidate.join("build-producer-evidence.json"),
        PRODUCER,
    ))
    .unwrap();
    assert_eq!(producer["status"], "invalidated");
    assert_eq!(producer["source_binding"], "unavailable");
    pinned(
        candidate.join("built/workspace.meta.json"),
        "65b2153322eec7edf0c4d2cb1ada34e06b4930a027611de87dc9c20a40060736",
    );

    let modules = ScreenModules::open(candidate.join("built"), MODULES).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open_with_modules(
            candidate.join("built/assets"),
            FILES,
            ASSETS,
            Some(modules),
        )
        .unwrap(),
    );
    assert_eq!(assets.manifest()["screens"].as_object().unwrap().len(), 67);
    assert_eq!(
        assets.manifest()["script"],
        "/workspace/named/workspace-ec20bb3ccf264b19.js"
    );
    assert_eq!(
        assets.manifest()["stylesheet"],
        "/workspace/named/workspace-c87133979d1937e6.css"
    );
    let dom = fs::read(custody.join("source/src/workspace/first-answers.json")).unwrap();
    let app = route_table(
        assets.clone(),
        WorkspaceSupplies {
            sessions: Some(Arc::new(FixtureSession)),
            operations: Some(Arc::new(UnavailableOperations)),
            live: None,
            dom: WorkspaceDom::from_source(&dom, blake3::hash(&dom).to_hex().as_str()).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    for path in [
        "/workspace/files.json",
        assets.manifest()["script"].as_str().unwrap(),
        assets.manifest()["stylesheet"].as_str().unwrap(),
        "/workspace/screen-view.js",
        "/workspace/named/screen-view-299b7cae37c3c4d9.js",
    ] {
        let expected = fs::read(
            candidate
                .join("built/assets")
                .join(path.trim_start_matches('/')),
        )
        .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::COOKIE, "fixture-session=yes")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            to_bytes(response.into_body(), 64 * 1024 * 1024)
                .await
                .unwrap()
                .as_ref(),
            expected.as_slice()
        );
    }
    let refused = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/workspace/files.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);

    // Independent Python tarfile decoding produced these full body identities.
    let expected = BTreeMap::from([
        (
            "1f:fd2dc0c31890a3c8a02bcd7c7292f7c464bb4ca7ee4a115d8262260b072f8b7c",
            "241d8ec1920a58007d2d06d3aaee2f49256986da774c3525b4bbfb1982d0a12f",
        ),
        (
            "1f:fac42b7418660bd52e80b35c5703b04ec4ac4bbcac1412656c91d78ac5c252b3",
            "29428d7f0c52d86e65aca0de9e9d82c191d95f33e813f48d7169ea9e741d5d92",
        ),
        (
            "1f:41ba636cf751d3b0f80856752ba172f5c87e0317d3d0465851ecd6660f64ecb0",
            "195bbd38819c629f9836424c607b31990a9e7752d618812112227d9b5cc4ba84",
        ),
        (
            "1f:c11966bc13f4f011e7de8a2d652cda459c8706178707c2c80e48a393825b7193",
            "4239097890c82ae07438e03834fc64952bef6d541c517da3c834db7584f29baa",
        ),
        (
            "1f:bfcbc10ca6234fd4c26f7c4f7b379a06188f10bfb24e8e3aed82b0c6747fd269",
            "d9e20dcc115193398c5ce3712a8a9077084563c81ada3a0969e08b8b4177405d",
        ),
    ]);
    let mut consumed = BTreeSet::new();
    for value in assets.manifest()["import_map"]["imports"]
        .as_object()
        .unwrap()
        .values()
    {
        let path = value.as_str().unwrap();
        if !path.starts_with("/workshop/modules/") {
            continue;
        }
        // Public program archives use their own original immutable-code policy.
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let identity = response.headers()["x-content-identity"]
            .to_str()
            .unwrap()
            .to_owned();
        let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        assert_eq!(
            blake3::hash(&body).to_hex().as_str(),
            *expected.get(identity.as_str()).unwrap()
        );
        assert!(consumed.insert(identity));
    }
    assert_eq!(consumed.len(), 5);
}
