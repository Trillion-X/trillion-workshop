// src/host/account.rs
//
// Purpose: The two things the record store's files take from the account owner of the engine this tool was moved out of: its
// error (`AccountError`, copied from src/account.rs of Trillion-X/trillion-rust at 5fbc2ff4b1) and the report of the computer
// this program runs on (`computers::this_computer`), which sizes the store's byte budget. The account's copies between
// computers are not part of this tool: no vault of this tool's store has copies, so `copies::vault_gate` always answers free.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountError {
    InvalidInput(crate::refusal_cause::Cause),
    SourceUnavailable(crate::refusal_cause::Cause),
    SourceChanged(crate::refusal_cause::Cause),
    /// The read's own cancellation (its caller went away or stopped it), not a change to the source.
    Cancelled(crate::refusal_cause::Cause),
    /// The read's deadline passed before its last check, not a change to the source.
    DeadlineElapsed(crate::refusal_cause::Cause),
    BrowserInactive(crate::refusal_cause::Cause),
    RightsRefused(crate::refusal_cause::Cause),
    RightsChanging(crate::refusal_cause::Cause),
    KeyWithdrawn(crate::refusal_cause::Cause),
    OriginalBindingUnavailable(crate::refusal_cause::Cause),
    RecoveryPending(crate::refusal_cause::Cause),
    AlreadyIssued(crate::refusal_cause::Cause),
    RootUnavailable(crate::refusal_cause::Cause),
    /// The record read names a kind that stays on this computer, to a caller that is not running here.
    DeviceOnly(crate::refusal_cause::Cause),
    /// A records filter that no declared order narrows asked to read a kind too large to read row by row.
    WholeKind(crate::refusal_cause::Cause),
    /// The key's sign-in use note is due for the first time or its row is not settled, and this owner writes none:
    /// the account's own owner admits it.
    UseNoteRequired(crate::refusal_cause::Cause),
}
impl AccountError {
    /// Static construction site and condition; never caller input or private values.
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::InvalidInput(cause) => cause,
            Self::SourceUnavailable(cause) => cause,
            Self::SourceChanged(cause) => cause,
            Self::Cancelled(cause) => cause,
            Self::DeadlineElapsed(cause) => cause,
            Self::BrowserInactive(cause) => cause,
            Self::RightsRefused(cause) => cause,
            Self::RightsChanging(cause) => cause,
            Self::KeyWithdrawn(cause) => cause,
            Self::OriginalBindingUnavailable(cause) => cause,
            Self::RecoveryPending(cause) => cause,
            Self::AlreadyIssued(cause) => cause,
            Self::RootUnavailable(cause) => cause,
            Self::DeviceOnly(cause) => cause,
            Self::WholeKind(cause) => cause,
            Self::UseNoteRequired(cause) => cause,
        }
    }
}
crate::impl_caused!(AccountError);

impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let words = match self {
            Self::InvalidInput(_) => "native account input refused",
            Self::SourceUnavailable(_) => "original account source unavailable",
            Self::SourceChanged(_) => "original account source changed",
            Self::Cancelled(_) => "the read was cancelled",
            Self::DeadlineElapsed(_) => "the read's deadline elapsed",
            Self::BrowserInactive(_) => "original browser sign-in inactive",
            Self::RightsRefused(_) => "current account rights refused",
            Self::RightsChanging(_) => "current account rights changing",
            Self::KeyWithdrawn(_) => "original Mac credential withdrawn or changed",
            Self::OriginalBindingUnavailable(_) => "original Mac issuer binding unavailable",
            Self::RecoveryPending(_) => "original Mac publication requires owner recovery",
            Self::AlreadyIssued(_) => "original Mac credential reveal window ended",
            Self::RootUnavailable(_) => "original native-key root unavailable",
            Self::DeviceOnly(_) => "a kind of record that stays on this computer",
            Self::WholeKind(_) => "a filter that would read every row of a large kind",
            Self::UseNoteRequired(_) => "a sign-in use note only the account's own owner writes",
        };
        write!(f, "{words}; cause={}", self.cause().id())
    }
}
impl std::error::Error for AccountError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type AccountResult<T> = Result<T, AccountError>;
pub mod computers {
    use crate::storage::record_store::settings::Budget;

    /// What the computer says about itself that the record store reads: how large it lets a store grow.
    pub struct ComputerReport {
        pub storage: Budget,
    }

    /// The report this program gives of the computer it runs on: a store may grow to what it holds plus the volume's free
    /// bytes above 10 GiB (the shipped default of the engine this tool came from).
    pub fn this_computer() -> &'static ComputerReport {
        static REPORT: ComputerReport = ComputerReport { storage: Budget::KeepFreeBytes(10_737_418_240) };
        &REPORT
    }

    pub mod copies {
        use crate::storage::{record_store::RecordStore, Storage};
        use std::path::Path;

        /// The copies of an account that follow a vault. This tool's store has none, so the type holds no value.
        pub enum Copies {}
        impl Copies {
            pub fn is_writer(&self) -> bool {
                match *self {}
            }
            pub fn holders(&self) -> Vec<String> {
                match *self {}
            }
        }

        pub enum VaultGate {
            /// No copies follow this vault: it is written on its own store.
            Free,
            Copies(std::sync::Arc<Copies>),
            Closed,
        }

        pub fn vault_gate<S: Storage>(_: Option<&Path>, _: &str, _: &RecordStore<S>) -> VaultGate {
            VaultGate::Free
        }
    }
}
