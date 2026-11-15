//! Read the own-record authority header the account's record store holds
//! (`own_records::identity`). Connection labels and browser generations do not
//! define the incarnation of this original journal.
use super::*;
use crate::account::NativeAccountOwner;

use crate::{local_account::own_records,storage::sqlite::resource_identity};

pub(super) struct Guard {
    expected: i64,
    physical: resource_identity::WriteProof,
    /// The command committed: its answer's check reads the header on a read snapshot (`committed`).
    committed: std::cell::Cell<bool>,
}
impl Guard {
    pub(super) fn new(expected:i64)->Self { Self { expected, physical:resource_identity::WriteProof::new(), committed:std::cell::Cell::new(false) } }
    pub(super) fn reset_transaction(&self) { self.physical.reset_transaction(); }
    /// The command committed. From here the header is read on whatever snapshot the delivering read holds: a read
    /// needs no write reservation, so another writer of the file cannot make the answer fail.
    pub(super) fn committed(&self) { self.physical.reset_transaction(); self.committed.set(true); }
    pub(super) fn assert_current(&self,db:&Connection,binding:&CommandBinding)->Result<()> {
        // The selected command's semantic generation remains an account fact.
        if binding.generation.as_i64()!=Some(self.expected) { return Err(crate::cause!(Error::Refused)); }
        if self.committed.get() {
            if db.is_autocommit() { return Err(crate::cause!(Error::Source)); }
            let header=identity(db,&binding.owner).map_err(|error| crate::carry_cause!(Error::Source, error))?;
            return if decoded(header,&binding.owner,&binding.resource)? == self.expected { Ok(()) } else { Err(crate::cause!(Error::Refused)) };
        }
        self.physical.assert_current(db,|db| {
            let header=identity(db,&binding.owner)?;
            Ok(header.is_some_and(|header| decode(&binding.owner,&binding.resource,&header.owner,&header.resource,header.generation,header.ready)==Ok(self.expected)))
        }).map_err(|error|match error { crate::storage::Error::Unavailable(_)=>crate::carry_cause!(Error::Source, error), _=>crate::carry_cause!(Error::Refused, error) })
    }
    #[cfg(test)]
    pub(super) fn lookups(&self)->u64 { self.physical.lookups() }
}

/// Pure decoding shared by the writer and the current readonly source. This
/// proves header contents only; callers retain physical/source/rights custody.
pub(crate) fn decode(owner:&str,resource:&str,actual_owner:&str,actual_resource:&str,generation:i64,ready:i64)->Result<i64>{
    if actual_owner!=owner||actual_resource!=resource||ready!=1||!(1..=9_007_199_254_740_991).contains(&generation){return Err(crate::cause!(Error::Refused))}
    Ok(generation)
}
/// The header `own_records::identity` reads, as the storage boundary's error: a header that cannot be read is
/// Unavailable (a source error), never an absent one.
fn identity(db:&crate::storage::sqlite::Connection,owner:&str)->crate::storage::Result<Option<own_records::Identity>> {
    own_records::identity(db,owner).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))
}
fn decoded(header:Option<own_records::Identity>,owner:&str,resource:&str)->Result<i64> {
    let header=header.ok_or(crate::cause!(Error::Refused))?;
    decode(owner,resource,&header.owner,&header.resource,header.generation,header.ready)
}

impl LocalAccount {
    /// Initial source value only. The concrete writer independently rechecks
    /// it under its retained IMMEDIATE transaction before any effect/commit.
    pub(crate) fn original_workspace_generation(&mut self) -> Result<i64> {
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let path = self
            .source
            .record_book_path
            .clone()
            .ok_or(crate::cause!(Error::Source))?;
        let (_file, inode) = open_regular(&path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        check_sqlite_sidecars(&path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let owner=self.account().owner_id.clone();
        // Read on the record book handle the commands keep (`record_store_resources::Writer`), not a new one.
        let deadline=Instant::now()+crate::legacy_records::Bounds::default().elapsed;
        let writer=self.own_writer().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        if writer.path()!=path {return Err(crate::cause!(Error::Source))}
        let source=writer.lend(Arc::new(AtomicBool::new(false)),deadline).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        let header=identity(source.connection(),&owner).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        drop(source);
        // No header: the account's first start has not filled its own records yet. That is not a refusal of
        // the caller's rights; the command waits for the start, as the writer says (`NotMigrated`).
        let header=header.ok_or(crate::cause!(Error::NotMigrated))?;
        let generation=decoded(Some(header),&owner,"@own-records")?;
        inode.check(&path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        check_sqlite_sidecars(&path).map_err(|error| crate::carry_cause!(Error::Source, error))?;
        self.assert_owned().map_err(|error| crate::carry_cause!(Error::Source, error))?;
        Ok(generation)
    }
}
