// tests/workspace_stream.rs
//
// Purpose: Qualify the typed first-answer streaming scheduler and body lifecycle.
//
// Non-Negotiable Invariants: Prefix precedes reads; one session gate precedes revision and current reads; independent
// batch-relative read clocks and document-close omission are verified with synthetic supplies only.
//
// Key Concepts: Real HTTP-body polling, fast-answer interleaving, lazy factories, tail retention and permit cancellation.
//
// Security Considerations: These fixtures prove only local body mechanics. They do not prove real-account authority,
// canonical suppliers, frontend rendering, database behavior, customer outcomes, or deployed behavior.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use axum::{
    body::{Body, Bytes},
    http::{header, Request},
    response::Response,
};
use content_crypto::advanced::blake3;
use http_body::{Body as HttpBody, Frame};
use serde_json::{json, Value};
use std::{
    future::{pending, poll_fn},
    io,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tempfile::TempDir;
use tower::ServiceExt;
use trillion_local::{workspace::*, workspace_stream::*};

const DOM: &[u8] =
    br#"{"element_id":"page-answers","item_reads":{"element_id":"page-item-answers"}}"#;

fn tree_pin(root: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    fn walk(root: &Path, relative: &str, hash: &mut blake3::Hasher) {
        let mut children = std::fs::read_dir(root.join(relative))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child.file_name().into_string().unwrap();
            let rel = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let meta = std::fs::symlink_metadata(child.path()).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            let row = if meta.is_dir() {
                json!([rel, "directory", mode])
            } else {
                json!([
                    rel,
                    "file",
                    mode,
                    meta.len(),
                    blake3::hash(&std::fs::read(child.path()).unwrap())
                        .to_hex()
                        .as_str()
                ])
            };
            hash.update(serde_json::to_string(&row).unwrap().as_bytes());
            hash.update(b"\n");
            if meta.is_dir() {
                walk(root, &rel, hash);
            }
        }
    }
    let mut hash = blake3::Hasher::new();
    walk(root, "", &mut hash);
    hash.finalize().to_hex().to_string()
}

struct TestSessions(Mutex<Option<WorkspacePermit>>);
impl CurrentSession for TestSessions {
    fn current(
        &self,
        _: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        *self.0.lock().unwrap() = Some(permit);
        Box::pin(async {
            Ok(WorkspaceSession {
                account_id: "synthetic-account".into(),
                session_id: "synthetic-session".into(),
            })
        })
    }
}
struct TestOperations;
impl WorkspaceOperations for TestOperations {
    fn page(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequestHead,
        _: WorkspacePermit,
    ) -> SupplyFuture<WorkspacePage> {
        Box::pin(async {
            Ok(WorkspacePage {
            document: "<!doctype html><html><head><title>fixture</title></head><body><div id=\"root\"></div></body></html>".into(),
            screen_entry: None, listed_reads: vec![], item_reads: vec![], known: vec![], answers: vec![],
        })
        })
    }
    fn invoke(
        &self,
        _: WorkspaceSession,
        _: WorkspaceRequest,
        _: WorkspacePermit,
    ) -> SupplyFuture<Response> {
        Box::pin(async { Ok(Response::new(Body::empty())) })
    }
}

async fn permit_anchor() -> (Response, WorkspacePermit, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("workspace/named")).unwrap();
    std::fs::write(dir.path().join("workspace/named/app.js"), "fixture").unwrap();
    std::fs::write(dir.path().join("workspace/named/app.css"), "fixture").unwrap();
    let manifest = serde_json::to_vec(&json!({"script":"/workspace/named/app.js","stylesheet":"/workspace/named/app.css","preload":[],"screens":{},"import_map":{"imports":{}}})).unwrap();
    std::fs::write(dir.path().join("workspace/files.json"), &manifest).unwrap();
    let assets = Arc::new(
        WorkspaceAssets::open(
            dir.path(),
            blake3::hash(&manifest).to_hex().as_str(),
            &tree_pin(dir.path()),
        )
        .unwrap(),
    );
    let sessions = Arc::new(TestSessions(Mutex::new(None)));
    let app = route_table(
        assets,
        WorkspaceSupplies {
            sessions: Some(sessions.clone()),
            operations: Some(Arc::new(TestOperations)),
            live: None,
            dom: WorkspaceDom::from_source(DOM, blake3::hash(DOM).to_hex().as_str()).unwrap(),
        },
        WorkspaceLimits::default(),
    )
    .unwrap();
    let request = Request::builder()
        .uri("/")
        .header(header::COOKIE, "synthetic=yes")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    let permit = sessions.0.lock().unwrap().as_ref().unwrap().clone();
    (response, permit, dir)
}

fn serializer() -> AnswerSerializer {
    Arc::new(|answer| {
        let encoded = answer
            .envelope
            .json_text(16 * 1024 * 1024)
            .map_err(|_| trillion_local::cause!(WorkspaceError::Integrity))?
            .replace('<', "\\u003c");
        Ok(Bytes::from(format!(
            "<answer path={:?} copy={}>{encoded}</answer>",
            answer.path, answer.copy
        )))
    })
}

fn immediate(value: Option<Value>) -> ReadFactory {
    Box::new(move || Box::pin(async move { Ok(value.map(Into::into)) }))
}
fn answer(path: &str, copy: bool, marker: &str) -> ReadSpec {
    ReadSpec::new(
        path,
        copy,
        immediate(Some(json!({"status":200,"body":{"marker":marker}}))),
    )
}
fn limits(document: Duration, read: Duration) -> StreamLimits {
    StreamLimits {
        document_timeout: document,
        read_timeout: read,
        response_bytes: 4096,
        answer_chunk_bytes: 1024,
    }
}
async fn next_chunk<B>(body: &mut B) -> Option<Result<Frame<Bytes>, B::Error>>
where
    B: HttpBody<Data = Bytes> + Unpin,
{
    poll_fn(|cx| Pin::new(&mut *body).poll_frame(cx)).await
}
fn data(chunk: Result<Frame<Bytes>, io::Error>) -> Bytes {
    chunk.unwrap().into_data().unwrap()
}
fn batch(
    permit: WorkspacePermit,
    revision: ReadSpec,
    current: Vec<ReadSpec>,
    copies: Vec<ReadSpec>,
    confirm: impl FnOnce() -> SupplyFuture<()> + Send + 'static,
) -> WorkspaceReadBatch {
    WorkspaceReadBatch {
        confirm_session: Box::new(confirm),
        revision,
        current,
        copies,
        permit,
        retention: None,
    }
}

#[tokio::test]
async fn prefix_is_first_and_fast_answers_are_not_held_by_slow_reads() {
    let (anchor, permit, _dir) = permit_anchor().await;
    let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    let confirmation_order = order.clone();
    let slow_order = order.clone();
    let slow = ReadSpec::new(
        "/work/api/slow",
        false,
        Box::new(move || {
            slow_order.lock().unwrap().push("slow-start");
            Box::pin(async {
                pending::<
                    Result<
                        Option<trillion_local::workspace::WorkspaceAnswerEnvelope>,
                        WorkspaceError,
                    >,
                >()
                .await
            })
        }),
    );
    let mut current = vec![slow];
    let fast_order = order.clone();
    current.push(ReadSpec::new(
        "/work/api/fast",
        false,
        Box::new(move || {
            fast_order.lock().unwrap().push("fast-start");
            Box::pin(async { Ok(Some(json!({"status":200,"body":{"fast":true}}).into())) })
        }),
    ));
    let revision_start = order.clone();
    let revision = ReadSpec::new(
        "/work/api/revision",
        false,
        Box::new(move || {
            revision_start.lock().unwrap().push("revision-start");
            immediate(Some(json!({"status":200,"body":{"marker":"revision"}})))()
        }),
    );
    let batch = batch(
        permit.clone(),
        revision,
        current,
        vec![ReadSpec::new("/work/api/fast", true, immediate(None))],
        move || {
            confirmation_order.lock().unwrap().push("confirm");
            Box::pin(async { Ok(()) })
        },
    );
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"PREFIX"),
        Bytes::from_static(b"SUFFIX"),
        batch,
        serializer(),
        limits(Duration::from_millis(80), Duration::from_secs(1)),
    )
    .unwrap();
    assert_eq!(
        &data(next_chunk(&mut stream).await.unwrap()).as_ref(),
        b"PREFIX"
    );
    assert!(
        order.lock().unwrap().is_empty(),
        "no read factory runs before the prefix chunk"
    );
    let revision = data(next_chunk(&mut stream).await.unwrap());
    assert!(std::str::from_utf8(&revision).unwrap().contains("revision"));
    let fast = data(next_chunk(&mut stream).await.unwrap());
    assert!(
        std::str::from_utf8(&fast).unwrap().contains("fast"),
        "fast read arrives while earlier read is still pending"
    );
    assert!(
        !std::str::from_utf8(&fast).unwrap().contains("copy=true"),
        "an absent cached copy does not suppress or become the current answer"
    );
    let log = order.lock().unwrap().clone();
    assert_eq!(log.iter().filter(|name| **name == "confirm").count(), 1);
    assert!(
        log.iter().position(|name| *name == "confirm")
            < log.iter().position(|name| *name == "revision-start")
    );
    assert!(
        log.iter().position(|name| *name == "revision-start")
            < log.iter().position(|name| *name == "slow-start")
    );
    let suffix = data(next_chunk(&mut stream).await.unwrap());
    assert_eq!(&suffix[..], b"SUFFIX");
    assert!(next_chunk(&mut stream).await.is_none());
    drop(stream);
    assert!(
        permit.cancelled(),
        "without a retention owner, normal EOF cancels the same request lifetime"
    );
    drop(anchor);
}

#[tokio::test]
async fn reads_wait_for_revision_and_expired_waiters_never_start() {
    let (anchor, permit, _dir) = permit_anchor().await;
    let current_starts = Arc::new(AtomicUsize::new(0));
    let started = current_starts.clone();
    let current = ReadSpec::new(
        "/work/api/current",
        false,
        Box::new(move || {
            started.fetch_add(1, Ordering::SeqCst);
            immediate(Some(json!({"status":200,"body":{}})))()
        }),
    );
    let revision = ReadSpec::new(
        "/work/api/revision",
        false,
        Box::new(|| {
            Box::pin(async {
                pending::<
                    Result<
                        Option<trillion_local::workspace::WorkspaceAnswerEnvelope>,
                        WorkspaceError,
                    >,
                >()
                .await
            })
        }),
    );
    let retained = Arc::new(Mutex::new(None));
    let retained_by_owner = retained.clone();
    let mut plan = batch(permit.clone(), revision, vec![current], vec![], || {
        Box::pin(async { Ok(()) })
    });
    plan.retention = Some(Box::new(move |owner_permit, tail| {
        *retained_by_owner.lock().unwrap() = Some((owner_permit, tail));
    }));
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"H"),
        Bytes::from_static(b"T"),
        plan,
        serializer(),
        limits(Duration::from_millis(5), Duration::from_millis(20)),
    )
    .unwrap();
    assert_eq!(&data(next_chunk(&mut stream).await.unwrap()).as_ref(), b"H");
    assert_eq!(&data(next_chunk(&mut stream).await.unwrap()).as_ref(), b"T");
    assert!(
        next_chunk(&mut stream).await.is_none(),
        "normal EOF is required before tail transfer"
    );
    let (retained_permit, tail) = retained.lock().unwrap().take().unwrap();
    assert!(!retained_permit.cancelled());
    let _ = tokio::time::timeout(Duration::from_millis(80), tail)
        .await
        .unwrap();
    assert_eq!(
        current_starts.load(Ordering::SeqCst),
        0,
        "expired waiter behind slow revision must never create its supplier future"
    );
    assert!(!permit.cancelled());
    drop(stream);
    drop(anchor);
    assert!(
        retained_permit.cancelled(),
        "retention owner and page share the same permit cancellation state"
    );
}

#[tokio::test]
async fn document_deadline_omits_failed_and_unresolved_answers_without_pending_503() {
    let (anchor, permit, _dir) = permit_anchor().await;
    let failed = ReadSpec::new(
        "/work/api/failed",
        false,
        Box::new(|| Box::pin(async { Err(trillion_local::cause!(WorkspaceError::Unavailable)) })),
    );
    let slow = ReadSpec::new(
        "/work/api/slow",
        false,
        Box::new(|| {
            Box::pin(async {
                pending::<
                    Result<
                        Option<trillion_local::workspace::WorkspaceAnswerEnvelope>,
                        WorkspaceError,
                    >,
                >()
                .await
            })
        }),
    );
    let plan = batch(
        permit.clone(),
        answer("/work/api/revision", false, "revision"),
        vec![failed, slow],
        vec![],
        || Box::pin(async { Ok(()) }),
    );
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"HEAD"),
        Bytes::from_static(b"TAIL"),
        plan,
        serializer(),
        limits(Duration::from_millis(8), Duration::from_secs(1)),
    )
    .unwrap();
    let mut output = Vec::new();
    while let Some(chunk) = next_chunk(&mut stream).await {
        output.extend_from_slice(&data(chunk));
    }
    let text = String::from_utf8(output).unwrap();
    assert!(text.starts_with("HEAD") && text.ends_with("TAIL"));
    assert!(text.contains("revision"));
    assert!(!text.contains("failed") && !text.contains("slow"));
    assert!(!text.contains("503") && !text.contains("pending"));
    assert!(
        permit.cancelled(),
        "document EOF without retention must cancel the unresolved original work"
    );
    drop(anchor);
}

#[tokio::test]
async fn premature_drop_cancels_and_normal_eof_hands_the_same_permit_to_retention() {
    let (anchor, permit, _dir) = permit_anchor().await;
    let plan = batch(
        permit.clone(),
        answer("/work/api/revision", false, "revision"),
        vec![],
        vec![],
        || Box::pin(async { Ok(()) }),
    );
    let mut dropped = WorkspaceStream::new(
        Bytes::from_static(b"HEAD"),
        Bytes::from_static(b"TAIL"),
        plan,
        serializer(),
        limits(Duration::from_millis(20), Duration::from_secs(1)),
    )
    .unwrap();
    let _ = next_chunk(&mut dropped).await.unwrap();
    drop(dropped);
    assert!(
        permit.cancelled(),
        "dropping before suffix/EOF cancels the permit"
    );
    drop(anchor);

    let (anchor, permit, _dir) = permit_anchor().await;
    let retained = Arc::new(Mutex::new(None));
    let retained_by_owner = retained.clone();
    let pending_revision = ReadSpec::new(
        "/work/api/revision",
        false,
        Box::new(|| {
            Box::pin(async {
                pending::<
                    Result<
                        Option<trillion_local::workspace::WorkspaceAnswerEnvelope>,
                        WorkspaceError,
                    >,
                >()
                .await
            })
        }),
    );
    let mut plan = batch(permit.clone(), pending_revision, vec![], vec![], || {
        Box::pin(async { Ok(()) })
    });
    plan.retention = Some(Box::new(move |owner_permit, tail| {
        *retained_by_owner.lock().unwrap() = Some((owner_permit, tail));
    }));
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"HEAD"),
        Bytes::from_static(b"TAIL"),
        plan,
        serializer(),
        limits(Duration::from_millis(3), Duration::from_millis(30)),
    )
    .unwrap();
    assert_eq!(
        &data(next_chunk(&mut stream).await.unwrap()).as_ref(),
        b"HEAD"
    );
    assert_eq!(
        &data(next_chunk(&mut stream).await.unwrap()).as_ref(),
        b"TAIL"
    );
    assert!(next_chunk(&mut stream).await.is_none());
    let (owner_permit, tail) = retained.lock().unwrap().take().unwrap();
    assert!(!owner_permit.cancelled());
    let _ = tokio::time::timeout(Duration::from_millis(60), tail)
        .await
        .unwrap();
    drop(stream);
    assert!(
        !owner_permit.cancelled(),
        "normal EOF leaves the continuation's permit live"
    );
    drop(anchor);
    assert!(
        owner_permit.cancelled(),
        "dropping the original workspace response cancels the same retained permit"
    );
}

#[tokio::test]
async fn completed_sibling_cannot_suppress_retained_read_deadline() {
    let (_anchor, permit, _dir) = permit_anchor().await;
    let retained = Arc::new(Mutex::new(None));
    let own = retained.clone();
    let mut plan = batch(
        permit.clone(),
        answer("/work/api/revision", false, "revision"),
        vec![
            answer("/work/api/fast", false, "fast"),
            ReadSpec::new("/work/api/hung", false, Box::new(|| Box::pin(pending()))),
        ],
        vec![],
        || Box::pin(async { Ok(()) }),
    );
    plan.retention = Some(Box::new(move |permit, tail| {
        *own.lock().unwrap() = Some((permit, tail));
    }));
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"H"),
        Bytes::from_static(b"T"),
        plan,
        serializer(),
        limits(Duration::from_millis(5), Duration::from_millis(30)),
    )
    .unwrap();
    while next_chunk(&mut stream).await.is_some() {}
    let (owner_permit, tail) = retained.lock().unwrap().take().unwrap();
    let answers = tokio::time::timeout(Duration::from_millis(100), tail)
        .await
        .expect("a completed sibling must not hide a never-ready sibling's original deadline");
    assert!(answers.iter().any(|a| a.path == "/work/api/fast"));
    assert!(!answers.iter().any(|a| a.path == "/work/api/hung"));
    assert!(!owner_permit.cancelled());
}
#[tokio::test]
async fn abandoning_unpolled_retained_tail_cancels_original_permit() {
    let (_anchor, permit, _dir) = permit_anchor().await;
    let retained = Arc::new(Mutex::new(None));
    let own = retained.clone();
    let mut plan = batch(
        permit.clone(),
        ReadSpec::new(
            "/work/api/revision",
            false,
            Box::new(|| Box::pin(pending())),
        ),
        vec![],
        vec![],
        || Box::pin(async { Ok(()) }),
    );
    plan.retention = Some(Box::new(move |permit, tail| {
        *own.lock().unwrap() = Some((permit, tail));
    }));
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"H"),
        Bytes::from_static(b"T"),
        plan,
        serializer(),
        limits(Duration::from_millis(3), Duration::from_millis(30)),
    )
    .unwrap();
    while next_chunk(&mut stream).await.is_some() {}
    let (owner_permit, tail) = retained.lock().unwrap().take().unwrap();
    assert!(!owner_permit.cancelled());
    drop(tail);
    assert!(owner_permit.cancelled());
}
#[tokio::test]
async fn answer_budget_reserves_closing_suffix() {
    let (_anchor, permit, _dir) = permit_anchor().await;
    let plan = batch(
        permit.clone(),
        answer("/work/api/revision", false, "revision"),
        vec![],
        vec![],
        || Box::pin(async { Ok(()) }),
    );
    let serialize: AnswerSerializer = Arc::new(|_| Ok(Bytes::from_static(b"0123456789")));
    let mut stream = WorkspaceStream::new(
        Bytes::from_static(b"H"),
        Bytes::from_static(b"T"),
        plan,
        serialize,
        StreamLimits {
            document_timeout: Duration::from_millis(10),
            read_timeout: Duration::from_millis(20),
            response_bytes: 11,
            answer_chunk_bytes: 16,
        },
    )
    .unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = next_chunk(&mut stream).await {
        bytes.extend_from_slice(&data(chunk));
    }
    assert_eq!(bytes, b"HT");
    assert!(
        permit.cancelled(),
        "without retained owner a natural EOF closes its work too"
    );
}
