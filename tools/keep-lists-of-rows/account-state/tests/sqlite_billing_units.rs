//! Calibrate the local write unit; this does not execute a provider workload.
use rusqlite::Connection;
use trillion_local::sqlite_work::{ObservedConnection, WorkMeter};

#[test]
fn changed_table_rows_do_not_measure_index_write_amplification() {
    for indexes in 0..=2 {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE item(id INTEGER PRIMARY KEY,value TEXT NOT NULL,payload TEXT NOT NULL)",
        )
        .unwrap();
        if indexes >= 1 {
            db.execute_batch("CREATE INDEX item_value ON item(value)")
                .unwrap();
        }
        if indexes >= 2 {
            db.execute_batch("CREATE INDEX item_payload ON item(payload)")
                .unwrap();
        }
        let meter = WorkMeter::new();
        // SAFETY: this fresh fixture has no trace callback or outstanding SQL.
        let db = unsafe { ObservedConnection::attach_untraced(db, meter.clone()) }.unwrap();
        for (operation, sql) in [
            ("insert", "INSERT INTO item VALUES(1,'before','before')"),
            (
                "update",
                "UPDATE item SET value='after',payload='after' WHERE id=1",
            ),
            ("delete", "DELETE FROM item WHERE id=1"),
        ] {
            let before = meter.snapshot().unwrap();
            assert_eq!(db.connection().execute(sql, []).unwrap(), 1);
            let after = meter.snapshot().unwrap();
            assert_eq!(after.active_statements, 0);
            let changed_rows = after.work.rows_written - before.work.rows_written;
            assert_eq!(changed_rows, 1, "{indexes} indexes; {operation}");
            // This counter is total_changes-based. Provider index writes must
            // be measured separately; no billable-row equivalence is asserted.
            println!(
                "WRITE_UNIT_CALIBRATION secondary_indexes={indexes} operation={operation} changed_table_rows={changed_rows} provider_index_writes=unmeasured"
            );
        }
    }
}
