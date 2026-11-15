use super::*;
use base64::{Engine,engine::general_purpose::STANDARD};
use trillion_local::kept_runs::{KeptRuns, Settings};
fn generated(db: &Connection, build: impl FnOnce(&Connection, &mut KeptRuns)) {
    db.execute_batch("DROP TABLE record_keys_runs; DROP TABLE record_keys_big").unwrap();
    let tx = db.unchecked_transaction().unwrap();
    let mut runs = KeptRuns::create(&tx,"record_keys",Settings{page_bytes:2048,max_key_bytes:512,..Settings::default()}).unwrap();
    tx.commit().unwrap(); build(db,&mut runs);
}
fn flush(db: &Connection,runs: &mut KeptRuns) {
    let tx=db.unchecked_transaction().unwrap(); runs.flush(&tx,&json!(0)).unwrap();tx.commit().unwrap();
}
fn convert(db: &Connection, mode: &str) {
    let mut q=db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'record_keys_run_[0-9]*'").unwrap();
    let tables=q.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();drop(q);
    for table in tables {
        let mut q=db.prepare(&format!("SELECT page,body FROM {table} WHERE page<0")).unwrap();
        let rows=q.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,Vec<u8>>(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();drop(q);
        for (page,body) in rows {
            match mode {
                "base64"=>{db.execute(&format!("UPDATE {table} SET body=? WHERE page=?"),params![STANDARD.encode(body),page]).unwrap();},
                "missing"=>{db.execute(&format!("DELETE FROM {table} WHERE page=?"),[page]).unwrap();},
                "short"=>{db.execute(&format!("UPDATE {table} SET body=? WHERE page=?"),params![vec![0u8;body.len()-1],page]).unwrap();},
                "unsupported"=>{db.execute(&format!("UPDATE {table} SET body=42 WHERE page=?"),[page]).unwrap();},
                "malformed"=>{let mut text=STANDARD.encode(body);text.replace_range(0..1,"!");db.execute(&format!("UPDATE {table} SET body=? WHERE page=?"),params![text,page]).unwrap();},
                "zero"=>{db.execute(&format!("UPDATE {table} SET body=? WHERE page=?"),params![vec![0u8;body.len()],page]).unwrap();},
                _=>{}
            }
        }
    }
}
#[test]
fn canonical_generated_blocked_filters_preserve_present_absent_unicode_and_tombstones() {
    for mode in ["blob","base64"] {
        let f=fixture(|db|generated(db,|db,runs|{
            for n in 0..12 { runs.put(&format!("filler{n:02}"),json!("x".repeat(900))).unwrap(); }
            for key in ["a","🎹","\u{e000}","x\0\n"] {runs.put_json(key,Some("1.00".into())).unwrap();}
            flush(db,runs);runs.remove("🎹").unwrap();for n in 0..12 {runs.put(&format!("filler{n:02}"),json!("y".repeat(900))).unwrap();}flush(db,runs);convert(db,mode);
            let pages:i64=db.query_row("SELECT MIN(pages) FROM record_keys_runs",[],|r|r.get(0)).unwrap();assert!(pages>1);
        }));
        for (key,wanted) in [("a",Entry::Json("1.00".into())),("x\0\n",Entry::Json("1.00".into())),("\u{e000}",Entry::Json("1.00".into())),("🎹",Entry::Tombstone),("m",Entry::Absent)] {
            let got=reader().point(&mut open(&f),key).unwrap();assert_eq!(got.entry,wanted,"mode={mode} key={key}");
        }
        let selected = ["a", "x\0\n", "\u{e000}", "🎹", "m"]
            .iter().map(|key| (*key).to_owned()).collect::<Vec<_>>();
        let batch = reader().points_with_budget(&mut open(&f), &selected, PointBudget {
            statements: 128, rows: 4096, source_bytes: 16 * 1024 * 1024,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        }).unwrap();
        for (key, entry) in selected.iter().zip(&batch.entries) {
            assert_eq!(*entry, reader().point(&mut open(&f), key).unwrap().entry,
                "batch/point mode={mode} key={key}");
        }
    }
}
#[test]
fn optional_missing_malformed_truncated_and_unsupported_filter_still_opens_exact_page() {
    for mode in ["missing","short","unsupported","malformed","unpublished","invalid-bits"] {
        let f=fixture(|db|generated(db,|db,runs|{
            runs.put("a",json!("x".repeat(900))).unwrap();runs.put("z",json!("x".repeat(900))).unwrap();
            runs.put_json("key",Some("[1.00,2e0]".into())).unwrap();flush(db,runs);convert(db,mode);
            let pages:i64=db.query_row("SELECT MIN(pages) FROM record_keys_runs",[],|r|r.get(0)).unwrap();assert!(pages>1);
            if mode=="unpublished" {convert(db,"zero");db.execute("UPDATE record_keys_runs SET filter_bits=0",[]).unwrap();}
            if mode=="invalid-bits" {convert(db,"zero");db.execute("UPDATE record_keys_runs SET filter_bits=7",[]).unwrap();}
        }));
        let got=reader().point(&mut open(&f),"key").unwrap();assert_eq!(got.entry,Entry::Json("[1.00,2e0]".into()),"mode={mode}");
        assert_eq!(got.work.page_bodies,1);
        let batch = reader().points_with_budget(&mut open(&f), &["key".to_owned()], PointBudget {
            statements: 128, rows: 4096, source_bytes: 16 * 1024 * 1024,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        }).unwrap();
        assert_eq!(batch.entries, vec![got.entry], "batch mode={mode}");
    }
}
#[test]
fn canonical_many_run_absence_reduces_observations_without_warmup() {
    for mode in ["blob","base64"] {
        let f=fixture(|db|generated(db,|db,runs|{
            runs.put_json("m",Some("{\"original\":1.00}".into())).unwrap();flush(db,runs);
            for _ in 0..45 {
                runs.put_json("a",Some("0".into())).unwrap();runs.put_json("z",Some("1".into())).unwrap();flush(db,runs);
            }
            convert(db,mode);
        }));
        let before=fs::read(&f.database).unwrap();
        let got=reader().point(&mut open(&f),"m").unwrap();assert_eq!(got.entry,Entry::Json("{\"original\":1.00}".into()));
        eprintln!("COLD_FILTER_POINT mode={mode} {}",serde_json::to_string(&got.work).unwrap());
        assert_eq!(fs::read(&f.database).unwrap(),before);
    }
}
#[test]
fn canonical_multi_page_filter_unknown_and_negative_keep_boundary_key_fallback_and_limits() {
    for mode in ["blob","base64","missing","short"] {
        let f=fixture(|db|generated(db,|db,runs|{
            for n in 0..30 {runs.put(&format!("key{n:03}"),json!("x".repeat(200))).unwrap();}flush(db,runs);convert(db,mode);
        }));
        let mut source=open(&f);assert!(matches!(reader().point(&mut source,"key015").unwrap().entry,Entry::Json(_)));
        assert_eq!(reader().point(&mut source,"key015x").unwrap().entry,Entry::Absent);
    }
}

#[test]
fn unfiltered_48_run_batch_shares_small_run_boundary_keys_for_100_real_answers() {
    let keys = (0..100).map(|at| format!("i\0id{at:03}")).collect::<Vec<_>>();
    let f = fixture(|db| {
        let old = keys.iter().enumerate()
            .map(|(at, key)| (key.as_str(), packed(key, &at.to_string())))
            .collect::<Vec<_>>();
        run(db, 1, 1, &old, 0, 1);
        let unrelated = [
            ("a", packed("a", "0")),
            ("b", packed("b", "0")),
            ("y", packed("y", "0")),
            ("z", packed("z", "0")),
        ];
        for run_number in 2..=48 {
            run(db, run_number, run_number, &unrelated, 0, 1);
        }
    });
    let batch = reader().points_with_budget(
        &mut open(&f),
        &keys,
        PointBudget {
            statements: 128,
            rows: 4096,
            source_bytes: 16 * 1024 * 1024,
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
        },
    ).unwrap();
    for (at, entry) in batch.entries.iter().enumerate() {
        assert_eq!(*entry, Entry::Json(at.to_string()));
    }
    assert!(batch.work.sql_statements <= 128, "{}", batch.work.sql_statements);
    assert!(batch.work.rows_returned <= 4096, "{}", batch.work.rows_returned);
    eprintln!("SMALL_RUN_BATCH_48 sql={} rows={} pages={}",
        batch.work.sql_statements, batch.work.rows_returned, batch.work.page_bodies);
}


#[test]
fn original_js_positive_filter_vector_crosses_512k_chunks_without_wrong_negatives() {
    let vector:serde_json::Value=serde_json::from_str(include_str!("filter-positive-vector.json")).unwrap();
    let selected=vector["selected"].as_str().unwrap();
    for mode in ["blob","base64","missing-tail","short-tail","malformed"] {
        let f=fixture(|db| {
            let keys=vector["keys"].as_array().unwrap();
            let body=|keys: &[serde_json::Value]|format!("{}\n{}",json!({"p":vec![0;keys.len()],"s":keys,"d":vec![4;keys.len()]}),"1.00".repeat(keys.len()));
            run(db,1,1,&[("a",body(&keys[..2])),("z",body(&keys[2..]))],0,1);
            db.execute_batch("ALTER TABLE record_keys_runs ADD COLUMN filter_bits INTEGER DEFAULT 0").unwrap();
            db.execute("UPDATE record_keys_runs SET filter_bits=?,last=?",params![vector["bits"].as_i64().unwrap(),serde_json::to_string(keys.last().unwrap().as_str().unwrap()).unwrap()]).unwrap();
            let mut bytes=vec![0;vector["bytes"].as_u64().unwrap() as usize];
            for pair in vector["nonzero"].as_array().unwrap() {bytes[pair[0].as_u64().unwrap()as usize]=pair[1].as_u64().unwrap() as u8;}
            for (chunk,body) in bytes.chunks(512*1024).enumerate() {
                if mode=="missing-tail" && chunk==1 {continue;}
                let page=-1-chunk as i64;
                if mode=="base64" || mode=="malformed" {
                    let mut text=STANDARD.encode(body);if mode=="malformed" {text.replace_range(0..1,"!");}
                    db.execute("INSERT INTO record_keys_run_1 VALUES(?,NULL,?)",params![page,text]).unwrap();
                } else {
                    let body=if mode=="short-tail" && chunk==1 {&body[..body.len()-1]}else{body};
                    db.execute("INSERT INTO record_keys_run_1 VALUES(?,NULL,?)",params![page,body]).unwrap();
                }
            }
        });
        let got=reader().point(&mut open(&f),selected).unwrap();assert_eq!(got.entry,Entry::Json("1.00".into()),"mode={mode}");
        assert!(got.work.source_bytes<8192,"sparse samples cannot copy the512KiB filter into the caller");
        eprintln!("COLD_FILTER_POSITIVE mode={mode} {}",serde_json::to_string(&got.work).unwrap());
    }
}

#[test]
fn duplicate_optional_negative_rows_cannot_certify_false_absence() {
    let f=fixture(|db|generated(db,|db,runs|{
        runs.put("a",json!("x".repeat(900))).unwrap();
        runs.put("z",json!("x".repeat(900))).unwrap();
        runs.put_json("key",Some("1.00".into())).unwrap();flush(db,runs);
        let pages:i64=db.query_row("SELECT pages FROM record_keys_runs WHERE run=1",[],|r|r.get(0)).unwrap();assert!(pages>1);
        // Malformed optional rows do not change the selected page's value.
        // The former scalar subquery chose the first zero row and lied absent.
        db.execute_batch("ALTER TABLE record_keys_run_1 RENAME TO saved_run; CREATE TABLE record_keys_run_1(page INTEGER,first TEXT,body BLOB)").unwrap();
        db.execute("INSERT INTO record_keys_run_1 VALUES(-1,NULL,?)",[vec![0u8;64]]).unwrap();
        db.execute_batch("INSERT INTO record_keys_run_1 SELECT page,first,body FROM saved_run; DROP TABLE saved_run").unwrap();
    }));
    assert_eq!(reader().point(&mut open(&f),"key").unwrap().entry,Entry::Json("1.00".into()));
    let batch = reader().points_with_budget(&mut open(&f), &["key".to_owned()], PointBudget {
        statements: 128, rows: 4096, source_bytes: 16 * 1024 * 1024,
        deadline: std::time::Instant::now() + std::time::Duration::from_secs(5),
    }).unwrap();
    assert_eq!(batch.entries, vec![Entry::Json("1.00".into())]);
}
