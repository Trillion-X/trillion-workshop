//! Compact projection controls; no original account or cloud resources are used.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use trillion_local::kept_runs::{Error,KeptRuns,Lookup,Range,ReadBudget,Settings};
fn create(db:&mut Connection,settings:Settings)->KeptRuns{let tx=db.transaction().unwrap();let runs=KeptRuns::create(&tx,"record_keys",settings).unwrap();tx.commit().unwrap();runs}
fn flush(db:&mut Connection,runs:&mut KeptRuns,covered:i64){let tx=db.transaction().unwrap();runs.flush(&tx,&json!(covered)).unwrap();tx.commit().unwrap();}
fn range<'a>(lo:&'a str,hi:&'a str,reverse:bool,limit:usize)->Range<'a>{Range{lo,hi,after:None,reverse,limit}}

#[test]
fn exact_memtable_flush_cold_restart_and_scope_keys_preserve_json_null(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("compact.sqlite");let mut db=Connection::open(&path).unwrap();let mut runs=create(&mut db,Settings::default());
    runs.put("i|first",json!({"x":1,"wide":"🎹"})).unwrap();runs.put("i|last",Value::Null).unwrap();
    let hot=runs.get(&db,"i|first",ReadBudget::default()).unwrap();assert_eq!(hot.work.sql_statements,0);assert_eq!(hot.result,Lookup::Value(json!({"x":1,"wide":"🎹"})));
    flush(&mut db,&mut runs,12);assert_eq!(runs.covered(&db).unwrap(),Some(json!(12)));drop(runs);drop(db);
    let db=Connection::open(path).unwrap();let mut cold=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();
    assert_eq!(cold.get(&db,"i|last",ReadBudget::default()).unwrap().result,Lookup::Value(Value::Null));
    let read=cold.get(&db,"i|first",ReadBudget::default()).unwrap();assert_eq!(read.result,Lookup::Value(json!({"x":1,"wide":"🎹"})));assert_eq!(read.work.selected_values,1);assert!(read.work.page_bodies<=1);
    assert_eq!(cold.get(&db,"not|ours",ReadBudget::default()).unwrap().result,Lookup::Absent);
}

#[test]
fn tombstones_and_new_winners_never_open_superseded_large_values(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());
    runs.put("i|one",json!("OLD".repeat(100_000))).unwrap();runs.put("i|two",json!("OLD".repeat(100_000))).unwrap();flush(&mut db,&mut runs,1);
    runs.put("i|one",json!({"winner":"new"})).unwrap();runs.remove("i|two").unwrap();flush(&mut db,&mut runs,2);
    // Corrupt old BIG bytes: correctness must not depend on opening them.
    db.execute("UPDATE record_keys_big SET body='malformed OLD VALUE'",[]).unwrap();
    let mut cold=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();
    let one=cold.get(&db,"i|one",ReadBudget::default()).unwrap();assert_eq!(one.result,Lookup::Value(json!({"winner":"new"})));assert_eq!(one.work.selected_values,1);
    let two=cold.get(&db,"i|two",ReadBudget::default()).unwrap();assert_eq!(two.result,Lookup::Tombstone);assert_eq!(two.work.selected_values,0);
    for reverse in [false,true]{let mut cold=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();let page=cold.range(&db,range("i|","j|",reverse,20),ReadBudget::default()).unwrap();assert!(page.complete);assert_eq!(page.entries,vec![("i|one".into(),json!({"winner":"new"}))]);assert_eq!(page.work.selected_values,1);assert!(page.work.page_bodies<=1);}
}

#[test]
fn winning_big_value_is_complete_but_refuses_too_small_budget(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());let value=json!("😁".repeat(180_000));runs.put("i|big",value.clone()).unwrap();flush(&mut db,&mut runs,1);let mut runs=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();
    let read=runs.get(&db,"i|big",ReadBudget::default()).unwrap();assert_eq!(read.result,Lookup::Value(value));assert!(read.work.rows_fetched>1);assert_eq!(read.work.page_bodies,0);
    let budget=ReadBudget{output_bytes:1024,..ReadBudget::default()};assert!(matches!(runs.get(&db,"i|big",budget),Err(Error::Bounds(_, _))));
}

#[test]
fn ranges_resume_forward_reverse_and_empty_tombstone_pages_make_progress(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());
    for n in 0..30{runs.put(&format!("i|{n:03}"),json!({"n":n})).unwrap();}flush(&mut db,&mut runs,1);
    for n in 0..12{runs.remove(&format!("i|{n:03}")).unwrap();}flush(&mut db,&mut runs,2);
    let partial=runs.range(&db,range("i|","j|",false,100),ReadBudget{entries:5,..ReadBudget::default()}).unwrap();assert!(!partial.complete);assert!(partial.entries.is_empty());assert_eq!(partial.next.as_deref(),Some("i|004"));
    for reverse in [false,true]{let mut after=None;let mut got=Vec::new();loop{let request=Range{after:after.as_deref(),..range("i|","j|",reverse,3)};let page=runs.range(&db,request,ReadBudget{entries:7,..ReadBudget::default()}).unwrap();got.extend(page.entries.into_iter().map(|(key,_)|key));if page.complete{break;}assert!(page.next.is_some());assert_ne!(page.next,after);after=page.next;}
        let mut expected=(12..30).map(|n|format!("i|{n:03}")).collect::<Vec<_>>();if reverse{expected.reverse();}assert_eq!(got,expected);
    }
}

#[test]
fn utf16_key_order_prefixes_escapes_and_utf16_value_lengths_are_preserved(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());
    for(key,value)in [("x|🎹a",json!("α🎹a")),("x|🎹b",json!("👩‍💻b")),("x|\u{e000}",json!("c")),("x|\0\u{1}\u{2}\u{3}\n",json!("escaped"))]{runs.put(key,value).unwrap();}flush(&mut db,&mut runs,1);let mut runs=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();
    let page=runs.range(&db,range("x|","y|",false,10),ReadBudget::default()).unwrap();assert_eq!(page.entries.iter().map(|(k,_)|k.as_str()).collect::<Vec<_>>(),vec!["x|\0\u{1}\u{2}\u{3}\n","x|🎹a","x|🎹b","x|\u{e000}"]);
    assert_eq!(page.entries[1].1,json!("α🎹a"));assert_eq!(page.entries[2].1,json!("👩‍💻b"));
}

#[test]
fn rollback_reload_drops_stale_mem_and_reused_run_page_ids(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());runs.put("i|x",json!("committed")).unwrap();flush(&mut db,&mut runs,1);
    runs.put("i|x",json!("rolled back")).unwrap();{let tx=db.transaction().unwrap();runs.flush(&tx,&json!(2)).unwrap();assert_eq!(runs.get(&tx,"i|x",ReadBudget::default()).unwrap().result,Lookup::Value(json!("rolled back")));tx.rollback().unwrap();}
    runs.reset_after_rollback(&db).unwrap();assert_eq!(runs.covered(&db).unwrap(),Some(json!(1)));assert_eq!(runs.get(&db,"i|x",ReadBudget::default()).unwrap().result,Lookup::Value(json!("committed")));
    runs.put("i|x",json!("new reuse")).unwrap();flush(&mut db,&mut runs,3);assert_eq!(runs.get(&db,"i|x",ReadBudget::default()).unwrap().result,Lookup::Value(json!("new reuse")));
}

#[test]
fn merge_is_bounded_resumable_and_preserves_newest_values_through_restart(){
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("merge.sqlite");let mut db=Connection::open(&path).unwrap();let settings=Settings{page_bytes:2048,max_key_bytes:512,..Settings::default()};let mut runs=create(&mut db,settings.clone());
    for version in 0..3{for n in 0..40{if version==2&&n<10{runs.remove(&format!("i|{n:03}")).unwrap();}else{runs.put(&format!("i|{n:03}"),json!({"version":version,"body":"x".repeat(100)})).unwrap();}}flush(&mut db,&mut runs,version);}
    let inputs=runs.run_numbers().collect::<Vec<_>>();{let tx=db.transaction().unwrap();runs.start_merge(&tx,&inputs).unwrap();tx.commit().unwrap();}
    let mut steps=0;loop{let tx=db.transaction().unwrap();let step=runs.merge_step(&tx,1,7,ReadBudget::default()).unwrap();assert!(step.pages<=1);assert!(step.entries<=7);tx.commit().unwrap();steps+=1;
        drop(runs);drop(db);db=Connection::open(&path).unwrap();runs=KeptRuns::open(&db,"record_keys",settings.clone()).unwrap();
        assert_eq!(runs.get(&db,"i|010",ReadBudget::default()).unwrap().result,Lookup::Value(json!({"version":2,"body":"x".repeat(100)})));
        if step.complete{break;}assert!(steps<30);
    }
    assert!(steps>1);assert_eq!(runs.run_numbers().count(),1);assert_eq!(runs.get(&db,"i|000",ReadBudget::default()).unwrap().result,Lookup::Absent);
    let page=runs.range(&db,range("i|","j|",false,100),ReadBudget::default()).unwrap();assert_eq!(page.entries.len(),30);
}

#[test]
fn byte_limits_bound_cache_memtable_output_and_read_work(){
    let mut db=Connection::open_in_memory().unwrap();let settings=Settings{page_bytes:2048,max_key_bytes:512,cache_bytes:4096,filter_bytes:0,memtable_bytes:4096,memtable_hold:2,..Settings::default()};let mut runs=create(&mut db,settings.clone());
    for n in 0..60{runs.put(&format!("i|{n:03}"),json!("x".repeat(300))).unwrap();if runs.full(){flush(&mut db,&mut runs,n);}}flush(&mut db,&mut runs,99);
    for n in 0..60{let _=runs.get(&db,&format!("i|{n:03}"),ReadBudget::default()).unwrap();assert!(runs.held().cache_bytes<=settings.cache_bytes);assert!(runs.held().memtable_bytes<=settings.memtable_bytes*settings.memtable_hold);}
    let page=runs.range(&db,range("i|","j|",false,100),ReadBudget{output_bytes:1024,..ReadBudget::default()}).unwrap();assert!(!page.complete);assert!(!page.entries.is_empty());assert!(page.serialized_bytes<=1024);assert_eq!(serde_json::to_vec(&page.entries).unwrap().len(),page.serialized_bytes);
    assert!(matches!(runs.get(&db,"i|030",ReadBudget{rows:0,..ReadBudget::default()}),Err(Error::Bounds(_, _))));
    assert!(matches!(runs.range(&db,range("i|","j|",false,100),ReadBudget{output_bytes:2,..ReadBudget::default()}),Err(Error::Bounds(_, _))));
}

#[test]
fn adjacent_merge_refuses_reordering_and_rollback_never_publishes_partial_output(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());for n in 0..3{runs.put("i|same",json!(n)).unwrap();flush(&mut db,&mut runs,n);}
    let numbers=runs.run_numbers().collect::<Vec<_>>();{let tx=db.transaction().unwrap();assert!(matches!(runs.start_merge(&tx,&[numbers[0],numbers[2]]),Err(Error::Corrupt(_, _))));tx.rollback().unwrap();}
    {let tx=db.transaction().unwrap();runs.start_merge(&tx,&numbers).unwrap();runs.merge_step(&tx,1,1,ReadBudget::default()).unwrap();tx.rollback().unwrap();}
    runs.reset_after_rollback(&db).unwrap();assert_eq!(runs.run_numbers().count(),3);assert_eq!(runs.get(&db,"i|same",ReadBudget::default()).unwrap().result,Lookup::Value(json!(2)));
}

fn legacy_run(db:&mut Connection,page:&str,last:&str){db.execute_batch("CREATE TABLE record_keys_run_1(page INTEGER PRIMARY KEY,first TEXT,body TEXT NOT NULL)").unwrap();db.execute("INSERT INTO record_keys_run_1 VALUES(0,?,?)",params![serde_json::to_string("a").unwrap(),page]).unwrap();db.execute("INSERT INTO record_keys_runs(run,age,pages,keys,bytes,last,filter_bits,page_layout) VALUES(1,1,1,2,?,?,0,NULL)",params![page.len()as i64,serde_json::to_string(last).unwrap()]).unwrap();}
#[test]
fn canonical_legacy_layout1_layout2_uniform_common_and_list_pages_read_without_translation(){
    let fixtures=[("[[\"a\",{\"v\":1}],[\"b\",null]]".to_string(),json!({"v":1}),Value::Null),
        ("{\"p\":[0,0],\"s\":[\"a\",\"b\"],\"d\":[7,4]}\n{\"v\":1}null".into(),json!({"v":1}),Value::Null),
        ("~{\"ps\":\"##\",\"v\":\"null\"}\u{2}a\u{3}b\n".into(),Value::Null,Value::Null),
        ("~{\"q\":[[0,2]],\"d\":[2,2],\"c\":\"{\\\"v\\\":\"}\u{2}a\u{3}b\n1}2}".into(),json!({"v":1}),json!({"v":2}))];
    for(page,a,b)in fixtures{let mut db=Connection::open_in_memory().unwrap();let _=create(&mut db,Settings::default());legacy_run(&mut db,&page,"b");let mut runs=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();assert_eq!(runs.get(&db,"a",ReadBudget::default()).unwrap().result,Lookup::Value(a));assert_eq!(runs.get(&db,"b",ReadBudget::default()).unwrap().result,Lookup::Value(b));}
}

#[test]
fn unsupported_sparse_format_and_catalogue_bounds_refuse_explicitly(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());runs.put("a",json!(1)).unwrap();flush(&mut db,&mut runs,1);
    db.execute_batch("ALTER TABLE record_keys_runs ADD COLUMN page_format INTEGER; UPDATE record_keys_runs SET page_format=1").unwrap();assert!(matches!(KeptRuns::open(&db,"record_keys",Settings::default()),Err(Error::Unsupported(_, _))));
    db.execute("UPDATE record_keys_runs SET page_format=0",[]).unwrap();assert!(matches!(KeptRuns::open(&db,"record_keys",Settings{catalog_bytes:1,..Settings::default()}),Err(Error::Bounds(_, _))));
    assert!(matches!(KeptRuns::open(&db,"bad;prefix",Settings::default()),Err(Error::Corrupt(_, _))));
}

#[test]
fn resident_block_filters_reject_cold_absent_keys_without_opening_run_pages(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());for n in 0..12{runs.put("a",json!(n)).unwrap();runs.put("z",json!(n)).unwrap();flush(&mut db,&mut runs,n);}
    let mut cold=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();assert!(cold.held().filter_bytes>0);
    let mut observed=false;for n in 0..100{let read=cold.get(&db,&format!("middle-{n}"),ReadBudget::default()).unwrap();assert_eq!(read.result,Lookup::Absent);if read.work.sql_statements==0{observed=true;break;}}
    assert!(observed,"at least one true miss must be rejected by resident exact membership alone");
}

#[test]
fn packed_range_heads_do_not_open_superseded_inline_value_tails(){
    let mut db=Connection::open_in_memory().unwrap();let mut runs=create(&mut db,Settings::default());runs.put("i|x",json!("old-inline")).unwrap();flush(&mut db,&mut runs,1);
    // Valid header, deliberately invalid JSON value tail. New winner must make
    // that tail irrelevant to the actual range consumer, including cold open.
    let old:i64=runs.run_numbers().next().unwrap();let table=format!("record_keys_run_{old}");
    db.execute(&format!("UPDATE {table} SET body='~{{\"p\":[0],\"d\":[12],\"b\":{{}}}}'||char(2)||'i|x'||char(10)||'not-json!!!!' WHERE page=0"),[]).unwrap();
    runs.put("i|x",json!("new")).unwrap();flush(&mut db,&mut runs,2);
    let mut cold=KeptRuns::open(&db,"record_keys",Settings::default()).unwrap();let page=cold.range(&db,range("i|","j|",false,1),ReadBudget::default()).unwrap();assert_eq!(page.entries,vec![("i|x".into(),json!("new"))]);assert_eq!(page.work.page_bodies,1);assert_eq!(page.work.selected_values,1);
}


#[test]
fn pure_original_page_heads_do_not_parse_unselected_values_or_open_big_parts() {
    use trillion_local::kept_runs::{packed_page_text,PackedText};
    let settings=Settings::default();
    let raw=format!("{}\nINVALID",serde_json::json!({"s":["a","b","c"],"p":[0,0,0],"d":[7,0,0],"b":{"1":["private-ref-sentinel",2]}}));
    let page=packed_page_text(&raw,&settings).unwrap();
    assert_eq!(page.len(),3);assert_eq!(page.key(0).unwrap(),"a");
    assert!(!page.is_tombstone(0).unwrap());assert!(!page.is_tombstone(1).unwrap());assert!(page.is_tombstone(2).unwrap());
    assert!(page.selected(0,&settings).is_err());
    assert!(matches!(page.selected(1,&settings).unwrap(),PackedText::Big{parts:2,..}));
    assert!(matches!(page.selected(2,&settings).unwrap(),PackedText::Tombstone));
    assert!(!format!("{page:?}").contains("private-ref-sentinel"));
    assert!(page.resident_bytes()>=raw.len());assert!(page.key(3).is_err());
}
#[test]
fn opaque_original_page_uses_same_exact_text_and_selected_value_bound_as_point() {
    use trillion_local::kept_runs::{packed_page_text,packed_point_text,PackedText};
    let settings=Settings::default();let raw=r#"[["a",{"z":1.00,"a":1e2}],["b"]]"#;
    let page=packed_page_text(raw,&settings).unwrap();
    assert_eq!(page.selected(0,&settings).unwrap(),packed_point_text(raw,"a",&settings).unwrap());
    assert_eq!(page.selected(0,&settings).unwrap(),PackedText::Json(r#"{"z":1.00,"a":1e2}"#.into()));
    let mut small=settings.clone();small.max_value_bytes=1;assert!(page.selected(0,&small).is_err());
    assert!(page.is_tombstone(1).unwrap());
}
#[test]
fn pure_packed_head_projection_keeps_heads_without_copying_omitted_value_tail() {
    use trillion_local::kept_runs::packed_page_text;
    let settings=Settings::default();
    let header=format!("{}\n",serde_json::json!({"s":["a","b"],"p":[0,0],"d":[200000,0]}));
    let page=packed_page_text(&header,&settings).unwrap();
    assert_eq!(page.key(0).unwrap(),"a");assert!(!page.is_tombstone(0).unwrap());assert!(page.is_tombstone(1).unwrap());
    assert!(page.resident_bytes()<4096);assert!(page.selected(0,&settings).is_err());
}

#[test]
fn opaque_page_held_bytes_include_uniform_and_multipart_reference_allocations() {
    use trillion_local::kept_runs::packed_page_text;
    let settings=Settings::default();
    let uniform=serde_json::to_string(&"u".repeat(4096)).unwrap();
    let raw=format!("{}\n",json!({"s":["a","b"],"p":[0,0],"v":uniform}));
    let page=packed_page_text(&raw,&settings).unwrap();
    assert!(page.resident_bytes()>=raw.len()+uniform.len());
    let reference="r".repeat(2048);
    let raw=format!("{}\n",json!({"s":["a"],"p":[0],"d":[0],"b":{"0":[reference,1]}}));
    let page=packed_page_text(&raw,&settings).unwrap();
    assert!(page.resident_bytes()>=raw.len()+reference.len());
}
