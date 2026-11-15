//! The measured-attempt shell every SQLite candidate shares: arm the
//! interruption fault, run the candidate's work inside spans, charge every
//! row written, rewrite the file after an owner erasure, and turn the result
//! into an [`Outcome`]. A candidate supplies only its work and its reopen.

use std::path::Path;
use workload_simulation::{
    Capability, Intent, Interrupt, Meters, Operation, Outcome, Reply, StoreError,
};

use crate::meter::{rewrite_erased, MeteredDb, Spans};

/// What one attempt's work returns.
pub struct Done {
    pub reply: Reply,
    /// A retry answered from the original receipt.
    pub duplicate: bool,
    /// Meters the work measured outside SQLite (archive PUTs/GETs, bytes).
    pub extra: Meters,
}

pub fn crashed() -> StoreError {
    StoreError("store is crashed".into())
}

/// A candidate's work: one attempt inside spans, and the reopen of its file
/// after the erasure rewrite.
pub trait Work {
    fn path(&self) -> &Path;
    fn run(
        &mut self,
        db: &mut MeteredDb,
        op: &Operation,
        spans: &mut Spans,
    ) -> Result<Done, StoreError>;
    fn reopen(&mut self) -> Result<(MeteredDb, Meters), StoreError>;
}

/// One measured attempt of `op` against the open connection in `slot`.
pub fn apply(
    slot: &mut Option<MeteredDb>,
    work: &mut impl Work,
    op: &Operation,
    fault: Option<Interrupt>,
) -> Outcome {
    let failed = |error: String| Outcome::Failed {
        error,
        meters: Meters::new(),
    };
    let Some(db) = slot.as_mut() else {
        return failed(crashed().0);
    };
    let mut spans = match db.spans() {
        Ok(s) => s,
        Err(e) => return failed(e.0),
    };
    db.arm(fault);
    let result = work.run(db, op, &mut spans);
    let interrupted = db.disarm();
    let mut meters = match db.finish(spans) {
        Ok(m) => m,
        Err(e) => return failed(e.0),
    };
    match result {
        Ok(done) => {
            meters.merge(&done.extra);
            if matches!(op.intent, Intent::EraseOwner { .. }) {
                if let Some(db) = slot.take() {
                    db.release_hooks();
                }
                let rewritten = rewrite_erased(work.path()).and_then(|mut m| {
                    let (db, opened) = work.reopen()?;
                    *slot = Some(db);
                    m.merge(&opened);
                    Ok(m)
                });
                match rewritten {
                    Ok(m) => meters.merge(&m),
                    Err(e) => return Outcome::Failed { error: e.0, meters },
                }
            }
            Outcome::Acked {
                reply: done.reply,
                duplicate: done.duplicate,
                meters,
            }
        }
        Err(e) => Outcome::Failed {
            error: if interrupted {
                "interrupted mid-statement".into()
            } else {
                e.0
            },
            meters,
        },
    }
}

/// Drop the connection as a process death would.
pub fn crash(slot: &mut Option<MeteredDb>) {
    if let Some(db) = slot.take() {
        db.release_hooks();
    }
}

pub fn capability(name: &str, supported: bool, note: &str) -> Capability {
    Capability {
        name: name.into(),
        supported,
        note: note.into(),
    }
}

/// Whether the operation changes stored state (retries look for a receipt).
pub fn mutating(intent: &Intent) -> bool {
    !matches!(
        intent,
        Intent::Read { .. } | Intent::List { .. } | Intent::Search { .. }
    )
}
