//! Giving back the storage of files deleted for good: the port of old trillion's byte release (the store's part,
//! `byteReleaseStore`, ports/account-files-byte-release.json) and of its files module's `releaseGoneBytes` (the part
//! that removes objects), into the account files' own records.
//!
//! A set-aside name forgotten for good (`names.rs` `forget_set_aside`, the old Recently Deleted sweep's `onGone`)
//! notes its file here (`note_gone`). A page of noted files (`queue_release`) turns each file nothing holds any more
//! into release rows, one per stored object (the file's own object, or each chunk no other file uses), and forgets the
//! file's records at once. `release_gone_bytes` then claims those rows a page at a time, removes each object from the
//! store that keeps it (`Objects::delete`) and reports it released. What was released, how big and when, stays
//! readable (`list_released`).
//!
//! Non-negotiable invariants (old :12-25):
//! 1. Only a file whose set-aside name was forgotten for good is ever a candidate. A file with no name is not one by
//!    itself: some files are held by identity on purpose.
//! 2. A file stays while anything names it by any of its identities: a live name (its file record's `names`), a
//!    name still set aside (its file record's `set_aside`, `Tree::listed_in`), or a move off its store in progress
//!    (its store takes no new bytes while `moves.rs` empties it).
//! 3. A chunk is released only when no other file, finished or still uploading, uses it: the chunk record names the
//!    one upload that first kept it (`used_by`) until a second user marks it `shared` (`write.rs`). A chunk with no
//!    `used_by` (migrated from the hosted Worker, whose span table this store does not have) is never released here.
//!    A whole-file object that a chunk record also names (a piece identical to the whole file) stays.
//! 4. Object keys are made from the content, so a later upload of the same bytes writes the same key. A release row
//!    not claimed yet is cancelled when an upload records that origin and key; bytes written while a release was
//!    claimed, or finished after the write began, are refused (`may_record`), and the sender sends them again. No kept
//!    record ever points at removed bytes.
//! 5. Reads lists of changes (the noted files and the release rows), never every file.
//!
//! Records (account = the person's account):
//! - `@account-files/release/noted` id = file identity, kind `files-release-noted`: `noted_at` (the old candidates
//!   table).
//! - `@account-files/release/waiting` id = `row_id(origin, key)`, kind `files-release-key`: origin, key, byte_length,
//!   identity, queued_at, claimed_at (the old release keys table's rows whose `released_at` is null).
//! - `@account-files/release/done` the same id, kind `files-released`: the row as it was, with `released_at` (old
//!   released rows, kept as the record of storage given back).
//!
//! Dropped from the old file, by the rules: its SQLite table creation and the key-only queue's rebuild (record store
//! scopes replace tables); the shared origin room pool (`releaseOriginRoomOnce`, central shared storage); the daily
//! pass armed per person (an always-on default: a caller, a tool or the person, asks for a pass); `byDay`
//! and the release rules' screen DATA (a feature, the storage screen's).

use super::{
    settings::{settings, word},
    text, AccountFiles, AccountFilesError, Answer, ALIASES, CHUNKS, FILES, RELEASED_KIND, RELEASE_DONE, RELEASE_KEY_KIND,
    RELEASE_NOTED, RELEASE_NOTED_KIND, RELEASE_WAITING, SPANS, LIVE, SET_ASIDE,
};
use crate::{
    records::{Mutation, Record, Records, MAX_PAGE_ITEMS},
    storage::Storage,
};
use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{collections::BTreeSet, time::Instant};

/// The id of one stored object's release row: the BLAKE3 of its origin and key, so the same object at the same store
/// always has one row (old `PRIMARY KEY(origin,key)`, :31).
pub fn row_id(origin: &str, key: &str) -> String {
    blake3::hash(format!("{origin}\0{key}").as_bytes()).to_hex().to_string()
}

/// A content identity this store keeps files under: `1f:` or `12:` and 64 lowercase hex.
pub fn is_identity(identity: &str) -> bool {
    (identity.starts_with("1f:") || identity.starts_with("12:"))
        && identity.len() == 67
        && identity[3..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// One stored object to remove.
pub(super) struct Gone {
    origin: String,
    key: String,
    byte_length: u64,
    identity: String,
}

impl<S: Storage + Send> AccountFiles<S> {
    /// One change's request key: what it does, to which record, at which of its versions and when, so a retry of the
    /// same change is answered by its first write and a later change of the same record is never taken for it.
    fn request(&self, what: &str, id: &str, version: i64, at: u64) -> String {
        blake3::hash(format!("{what}\0{id}\0{version}\0{at}").as_bytes()).to_hex().to_string()
    }

    /// Remove the record `id` of `scope` when it is there (a tombstone at its version).
    fn forget(&mut self, scope: &str, id: &str, what: &str, at: u64) -> Answer<()> {
        if let Some(held) = self.get(scope, id)? {
            let request = self.request(what, id, held.version, at);
            self.mutate(scope, Mutation { id: id.to_owned(), expected_version: held.version, request_key: request, deleted: true, value: Value::Null })?;
        }
        Ok(())
    }

    /// Every identity of the same file: itself, the one it is an alias of, and that one's aliases
    /// (old :84 `familyOf`). The first is the file record's identity when there is one.
    pub(super) fn family_of(&self, identity: &str) -> Answer<(Vec<String>, Option<Record>)> {
        let mut family = vec![identity.to_owned()];
        let canonical = match self.get(FILES, identity)? {
            Some(_) => identity.to_owned(),
            None => self.get(ALIASES, identity)?.and_then(|alias| text(&alias.value, "identity").map(str::to_owned)).unwrap_or_else(|| identity.to_owned()),
        };
        let file = self.get(FILES, &canonical)?;
        if !family.contains(&canonical) {
            family.insert(0, canonical);
        }
        if let Some(aliases) = file.as_ref().and_then(|file| file.value.get("aliases")).and_then(Value::as_array) {
            for alias in aliases {
                let alias = alias.as_str().or_else(|| text(alias, "alias"));
                if let Some(alias) = alias.filter(|alias| !family.iter().any(|known| known == alias)) {
                    family.push(alias.to_owned());
                }
            }
        }
        Ok((family, file))
    }

    /// `note_gone`: files whose set-aside names were just forgotten for good (old `noteGone`). A file already noted
    /// keeps its first time.
    pub fn note_gone(&mut self, identities: &[&str]) -> Answer<Value> {
        if identities.iter().any(|identity| !is_identity(identity)) {
            return Err(AccountFilesError::Invalid(word("release_identities"), crate::cause!()));
        }
        let at = self.now_ms();
        let mut noted = 0;
        for identity in identities.iter().collect::<BTreeSet<_>>() {
            let (version, held) = self.held(RELEASE_NOTED, identity)?;
            if held.is_some() {
                continue;
            }
            let value = json!({ "kind": RELEASE_NOTED_KIND, "identity": identity, "noted_at": at });
            let request = self.request("noted", identity, version, at);
            self.mutate(RELEASE_NOTED, Mutation { id: (*identity).to_owned(), expected_version: version, request_key: request, deleted: false, value })?;
            noted += 1;
        }
        Ok(json!({ "noted": noted }))
    }

    /// Whether a file, by any of its identities, is a final deletion awaiting release (old `gone`).
    pub fn release_noted(&self, identity: &str) -> Answer<bool> {
        let (family, _) = self.family_of(identity)?;
        let ids: Vec<&str> = family.iter().map(String::as_str).collect();
        Ok(self.store.get_many(&self.account, RELEASE_NOTED, &ids)?.iter().any(Option::is_some))
    }

    /// Whether anything is left to do: a noted file, or an object not removed yet (old `pending`).
    pub fn release_pending(&self) -> Answer<bool> {
        Ok(!self.store.list_page(&self.account, RELEASE_NOTED, "", 1)?.items.is_empty()
            || !self.store.list_page(&self.account, RELEASE_WAITING, "", 1)?.items.is_empty())
    }

    /// Whether anything still holds the file `file` (invariant 2): a live name, a name set aside, or its bytes on a
    /// store being emptied into another.
    fn held_file(&self, file: &Record, draining: &BTreeSet<String>) -> bool {
        let listed = |field: &str| file.value.get(field).and_then(Value::as_array).is_some_and(|names| !names.is_empty());
        listed(LIVE.listed_in) || listed(SET_ASIDE.listed_in) || text(&file.value, "origin").is_some_and(|origin| draining.contains(origin))
    }

    /// The stores being emptied into another: they take no new bytes while a move carries what they hold
    /// (`moves.rs`, the old moves table).
    fn draining(&self) -> Answer<BTreeSet<String>> {
        Ok(self.origins()?.into_iter().filter(|(_, origin)| !origin.takes_new_bytes).map(|(id, _)| id).collect())
    }

    /// `queue_release`: one page of noted files; each nothing holds becomes release rows and its own records are
    /// forgotten (old `queue`, :116-139). Answers the files released, kept (held) and
    /// the objects queued, the chunks kept because they are shared or their users are not known, and whether more
    /// noted files wait.
    pub fn queue_release(&mut self, limit: Option<usize>) -> Answer<Value> {
        let limit = limit.unwrap_or(settings().release.candidates_per_page);
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(AccountFilesError::Invalid(word("release_limit"), crate::cause!()));
        }
        let at = self.now_ms();
        let draining = self.draining()?;
        let page = self.store.list_page(&self.account, RELEASE_NOTED, "", limit)?;
        let (mut files, mut kept, mut keys, mut kept_chunks) = (0u64, 0u64, 0u64, 0u64);
        for noted in page.items {
            self.check_current()?;
            let identity = noted.id.clone();
            let (family, file) = self.family_of(&identity)?;
            if file.as_ref().is_some_and(|file| self.held_file(file, &draining)) {
                self.forget(RELEASE_NOTED, &identity, "kept", at)?;
                kept += 1;
                continue;
            }
            if let Some(file) = file {
                let (gone, shared) = self.objects_of(&file, &draining)?;
                kept_chunks += shared;
                for object in &gone {
                    self.queue_key(object, at)?;
                    keys += 1;
                }
                // The file's own records go at once, its chunks first, so a later upload of the same bytes keeps them
                // anew (and asks `may_record`) instead of naming bytes on their way out.
                for object in gone.iter().filter(|object| object.identity != file.id) {
                    self.forget(CHUNKS, &object.identity, "chunk", at)?;
                }
                for page in super::paged_spans::page_ids(&file) {
                    self.forget(SPANS, &page, "spans", at)?;
                }
                self.forget(FILES, &file.id, "file", at)?;
                files += 1;
            }
            for alias in family.iter().filter(|alias| alias.starts_with("12:")) {
                self.forget(ALIASES, alias, "alias", at)?;
            }
            // The note goes last: a stop before this leaves it noted, and the next page finishes it.
            self.forget(RELEASE_NOTED, &identity, "queued", at)?;
        }
        let more = !self.store.list_page(&self.account, RELEASE_NOTED, "", 1)?.items.is_empty();
        Ok(json!({ "files": files, "kept": kept, "keys": keys, "kept_chunks": kept_chunks, "more": more }))
    }

    /// The stored objects that leave with `file`: its whole-file object (unless a chunk record names the same bytes),
    /// or each chunk only this file used (old :126-133). Also how many chunks stay
    /// because another user may need them, or a move off their store is in progress.
    pub(super) fn objects_of(&self, file: &Record, draining: &BTreeSet<String>) -> Answer<(Vec<Gone>, u64)> {
        let spans = file.value.get("spans").and_then(Value::as_u64).unwrap_or(0);
        if spans == 0 {
            let (Some(origin), Some(key)) = (text(&file.value, "origin"), text(&file.value, "key").filter(|key| !key.is_empty())) else {
                return Ok((Vec::new(), 0));
            };
            // A piece identical to the whole file reuses its object (`write.rs` keep_chunk): that chunk holds it.
            if self.get(CHUNKS, &file.id)?.is_some_and(|chunk| text(&chunk.value, "key") == Some(key) && text(&chunk.value, "origin") == Some(origin)) {
                return Ok((Vec::new(), 1));
            }
            let byte_length = file.value.get("byte_length").and_then(Value::as_u64).unwrap_or(0);
            return Ok((vec![Gone { origin: origin.to_owned(), key: key.to_owned(), byte_length, identity: file.id.clone() }], 0));
        }
        // The chunks this file's spans name, each once.
        let user = text(&file.value, "span_set").unwrap_or(&file.id).to_owned();
        let mut chunks = BTreeSet::new();
        for page in super::paged_spans::page_ids(file) {
            let Some(record) = self.get(SPANS, &page)? else { continue };
            for span in record.value.get("spans").and_then(Value::as_array).into_iter().flatten() {
                if let Some(chunk) = text(span, "chunk") {
                    chunks.insert(chunk.to_owned());
                }
            }
        }
        let chunks: Vec<String> = chunks.into_iter().collect();
        let (mut gone, mut shared) = (Vec::new(), 0u64);
        for batch in chunks.chunks(MAX_PAGE_ITEMS) {
            let ids: Vec<&str> = batch.iter().map(String::as_str).collect();
            for (id, chunk) in ids.iter().zip(self.store.get_many(&self.account, CHUNKS, &ids)?) {
                let Some(chunk) = chunk else { continue };
                let only_this = text(&chunk.value, "used_by") == Some(user.as_str())
                    && chunk.value.get("shared").and_then(Value::as_bool) != Some(true)
                    && !text(&chunk.value, "origin").is_some_and(|origin| draining.contains(origin));
                match (only_this, text(&chunk.value, "origin"), text(&chunk.value, "key")) {
                    (true, Some(origin), Some(key)) => gone.push(Gone {
                        origin: origin.to_owned(),
                        key: key.to_owned(),
                        byte_length: chunk.value.get("byte_length").and_then(Value::as_u64).unwrap_or(0),
                        identity: (*id).to_owned(),
                    }),
                    _ => shared += 1,
                }
            }
        }
        Ok((gone, shared))
    }

    /// One release row, waiting and unclaimed (old `queueKey`: a row already there is queued again).
    fn queue_key(&mut self, object: &Gone, at: u64) -> Answer<()> {
        let id = row_id(&object.origin, &object.key);
        let (version, _) = self.held(RELEASE_WAITING, &id)?;
        let value = json!({
            "kind": RELEASE_KEY_KIND, "origin": object.origin, "key": object.key, "byte_length": object.byte_length,
            "identity": object.identity, "queued_at": at, "claimed_at": null,
        });
        let request = self.request("queue", &id, version, at);
        self.mutate(RELEASE_WAITING, Mutation { id, expected_version: version, request_key: request, deleted: false, value })?;
        Ok(())
    }

    /// `claim_release`: a page of objects to remove now, marked claimed; a claim that never reported back is claimed
    /// again after `claim_stale_minutes` (old `claim`). The rows are read in id order, not queued order: a scope walk
    /// has no second order, and every waiting row is reached all the same.
    pub fn claim_release(&mut self, limit: Option<usize>) -> Answer<Vec<Value>> {
        let release = &settings().release;
        let limit = limit.unwrap_or(release.keys_per_page);
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(AccountFilesError::Invalid(word("release_limit"), crate::cause!()));
        }
        let at = self.now_ms();
        let stale = at.saturating_sub(release.claim_stale_minutes * 60_000);
        let page = self.store.list_page(&self.account, RELEASE_WAITING, "", release.claim_walk)?;
        let mut claimed = Vec::new();
        for row in page.items {
            if claimed.len() == limit {
                break;
            }
            if row.value.get("claimed_at").and_then(Value::as_u64).is_some_and(|claimed_at| claimed_at >= stale) {
                continue;
            }
            self.check_current()?;
            let mut value = row.value.clone();
            value["claimed_at"] = json!(at);
            let request = self.request("claim", &row.id, row.version, at);
            self.mutate(RELEASE_WAITING, Mutation { id: row.id.clone(), expected_version: row.version, request_key: request, deleted: false, value: value.clone() })?;
            claimed.push(value);
        }
        Ok(claimed)
    }

    /// `released`: these objects are removed from where they were kept (old `released`). Each needs one exact origin
    /// and key; a row not claimed (cancelled by an upload, or never queued) is left as it is.
    pub fn released(&mut self, objects: &[(String, String)]) -> Answer<Value> {
        if objects.iter().any(|(origin, key)| origin.is_empty() || key.is_empty()) {
            return Err(AccountFilesError::Invalid(word("release_ack"), crate::cause!()));
        }
        let at = self.now_ms();
        let mut released = 0;
        for (origin, key) in objects {
            let id = row_id(origin, key);
            let Some(row) = self.get(RELEASE_WAITING, &id)? else { continue };
            if row.value.get("claimed_at").and_then(Value::as_u64).is_none() {
                continue;
            }
            let mut value = row.value.clone();
            value["kind"] = json!(RELEASED_KIND);
            value["released_at"] = json!(at);
            let (version, _) = self.held(RELEASE_DONE, &id)?;
            self.mutate(RELEASE_DONE, Mutation { id: id.clone(), expected_version: version, request_key: self.request("done", &id, version, at), deleted: false, value })?;
            self.mutate(RELEASE_WAITING, Mutation { id: id.clone(), expected_version: row.version, request_key: self.request("left", &id, row.version, at), deleted: true, value: Value::Null })?;
            released += 1;
        }
        Ok(json!({ "released": released }))
    }

    /// Whether bytes written at `origin` and `key` (the write began at `started_ms`) may be recorded as held
    /// (old `mayRecord`, :170-183). A release of that object not claimed yet is
    /// cancelled: the bytes are wanted again. A release claimed and not finished, or finished after the write began
    /// (less `recorded_margin_seconds`), may have removed them: they are sent again.
    pub(super) fn may_record(&mut self, origin: &str, key: &str, started_ms: u64) -> Answer<bool> {
        if origin.is_empty() {
            return Ok(false);
        }
        let id = row_id(origin, key);
        if let Some(row) = self.get(RELEASE_WAITING, &id)? {
            if row.value.get("claimed_at").and_then(Value::as_u64).is_some() {
                return Ok(false);
            }
            let at = self.now_ms();
            self.mutate(RELEASE_WAITING, Mutation { id: id.clone(), expected_version: row.version, request_key: self.request("wanted", &id, row.version, at), deleted: true, value: Value::Null })?;
            return Ok(true);
        }
        let margin = settings().release.recorded_margin_seconds * 1000;
        Ok(match self.get(RELEASE_DONE, &id)?.and_then(|row| row.value.get("released_at").and_then(Value::as_u64)) {
            Some(released_at) => released_at < started_ms.saturating_sub(margin),
            None => true,
        })
    }

    /// The refusal of bytes that raced a release: the sender sends them again.
    pub(super) fn record_or_again(&mut self, origin: &str, key: &str, started_ms: u64) -> Answer<()> {
        if self.may_record(origin, key, started_ms)? {
            Ok(())
        } else {
            Err(AccountFilesError::Invalid(word("release_again"), crate::cause!()))
        }
    }

    /// `release_gone_bytes`: the claimed objects removed a page at a time until the call's time ends (the old
    /// files module's `releaseGoneBytes`): each is removed from the store that keeps it and reported
    /// released. An object that cannot be removed now stays claimed and is tried again when its claim goes stale.
    /// Answers how many objects and bytes were released and whether more wait.
    pub fn release_gone_bytes(&mut self, limit: Option<usize>) -> Answer<Value> {
        let (mut released, mut bytes) = (0u64, 0u64);
        loop {
            if self.until.is_some_and(|until| Instant::now() >= until) {
                return Ok(json!({ "released": released, "bytes": bytes, "more": true }));
            }
            let page = self.claim_release(limit)?;
            if page.is_empty() {
                return Ok(json!({ "released": released, "bytes": bytes, "more": self.release_pending()? }));
            }
            let mut done = Vec::new();
            let mut failed = None;
            for row in &page {
                let (Some(origin), Some(key)) = (text(row, "origin"), text(row, "key")) else { continue };
                self.check_current()?;
                match self.objects.delete(origin, key) {
                    Ok(()) => {
                        done.push((origin.to_owned(), key.to_owned()));
                        bytes += row.get("byte_length").and_then(Value::as_u64).unwrap_or(0);
                    }
                    Err(error) => failed = Some(error.to_string()),
                }
            }
            released += done.len() as u64;
            self.released(&done)?;
            if let Some(failed) = failed {
                return Ok(json!({ "released": released, "bytes": bytes, "more": true, "failed": failed }));
            }
        }
    }

    /// `list_released`: one page of the objects given back, in id order, each with its origin, key, size, the file
    /// it belonged to and when it was queued, claimed and released.
    pub fn list_released(&self, after: Option<&str>, limit: Option<usize>) -> Answer<Value> {
        let limit = limit.unwrap_or(settings().release.keys_per_page);
        if !(1..=MAX_PAGE_ITEMS).contains(&limit) {
            return Err(AccountFilesError::Invalid(word("release_limit"), crate::cause!()));
        }
        let page = self.store.list_page(&self.account, RELEASE_DONE, after.unwrap_or(""), limit)?;
        let rows: Vec<Value> = page.items.into_iter().map(|row| row.value).collect();
        Ok(json!({ "released": rows, "next_after": page.next, "pending": self.release_pending()? }))
    }
}
