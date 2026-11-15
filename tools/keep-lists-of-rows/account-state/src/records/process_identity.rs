// src/records/process_identity.rs
//
// Purpose: The start time of a process, observed by its pid, so the state lock can tell a live owner from a
// finished one (src/local_account/state_lock_recovery.rs). The computer's process table answers (src/tool_runs/os.rs
// `ProcessTable`); a computer without one observes nothing and the state lock refuses to decide.
//
// Non-Negotiable Invariants:
// - Only the start time of a process is read. No signal is sent and no process is changed.
// - A process that is gone answers `None`, never an error. Any other failure is the unavailable error.
// - The value is compared for equality only; its two parts are the whole seconds and the rest in the system's units.
//
// Key Concepts:
// - `ProcessIdentity` is defined in src/local_account.rs; this file holds its `observe`.

use crate::account::{AccountError, AccountResult};
use crate::local_account::ProcessIdentity;
use crate::tool_runs::os::{ProcessTable, This};

/// Whether `pid` names a process whose start time may be observed: any pid above 0 that fits the system's pid type.
/// PID 1 is a real owner: `trillion-local serve` runs as PID 1 when it is a container's first process,
/// and the state lock names it like any other process. Only 0 (no process) is refused.
pub(crate) fn observable(pid: u32) -> bool {
    pid >= 1 && pid <= i32::MAX as u32
}

impl ProcessIdentity {
    /// The start time of `pid`. `None` when no such process is running; the unavailable error when this computer
    /// cannot say.
    pub fn observe(pid: u32) -> AccountResult<Option<Self>> {
        if !observable(pid) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        let started = This::started(pid).map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
        Ok(started.map(|(started_seconds, started_fraction)| Self { pid, started_seconds, started_fraction }))
    }
}

#[cfg(test)]
mod process_identity_tests {
    use super::*;

    #[test]
    #[cfg_attr(not(any(process_table = "procfs", process_table = "proc-pidinfo")), ignore = "this computer has no process table")]
    fn observe_returns_this_process_and_the_same_value_each_time() {
        let me = ProcessIdentity::observe(std::process::id()).unwrap().unwrap();
        assert_eq!(me.pid, std::process::id());
        assert_eq!(ProcessIdentity::observe(std::process::id()).unwrap(), Some(me));
    }

    #[test]
    #[cfg_attr(not(any(process_table = "procfs", process_table = "proc-pidinfo")), ignore = "this computer has no process table")]
    fn observe_names_a_finished_process_as_gone() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(ProcessIdentity::observe(pid).unwrap(), None);
    }

    #[test]
    fn observe_refuses_pid_zero_and_out_of_range() {
        assert!(matches!(ProcessIdentity::observe(0), Err(AccountError::InvalidInput(_))));
        assert!(matches!(ProcessIdentity::observe(u32::MAX), Err(AccountError::InvalidInput(_))));
    }

    /// `trillion-local serve` may be PID 1 when it is a container's first process: PID 1 is observed
    /// like any other process (measured refused on a Cloudflare Container, 2026-11-03).
    #[test]
    #[cfg_attr(not(process_table = "procfs"), ignore = "measured only where the process table is procfs")]
    fn observe_answers_pid_one() {
        let first = ProcessIdentity::observe(1).unwrap().expect("PID 1 runs in every PID namespace");
        assert_eq!(first.pid, 1);
        assert_eq!(ProcessIdentity::observe(1).unwrap(), Some(first));
    }
}
