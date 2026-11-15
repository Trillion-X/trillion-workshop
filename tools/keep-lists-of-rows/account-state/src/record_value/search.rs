// src/record_value/search.rs
//
// Purpose: One question over the account's own records, answered by the door's `search` operation
// (`records-routes.json` `search`). It is the port of old trillion's one search (Trillion-X/trillion src/search.mjs:1750
// `finish`, with its records mechanism `words-in-records` at src/search.mjs:1400 and the helpers `words`, `holdsEvery`
// and `around` at src/search.mjs:59, 121 and 123), reached the way the old MCP `search` tool reached it
// (src/file-tools.mjs:125 -> GET /namespace/search, src/namespace.mjs:2127). Candidates come from the record store word index
// (`storage::record_store::segments` `RecordStore::search`), which every written row feeds at write time; this module only plans the
// question, checks every candidate against its opened value and ranks the answer.
//
// What was ported, one to one:
// - The question is cut to `question_chars`, its words are the distinct lowercased words of at least
//   `min_word_length` (search.mjs `terms`).
// - A word no record holds means no record holds every word (search.mjs:1330); common words narrow nothing, so
//   candidates are the records holding every uncommon word (`informative`), and each candidate is checked for every
//   asked word in its opened value (`holdsEvery`: an asked word is held when a word of the text starts with it).
// - Each lane ranks its own hits; things are merged by reciprocal rank fusion with `k` (search.mjs:1873 `fused`): a
//   thing is worth its lane's rank weight over (k + its rank in that lane), so lanes add by rank, never raw score.
// - A result is one thing with `found_in` (its places), `said` (the words around the first asked word, cut to
//   `said_characters`), its title and its address; the answer names `unavailable` and `pending` lanes. The records
//   lane is pending while the store's search walk still indexes rows written before the index existed
//   (`OrderedSupply::search_pending`, `RecordStore::search_walk`).
//
// What was dropped, and why:
// - The search feed reader, candidate pages, fusion sessions and per-wake catch-up (search-answer.mjs, the
//   search_candidate_* and search_fusion_* tables): they paged a Worker's clock budget and a Durable Object's feed;
//   the rules rule out a machine kind in the design (docs/PRINCIPLES.md 2), and record store already keeps the index inside the
//   write (`segments.rs`).
// - Lanes named in data per record type (search.json `decisions`, `pursuits`, `messages`): trillion-local names no kind
//   (docs/PRINCIPLES.md 5), so every kind that holds a hit is its own lane, of rank 1, labelled by its kind.
// - Learned lane weights (search-answers.mjs) and meaning, picture and colour lanes: there is no answer log and no
//   encoder in trillion-local yet; they are named gaps, not guessed.
//
// Non-Negotiable Invariants:
// - Every record answered is opened through `record_value::read` under the caller's policy (sealed fields, erasure),
//   and a candidate whose opened value does not hold every asked word is never answered.
// - The index only proposes; a stale posting (a record changed since) is checked against the current record.
// - With `type` given, only records of that kind are answered, so a run granted one kind learns nothing of others.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{list::OrderedSupply, read, Limits, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// The search operation's numbers and names (records-routes.json `search`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchSettings {
    #[serde(rename = "_what")]
    _what: String,
    pub(super) operation: String,
    /// Results answered when the input names no limit.
    pub(super) limit: usize,
    /// The most results one answer may ask for.
    pub(super) most: usize,
    pub(super) question_chars: usize,
    pub(super) min_word_length: usize,
    pub(super) said_characters: usize,
    /// Postings asked of the index per word: a word with this many is common and narrows nothing.
    pub(super) word_hits: usize,
    /// Reciprocal rank fusion's k.
    pub(super) k: f64,
    /// Where a record's words are found, and its source, as old search.json names them (`{word}` in the source is
    /// the product's identity word).
    pub(super) place: String,
    pub(super) source: String,
    /// What a record's result id starts with (old search.mjs `record:${id}`).
    pub(super) key_prefix: String,
}

impl SearchSettings {
    pub(super) fn valid(&self) -> bool {
        !self.operation.is_empty()
            && (1..=self.most).contains(&self.limit)
            && self.most <= super::list::MAX_LIST_ROWS
            && self.question_chars > 0
            && self.min_word_length > 0
            && self.said_characters > 0
            && (1..=crate::records::MAX_PAGE_ITEMS).contains(&self.word_hits)
            && self.k.is_finite()
            && self.k > 0.0
            && !self.place.is_empty()
            && !self.source.is_empty()
            && !self.key_prefix.is_empty()
    }
}

/// `{question, type?, limit?}` as read.
pub(super) struct SearchInput<'a> {
    pub(super) question: &'a str,
    pub(super) kind: Option<&'a str>,
    pub(super) limit: usize,
}

/// The lowercased words of a text (old search.mjs `words`: letters and digits, apostrophes dropped).
pub fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace(['\'', '\u{2019}'], "")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The distinct asked words of a question: at most `question_chars` of it, words of at least `min_word_length`.
pub fn terms(question: &str, question_chars: usize, min_word_length: usize) -> (String, Vec<String>) {
    let question: String = question.trim().chars().take(question_chars).collect();
    let mut seen = BTreeSet::new();
    let terms = words(&question)
        .into_iter()
        .filter(|word| word.chars().count() >= min_word_length && seen.insert(word.clone()))
        .collect();
    (question, terms)
}

/// Whether every asked word starts a word of `text` (old search.mjs `holdsEvery`).
pub fn holds_every(text: &str, terms: &[String]) -> bool {
    let said = words(text);
    terms.iter().all(|term| said.iter().any(|word| word.starts_with(term.as_str())))
}

/// The words around the first asked word, cut to `length` characters (old search.mjs `around`).
pub fn around(text: &str, terms: &[String], length: usize) -> String {
    let whole = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = whole.to_lowercase();
    let at = terms
        .first()
        .and_then(|term| lower.find(term.as_str()))
        .map(|byte| lower[..byte].chars().count().saturating_sub(60))
        .unwrap_or(0);
    let cut: String = whole.chars().skip(at).take(length).collect();
    format!("{}{}", if at > 0 { "\u{2026}" } else { "" }, cut.trim())
}

/// Every text of an opened value a search reads: its top-level texts and the texts of its top-level lists, in order.
fn text_of(value: &Value) -> String {
    let Some(object) = value.as_object() else { return value.as_str().unwrap_or_default().to_owned() };
    let mut texts = Vec::new();
    for item in object.values() {
        match item {
            Value::String(text) => texts.push(text.as_str()),
            Value::Array(items) => texts.extend(items.iter().filter_map(Value::as_str)),
            _ => {}
        }
    }
    texts.join("\n")
}

/// The ids every uncommon asked word proposes (old search.mjs `informative`: a word holding `word_hits` postings
/// narrows nothing), the rarest word's order kept. None when some word is held by no record at all. `ids_of` is the
/// word index of the owner asking (the account's records, or its files), at most `word_hits` ids a word.
pub fn candidates<E>(mut ids_of: impl FnMut(&str) -> std::result::Result<Vec<String>, E>, terms: &[String], word_hits: usize)
    -> std::result::Result<Option<Vec<String>>, E> {
    let mut lists = Vec::with_capacity(terms.len());
    for term in terms {
        let ids = ids_of(term)?;
        if ids.is_empty() {
            // The index holds whole words; an asked word may still start a longer one, which only the full walk of
            // the words could find. Old search matched prefixes; this index does not (a named gap).
            return Ok(None);
        }
        lists.push(ids);
    }
    let uncommon: Vec<&Vec<String>> = lists.iter().filter(|ids| ids.len() < word_hits).collect();
    let narrowing: Vec<&Vec<String>> = if uncommon.is_empty() { lists.iter().collect() } else { uncommon };
    let Some(rarest) = narrowing.iter().min_by_key(|ids| ids.len()) else { return Ok(Some(Vec::new())) };
    let others: Vec<BTreeSet<&str>> = narrowing.iter().map(|ids| ids.iter().map(String::as_str).collect()).collect();
    Ok(Some(rarest.iter().filter(|id| others.iter().all(|held| held.contains(id.as_str()))).cloned().collect()))
}

/// One hit of a lane: the record, its title and the words around the match.
struct Hit {
    id: String,
    kind: String,
    title: String,
    said: String,
}

/// The answer to one question over `supply`, every record opened under the account's installed record model
/// (`model`: its open policy, and the kinds that stay on this computer).
pub(super) fn answer(
    input: SearchInput<'_>,
    settings: &SearchSettings,
    resource: &str,
    read_operation: &str,
    supply: &mut impl OrderedSupply,
    model: &crate::record_model_policy::Installed,
    limits: Limits,
) -> Result<Value> {
    let policy = model.open_policy();
    let (question, terms) = terms(input.question, settings.question_chars, settings.min_word_length);
    let titles = supply.settings().search.fields();
    let mut lanes: BTreeMap<String, Vec<Hit>> = BTreeMap::new();
    let mut found = 0usize;
    // Rows written before the word index existed reach it through the store's walk; until it is done, the records
    // lane is named pending (old search.mjs: a lane still working is `pending`, and the caller asks again).
    let pending = supply.search_pending()?;
    if !terms.is_empty() {
        let word_hits = settings.word_hits;
        if let Some(ids) = candidates(|word| supply.search_ids(word, word_hits), &terms, word_hits)? {
            for id in ids {
                if found >= input.limit {
                    break;
                }
                let Some(record) = read(&id, supply, policy, limits)? else { continue };
                // A kind its owner keeps (`owner_only`, the vault's own values) is no one's answer, typed or not.
                if model.owner_only(record.record_type()) {
                    continue;
                }
                // With a type, only that kind; with none, never a kind that stays on this computer (the door refuses a
                // caller from elsewhere that names one, `Door::device_only_asked`; one named nothing never sees one).
                match input.kind {
                    Some(kind) if kind != record.record_type() => continue,
                    None if model.stays(record.record_type()) => continue,
                    _ => {}
                }
                let value = super::account_routes::value_json(&record)?;
                let text = text_of(&value);
                if !holds_every(&text, &terms) {
                    continue;
                }
                let title = titles
                    .iter()
                    .find_map(|field| value.get(field).and_then(Value::as_str).filter(|text| !text.trim().is_empty()))
                    .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(140).collect())
                    .unwrap_or_else(|| id.clone());
                let kind = record.record_type().to_owned();
                lanes.entry(kind.clone()).or_default().push(Hit { id, kind, title, said: around(&text, &terms, settings.said_characters) });
                found += 1;
            }
        }
    }
    // Reciprocal rank fusion over the lanes (one per kind, each of rank 1): a thing is worth 1 / (k + its rank).
    let mut things: Vec<(f64, Hit)> = Vec::new();
    for hits in lanes.into_values() {
        for (at, hit) in hits.into_iter().enumerate() {
            things.push((1.0 / (settings.k + (at + 1) as f64), hit));
        }
    }
    things.sort_by(|a, b| b.0.total_cmp(&a.0));
    things.truncate(input.limit);
    let results: Vec<Value> = things
        .into_iter()
        .map(|(score, hit)| {
            json!({
                "id": format!("{}{}", settings.key_prefix, hit.id),
                // `{word}` is the product's identity word (src/account_files/identity.rs `named`).
                "source": crate::account_files::identity::named(&settings.source).unwrap_or_else(|_| settings.source.clone()),
                "kind_label": hit.kind,
                "type": hit.kind,
                "title": hit.title,
                "name": hit.title,
                "record": hit.id,
                "address": {"resource": resource, "operation": read_operation, "input": {"id": hit.id, "type": hit.kind}},
                "found_in": [settings.place],
                "places": [{"place": settings.place, "said": hit.said}],
                "said": hit.said,
                "score": (score * 1e5).round() / 1e5,
            })
        })
        .collect();
    Ok(json!({
        "question": question,
        "terms": terms,
        "results": results,
        "unavailable": [],
        "pending": if pending { vec![settings.place.clone()] } else { Vec::new() },
    }))
}

/// `{question, type?, limit?}`: the closed input of the search operation.
pub(super) fn input<'a>(fields: &'a Map<String, Value>, settings: &SearchSettings) -> std::result::Result<SearchInput<'a>, crate::mcp::InputFault> {
    use crate::mcp::InputFault;
    if let Some(key) = fields.keys().find(|key| !["question", "type", "limit"].contains(&key.as_str())) {
        return Err(InputFault::new(key.as_str(), "not a field of this operation; its fields are question, type, limit"));
    }
    let question = fields
        .get("question")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| InputFault::new("question", "required: the question or the words to find"))?;
    let kind = match fields.get("type") {
        None | Some(Value::Null) => None,
        Some(Value::String(kind)) if !kind.is_empty() => Some(kind.as_str()),
        Some(_) => return Err(InputFault::new("type", "non-empty text")),
    };
    let limit = match fields.get("limit") {
        None | Some(Value::Null) => settings.limit,
        Some(limit) => limit
            .as_u64()
            .and_then(|limit| usize::try_from(limit).ok())
            .filter(|limit| (1..=settings.most).contains(limit))
            .ok_or_else(|| InputFault::new("limit", format!("a whole number from 1 to {}", settings.most)))?,
    };
    Ok(SearchInput { question, kind, limit })
}
