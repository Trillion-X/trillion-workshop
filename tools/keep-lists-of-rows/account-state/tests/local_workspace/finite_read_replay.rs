//! Finite, complete HTTP read replay through the current selected Rust owner.
//! Synthetic state makes this repeatable; it is not the old seven-minute app replay.
use super::*;

#[cfg(target_os = "macos")]
#[tokio::test]
async fn routed_finite_read_replay_counts_setup_cold_hot_and_reopen() {
    let names = (0..64).map(|i| format!("record-{i:03}")).collect::<Vec<_>>();
    let values = (0..64).map(|i| json!({"n":i,"useful":true}).to_string()).collect::<Vec<_>>();
    let rows = names.iter().zip(values.iter()).map(|(n,v)| (n.as_str(),v.as_str())).collect::<Vec<_>>();
    let f = Fixture::new(&rows);
    let setup = f.owner.lock().unwrap().sql_work().unwrap().work;
    eprintln!("finite-routed-read phase=owner-open statements={} visits={} writes={}",
        setup.sql_statements, setup.sqlite_scan_visits, setup.rows_written);

    let mut previous = setup;
    for (phase, indexes) in [
        ("cold-point", vec![17]),
        ("all-64", (0..64).collect::<Vec<_>>()),
        ("hot-point-64", vec![17;64]),
    ] {
        for i in indexes.iter().copied() {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("label", &names[i]).finish();
            let (status, body) = f.get(&query).await;
            assert_eq!(status, StatusCode::OK, "{phase} row {i}");
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["records"][names[i].as_str()], serde_json::from_str::<Value>(&values[i]).unwrap());
            assert_eq!(body["records"].as_object().unwrap().len(), 1);
        }
        let now = f.owner.lock().unwrap().sql_work().unwrap().work;
        eprintln!("finite-routed-read phase={phase} calls={} statements={} visits={} writes={}",
            indexes.len(), now.sql_statements-previous.sql_statements,
            now.sqlite_scan_visits-previous.sqlite_scan_visits,
            now.rows_written-previous.rows_written);
        assert_eq!(now.rows_written, previous.rows_written, "read route changed stored rows");
        previous = now;
    }

    let Fixture { _temp: held, app, adapter, owner, .. } = f;
    drop((app, adapter, owner));
    let (reopened, owner) = copied_one_record_controls::reopened_app(held.path());
    let opened = owner.lock().unwrap().sql_work().unwrap().work;
    eprintln!("finite-routed-read phase=reopen-owner statements={} visits={} writes={}",
        opened.sql_statements, opened.sqlite_scan_visits, opened.rows_written);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("label", &names[17]).finish();
    let response = reopened.oneshot(request("GET", &format!("/work/api/records?{query}"), None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(&to_bytes(response.into_body(), 8*1024*1024).await.unwrap()).unwrap();
    assert_eq!(body["records"][names[17].as_str()], serde_json::from_str::<Value>(&values[17]).unwrap());
    let after = owner.lock().unwrap().sql_work().unwrap().work;
    eprintln!("finite-routed-read phase=reopen-point calls=1 statements={} visits={} writes={}",
        after.sql_statements-opened.sql_statements,
        after.sqlite_scan_visits-opened.sqlite_scan_visits,
        after.rows_written-opened.rows_written);
    assert_eq!(after.rows_written, opened.rows_written);
}
