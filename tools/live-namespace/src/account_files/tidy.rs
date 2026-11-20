// src/account_files/tidy.rs
//
// Purpose: Tidying a person's files: their own AI suggests a title and/or a folder for each file, grounded in what is already
// kept about it (its results: transcript, summary, facts); the person accepts or rejects each suggestion; the accepted ones are
// applied as one tidy-up (a title is recorded as a result of kind `title_kind`, a folder is the file's name moved into it); every
// tidy-up is kept and one not undone can be undone. Ported from the old src/file-tidy.mjs (tools/organize-my-files/src/,
// its routes /namespace/tidy, /tidy/decisions, /tidy/apply, /tidy/undo, /tidy/history), whose store was the retired Worker's
// PersonStore: here a suggestion is a row of `@namespace/tidy-proposals` and a tidy-up a row of `@namespace/tidy-ups`, in the
// person's own rows, and the calls are tidy_propose, tidy_list, tidy_decide, tidy_apply, tidy_undo and tidy_history.
//
// Non-Negotiable Invariants:
// - Grounded: a suggestion cites results already kept for the file, and its title (and a folder that does not exist yet) must be
//   mentioned by their words (thresholds and ignored words are DATA, tidy.json `grounding`). Nothing here invents or runs a model.
// - Never stale: applying reads the file under its name and the value identity of every cited result again; a file renamed,
//   moved or replaced, or evidence changed since, makes that suggestion `stale` and applies nothing for it.
// - One tidy-up is one change: its whole plan (each file's name and title before and after) is written as its row before its
//   first step, and each step is skipped when already taken, so a tidy-up stopped part way is finished by the next tidy_apply
//   (or, while undoing, tidy_undo) before anything else. The old Worker did this in one SQL transaction; this store changes one
//   row at a time at the version read, so the plan row is what makes the steps one tidy-up.
// - Undo reverses a tidy-up only when every file it touched is still as it left them.
// - The files' bytes are never touched: a folder move changes a name, a title is a result.
// - Words, limits and states are DATA (tidy.json).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{folder_name, names, names_scope, now_iso, parent, text, AccountFiles, AccountFilesError, Answer, LIVE};
use crate::store::{Mutation, Record};
use content_crypto::advanced::blake3;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::OnceLock,
};

/// The rows of the person's suggestions, one per suggestion by its id (`tidy:<24 hex>`).
pub const PROPOSALS: &str = "@namespace/tidy-proposals";
/// The rows of the person's tidy-ups, one per tidy-up by its id (`tidy-up:<13-digit ms>-<6 hex>`, so ids sort by time).
pub const TIDY_UPS: &str = "@namespace/tidy-ups";

#[derive(Deserialize)]
struct Grounding {
    min_word_length: usize,
    stem_length: usize,
    missing_share_denominator: usize,
    container_words: Vec<String>,
}

#[derive(Deserialize)]
struct Settings {
    title_kind: String,
    max_items: usize,
    max_name_chars: usize,
    max_title_chars: usize,
    max_reason_chars: usize,
    max_folder_chars: usize,
    list_limit: usize,
    history_limit: usize,
    evidence_chars: usize,
    grounding: Grounding,
    states: BTreeMap<String, Value>,
    decidable_states: Vec<String>,
    replaceable_states: Vec<String>,
    words: BTreeMap<String, String>,
}

fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_str(include_str!("tidy.json")).expect("tidy.json is the shape tidy.rs reads"))
}

/// The words of `key`, with each `{name}` filled from `values`.
fn said(key: &str, values: &[(&str, String)]) -> String {
    let mut words = settings().words.get(key).cloned().unwrap_or_else(|| key.to_owned());
    for (name, value) in values {
        words = words.replace(&format!("{{{name}}}"), value);
    }
    words
}

fn one_line(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(|c| c.is_control())
}

fn base_of(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// The name a file named `name` has once placed in `folder`.
fn place_in(folder: &str, name: &str) -> String {
    format!("{}/{}", if folder == "/" { "" } else { folder }, base_of(name))
}

/// A folder as a clean path: starts with /, no empty, `.` or `..` parts, no trailing /. None when not one.
fn folder_path(value: &str, max: usize) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    if !trimmed.starts_with('/') || trimmed.chars().count() > max || trimmed.chars().any(|c| c.is_control()) {
        return None;
    }
    if trimmed != "/" && trimmed[1..].split('/').any(|part| part.trim().is_empty() || part == "." || part == "..") {
        return None;
    }
    Some(trimmed.to_owned())
}

/// The value identity a result of `value` is kept under (results.rs `value_identity`, of the value's JSON text).
fn value_identity_of(value: &Value) -> String {
    format!("1f:{}", blake3::hash(value.to_string().as_bytes()).to_hex())
}

/// The grounding check (old file-tidy.mjs `grounding`, the Mac's recording-evidence.mjs).
struct Check {
    container: HashSet<String>,
}
impl Check {
    fn new() -> Self {
        Self { container: settings().grounding.container_words.iter().map(|word| word.to_lowercase()).collect() }
    }
    fn words(text: &str) -> Vec<String> {
        text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|word| !word.is_empty()).map(str::to_owned).collect()
    }
    fn counted(&self, word: &str) -> bool {
        word.chars().count() >= settings().grounding.min_word_length && !word.chars().all(|c| c.is_ascii_digit()) && !self.container.contains(word)
    }
    fn stem(word: &str) -> String {
        word.chars().take(settings().grounding.stem_length).collect()
    }
    /// The word stems a text mentions.
    fn mentioned(&self, text: &str) -> HashSet<String> {
        Self::words(text).into_iter().filter(|word| self.counted(word)).map(|word| Self::stem(&word)).collect()
    }
    /// The words of a title the evidence does not mention, when too many are missing.
    fn title_missing(&self, title: &str, mentioned: &HashSet<String>) -> Option<Vec<String>> {
        let mut judged: Vec<String> = Vec::new();
        for word in Self::words(title).into_iter().filter(|word| self.counted(word)) {
            if !judged.contains(&word) {
                judged.push(word);
            }
        }
        let missing: Vec<String> = judged.iter().filter(|word| !mentioned.contains(&Self::stem(word))).cloned().collect();
        (!judged.is_empty() && missing.len() * settings().grounding.missing_share_denominator > judged.len()).then_some(missing)
    }
    /// Whether a term has words to judge and the evidence mentions none of them.
    fn unsupported(&self, term: &str, mentioned: &HashSet<String>) -> bool {
        let judged: Vec<String> = Self::words(term).into_iter().filter(|word| self.counted(word)).collect();
        !judged.is_empty() && !judged.iter().any(|word| mentioned.contains(&Self::stem(word)))
    }
}

/// Every piece of text in `value`, up to `budget` characters.
fn text_of(value: &Value, budget: &mut usize, parts: &mut Vec<String>) {
    if *budget == 0 {
        return;
    }
    match value {
        Value::String(text) => {
            let piece: String = text.chars().take(*budget).collect();
            *budget -= piece.chars().count();
            parts.push(piece);
        }
        Value::Array(items) => items.iter().for_each(|item| text_of(item, budget, parts)),
        Value::Object(fields) => fields.values().for_each(|item| text_of(item, budget, parts)),
        _ => {}
    }
}

fn request(parts: &[&str]) -> String {
    blake3::hash(parts.join("\0").as_bytes()).to_hex().to_string()
}

impl AccountFiles {
    /// The file a live name names now: (its identity, the name row's version), or None.
    fn tidy_named(&self, name: &str) -> Answer<Option<(String, i64)>> {
        Ok(self.get(&names_scope(parent(name)), name)?.and_then(|row| text(&row.value, "file").map(|file| (file.to_owned(), row.version))))
    }

    /// Whether a live folder is there.
    fn tidy_folder_there(&self, folder: &str) -> Answer<bool> {
        Ok(folder == "/" || self.get(&LIVE.folders(parent(folder)), folder)?.is_some())
    }

    /// The newest result of `kind` a file has: (its value, its value identity).
    fn tidy_result(&self, identity: &str, kind: &str) -> Answer<Option<(Value, String)>> {
        Ok(self.newest_of(identity, Some(kind))?.into_iter().next().map(|record| {
            (record.value.get("value").cloned().unwrap_or(Value::Null), text(&record.value, "value_identity").unwrap_or_default().to_owned())
        }))
    }

    /// Every row of `scope`, in id order, at most `most`.
    fn tidy_rows(&self, scope: &str, most: usize) -> Answer<Vec<Record>> {
        let mut rows = Vec::new();
        let mut after = String::new();
        while rows.len() < most {
            let page = self.store.list_page(scope, &after, (most - rows.len()).min(super::MAX_PAGE_ITEMS))?;
            let next = page.next.clone();
            rows.extend(page.items);
            match next {
                Some(next) if next != after => after = next,
                _ => break,
            }
        }
        Ok(rows)
    }

    /// Write `value` as the row `id` of `scope` at the version held now (None deletes it).
    fn tidy_put(&mut self, scope: &str, id: &str, value: Option<Value>, key: &str) -> Answer<()> {
        let (version, held) = self.held(scope, id)?;
        if held.as_ref().map(|row| &row.value) == value.as_ref() {
            return Ok(());
        }
        let deleted = value.is_none();
        self.mutate(scope, Mutation { id: id.to_owned(), expected_version: version, request_key: key.to_owned(), deleted, value: value.unwrap_or(Value::Null) })?;
        Ok(())
    }

    /// A suggestion as answered: its row, with its tidy-up as {id, applied_at, undone_at} when it was part of one.
    fn tidy_shown(&self, row: &Record) -> Answer<Value> {
        let mut shown = row.value.clone();
        shown["id"] = json!(row.id);
        if let Some(tidy_up) = text(&row.value, "tidy_up") {
            shown["tidy_up"] = match self.get(TIDY_UPS, tidy_up)? {
                Some(held) => json!({"id": tidy_up, "applied_at": held.value["applied_at"], "undone_at": held.value["undone_at"]}),
                None => Value::Null,
            };
        }
        Ok(shown)
    }

    /// What would stop a suggestion being applied now: the file under its name changed, the cited results changed, or the
    /// name it would move to is taken. None when it can be applied.
    fn tidy_problem(&self, proposal: &Value) -> Answer<Option<String>> {
        let name = text(proposal, "name").unwrap_or_default();
        let identity = text(proposal, "identity").unwrap_or_default();
        if self.tidy_named(name)?.map(|(file, _)| file) != Some(identity.to_owned()) {
            return Ok(Some(said("file_changed", &[])));
        }
        let mut changed = Vec::new();
        for cited in proposal["evidence"].as_array().into_iter().flatten() {
            let kind = text(cited, "kind").unwrap_or_default();
            let now = self.tidy_result(identity, kind)?.map(|(_, value_identity)| value_identity);
            if now.as_deref() != text(cited, "value_identity") {
                changed.push(kind.to_owned());
            }
        }
        if !changed.is_empty() {
            return Ok(Some(said("evidence_changed", &[("kinds", changed.join(", "))])));
        }
        if let Some(folder) = text(proposal, "folder") {
            let target = place_in(folder, name);
            if target != name {
                let taken = match self.tidy_named(&target)? {
                    Some((file, _)) => file != identity,
                    None => self.tidy_folder_there(&target)?,
                };
                if taken {
                    return Ok(Some(said("name_taken", &[("name", target)])));
                }
            }
        }
        Ok(None)
    }

    /// `tidy_propose` {items: [{name, title?, folder?, evidence: [kind], reason?}], produced_by?}: each item checked and kept as a
    /// suggestion waiting for the person -> {proposed, unchanged, refused: [{index, name, reason}], said}.
    pub fn tidy_propose(&mut self, items: &[Value], produced_by: Option<&str>) -> Answer<Value> {
        let config = settings();
        if items.is_empty() || items.len() > config.max_items {
            return Err(AccountFilesError::Invalid("items is a list of 1 to max_items {name, title?, folder?, evidence}", crate::cause!()));
        }
        let check = Check::new();
        let open = self.tidy_rows(PROPOSALS, config.list_limit)?;
        let (mut proposed, mut refused, mut unchanged) = (Vec::new(), Vec::new(), 0u64);
        for (index, item) in items.iter().enumerate() {
            let asked_name = text(item, "name").map(str::to_owned);
            let refuse = |reason: String| json!({"index": index, "name": asked_name, "reason": reason});
            let name = text(item, "name").unwrap_or_default().trim().to_owned();
            let Some((identity, _)) = name.starts_with('/').then(|| self.tidy_named(&name)).transpose()?.flatten() else {
                refused.push(refuse(said("no_file", &[])));
                continue;
            };
            let title = text(item, "title").filter(|title| !title.is_empty());
            if title.is_some_and(|title| !one_line(title) || title.trim().chars().count() > config.max_title_chars) {
                refused.push(refuse(said("bad_title", &[("max", config.max_title_chars.to_string())])));
                continue;
            }
            let asked_folder = text(item, "folder").filter(|folder| !folder.is_empty());
            let folder = match asked_folder.map(|folder| folder_path(folder, config.max_folder_chars)) {
                Some(None) => {
                    refused.push(refuse(said("bad_folder", &[("max", config.max_folder_chars.to_string())])));
                    continue;
                }
                // A folder the file is already in is no move.
                Some(Some(folder)) if folder == folder_name(parent(&name)) || folder == parent(&name) => None,
                Some(Some(folder)) => Some(folder),
                None => None,
            };
            if title.is_none() && folder.is_none() {
                refused.push(refuse(said("nothing_suggested", &[])));
                continue;
            }
            let mut kinds: Vec<String> = Vec::new();
            for kind in item["evidence"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|kind| !kind.is_empty()) {
                if !kinds.iter().any(|seen| seen == kind) {
                    kinds.push(kind.to_owned());
                }
            }
            if kinds.is_empty() {
                refused.push(refuse(said("no_evidence_named", &[])));
                continue;
            }
            let mut cited = Vec::new();
            let mut missing = None;
            for kind in &kinds {
                match self.tidy_result(&identity, kind)? {
                    Some((value, value_identity)) => cited.push((kind.clone(), value, value_identity)),
                    None => {
                        missing = Some(kind.clone());
                        break;
                    }
                }
            }
            if let Some(kind) = missing {
                refused.push(refuse(said("evidence_missing", &[("kind", kind)])));
                continue;
            }
            let (mut budget, mut parts) = (config.evidence_chars, Vec::new());
            for (_, value, _) in &cited {
                text_of(value, &mut budget, &mut parts);
            }
            let words = parts.join("\n");
            if words.trim().is_empty() {
                refused.push(refuse(said("evidence_empty", &[])));
                continue;
            }
            let mentioned = check.mentioned(&words);
            if let Some(missing) = title.and_then(|title| check.title_missing(title, &mentioned)) {
                refused.push(refuse(said("title_ungrounded", &[("missing", missing.join(", "))])));
                continue;
            }
            if let Some(folder) = &folder {
                if self.tidy_named(folder)?.is_some() {
                    refused.push(refuse(said("bad_folder", &[("max", config.max_folder_chars.to_string())])));
                    continue;
                }
                if !self.tidy_folder_there(folder)? && check.unsupported(base_of(folder), &mentioned) {
                    refused.push(refuse(said("folder_ungrounded", &[("folder", folder.clone())])));
                    continue;
                }
            }
            let evidence: Vec<Value> = cited.iter().map(|(kind, _, value_identity)| json!({"kind": kind, "value_identity": value_identity})).collect();
            let clean_title = title.map(|title| title.trim().to_owned());
            let id = format!("tidy:{}", &request(&[&json!([name, identity, clean_title, folder, evidence]).to_string()])[..24]);
            if let Some(held) = self.get(PROPOSALS, &id)? {
                unchanged += 1;
                proposed.push(self.tidy_shown(&held)?);
                continue;
            }
            // A newer suggestion for the same file replaces one still waiting; applied ones stay in the history.
            for older in open.iter().filter(|row| text(&row.value, "name") == Some(name.as_str())) {
                let state = text(&older.value, "state").unwrap_or_default();
                if config.replaceable_states.iter().any(|replaceable| replaceable == state) && self.get(PROPOSALS, &older.id)?.is_some() {
                    self.tidy_put(PROPOSALS, &older.id, None, &request(&["replaced", &older.id, &id]))?;
                }
            }
            let reason = text(item, "reason").map(|reason| reason.trim().chars().take(config.max_reason_chars).collect::<String>()).filter(|reason| !reason.is_empty());
            let value = json!({
                "kind": "tidy-proposal", "name": name, "identity": identity, "title": clean_title, "folder": folder, "reason": reason,
                "evidence": evidence, "produced_by": produced_by.map(|by| by.chars().take(200).collect::<String>()),
                "state": "review", "problem": null, "tidy_up": null, "proposed_at": now_iso(), "decided_at": null,
            });
            self.tidy_put(PROPOSALS, &id, Some(value), &request(&["proposed", &id]))?;
            let held = self.get(PROPOSALS, &id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
            proposed.push(self.tidy_shown(&held)?);
        }
        let words = said("said_proposed", &[("proposed", proposed.len().to_string()), ("refused", refused.len().to_string())]);
        Ok(json!({"proposed": proposed, "unchanged": unchanged, "refused": refused, "said": words}))
    }

    /// `tidy_list` {state?}: suggestions newest first (only those in `state` when given), how many are in each state, and the
    /// tidy-up an undo would reverse.
    pub fn tidy_list(&self, state: Option<&str>) -> Answer<Value> {
        let config = settings();
        if state.is_some_and(|state| !config.states.contains_key(state)) {
            return Err(AccountFilesError::Invalid("state is one of the states tidy.json names", crate::cause!()));
        }
        let mut rows = self.tidy_rows(PROPOSALS, config.list_limit)?;
        let mut counts = Map::new();
        for row in &rows {
            let state = text(&row.value, "state").unwrap_or_default().to_owned();
            let count = counts.get(&state).and_then(Value::as_u64).unwrap_or(0) + 1;
            counts.insert(state, json!(count));
        }
        rows.retain(|row| state.is_none_or(|state| text(&row.value, "state") == Some(state)));
        rows.sort_by(|a, b| text(&b.value, "proposed_at").cmp(&text(&a.value, "proposed_at")).then(a.id.cmp(&b.id)));
        let can_undo = self.tidy_latest_applied()?.map(|row| row.id);
        let count = |state: &str| counts.get(state).and_then(Value::as_u64).unwrap_or(0).to_string();
        let words = said("said_list", &[("review", count("review")), ("accepted", count("accepted"))]);
        let proposals = rows.iter().map(|row| self.tidy_shown(row)).collect::<Answer<Vec<_>>>()?;
        Ok(json!({"proposals": proposals, "counts": counts, "can_undo": can_undo, "said": words}))
    }

    /// The newest tidy-up that is applied and not undone.
    fn tidy_latest_applied(&self) -> Answer<Option<Record>> {
        let rows = self.tidy_rows(TIDY_UPS, usize::MAX >> 1)?;
        Ok(rows.into_iter().rev().find(|row| text(&row.value, "state") == Some("applied")))
    }

    /// `tidy_decide` {decisions: [{id, choice: accept | reject}]} -> {decided, refused: [{id, reason}]}.
    pub fn tidy_decide(&mut self, decisions: &[Value]) -> Answer<Value> {
        let config = settings();
        if decisions.is_empty() || decisions.len() > config.list_limit {
            return Err(AccountFilesError::Invalid("decisions is a list of {id, choice: accept or reject}", crate::cause!()));
        }
        let (mut decided, mut refused) = (0u64, Vec::new());
        for decision in decisions {
            let id = text(decision, "id").unwrap_or_default();
            let state = match text(decision, "choice") {
                Some("accept") => "accepted",
                Some("reject") => "rejected",
                _ => {
                    refused.push(json!({"id": id, "reason": said("bad_choice", &[])}));
                    continue;
                }
            };
            let Some(row) = self.get(PROPOSALS, id)? else {
                refused.push(json!({"id": id, "reason": said("not_decidable", &[])}));
                continue;
            };
            if !config.decidable_states.iter().any(|decidable| Some(decidable.as_str()) == text(&row.value, "state")) {
                refused.push(json!({"id": id, "reason": said("not_decidable", &[])}));
                continue;
            }
            let mut value = row.value.clone();
            value["state"] = json!(state);
            value["decided_at"] = json!(now_iso());
            self.tidy_put(PROPOSALS, id, Some(value), &request(&["decided", id, state, &row.version.to_string()]))?;
            decided += 1;
        }
        Ok(json!({"decided": decided, "refused": refused}))
    }

    /// A tidy-up row left part way (`applying` or `undoing`) by a call that stopped, finished now. Answers what it finished.
    fn tidy_finish_left(&mut self) -> Answer<Option<Value>> {
        let rows = self.tidy_rows(TIDY_UPS, usize::MAX >> 1)?;
        let Some(left) = rows.into_iter().find(|row| matches!(text(&row.value, "state"), Some("applying" | "undoing"))) else { return Ok(None) };
        let undoing = text(&left.value, "state") == Some("undoing");
        let answer = if undoing { self.tidy_take_undo(&left)? } else { self.tidy_take_apply(&left)? };
        Ok(Some(json!({"finished_first": left.id, "said": said("applying_left", &[("id", left.id.clone())]), "answer": answer})))
    }

    /// Take every step of an `applying` tidy-up (each skipped when already taken), then mark it and its suggestions applied.
    fn tidy_take_apply(&mut self, row: &Record) -> Answer<Value> {
        let config = settings();
        let id = row.id.clone();
        let changes: Vec<Value> = row.value["changes"].as_array().cloned().unwrap_or_default();
        for change in &changes {
            let identity = text(change, "identity").unwrap_or_default();
            if let Some(title) = change.get("title_value").filter(|value| !value.is_null()) {
                let now = self.tidy_result(identity, &config.title_kind)?.map(|(_, value_identity)| value_identity);
                if now.as_deref() != text(change, "title_after") {
                    let produced_by = text(change, "produced_by").unwrap_or("tidy-up");
                    let answer = self.record_file_results(&[json!({"identity": identity, "kind": config.title_kind, "value": title, "produced_by": produced_by})])?;
                    if answer["refused"].as_array().is_some_and(|refused| !refused.is_empty()) {
                        return Err(AccountFilesError::Invalid("a title of this tidy-up could not be recorded", crate::cause!()));
                    }
                }
            }
            let (before, after) = (text(change, "name_before").unwrap_or_default(), text(change, "name_after").unwrap_or_default());
            if before != after {
                self.tidy_move(identity, before, after)?;
            }
        }
        let mut value = row.value.clone();
        value["state"] = json!("applied");
        self.tidy_put(TIDY_UPS, &id, Some(value.clone()), &request(&["applied", &id]))?;
        for change in &changes {
            let proposal = text(change, "proposal").unwrap_or_default();
            if let Some(held) = self.get(PROPOSALS, proposal)? {
                let mut marked = held.value.clone();
                marked["state"] = json!("applied");
                marked["problem"] = Value::Null;
                marked["tidy_up"] = json!(id);
                self.tidy_put(PROPOSALS, proposal, Some(marked), &request(&["applied", &id, proposal]))?;
            }
        }
        let refused = row.value.get("refused").cloned().unwrap_or(json!([]));
        let mut words = said("said_applied", &[("applied", changes.len().to_string())]);
        if refused.as_array().is_some_and(|refused| !refused.is_empty()) {
            words = format!("{words} {}", said("said_not_applied", &[("refused", refused.as_array().map_or(0, Vec::len).to_string())]));
        }
        Ok(json!({"tidy_up": id, "name": value["name"], "applied": changes.len(), "refused": refused, "said": words}))
    }

    /// Move a file's name `from` to `to`, unless it is already there.
    fn tidy_move(&mut self, identity: &str, from: &str, to: &str) -> Answer<()> {
        if self.tidy_named(to)?.is_some_and(|(file, _)| file == identity) && self.tidy_named(from)?.is_none() {
            return Ok(());
        }
        let (_, version) = self.tidy_named(from)?.filter(|(file, _)| file == identity).ok_or(crate::cause!(AccountFilesError::NotFound))?;
        self.carry_names(names::Carry { source: &LIVE, from, target: &LIVE, to, kept: false, expected: Some(version) }, None, None)?;
        Ok(())
    }

    /// `tidy_apply` {ids?, name?}: every accepted suggestion (or those of `ids` that are accepted) applied as one named tidy-up ->
    /// {tidy_up, name, applied, refused: [{id, name, reason}], said}, or {error} when nothing could be.
    pub fn tidy_apply(&mut self, ids: Option<&[Value]>, name: Option<&str>) -> Answer<Value> {
        let config = settings();
        if let Some(finished) = self.tidy_finish_left()? {
            return Ok(finished);
        }
        if name.is_some_and(|name| !one_line(name) || name.trim().chars().count() > config.max_name_chars) {
            return Ok(json!({"error": said("name_needed", &[("max", config.max_name_chars.to_string())])}));
        }
        let wanted: Option<Vec<&str>> = ids.map(|ids| ids.iter().filter_map(Value::as_str).collect());
        let mut accepted: Vec<Record> = self.tidy_rows(PROPOSALS, config.list_limit)?.into_iter()
            .filter(|row| text(&row.value, "state") == Some("accepted"))
            .filter(|row| wanted.as_ref().is_none_or(|wanted| wanted.contains(&row.id.as_str())))
            .collect();
        accepted.sort_by(|a, b| text(&a.value, "proposed_at").cmp(&text(&b.value, "proposed_at")).then(a.id.cmp(&b.id)));
        if accepted.is_empty() {
            return Ok(json!({"error": said("nothing_accepted", &[])}));
        }
        let (mut changes, mut refused) = (Vec::new(), Vec::new());
        // A title belongs to the bytes: several suggestions for one file share one title write and one true value before.
        let mut titled: BTreeMap<String, usize> = BTreeMap::new();
        for row in &accepted {
            if let Some(problem) = self.tidy_problem(&row.value)? {
                let mut stale = row.value.clone();
                stale["state"] = json!("stale");
                stale["problem"] = json!(problem);
                self.tidy_put(PROPOSALS, &row.id, Some(stale), &request(&["stale", &row.id, &row.version.to_string()]))?;
                refused.push(json!({"id": row.id, "name": row.value["name"], "reason": problem}));
                continue;
            }
            let identity = text(&row.value, "identity").unwrap_or_default().to_owned();
            let before = text(&row.value, "name").unwrap_or_default().to_owned();
            let after = text(&row.value, "folder").map_or(before.clone(), |folder| place_in(folder, &before));
            let mut change = json!({"proposal": row.id, "identity": identity, "name_before": before, "name_after": after,
                "title_before": null, "title_before_identity": null, "title_value": null, "title_after": null, "produced_by": row.value["produced_by"]});
            if let Some(title) = text(&row.value, "title") {
                let value = json!({"title": title});
                match titled.get(&identity) {
                    Some(&first) => {
                        let first_change: &mut Value = &mut changes[first];
                        first_change["title_value"] = Value::Null;
                        first_change["title_after"] = Value::Null;
                        change["title_before"] = first_change["title_before"].clone();
                        change["title_before_identity"] = first_change["title_before_identity"].clone();
                    }
                    None => {
                        if let Some((now, now_identity)) = self.tidy_result(&identity, &config.title_kind)? {
                            change["title_before"] = now;
                            change["title_before_identity"] = json!(now_identity);
                        }
                    }
                }
                change["title_after"] = json!(value_identity_of(&value));
                change["title_value"] = value;
                titled.insert(identity.clone(), changes.len());
            }
            changes.push(change);
        }
        if changes.is_empty() {
            let words = said("said_not_applied", &[("refused", refused.len().to_string())]);
            return Ok(json!({"tidy_up": null, "applied": 0, "refused": refused, "said": words}));
        }
        let batch_name = name.map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned)
            .unwrap_or_else(|| said("default_tidy_up_name", &[("count", changes.len().to_string())]));
        let plan = json!(changes);
        let id = format!("tidy-up:{:013}-{}", self.now_ms(), &request(&[&plan.to_string()])[..6]);
        let row = json!({"kind": "tidy-up", "name": batch_name, "state": "applying", "applied_at": now_iso(), "undone_at": null,
            "changes": plan, "refused": refused});
        // The whole plan is kept before its first step: a call that stops part way leaves it `applying`, and the next call finishes it.
        self.tidy_put(TIDY_UPS, &id, Some(row), &request(&["planned", &id]))?;
        let held = self.get(TIDY_UPS, &id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
        self.tidy_take_apply(&held)
    }

    /// `tidy_undo` {id?}: a tidy-up not undone (the newest when none is named), reversed as one, only when every file it touched
    /// is still as it left them -> {undone, name, changes, said}, or {error}.
    pub fn tidy_undo(&mut self, id: Option<&str>) -> Answer<Value> {
        if let Some(finished) = self.tidy_finish_left()? {
            return Ok(finished);
        }
        let row = match id {
            Some(id) => self.get(TIDY_UPS, id)?,
            None => self.tidy_latest_applied()?,
        };
        let Some(row) = row else {
            return Ok(json!({"error": match id { Some(id) => said("tidy_up_unknown", &[("id", id.to_owned())]), None => said("nothing_to_undo", &[]) }}));
        };
        if text(&row.value, "state") != Some("applied") {
            let name = text(&row.value, "name").unwrap_or(&row.id).to_owned();
            return Ok(json!({"error": said("already_undone", &[("name", name)])}));
        }
        let config = settings();
        let changes: Vec<Value> = row.value["changes"].as_array().cloned().unwrap_or_default();
        let mut changed_since = Vec::new();
        for change in &changes {
            let identity = text(change, "identity").unwrap_or_default();
            let (before, after) = (text(change, "name_before").unwrap_or_default(), text(change, "name_after").unwrap_or_default());
            let moved_back = before != after && (self.tidy_named(after)?.map(|(file, _)| file) != Some(identity.to_owned()) || self.tidy_named(before)?.is_some());
            let retitled = match text(change, "title_after") {
                Some(after) => self.tidy_result(identity, &config.title_kind)?.map(|(_, now)| now).as_deref() != Some(after),
                None => false,
            };
            if moved_back || retitled {
                changed_since.push(after.to_owned());
            }
        }
        if !changed_since.is_empty() {
            return Ok(json!({"error": said("undo_changed", &[("names", changed_since.join(", "))])}));
        }
        let mut value = row.value.clone();
        value["state"] = json!("undoing");
        self.tidy_put(TIDY_UPS, &row.id, Some(value), &request(&["undoing", &row.id]))?;
        let held = self.get(TIDY_UPS, &row.id)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
        self.tidy_take_undo(&held)
    }

    /// Take every step of an `undoing` tidy-up back (each skipped when already taken), then mark it and its suggestions undone.
    fn tidy_take_undo(&mut self, row: &Record) -> Answer<Value> {
        let config = settings();
        let id = row.id.clone();
        let changes: Vec<Value> = row.value["changes"].as_array().cloned().unwrap_or_default();
        for change in &changes {
            let identity = text(change, "identity").unwrap_or_default();
            if text(change, "title_after").is_some() {
                let now = self.tidy_result(identity, &config.title_kind)?.map(|(_, value_identity)| value_identity);
                match change.get("title_before").filter(|value| !value.is_null()) {
                    None if now.is_some() => {
                        self.remove_file_result(identity, &config.title_kind)?;
                    }
                    Some(before) if now.as_deref() != text(change, "title_before_identity") => {
                        self.record_file_results(&[json!({"identity": identity, "kind": config.title_kind, "value": before, "produced_by": "tidy-up undone"})])?;
                    }
                    _ => {}
                }
            }
            let (before, after) = (text(change, "name_before").unwrap_or_default(), text(change, "name_after").unwrap_or_default());
            if before != after {
                self.tidy_move(identity, after, before)?;
            }
        }
        let mut value = row.value.clone();
        value["state"] = json!("undone");
        value["undone_at"] = json!(now_iso());
        self.tidy_put(TIDY_UPS, &id, Some(value.clone()), &request(&["undone", &id]))?;
        for change in &changes {
            let proposal = text(change, "proposal").unwrap_or_default();
            if let Some(held) = self.get(PROPOSALS, proposal)? {
                let mut marked = held.value.clone();
                marked["state"] = json!("undone");
                self.tidy_put(PROPOSALS, proposal, Some(marked), &request(&["undone", &id, proposal]))?;
            }
        }
        Ok(json!({"undone": id, "name": value["name"], "changes": changes.len(), "said": said("said_undone", &[("changes", changes.len().to_string())])}))
    }

    /// `tidy_history` {limit?}: tidy-ups newest first, each with what changed for each file and whether undo would reverse it.
    pub fn tidy_history(&self, limit: Option<usize>) -> Answer<Value> {
        let config = settings();
        let rows = self.tidy_rows(TIDY_UPS, usize::MAX >> 1)?;
        let latest = rows.iter().rev().find(|row| text(&row.value, "state") == Some("applied")).map(|row| row.id.clone());
        let limit = limit.unwrap_or(config.history_limit).clamp(1, config.history_limit);
        let shown: Vec<Value> = rows.iter().rev().take(limit).map(|row| {
            let mut value = row.value.clone();
            value["id"] = json!(row.id);
            value["can_undo"] = json!(latest.as_deref() == Some(row.id.as_str()));
            value
        }).collect();
        Ok(json!({"tidy_ups": shown, "said": said("said_history", &[("count", rows.len().to_string())])}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_grounded_only_when_its_words_are_in_the_evidence() {
        let check = Check::new();
        let mentioned = check.mentioned("Federer forehand practice on the hard court, side view");
        assert!(check.title_missing("Forehand practice side view", &mentioned).is_none());
        assert_eq!(check.title_missing("Backhand volley drills tournament", &mentioned).map(|missing| missing.len()), Some(4));
        assert!(check.title_missing("Video recording", &mentioned).is_none(), "container words are never judged");
        assert!(check.unsupported("Tournaments", &mentioned));
        assert!(!check.unsupported("Forehands", &mentioned), "a word matches on its first stem_length letters");
    }

    #[test]
    fn a_folder_is_a_clean_absolute_path() {
        assert_eq!(folder_path("/Tennis/Forehand/", 100).as_deref(), Some("/Tennis/Forehand"));
        assert_eq!(folder_path("/", 100).as_deref(), Some("/"));
        for bad in ["Tennis", "/a//b", "/a/../b", "/a/./b", "/a\nb"] {
            assert!(folder_path(bad, 100).is_none(), "{bad}");
        }
        assert!(folder_path("/abcdef", 3).is_none());
        assert_eq!(place_in("/Tennis", "/Inbox/a.mp4"), "/Tennis/a.mp4");
        assert_eq!(place_in("/", "/Inbox/a.mp4"), "/a.mp4");
    }
}
