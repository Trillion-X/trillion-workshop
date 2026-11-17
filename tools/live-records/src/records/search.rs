// src/records/search.rs
//
// Purpose: `records:search { question, type?, limit? }` answers `{ question, terms, results, unavailable, pending }`: the records whose
// text holds every asked word, each type ranked as its own lane (most recently changed first) and the lanes merged by reciprocal rank
// fusion, each result with its `score` and the `address` (a `records:read`) that opens it. With `type` only that type is answered; with
// none, every type the person holds.
//
// Non-Negotiable Invariants:
// - A record is a result only when every asked word starts a word of its text (the text of every string and number it holds): a
//   candidate the database offers for holding the word anywhere is checked against that, so "ca" finds "car" and not "scar".
// - A question's words are the distinct runs of letters and digits of at least `search_min_word_length` characters, lower-cased; a
//   question with none answers nothing.
// - The door's own address is the settings'; nothing here names it.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{closed, Records, Refusal};
use rows_store::store::Record;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

impl Records {
    pub(super) fn search(&self, input: &Map<String, Value>) -> Result<Value, Refusal> {
        closed(input, &["question", "type", "limit"])?;
        let bounds = &self.settings.bounds;
        let question: String = input.get("question").and_then(Value::as_str).ok_or_else(Refusal::input)?.chars().take(bounds.search_question_chars).collect();
        let limit = match input.get("limit") {
            None | Some(Value::Null) => bounds.search_limit,
            Some(limit) => limit.as_u64().and_then(|limit| usize::try_from(limit).ok()).filter(|limit| (1..=bounds.search_most).contains(limit)).ok_or_else(Refusal::input)?,
        };
        let terms = words(&question, bounds.search_min_word_length);
        let empty = |terms: &[String]| json!({"question": question, "terms": terms, "results": [], "unavailable": [], "pending": false});
        if terms.is_empty() {
            return Ok(empty(&terms));
        }
        let lanes: Vec<String> = match input.get("type") {
            None | Some(Value::Null) => {
                let prefix = &self.settings.scopes.records;
                self.store.scopes(prefix, bounds.writes_most * 64)?.into_iter().filter_map(|scope| scope.strip_prefix(prefix.as_str()).map(str::to_owned)).collect()
            }
            Some(_) => vec![self.name_of(input, "type")?.to_owned()],
        };
        let mut merged: BTreeMap<(String, String), (f64, Value)> = BTreeMap::new();
        for kind in &lanes {
            let candidates = self.store.find_text(&self.records_scope(kind), &terms, bounds.search_candidates)?;
            let mut rank = 0usize;
            for record in candidates {
                let text = text_of(&record.value);
                if !terms.iter().all(|term| words(&text, 1).iter().any(|word| word.starts_with(term.as_str()))) {
                    continue;
                }
                rank += 1;
                let score = 1.0 / (bounds.search_k + rank) as f64;
                let said = said_of(&text, &terms[0], bounds.search_said_characters);
                merged.insert((kind.clone(), record.id.clone()), (score, self.result_of(kind, &record, &said, score)));
            }
        }
        let mut ranked: Vec<_> = merged.into_iter().collect();
        ranked.sort_by(|(left_key, (left, _)), (right_key, (right, _))| right.total_cmp(left).then_with(|| left_key.cmp(right_key)));
        let results: Vec<Value> = ranked.into_iter().take(limit).map(|(_, (_, result))| result).collect();
        Ok(json!({"question": question, "terms": terms, "results": results, "unavailable": [], "pending": false}))
    }

    fn result_of(&self, kind: &str, record: &Record, said: &str, score: f64) -> Value {
        let title = self.settings.title_fields.iter().find_map(|field| record.value.get(field).and_then(Value::as_str));
        json!({
            "id": record.id, "type": kind, "title": title, "said": said, "found_in": "written",
            "places": [{"place": "written", "said": said}],
            "address": {"resource": self.settings.address, "operation": "records:read", "input": {"id": record.id, "type": kind}},
            "score": score,
        })
    }
}

/// The distinct words of `text`: runs of letters and digits of at least `shortest` characters, lower-cased, in the order they first appear.
fn words(text: &str, shortest: usize) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for word in text.split(|c: char| !c.is_alphanumeric()).filter(|word| word.chars().count() >= shortest) {
        let word = word.to_lowercase();
        if !seen.contains(&word) {
            seen.push(word);
        }
    }
    seen
}

/// Every string and number a value holds, joined by a space: the text a person reads in it.
fn text_of(value: &Value) -> String {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.clone()),
            Value::Number(number) => out.push(number.to_string()),
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            Value::Object(fields) => fields.values().for_each(|field| walk(field, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out.join(" ")
}

/// The words around the first place `word` starts a word of `text`, at most `most` characters.
fn said_of(text: &str, word: &str, most: usize) -> String {
    let lower = text.to_lowercase();
    let at = lower.match_indices(word).map(|(at, _)| at).find(|at| lower[..*at].chars().next_back().is_none_or(|before| !before.is_alphanumeric())).unwrap_or(0);
    let before = lower[..at].chars().count();
    text.chars().skip(before.saturating_sub(most / 4)).take(most).collect()
}
