// Opposing controls on the actual selected local writer. Mutations occur at
// its real log-ID publication boundary, after initial admission/source capture.
// No cloud, real account, substitute executor or production-only test hook.
use super::*;
use std::sync::atomic::Ordering;

struct ChangeAtPublication {
    next: u16,
    change: Option<Box<dyn FnOnce()>>,
}
impl LogIds for ChangeAtPublication {
    fn next_log_id(&mut self) -> Option<String> {
        self.next += 1;
        if self.next == 1 {
            (self.change.take().unwrap())();
        }
        Some(format!(
            "01234567-89ab-7{:03x}-8f01-000000000001",
            self.next
        ))
    }
}
fn run_local(
    owner: &mut crate::native_boot::SelectedAccount,
    f: &Fixture,
    key: &str,
    cancel: Arc<AtomicBool>,
    ids: &mut dyn LogIds,
) -> record_writer::Result<NativeCommandResult> {
    owner.execute_personal_local_workspace_write(
        f.token.as_bytes(),
        &f.principal(),
        &operation(key, input()),
        cancel,
        Instant::now() + Duration::from_secs(15),
        ids,
    )
}
fn change_state(path: &Path, change: impl FnOnce(&mut Value)) {
    let db = Connection::open(path).unwrap();
    let raw: String = db
        .query_row(
            "SELECT state_json FROM account_control_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut state: Value = serde_json::from_str(&raw).unwrap();
    change(&mut state);
    db.execute(
        "UPDATE account_control_state SET state_json=? WHERE singleton=1",
        [state.to_string()],
    )
    .unwrap();
    assert_eq!(
        db.query_row(
            "SELECT epoch FROM account_control_state WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7
    );
}
#[test]
fn local_mcp_same_revision_policy_and_both_gate_withdrawals_roll_back_the_actual_effect() {
    for case in [
        "policy",
        "own-state",
        "own-fence",
        "usage-state",
        "usage-fence",
    ] {
        let f = Fixture::new();
        let mut owner = f.selected();
        let before = state(&f);
        let root = f.root.clone();
        let sign_in = f.signin.clone();
        let mut ids = ChangeAtPublication {
            next: 0,
            change: Some(Box::new(move || match case {
                "policy" => {
                    let db = Connection::open(root.join("policy.sqlite")).unwrap();
                    directory(
                        &db,
                        "account-erasure-continuation",
                        json!({"withdrawal":true}),
                    );
                    assert_eq!(
                        db.query_row(
                            "SELECT value FROM policy_directory WHERE name='revision'",
                            [],
                            |r| r.get::<_, String>(0)
                        )
                        .unwrap(),
                        "7"
                    );
                }
                "own-state" | "usage-state" => {
                    let file = if case == "own-state" {
                        "own.sqlite"
                    } else {
                        "use.sqlite"
                    };
                    change_state(&root.join(file), |v| {
                        v["sign_ins"][&sign_in]["ended_until_ms"] = json!(millis() + 60_000)
                    });
                }
                "own-fence" | "usage-fence" => {
                    let file = if case == "own-fence" {
                        "own.sqlite"
                    } else {
                        "use.sqlite"
                    };
                    directory(
                        &Connection::open(root.join(file)).unwrap(),
                        "fence",
                        json!("same-revision-withdrawal"),
                    );
                }
                _ => unreachable!(),
            })),
        };
        let result = run_local(
            &mut owner,
            &f,
            "local-same-revision-withdrawal",
            Arc::new(AtomicBool::new(false)),
            &mut ids,
        );
        assert!(result.is_err(), "{case}");
        assert_eq!(ids.next, 1, "{case}: actual publication boundary reached");
        assert_eq!(
            state(&f),
            before,
            "{case}: no effect, log or command survived"
        );
    }
}
#[test]
fn local_mcp_key_delete_blob_replacement_source_withdrawal_and_cancel_roll_back() {
    for case in ["key-delete", "key-blob", "receipt", "cancel"] {
        let f = Fixture::new();
        let mut owner = f.selected();
        let before = state(&f);
        let root = f.root.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let held = cancel.clone();
        let mut ids = ChangeAtPublication {
            next: 0,
            change: Some(Box::new(move || match case {
                "key-delete" => {
                    Connection::open(root.join("storage/kv/trillion-local-app/current.sqlite"))
                        .unwrap()
                        .execute(
                            "DELETE FROM _mf_entries WHERE key LIKE 'personal-key:%'",
                            [],
                        )
                        .unwrap();
                }
                "key-blob" => {
                    fs::write(root.join("storage/kv/trillion-local-app/blobs/bb"), b"null")
                        .unwrap();
                }
                "receipt" => {
                    fs::write(
                        root.join("restore-receipt.json"),
                        b"withdrawn selected source",
                    )
                    .unwrap();
                }
                "cancel" => held.store(true, Ordering::Release),
                _ => unreachable!(),
            })),
        };
        assert!(
            run_local(
                &mut owner,
                &f,
                "local-key-source-withdrawal",
                cancel,
                &mut ids
            )
            .is_err(),
            "{case}"
        );
        assert_eq!(ids.next, 1, "{case}: actual publication boundary reached");
        assert_eq!(
            state(&f),
            before,
            "{case}: no effect, log or command survived"
        );
    }
}
#[test]
fn local_mcp_original_personal_and_kv_expiry_are_still_evaluated_after_capture() {
    for case in ["personal-expiry", "kv-expiry"] {
        let f = Fixture::new();
        let mut owner = f.selected();
        let before = state(&f);
        let expires = millis() + 2_500;
        if case == "personal-expiry" {
            let path = f.root.join("storage/kv/trillion-local-app/blobs/bb");
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            value["expires_at"] = json!(iso(expires));
            fs::write(path, value.to_string()).unwrap();
        } else {
            Connection::open(f.root.join("storage/kv/trillion-local-app/current.sqlite"))
                .unwrap()
                .execute(
                    "UPDATE _mf_entries SET expiration=? WHERE key LIKE 'personal-key:%'",
                    [i64::try_from(expires).unwrap()],
                )
                .unwrap();
        }
        let mut ids = ChangeAtPublication {
            next: 0,
            change: Some(Box::new(move || {
                while millis() <= expires {
                    std::thread::sleep(Duration::from_millis(10));
                }
            })),
        };
        assert!(
            run_local(
                &mut owner,
                &f,
                "local-key-expired-after-capture",
                Arc::new(AtomicBool::new(false)),
                &mut ids
            )
            .is_err(),
            "{case}"
        );
        assert_eq!(
            ids.next, 1,
            "{case}: admitted before actual publication/expiry"
        );
        assert_eq!(
            state(&f),
            before,
            "{case}: expired authority could not commit"
        );
    }
}
#[tokio::test]
async fn actual_local_http_same_revision_gate_and_usage_withdrawal_refuses_saved_retry() {
    use tower::ServiceExt;
    for file in ["own.sqlite", "use.sqlite"] {
        let f = Fixture::new();
        let owner = Arc::new(std::sync::Mutex::new(f.selected()));
        let app = crate::native_boot::mcp_local::route_table(owner, "127.0.0.1:28788".into()).unwrap();
        let response = app
            .clone()
            .oneshot(local_http_request(
                &f,
                "local-http-retry-withdrawal",
                "2026-07-28",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        assert!(String::from_utf8(bytes.to_vec())
            .unwrap()
            .contains("written"));
        let committed = state(&f);
        change_state(&f.root.join(file), |v| {
            v["sign_ins"][&f.signin]["ended_until_ms"] = json!(millis() + 60_000)
        });
        let response = app
            .oneshot(local_http_request(
                &f,
                "local-http-retry-withdrawal",
                "2026-07-28",
            ))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 65536)
            .await
            .unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!body.contains("written"), "{file}: {body}");
        assert_eq!(
            state(&f),
            committed,
            "{file}: no repeated effect or command"
        );
    }
}

#[tokio::test]
async fn actual_local_http_lost_response_same_key_retry_returns_original_without_another_effect() {
    use tower::ServiceExt;
    let f = Fixture::new();
    let owner = Arc::new(std::sync::Mutex::new(f.selected()));
    let app = crate::native_boot::mcp_local::route_table(owner, "127.0.0.1:28788".into()).unwrap();
    let response = app
        .clone()
        .oneshot(local_http_request(
            &f,
            "local-http-same-key-recovery",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    drop(response);
    let committed = state(&f);
    assert_eq!(committed.2, 1);
    let response = app
        .oneshot(local_http_request(
            &f,
            "local-http-same-key-recovery",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 65536)
        .await
        .unwrap();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(body.contains("written"), "{body}");
    assert!(!body.contains("isError\":true"), "{body}");
    assert_eq!(
        state(&f),
        committed,
        "original effect, log and command are unchanged"
    );
}

#[tokio::test]
async fn actual_browser_http_elapsed_expiry_after_headers_keeps_the_recovered_answer_and_refuses_the_retry() {
    use tower::ServiceExt;
    let (f, owner, _) = browser_fixture();
    let expires = millis() + 2_500;
    let path = f.root.join("storage/kv/trillion-local-app/blobs/aa");
    let mut session: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    session["expires_at"] = json!(iso(expires));
    fs::write(path, session.to_string()).unwrap();
    let app = browser_http_app(&f, owner);
    let response = app
        .clone()
        .oneshot(browser_http_request(
            "elapsed-first-frame-expiry",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let committed = state(&f);
    assert_eq!(committed.2, 1);
    while millis() <= expires {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // The answer was recovered under the live session before the headers, so
    // an expiry after them neither resets the delivery nor touches the effect.
    assert!(!axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        state(&f),
        committed,
        "expiry after the headers neither undoes nor repeats the committed effect"
    );
    let response = app
        .oneshot(browser_http_request(
            "elapsed-first-frame-expiry",
            "http://127.0.0.1:7189",
            input(),
        ))
        .await
        .unwrap();
    assert_ne!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        state(&f),
        committed,
        "expired retry performs no repeated effect"
    );
}
