//! Records delivery controls, mounted by tests/local_workspace.rs: actual
//! HTTP/body polls and workspace store commits; all accounts are synthetic.
use super::*;
use http_body::Body as _;
use std::{future::poll_fn, pin::Pin, task::Poll, time::Duration};

async fn prepared(f: &Fixture) -> Body {
    let response = f
        .app
        .clone()
        .oneshot(request(
            "GET",
            "/work/api/records?label=private-delivery-canary",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    response.into_body()
}
async fn pending(body: &mut Body) {
    assert!(
        poll_fn(|cx| Poll::Ready(Pin::new(&mut *body).poll_frame(cx)))
            .await
            .is_pending()
    );
}
/// The chunk is the snapshot the read began on, whatever committed after it.
async fn delivered(body: Body) {
    let bytes = to_bytes(body, 1024 * 1024).await.expect("a consistent read is delivered");
    assert_eq!(bytes.as_ref(), br#"{"records":{"private-delivery-canary":true}}"#);
}
async fn refused(mut body: Body) {
    assert!(matches!(
        poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await,
        Some(Err(_))
    ));
    assert!(
        poll_fn(|cx| Pin::new(&mut body).poll_frame(cx))
            .await
            .is_none()
    );
}

#[tokio::test]
async fn unchanged_records_keep_exact_body_and_final_guard_writes_nothing() {
    let f = Fixture::new(&[("private-delivery-canary", r#"{"n":1.00,"s":"ok"}"#)]);
    let body = prepared(&f).await;
    let before = f.owner.lock().unwrap().sql_work().unwrap().work;
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap();
    assert_eq!(
        bytes.as_ref(),
        br#"{"records":{"private-delivery-canary":{"n":1,"s":"ok"}}}"#
    );
    let after = f.owner.lock().unwrap().sql_work().unwrap().work;
    // The final rights check asks the sign-in about the window's row (293c00d), so the account's store takes no
    // statement from the guard: the count is the same after the body as before it.
    assert_eq!(after.sql_statements, before.sql_statements);
    assert_eq!(after.rows_written, before.rows_written);
}

#[tokio::test]
async fn prepared_records_wait_for_same_owner_then_deliver_without_requerying_or_resetting_deadline()
 {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let mut body = prepared(&f).await;
    let held = f.owner.lock().unwrap();
    pending(&mut body).await;
    drop(held);
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap();
    assert_eq!(
        bytes.as_ref(),
        br#"{"records":{"private-delivery-canary":true}}"#
    );
}

#[tokio::test]
async fn prepared_records_wait_rechecks_installed_selection() {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let mut body = prepared(&f).await;
    let held = f.owner.lock().unwrap();
    pending(&mut body).await;
    let descriptor = f._temp.path().join("adoption.json");
    let mut bytes = fs::read(&descriptor).unwrap();
    bytes.push(b' ');
    fs::write(descriptor, bytes).unwrap();
    drop(held);
    refused(body).await;
}

#[tokio::test]
async fn cancellation_while_owner_is_held_withholds_without_waiting_for_the_owner() {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let mut body = prepared(&f).await;
    let context = f.adapter.head_context.lock().unwrap().take().unwrap();
    let held = f.owner.lock().unwrap();
    pending(&mut body).await;
    context.permit.cancel();
    refused(body).await;
    drop(held);
}

#[tokio::test]
async fn replacing_selected_projection_file_with_identical_bytes_still_withholds() {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let body = prepared(&f).await;
    let original = fs::read(&f.records).unwrap();
    fs::rename(&f.records, f.records.with_extension("held-original")).unwrap();
    fs::write(&f.records, original).unwrap();
    refused(body).await;
}

#[tokio::test]
async fn a_committed_update_or_erase_after_the_read_does_not_withdraw_the_snapshot_it_delivers() {
    for change in ["update", "erase"] {
        let f = Fixture::new(&[("private-delivery-canary", "true")]);
        let body = prepared(&f).await;
        let db = Connection::open(&f.records).unwrap();
        let schema: i64 = db
            .query_row("PRAGMA schema_version", [], |r| r.get(0))
            .unwrap();
        crate::workspace_put(&f.records, "private-delivery-canary", (change == "update").then_some("false"));
        assert_eq!(
            schema,
            db.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0))
                .unwrap()
        );
        drop(db);
        delivered(body).await;
    }
}

#[tokio::test]
async fn a_committed_aba_after_the_read_does_not_withdraw_the_snapshot_it_delivers() {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let body = prepared(&f).await;
    crate::workspace_put(&f.records, "private-delivery-canary", Some("false"));
    crate::workspace_put(&f.records, "private-delivery-canary", Some("true"));
    assert_eq!(
        crate::workspace_text(&f.records, "private-delivery-canary").as_deref(),
        Some("true")
    );
    delivered(body).await;
}

#[tokio::test]
async fn prepared_records_deadline_is_not_renewed_by_first_body_poll() {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let body = prepared(&f).await;
    tokio::time::sleep(Duration::from_millis(2100)).await;
    refused(body).await;
}

#[tokio::test]
async fn unrelated_kv_commit_does_not_substitute_a_global_changed_database_refusal_for_current_rights()
 {
    let f = Fixture::new(&[("private-delivery-canary", "true")]);
    let body = prepared(&f).await;
    let db = Connection::open(&f.app_kv).unwrap();
    db.execute(
        "INSERT INTO _mf_entries(key,blob_id) VALUES('unrelated-synthetic-kv-item','aa')",
        [],
    )
    .unwrap();
    drop(db);
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap();
    assert_eq!(
        bytes.as_ref(),
        br#"{"records":{"private-delivery-canary":true}}"#
    );
}
