// src/scan.rs
//
// Purpose: Measure actual SQLite work for one prepared scoped point read without issuing extra measurement queries.
//
// Non-Negotiable Invariants:
// - Report statement, scan-visit, VM and returned-row observations in their actual units.
// - Finalize the prepared statement while its borrowed SQLite connection remains valid.
//
// Key Concepts:
// - SQLite statement scan status, VM steps and full-scan counters.
// - Connection-bounded foreign-function statement lifetime.
//
// Security Considerations:
// - Bind scope and record values as query parameters.
// - These counters do not prove physical disk reads, provider billing or whole-workload cost.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! One prepared point query. Counts actual SQLite loop visits, not returned rows
//! relabelled as Cloudflare billing. No SQL is run to collect these counters.
use rusqlite::{ffi, Connection};
use serde::Serialize;
use std::{ffi::CString, marker::PhantomData, ptr};

#[derive(Debug, Default, Clone, Serialize)]
pub struct ReadWork {
    pub sql_statements: u64,
    pub sqlite_scan_visits: u64,
    pub fullscan_steps: u64,
    pub vm_steps: u64,
    pub rows_returned: u64,
    pub rows_written: u64,
}

struct Statement<'a> {
    raw: *mut ffi::sqlite3_stmt,
    _connection: PhantomData<&'a Connection>,
}
impl Drop for Statement<'_> {
    fn drop(&mut self) {
        // SAFETY: this owner finalizes its successfully prepared statement once.
        unsafe {
            ffi::sqlite3_finalize(self.raw);
        }
    }
}
fn sqlite_error(code: i32) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(code), None)
}

pub fn point_read(
    connection: &Connection,
    account: &str,
    resource: &str,
    id: &str,
) -> Result<(Option<(i64, Vec<u8>)>, ReadWork), rusqlite::Error> {
    let bindings: Vec<CString> = [account, resource, id]
        .iter()
        .map(|s| {
            CString::new(*s)
                .map_err(|_| rusqlite::Error::InvalidParameterName("NUL in record key".into()))
        })
        .collect::<Result<_, _>>()?;
    let query = c"SELECT version, body FROM records WHERE account=?1 AND resource=?2 AND id=?3 AND deleted=0";
    // SAFETY: Connection owns the database; Statement's lifetime cannot outlive it.
    // SQLite copies bound text (TRANSIENT); output bytes are copied before finalize.
    unsafe {
        if ffi::sqlite3_compileoption_used(c"ENABLE_STMT_SCANSTATUS".as_ptr()) != 1 {
            return Err(rusqlite::Error::InvalidParameterName(
                "SQLite scan-status support is required".into(),
            ));
        }
        let handle = connection.handle();
        let before = ffi::sqlite3_total_changes64(handle);
        let mut raw = ptr::null_mut();
        let code = ffi::sqlite3_prepare_v2(handle, query.as_ptr(), -1, &mut raw, ptr::null_mut());
        if code != ffi::SQLITE_OK {
            return Err(sqlite_error(code));
        }
        let statement = Statement {
            raw,
            _connection: PhantomData::<&Connection>,
        };
        for (index, value) in bindings.iter().enumerate() {
            let code = ffi::sqlite3_bind_text(
                statement.raw,
                (index + 1) as i32,
                value.as_ptr(),
                -1,
                ffi::SQLITE_TRANSIENT(),
            );
            if code != ffi::SQLITE_OK {
                return Err(sqlite_error(code));
            }
        }
        let mut result = None;
        let mut rows = 0;
        loop {
            match ffi::sqlite3_step(statement.raw) {
                ffi::SQLITE_ROW => {
                    rows += 1;
                    if rows > 1 {
                        return Err(rusqlite::Error::InvalidQuery);
                    }
                    let version = ffi::sqlite3_column_int64(statement.raw, 0);
                    let length = ffi::sqlite3_column_bytes(statement.raw, 1) as usize;
                    let body = ffi::sqlite3_column_blob(statement.raw, 1).cast::<u8>();
                    if body.is_null() || length == 0 {
                        return Err(rusqlite::Error::InvalidQuery);
                    }
                    result = Some((version, std::slice::from_raw_parts(body, length).to_vec()));
                }
                ffi::SQLITE_DONE => break,
                code => return Err(sqlite_error(code)),
            }
        }
        let mut visits = 0_u64;
        for index in 0.. {
            let mut count = 0_i64;
            if ffi::sqlite3_stmt_scanstatus(
                statement.raw,
                index,
                ffi::SQLITE_SCANSTAT_NVISIT,
                (&mut count as *mut i64).cast(),
            ) != 0
            {
                break;
            }
            visits += count.max(0) as u64;
        }
        Ok((
            result,
            ReadWork {
                sql_statements: 1,
                sqlite_scan_visits: visits,
                fullscan_steps: ffi::sqlite3_stmt_status(
                    statement.raw,
                    ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP,
                    0,
                )
                .max(0) as u64,
                vm_steps: ffi::sqlite3_stmt_status(statement.raw, ffi::SQLITE_STMTSTATUS_VM_STEP, 0)
                    .max(0) as u64,
                rows_returned: rows,
                rows_written: (ffi::sqlite3_total_changes64(handle) - before).max(0) as u64,
            },
        ))
    }
}

/// Borrowed values stay valid only until the next step on the measured query.
pub(crate) struct PageRow<'a> {
    raw: *mut ffi::sqlite3_stmt,
    _query: PhantomData<&'a ()>,
}
impl PageRow<'_> {
    pub(crate) fn integer(&self, column: i32) -> i64 {
        // SAFETY: the row borrow cannot outlive or advance its query.
        unsafe { ffi::sqlite3_column_int64(self.raw, column) }
    }
    pub(crate) fn bytes(&self, column: i32) -> Option<&[u8]> {
        // SAFETY: SQLite owns these bytes through this row's exclusive step window.
        unsafe {
            if ffi::sqlite3_column_type(self.raw, column) == ffi::SQLITE_NULL {
                return None;
            }
            let length = ffi::sqlite3_column_bytes(self.raw, column).max(0) as usize;
            if length == 0 {
                return Some(&[]);
            }
            let bytes = ffi::sqlite3_column_blob(self.raw, column).cast::<u8>();
            if bytes.is_null() {
                return None;
            }
            Some(std::slice::from_raw_parts(bytes, length))
        }
    }
}

/// The Store uses this cursor itself; measured tests do not execute copied SQL.
pub(crate) struct PageQuery<'a> {
    statement: Statement<'a>,
    connection: &'a Connection,
    before: i64,
    rows: u64,
}
impl<'a> PageQuery<'a> {
    pub(crate) fn new(
        connection: &'a Connection,
        query: &std::ffi::CStr,
        text: [&str; 3],
        limit: i64,
    ) -> Result<Self, rusqlite::Error> {
        // SAFETY: the statement retains the connection lifetime; SQLite copies text.
        unsafe {
            if ffi::sqlite3_compileoption_used(c"ENABLE_STMT_SCANSTATUS".as_ptr()) != 1 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            let mut raw = ptr::null_mut();
            let code = ffi::sqlite3_prepare_v2(
                connection.handle(),
                query.as_ptr(),
                -1,
                &mut raw,
                ptr::null_mut(),
            );
            if code != ffi::SQLITE_OK {
                return Err(sqlite_error(code));
            }
            let statement = Statement {
                raw,
                _connection: PhantomData,
            };
            for (index, value) in text.iter().enumerate() {
                let length =
                    i32::try_from(value.len()).map_err(|_| rusqlite::Error::InvalidQuery)?;
                let code = ffi::sqlite3_bind_text(
                    raw,
                    index as i32 + 1,
                    value.as_ptr().cast(),
                    length,
                    ffi::SQLITE_TRANSIENT(),
                );
                if code != ffi::SQLITE_OK {
                    return Err(sqlite_error(code));
                }
            }
            let code = ffi::sqlite3_bind_int64(raw, 4, limit);
            if code != ffi::SQLITE_OK {
                return Err(sqlite_error(code));
            }
            Ok(Self {
                statement,
                connection,
                before: ffi::sqlite3_total_changes64(connection.handle()),
                rows: 0,
            })
        }
    }
    pub(crate) fn next(&mut self) -> Result<Option<PageRow<'_>>, rusqlite::Error> {
        // SAFETY: only this cursor steps its owned statement.
        match unsafe { ffi::sqlite3_step(self.statement.raw) } {
            ffi::SQLITE_ROW => {
                self.rows += 1;
                Ok(Some(PageRow {
                    raw: self.statement.raw,
                    _query: PhantomData,
                }))
            }
            ffi::SQLITE_DONE => Ok(None),
            code => Err(sqlite_error(code)),
        }
    }
    pub(crate) fn work(&self) -> ReadWork {
        // SAFETY: counters refer to this live owned statement and its connection.
        unsafe {
            let mut visits = 0;
            for index in 0.. {
                let mut count = 0_i64;
                if ffi::sqlite3_stmt_scanstatus(
                    self.statement.raw,
                    index,
                    ffi::SQLITE_SCANSTAT_NVISIT,
                    (&mut count as *mut i64).cast(),
                ) != 0
                {
                    break;
                }
                visits += count.max(0) as u64;
            }
            ReadWork {
                sql_statements: 1,
                sqlite_scan_visits: visits,
                fullscan_steps: ffi::sqlite3_stmt_status(
                    self.statement.raw,
                    ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP,
                    0,
                )
                .max(0) as u64,
                vm_steps: ffi::sqlite3_stmt_status(
                    self.statement.raw,
                    ffi::SQLITE_STMTSTATUS_VM_STEP,
                    0,
                )
                .max(0) as u64,
                rows_returned: self.rows,
                rows_written: (ffi::sqlite3_total_changes64(self.connection.handle()) - self.before)
                    .max(0) as u64,
            }
        }
    }
}
