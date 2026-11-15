//! The native write error every write path reports, and the selected native
//! command state (state lock, physical resource, admission) that native_command_context
//! witnesses at the boundaries of its one transaction.
//!
//! A command is one IMMEDIATE transaction: nothing it does is durable or shown
//! until COMMIT. So the full witness (state lock, record book inode and sidecars,
//! the admitter's current rights, the selection) runs at the boundaries only:
//! right after the transaction begins, right before COMMIT, and in the
//! delivery read after it. Each step between (a journal step, every record an
//! record store write applies) repeats only the free checks: cancellation, deadline and
//! the same held handle. A change a step check could see is still seen before
//! COMMIT, and the whole command rolls back.
use super::command_journal::{
    self as journal, Capture, CommandBinding, CommandJournal, CurrentCommand, Load,
};
use super::{check_sqlite_sidecars, open_regular, Inode, LocalAccount};
use crate::storage::sqlite::{Connection, TransactionBehavior};
use crate::{
    account::{self, BrowserAdmission},
    ecma_json::{JsString, Value},
    record_log::{self, Admission, Context, LogIds, Projected, RecordInput, Request, Scope},
    workspace::WorkspaceSession,
};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fmt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid(crate::refusal_cause::Cause),
    Bounds(crate::refusal_cause::Cause),
    Source(crate::refusal_cause::Cause),
    /// The account's own records are not migrated to record store yet (a clone or a start that did not finish its carry).
    NotMigrated(crate::refusal_cause::Cause),
    /// A value written to a field that declares choices is outside them (`Outside` names it).
    OutsideChoices(crate::refusal_cause::Cause),
    /// A value written to a field that declares moves changes it by a move they do not list (`Outside` names it, with
    /// the value it changes from; `record_write_model::Moves`).
    MoveNotDeclared(crate::refusal_cause::Cause),
    /// The write sets a value its field's declaring record marks as needing the person present, or removes such a
    /// mark, and the request carried no fresh confirmation of it (`NeedsPersonPresent` names it;
    /// `account::person_present`).
    NeedsPersonPresent(crate::refusal_cause::Cause),
    Refused(crate::refusal_cause::Cause),
    Conflict(crate::refusal_cause::Cause),
    OutcomeUnknown(crate::refusal_cause::Cause),
    ProtectedResultUnavailable(crate::refusal_cause::Cause),
    /// The command committed, but the check before its answer leaves refused (its rights or source changed after
    /// the commit): the outcome is known and a retry with the same request key answers the saved receipt.
    CommittedAnswerWithheld(crate::refusal_cause::Cause),
}
impl Error {
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause,
            Self::Bounds(cause) => cause,
            Self::Source(cause) => cause,
            Self::NotMigrated(cause) => cause,
            Self::OutsideChoices(cause) => cause,
            Self::MoveNotDeclared(cause) => cause,
            Self::NeedsPersonPresent(cause) => cause,
            Self::Refused(cause) => cause,
            Self::Conflict(cause) => cause,
            Self::OutcomeUnknown(cause) => cause,
            Self::ProtectedResultUnavailable(cause) => cause,
            Self::CommittedAnswerWithheld(cause) => cause,
        }
    }
}
crate::impl_caused!(Error);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid(_) => "current setting input refused",
            Self::Bounds(_) => "current setting exceeds bounds",
            Self::Source(_) => "current setting source unavailable",
            Self::NotMigrated(_) => "the account's own records are not migrated yet",
            Self::OutsideChoices(_) => "a value is outside the choices its field declares",
            Self::MoveNotDeclared(_) => "a value changes by a move its field does not declare",
            Self::NeedsPersonPresent(_) => {
                "the write needs a fresh confirmation by the person present"
            }
            Self::Refused(_) => "current setting is not admitted",
            Self::Conflict(_) => "current setting changed or command names different input",
            Self::ProtectedResultUnavailable(_) => {
                "original command is terminal; protected result unavailable"
            }
            Self::OutcomeUnknown(_) => {
                "current setting outcome unknown; retain original command identity"
            }
            Self::CommittedAnswerWithheld(_) => "the command committed; its answer is withheld",
        })
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
/// What a record write refused with `OutsideChoices` or `MoveNotDeclared` names to its caller: the record's kind, the
/// field and the value outside its choices or moves, and for a move the value it changes from. They are the person's
/// own words, answered to the person's own caller and never logged.
#[derive(Clone, PartialEq, Eq)]
pub struct Outside {
    pub kind: String,
    pub field: String,
    pub value: String,
    /// The value a refused move changes from (`record_write_model::START_OF_MOVES` for a field that held none).
    pub from: Option<String>,
}
impl Outside {
    /// The refusal's `detail` as every door answers it: kind, field and value, and `from` for a refused move.
    pub fn detail(&self) -> serde_json::Value {
        let mut detail =
            serde_json::json!({"kind": self.kind, "field": self.field, "value": self.value});
        if let Some(from) = &self.from {
            detail["from"] = serde_json::json!(from);
        }
        detail
    }
}
impl fmt::Debug for Outside {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Outside([redacted])")
    }
}
/// What a record write refused with `NeedsPersonPresent` names to its caller: the record, the field and the value a
/// confirmation must bind (`account::person_present::Requirement`), and how many such confirmations the write needs
/// (one write is confirmed by one; a caller splits a write that needs more). The person's own words, never logged.
#[derive(Clone, PartialEq, Eq)]
pub struct NeedsPersonPresent {
    pub requirement: crate::account::person_present::Requirement,
    pub marked_changes: usize,
}
impl fmt::Debug for NeedsPersonPresent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NeedsPersonPresent([redacted])")
    }
}
/// What the last refused record write named to its caller.
#[derive(Clone, PartialEq, Eq)]
pub enum Named {
    Outside(Outside),
    NeedsPersonPresent(NeedsPersonPresent),
}
impl fmt::Debug for Named {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WriteRefusal([redacted])")
    }
}
pub type Result<T> = std::result::Result<T, Error>;
fn record_error(error: record_log::Error) -> Error {
    let cause = error.cause();
    match error {
        record_log::Error::Invalid(_, _) => Error::Invalid(cause),
        record_log::Error::Bounds(_) => Error::Bounds(cause),
        record_log::Error::Refused(_) => Error::Refused(cause),
        record_log::Error::Conflict(_) => Error::Conflict(cause),
        _ => Error::Source(cause),
    }
}
/// The answer to a failed admission. A sign-in store that could not be read (busy, or unavailable) is a source condition the
/// caller retries; only a read that answered the person's rights is a refusal.
fn admission_error(error: account::AccountError) -> Error {
    let cause = error.cause();
    match error {
        account::AccountError::SourceUnavailable(_) => Error::Source(cause),
        _ => Error::Refused(cause),
    }
}
fn journal_error(e: journal::Error) -> Error {
    match e {
        journal::Error::Invalid(cause) => Error::Invalid(cause),
        journal::Error::Bounds(cause) => Error::Bounds(cause),
        journal::Error::Conflict(cause) => Error::Conflict(cause),
        journal::Error::Unknown(cause) => Error::OutcomeUnknown(cause),
        journal::Error::Unavailable(cause) | journal::Error::Changed(cause) => Error::Source(cause),
    }
}

enum StateAuthority<'a> {
    Browser {
        session: &'a WorkspaceSession,
        admitted: BrowserAdmission,
    },
    Personal(&'a mut dyn FnMut(&mut LocalAccount) -> crate::account::AccountResult<()>),
}

struct State<'a, 'c, W: CurrentCommand> {
    owner: &'a mut LocalAccount,
    external: &'a mut W,
    authority: StateAuthority<'c>,
    cancel: Arc<AtomicBool>,
    path: PathBuf,
    inode: Inode,
    handle: usize,
    deadline: Instant,
    /// How many full witnesses this command ran (`Work::source_witnesses`).
    witnesses: u64,
}
impl<W: CurrentCommand> State<'_, '_, W> {
    /// The free checks every step of the held transaction repeats.
    fn step(&self, db: &Connection) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) {
            let error = crate::cause!(Error::Refused);
            crate::quiet_eprintln!("record-writer event=refused reason=cancelled-at-step cause={}", error.cause());
            return Err(error);
        }
        if Instant::now() >= self.deadline {
            return Err(crate::cause!(Error::Bounds));
        }
        // SAFETY: only the address is compared; the handle is not used.
        if unsafe { db.handle() } as usize != self.handle {
            return Err(crate::cause!(Error::Source));
        }
        Ok(())
    }
    fn source(&mut self, db: &Connection) -> Result<()> {
        if self.cancel.load(Ordering::Acquire) {
            let error = crate::cause!(Error::Refused);
            crate::quiet_eprintln!("record-writer event=refused reason=cancelled-at-source cause={}", error.cause());
            return Err(error);
        }
        if Instant::now() >= self.deadline {
            return Err(crate::cause!(Error::Bounds));
        }
        self.owner.assert_owned_now().map_err(|error| Error::Source(error.cause()))?;
        let selected_path = self
            .external
            .physical_path()
            .or_else(|| self.owner.source.record_book_path.as_deref());
        if selected_path != Some(self.path.as_path()) {
            return Err(crate::cause!(Error::Source));
        }
        self.inode.check(&self.path).map_err(|error| Error::Source(error.cause()))?;
        check_sqlite_sidecars(&self.path).map_err(|error| Error::Source(error.cause()))?;
        let mut moved = 1i32;
        // SAFETY: this private operation retains the observed connection; no
        // raw handle/statement escapes. main and the output live for this call.
        let (handle, readonly, rc) = unsafe {
            (
                db.handle() as usize,
                rusqlite::ffi::sqlite3_db_readonly(db.handle(), b"main\0".as_ptr().cast()),
                rusqlite::ffi::sqlite3_file_control(
                    db.handle(),
                    b"main\0".as_ptr().cast(),
                    rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                    (&mut moved as *mut i32).cast(),
                ),
            )
        };
        if handle != self.handle || readonly != 0 || moved != 0 || rc != rusqlite::ffi::SQLITE_OK {
            return Err(crate::cause!(Error::Source));
        }
        Ok(())
    }
    /// Repeat only the existing admission owner. A committed delivery performs
    /// this possibly remote check before starting its bounded local snapshot.
    fn admission_current(&mut self) -> Result<()> {
        match &mut self.authority {
            StateAuthority::Browser { session, admitted } => {
                let now = account::current_browser_read_only(self.owner, &session.session_id)
                    .map_err(|error| {
                        // AccountError is a value-free enum; no session id, credential or input is logged.
                        crate::quiet_eprintln!("record-writer event=refused reason=browser-admission cause={}", error.cause());
                        admission_error(error)
                    })?;
                if now.account != admitted.account
                    || !admitted.still()
                    || now.account.user_id != session.account_id
                {
                    let error = crate::cause!(Error::Refused);
                    crate::quiet_eprintln!("record-writer event=refused reason=browser-admission-changed cause={}", error.cause());
                    return Err(error);
                }
            }
            StateAuthority::Personal(check) => check(self.owner).map_err(|error| {
                crate::quiet_eprintln!("record-writer event=refused reason=personal-admission cause={}", error.cause());
                admission_error(error)
            })?,
        }
        Ok(())
    }
    fn current(&mut self, db: &Connection) -> Result<()> {
        self.source(db)?;
        self.admission_current()?;
        self.source(db)
    }
}
/// The step checks: what the journal, the record log and every record store write call
/// between the boundaries (`State::witness`).
impl<W: CurrentCommand> CurrentCommand for State<'_, '_, W> {
    fn assert_current(&mut self, db: &Connection, binding: &CommandBinding) -> journal::Result<()> {
        self.step(db).map_err(|error| journal::Error::Changed(error.cause()))?;
        self.external.assert_current(db, binding)
    }
    fn assert_capture(
        &mut self,
        db: &Connection,
        binding: &CommandBinding,
        capture: &Capture<'_>,
    ) -> journal::Result<()> {
        self.step(db).map_err(|error| journal::Error::Changed(error.cause()))?;
        self.external.assert_capture(db, binding, capture)
    }
    fn assert_completion(
        &mut self,
        db: &Connection,
        binding: &CommandBinding,
        receipt: &journal::Completion,
    ) -> journal::Result<()> {
        // Known effect custody remains independent of public disclosure.
        self.step(db).map_err(|error| journal::Error::Changed(error.cause()))?;
        self.external.assert_completion(db, binding, receipt)
    }
}
#[path = "native_command_context.rs"]
pub mod native_command_context;

#[cfg(test)]
mod admission_error_tests {
    use super::{admission_error, Error};
    use crate::account::AccountError;

    #[test]
    fn an_unreadable_sign_in_store_is_a_source_condition_and_not_a_rights_refusal() {
        assert!(matches!(admission_error(crate::cause!(AccountError::SourceUnavailable)), Error::Source(_)));
        assert!(matches!(admission_error(crate::cause!(AccountError::RightsRefused)), Error::Refused(_)));
        assert!(matches!(admission_error(crate::cause!(AccountError::BrowserInactive)), Error::Refused(_)));
    }
}
