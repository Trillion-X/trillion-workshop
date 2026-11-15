//! Native SQLite metadata probe for an ALREADY admitted retained read snapshot.
//! It opens no connection and grants no account authority. SQL scanstatus does
//! not observe SQLite's schema initialization/hash work: report the native work
//! separately and never turn this result into a Cloudflare cost equivalence.
use crate::{
    import::{ImportError, ImportResult, ReadLimits, SqlValue},
    record_source::QueryBudget,
};
use rusqlite::{ffi, Connection};
use std::{
    ffi::{CStr, CString},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Work {
    /// Exact same-snapshot metadata answers reused after fresh custody checks.
    /// These are not native API calls or SQL executions.
    pub reused_probes: u64,
    /// The fixed SQL pin is real observed SQL and is also included in the
    /// caller's SQL/source totals. It is not an extra price/row estimate.
    pub pin_sql_statements: u64,
    pub pin_rows_returned: u64,
    pub pin_source_bytes: u64,
    pub pin_progress_callbacks: u64,
    pub metadata_calls: u64,
    pub origin_prepares: u64,
    pub origin_name_calls: u64,
    pub elapsed_us: u64,
    /// Pin/native metadata/origin preparation may initialize schema or virtual
    /// module metadata. SQL scanstatus does not account for all of that work;
    /// even a warm hash hit is real CPU work, never a provider price proof.
    pub schema_initialization_work_unmeasured: bool,
}
impl Work {
    pub fn merge(&mut self, other: Self) -> ImportResult<()> {
        let add = |a: u64, b: u64| {
            a.checked_add(b)
                .ok_or(ImportError::Budget("native metadata counters overflowed", crate::cause!()))
        };
        self.pin_sql_statements = add(self.pin_sql_statements, other.pin_sql_statements)?;
        self.reused_probes = add(self.reused_probes, other.reused_probes)?;
        self.pin_rows_returned = add(self.pin_rows_returned, other.pin_rows_returned)?;
        self.pin_source_bytes = add(self.pin_source_bytes, other.pin_source_bytes)?;
        self.pin_progress_callbacks =
            add(self.pin_progress_callbacks, other.pin_progress_callbacks)?;
        self.metadata_calls = add(self.metadata_calls, other.metadata_calls)?;
        self.origin_prepares = add(self.origin_prepares, other.origin_prepares)?;
        self.origin_name_calls = add(self.origin_name_calls, other.origin_name_calls)?;
        self.elapsed_us = add(self.elapsed_us, other.elapsed_us)?;
        self.schema_initialization_work_unmeasured |= other.schema_initialization_work_unmeasured;
        Ok(())
    }
}
pub struct Probe {
    /// None means unsupported/ambiguous, NOT absent. Caller retains its old
    /// counted SQL behavior. In particular SQLITE_ERROR is never false here.
    pub exists: ImportResult<Option<bool>>,
    pub work: Work,
}
impl Probe {
    pub fn unsupported() -> Self {
        Self {
            exists: Ok(None),
            work: Work::default(),
        }
    }
    pub fn refused(error: ImportError) -> Self {
        Self {
            exists: Err(error),
            work: Work::default(),
        }
    }
}
struct Prepared(*mut ffi::sqlite3_stmt);
impl Drop for Prepared {
    fn drop(&mut self) {
        // SAFETY: private statement prepared below; never stepped or exposed.
        unsafe {
            ffi::sqlite3_finalize(self.0);
        }
    }
}
#[track_caller]
fn native_error(code: i32) -> ImportError {
    ImportError::Sqlite(rusqlite::Error::SqliteFailure(ffi::Error::new(code), None), crate::cause!(caller_site: ImportError::Sqlite))
}
fn budget(stop: &AtomicBool, cap: QueryBudget) -> ImportResult<()> {
    if stop.load(Ordering::Acquire) {
        return Err(ImportError::Refused("native metadata read cancelled", crate::cause!()));
    }
    if cap.rows == 0 || cap.source_bytes == 0 || Instant::now() >= cap.deadline {
        return Err(ImportError::Budget("native metadata read exceeds bound", crate::cause!()));
    }
    Ok(())
}

pub(crate) fn probe(
    db: &Connection,
    name: &str,
    limits: &ReadLimits,
    cap: QueryBudget,
    stop: &Arc<AtomicBool>,
) -> Probe {
    probe_mode(db, name, limits, cap, stop, false)
}
/// The same exact-main-table metadata owner on a caller-held IMMEDIATE write
/// snapshot. Canonical backfill reads have already pinned that snapshot; this
/// neither opens a source nor admits any untrusted query or account.
pub(crate) fn probe_in_write_transaction(
    db: &Connection,
    name: &str,
    limits: &ReadLimits,
    cap: QueryBudget,
    stop: &Arc<AtomicBool>,
) -> Probe {
    probe_mode(db, name, limits, cap, stop, true)
}
fn probe_mode(
    db: &Connection,
    name: &str,
    limits: &ReadLimits,
    cap: QueryBudget,
    stop: &Arc<AtomicBool>,
    write_transaction: bool,
) -> Probe {
    let started = Instant::now();
    let mut work = Work::default();
    let exists = (|| {
        limits.validate()?;
        budget(stop, cap)?;
        super::check_query_connection(db, write_transaction)?;
        if db.is_autocommit() {
            return Err(ImportError::Refused(
                "native metadata needs its retained snapshot",
             crate::cause!()));
        }
        // Only existing literal/validated physical owner names use this path.
        // Other SQL names retain the original bounded SQL implementation.
        if name.is_empty()
            || name.len() > 4096
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Ok(None);
        }
        // This package pins bundled SQLite with this option. A different native
        // supply must explicitly support it rather than inventing metadata.
        if unsafe { ffi::sqlite3_compileoption_used(c"ENABLE_COLUMN_METADATA".as_ptr()) } != 1 {
            return Ok(None);
        }
        // BEGIN DEFERRED alone has not pinned a main-database read snapshot.
        // The existing bounded SQL owner steps this fixed cookie read FIRST.
        // Otherwise metadata-only preparation could observe one schema and a
        // subsequent payload query another. This is measured source SQL, not a
        // fabricated zero-work metadata lookup or a separate snapshot/cache.
        work.schema_initialization_work_unmeasured = true;
        // Existing main READ state is sufficient; do not add another pin query
        // for each nested lookup in this SAME retained SQLite transaction.
        let state = unsafe { ffi::sqlite3_txn_state(db.handle(), c"main".as_ptr()) };
        if state == ffi::SQLITE_TXN_NONE {
            work.pin_sql_statements += 1;
            let pin = super::query_bounded_with_budget(
                db,
                limits,
                "PRAGMA main.schema_version",
                &[],
                Some(stop.clone()),
                cap,
            )?;
            work.pin_rows_returned = pin.rows.len() as u64;
            work.pin_source_bytes = (pin.columns.iter().map(String::len).sum::<usize>()
                + pin
                    .rows
                    .iter()
                    .flatten()
                    .map(|v| match v {
                        SqlValue::Text(b) | SqlValue::Blob(b) => b.len(),
                        _ => 8,
                    })
                    .sum::<usize>()) as u64;
            work.pin_progress_callbacks = pin.progress_callbacks;
            if pin.rows.len() != 1
                || pin.rows[0].len() != 1
                || !matches!(&pin.rows[0][0], SqlValue::Integer(_))
            {
                return Err(ImportError::Refused(
                    "native metadata schema pin unavailable",
                 crate::cause!()));
            }
        } else if state
            != if write_transaction {
                ffi::SQLITE_TXN_WRITE
            } else {
                ffi::SQLITE_TXN_READ
            }
        {
            return Err(ImportError::Refused(
                "native metadata read snapshot state refused",
             crate::cause!()));
        }
        let name_c =
            CString::new(name).map_err(|_| ImportError::Refused("native metadata name refused", crate::cause!()))?;
        work.metadata_calls += 1;
        // SAFETY: retained borrowed connection, main/name storage lives through
        // the call, NULL column asks only existence. NULL outputs are supported.
        let rc = unsafe {
            ffi::sqlite3_table_column_metadata(
                db.handle(),
                c"main".as_ptr(),
                name_c.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        budget(stop, cap)?;
        // Virtual-table metadata may require module preparation that this
        // readonly authorizer deliberately refuses. That makes this optional
        // probe unsupported, not an absent table or a new read permission.
        // Its caller must still execute the original authorized catalogue SQL.
        if matches!(rc, ffi::SQLITE_ERROR | ffi::SQLITE_AUTH) {
            return Ok(None);
        }
        if rc != ffi::SQLITE_OK {
            return Err(native_error(rc));
        }

        // The metadata API rejects views, but its name lookup is case-insensitive.
        // A prepared (NEVER stepped) origin supplies the actual canonical name.
        // The identifier above contains no quoting characters or SQL operators.
        let sql = CString::new(format!("SELECT * FROM main.\"{name}\" LIMIT 0")).unwrap();
        if sql.as_bytes().len() > limits.sql_bytes {
            return Ok(None);
        }
        let mut raw = ptr::null_mut();
        work.origin_prepares += 1;
        let rc = unsafe {
            ffi::sqlite3_prepare_v3(db.handle(), sql.as_ptr(), -1, 0, &mut raw, ptr::null_mut())
        };
        let statement = Prepared(raw);
        budget(stop, cap)?;
        if matches!(rc, ffi::SQLITE_ERROR | ffi::SQLITE_AUTH) {
            return Ok(None);
        }
        if rc != ffi::SQLITE_OK {
            return Err(native_error(rc));
        }
        if raw.is_null()
            || unsafe { ffi::sqlite3_stmt_readonly(raw) } != 1
            || unsafe { ffi::sqlite3_column_count(raw) } < 1
        {
            return Ok(None);
        }
        work.origin_name_calls += 2;
        let database = unsafe { ffi::sqlite3_column_database_name(statement.0, 0) };
        let actual = unsafe { ffi::sqlite3_column_table_name(statement.0, 0) };
        if database.is_null() || actual.is_null() {
            return Ok(None);
        }
        let database = unsafe { CStr::from_ptr(database) }.to_bytes();
        let actual = unsafe { CStr::from_ptr(actual) }.to_bytes();
        if database != b"main" {
            return Ok(None);
        }
        if actual == name.as_bytes() {
            return Ok(Some(true));
        }
        if actual.eq_ignore_ascii_case(name.as_bytes()) {
            return Ok(Some(false));
        }
        Ok(None)
    })();
    let exists = match budget(stop, cap)
        .and_then(|_| super::check_query_connection(db, write_transaction))
    {
        Ok(()) => exists,
        Err(error) => Err(error),
    };
    work.elapsed_us = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
    Probe { exists, work }
}

#[cfg(test)]
mod write_snapshot_controls {
    use super::*;
    fn cap() -> QueryBudget {
        QueryBudget {
            rows: 4,
            source_bytes: 4096,
            deadline: Instant::now() + std::time::Duration::from_secs(1),
        }
    }
    #[test]
    fn exact_main_metadata_can_reuse_the_already_pinned_write_snapshot() {
        let folder = tempfile::tempdir().unwrap();
        let db = Connection::open(folder.path().join("original.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE chosen(value TEXT); BEGIN IMMEDIATE")
            .unwrap();
        let result = probe_in_write_transaction(
            &db,
            "chosen",
            &ReadLimits::default(),
            cap(),
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(result.exists.unwrap(), Some(true));
        assert_eq!(result.work.pin_sql_statements, 0);
        assert_eq!(result.work.metadata_calls, 1);
        assert!(result.work.schema_initialization_work_unmeasured);
        assert!(!db.is_autocommit());
        assert_eq!(db.total_changes(), 0);
        db.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    fn write_metadata_refuses_a_connection_without_the_actual_write_transaction() {
        let folder = tempfile::tempdir().unwrap();
        let db = Connection::open(folder.path().join("original.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE chosen(value TEXT)").unwrap();
        assert!(probe_in_write_transaction(
            &db,
            "chosen",
            &ReadLimits::default(),
            cap(),
            &Arc::new(AtomicBool::new(false))
        )
        .exists
        .is_err());
        db.execute_batch("BEGIN DEFERRED; SELECT * FROM chosen")
            .unwrap();
        assert!(probe_in_write_transaction(
            &db,
            "chosen",
            &ReadLimits::default(),
            cap(),
            &Arc::new(AtomicBool::new(false))
        )
        .exists
        .is_err());
        db.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    fn cancelled_write_metadata_does_not_turn_unknown_into_absence() {
        let folder = tempfile::tempdir().unwrap();
        let db = Connection::open(folder.path().join("original.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE chosen(value TEXT); BEGIN IMMEDIATE")
            .unwrap();
        let result = probe_in_write_transaction(
            &db,
            "chosen",
            &ReadLimits::default(),
            cap(),
            &Arc::new(AtomicBool::new(true)),
        );
        assert!(result.exists.is_err());
        assert_eq!(result.work.metadata_calls, 0);
        db.execute_batch("ROLLBACK").unwrap();
    }
}
