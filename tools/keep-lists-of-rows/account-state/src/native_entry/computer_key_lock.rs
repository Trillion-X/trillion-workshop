// src/native_entry/computer_key_lock.rs
//
// Purpose: One engine per computer key on a host. The engine holds an exclusive lock on its computer key file for the
// rest of its life, so a second engine that opens the same key file is refused at start, whatever launched it.
//
// Non-Negotiable Invariants:
// - A second engine on the same key file is refused while the first one lives (the lock is per open file, so this holds
//   inside one process too). Stopping the first engine releases the key for the next one.
// - A different key file never conflicts with this one.
//
// Key Concepts:
// - `File::try_lock` (exclusive, non-blocking): the lock is released by the operating system when the process ends.
//
// Security Considerations:
// - The lock holds no key material and writes nothing to the key file.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! The exclusive lock an engine holds on its computer key file (`computer::start`). Two engines that share a key on one host
//! make rival computer sessions under one computer id (the relay's route churn, 2026-11-12), so the second one is refused here.

use std::{fs::{File, TryLockError}, io, path::Path};

/// Why a computer key file is not locked for this engine: `kind` is `WouldBlock` when another engine holds it.
#[derive(Debug)]
pub struct KeyLockError {
    pub kind: io::ErrorKind,
    cause: crate::refusal_cause::Cause,
}

impl KeyLockError {
    #[track_caller]
    fn new(kind: io::ErrorKind) -> Self {
        Self { kind, cause: crate::cause!(caller_site: KeyLockError) }
    }
}

/// Lock the key file at `path` exclusively. The lock lasts as long as the returned file: the engine keeps it for its life
/// (`Computer`), and a stopped engine releases it. Another open of the file, from this process or another, is refused with
/// `WouldBlock` (another engine holds it).
pub fn hold(path: &Path) -> Result<File, KeyLockError> {
    let file = File::open(path).map_err(|error| KeyLockError::new(error.kind()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(KeyLockError::new(io::ErrorKind::WouldBlock)),
        Err(TryLockError::Error(error)) => Err(KeyLockError::new(error.kind())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_file(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("computer-key-lock-{}-{name}", std::process::id()));
        std::fs::write(&path, b"key").expect("key file");
        path
    }

    #[test]
    fn a_second_engine_on_the_same_key_is_refused() {
        let path = key_file("same");
        let _first = hold(&path).expect("the first engine holds the key");
        assert_eq!(hold(&path).unwrap_err().kind, io::ErrorKind::WouldBlock, "a second engine on the same key is refused");
    }

    #[test]
    fn a_different_key_file_is_not_refused() {
        let first = key_file("first");
        let second = key_file("second");
        let _first = hold(&first).expect("the first key");
        let _second = hold(&second).expect("another computer's key does not conflict");
    }

    #[test]
    fn a_missing_key_file_is_unreadable() {
        let path = std::env::temp_dir().join(format!("computer-key-lock-{}-missing", std::process::id()));
        assert_eq!(hold(&path).unwrap_err().kind, io::ErrorKind::NotFound);
    }
}
