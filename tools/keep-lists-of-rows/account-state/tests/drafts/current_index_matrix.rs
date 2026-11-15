#[test]
fn dirty_tail132_diagnostic_matrix_distinguishes_second_build_from_replay_and_range() {
    for runs in [1usize,16,32,64] {
        for padding in [0usize,26000] {
            let f=Fixture::new(101,Some("[]".into()),false);
            let db=Connection::open(&f.path).unwrap();
            for run in 2..=runs {
                db.execute_batch(&format!("CREATE TABLE record_keys_run_{run}(page INTEGER PRIMARY KEY,first TEXT,body TEXT); INSERT INTO record_keys_run_{run} SELECT * FROM record_keys_run_1; INSERT INTO record_keys_runs SELECT {run},{run},pages,last,page_format,page_layout FROM record_keys_runs WHERE run=1")).unwrap();
            }
            db.execute("DELETE FROM record_log",[]).unwrap();
            for row in 0..132 {
                let id=if row==131 {"decision:00000a"} else {"decision:00000"};
                let body=json!([{"id":id,"type":"decision","set":{"created_at":format!("new:{row:05}"),"padding":"p".repeat(padding)},"at":format!("z{row:05}"),"seq":format!("seq:{row:05}")}]).to_string();
                db.execute("INSERT INTO record_log VALUES(?,?,'fixture','a','a',0,1,?,NULL)",params![format!("01234567-89ab-7cde-8f01-{row:012}"),format!("tx:{row}"),body]).unwrap();
            }
            drop(db);
            eprintln!("DIRTY132_MATRIX_BEGIN runs={runs} padding={padding}");
            match query(&f,&Query{limit:100,reverse:true,..Default::default()},Default::default()) {
                Ok((page,work))=>eprintln!("DIRTY132_MATRIX_RESULT runs={} padding={} status=ok calls={} rows={} bytes={} dirty={} selected={} sql={} visits={} writes={}",runs,padding,page.work.record_log_statements,page.work.record_log_rows,page.work.record_log_source_bytes,page.work.dirty_records,page.entries.len(),work.sql_statements,work.sqlite_scan_visits,work.rows_written),
                Err(error)=>{
                    eprintln!("DIRTY132_MATRIX_RESULT runs={runs} padding={padding} error={error:?}");
                    if runs==64 {
                        let record_indexes::Error::CurrentIndexBound(d, _)=error else {panic!("expected second checkpoint build refusal")};
                        assert_eq!(d.reason,IndexBoundReason::RecordCalls);
                        assert_eq!(d.source_calls,128);
                        assert_eq!(d.dirty_records,1);
                        assert_eq!(d.uncovered_log_rows,132);
                    }
                }
            }
        }
    }
}
