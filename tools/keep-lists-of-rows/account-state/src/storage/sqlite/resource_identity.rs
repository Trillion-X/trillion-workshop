//! Physical custody for reading the account's resource-identity header, which
//! the record store holds (`own_records::identity`; copied from the old engine's
//! table at start). The header's decode, account ownership, resource meaning
//! and generation eligibility stay with the caller. The write proof belongs to
//! one retained handle and its actual mutation count; opening another source
//! or changing transactions cannot inherit that proof.
use crate::storage::{Error, Result};
use rusqlite::Connection;
use std::cell::Cell;

pub(crate) struct WriteProof {
    handle: Cell<Option<usize>>,
    proof: Cell<Option<(usize,u64)>>,
    lookups: Cell<u64>,
}
impl WriteProof {
    pub(crate) fn new() -> Self {
        Self { handle:Cell::new(None), proof:Cell::new(None), lookups:Cell::new(0) }
    }
    pub(crate) fn reset_transaction(&self) { self.proof.set(None); }
    /// `valid` reads and validates the header on `db`. Reuse lasts only within
    /// its actual retained write transaction; any mutation requires another
    /// header read.
    pub(crate) fn assert_current(&self, db:&Connection, valid:impl FnOnce(&Connection)->Result<bool>) -> Result<()> {
        let handle=unsafe { db.handle() } as usize;
        let state=unsafe { rusqlite::ffi::sqlite3_txn_state(db.handle(),c"main".as_ptr()) };
        if db.is_autocommit() || state!=rusqlite::ffi::SQLITE_TXN_WRITE
            || self.handle.get().is_some_and(|original|original!=handle) { return Err(crate::cause!(Error::Moved)); }
        let proof=(handle,db.total_changes());
        if self.proof.get()==Some(proof) { return Ok(()); }
        self.lookups.set(self.lookups.get().saturating_add(1));
        if !valid(db)? { return Err(crate::cause!(Error::Conflict)); }
        self.proof.set(Some(proof));self.handle.set(Some(handle));Ok(())
    }
    #[cfg(test)]
    pub(crate) fn lookups(&self)->u64 { self.lookups.get() }
}
