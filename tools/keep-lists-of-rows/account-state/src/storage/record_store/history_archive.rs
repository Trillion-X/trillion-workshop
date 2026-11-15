// src/storage/record_store/history_archive.rs
//
// Purpose: A resource's replaced versions move out as files (JSON lines, one version per line) kept in the account's own
// files, and only then leave the store, so the history is kept whole and the store stays small. Which resources do this
// is DATA (`settings.json` `history_archive.resources`, none shipped); a resource not named keeps today's rule (replaced
// versions leave after the undo window, `mod.rs` `exit_step`). Pins hold every version from a stamp on in the store.
//
// Ported one to one from old trillion `src/record-history.mjs` (tag old-trillion-before-worker-retire) onto the record
// store's `versions` family: `makeRecordHistory` :396 (`moveOne` :424, pins :410-421), `historyRows` :202,
// `restoreRecordHistory` :226, `eraseFromKeptHistory` :262, and the pins of `parts/eeaf` (`oldestPin`). The chain proof,
// paged check and verified keep are `history_chain.rs`.
//
// Non-Negotiable Invariants:
// 1. A version leaves the store only after the file holding it is kept and read back (`history_chain::keep_archive` is
//    what a caller's `keep` runs). The kept page's versions are removed in the same write as the chain head moves to the
//    file's identity, so a refused keep, a refused readback or a refused write removes nothing and moves nothing.
// 2. A file is named by its first version (its `valid_to` stamp and id), and it names the head before it, so moving the
//    same versions again after a restart writes the same bytes under the same name, never a second file.
// 3. A page is at most `rows_per_file` versions and about `bytes_per_file` bytes, cut at whole versions; each version's
//    stored body is read bounded at four times the file cap, so one larger version stays in the store (refused, not
//    split) and never enters memory whole.
// 4. A pin holds every replaced version whose `valid_to` is at or after its stamp: archival stops before it. A pin that
//    arrives while a file is being kept refuses the removal (the write sees it), and the head does not move.
// 5. Kept history goes back into the store (`restore_history`) only after every file through the head was read and the
//    chain checked; a changed, missing or reordered file is refused with nothing applied. Files kept after the head are
//    left out. A version put back is a replaced version (never current) and never replaces a row the store holds.
// 6. Erasure of kept history rewrites a file without the waiting records' words (the named fields of their values set
//    to null; a sealed value is left, its key being gone): the file keeps its name, its lines and its link, and the
//    substitution of its identity is kept before the file is written, so the chain still checks.
//
// Key Concepts:
// - The archive is a step a host runs between requests (`archive_history_step`), like `reclaim_step`: it is not part of
//   every write, and it never runs for a resource the DATA does not name.
//
// Security Considerations:
// - A kept file holds the account's own record values; it lives in the account's own files, never in a shared store.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::clock_ms;
use super::history_chain::{HistoryError, chain_line, history_identity, Broken, Substitution, Verifier, VerifierState};
use super::{text, unavailable, validate, Bound, Field, Intent, Order, Range, RecordStore, Storage, StorageError, Value, When, CURRENT, VERSIONS};
use crate::records::Error;
use serde::Deserialize;
use serde_json::{json, Map};
use std::collections::BTreeMap;

const CHAIN: &str = "kept_history_chain";
const PINS: &str = "kept_history_pins";
const SUBSTITUTIONS: &str = "kept_history_substitutions";

/// Which resources archive their history, and how (`settings.json` `history_archive`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveSettings {
    #[serde(rename = "_why", default)]
    pub why: Option<String>,
    /// The resources whose replaced versions move out as files; `*` names every resource.
    pub resources: Vec<String>,
    /// The folder of the account's files the kept files go in.
    pub folder: String,
    /// How old a replaced version is (since it was replaced) before it moves out.
    pub keep_ms: u64,
    pub rows_per_file: usize,
    pub bytes_per_file: usize,
}
impl ArchiveSettings {
    pub fn valid(&self) -> bool {
        self.rows_per_file > 0 && self.bytes_per_file > 0 && !self.folder.is_empty() && !self.folder.starts_with('/') && !self.folder.ends_with('/')
    }
    /// Whether `resource`'s replaced versions archive.
    pub fn covers(&self, resource: &str) -> bool {
        self.resources.iter().any(|named| named == "*" || named == resource)
    }
}

/// Why an archive step moved nothing and changed nothing.
#[derive(Debug)]
pub enum ArchiveError {
    /// The DATA does not name this resource.
    NotArchived(crate::refusal_cause::Cause),
    Store(Error, crate::refusal_cause::Cause),
    /// The file could not be kept or read back as written.
    Keep(String, crate::refusal_cause::Cause),
    /// One version is larger than four times the file cap: it stays in the store.
    TooLarge(crate::refusal_cause::Cause),
    /// A pin arrived while the file was kept: the versions stay and the head does not move.
    Pinned(crate::refusal_cause::Cause),
}
impl ArchiveError {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotArchived(cause) => cause.clone(),
            Self::Store(_, cause) => cause.clone(),
            Self::Keep(_, cause) => cause.clone(),
            Self::TooLarge(cause) => cause.clone(),
            Self::Pinned(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(ArchiveError);


impl PartialEq for ArchiveError {
    fn eq(&self, other: &Self) -> bool {
        match (self,other) {
            (Self::NotArchived(_),Self::NotArchived(_)) => true,
            (Self::Store(a0, _),Self::Store(b0, _)) => a0 == b0,
            (Self::Keep(a0, _),Self::Keep(b0, _)) => a0 == b0,
            (Self::TooLarge(_),Self::TooLarge(_)) => true,
            (Self::Pinned(_),Self::Pinned(_)) => true,
            _ => false,
        }
    }
}

impl From<Error> for ArchiveError {
    fn from(error: Error) -> Self {
        let cause = error.cause();
        Self::Store(error, cause)
    }
}

/// What one archive step did.
#[derive(Debug, PartialEq)]
pub struct Moved {
    pub moved: usize,
    pub file: Option<String>,
    /// Whether older versions may remain due (the next step may move more).
    pub more: bool,
}

/// What putting kept history back did.
#[derive(Debug, PartialEq)]
pub struct Restored {
    pub files: usize,
    pub left_out: usize,
    pub rows: usize,
    pub applied: usize,
}

/// A file name part that keeps only plain characters (others as `%XX`), so a resource or id never adds a folder.
fn plain(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"._-".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The JSON line of one stored version (`body` as its exact text when it is UTF-8, else base64 in `body_base64`).
fn version_line(row: &[Value]) -> Option<serde_json::Value> {
    let integer = |at: usize| row.get(at).and_then(Value::as_integer);
    let mut line = Map::new();
    line.insert("id".into(), json!(row.first()?.as_text()?));
    line.insert("valid_from".into(), json!(integer(1)?));
    line.insert("version".into(), json!(integer(2)?));
    line.insert("deleted".into(), json!(integer(3)? != 0));
    match row.get(4)? {
        Value::Blob(bytes) => match std::str::from_utf8(bytes) {
            Ok(body) => line.insert("body".into(), json!(body)),
            Err(_) => {
                use base64::Engine as _;
                line.insert("body_base64".into(), json!(base64::engine::general_purpose::STANDARD.encode(bytes)))
            }
        },
        Value::Null => line.insert("body".into(), serde_json::Value::Null),
        _ => return None,
    };
    line.insert("ring".into(), row.get(5)?.as_text().map_or(serde_json::Value::Null, |ring| json!(ring)));
    line.insert("kind".into(), row.get(6)?.as_text().map_or(serde_json::Value::Null, |kind| json!(kind)));
    line.insert("valid_to".into(), json!(integer(7)?));
    Some(serde_json::Value::Object(line))
}

/// The versions one kept file holds, as stored rows for `account` and `resource` (old `historyRows`).
pub fn history_rows(bytes: &[u8], account: &str, resource: &str) -> Result<Vec<Vec<(&'static str, Value)>>, HistoryError> {
    let content = std::str::from_utf8(bytes).map_err(|error| HistoryError::with_cause("A kept history file is not text.".to_string(), crate::refusal_cause::Caused::cause(&error)))?;
    let mut rows = Vec::new();
    for line in content.split('\n').skip(1).filter(|line| !line.is_empty()) {
        let row: serde_json::Value = serde_json::from_str(line).map_err(|error| HistoryError::with_cause("A kept history line is not JSON.".to_string(), crate::refusal_cause::Caused::cause(&error)))?;
        let field = |name: &str| row.get(name);
        let integer = |name: &str, cause| field(name).and_then(serde_json::Value::as_i64).ok_or_else(|| HistoryError::with_cause(format!("A kept history line has no {name}."), cause));
        let body = match (field("body"), field("body_base64")) {
            (Some(serde_json::Value::String(body)), _) => Value::Blob(body.clone().into_bytes()),
            (_, Some(serde_json::Value::String(encoded))) => {
                use base64::Engine as _;
                Value::Blob(base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| HistoryError::new("A kept history body is not base64.".to_string()))?)
            }
            _ => Value::Null,
        };
        let optional = |name: &str| field(name).and_then(serde_json::Value::as_str).map_or(Value::Null, |value| text(value));
        rows.push(vec![
            ("account", text(account)),
            ("resource", text(resource)),
            ("id", text(field("id").and_then(serde_json::Value::as_str).ok_or_else(|| HistoryError::new("A kept history line has no id.".to_string()))?)),
            ("valid_to", Value::Integer(integer("valid_to", crate::cause!())?)),
            ("valid_from", Value::Integer(integer("valid_from", crate::cause!())?)),
            ("version", Value::Integer(integer("version", crate::cause!())?)),
            ("deleted", Value::Integer(i64::from(field("deleted").and_then(serde_json::Value::as_bool).unwrap_or(false)))),
            ("body", body),
            ("ring", optional("ring")),
            ("kind", optional("kind")),
        ]);
    }
    Ok(rows)
}

impl<S: Storage> RecordStore<S> {
    fn archive_settings(&self, resource: &str) -> Result<&'static ArchiveSettings, ArchiveError> {
        let settings = &self.settings.history_archive;
        if settings.covers(resource) { Ok(settings) } else { Err(crate::cause!(ArchiveError::NotArchived)) }
    }

    /// Run `work` in one write scope of the supply (nested inside a lent one), committing when it answers Ok.
    fn archive_scope<T>(&mut self, work: impl FnOnce(&Self) -> Result<T, ArchiveError>) -> Result<T, ArchiveError> {
        let intent = if self.storage.scoped() { Intent::Nested } else { Intent::Write };
        self.storage.open_scope(intent).map_err(|error| Error::Unavailable(error.cause()))?;
        match work(self) {
            Ok(value) => {
                self.storage.close_scope(true).map_err(super::uncertain)?;
                Ok(value)
            }
            Err(error) => {
                self.storage.close_scope(false).map_err(super::uncertain)?;
                Err(error)
            }
        }
    }

    /// Hold every replaced version of the resource from `from_stamp` on in the store, under the name `pin`.
    pub fn pin_history(&mut self, account: &str, resource: &str, pin: &str, from_stamp: i64) -> Result<(), ArchiveError> {
        validate(account, resource, pin)?;
        self.archive_scope(|store| {
            let row = [("account", text(account)), ("resource", text(resource)), ("pin", text(pin)), ("from_stamp", Value::Integer(from_stamp))];
            store.storage.put(PINS, &row, When::Always).map_err(unavailable)?;
            Ok(())
        })
    }
    /// Release one pin; answers whether it was held.
    pub fn release_history_pin(&mut self, account: &str, resource: &str, pin: &str) -> Result<bool, ArchiveError> {
        validate(account, resource, pin)?;
        self.archive_scope(|store| {
            let key = vec![text(account), text(resource), text(pin)];
            let range = Range { order: Order::Key, from: Bound::Included(key.clone()), to: Bound::Included(key), reverse: false, limit: None };
            Ok(store.storage.erase(PINS, &range).map_err(unavailable)? > 0)
        })
    }
    /// The oldest pin's stamp, None when the resource holds no pin.
    pub fn oldest_history_pin(&self, account: &str, resource: &str) -> Result<Option<i64>, Error> {
        let scope = vec![text(account), text(resource)];
        let range = Range { order: Order::Named("oldest"), from: Bound::Included(scope.clone()), to: Bound::Included(scope), reverse: false, limit: Some(1) };
        let rows = self.scan_rows(PINS, &range, &[Field::whole("from_stamp")]).map_err(unavailable)?;
        Ok(rows.into_iter().next().and_then(|mut row| row.take(0).as_integer()))
    }
    /// The identity of the newest kept file of the resource's history and how many were kept (None: none yet).
    pub fn history_head(&self, account: &str, resource: &str) -> Result<Option<(String, i64)>, Error> {
        let row = self.storage.get(CHAIN, &[text(account), text(resource)], &[Field::whole("head"), Field::whole("files")]).map_err(unavailable)?;
        Ok(row.and_then(|mut row| {
            let head = row.take(0).as_text().map(str::to_owned)?;
            Some((head, row.take(1).as_integer().unwrap_or(0)))
        }))
    }
    /// The substitutions of kept files rewritten by erasure.
    pub fn history_substitutions(&self, account: &str, resource: &str) -> Result<Vec<Substitution>, Error> {
        let scope = vec![text(account), text(resource)];
        let range = Range { order: Order::Key, from: Bound::Included(scope.clone()), to: Bound::Included(scope), reverse: false, limit: None };
        let rows = self.scan_rows(SUBSTITUTIONS, &range, &[Field::whole("file"), Field::whole("old_identity"), Field::whole("new_identity")]).map_err(unavailable)?;
        Ok(rows
            .into_iter()
            .filter_map(|mut row| {
                Some(Substitution { file: row.take(0).as_text()?.to_owned(), old_identity: row.take(1).as_text()?.to_owned(), new_identity: row.take(2).as_text()?.to_owned() })
            })
            .collect())
    }
    /// Keep one substitution (before the rewritten file is written, invariant 6).
    pub fn keep_history_substitution(&mut self, account: &str, resource: &str, substitution: &Substitution) -> Result<(), ArchiveError> {
        validate(account, resource, &substitution.file)?;
        self.archive_scope(|store| {
            let row = [
                ("account", text(account)),
                ("resource", text(resource)),
                ("file", text(&substitution.file)),
                ("old_identity", text(&substitution.old_identity)),
                ("new_identity", text(&substitution.new_identity)),
            ];
            store.storage.put(SUBSTITUTIONS, &row, When::Always).map_err(unavailable)?;
            Ok(())
        })
    }

    /// The stamp below which replaced versions are due: `keep_ms` before now, or the oldest pin when it is older.
    fn archive_cutoff(&self, account: &str, resource: &str, settings: &ArchiveSettings) -> Result<i64, Error> {
        let to_stamp = |ms: u64| i64::try_from(ms).unwrap_or(i64::MAX >> 16) << 16;
        let now = to_stamp(clock_ms(&*self.clock));
        let due = now.saturating_sub(to_stamp(settings.keep_ms));
        Ok(match self.oldest_history_pin(account, resource)? {
            Some(pin) if pin < due => pin,
            _ => due,
        })
    }

    /// One archive step: the oldest due page of replaced versions is written as one chained file through `keep` (which
    /// keeps it in the account's files and reads it back, `history_chain::keep_archive`), then removed from the store
    /// in the same write as the chain head moves (invariant 1). Answers what moved; nothing is changed on any error.
    pub fn archive_history_step(&mut self, account: &str, resource: &str, keep: &mut dyn FnMut(&str, &[u8]) -> Result<(), HistoryError>) -> Result<Moved, ArchiveError> {
        validate(account, resource, "history")?;
        let settings = self.archive_settings(resource)?;
        let cutoff = self.archive_cutoff(account, resource, settings)?;
        let scope = vec![text(account), text(resource)];
        let mut to = scope.clone();
        to.push(Value::Integer(cutoff.min(CURRENT - 1)));
        let range = Range { order: Order::Named("ending"), from: Bound::Included(scope), to: Bound::Excluded(to), reverse: false, limit: Some(settings.rows_per_file) };
        let largest = settings.bytes_per_file.saturating_mul(4);
        let read = [Field::whole("id"), Field::whole("valid_from"), Field::whole("version"), Field::whole("deleted"), Field::at_most("body", largest), Field::whole("ring"), Field::whole("kind"), Field::whole("valid_to")];
        let rows = self.scan_rows(VERSIONS, &range, &read).map_err(unavailable)?;
        if rows.is_empty() {
            return Ok(Moved { moved: 0, file: None, more: false });
        }
        let head = self.history_head(account, resource)?;
        let mut bytes = chain_line(head.as_ref().map(|(head, _)| head.as_str()));
        let mut moved: Vec<(Value, i64)> = Vec::new();
        for row in &rows {
            if matches!(row.0.get(4), Some(Value::Oversized(_))) {
                if moved.is_empty() {
                    return Err(crate::cause!(ArchiveError::TooLarge));
                }
                break;
            }
            let line = version_line(&row.0).ok_or(ArchiveError::from(crate::cause!(Error::Unavailable)))?;
            let mut line = serde_json::to_vec(&line).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            line.push(b'\n');
            if !moved.is_empty() && bytes.len() + line.len() > settings.bytes_per_file {
                break;
            }
            if line.len() > largest {
                return Err(crate::cause!(ArchiveError::TooLarge));
            }
            bytes.extend_from_slice(&line);
            moved.push((row.0[0].clone(), row.0[7].as_integer().ok_or(ArchiveError::from(crate::cause!(Error::Unavailable)))?));
        }
        let (first_id, first_to) = (&moved[0].0, moved[0].1);
        let file = format!("{}/{}/{first_to:020}-{}.jsonl", settings.folder, plain(resource), plain(first_id.as_text().unwrap_or_default()));
        keep(&file, &bytes).map_err(|failure| { let cause = failure.cause(); ArchiveError::Keep(failure.code, cause) })?;
        let identity = history_identity(&bytes);
        let files = head.as_ref().map_or(0, |(_, files)| *files) + 1;
        let last_to = moved.last().map(|(_, to)| *to).unwrap_or(first_to);
        let count = moved.len();
        self.archive_scope(|store| {
            // A pin may have arrived while the file was kept: the versions it holds stay, and the head does not move.
            if store.oldest_history_pin(account, resource)?.is_some_and(|pin| last_to >= pin) {
                return Err(crate::cause!(ArchiveError::Pinned));
            }
            // Another step may have moved this page first: the head must still be the one this file names.
            if store.history_head(account, resource)? != head {
                return Err(ArchiveError::from(crate::cause!(Error::Conflict)));
            }
            for (id, valid_to) in &moved {
                let key = vec![text(account), text(resource), id.clone(), Value::Integer(*valid_to)];
                let range = Range { order: Order::Key, from: Bound::Included(key.clone()), to: Bound::Included(key), reverse: false, limit: None };
                store.storage.erase(VERSIONS, &range).map_err(|error| Error::Unavailable(error.cause()))?;
            }
            let row = [("account", text(account)), ("resource", text(resource)), ("head", text(&identity)), ("files", Value::Integer(files))];
            store.storage.put(CHAIN, &row, When::Always).map_err(unavailable)?;
            Ok(())
        })?;
        Ok(Moved { moved: count, file: Some(file), more: true })
    }

    /// Put kept history back (invariant 5): `names` the kept files oldest first, `read` their bytes. Every file through
    /// the head the store kept is read and checked first; only then are their versions put back.
    pub fn restore_history(
        &mut self,
        account: &str,
        resource: &str,
        names: &[String],
        read: &mut dyn FnMut(&str) -> Result<Option<Vec<u8>>, HistoryError>,
    ) -> Result<Result<Restored, Broken>, ArchiveError> {
        validate(account, resource, "history")?;
        let head = self.history_head(account, resource)?.map(|(head, _)| head);
        let substitutions = self.history_substitutions(account, resource)?;
        let mut check = Verifier::new(&substitutions, VerifierState::default(), false);
        let mut through = if head.is_none() { Some(0) } else { None };
        for (index, name) in names.iter().enumerate() {
            if through.is_some() {
                break;
            }
            let bytes = read(name).map_err(|failure| { let cause = failure.cause(); ArchiveError::Keep(failure.code, cause) })?.ok_or_else(|| ArchiveError::Keep(format!("{name} cannot be read."), crate::cause!()))?;
            if let Some(broken) = check.take(name, &bytes) {
                return Ok(Err(broken));
            }
            if check.matches_head(check.last(), name, head.as_deref()) {
                through = Some(index + 1);
            }
        }
        let Some(through) = through else {
            return Ok(Err(check.end(head.as_deref()).err().unwrap_or(Broken { cause: crate::cause!(), at: 0, why: "The kept files do not reach the head.".into() })));
        };
        let mut restored = Restored { files: through, left_out: names.len() - through, rows: 0, applied: 0 };
        let mut kept = Vec::new();
        for name in &names[..through] {
            let bytes = read(name).map_err(|failure| { let cause = failure.cause(); ArchiveError::Keep(failure.code, cause) })?.ok_or_else(|| ArchiveError::Keep(format!("{name} cannot be read."), crate::cause!()))?;
            kept.extend(history_rows(&bytes, account, resource).map_err(|failure| { let cause = failure.cause(); ArchiveError::Keep(failure.code, cause) })?);
        }
        restored.rows = kept.len();
        restored.applied = self.archive_scope(|store| {
            let mut applied = 0;
            for row in &kept {
                // A version put back is a replaced one; a line naming a current row is never applied.
                if matches!(row[3].1, Value::Integer(CURRENT)) {
                    continue;
                }
                applied += store.storage.put(VERSIONS, row, When::Absent).map_err(unavailable)? as usize;
            }
            Ok(applied)
        })?;
        Ok(Ok(restored))
    }
}

/// One bounded step of erasing waiting records' words from kept history (invariant 6, old `eraseFromKeptHistory`):
/// `fields` names, per record id, the fields of its value to take out (a field is a path of names). Each listed file
/// holding a waiting record is rewritten with those fields null; `write` keeps the substitution first, then the file.
/// Answers the next cursor (None when every file was read) and the substitutions made.
pub fn erase_from_kept_history(
    list: &mut dyn FnMut(Option<&str>) -> Result<(Vec<String>, Option<String>), HistoryError>,
    read: &mut dyn FnMut(&str) -> Result<Vec<u8>, HistoryError>,
    write: &mut dyn FnMut(&str, &[u8], &Substitution) -> Result<(), HistoryError>,
    fields: &BTreeMap<String, Vec<Vec<String>>>,
    cursor: Option<&str>,
) -> Result<(Option<String>, Vec<Substitution>), HistoryError> {
    let (names, next) = list(cursor)?;
    let mut substitutions = Vec::new();
    for name in names {
        let bytes = read(&name)?;
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
        if !fields.keys().any(|id| text.contains(&serde_json::to_string(id).unwrap_or_default())) {
            continue;
        }
        let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
        let mut changed = false;
        for line in lines.iter_mut().skip(1).filter(|line| !line.is_empty()) {
            let Ok(mut row) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let Some(wanted) = row.get("id").and_then(serde_json::Value::as_str).and_then(|id| fields.get(id)) else { continue };
            let Some(body) = row.get("body").and_then(serde_json::Value::as_str) else { continue };
            let Ok(mut value) = serde_json::from_str::<serde_json::Value>(body) else { continue };
            let mut touched = false;
            for path in wanted {
                let Some((last, parents)) = path.split_last() else { continue };
                let mut parent = Some(&mut value);
                for part in parents {
                    parent = parent.and_then(|container| container.get_mut(part.as_str()));
                }
                let Some(serde_json::Value::Object(container)) = parent else { continue };
                let sealed = matches!(container.get(last.as_str()), Some(serde_json::Value::Object(object)) if object.contains_key(crate::record_sealed::SEALED_MARK));
                if matches!(container.get(last.as_str()), None | Some(serde_json::Value::Null)) || sealed {
                    continue;
                }
                container.insert(last.clone(), serde_json::Value::Null);
                touched = true;
            }
            if touched {
                row["body"] = json!(serde_json::to_string(&value).map_err(|error| HistoryError::with_cause("A kept value cannot be written.".to_string(), crate::refusal_cause::Caused::cause(&error)))?);
                *line = serde_json::to_string(&row).map_err(|error| HistoryError::with_cause("A kept line cannot be written.".to_string(), crate::refusal_cause::Caused::cause(&error)))?;
                changed = true;
            }
        }
        if !changed {
            continue;
        }
        let rewritten = lines.join("\n").into_bytes();
        let substitution = Substitution { file: name.clone(), old_identity: history_identity(&bytes), new_identity: history_identity(&rewritten) };
        write(&name, &rewritten, &substitution)?;
        substitutions.push(substitution);
    }
    Ok((next, substitutions))
}

#[cfg(test)]
#[path = "history_archive_tests.rs"]
mod tests;
