// src/tool_runs/os/process_table_proc_pidinfo.rs: the process table through libproc (build-targets.json
// `process_table: "proc-pidinfo"`). Only reads; a gone process is `Ok(None)`, any other failure an error; a full
// listing is inconclusive (`None`), never proof a group is empty.

use super::{ProcessTable, This};
use std::io;

#[link(name = "proc")]
extern "C" {}

impl ProcessTable for This {
    const IMPLEMENTATION: Option<&'static str> = Some("proc-pidinfo");

    /// The kernel's start time of `pid`: whole seconds and microseconds.
    fn started(pid: u32) -> io::Result<Option<(u64, u64)>> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        // SAFETY: `info` is writable storage of exactly `size` bytes for the whole call.
        let got = unsafe {
            libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size)
        };
        if got == size {
            return Ok(Some((info.pbi_start_tvsec, info.pbi_start_tvusec)));
        }
        let error = io::Error::last_os_error();
        if got == 0 && crate::refusal_cause::raw_os_error(&(error)) == Some(libc::ESRCH) {
            return Ok(None);
        }
        crate::io_operation!(Err(error))
    }

    fn other_group_members(pid: u32) -> Option<bool> {
        Some(group_members(pid)?.iter().any(|member| *member != pid))
    }

    /// Each member's physical footprint (`proc_pid_rusage` RUSAGE_INFO_V2 `ri_phys_footprint`, the memory the system
    /// itself reports for the process), summed.
    fn group_footprint(pid: u32) -> Option<u64> {
        let footprint = |member: u32| -> Option<u64> {
            let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
            // SAFETY: `info` is a valid rusage_info_v2 the call fills for flavor RUSAGE_INFO_V2, and lives through it.
            let read = unsafe {
                libc::proc_pid_rusage(member as i32, libc::RUSAGE_INFO_V2, (&mut info as *mut libc::rusage_info_v2).cast())
            };
            (read == 0).then_some(info.ri_phys_footprint)
        };
        Some(group_members(pid)?.into_iter().filter_map(footprint).fold(0u64, u64::saturating_add))
    }
}

/// Every process of the group `pid` leads, the leader too while it runs; `None` when the list cannot be read whole.
fn group_members(pid: u32) -> Option<Vec<u32>> {
    // PROC_PGRP_ONLY is 2 in the native sys/proc_info.h contract. A full
    // buffer is inconclusive rather than permission to claim cleanup.
    let mut members = [0i32; 4096];
    let bound = std::mem::size_of_val(&members);
    let bytes = unsafe { libc::proc_listpids(2, pid, members.as_mut_ptr().cast(), bound as i32) };
    if bytes < 0 || bytes as usize >= bound || !(bytes as usize).is_multiple_of(std::mem::size_of::<i32>()) {
        return None;
    }
    Some(
        members[..bytes as usize / std::mem::size_of::<i32>()]
            .iter()
            .filter(|member| **member > 0)
            .map(|member| *member as u32)
            .collect(),
    )
}
