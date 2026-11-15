//! DATA file names, the disk guard and JSON output shared by every binary.

use std::path::{Path, PathBuf};
use workload_simulation::SimError;

/// This package's folder: `workloads/`, `candidates/`, `faults/`,
/// `cost-models/`, `shapes/` and `usage/` live under it.
pub const HOME: &str = env!("CARGO_MANIFEST_DIR");
/// Heavy work refuses to start (or to start another run) below this.
pub const MIN_FREE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// A bare name resolves to `<HOME>/<dir>/<name>.json`; anything with a path
/// separator or a `.json` suffix is a path.
pub fn resolve(dir: &str, name: &str) -> PathBuf {
    if name.contains('/') || name.ends_with(".json") {
        PathBuf::from(name)
    } else {
        PathBuf::from(format!("{HOME}/{dir}/{name}.json"))
    }
}

pub fn free_bytes(path: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(path.as_os_str().to_string_lossy().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: valid NUL-terminated path and an owned out-parameter.
    (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize)
}

/// Refuse heavy work when `path`'s volume holds less than [`MIN_FREE_BYTES`].
pub fn require_free(path: &Path) -> Result<(), SimError> {
    let free = free_bytes(path)
        .ok_or_else(|| SimError::Data("free space is unknown; refusing to start".into()))?;
    if free < MIN_FREE_BYTES {
        return Err(SimError::Data(format!(
            "only {} GiB free at {}; the 10 GiB reserve refuses heavy work",
            free / (1 << 30),
            path.display()
        )));
    }
    Ok(())
}

/// Pretty JSON with a trailing newline, written to a temporary name first
/// and renamed, so a reader never sees half a file.
pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), SimError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| SimError::Data(e.to_string()))?;
    bytes.push(b'\n');
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
