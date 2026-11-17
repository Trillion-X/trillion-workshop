// src/account_files/held.rs
//
// Purpose: The values this run holds (`crate::secrets::Held`: the person's `files-store` connection the engine attached) as the
// account files byte owner's vault port (`objects::Secrets`). The holder knows nothing of who consumes it; this adapter lives with
// the consumer.
//
// Non-Negotiable Invariants:
// - The secret never leaves the holder: `sigv4_day_key` runs the holder's own signing operation over the day.
// - A refusal carries the vault name it concerns and never a value.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::objects::{Secrets, ObjectError};
use crate::secrets::{self, Held};
use zeroize::Zeroizing;

impl Secrets for Held {
    fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError> {
        Held::plain(self, name).map_err(refused)
    }
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        Held::sigv4_day_key(self, name, day).map_err(refused)
    }
    fn holds(&self, name: &str) -> Result<bool, ObjectError> {
        Ok(Held::holds(self, name))
    }
}

/// The holder as the process keeps it (`secrets::open_home`).
impl Secrets for std::sync::Arc<Held> {
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
