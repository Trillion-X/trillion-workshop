//! The one OS-neutral problem set. Every shell maps each problem to its own (Apple's NSFileProviderError, Windows'
//! cfapi status, Android's exceptions, a FUSE errno); the core maps every refusal the door answers to one of these
//! through contract.json `refusals` and `protocol_refusals` (src/door.rs), so no shell reads an answer itself.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Problem {
    /// The device credential is not accepted (sign in again).
    Unauthorised,
    /// The credential may not do this (a shared name is read-only).
    Forbidden,
    /// No such name or content.
    Missing,
    /// The version asked for is no longer the current one (a stale edit, a changed file).
    StaleVersion,
    /// No computer of the account answered.
    Unreachable,
    /// The request is outside the contract.
    Invalid,
    /// An answer failed its check (wrong version, range or length); nothing of it was handed over.
    RefusedCopy,
    /// The contract does not offer this job.
    NotOffered,
    /// The shell cancelled the demand.
    Cancelled,
}
