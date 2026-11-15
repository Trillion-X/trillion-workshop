// src/account_files/recent.rs
//
// Purpose: The files the person used most recently and how, as account rows in the account's own files store. A behavioral
// port of old trillion src/recent-files.mjs (`recentFilesStore`: `record` and `recent`, its settings
// src/recent-files.json). The rules are this owner's DATA (`recent`); no kind of use or word is listed here. The
// facts kept about each file are not here: old src/file-tools.mjs:135 `set_file_facts` was the results merge of kind
// `facts`, and so it is (`results.rs` `merge_file_result`, the kind DATA `facts.kind`), one owner for every result.
//
// Non-Negotiable Invariants (old src/recent-files.mjs:9-19):
// 1. A use is DATA: {file, kind}; `kind` is an open set matched by `kind_pattern`, and how it reads is `words`.
// 2. trillion-local stamps the time with its own clock; a caller never supplies one, so no client reorders the list.
// 3. A use names a file this person keeps: the name or identity is resolved through the files (`resolve`), and the
//    use is kept under the file's own identity, so a file used by two of its names is one row. A file not theirs is
//    refused (`NotFound`).
// 4. One row per file (`RECENT_FILES`), holding each kind's newest time, so repeats never grow the rows;
//    at most `keep` files are held, the one used longest ago leaving first.
// 5. What a row is called and its type are read from the files at read time, so a renamed file reads by its new name
//    and a file no longer kept drops out of the list.
// - The newest-first order is a second scope (`RECENT_ORDER`) whose id is the inverted time and the
//   identity, so a page is one walk in id order. A use writes the new order row first, then the file's row naming it,
//   then removes the old order row: a crash between leaves an order row its file's row does not name, which a read
//   skips and the next trim removes.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{account_routes::Files, AccountFiles, AccountFilesError, Answer};
use crate::{records::{Error, Mutation, Records, MAX_PAGE_ITEMS}, storage::Storage};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// One row per file used: each kind's newest time, the newest use, and the order row naming it.
pub const RECENT_FILES: &str = "@account-files/recent/files";
/// One row per file used, its id sorting newest first.
pub const RECENT_ORDER: &str = "@account-files/recent/order";
pub const RECENT_KIND: &str = "files-recent";
pub const RECENT_ORDER_KIND: &str = "files-recent-order";

/// The largest time in milliseconds an order id inverts (13 digits, past the year 2286).
const LAST_MS: i64 = 9_999_999_999_999;
/// The longest file name or identity a use may name (old src/recent-files.mjs:65).
const MOST_FILE_CHARS: usize = 1000;

/// This owner's DATA `recent`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecentSettings {
    pub keep: usize,
    pub list_default: usize,
    pub list_max: usize,
    pub kind_pattern: String,
    pub words: BTreeMap<String, String>,
    pub said: Said,
    pub uses: Vec<Use>,
}

/// How a page of recent files says its count.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Said {
    pub one: String,
    /// `{count}` is the count.
    pub many: String,
    pub no_older: String,
    pub none: String,
}

/// An operation that keeps a use when it answers.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Use {
    pub operation: String,
    /// The input field naming the file (a name or an identity).
    pub file: String,
    pub kind: String,
    /// When set, the use is kept only when this input field is absent or 0.
    #[serde(default)]
    pub when_zero: Option<String>,
}

impl RecentSettings {
    pub(super) fn valid(&self, operations: &[String]) -> bool {
        let Ok(pattern) = regex::Regex::new(&self.kind_pattern) else { return false };
        (1..=self.list_max).contains(&self.list_default)
            && self.keep >= self.list_max
            && self.list_max <= MAX_PAGE_ITEMS
            && self.said.many.contains("{count}")
            && self.uses.iter().all(|used| operations.contains(&used.operation) && pattern.is_match(&used.kind) && !used.file.is_empty())
            && self.words.keys().all(|kind| pattern.is_match(kind))
    }

    /// How a kind of use reads: its row in `words`, else the word itself, first letter raised, dashes as spaces
    /// (old src/recent-files.mjs:25 `useWords`).
    pub fn words_of(&self, kind: &str) -> String {
        if let Some(words) = self.words.get(kind) {
            return words.clone();
        }
        let mut chars = kind.chars();
        chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect::<String>().replace('-', " "))
    }

    /// The use `operation` keeps for `input` when it answered, if any: (file, kind).
    pub fn use_of<'a>(&'a self, operation: &str, input: &'a Value) -> Option<(&'a str, &'a str)> {
        let used = self.uses.iter().find(|used| used.operation == operation)?;
        if let Some(field) = &used.when_zero {
            if input.get(field).is_some_and(|value| value.as_u64() != Some(0)) {
                return None;
            }
        }
        Some((input.get(&used.file).and_then(Value::as_str)?, used.kind.as_str()))
    }
}

/// This owner's DATA `facts`: the result kind `set_file_facts` merges (old src/file-tools.mjs:135 `kind: 'facts'`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactsSettings {
    pub kind: String,
}
impl FactsSettings {
    pub(super) fn valid(&self) -> bool {
        super::results::is_kind(&self.kind)
    }
}

fn settings() -> Answer<&'static Files> {
    Files::shipped().ok_or(AccountFilesError::Records(crate::cause!(Error::Unavailable), crate::cause!()))
}

/// The last part of a name (old src/recent-files.mjs:30 `baseName`).
fn base_name(name: &str) -> &str {
    match name.rsplit('/').next() {
        Some(last) if !last.is_empty() => last,
        _ => name,
    }
}

/// A request key for one write of this owner: unique to what it writes and when.
fn request_key(what: &str, id: &str, at: &str) -> String {
    format!("files-recent:{}", blake3::hash(format!("{what}\0{id}\0{at}").as_bytes()).to_hex())
}

impl<S: Storage + Send> AccountFiles<S> {
    /// `record_file_use`: keep that `file` (a name starting with / or an identity) was used as `kind`, now. Answers
    /// {recorded, file: its row} (old src/recent-files.mjs:62 `record`).
    pub fn record_file_use(&mut self, file: &str, kind: &str) -> Answer<Value> {
        let recent = settings()?.recent();
        let file = file.trim();
        if file.is_empty() || file.chars().count() > MOST_FILE_CHARS {
            return Err(AccountFilesError::Invalid("say which file this was, by its name or its identity", crate::cause!()));
        }
        let kind = kind.trim();
        let pattern = regex::Regex::new(&recent.kind_pattern).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !pattern.is_match(kind) {
            return Err(AccountFilesError::Invalid("say what happened in one short word, such as opened, watched or edited", crate::cause!()));
        }
        let identity = self.resolve(file)?.file.id;
        // `last_at` is the account-files clock at its declared millisecond precision. The
        // order tick is a per-scope hybrid clock: advance past the current newest row when
        // the wall clock ties or moves backwards. This keeps the existing inverted-millisecond
        // key format and lets existing pages continue across old and new rows.
        let now_ms = i64::try_from(self.now_ms()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let now = chrono::DateTime::from_timestamp_millis(now_ms).ok_or(crate::cause!(Error::Unavailable))?;
        let at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let order_ms = now_ms.clamp(0, LAST_MS);
        let newest = self.store.list_page(&self.account, RECENT_ORDER, "", 1)?.items;
        let previous_tick = newest.first()
            .and_then(|row| row.id.split_once(':').map(|(inverted, _)| inverted))
            .and_then(|inverted| inverted.parse::<i64>().ok())
            .and_then(|inverted| LAST_MS.checked_sub(inverted));
        let order_tick = match previous_tick {
            Some(tick) => order_ms.max(tick.checked_add(1).ok_or(crate::cause!(Error::Unavailable))?),
            None => order_ms,
        };
        if order_tick > LAST_MS {
            return Err(crate::cause!(Error::Unavailable).into());
        }
        let order = format!("{:013}:{identity}", LAST_MS - order_tick);
        let (version, held) = self.held(RECENT_FILES, &identity)?;
        let mut kinds = held.as_ref().and_then(|row| row.value.get("kinds")).and_then(Value::as_object).cloned().unwrap_or_default();
        kinds.insert(kind.to_owned(), json!(at));
        let previous = held.as_ref().and_then(|row| row.value.get("order")).and_then(Value::as_str).map(str::to_owned);
        // The new order row first, then the file's row naming it, then the old order row goes.
        let (order_version, _) = self.held(RECENT_ORDER, &order)?;
        self.mutate(RECENT_ORDER, Mutation { id: order.clone(), expected_version: order_version, request_key: request_key("order", &order, &at),
            deleted: false, value: json!({"kind": RECENT_ORDER_KIND, "identity": identity, "last_at": at}) })?;
        let value = json!({"kind": RECENT_KIND, "identity": identity, "last_at": at, "last_kind": kind, "kinds": kinds, "order": order});
        self.mutate(RECENT_FILES, Mutation { id: identity.clone(), expected_version: version, request_key: request_key("file", &identity, &order_tick.to_string()),
            deleted: false, value })?;
        if let Some(previous) = previous.filter(|previous| *previous != order) {
            self.forget_order(&previous, &at)?;
        }
        if held.is_none() {
            self.trim_recent(recent.keep, &at)?;
        }
        let row = self.recent_row(&identity, &at, kind, &Value::Object(kinds))?;
        Ok(json!({"recorded": true, "file": row}))
    }

    /// Remove one order row, when it is still there.
    fn forget_order(&mut self, order: &str, at: &str) -> Answer<()> {
        let (version, held) = self.held(RECENT_ORDER, order)?;
        if held.is_some() {
            self.mutate(RECENT_ORDER, Mutation { id: order.to_owned(), expected_version: version, request_key: request_key("forget", order, at),
                deleted: true, value: Value::Null })?;
        }
        Ok(())
    }

    /// Past `keep` order rows (newest first), each row and the file's row it names go: the file used longest ago
    /// leaves first (old src/recent-files.mjs:42 `trim`).
    fn trim_recent(&mut self, keep: usize, at: &str) -> Answer<()> {
        let mut seen = 0usize;
        let mut after: Option<String> = None;
        let mut past = Vec::new();
        loop {
            let (ids, next) = self.store.ids(&self.account, RECENT_ORDER, after.as_deref(), MAX_PAGE_ITEMS)?;
            for id in ids {
                seen += 1;
                if seen > keep {
                    past.push(id);
                }
            }
            match next {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        for order in past {
            let identity = order.split_once(':').map(|(_, identity)| identity.to_owned()).unwrap_or_default();
            let (version, held) = self.held(RECENT_FILES, &identity)?;
            if held.as_ref().and_then(|row| row.value.get("order")).and_then(Value::as_str) == Some(order.as_str()) {
                self.mutate(RECENT_FILES, Mutation { id: identity.clone(), expected_version: version, request_key: request_key("trim", &identity, at),
                    deleted: true, value: Value::Null })?;
            }
            self.forget_order(&order, at)?;
        }
        Ok(())
    }

    /// The row the list shows for one file, read from the files now: None when the files no longer keep it
    /// (old src/recent-files.mjs:49 `shaped`).
    fn recent_row(&self, identity: &str, last_at: &str, last_kind: &str, kinds: &Value) -> Answer<Option<Value>> {
        let Some(file) = self.get(super::FILES, identity)? else { return Ok(None) };
        let name = file.value.get("names").and_then(Value::as_array).and_then(|names| names.first()).and_then(Value::as_str);
        let recent = settings()?.recent();
        Ok(Some(json!({
            "identity": identity,
            "name": name,
            "title": name.map_or(identity, base_name),
            "media_type": file.value.get("media_type").cloned().unwrap_or(Value::Null),
            "last_at": last_at,
            "last_kind": last_kind,
            "last_words": recent.words_of(last_kind),
            "kinds": kinds,
        })))
    }

    /// `recent_files`: newest first, {items, next_before, said}; `before` (an earlier page's next_before) reads older
    /// files (old src/recent-files.mjs:81 `recent`).
    pub fn recent_files(&self, limit: Option<u64>, before: Option<&str>) -> Answer<Value> {
        let recent = settings()?.recent();
        let size = limit.and_then(|limit| usize::try_from(limit).ok()).filter(|limit| *limit > 0)
            .unwrap_or(recent.list_default).clamp(1, recent.list_max);
        let page = self.store.list_page(&self.account, RECENT_ORDER, before.unwrap_or(""), size)?;
        let identities: Vec<&str> = page.items.iter().filter_map(|order| order.value.get("identity").and_then(Value::as_str)).collect();
        let rows = self.store.get_many(&self.account, RECENT_FILES, &identities)?;
        let mut items = Vec::new();
        for (order, row) in page.items.iter().zip(identities.iter().zip(rows)) {
            let (identity, Some(row)) = row else { continue };
            // An order row the file's row no longer names is left over from a crash between a use's writes.
            if row.value.get("order").and_then(Value::as_str) != Some(order.id.as_str()) {
                continue;
            }
            let text = |field: &str| row.value.get(field).and_then(Value::as_str).unwrap_or_default().to_owned();
            if let Some(item) = self.recent_row(identity, &text("last_at"), &text("last_kind"), row.value.get("kinds").unwrap_or(&Value::Null))? {
                items.push(item);
            }
        }
        let said = match items.len() {
            0 if before.is_some_and(|before| !before.is_empty()) => recent.said.no_older.clone(),
            0 => recent.said.none.clone(),
            1 => recent.said.one.clone(),
            count => recent.said.many.replace("{count}", &count.to_string()),
        };
        Ok(json!({"items": items, "next_before": page.next, "said": said}))
    }

    /// The use an operation keeps when it answered (DATA `recent.uses`): the answer, with
    /// `recent_use_not_kept` saying why when the use could not be kept (the operation's own effect stands).
    pub(super) fn keep_use(&mut self, operation: &str, input: &Value, mut answer: Value) -> Value {
        let Ok(files) = settings() else { return answer };
        let Some((file, kind)) = files.recent().use_of(operation, input) else { return answer };
        if let Err(error) = self.record_file_use(file, kind) {
            if let Some(fields) = answer.as_object_mut() {
                fields.insert("recent_use_not_kept".into(), json!(error.to_string()));
            }
        }
        answer
    }
}
