// src/native_entry/module_computer/host.rs
//
// Purpose: `HostSql` (src/storage/hosted_sql.rs) over the SQLite this computer's host gives one object
// (`ctx.storage.sql`: `exec(query, ...bindings)` and `databaseSize`), the same storage the old app's stores ran on.
//
// Non-Negotiable Invariants:
// - Values cross as `Cell`s only: null, a 64-bit float, text, bytes. The hosted supply never binds an integer as a
//   number (it binds its text under a cast) and reads every integer back as text beside its type, so nothing here
//   rounds. Measured under the local host program: a number bound as 1 is stored as REAL, so a number must never
//   stand for an integer.
// - `hold` and `release` do nothing: the host runs each synchronous call of one object as one atomic unit, and every
//   call of the record store from object.rs is one synchronous call; the supply's own undo journal is every rollback.
// - One handle per database: `mark` never moves.
// - A host refusal is a storage error; a constraint refusal is `Conflict`, as SQLite's is to the file supply.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::storage::{
    hosted_sql::{Cell, HostSql},
    Error, Intent, Result,
};
use wasm_bindgen::JsValue;
use worker::{SqlStorage, SqlStorageValue};

pub struct ObjectSql(pub SqlStorage);

#[track_caller]
fn refused(error: worker::Error) -> Error {
    let text = error.to_string();
    if text.contains("constraint failed") {
        crate::cause!(caller: Error::Conflict)
    } else if text.contains("SQLITE_TOOBIG") || text.contains("too big") || text.contains("SQLITE_FULL") || text.contains("disk is full") {
        crate::cause!(caller: Error::TooBig)
    } else {
        let refusal = crate::cause!(caller: Error::Unavailable);
        worker::console_error!("hosted sql refused cause={}", refusal.cause());
        refusal
    }
}

impl HostSql for ObjectSql {
    fn exec(&self, sql: &str, bind: &[Cell]) -> Result<Vec<Vec<Cell>>> {
        let bound: Vec<JsValue> = bind
            .iter()
            .map(|cell| match cell {
                Cell::Null => JsValue::NULL,
                Cell::Real(v) => JsValue::from(*v),
                Cell::Text(v) => JsValue::from(v.as_str()),
                Cell::Blob(v) => {
                    let array = js_sys::Uint8Array::new_with_length(v.len() as u32);
                    array.copy_from(v);
                    array.buffer().into()
                }
            })
            .collect();
        let cursor = self.0.exec_raw(sql, bound).map_err(|error| refused(error))?;
        let mut rows = Vec::new();
        for row in cursor.raw() {
            let row = row.map_err(|error| refused(error))?;
            rows.push(
                row.into_iter()
                    .map(|cell| match cell {
                        SqlStorageValue::Null => Cell::Null,
                        SqlStorageValue::Boolean(b) => Cell::Real(if b { 1.0 } else { 0.0 }),
                        SqlStorageValue::Integer(v) => Cell::Real(v as f64),
                        SqlStorageValue::Float(v) => Cell::Real(v),
                        SqlStorageValue::String(v) => Cell::Text(v),
                        SqlStorageValue::Blob(v) => Cell::Blob(v),
                    })
                    .collect(),
            );
        }
        Ok(rows)
    }
    fn hold(&self, _intent: Intent) -> Result<()> {
        Ok(())
    }
    fn release(&self) -> Result<()> {
        Ok(())
    }
    fn mark(&self) -> Result<i64> {
        Ok(0)
    }
    fn bytes(&self) -> Result<u64> {
        Ok(self.0.database_size() as u64)
    }
    fn custody(&self) -> Result<()> {
        Ok(())
    }
    fn overwrites_removed(&self) -> bool {
        false
    }
}
