// src/account_files/held.rs
//
// Purpose: The secrets vault (`crate::secrets`) as the account files byte owner's vault port
// (`objects::Secrets`). The vault knows nothing of who consumes it; this adapter lives with the consumer.
//
// Non-Negotiable Invariants:
// - The secret never leaves the vault: `sigv4_day_key` runs the vault's own signing operation over the day.
// - A refusal carries the vault name it concerns and never a value.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::objects::{Secrets, ObjectError};
use crate::{secrets, storage::Storage};
use zeroize::Zeroizing;

impl<S: Storage + Send + 'static> Secrets for secrets::Secrets<S> {
    fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError> {
        secrets::Secrets::plain(self, name).map_err(refused)
    }
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        secrets::Secrets::sigv4_day_key(self, name, day).map_err(refused)
    }
    fn holds(&self, name: &str) -> Result<bool, ObjectError> {
        secrets::Secrets::holds(self, name).map_err(refused)
    }
}

/// The vault as the process keeps it open (`secrets::open_home`).
impl<S: Storage + Send + 'static> Secrets for std::sync::Arc<secrets::Secrets<S>> {
    fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError> {
        Secrets::plain(&**self, name)
    }
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        Secrets::sigv4_day_key(&**self, name, day)
    }
    fn holds(&self, name: &str) -> Result<bool, ObjectError> {
        Secrets::holds(&**self, name)
    }
}

fn refused(error: secrets::Error) -> ObjectError {
    match error {
        secrets::Error::NotHeld(name, cause) => ObjectError::NotHeld(name, cause),
        other => { let cause = other.cause(); ObjectError::Unavailable(other.to_string(), cause) },
    }
}
