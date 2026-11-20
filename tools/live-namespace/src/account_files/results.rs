//! What has been worked out about one file, kept next to the file in the person's own files: the port of old trillion's
//! results module (`resultsStore` and `handleResultsApi`, ports/account-files-results.json) into the account files' records.
//!
//! A recording's transcript, its summary, the facts measured from it: each is a result, keyed by the file's content
//! identity (`1f:` BLAKE3, or an alias such as the `12:` SHA-256 a drive store files it under) and a kind. The kind is
//! DATA the producer names (`transcript`, `summary`, `facts`, anything a later tool makes); nothing here lists kinds.
//! A result is written once and read by any AI or app the person lets in, so the work is never repeated for the same
//! bytes (old :1-7).
//!
//! Invariants (old :23-34):
//! - A person reads and writes only their own results: the records are in their own account files.
//! - Writing the same value again changes nothing, so copying existing work is safe to repeat.
//! - A read by any identity of a file also finds results recorded under its other identities (`family_of`: the file
//!   record and its aliases).
//! - No value is larger than `max_value_bytes`, and no page carries more than `page_bytes` of values.
//! - A merge changes the one result the file already has under any of its identities (never a second copy under
//!   another), written against the version it read, so two writers of different fields never undo each other: the
//!   second is refused with a conflict and merges again on what the first wrote.
//!
//! Records (account = the person's account):
//! - `@account-files/results/<identity>` id = the result's kind, kind `files-result`: the value as JSON, its value
//!   identity (BLAKE3 of the value's JSON text), produced_by and recorded_at (the old results table's rows).
//! - `@account-files/result-kinds/<kind>` id = identity, kind `files-result-index`: the value identity and size, so one
//!   kind across every file is one walk in identity order (the old index by kind).
//! - `@account-files/result-counts` id = the kind, kind `files-result-count`: how many results of that kind are kept,
//!   moved in the same call as the write (the old counts table).
//!
//! Dropped from the old file, by the rules: its tables, indexes and the search triggers and feed (the record store and
//! its own word index replace them; search is a tool's work); the timeline and `resultsWaiting` (the awareness
//! reading's feature), `arrivedFrom` (the organization feature's kind) and `carry` (the side-files feature); the slice
//! by slice streaming of a value out of a Durable Object's memory (a record store record is read whole and is at most
//! `max_value_bytes`), and `countStep`'s chunked recount (counts are kept from the first write here).

use super::{
    settings::{settings, word},
    text, now_iso, AccountFiles, AccountFilesError, Answer, RESULTS, RESULTS_BY_KIND, RESULT_COUNTS, RESULT_COUNT_KIND,
    RESULT_INDEX_KIND, RESULT_KIND,
};
use crate::{
    store::{Mutation, Record, MAX_PAGE_ITEMS},
    refusal_cause::{Cause, CodedError},
};
use content_crypto::advanced::blake3;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// A result kind: lowercase letters, digits and hyphens, a letter first, at most 64 (old `KIND`).
pub fn is_kind(kind: &str) -> bool {
    let bytes = kind.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// A field one fields read names: lowercase letters, digits and underscores, a letter first, at most 64.
fn is_field(field: &str) -> bool {
    let bytes = field.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn results_scope(identity: &str) -> String {
    format!("{RESULTS}{identity}")
}
fn kind_scope(kind: &str) -> String {
    format!("{RESULTS_BY_KIND}{kind}")
}
fn value_identity(json: &str) -> String {
    format!("1f:{}", blake3::hash(json.as_bytes()).to_hex())
}

/// The reads each caller has open now (old :227-242 `admitted`): a read past
/// `reads_at_once_per_caller` is answered busy instead of queued; a read that never finishes stops counting after
/// `read_counts_for_ms`. One per process, keyed by the account and the caller the read names.
fn open_reads() -> &'static Mutex<HashMap<String, Vec<(u64, Instant)>>> {
    static OPEN: OnceLock<Mutex<HashMap<String, Vec<(u64, Instant)>>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One open read: it stops counting when dropped.
pub struct OpenRead {
    key: String,
    id: u64,
}
impl Drop for OpenRead {
    fn drop(&mut self) {
        if let Ok(mut open) = open_reads().lock() {
            if let Some(reads) = open.get_mut(&self.key) {
                reads.retain(|(id, _)| *id != self.id);
                if reads.is_empty() {
                    open.remove(&self.key);
                }
            }
        }
    }
}

/// Admit one read of `caller` in `account`, or None when it already has its most reads open.
pub fn admit_read(account: &str, caller: Option<&str>) -> Option<OpenRead> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let results = &settings().results;
    let caller: String = caller.filter(|caller| !caller.is_empty()).unwrap_or("someone").chars().take(120).collect();
    let key = format!("{account}\0{caller}");
    let mut open = open_reads().lock().ok()?;
    let reads = open.entry(key.clone()).or_default();
    let lasting = Duration::from_millis(results.read_counts_for_ms);
    reads.retain(|(_, at)| at.elapsed() < lasting);
    if reads.len() >= results.reads_at_once_per_caller {
        return None;
    }
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    reads.push((id, Instant::now()));
    Some(OpenRead { key, id })
}

impl AccountFiles {
    /// One change's request key: what, which result, which value, at which version of its record and when.
    fn result_request(&self, what: &str, identity: &str, kind: &str, value_identity: &str, version: i64) -> String {
        blake3::hash(format!("{what}\0{identity}\0{kind}\0{value_identity}\0{version}\0{}", self.now_ms()).as_bytes()).to_hex().to_string()
    }

    /// Every identity a file is known by here (old `sameFile`, the store's `identitiesOf`).
    fn same_file(&self, identity: &str) -> Answer<Vec<String>> {
        Ok(self.family_of(identity)?.0)
    }

    /// The newest result of each kind a file has under any of its identities (of one kind, given `kind`)
    /// (old `newestOf`).
    pub(super) fn newest_of(&self, identity: &str, kind: Option<&str>) -> Answer<Vec<Record>> {
        let mut newest: Vec<Record> = Vec::new();
        for known in self.same_file(identity)? {
            let found = match kind {
                Some(kind) => self.get(&results_scope(&known), kind)?.into_iter().collect::<Vec<_>>(),
                None => self.store.list_page(&results_scope(&known), "", MAX_PAGE_ITEMS)?.items,
            };
            for record in found {
                match newest.iter_mut().find(|kept| kept.id == record.id) {
                    Some(kept) if text(&kept.value, "recorded_at") < text(&record.value, "recorded_at") => *kept = record,
                    Some(_) => {}
                    None => newest.push(record),
                }
            }
        }
        newest.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(newest)
    }

    /// A result as the operations answer it: its fields and its value.
    fn shown(record: &Record) -> Value {
        json!({
            "identity": record.value.get("identity"), "kind": record.id, "produced_by": record.value.get("produced_by"),
            "recorded_at": record.value.get("recorded_at"), "value": record.value.get("value"),
        })
    }

    /// Move the count of `kind` by `by` (old `counting`).
    fn count_result(&mut self, kind: &str, by: i64, request: &str) -> Answer<()> {
        let (version, held) = self.held(RESULT_COUNTS, kind)?;
        let n = held.as_ref().and_then(|record| record.value.get("n")).and_then(Value::as_i64).unwrap_or(0) + by;
        let change = if n <= 0 {
            if held.is_none() {
                return Ok(());
            }
            Mutation { id: kind.to_owned(), expected_version: version, request_key: request.to_owned(), deleted: true, value: Value::Null }
        } else {
            let value = json!({ "kind": RESULT_COUNT_KIND, "result_kind": kind, "n": n });
            Mutation { id: kind.to_owned(), expected_version: version, request_key: request.to_owned(), deleted: false, value }
        };
        self.mutate(RESULT_COUNTS, change)?;
        Ok(())
    }

    /// `record_file_results`: keep results (old `put`, :284-315). Each is
    /// `{identity, kind, value, produced_by?, only_if_absent?}`; a refused item names its index and why, and the others
    /// are kept. Answers how many were recorded, how many were already kept as they are, and the refused.
    pub fn record_file_results(&mut self, items: &[Value]) -> Answer<Value> {
        let limits = &settings().results;
        if items.len() > limits.max_write {
            return Err(AccountFilesError::Invalid(word("result_write_list"), crate::cause!()));
        }
        let (mut recorded, mut unchanged) = (0u64, 0u64);
        let mut refused = Vec::new();
        for (index, item) in items.iter().enumerate() {
            match self.put_result(item, None)? {
                Ok(true) => recorded += 1,
                Ok(false) => unchanged += 1,
                Err(reason) => refused.push(json!({ "index": index, "reason": reason.code, "cause": reason.cause().id() })),
            }
        }
        Ok(json!({ "recorded": recorded, "unchanged": unchanged, "refused": refused }))
    }

    /// Keep one result: Ok(true) when written, Ok(false) when the same value was already kept, Err(why) when refused.
    /// `expected` is the version a merge read; a plain write uses the version it reads here.
    fn put_result(&mut self, item: &Value, expected: Option<i64>) -> Answer<Result<bool, CodedError<&'static str>>> {
        let limits = &settings().results;
        let identity = text(item, "identity").unwrap_or_default();
        let kind = text(item, "kind").unwrap_or_default();
        if !super::release::is_identity(identity) {
            return Ok(Err(CodedError::new(word("result_identity"))));
        }
        if !is_kind(kind) {
            return Ok(Err(CodedError::new(word("result_kind"))));
        }
        let Some(value) = item.get("value") else { return Ok(Err(CodedError::new(word("result_value_missing")))) };
        let kept = serde_json::to_string(value).map_err(|_| AccountFilesError::Invalid(word("result_value_missing"), crate::cause!()))?;
        if kept.len() > limits.max_value_bytes {
            return Ok(Err(CodedError::new(word("result_value_large"))));
        }
        let only_if_absent = match item.get("only_if_absent") {
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return Ok(Err(CodedError::new(word("result_only_if_absent")))),
        };
        let identity_of_value = value_identity(&kept);
        // The decision is made at this write's own read of the result; alias identities name the same immutable
        // bytes and cannot evade it.
        let current = if only_if_absent { self.newest_of(identity, Some(kind))?.into_iter().next() } else { self.get(&results_scope(identity), kind)? };
        if current.as_ref().and_then(|current| text(&current.value, "value_identity")) == Some(identity_of_value.as_str()) {
            return Ok(Ok(false));
        }
        if current.is_some() && only_if_absent {
            return Ok(Err(CodedError::new(word("result_already"))));
        }
        let produced_by = text(item, "produced_by").map(|by| by.chars().take(limits.produced_by_chars).collect::<String>());
        let scope = results_scope(identity);
        let (held_version, exact) = self.held(&scope, kind)?;
        // A merge writes against the version it read, so a write between its read and this one is a conflict.
        let version = expected.unwrap_or(held_version);
        let request = self.result_request("put", identity, kind, &identity_of_value, version);
        let record = json!({
            "kind": RESULT_KIND, "identity": identity, "value": value, "produced_by": produced_by,
            "value_identity": identity_of_value, "value_bytes": kept.len(), "recorded_at": now_iso(),
        });
        self.mutate(&scope, Mutation { id: kind.to_owned(), expected_version: version, request_key: request.clone(), deleted: false, value: record })?;
        let index = json!({ "kind": RESULT_INDEX_KIND, "result_kind": kind, "value_identity": identity_of_value, "value_bytes": kept.len() });
        let (index_version, _) = self.held(&kind_scope(kind), identity)?;
        self.mutate(&kind_scope(kind), Mutation { id: identity.to_owned(), expected_version: index_version, request_key: format!("{request}:index"), deleted: false, value: index })?;
        if exact.is_none() {
            self.count_result(kind, 1, &format!("{request}:count"))?;
        }
        Ok(Ok(true))
    }

    /// `read_file_results`: every result of a file, the newest of each kind under any of its identities (of one kind,
    /// given `kind`) (old `readBody`).
    pub fn read_file_results(&self, identity: &str, kind: Option<&str>, caller: Option<&str>) -> Answer<Value> {
        if !super::release::is_identity(identity) {
            return Err(AccountFilesError::Invalid(word("result_identity"), crate::cause!()));
        }
        if kind.is_some_and(|kind| !is_kind(kind)) {
            return Err(AccountFilesError::Invalid(word("result_kind"), crate::cause!()));
        }
        let Some(_open) = admit_read(&self.account, caller) else { return Ok(busy(crate::cause!(caller_site: result_read_not_admitted))) };
        let identities = self.same_file(identity)?;
        let results: Vec<Value> = self.newest_of(identity, kind)?.iter().map(Self::shown).collect();
        Ok(json!({ "identity": identity, "identities": identities, "results": results }))
    }

    /// `read_file_result_fields`: only the named fields of a file's result of one kind, each null when it is not
    /// there (old `readFieldsBody`): a shared consumer gets only the fields its owner admits.
    pub fn read_file_result_fields(&self, identity: &str, kind: &str, fields: &[&str], caller: Option<&str>) -> Answer<Value> {
        if !super::release::is_identity(identity) {
            return Err(AccountFilesError::Invalid(word("result_identity"), crate::cause!()));
        }
        if !is_kind(kind) || fields.is_empty() || fields.len() > settings().results.fields_most || !fields.iter().all(|field| is_field(field)) {
            return Err(AccountFilesError::Invalid(word("result_fields"), crate::cause!()));
        }
        let Some(_open) = admit_read(&self.account, caller) else { return Ok(busy(crate::cause!(caller_site: result_read_not_admitted))) };
        let held = self.newest_of(identity, Some(kind))?.into_iter().next();
        let value = held.as_ref().and_then(|record| record.value.get("value"));
        let mut selected = Map::new();
        for field in fields {
            selected.insert((*field).to_owned(), value.and_then(|value| value.get(*field)).cloned().unwrap_or(Value::Null));
        }
        Ok(Value::Object(selected))
    }

    /// `list_file_results`: one kind across every file, in identity order: at most `limit` results and `page_bytes`
    /// of values a page (old `listBody`); `kind` absent answers how many results of each kind are kept (old `counts`).
    pub fn list_file_results(&self, kind: Option<&str>, after: Option<&str>, limit: Option<usize>, caller: Option<&str>) -> Answer<Value> {
        let limits = &settings().results;
        let Some(kind) = kind else {
            let page = self.store.list_page(RESULT_COUNTS, "", MAX_PAGE_ITEMS)?;
            let kinds: Map<String, Value> = page.items.into_iter().map(|record| (record.id, record.value.get("n").cloned().unwrap_or(json!(0)))).collect();
            return Ok(json!({ "kinds": kinds }));
        };
        if !is_kind(kind) {
            return Err(AccountFilesError::Invalid(word("result_kind"), crate::cause!()));
        }
        let limit = limit.filter(|limit| *limit > 0).unwrap_or(limits.default_page_limit).min(limits.max_page_limit);
        let Some(_open) = admit_read(&self.account, caller) else { return Ok(busy(crate::cause!(caller_site: result_read_not_admitted))) };
        let page = self.store.list_page(&kind_scope(kind), after.unwrap_or(""), limit)?;
        let mut results = Vec::new();
        let mut bytes = 0usize;
        let mut cut = false;
        for index in &page.items {
            let size = index.value.get("value_bytes").and_then(Value::as_u64).unwrap_or(0) as usize;
            if !results.is_empty() && bytes + size > limits.page_bytes {
                cut = true;
                break;
            }
            let Some(record) = self.get(&results_scope(&index.id), kind)? else { continue };
            bytes += size;
            let mut shown = Self::shown(&record);
            shown["identity"] = json!(index.id);
            results.push(shown);
        }
        let next_after = if cut || page.next.is_some() { results.last().and_then(|row| row["identity"].as_str()).map(str::to_owned) } else { None };
        Ok(json!({ "kind": kind, "results": results, "next_after": next_after }))
    }

    /// `read_file_results_many`: one kind's value for each of several files, by any of their identities:
    /// `{identity asked: value}` (old `manyBody`). An identity with no result, or not an identity, is left out.
    pub fn read_file_results_many(&self, identities: &[&str], kind: &str, caller: Option<&str>) -> Answer<Value> {
        if identities.len() > settings().results.max_many || !is_kind(kind) {
            return Err(AccountFilesError::Invalid(word("result_many"), crate::cause!()));
        }
        let Some(_open) = admit_read(&self.account, caller) else { return Ok(busy(crate::cause!(caller_site: result_read_not_admitted))) };
        let mut found = Map::new();
        for identity in identities.iter().filter(|identity| super::release::is_identity(identity)) {
            if let Some(record) = self.newest_of(identity, Some(kind))?.into_iter().next() {
                found.insert((*identity).to_owned(), record.value.get("value").cloned().unwrap_or(Value::Null));
            }
        }
        Ok(json!({ "kind": kind, "results": found }))
    }

    /// `merge_file_result`: change only the fields `patch` names in the file's result of `kind`, kept under whichever
    /// of the file's identities already holds it; null takes a field away; `only_if_empty` fills only fields that are
    /// empty now (old `merge`, :421-437).
    pub fn merge_file_result(&mut self, identity: &str, kind: &str, patch: &Value, produced_by: Option<&str>, only_if_empty: bool) -> Answer<Value> {
        if !super::release::is_identity(identity) {
            return Err(AccountFilesError::Invalid(word("result_identity"), crate::cause!()));
        }
        if !is_kind(kind) {
            return Err(AccountFilesError::Invalid(word("result_kind"), crate::cause!()));
        }
        let Some(patch) = patch.as_object() else { return Err(AccountFilesError::Invalid(word("result_patch"), crate::cause!())) };
        let held = self.newest_of(identity, Some(kind))?.into_iter().next();
        let kept_under = held.as_ref().and_then(|record| text(&record.value, "identity")).unwrap_or(identity).to_owned();
        let before = held.as_ref().and_then(|record| record.value.get("value")).cloned().unwrap_or_else(|| json!({}));
        let Some(mut value) = before.as_object().cloned() else { return Err(AccountFilesError::Invalid(word("result_not_object"), crate::cause!())) };
        for (field, next) in patch {
            let empty = match value.get(field) {
                None | Some(Value::Null) => true,
                Some(Value::String(text)) => text.is_empty(),
                Some(Value::Array(items)) => items.is_empty(),
                Some(_) => false,
            };
            if only_if_empty && !empty {
                continue;
            }
            if next.is_null() {
                value.remove(field);
            } else {
                value.insert(field.clone(), next.clone());
            }
        }
        let value = Value::Object(value);
        let item = json!({ "identity": kept_under, "kind": kind, "value": value, "produced_by": produced_by });
        let expected = held.as_ref().map(|record| record.version);
        let changed = match self.put_result(&item, expected)? {
            Ok(changed) => changed,
            Err(reason) => return Err(AccountFilesError::Invalid(reason.code, reason.cause())),
        };
        Ok(json!({ "identity": identity, "kept_under": kept_under, "kind": kind, "value": value, "changed": changed }))
    }

    /// `remove_file_result`: forget one kind of result recorded under exactly this identity (old `remove`).
    pub fn remove_file_result(&mut self, identity: &str, kind: &str) -> Answer<Value> {
        if !super::release::is_identity(identity) {
            return Err(AccountFilesError::Invalid(word("result_identity"), crate::cause!()));
        }
        if !is_kind(kind) {
            return Err(AccountFilesError::Invalid(word("result_kind"), crate::cause!()));
        }
        let scope = results_scope(identity);
        let Some(current) = self.get(&scope, kind)? else { return Ok(json!({ "removed": 0 })) };
        let request = self.result_request("remove", identity, kind, text(&current.value, "value_identity").unwrap_or_default(), current.version);
        self.mutate(&scope, Mutation { id: kind.to_owned(), expected_version: current.version, request_key: request.clone(), deleted: true, value: Value::Null })?;
        if let Some(index) = self.get(&kind_scope(kind), identity)? {
            self.mutate(&kind_scope(kind), Mutation { id: identity.to_owned(), expected_version: index.version, request_key: format!("{request}:index"), deleted: true, value: Value::Null })?;
        }
        self.count_result(kind, -1, &format!("{request}:count"))?;
        Ok(json!({ "removed": 1 }))
    }
}

/// The answer to a read past the caller's most open reads (old `answerStream` 429).
fn busy(cause: Cause) -> Value {
    json!({ "busy": true, "error": word("result_busy"), "cause": cause.id(), "retry_after_seconds": 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_fields_are_bounded_lowercase_names() {
        assert!(is_kind("transcript") && is_kind("facts-2"));
        assert!(!is_kind("") && !is_kind("Transcript") && !is_kind("2facts") && !is_kind(&"a".repeat(65)) && !is_kind("a_b"));
        assert!(is_field("original_name") && !is_field("Name") && !is_field("a-b"));
    }

    #[test]
    fn a_caller_has_at_most_its_reads_open_at_once_and_a_finished_read_frees_its_turn() {
        let most = settings().results.reads_at_once_per_caller;
        let open: Vec<OpenRead> = (0..most).map(|_| admit_read("account-reads", Some("app")).unwrap()).collect();
        assert!(admit_read("account-reads", Some("app")).is_none(), "past the most reads, the read is busy");
        assert!(admit_read("account-reads", Some("other app")).is_some(), "another caller is not held back");
        drop(open);
        assert!(admit_read("account-reads", Some("app")).is_some());
    }
}
