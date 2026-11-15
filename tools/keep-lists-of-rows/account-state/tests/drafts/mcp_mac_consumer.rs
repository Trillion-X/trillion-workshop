// Real Swift transport -> TCP -> actual selected LocalAccount -> canonical
// read/disclosure owner. All account schemas and credentials are synthetic.
use super::*;
use std::{io::Write, process::{Command, Stdio}, sync::{Mutex, atomic::{AtomicUsize, Ordering}}};

async fn run_consumer(consumer: std::ffi::OsString, input: Vec<u8>) -> std::process::Output {
    tokio::task::spawn_blocking(move || {
        let mut child = Command::new(consumer).arg("--synthetic-router")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        child.wait_with_output().unwrap()
    }).await.unwrap()
}

#[tokio::test]
#[ignore = "requires the compiled primary synthetic Swift consumer; run focused with --ignored"]
async fn actual_swift_mac_consumer_reads_selected_local_forwarder() {
    let consumer = std::env::var_os("TRILLION_SYNTHETIC_MAC_CONSUMER")
        .expect("focused consumer test requires the compiled primary Swift fixture");
    let fixture = Fixture::new();
    let before = state(&fixture);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let app = crate::native_boot::mcp_local::route_table(
        Arc::new(Mutex::new(fixture.selected_at(address))), address.to_string(),
    ).unwrap().layer(axum::middleware::from_fn(move |request, next: axum::middleware::Next| {
        let observed = observed.clone();
        async move {
            observed.fetch_add(1, Ordering::SeqCst);
            next.run(request).await
        }
    }));
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).with_graceful_shutdown(async { let _ = stopped.await; }).await
    });
    let input = serde_json::to_vec(&json!({
        "origin":format!("http://{address}"), "account_id":"synthetic-user", "key":fixture.token,
    })).unwrap();
    let output = run_consumer(consumer.clone(), input).await;
    // Never print captured private-response or credential-bearing diagnostics.
    assert!(output.status.success(), "Swift consumer failed, captured output withheld");
    let report: Value = serde_json::from_slice(&output.stdout).expect("fixed metadata report");
    assert_eq!(report["selected_router_read_passed"], true);
    assert_eq!(report["real_account_access"], false);
    assert_eq!(report["provider_calls"], false);
    assert_eq!(count.load(Ordering::SeqCst), 1, "direct tools/call, no list/handshake/retry");
    assert_eq!(state(&fixture), before, "no business record or journal mutation");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&fixture.token));

    let kv = Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite")).unwrap();
    let digest = SecretNativeKey::parse(&fixture.token).unwrap().identity();
    assert_eq!(kv.execute("DELETE FROM _mf_entries WHERE key=?", [format!("personal-key:{digest}")]).unwrap(), 1);
    drop(kv);
    let withdrawn = serde_json::to_vec(&json!({
        "origin":format!("http://{address}"), "account_id":"synthetic-user", "key":fixture.token,
        "expect_refused":"yes",
    })).unwrap();
    let refused = run_consumer(consumer, withdrawn).await;
    let _ = stop.send(());
    tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
    assert!(refused.status.success(), "Swift refusal check failed, captured output withheld");
    let report: Value = serde_json::from_slice(&refused.stdout).expect("fixed refusal metadata");
    assert_eq!(report["selected_router_refusal_passed"], true);
    assert_eq!(count.load(Ordering::SeqCst), 2, "one direct request for each attempt");
    assert_eq!(state(&fixture), before);
    assert!(!String::from_utf8_lossy(&refused.stdout).contains(&fixture.token));
}
