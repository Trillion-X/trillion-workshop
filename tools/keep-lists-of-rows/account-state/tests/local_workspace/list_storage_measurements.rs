//! Complete synthetic caller writes, observation coverage and immediate reads.
use super::*;

async fn write_list_records(f: &Fixture, key: &str, records: Value) {
    let mut post = request("POST", "/work/api/records", Some(&json!({"records":records}).to_string()));
    post.headers_mut().insert(header::ORIGIN, ORIGIN.parse().unwrap());
    post.headers_mut().insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    post.headers_mut().insert("x-trillion-request-key", key.parse().unwrap());
    let response = f.app.clone().oneshot(post).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(status, StatusCode::OK, "synthetic write {key}: {}", String::from_utf8_lossy(&bytes));
}

#[tokio::test]
async fn measured_list_writes_are_immediately_readable_100_times() {
    ADMIT_APART.with(|flag| flag.set(true));
    let f = records_write_controls::started_fixture();
    write_list_records(&f, "list-proof-definition", json!([{
        "id":"list:proof", "type":"list", "value":{
            "id":"proof", "label":"Synthetic proof", "row_type":"proof", "title_field":"text",
            "fields":[{"id":"text", "label":"Text", "kind":"text"}]
        }
    }])).await;
    let mut statements = Vec::new();
    let mut visits = Vec::new();
    let mut returned = Vec::new();
    let mut writes = Vec::new();
    for sequence in 0..100 {
        let measured = f.owner.lock().unwrap().begin_sql_observation().unwrap();
        let started = std::time::Instant::now();
        write_list_records(&f, &format!("list-proof-{sequence}"), json!([{
            "id":"record:proof:row", "type":"record:proof", "value":{"text":format!("value-{sequence}")}
        }])).await;
        let elapsed = started.elapsed();
        let after = measured.finish().unwrap();
        let delta = (
            after.work.sql_statements,
            after.work.sqlite_scan_visits,
            after.work.rows_returned,
            after.work.rows_written,
        );
        assert!(delta.0 > 0, "positive control: the public write must reach the meter");
        statements.push(delta.0);
        visits.push(delta.1);
        returned.push(delta.2);
        writes.push(delta.3);
        let input = json!({"id":"record:proof:row"});
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("input", &input.to_string()).finish();
        let response = f.app.clone().oneshot(request("GET", &format!("/work/api/door/records:read?{query}"), None)).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        assert_eq!(status, StatusCode::OK, "read after write {sequence}: {}", String::from_utf8_lossy(&body));
        let read: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(read["value"]["text"], format!("value-{sequence}"), "immediate authoritative read {sequence}");
        eprintln!("list-storage-write sequence={sequence} statements={} scan_visits={} returned_rows={} written_rows={} elapsed_us={}", delta.0, delta.1, delta.2, delta.3, elapsed.as_micros());
    }
    eprintln!("list-storage-read-after-write successes=100 attempts=100");
    for (name, samples) in [("statements",statements),("scan_visits",visits),("returned_rows",returned),("written_rows",writes)] {
        eprintln!("list-storage-summary unit={name} count={} first={} min={} max={} total={}", samples.len(), samples[0], samples.iter().min().unwrap(), samples.iter().max().unwrap(), samples.iter().sum::<u64>());
    }
}


#[cfg(feature = "sql-statement-attribution")]
#[tokio::test]
async fn list_write_statement_attribution_covers_the_complete_http_operation() {
    ADMIT_APART.with(|flag| flag.set(true));
    let f = records_write_controls::started_fixture();
    write_list_records(&f, "attribution-list", json!([{
        "id":"list:proof", "type":"list", "value":{
            "id":"proof", "label":"Synthetic proof", "row_type":"proof", "title_field":"text",
            "fields":[{"id":"text", "label":"Text", "kind":"text"}]
        }
    }])).await;
    let meter = unsafe { f.owner.lock().unwrap().enable_fixture_sql_attribution(512).unwrap() };
    for sequence in 0..3 {
        write_list_records(&f, &format!("attribution-row-{sequence}"), json!([{
            "id":"record:proof:row", "type":"record:proof", "value":{"text":format!("value-{sequence}")}
        }])).await;
    }
    let mut captured = meter.fixture_statement_snapshot().unwrap();
    assert!(captured.complete, "every actual statement and row must be accounted");
    captured.statements.sort_by_key(|s| std::cmp::Reverse(s.work.rows_returned));
    for statement in captured.statements {
        eprintln!("list-storage-attribution statements={} visits={} returned={} written={} template={:?}",
            statement.work.sql_statements, statement.work.sqlite_scan_visits, statement.work.rows_returned,
            statement.work.rows_written, statement.sql_template);
    }
    assert!(captured.work.sql_statements > 0);
}

async fn read_list_record(f: &Fixture, operation: &str, input: Value) -> Value {
    let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("input", &input.to_string()).finish();
    let response = f.app.clone().oneshot(request("GET", &format!("/work/api/door/{operation}?{query}"), None)).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{operation} {input}: {}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).unwrap()
}

/// Rows of `kind` the account's primary RecordBook holds as live records.
fn primary_rows(f: &Fixture, kind: &str) -> i64 {
    let db = Connection::open(&f.records).unwrap();
    db.query_row(
        "SELECT COUNT(*) FROM versions WHERE resource='own-records' AND kind=? AND valid_to=9223372036854775807 AND deleted=0",
        [kind],
        |row| row.get(0),
    )
    .unwrap()
}

/// Every list keeps its rows in a store of its own (`@list/<row_type>`, a `list-<row_type>.sqlite` file in the account's
/// state folder; old trillion src/placed-lists.mjs): a new list is given that store when it is made, its rows are written
/// there and never into the primary RecordBook, and every read finds them there: by id with no type (a link, a shared
/// child, an agent's read), by id and type, and as the list's page. An update and a removal land in the same store.
#[tokio::test]
async fn a_new_lists_rows_live_in_a_store_of_their_own_and_every_read_finds_them() {
    let f = records_write_controls::started_fixture();
    write_list_records(&f, "own-store-definition", json!([{
        "id":"list:proof", "type":"list", "value":{
            "id":"proof", "label":"Synthetic proof", "row_type":"proof", "title_field":"text",
            "fields":[{"id":"text", "label":"Text", "kind":"text"}]
        }
    }])).await;
    let list = read_list_record(&f, "records:read", json!({"id":"list:proof"})).await;
    assert_eq!(list["value"]["placement"], json!({"database":"proof"}), "a new list is given a store of its own: {list}");

    // One row whose id names its type, one whose id does not (as a library row's `x-money:...` does).
    write_list_records(&f, "own-store-rows", json!([
        {"id":"record:proof:one", "type":"record:proof", "value":{"text":"first synthetic row"}},
        {"id":"proof-two", "type":"record:proof", "value":{"text":"second synthetic row"}}
    ])).await;
    let state = f.records.parent().unwrap();
    assert!(state.join("list-proof.sqlite").is_file(), "the list's rows have a file of their own");
    assert_eq!(primary_rows(&f, "record:proof"), 0, "no row of the list is kept in the primary RecordBook");

    for id in ["record:proof:one", "proof-two"] {
        let bare = read_list_record(&f, "records:read", json!({"id":id})).await;
        assert_eq!(bare["type"], "record:proof", "a read by id alone finds the row in its list's store: {bare}");
        let typed = read_list_record(&f, "records:read", json!({"id":id, "type":"record:proof"})).await;
        assert_eq!(typed["value"], bare["value"], "{typed}");
    }
    let page = read_list_record(&f, "records:list", json!({"type":"record:proof"})).await;
    let ids: Vec<&str> = page["records"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["record:proof:one", "proof-two"], "the list's page reads its store: {page}");

    // An update and a removal are made in the list's store.
    write_list_records(&f, "own-store-update", json!([{"id":"proof-two", "type":"record:proof", "value":{"text":"changed synthetic row"}}])).await;
    let changed = read_list_record(&f, "records:read", json!({"id":"proof-two"})).await;
    assert_eq!(changed["value"]["text"], "changed synthetic row", "{changed}");
    write_list_records(&f, "own-store-remove", json!([{"id":"record:proof:one", "type":"record:proof", "value":null}])).await;
    let removed = read_list_record(&f, "records:read", json!({"id":"record:proof:one"})).await;
    assert_eq!(removed["value"], Value::Null, "{removed}");
    let page = read_list_record(&f, "records:list", json!({"type":"record:proof"})).await;
    assert_eq!(page["records"].as_array().unwrap().len(), 1, "{page}");
    assert_eq!(primary_rows(&f, "record:proof"), 0);
}
