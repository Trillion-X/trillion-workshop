//! The current logical reader retains a redacted failure stage. Stored forms
//! and field keys both come from the account's own records (record store,
//! `own_records`), read inside the account's admitted snapshot witness. No
//! partial record, identifier, field value or key enters diagnostics.
use super::LocalAccount;
use crate::record_value::{self, Error, Limits, LogicalRecord};
use std::{
    fmt,
    sync::{atomic::AtomicBool, Arc},
};

pub struct LogicalReadFailure {
    pub cause: crate::refusal_cause::Cause,
    pub kind: Error,
    pub stage: &'static str,
    pub final_snapshot_refused: bool,
}
impl LogicalReadFailure {
    fn new(stage: &'static str, kind: Error) -> Self {
        Self {
            cause: kind.cause(),
            kind,
            stage,
            final_snapshot_refused: false,
        }
    }
}
impl LogicalReadFailure {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause { &self.cause }
}
crate::impl_caused!(LogicalReadFailure);
impl fmt::Display for LogicalReadFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} stage={} final_snapshot_refused={}",
            self.kind, self.stage, self.final_snapshot_refused
        )
    }
}
impl fmt::Debug for LogicalReadFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for LogicalReadFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}

impl LocalAccount {
    /// Resolve one record from the account's own records (the record store) with its field
    /// keys from the same store, inside one admitted snapshot: the browser
    /// admission is taken before the read and the snapshot witness is checked
    /// again after it, so a late revocation withholds the record. A refusal
    /// carries a fixed stage label only.
    pub fn current_logical_record(
        &mut self,
        session_id: &str,
        id: &str,
        limits: Limits,
        cancel: Arc<AtomicBool>,
    ) -> Result<Option<LogicalRecord>, LogicalReadFailure> {
        let policy = crate::record_model_policy::open_policy(self.state_root())
            .map_err(|error| LogicalReadFailure::new("model-policy", Error::Source(error.cause())))?;
        let mut stage = "current-source";
        let read = self.with_own_records(session_id, cancel, |records| {
            stage = "logical-value";
            Ok(record_value::read(id, records, &policy, limits))
        });
        let held = read.map_err(|error| {
            let mut failure = LogicalReadFailure::new(stage, Error::Source(error.cause()));
            failure.final_snapshot_refused = stage == "logical-value";
            failure
        })?;
        held.map_err(|kind| LogicalReadFailure::new(stage, kind))
    }
}
