fn multipart_source_with_limits(f:&Fixture,limits:ReadLimits)->(Source,WorkMeter) {
    let db=Connection::open_with_flags(&f.path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX).unwrap();
    let meter=WorkMeter::new();
    let db=unsafe{ObservedConnection::attach_untraced(db,meter.clone())}.unwrap();
    let witness:fn()->ImportResult<()>=||Ok(());
    let source=SnapshotRecordSql::begin(db,limits,witness,Arc::new(AtomicBool::new(false))).unwrap();
    (SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap(),meter)
}

#[test]
fn multipart_complete_value_and_supplier_packet_limits_keep_exact_utf8_text() {
    for tight in [false,true] {
        let f=Fixture::new(1,None,false);
        let raw=if tight {
            format!("{{\"x\":\"{}😀{}\",\"n\":1.00}}","x".repeat(8146),"y".repeat(70_000))
        } else {
            format!("{{\"x\":\"{}😀{}\",\"n\":1.00}}","x".repeat(1_048_568),"y".repeat(2_000_000))
        };
        let db=Connection::open(&f.path).unwrap();
        let parts=if tight {1usize} else {32};
        db.execute("UPDATE record_keys_run_1 SET body=? WHERE page=1",[json!([["i\0decision:00000","full-exact",parts]]).to_string()]).unwrap();
        let mut offset=0;
        for part in 0..parts {
            let mut end=if part+1==parts {raw.len()} else {(part+1)*raw.len()/parts};
            while !raw.is_char_boundary(end) {end-=1;}
            db.execute("INSERT INTO record_keys_big VALUES('full-exact',?,?)",params![part as i64,&raw[offset..end]]).unwrap();
            offset=end;
        }
        assert_eq!(offset,raw.len());
        drop(db);
        let mut limits=ReadLimits::default();
        if tight {limits.result_bytes=8192;}
        let (mut source,meter)=multipart_source_with_limits(&f,limits);
        let answer=LegacyKept::new(Default::default()).unwrap().point_with_budget(&mut source,"i\0decision:00000",crate::legacy_kept::PointBudget{statements:128,rows:4096,source_bytes:8*1024*1024,deadline:std::time::Instant::now()+std::time::Duration::from_secs(5)});
        let completed=answer.is_ok();
        match answer {
            Ok(point)=>{
                assert_eq!(point.entry,crate::legacy_kept::Entry::Json(raw.clone()));
                eprintln!("SUPPLEMENTAL_MULTIPART tight={} status=ok calls={} returned={} source_bytes={} chunks={} exact_value_bytes={}",tight,point.work.sql_statements,point.work.rows_returned,point.work.source_bytes,point.work.multipart_chunks,raw.len());
            },
            Err(error)=>{
                assert!(tight,"complete default-bound value must be readable");
                eprintln!("SUPPLEMENTAL_MULTIPART tight={} status=refused reason={} calls={} returned={} source_bytes={}",tight,error.reason,error.work.sql_statements,error.work.rows_returned,error.work.source_bytes);
            }
        }
        let shared=source.work().unwrap();let finished=source.finish();
        if completed {finished.unwrap();}
        let physical=meter.snapshot().unwrap();
        eprintln!("SUPPLEMENTAL_PHYSICAL tight={} shared={:?} work={:?}",tight,shared,physical.work);
        assert_eq!(physical.work.rows_written,0);
    }
}

#[test]
fn multipart_smaller_aggregate_bytes_still_refuse_before_complete_answer() {
    let f=Fixture::new(1,None,false);
    let db=Connection::open(&f.path).unwrap();
    db.execute("UPDATE record_keys_run_1 SET body=? WHERE page=1",[json!([["i\0decision:00000","bounded",1]]).to_string()]).unwrap();
    db.execute("INSERT INTO record_keys_big VALUES('bounded',0,?)",[format!("\"{}\"","x".repeat(70_000))]).unwrap();
    drop(db);
    let (mut source,meter)=multipart_source_with_limits(&f,ReadLimits::default());
    let refused=LegacyKept::new(Default::default()).unwrap().point_with_budget(&mut source,"i\0decision:00000",crate::legacy_kept::PointBudget{statements:128,rows:4096,source_bytes:8192,deadline:std::time::Instant::now()+std::time::Duration::from_secs(5)}).unwrap_err();
    assert!(refused.budget_exhausted||refused.source.is_some());
    let finish_ok=source.finish().is_ok();
    assert_eq!(meter.snapshot().unwrap().work.rows_written,0);
    eprintln!("SUPPLEMENTAL_AGGREGATE_REFUSAL calls={} returned={} bytes={} finish_ok={}",refused.work.sql_statements,refused.work.rows_returned,refused.work.source_bytes,finish_ok);
}

#[test]
fn multipart_small_physical_cell_keeps_large_stored_part_refused() {
    let f=Fixture::new(1,None,false);
    let db=Connection::open(&f.path).unwrap();
    db.execute("UPDATE record_keys_run_1 SET body=? WHERE page=1",[json!([["i\0decision:00000","physical-cell",1]]).to_string()]).unwrap();
    db.execute("INSERT INTO record_keys_big VALUES('physical-cell',0,?)",[format!("\"{}\"","x".repeat(70_000))]).unwrap();
    drop(db);
    let mut limits=ReadLimits::default();limits.cell_bytes=4096;limits.result_bytes=8192;
    let (mut source,meter)=multipart_source_with_limits(&f,limits);
    let answer=LegacyKept::new(Default::default()).unwrap().point(&mut source,"i\0decision:00000");
    assert!(answer.is_err(),"packet sizing must not relax SQLite's actual cell ceiling");
    let _=source.finish();
    assert_eq!(meter.snapshot().unwrap().work.rows_written,0);
    eprintln!("SUPPLEMENTAL_PHYSICAL_CELL_REFUSAL cell_bytes=4096 stored_part_bytes=70002");
}
