// src/host/local_account.rs
//
// Purpose: What the record store takes from the engine's local account: the start time of a process (`ProcessIdentity`, which the
// state lock compares to tell a live owner from a finished one) and the names of the account's own records.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

/// A process and when it started: whole seconds, then the rest in the system's units, compared for equality only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_seconds: u64,
    pub started_fraction: u64,
}

/// What the record store takes from the engine's own-records owner: the name of the resource that holds an account's identity
/// header, the settings its writers open with, and whether a command domain is current.
pub mod own_records {
    use crate::records::Error;
    use crate::storage::{record_store::RecordStore, record_store_resources::domains::Identity, Storage};
    use std::path::Path;

    /// The record store resource that holds the account's resource-identity header (one record).
    pub(crate) const IDENTITY: &str = "own-resource-identity";

    /// The record store settings of the account whose state folder is `state`: the shipped settings plus the orders its
    /// installed tools join. This tool has no installed tools, so the joined orders are none.
    pub(crate) fn installed_settings(state: &Path) -> Result<&'static crate::storage::record_store::settings::Settings, Error> {
        let model = crate::record_model_policy::installed(state).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        crate::storage::record_store::settings::with_joined_orders(&model.orders()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    /// Whether the command domain `identity` is the account's current one. An account of this tool has no command domain (the
    /// engine's command slots are not part of it), so none is current.
    pub(crate) fn domain_current<S: Storage>(_: &RecordStore<S>, _: &str, _: &Identity) -> Result<bool, Error> {
        Ok(false)
    }
}
