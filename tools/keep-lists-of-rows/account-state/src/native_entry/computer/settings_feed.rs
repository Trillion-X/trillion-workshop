//! The place's product settings follow the feed (D23). A signed `product-settings` entry is fetched from the feed's folder,
//! checked by its signature and its BLAKE3 identity, and written atomically beside the previous file. The place is restarted
//! on it and asked for `/readyz` on its own machine (D25): the new file is kept only on a 200 within the deadline. Otherwise
//! the previous file is written back, the place is restarted on it, and the refusal names what happened.
//!
//! The entry is the engine's own (`releases::Entry`), signed under the engine's domain over the relative `url`, so a place
//! names no host: the hosts come from the feed's URLs at fetch time (`releases::body_urls`).

use super::releases::{self, numbers, Entry, Fetch, Row};
use crate::refusal_cause::CodedError;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The entry's `target` for a product settings file.
pub const TARGET: &str = "product-settings";
/// The feed that carries the product settings entries, beside the engine's `feed.json`.
pub const FEED: &str = "product-settings-feed.json";
/// The file mode of the settings file: a place reads it as its own, so nobody else may.
const SETTINGS_MODE: u32 = 0o600;
/// The partial file a download is written to before it is checked and renamed over the settings file.
const PARTIAL: &str = "partial";
/// The copy of the previous settings file kept beside the settings file while a new one is on trial.
const PREVIOUS: &str = "previous";
/// The file beside the settings file that names the sequence of the settings kept.
const SEQUENCE: &str = "sequence";

/// How a place restarts and proves itself ready (D25): its service unit and its own `/readyz` answer.
pub trait Restart: Sync {
    /// Restart the place so it reads the settings file. Err when the service manager refused it.
    fn restart(&self) -> Result<(), CodedError<&'static str>>;
    /// Whether the place's own `/readyz` answers 200 within its deadline, polled until `stop` is set.
    fn ready(&self, stop: &AtomicBool) -> bool;
}

/// The place's own service: `systemctl restart UNIT`, then `/readyz` at `readyz` asked on this machine, every `poll` until
/// `deadline` has passed. The unit and the URL are the place's layout row (D25), passed in from its config.
pub struct Service<'a> {
    pub unit: &'a str,
    pub readyz: &'a str,
    pub deadline: Duration,
    pub poll: Duration,
    pub fetch: &'a dyn Fetch,
}

impl Restart for Service<'_> {
    fn restart(&self) -> Result<(), CodedError<&'static str>> {
        let status = Command::new("systemctl").args(["restart", self.unit]).status()
            .map_err(|error| CodedError::with_cause("settings_restart_failed", crate::refusal_cause::Caused::cause(&error)))?;
        if status.success() { Ok(()) } else { Err(CodedError::new("settings_restart_failed")) }
    }

    fn ready(&self, stop: &AtomicBool) -> bool {
        let started = Instant::now();
        loop {
            // A 200 is the only answer `Fetch::get` reports as Ok, so any body read to its end is a ready place.
            if self.fetch.get(self.readyz, 4096, &mut io::sink(), stop).is_ok() {
                return true;
            }
            if started.elapsed() >= self.deadline || stop.load(Ordering::Acquire) {
                return false;
            }
            std::thread::sleep(self.poll);
        }
    }
}

/// Adopt `entry` as the place's product settings at `path` (D23): fetch and check it, write it atomically, restart the
/// place on it and keep it only when the place answers ready. Answers `Ok` when the new settings are kept. Otherwise the
/// refusal's code names what happened: a settings file that could not be checked or fetched, or a place that did not come
/// back ready on it (`settings_reverted`: the previous file is back and the place answers on it).
pub fn adopt(entry: &Entry, row: &Row, path: &Path, fetch: &dyn Fetch, restart: &dyn Restart, stop: &AtomicBool) -> Result<(), CodedError<&'static str>> {
    if entry.target != TARGET {
        return Err(CodedError::new("settings_target_refused"));
    }
    if !entry.signed_by(row) {
        return Err(CodedError::new("settings_signature_refused"));
    }
    let partial = sibling(path, PARTIAL);
    fetch_checked(entry, row, &partial, fetch, stop)?;
    let previous = fs::read(path).ok();
    if let Some(bytes) = &previous {
        write_settings(&sibling(path, PREVIOUS), bytes)?;
    }
    fs::rename(&partial, path).map_err(|_| CodedError::new("settings_unwritable"))?;
    fs::set_permissions(path, settings_permissions()).map_err(|_| CodedError::new("settings_unwritable"))?;
    if restart.restart().is_ok() && restart.ready(stop) {
        return Ok(());
    }
    revert(path, previous.as_deref(), restart, stop)
}

/// Write the previous settings back and restart the place on them. The refusal says whether the place came back ready.
fn revert(path: &Path, previous: Option<&[u8]>, restart: &dyn Restart, stop: &AtomicBool) -> Result<(), CodedError<&'static str>> {
    match previous {
        Some(bytes) => write_settings(path, bytes).map_err(|_| CodedError::new("settings_restore_failed"))?,
        None => fs::remove_file(path).map_err(|_| CodedError::new("settings_restore_failed"))?,
    }
    if restart.restart().is_ok() && restart.ready(stop) {
        Err(CodedError::new("settings_reverted"))
    } else {
        Err(CodedError::new("settings_restore_failed"))
    }
}

/// Read the product settings feed beside each engine feed URL and adopt its newest entry whose sequence is above the one
/// kept beside the settings file (`SEQUENCE`). Answers `Ok(Some(sequence))` when a newer entry was kept, `Ok(None)` when none
/// is newer or no feed answers. A refusal of the adoption is the adoption's own code.
pub fn look(feed_urls: &[String], row: &Row, path: &Path, fetch: &dyn Fetch, restart: &dyn Restart, stop: &AtomicBool) -> Result<Option<u64>, CodedError<&'static str>> {
    let kept = read_sequence(path);
    let Some(feed) = read_feed(feed_urls, fetch, stop) else {
        return Ok(None);
    };
    let newest = feed.into_iter()
        .filter(|entry| entry.target == TARGET && entry.sequence > kept && entry.signed_by(row))
        .max_by_key(|entry| entry.sequence);
    let Some(entry) = newest else {
        return Ok(None);
    };
    adopt(&entry, row, path, fetch, restart, stop)?;
    write_sequence(path, entry.sequence)?;
    Ok(Some(entry.sequence))
}

/// The entries of the first product settings feed that answers, read whole within the bound.
fn read_feed(feed_urls: &[String], fetch: &dyn Fetch, stop: &AtomicBool) -> Option<Vec<Entry>> {
    #[derive(serde::Deserialize)]
    struct Feed {
        releases: Vec<Entry>,
    }
    feed_urls.iter().find_map(|engine| {
        let url = url::Url::parse(engine).ok()?.join(FEED).ok()?.to_string();
        let mut bytes = Vec::new();
        fetch.get(&url, numbers().feed_body_max_bytes, &mut bytes, stop).ok()?;
        serde_json::from_slice::<Feed>(&bytes).ok().map(|feed| feed.releases)
    })
}

/// The sequence of the settings last kept at `path`, or 0 when none is recorded.
fn read_sequence(path: &Path) -> u64 {
    fs::read_to_string(sibling(path, SEQUENCE)).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(0)
}

/// Record the sequence of the settings kept at `path`.
fn write_sequence(path: &Path, sequence: u64) -> Result<(), CodedError<&'static str>> {
    fs::write(sibling(path, SEQUENCE), sequence.to_string()).map_err(|error| CodedError::with_cause("settings_unwritable", crate::refusal_cause::Caused::cause(&error)))
}

/// Download the entry's body from the first feed host that holds exactly its bytes and identity into `into`, then set its
/// mode. A host that answers other bytes is passed over like one that does not answer.
fn fetch_checked(entry: &Entry, row: &Row, into: &Path, fetch: &dyn Fetch, stop: &AtomicBool) -> Result<(), CodedError<&'static str>> {
    for url in releases::body_urls(entry, &row.urls) {
        if let Ok((written, content)) = releases::download(entry, &url, into, fetch, stop) {
            if written == entry.bytes && content == entry.content {
                return fs::set_permissions(into, settings_permissions()).map_err(|_| CodedError::new("settings_unwritable"));
            }
        }
        let _ = fs::remove_file(into);
    }
    Err(CodedError::new("settings_unreachable"))
}

/// The path beside `path` named `<file>.<suffix>`.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{name}.{suffix}"))
}

/// Write `bytes` to `path` through a partial file and a rename, so a reader never sees half of them.
fn write_settings(path: &Path, bytes: &[u8]) -> Result<(), CodedError<&'static str>> {
    let partial = sibling(path, PARTIAL);
    let unwritten = |error: io::Error| CodedError::with_cause("settings_unwritable", crate::refusal_cause::Caused::cause(&error));
    let mut file = fs::File::create(&partial).map_err(unwritten)?;
    file.write_all(bytes).map_err(unwritten)?;
    file.sync_all().map_err(unwritten)?;
    drop(file);
    fs::set_permissions(&partial, settings_permissions()).map_err(unwritten)?;
    fs::rename(&partial, path).map_err(unwritten)
}

/// The mode the settings file has: owner only.
fn settings_permissions() -> fs::Permissions {
    use std::os::unix::fs::PermissionsExt as _;
    fs::Permissions::from_mode(SETTINGS_MODE)
}

#[cfg(test)]
#[path = "settings_feed_tests.rs"]
mod tests;
