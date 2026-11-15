//! Typed readonly storage over an existing bounded snapshot supplier. Statements
//! use the same DATA builders as the ordinary SQLite supply; execution stays in
//! the original supplier so shared work, snapshots and memo custody remain there.
use super::{get_statement, scan_statement, quoted, range_condition};
use crate::{
    import::{ImportError, SqlValue},
    record_source::{BoundedRecordSql, QueryBudget, ReadSourceState},
    storage::{Error, Intent, Range, Read, Result, Row, Schema, Storage, Value, When},
};
use rusqlite::types::Value as Parameter;
use std::{cell::RefCell, fmt::Write as _};

pub struct Supply<'a, S: BoundedRecordSql + ?Sized> {
    source: RefCell<&'a mut S>,
    schema: &'static Schema,
    budget: QueryBudget,
    initial: ReadSourceState,
}
fn failure(error: ImportError) -> Error {
    match error { ImportError::Budget(_, cause) => Error::Interrupted(cause), _ => Error::Unavailable(error.cause()) }
}
/// Borrow one already-held readonly snapshot; this opens no connection or scope.
/// Suppliers without an actual physical snapshot observation explicitly refuse.
pub fn lend<'a, S: BoundedRecordSql + ?Sized>(source: &'a mut S, schema: &str, budget: QueryBudget) -> Result<Supply<'a, S>> {
    lend_in_state(source, schema, budget, false)
}
/// Only the SQLite supply's provisional canonical read phase may lend a
/// checked typed view of its held write scope. This view remains read-only;
/// its physical state stays writing=true and each query rechecks the phase.
pub(super) fn lend_read_phase<'s, 'd, C, W>(
    source: &'s mut super::record_source::ReadPhase<'d, C, W>,
    schema: &str,
    budget: QueryBudget,
) -> Result<Supply<'s, super::record_source::ReadPhase<'d, C, W>>>
where C: std::borrow::Borrow<rusqlite::Connection>, W: crate::record_source::RecordSourceWitness {
    lend_in_state(source, schema, budget, true)
}
fn lend_in_state<'a, S: BoundedRecordSql + ?Sized>(source: &'a mut S, schema: &str, budget: QueryBudget, writing: bool) -> Result<Supply<'a, S>> {
    let schema = crate::storage::schema(schema)?;
    if budget.rows == 0 || budget.source_bytes == 0 || std::time::Instant::now() >= budget.deadline {
        return Err(crate::cause!(Error::Interrupted));
    }
    let initial = source.read_source_state().map_err(failure)?;
    if !initial.usable { return Err(crate::cause!(Error::Interrupted)); }
    if !initial.custody || !initial.scoped || initial.writing != writing { return Err(crate::cause!(Error::Moved)); }
    Ok(Supply { source: RefCell::new(source), schema, budget, initial })
}
fn value(cell: &SqlValue) -> Result<Value> {
    Ok(match cell {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(v) => Value::Integer(*v),
        SqlValue::RealBits(v) => Value::Real(f64::from_bits(*v)),
        SqlValue::Text(v) => Value::Text(String::from_utf8(v.clone()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?),
        SqlValue::Blob(v) => Value::Blob(v.clone()),
    })
}
impl<S: BoundedRecordSql + ?Sized> Supply<'_, S> {
    fn query(&self, sql: &str, params: &[Parameter]) -> Result<Vec<Vec<SqlValue>>> {
        self.source.try_borrow_mut().map_err(|error| crate::carry_cause!(Error::Busy, error))?
            .query_reusable_with_budget(sql, params, self.budget).map(|v| v.rows).map_err(failure)
    }
    fn rows(&self, sql: &str, params: &[Parameter], read: &[Read<'_>]) -> Result<Vec<Row>> {
        let rows = self.query(sql, params)?;
        rows.iter().map(|row| {
            let mut result = Vec::with_capacity(read.len());
            let mut at = 0;
            for one in read {
                let mut cell = value(row.get(at).ok_or(crate::cause!(Error::Unavailable))?)?;
                at += 1;
                if one.at_most.is_some() {
                    let size = row.get(at).ok_or(crate::cause!(Error::Unavailable))?;
                    if matches!(cell, Value::Null) {
                        if let SqlValue::Integer(bytes) = size { cell = Value::Oversized((*bytes).max(0) as u64); }
                    }
                    at += 1;
                }
                result.push(cell);
            }
            if at != row.len() { return Err(crate::cause!(Error::Unavailable)); }
            Ok(Row(result))
        }).collect()
    }
    fn integer(&self, sql: &str) -> Result<i64> {
        let rows = self.query(sql, &[])?;
        match rows.as_slice() { [row] => match row.as_slice() { [SqlValue::Integer(v)] => Ok(*v), _ => Err(crate::cause!(Error::Unavailable)) }, _ => Err(crate::cause!(Error::Unavailable)) }
    }
}
impl<S: BoundedRecordSql + ?Sized> Storage for Supply<'_, S> {
    fn schema(&self) -> &'static Schema { self.schema }
    fn get(&self, family: &str, key: &[Value], read: &[Read<'_>]) -> Result<Option<Row>> {
        let (sql, params) = get_statement(self.schema.family(family)?, key, read)?;
        Ok(self.rows(&sql, &params, read)?.pop())
    }
    fn scan(&self, family: &str, range: &Range<'_>, read: &[Read<'_>]) -> Result<Vec<Row>> {
        let (sql, params) = scan_statement(self.schema.family(family)?, range, read)?;
        self.rows(&sql, &params, read)
    }
    fn count(&self, family: &str, range: &Range<'_>) -> Result<u64> {
        let family = self.schema.family(family)?;
        let mut params = Vec::new();
        let (condition, _) = range_condition(family, range, &mut params)?;
        let mut source = format!("SELECT 1 FROM {}{condition}", quoted(&family.family));
        if let Some(limit) = range.limit {
            params.push(Parameter::Integer(i64::try_from(limit).map_err(|error| crate::carry_cause!(Error::Invalid, error))?));
            let _ = write!(source, " LIMIT ?{}", params.len());
        }
        let rows = self.query(&format!("SELECT count(*) FROM ({source})"), &params)?;
        match rows.as_slice() { [row] => match row.as_slice() { [SqlValue::Integer(n)] => u64::try_from(*n).map_err(|error| crate::carry_cause!(Error::Unavailable, error)), _ => Err(crate::cause!(Error::Unavailable)) }, _ => Err(crate::cause!(Error::Unavailable)) }
    }
    fn present(&self, family: &str) -> Result<bool> {
        let family = self.schema.family(family)?;
        let rows = self.query("SELECT type FROM pragma_table_list(?1) WHERE schema='main'", &[Parameter::Text(family.family.clone())])?;
        match rows.as_slice() {
            [] => Ok(false),
            [row] => match row.as_slice() {
                [SqlValue::Text(v)] if matches!(v.as_slice(),b"table"|b"virtual"|b"shadow") => Ok(true),
                _ => Err(crate::cause!(Error::Unavailable)),
            },
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }
    fn put(&self, _: &str, _: &[(&str, Value)], _: When<'_>) -> Result<u64> { Err(crate::cause!(Error::ReadOnly)) }
    fn erase(&self, _: &str, _: &Range<'_>) -> Result<u64> { Err(crate::cause!(Error::ReadOnly)) }
    fn custody(&self) -> Result<()> {
        let current = self.source.try_borrow_mut().map_err(|error| crate::carry_cause!(Error::Busy, error))?.read_source_state().map_err(failure)?;
        if !current.usable { return Err(crate::cause!(Error::Interrupted)); }
        if !current.custody || !current.scoped || current.writing != self.initial.writing || current.location != self.initial.location || current.changes != self.initial.changes { return Err(crate::cause!(Error::Moved)); }
        Ok(())
    }
    fn location(&self) -> Option<&str> { self.initial.location.as_deref() }
    // The constructor requires a held snapshot; this exclusive read-only view
    // cannot close it, and its original owner controls retirement.
    fn scoped(&self) -> bool { self.source.try_borrow_mut().ok().and_then(|mut source| source.read_source_state().ok()).is_some_and(|state| state.scoped) }
    fn writing(&self) -> Result<bool> { self.custody()?; Ok(self.initial.writing) }
    fn changes(&self) -> u64 { self.initial.changes }
    fn mark(&self) -> Result<i64> { self.integer("PRAGMA main.data_version") }
    fn schema_mark(&self) -> Result<i64> { self.integer("PRAGMA main.schema_version") }
    fn allocated_bytes(&self) -> Result<u64> {
        u64::try_from(self.integer("PRAGMA main.page_count")?).ok()
            .zip(u64::try_from(self.integer("PRAGMA main.page_size")?).ok())
            .and_then(|(pages,size)| pages.checked_mul(size)).ok_or(crate::cause!(Error::Unavailable))
    }
    // A borrowed source's snapshot belongs to its original owner. A scope cannot
    // be opened/closed through this facade behind the owner's meter and memo.
    fn reclaim(&self) -> Result<()> { if self.scoped() { Err(crate::cause!(Error::Invalid)) } else { Err(crate::cause!(Error::ReadOnly)) } }
    fn open_scope(&self, _: Intent) -> Result<()> { Err(crate::cause!(Error::Invalid)) }
    fn close_scope(&self, _: bool) -> Result<()> { Err(crate::cause!(Error::Invalid)) }
}


#[cfg(test)]
mod controls {
    use super::*;
    use crate::{current_record_keys::SharedRecordSql, import::{ImportResult, QueryRows, ReadLimits}, record_source::SnapshotRecordSql, sqlite_work::{ObservedConnection, WorkMeter}};
    use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
    use rusqlite::{Connection, OpenFlags};
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap(); let path=dir.path().join("source.sqlite");
        let db=Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE record_keys_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO record_keys_meta VALUES('marker','value');").unwrap();
        (dir,path)
    }
    fn budget(bytes:usize) -> QueryBudget { QueryBudget { rows:1, source_bytes:bytes, deadline:Instant::now()+Duration::from_secs(5) } }
    #[test]
    fn present_distinguishes_table_missing_family_and_view() {
        let (_dir,path)=fixture();
        let db=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
        assert_eq!(store.present("record_keys_meta"),Ok(true));
        assert_eq!(store.present("record_log"),Ok(false));
        drop(store);
        drop(shared);

        Connection::open(&path).unwrap().execute_batch("CREATE VIEW record_log AS SELECT key AS id FROM record_keys_meta").unwrap();
        let db=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
        assert_eq!(store.present("record_log"),Err(crate::cause!(Error::Unavailable)));
    }
    #[test]
    fn typed_get_keeps_one_physical_row_and_shared_memo_accounting() {
        let (_dir,path)=fixture(); let meter=WorkMeter::new();
        let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let db=unsafe { ObservedConnection::attach_untraced(db,meter.clone()) }.unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let before=meter.snapshot().unwrap().work;
        let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
        let wanted=Some(Row(vec![Value::Text("value".into())]));
        assert_eq!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).unwrap(),wanted);
        assert_eq!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).unwrap(),wanted);
        let after=meter.snapshot().unwrap().work;
        crate::quiet_eprintln!("bounded-typed-get before={before:?} after={after:?}");
        assert_eq!(after.sqlite_scan_visits-before.sqlite_scan_visits,1);
        assert_eq!(after.sql_statements-before.sql_statements,1);
    }
    #[test]
    fn typed_get_preserves_shared_byte_bound() {
        let (_dir,path)=fixture();
        let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let store=lend(&mut shared,"record_log",budget(1)).unwrap();
        assert!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).is_err());
    }
    #[test]
    fn cancellation_retires_memo_and_custody_still_refuses() {
        let (_dir,path)=fixture(); let cancel=Arc::new(AtomicBool::new(false));
        let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),cancel.clone()).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
        assert!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).unwrap().is_some());
        cancel.store(true,Ordering::Release);
        assert_eq!(store.custody(),Err(crate::cause!(Error::Interrupted)));
        // Cancellation removes eligibility, not the physical transaction. The
        // actual query then retires that transaction and returns no memo value.
        assert!(store.scoped());
        assert!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).is_err());
        assert!(store.custody().is_err()); assert!(!store.scoped());
    }
    #[test]
    fn scope_and_write_requests_cannot_change_the_source_owners_snapshot() {
        let (_dir,path)=fixture();
        let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
        assert_eq!(store.put("record_keys_meta",&[("key","marker".into()),("value","other".into())],When::Always),Err(crate::cause!(Error::ReadOnly)));
        assert_eq!(store.erase("record_keys_meta",&Range::all()),Err(crate::cause!(Error::ReadOnly)));
        assert_eq!(store.open_scope(Intent::Read),Err(crate::cause!(Error::Invalid)));
        assert_eq!(store.close_scope(false),Err(crate::cause!(Error::Invalid)));
        assert_eq!(store.reclaim(),Err(crate::cause!(Error::Invalid)));
        assert!(store.scoped()); assert_eq!(store.changes(),0);
        assert_eq!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).unwrap(),Some(Row(vec!["value".into()])));
    }
    #[test]
    fn current_source_withdrawal_still_withholds_an_already_memoized_value() {
        let (_dir,path)=fixture(); let allowed=Arc::new(AtomicBool::new(true)); let observed=allowed.clone();
        let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source=SnapshotRecordSql::begin(db,ReadLimits::default(),move || {
            if observed.load(Ordering::Acquire) { Ok(()) } else { Err(ImportError::Refused("fixture source withdrawn", crate::cause!())) }
        },Arc::new(AtomicBool::new(false))).unwrap();
        let mut shared=SharedRecordSql::new_reusing_snapshot(source,Default::default()).unwrap();
        let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
        assert!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).unwrap().is_some());
        allowed.store(false,Ordering::Release);
        assert!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).is_err());
    }
    #[test]
    fn each_typed_get_still_spends_the_same_shared_aggregate_allowance() {
        for bytes in [false,true] {
            let (_dir,path)=fixture();
            let writer=Connection::open(&path).unwrap();
            writer.execute("INSERT INTO record_keys_meta VALUES('other','value')",[]).unwrap();
            drop(writer);
            let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let source=SnapshotRecordSql::begin(db,ReadLimits::default(),||Ok(()),Arc::new(AtomicBool::new(false))).unwrap();
            let mut limits=crate::current_record_keys::SharedLimits::default();
            // Existing supplier charges the five-byte column name plus five-byte value.
            if bytes { limits.source_bytes=10; } else { limits.rows=1; }
            let mut shared=SharedRecordSql::new_reusing_snapshot(source,limits).unwrap();
            let store=lend(&mut shared,"record_log",budget(8192)).unwrap();
            assert!(store.get("record_keys_meta",&["marker".into()],&[Read::whole("value")]).unwrap().is_some());
            assert!(store.get("record_keys_meta",&["other".into()],&[Read::whole("value")]).is_err());
        }
    }
    #[test]
    fn unsupported_source_cannot_invent_a_snapshot() {
        struct Unknown;
        impl BoundedRecordSql for Unknown { fn query(&mut self,_:&str,_:&[Parameter])->ImportResult<QueryRows> { panic!("must not execute") } }
        assert!(lend(&mut Unknown,"record_log",budget(8192)).is_err());
    }
}
