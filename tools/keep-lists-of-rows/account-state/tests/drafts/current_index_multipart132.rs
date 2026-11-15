#[test]
fn dirty_tail132_multipart_build_keeps_original_caps_and_exact_current_entries() {
    let f=Fixture::new(2,Some("[]".into()),false);
    let db=Connection::open(&f.path).unwrap();
    let key="i\0decision:00001";
    let marker=json!([[key,"multipart-132",32]]).to_string();
    db.execute("UPDATE record_keys_run_1 SET body=? WHERE page=3",[marker]).unwrap();
    let raw=format!(r#"["decision","old-sequence",{{"created_at":"date:00001","title":"\ud800","large":{}}},{{"at":"a"}}]"#,serde_json::to_string(&"x".repeat(4_500_000)).unwrap());
    let mut offset=0;
    for part in 0..32 {
        let end=if part==31 {raw.len()} else {(part+1)*raw.len()/32};
        db.execute("INSERT INTO record_keys_big VALUES('multipart-132',?,?)",params![part as i64,&raw[offset..end]]).unwrap();
        offset=end;
    }
    assert_eq!(offset,raw.len());
    db.execute("DELETE FROM record_log",[]).unwrap();
    for row in 0..132 {
        let id=if row==131 {"decision:00001"} else {"decision:00000"};
        let body=json!([{"id":id,"type":"decision","set":{"created_at":format!("new:{row:05}")},"at":format!("z{row:05}"),"seq":format!("seq:{row:05}")}]).to_string();
        db.execute("INSERT INTO record_log VALUES(?,?,'fixture','a','a',0,1,?,NULL)",params![format!("01234567-89ab-7cde-8f01-{row:012}"),format!("tx:{row}"),body]).unwrap();
    }
    drop(db);
    match query(&f,&Query{limit:100,reverse:true,..Default::default()},Default::default()) {
        Ok((page,work))=>{
            assert_eq!(page.entries.iter().map(|e|e.id.as_str()).collect::<Vec<_>>(),vec!["decision:00001","decision:00000"]);
            assert!(page.complete && page.next.is_none());
            assert_eq!(page.work.dirty_records,2);
            assert!(page.work.record_log_statements<=128);
            assert_eq!(work.rows_written,0);
            eprintln!("MULTIPART132_RESULT status=ok calls={} rows={} bytes={} dirty={} selected={} sql={} visits={} writes={}",page.work.record_log_statements,page.work.record_log_rows,page.work.record_log_source_bytes,page.work.dirty_records,page.entries.len(),work.sql_statements,work.sqlite_scan_visits,work.rows_written);
        }
        Err(error)=>{
            eprintln!("MULTIPART132_RESULT status=refused error={error:?}");
            let record_indexes::Error::CurrentIndexBound(d, _)=error else {panic!("explicit current-index bound expected")};
            assert_eq!(d.reason,IndexBoundReason::RecordCalls);
            assert_eq!(d.source_calls,128);
            assert_eq!(d.dirty_records,1);
            assert_eq!(d.uncovered_log_rows,132);
        }
    }
}
