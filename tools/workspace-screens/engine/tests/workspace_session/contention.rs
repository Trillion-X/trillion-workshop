//! Actual HTTP route table and actual WorkspaceSessions mutex admission with a
//! synthetic owner. These controls establish a causal mechanism, not that the
//! installed account's observed 503 has this cause. No timeout/cap is changed.
use super::*;
use std::{sync::mpsc, time::{Duration, Instant}};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn bounded_long_owner_read_refuses_page_and_api_then_both_recover_and_recheck_rights() {
    let f = fixture();
    let owner = f.owner.clone();
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _read = owner.lock().unwrap();
        held_tx.send(()).unwrap();
        // A fixture failure cannot retain the synthetic owner indefinitely.
        release_rx.recv_timeout(Duration::from_secs(8)).unwrap();
    });
    held_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let started = Instant::now();
    let (page, api) = tokio::join!(
        f.app.clone().oneshot(request("/", Some(&cookie()))),
        f.app.clone().oneshot(request("/work/api/scope", Some(&cookie()))),
    );
    let elapsed = started.elapsed();
    for response in [page.unwrap(), api.unwrap()] {
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body["error"], "workspace owner unavailable");
        assert!(body["cause"].as_str().unwrap().starts_with("trillion_local::workspace_session::owner_wait@"), "{body}");
        assert_eq!(body.as_object().unwrap().len(), 2, "{body}");
    }
    // Match the existing 2-second admission bound, without asserting a tight
    // machine-speed upper bound or substituting an application deadline.
    assert!(elapsed >= Duration::from_secs(2));
    assert_eq!(f.owner.try_lock().err().is_some(), true);
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    for path in ["/", "/work/api/scope"] {
        let response = f.app.clone().oneshot(request(path, Some(&cookie()))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        if path == "/" { assert!(body.windows(9).any(|w| w == b"id=\"root\"")); }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a signed-in browser session: integration tests cannot list an account's door open (account_routes::register is crate-private) since sign-in moved to the Better Auth Workshop tool, Nov 13 2026"]
async fn short_owner_read_releases_before_existing_bound_and_page_and_api_succeed() {
    let f = fixture();
    let owner = f.owner.clone();
    let (held_tx, held_rx) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _read = owner.lock().unwrap();
        held_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(40));
    });
    held_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let (page, api) = tokio::join!(
        f.app.clone().oneshot(request("/", Some(&cookie()))),
        f.app.clone().oneshot(request("/work/api/scope", Some(&cookie()))),
    );
    holder.join().unwrap();
    for response in [page.unwrap(), api.unwrap()] {
        assert_eq!(response.status(), StatusCode::OK);
        to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    }
}
