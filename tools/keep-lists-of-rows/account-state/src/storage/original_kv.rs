//! Write public values through the original APP_KV's typed index and immutable
//! blob layout. A caller supplies its already admitted selected store and
//! a write scope; values contain public metadata, never credentials. Immutable
//! blobs are durable before their pointers become visible in the one atomic
//! index transaction. A failed commit may leave an unreferenced public blob,
//! but never a pointer to missing bytes or a replacement of an existing value.
use super::{Error, Read, Result, Storage, Value, When};
use content_crypto::advanced::blake3;
use std::{
    fs::{self, OpenOptions},
    io::{Read as _, Write},
    path::Path,
};

use crate::tool_runs::os::{Open, OwnerFiles, This};

const MOST: usize = 64 * 1024;
/// The most bytes one published service record (`service-record:{label}`) may hold: the bound its reader reads with
/// (src/local_account/show_rules.rs `show_rule_service_record`).
pub(crate) const MOST_PUBLISHED: usize = 4 * 1024 * 1024;
pub(crate) fn read(
    store: &dyn Storage,
    blobs: &Path,
    key: &str,
    now: u64,
) -> Result<Option<Vec<u8>>> {
    read_at_most(store, blobs, key, now, MOST)
}
/// `read` with the caller's bound, which is at most `MOST_PUBLISHED`.
pub(crate) fn read_at_most(
    store: &dyn Storage,
    blobs: &Path,
    key: &str,
    now: u64,
    most: usize,
) -> Result<Option<Vec<u8>>> {
    if most == 0 || most > MOST_PUBLISHED {
        return Err(crate::cause!(Error::Invalid));
    }
    let Some(mut row) = store.get(
        "_mf_entries",
        &[Value::from(key)],
        &[Read::at_most("blob_id", 256), Read::whole("expiration")],
    )?
    else {
        return Ok(None);
    };
    if matches!(row.0.get(1),Some(Value::Integer(at)) if *at < 0 || *at as u64 <= now) {
        return Ok(None);
    }
    let Value::Text(name) = row.take(0) else {
        return Err(crate::cause!(Error::Invalid));
    };
    if name.is_empty() || name.len() > 256 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(crate::cause!(Error::Invalid));
    }
    let path = blobs.join(name);
    let mut file = This::open(OpenOptions::new().read(true), &path, Open::NO_FOLLOW)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !file.metadata().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_file() {
        return Err(crate::cause!(Error::Invalid));
    }
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(most as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if bytes.len() > most {
        return Err(crate::cause!(Error::Invalid));
    }
    store.custody()?;
    Ok(Some(bytes))
}

pub(crate) fn keep_public(
    store: &dyn Storage,
    blobs: &Path,
    key: &str,
    bytes: &[u8],
    now: u64,
) -> Result<()> {
    if key.is_empty() || key.len() > 1024 || bytes.is_empty() || bytes.len() > MOST {
        return Err(crate::cause!(Error::Invalid));
    }
    if let Some(old) = read(store, blobs, key, now)? {
        return if old == bytes {
            Ok(())
        } else {
            Err(crate::cause!(Error::Conflict))
        };
    }
    let name = keep_blob(blobs, bytes, MOST)?;
    store.put(
        "_mf_entries",
        &[
            ("key", Value::from(key)),
            ("blob_id", Value::Text(name)),
            ("expiration", Value::Null),
            ("metadata", Value::Null),
        ],
        When::New,
    )?;
    Ok(())
}

/// Point `key` at `bytes`, replacing what it held: the one versioned value its one publisher keeps
/// (`service-record:{label}`, src/local_account/service_records.rs), never a credential. The blob is durable before
/// the pointer changes in the caller's transaction; the blob the old pointer named is kept as it is (immutable,
/// content-addressed, possibly shared). Whether to replace is the publisher's decision, made on what it read.
pub(crate) fn replace_public(store: &dyn Storage, blobs: &Path, key: &str, bytes: &[u8]) -> Result<()> {
    if key.is_empty() || key.len() > 1024 || bytes.is_empty() || bytes.len() > MOST_PUBLISHED {
        return Err(crate::cause!(Error::Invalid));
    }
    let name = keep_blob(blobs, bytes, MOST_PUBLISHED)?;
    store.put(
        "_mf_entries",
        &[
            ("key", Value::from(key)),
            ("blob_id", Value::Text(name)),
            ("expiration", Value::Null),
        ],
        When::Always,
    )?;
    Ok(())
}

/// Write `bytes` as the immutable blob named by their BLAKE3, or find it already there with the same bytes; its name.
fn keep_blob(blobs: &Path, bytes: &[u8], most: usize) -> Result<String> {
    let name = blake3::hash(bytes).to_hex().to_string();
    let path = blobs.join(&name);
    match This::open(OpenOptions::new().write(true).create_new(true), &path,
        Open { no_follow: true, ..Open::owner_only(0o600) })
    {
        Ok(mut file) => {
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            fs::File::open(blobs)
                .and_then(|file| file.sync_all())
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let file = This::open(OpenOptions::new().read(true), &path, Open::NO_FOLLOW)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if !file.metadata().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_file() {
                return Err(crate::cause!(Error::Invalid));
            }
            let mut old = Vec::new();
            file.take(most as u64 + 1)
                .read_to_end(&mut old)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if old != bytes {
                return Err(crate::cause!(Error::Conflict));
            }
        }
        Err(_) => return Err(crate::cause!(Error::Unavailable)),
    }
    Ok(name)
}
