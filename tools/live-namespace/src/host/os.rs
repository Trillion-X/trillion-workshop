// src/host/os.rs
//
// Purpose: What this tool asks the computer under it for that only some computers have, kept from src/tool_runs/os.rs of
// Trillion-X/trillion-rust at 5fbc2ff4b1: files only their owner may read (`OwnerFiles`: owner, mode, identity, locks,
// shared mappings, free bytes) and the process table (`ProcessTable`). Each capability is one trait whose default methods are
// the absent answer; `This` is the computer this program runs on, with its POSIX implementation where it has one.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use std::{
    io,
    path::{Path, PathBuf},
};

/// The computer this program runs on: the one implementor of every capability.
pub struct This;

/// Observe other processes: when one started, and whether a process group still has members.
pub trait ProcessTable {
    const IMPLEMENTATION: Option<&'static str> = None;
    /// When `pid` started (whole seconds, the rest in the system's units), compared for equality only; `Ok(None)`
    /// when no such process runs.
    fn started(_: u32) -> io::Result<Option<(u64, u64)>> {
        crate::io_operation!(Err(io::ErrorKind::Unsupported.into()))
    }
    /// Whether a process other than `pid` is in the group `pid` leads; `None` when this cannot be known.
    fn other_group_members(_: u32) -> Option<bool> {
        None
    }
    /// The physical memory the group `pid` leads holds now: each member's footprint, summed (a member that ends or
    /// cannot be read while it is counted adds nothing); `None` when the group cannot be read. Absent: `None`, so a
    /// memory bound is never met by a computer that cannot read it (the run's other bounds still end it).
    fn group_footprint(_: u32) -> Option<u64> {
        None
    }
}

/// Files only their owner may read or change, and what the computer says about a file: its owner, mode, identity and
/// times. The account door, the computer entry and the stores keep keys and records in such files; a computer without
/// them (no owner, no mode, no way to refuse following a link) answers every method absent, and those doors then refuse
/// instead of writing a key file anyone could read.
pub trait OwnerFiles {
    const IMPLEMENTATION: Option<&'static str> = None;
    /// What the computer says about the file `metadata` describes.
    fn facts(_: &std::fs::Metadata) -> io::Result<FileFacts> {
        crate::io_operation!(Err(absent()))
    }
    /// The mode bits `permissions` hold.
    fn mode_of(_: &std::fs::Permissions) -> io::Result<u32> {
        crate::io_operation!(Err(absent()))
    }
    /// Permissions holding exactly the mode bits `mode`.
    fn with_mode(_: u32) -> io::Result<std::fs::Permissions> {
        crate::io_operation!(Err(absent()))
    }
    /// Open `path` with `options`, as `how` says (not following a final link, not waiting, the mode a new file gets).
    fn open(_: &mut std::fs::OpenOptions, _: &Path, _: Open) -> io::Result<std::fs::File> {
        crate::io_operation!(Err(absent()))
    }
    /// Make one folder `path` whose mode is `mode`; `all` makes its missing parents too.
    fn make_folder(_: &Path, _: u32, _: bool) -> io::Result<()> {
        crate::io_operation!(Err(absent()))
    }
    /// Read exactly `buffer.len()` bytes of `file` from `offset`, without moving its cursor.
    fn read_exact_at(_: &std::fs::File, _: &mut [u8], _: u64) -> io::Result<()> {
        crate::io_operation!(Err(absent()))
    }
    /// Read up to `buffer.len()` bytes of `file` from `offset`, without moving its cursor.
    fn read_at(_: &std::fs::File, _: &mut [u8], _: u64) -> io::Result<usize> {
        crate::io_operation!(Err(absent()))
    }
    /// Write all of `bytes` into `file` at `offset`, without moving its cursor.
    fn write_all_at(_: &std::fs::File, _: &[u8], _: u64) -> io::Result<()> {
        crate::io_operation!(Err(absent()))
    }
    /// The owner number this process makes and reads files as.
    fn this_owner() -> io::Result<u32> {
        crate::io_operation!(Err(absent()))
    }
    /// The home folder of the person this process runs as, from the computer's account list (never the environment a
    /// parent could set).
    fn home_folder() -> io::Result<PathBuf> {
        crate::io_operation!(Err(absent()))
    }
    /// Bytes free to an unprivileged writer on the volume holding `path`.
    fn free_bytes(_: &Path) -> io::Result<u64> {
        crate::io_operation!(Err(absent()))
    }
    /// The free inodes to an unprivileged writer on the volume holding `path` (`statvfs` on a POSIX computer).
    fn free_inodes(_: &Path) -> io::Result<u64> {
        crate::io_operation!(Err(absent()))
    }
    /// Make `link` a link naming `target`.
    fn link(_: impl AsRef<Path>, _: impl AsRef<Path>) -> io::Result<()> {
        crate::io_operation!(Err(absent()))
    }
    /// Map the first `bytes` of `file` shared, readable and writable: a write to the mapping is in the file the moment
    /// it is made, for every process that maps it. The caller unmaps it once (`unmap`).
    fn map_shared(_: &std::fs::File, _: usize) -> io::Result<std::ptr::NonNull<u8>> {
        crate::io_operation!(Err(absent()))
    }
    /// Unmap what `map_shared` mapped.
    fn unmap(_: std::ptr::NonNull<u8>, _: usize) {}
    /// Ask the computer to write a shared mapping to the disk now.
    fn sync_map(_: std::ptr::NonNull<u8>, _: usize) {}
    /// Give the file or folder at `path` exactly the mode bits `mode`.
    fn set_mode(_: impl AsRef<Path>, _: u32) -> io::Result<()> {
        crate::io_operation!(Err(absent()))
    }
    /// Take, wait for, or give back the one exclusive lock of `file`: `Ok(false)` when `Lock::Try` finds another process
    /// has it. The lock is the one every trillion-local on this computer takes, held until given back or the file is closed. An
    /// interrupted wait answers `ErrorKind::Interrupted`, for the caller to wait again.
    fn lock(_: &std::fs::File, _: Lock) -> io::Result<bool> {
        crate::io_operation!(Err(absent()))
    }
}

/// What a computer with owner-only files says about one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileFacts {
    /// The volume and the file's number on it: one file while both are the same.
    pub device: u64,
    pub inode: u64,
    /// The owner number, its group number, and the mode (type and permission bits).
    pub owner: u32,
    pub group: u32,
    pub mode: u32,
    /// How many names the file has.
    pub links: u64,
    /// When its bytes changed, and when anything about it changed: whole seconds and nanoseconds.
    pub modified: (i64, i64),
    pub changed: (i64, i64),
}

/// What `OwnerFiles::lock` does with a file's exclusive lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lock {
    Try,
    TryShared,
    Wait,
    Release,
}

/// How `OwnerFiles::open` opens a file. `Open::default()` is a plain open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Open {
    /// Refuse when the last name is a link.
    pub no_follow: bool,
    /// Never wait on the file (a pipe, a device).
    pub nonblocking: bool,
    /// The file is a folder.
    pub folder: bool,
    /// The mode a file this open makes gets.
    pub mode: Option<u32>,
}
impl Open {
    /// Not following a final link, not waiting: how a key or record file is read.
    pub const NO_FOLLOW: Self = Self {
        no_follow: true,
        nonblocking: true,
        folder: false,
        mode: None,
    };
    /// A file only its owner may read or write, when this open makes it.
    pub const fn owner_only(mode: u32) -> Self {
        Self {
            no_follow: false,
            nonblocking: false,
            folder: false,
            mode: Some(mode),
        }
    }
}

fn absent() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "this computer does not have that capability",
    )
}


#[cfg(unix)]
#[path = "os/owner_files_posix.rs"]
mod owner_files;
#[cfg(not(unix))]
impl OwnerFiles for This {}

#[cfg(target_os = "macos")]
#[path = "os/process_table_proc_pidinfo.rs"]
mod process_table;
#[cfg(target_os = "linux")]
#[path = "os/process_table_procfs.rs"]
mod process_table;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl ProcessTable for This {}
