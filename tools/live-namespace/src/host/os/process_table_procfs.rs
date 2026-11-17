// src/tool_runs/os/process_table_procfs.rs: the process table from `/proc` (build-targets.json `process_table: "procfs"`).
// Only reads; a gone process is `Ok(None)`, any other failure an error; a listing past its bound is inconclusive.

use super::{ProcessTable, This};
use std::{fs, io};

impl ProcessTable for This {
    const IMPLEMENTATION: Option<&'static str> = Some("procfs");

    /// Field 22 (`starttime`, clock ticks since boot) of `/proc/<pid>/stat`, split into whole seconds and the rest of
    /// a second in ticks.
    fn started(pid: u32) -> io::Result<Option<(u64, u64)>> {
        let text = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return crate::io_operation!(Err(error)),
        };
        let unreadable = || io::Error::from(io::ErrorKind::InvalidData);
        // The command name (field 2) sits in parentheses and may hold spaces or ')'. Fields after the last ')'
        // start at field 3, so `starttime` (field 22) is the 20th of them.
        let after = crate::io_operation!((text.rsplit_once(')').ok_or_else(unreadable)).map_err(std::io::Error::from))?.1;
        let start: u64 = crate::io_operation!((after.split_whitespace().nth(19).and_then(|field| field.parse().ok()).ok_or_else(unreadable)).map_err(std::io::Error::from))?;
        // SAFETY: sysconf only reads a configuration value.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let ticks = crate::io_operation!((u64::try_from(ticks).ok().filter(|ticks| *ticks > 0).ok_or_else(unreadable)).map_err(std::io::Error::from))?;
        Ok(Some((start / ticks, start % ticks)))
    }

    fn other_group_members(pid: u32) -> Option<bool> {
        Some(group_members(pid)?.iter().any(|member| *member != pid))
    }

    /// Each member's resident memory (`/proc/<pid>/statm` field 2, in pages), summed.
    fn group_footprint(pid: u32) -> Option<u64> {
        // SAFETY: sysconf only reads a configuration value.
        let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok().filter(|page| *page > 0)?;
        let resident = |member: u32| -> Option<u64> {
            let statm = fs::read_to_string(format!("/proc/{member}/statm")).ok()?;
            Some(statm.split_whitespace().nth(1)?.parse::<u64>().ok()?.saturating_mul(page))
        };
        Some(group_members(pid)?.into_iter().filter_map(resident).fold(0u64, u64::saturating_add))
    }
}

/// Every process of the group `pid` leads, the leader too while it runs. A process that ends while the list is read is
/// not a member; one that cannot be read, or a listing past its bound, is inconclusive (`None`).
fn group_members(pid: u32) -> Option<Vec<u32>> {
    let mut members = Vec::new();
    for (count, entry) in fs::read_dir("/proc").ok()?.enumerate() {
        if count >= 65536 {
            return None;
        }
        let entry = entry.ok()?;
        let name = entry.file_name();
        let text = name.to_str()?;
        if !text.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let contents = match fs::read_to_string(entry.path().join("stat")) {
            Ok(value) if value.len() <= 16384 => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            _ => return None,
        };
        let end = contents.rfind(')')?;
        // Fields after the last ')' start at field 3; field 5 (`pgrp`) is the third of them.
        if contents[end + 1..].split_whitespace().nth(2)?.parse::<u32>().ok() == Some(pid) {
            members.push(text.parse().ok()?);
        }
    }
    Some(members)
}
