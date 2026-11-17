// src/tool_runs/os/owner_files_posix.rs: owner-only files on a POSIX computer (build-targets.json
// `owner_files: "posix"`): file mode and owner, device and inode, `O_NOFOLLOW`, `pread`/`pwrite`, `flock`, `statvfs`,
// `getpwuid_r` and symbolic links.
//
// Invariants: every answer is the computer's own (no default stands in for a value it did not give); the home folder
// comes from the account list for this process's effective owner, never from `HOME`.

use super::{FileFacts, Lock, Open, OwnerFiles, This};
use std::{
    ffi::{CStr, CString},
    fs::{DirBuilder, File, Metadata, OpenOptions, Permissions},
    io,
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
};

impl OwnerFiles for This {
    const IMPLEMENTATION: Option<&'static str> = Some("posix");

    fn facts(metadata: &Metadata) -> io::Result<FileFacts> {
        Ok(FileFacts {
            device: metadata.dev(),
            inode: metadata.ino(),
            owner: metadata.uid(),
            group: metadata.gid(),
            mode: metadata.mode(),
            links: metadata.nlink(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }

    fn mode_of(permissions: &Permissions) -> io::Result<u32> {
        Ok(permissions.mode())
    }

    fn with_mode(mode: u32) -> io::Result<Permissions> {
        Ok(Permissions::from_mode(mode))
    }

    fn open(options: &mut OpenOptions, path: &Path, how: Open) -> io::Result<File> {
        let mut flags = 0;
        if how.no_follow {
            flags |= libc::O_NOFOLLOW;
        }
        if how.nonblocking {
            flags |= libc::O_NONBLOCK;
        }
        if how.folder {
            flags |= libc::O_DIRECTORY;
        }
        // std opens every file close-on-exec already; it is named so no child ever inherits an owner-only file.
        options.custom_flags(flags | libc::O_CLOEXEC);
        if let Some(mode) = how.mode {
            options.mode(mode);
        }
        crate::io_operation!(options.open(path))
    }

    fn make_folder(path: &Path, mode: u32, all: bool) -> io::Result<()> {
        crate::io_operation!(DirBuilder::new().recursive(all).mode(mode).create(path))
    }

    fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<()> {
        crate::io_operation!(file.read_exact_at(buffer, offset))
    }

    fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
        crate::io_operation!(file.read_at(buffer, offset))
    }

    fn write_all_at(file: &File, bytes: &[u8], offset: u64) -> io::Result<()> {
        crate::io_operation!(file.write_all_at(bytes, offset))
    }

    fn this_owner() -> io::Result<u32> {
        // SAFETY: geteuid only reads this process's effective owner.
        Ok(unsafe { libc::geteuid() })
    }

    fn home_folder() -> io::Result<PathBuf> {
        let mut storage = vec![0_u8; 64 * 1024];
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // SAFETY: storage, record and result stay live for the call and the copy below; getpwuid_r bounds its writes
        // by the length it is given.
        let status = unsafe {
            libc::getpwuid_r(libc::geteuid(), record.as_mut_ptr(), storage.as_mut_ptr().cast(), storage.len(), &mut result)
        };
        if status != 0 || result.is_null() {
            return crate::io_operation!(Err(io::Error::new(io::ErrorKind::NotFound, "this owner has no account entry")));
        }
        // SAFETY: getpwuid_r answered success with a non-null result, so record is initialized.
        let record = unsafe { record.assume_init() };
        if record.pw_dir.is_null() {
            return crate::io_operation!(Err(io::Error::new(io::ErrorKind::NotFound, "this owner has no home folder")));
        }
        // SAFETY: pw_dir points into storage, a NUL-terminated string getpwuid_r wrote.
        let home = unsafe { CStr::from_ptr(record.pw_dir) };
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())))
    }

    fn free_bytes(path: &Path) -> io::Result<u64> {
        let name = crate::io_operation!((CString::new(path.as_os_str().as_bytes()).map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::InvalidInput), _refusal_io_cause) })).map_err(std::io::Error::from))?;
        // SAFETY: `statvfs` writes only into the zeroed struct it is given and reads the NUL-terminated name.
        let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(name.as_ptr(), &mut stats) } != 0 {
            return crate::io_operation!(Err(io::Error::last_os_error()));
        }
        // Available blocks times the fragment size.
        #[allow(clippy::useless_conversion)]
        Ok(u64::from(stats.f_bavail).saturating_mul(u64::from(stats.f_frsize)))
    }

    fn free_inodes(path: &Path) -> io::Result<u64> {
        let name = crate::io_operation!((CString::new(path.as_os_str().as_bytes()).map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(io::Error::from(io::ErrorKind::InvalidInput), _refusal_io_cause) })).map_err(std::io::Error::from))?;
        // SAFETY: `statvfs` writes only into the zeroed struct it is given and reads the NUL-terminated name.
        let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(name.as_ptr(), &mut stats) } != 0 {
            return crate::io_operation!(Err(io::Error::last_os_error()));
        }
        #[allow(clippy::useless_conversion)]
        Ok(u64::from(stats.f_favail))
    }

    fn link(target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
        crate::io_operation!(std::os::unix::fs::symlink(target, link))
    }

    fn map_shared(file: &File, bytes: usize) -> io::Result<std::ptr::NonNull<u8>> {
        // SAFETY: a shared read/write mapping of a descriptor the caller owns; checked below.
        let at = unsafe { libc::mmap(std::ptr::null_mut(), bytes, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, file.as_raw_fd(), 0) };
        if at == libc::MAP_FAILED {
            return crate::io_operation!(Err(io::Error::last_os_error()));
        }
        crate::io_operation!(std::ptr::NonNull::new(at.cast()).ok_or_else(|| io::Error::from(io::ErrorKind::Other)))
    }

    fn unmap(at: std::ptr::NonNull<u8>, bytes: usize) {
        // SAFETY: the mapping `map_shared` made, unmapped once by its owner.
        unsafe { libc::munmap(at.as_ptr().cast(), bytes) };
    }

    fn sync_map(at: std::ptr::NonNull<u8>, bytes: usize) {
        // SAFETY: a mapping its owner holds.
        unsafe { libc::msync(at.as_ptr().cast(), bytes, libc::MS_SYNC) };
    }

    fn set_mode(path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
        crate::io_operation!(std::fs::set_permissions(path, Permissions::from_mode(mode)))
    }

    fn lock(file: &File, how: Lock) -> io::Result<bool> {
        let operation = match how {
            Lock::Try => libc::LOCK_EX | libc::LOCK_NB,
            Lock::TryShared => libc::LOCK_SH | libc::LOCK_NB,
            Lock::Wait => libc::LOCK_EX,
            Lock::Release => libc::LOCK_UN,
        };
        // SAFETY: the descriptor is borrowed from `file` for this one call.
        if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if matches!(how, Lock::Try | Lock::TryShared) && error.kind() == io::ErrorKind::WouldBlock {
            return Ok(false);
        }
        crate::io_operation!(Err(error))
    }
}
