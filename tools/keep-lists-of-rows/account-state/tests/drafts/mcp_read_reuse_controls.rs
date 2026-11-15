// Opposing controls on the real selected owner and original private gates.
use super::*;
use crate::native_boot::mcp_selected_personal::private_view::read_current_registered_private_view;

#[test]
fn mcp_read_reuse_finishes_real_authorization_after_provisional_queries() {
    for withdrawal in ["none", "key", "usage", "private-reach", "selection", "cancel"] {
        let fixture = Fixture::new();
        let mut selected = fixture.selected();
        selected
            .authorize_personal_mcp_private_view(fixture.token.as_bytes(), &fixture.principal())
            .unwrap();
        let saved = state(&fixture);
        let selection = &selected.selection;
        let mut key = crate::mcp_personal_key::verified_personal_key(
            &mut selected.owner,
            fixture.token.as_bytes(),
        )
        .unwrap();
        let account = key.account_id().to_owned();
        let cancel = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(2);
        key.with_current_local_claims_for_final_output(|owner, claims, key_current| {
            let admitted = read_current_registered_private_view(owner, claims, &account)?;
            let mut first_check = true;
            let mut changed = false;
            let mut current = |owner: &mut LocalAccount| {
                if !first_check && !changed {
                    changed = true;
                    match withdrawal {
                        "key" => {
                            let digest = SecretNativeKey::parse(&fixture.token).unwrap().identity();
                            Connection::open(fixture.root.join("storage/kv/trillion-local-app/current.sqlite"))
                                .unwrap()
                                .execute("DELETE FROM _mf_entries WHERE key=?", [format!("personal-key:{digest}")])
                                .unwrap();
                        }
                        "usage" => change_gate(&fixture, "use.sqlite", |value| {
                            value["sign_ins"][&fixture.signin]["ended_until_ms"] = json!(millis() + 60_000);
                        }),
                        "private-reach" => change_gate(&fixture, "own.sqlite", |value| {
                            value["sign_ins"][&fixture.signin]["chosen"] = json!({"private":false,"spaces":["team"]});
                        }),
                        "selection" => {
                            let path = fixture.root.join("adoption.json");
                            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                            value["port"] = json!(28789);
                            fs::write(path, value.to_string()).unwrap();
                        }
                        "cancel" => cancel.store(true, std::sync::atomic::Ordering::Release),
                        "none" => {}
                        _ => unreachable!(),
                    }
                }
                first_check = false;
                if cancel.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline {
                    return Err(trillion_local::cause!(crate::account::AccountError::SourceChanged));
                }
                selection.assert_current().map_err(|_| trillion_local::cause!(crate::account::AccountError::SourceChanged))?;
                key_current(owner)?;
                let fresh = read_current_registered_private_view(owner, claims, &account)?;
                if fresh != admitted || !fresh.reach.private {
                    return Err(trillion_local::cause!(crate::account::AccountError::RightsChanging));
                }
                Ok(())
            };
            let result = owner.prepare_personal_record_projection(
                &mut current,
                Some(&crate::workspace_records::Selection {
                    labels: vec!["saved-board".into()],
                    prefixes: vec![],
                }),
                cancel.clone(),
                deadline,
            );
            drop(current);
            if withdrawal == "none" {
                let (snapshot, _) = result.unwrap();
                assert_eq!(snapshot.records.len(), 1);
                assert_eq!(snapshot.records[0].0, "saved-board");
                assert_eq!(snapshot.work.rows_written, 0);
            } else {
                assert!(result.is_err(), "{withdrawal}: provisional rows must not leave without final authorization");
            }
            assert!(changed, "the operation must finish its full current check");
            Ok(())
        })
        .unwrap();
        assert_eq!(state(&fixture), saved, "{withdrawal}: no record, log or command write");
    }
}

#[tokio::test]
async fn mcp_read_reuse_rechecks_clock_expiry_at_first_disclosure_chunk() {
    use std::sync::Mutex;
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let selected = fixture.selected();
    let expires_at = millis() + 750;
    let key_blob = fixture.root.join("storage/kv/trillion-local-app/blobs/bb");
    let mut key: Value = serde_json::from_slice(&fs::read(&key_blob).unwrap()).unwrap();
    key["expires_at"] = json!(iso(expires_at));
    fs::write(&key_blob, key.to_string()).unwrap();
    let key_after_setup = fs::read(&key_blob).unwrap();
    let before_state = state(&fixture);

    let owner = Arc::new(Mutex::new(selected));
    let app = crate::native_boot::mcp_local::route_table(owner, "127.0.0.1:28788".into()).unwrap();
    let request_started = Instant::now();
    let response = app
        .oneshot(local_read_http_request_for_protocol(
            &fixture,
            "clock-expiry-read",
            "synthetic-clock-expiry-client",
            "@own-records",
            "2026-07-28",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let (parts, mut body) = response.into_parts();
    assert!(!parts
        .headers
        .contains_key(axum::http::header::CONTENT_LENGTH));
    let hint = http_body::Body::size_hint(&body);
    assert_eq!(hint.lower(), 0);
    assert!(hint.upper().is_none());

    while millis() <= expires_at {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(request_started.elapsed() < crate::workspace_records::Limits::default().elapsed);
    let chunk =
        std::future::poll_fn(|cx| http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx))
            .await;
    assert!(
        matches!(chunk, Some(Err(_))),
        "expired key must withhold disclosure"
    );
    assert_eq!(
        state(&fixture),
        before_state,
        "read has no record or journal effect"
    );
    assert_eq!(
        fs::read(&key_blob).unwrap(),
        key_after_setup,
        "no key source changed after prepare"
    );
}

#[tokio::test]
async fn mcp_read_reuse_rejects_same_value_key_source_aba_before_first_chunk() {
    use std::sync::Mutex;
    use tower::ServiceExt;
    for change in ["kv-entry", "same-bytes-new-blob-generation"] {
        let fixture = Fixture::new();
        let selected = fixture.selected();
        let key = format!(
            "personal-key:{}",
            SecretNativeKey::parse(&fixture.token).unwrap().identity()
        );
        let key_blob = fixture.root.join("storage/kv/trillion-local-app/blobs/bb");
        let original_blob = fs::read(&key_blob).unwrap();
        let before_state = state(&fixture);
        let owner = Arc::new(Mutex::new(selected));
        let app = crate::native_boot::mcp_local::route_table(owner, "127.0.0.1:28788".into()).unwrap();
        let response = app
            .oneshot(local_read_http_request_for_protocol(&fixture, "key-aba-read", "synthetic-aba-client", "@own-records", "2026-07-28"))
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{change}");
        let (parts, mut body) = response.into_parts();
        assert!(!parts
            .headers
            .contains_key(axum::http::header::CONTENT_LENGTH));
        assert!(
            http_body::Body::size_hint(&body).upper().is_none(),
            "{change}"
        );

        match change {
            "kv-entry" => {
                let kv = Connection::open(
                    fixture
                        .root
                        .join("storage/kv/trillion-local-app/current.sqlite"),
                )
                .unwrap();
                kv.execute("UPDATE _mf_entries SET blob_id='aa' WHERE key=?", [&key])
                    .unwrap();
                kv.execute("UPDATE _mf_entries SET blob_id='bb' WHERE key=?", [&key])
                    .unwrap();
            }
            "same-bytes-new-blob-generation" => {
                let replacement = key_blob.with_extension("replacement");
                fs::write(&replacement, b"different-generation").unwrap();
                fs::rename(&replacement, &key_blob).unwrap();
                let replacement = key_blob.with_extension("restored");
                fs::write(&replacement, &original_blob).unwrap();
                fs::rename(&replacement, &key_blob).unwrap();
                assert_eq!(fs::read(&key_blob).unwrap(), original_blob);
            }
            _ => unreachable!(),
        }

        let chunk = std::future::poll_fn(|cx| {
            http_body::Body::poll_frame(std::pin::Pin::new(&mut body), cx)
        })
        .await;
        assert!(matches!(chunk, Some(Err(_))), "{change}");
        assert_eq!(state(&fixture), before_state, "{change}");
        assert_eq!(fs::read(&key_blob).unwrap(), original_blob, "{change}");
    }
}
