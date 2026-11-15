// Actual SQLite objects, using the existing physical Reader fixture. No mock
// module or new product rejection rule is introduced to justify a probe.
use super::*;

#[test]
fn missing_table_and_real_view_refuse_without_initializing_or_copying_values() {
    for schema in ["missing", "view"] {
        let f = Fixture::new(|db| {
            db.execute_batch("DROP TABLE workspace_records").unwrap();
            if schema == "view" {
                db.execute_batch("CREATE TABLE actual_source(label TEXT PRIMARY KEY,value TEXT NOT NULL,written_at TEXT NOT NULL);INSERT INTO actual_source VALUES('held','999','source');CREATE VIEW workspace_records AS SELECT label,value,written_at FROM actual_source").unwrap();
                let info: Vec<(String,i64)> = db.prepare("PRAGMA main.table_info(workspace_records)").unwrap()
                    .query_map([], |r| Ok((r.get(1)?,r.get(5)?))).unwrap().map(Result::unwrap).collect();
                assert_eq!(info[0], ("label".into(),0), "real view does not carry the source primary key");
            }
        });
        let before=fs::read(&f.path).unwrap();
        let error=Reader::new(f.connection(),Witness::new(),Limits::default()).unwrap_err();
        assert_eq!(error.kind,Kind::Schema,"{schema}");
        assert_eq!(error.work.rows_written,0);
        assert_eq!(before,fs::read(&f.path).unwrap());
    }
}

#[test]
fn actual_fts_virtual_projection_and_its_shadow_family_do_not_bypass_columns() {
    let f=Fixture::new(|db| {
        db.execute_batch("DROP TABLE workspace_records;CREATE VIRTUAL TABLE workspace_records USING fts5(label,value,written_at);INSERT INTO workspace_records VALUES('held','999','source')").unwrap();
        let objects: Vec<(String,String)> = db.prepare("PRAGMA main.table_list").unwrap()
            .query_map([], |r| Ok((r.get(1)?,r.get(2)?))).unwrap().map(Result::unwrap).collect();
        assert!(objects.iter().any(|(name,kind)| name=="workspace_records" && kind=="virtual"));
        assert!(objects.iter().any(|(name,kind)| name.starts_with("workspace_records_") && kind=="shadow"),"this is a real SQLite shadow family");
        let primary_key:i64=db.query_row("SELECT pk FROM pragma_table_info('workspace_records') WHERE name='label'",[],|r|r.get(0)).unwrap();
        assert_eq!(primary_key,0);
    });
    let before=fs::read(&f.path).unwrap();
    let error=Reader::new(f.connection(),Witness::new(),Limits::default()).unwrap_err();
    assert_eq!(error.kind,Kind::Schema);
    assert_eq!(error.work.rows_written,0);
    assert_eq!(before,fs::read(&f.path).unwrap());
}

#[test]
fn temp_view_and_attached_table_cannot_shadow_selected_main_rows() {
    for shadow in ["temporary-view","attached-table"] {
        let f=Fixture::new(|db|insert(db,"held","1"));
        let db=f.connection();
        if shadow=="temporary-view" {
            db.execute_batch("CREATE TEMP VIEW workspace_records AS SELECT 'held' AS label,'999' AS value,'unselected' AS written_at").unwrap();
        } else {
            let other_path=f._dir.path().join("other.sqlite");
            let other=Connection::open(&other_path).unwrap();
            other.execute_batch("CREATE TABLE workspace_records(label TEXT PRIMARY KEY,value TEXT NOT NULL,written_at TEXT NOT NULL);INSERT INTO workspace_records VALUES('held','999','unselected')").unwrap();
            drop(other);
            db.execute("ATTACH ? AS other",[other_path.to_str().unwrap()]).unwrap();
        }
        let mut reader=Reader::new(db,Witness::new(),Limits::default()).unwrap();
        let read=reader.read(Some(&labels(&["held"])),uncancelled()).unwrap();
        assert_eq!(read.records.len(),1,"{shadow}");
        assert_eq!(json(&read.records[0].1),"1","{shadow}");
        assert_eq!(read.work.rows_written,0);
    }
}
