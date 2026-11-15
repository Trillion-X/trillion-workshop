// src/account_rights/share_grant/reach.rs
//
// Purpose: A key-free, read-only share of a mixed collection of the sharer's typed records, beside the `record` and
// `grant` shapes of `share_grant`. The sharer's sharing record (`<record_prefix><label>`) holds `reach` — entries of a record
// kind and, at most, one exact id or one id prefix — with the people (and the link) allowed to look, each by the BLAKE3 of
// the bearer the sharer handed them. Nothing is sealed in the vault and no key of the sharer takes part: the engine reads the
// sharer's records in its own process, as the account's owner, bounded to exactly the entries of the one open sharing record
// that names the bearer's digest now. The DATA is `door_grant.reach` in share-grant.json beside this folder.
//
// Non-Negotiable Invariants:
// - A sharing record is a reach share only when it holds `reach` and neither `record` nor `grant`, every entry is well formed
//   (a non-empty kind, and an id or a prefix, never both, never empty) and there are 1 to `most_items` of them; anything else
//   is no share at all, never a share of part of it.
// - A bearer reaches a collection only through exactly one sharing record whose `people` name its digest now and that is
//   open now (published, not revoked, not expired, `can` holding the link's view): `Grants::collection` is called on the
//   sharing records read for this very call, so removing a person, revoking or expiring ends the next read.
// - A door read is admitted only inside an entry: a read of one record names exactly `read_fields`, its kind an entry's and its
//   id that entry's (any id for a kind entry, the exact id, or an id starting with the prefix); a list names only
//   `list_fields`, its kind an entry's and its prefix starting with the entry's prefix (an exact-id entry answers no list).
//   Every other operation or field is outside the reach.
// - The answer names no sharing record, no key and no person: only `{id, type, value}` of records the entries cover, and it
//   stops at the DATA bounds, saying `truncated`.
// - The page runs no script and loads nothing; every value is escaped; its one style block carries the response's own nonce.
//
// Key Concepts:
// - `Collection`: one reach share a bearer reaches now (its label, words and entries).
// - `Collection::covers`: whether one door read lies inside the reach.
// - `Collection::answer`: the collection's records, read through the caller's `ask` (the owner's in-process reader).
// - `Grants::page`: the same answer as a read-only page with its response policy.
//
// Security Considerations:
// - Whether a kind may leave this computer is the reader's decision (the owner's records reads refuse a kind that stays on
//   this computer to a remote reader); a refusal from `ask` makes the whole share answer nothing.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{Grants, Refusal};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

/// `door_grant.reach` of share-grant.json.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReachData {
    #[serde(rename = "_what")]
    _what: String,
    most_items: usize,
    most_records: usize,
    most_bytes: usize,
    most_seconds: u64,
    page_rows: usize,
    read_fields: Vec<String>,
    list_fields: Vec<String>,
    definitions: Vec<Definition>,
    page: PageData,
}

/// A record kind that holds the definition of another kind (`door_grant.reach.definitions`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    #[serde(rename = "_what")]
    _what: String,
    kind: String,
    rows_kind_prefix: String,
    rows_kind_field: String,
    label_field: String,
    fields_field: String,
    field_id: String,
    field_label: String,
    title_field: String,
    /// The key of a field's kind, and the kinds whose values are days.
    field_kind: String,
    date_kinds: Vec<String>,
    views_field: String,
    view: ViewData,
}

/// How a definition's saved view is written (`door_grant.reach.definitions[].view`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewData {
    #[serde(rename = "_what")]
    _what: String,
    label: String,
    rules: String,
    sort: String,
    sort_field: String,
    sort_direction: String,
    sort_descending: String,
    groups: String,
    group_field: String,
    /// Where the totals a view asks for are, as the keys down to their list of measures.
    totals_path: Vec<String>,
}

/// The read-only page's words and look (`door_grant.reach.page`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageData {
    #[serde(rename = "_what")]
    _what: String,
    language: String,
    read_only: String,
    nothing: String,
    truncated: String,
    empty_cell: String,
    id_column: String,
    id_head: String,
    id_cell: String,
    kind_title: String,
    document: String,
    about_line: String,
    note_line: String,
    plain_line: String,
    heading: String,
    table: String,
    column: String,
    row: String,
    cell: String,
    policy: String,
    style: String,
    view_section: String,
    view_group: String,
    view_group_heading: String,
    view_count_one: String,
    view_count: String,
    view_notice: String,
    view_totals_notice: String,
    view_unsupported_notice: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Scope {
    Kind,
    Id(String),
    Prefix(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    kind: String,
    scope: Scope,
}

/// One reach share a bearer reaches now.
#[derive(Clone, Debug)]
pub struct Collection {
    label: String,
    title: String,
    about: Option<String>,
    changed: Option<String>,
    entries: Vec<Entry>,
}

/// What one read of the reach came to, as the caller's reader says it (`Collection::answer`), and what the whole answer came
/// to: the records, a part of the reach the reader would not read (the share answers nothing), or a read that could not be
/// made now.
#[derive(Clone, Debug, PartialEq)]
pub enum Read {
    Records(Value),
    OutsideReach,
    CannotRead,
}

/// A read-only page and the policy its response carries.
pub struct Page {
    pub html: String,
    pub content_security_policy: String,
}

impl Entry {
    fn parse(entry: &Value) -> Option<Self> {
        let fields = entry.as_object()?;
        if fields.keys().any(|key| !matches!(key.as_str(), "type" | "id" | "prefix")) {
            return None;
        }
        let text = |key: &str| match fields.get(key) {
            None => Some(None),
            Some(Value::String(text)) if !text.is_empty() => Some(Some(text.clone())),
            Some(_) => None,
        };
        let kind = text("type")??;
        let scope = match (text("id")?, text("prefix")?) {
            (None, None) => Scope::Kind,
            (Some(id), None) => Scope::Id(id),
            (None, Some(prefix)) => Scope::Prefix(prefix),
            (Some(_), Some(_)) => return None,
        };
        Some(Self { kind, scope })
    }
}

impl Grants {
    /// The one open reach share `bearer` reaches in the sharer's sharing records `sharing`, at `now`; None for a bearer that
    /// reaches none or more than one, a closed share, or a record that is not a well formed reach share.
    pub fn collection(&self, sharing: &BTreeMap<String, Value>, bearer: &[u8], now: DateTime<Utc>) -> Option<Collection> {
        let digest = self.digest(bearer)?;
        let mut found = sharing.iter().filter_map(|(label, value)| {
            let shared = label.strip_prefix(self.record_prefix.as_str())?;
            if shared.is_empty() || shared.starts_with(self.record_prefix.as_str()) {
                return None;
            }
            let named = value.get("people")?.as_array()?.iter().any(|person| {
                person.get("key_blake3").and_then(Value::as_str) == Some(digest.as_str())
            });
            if !named || value.get("record").is_some() || value.get("grant").is_some() || !self.open_public(value, now) {
                return None;
            }
            let reach = value.get("reach")?.as_array()?;
            if reach.is_empty() || reach.len() > self.reach.most_items {
                return None;
            }
            let entries = reach.iter().map(Entry::parse).collect::<Option<Vec<_>>>()?;
            let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
            Some(Collection {
                label: shared.to_owned(),
                title: text("title").unwrap_or_default(),
                about: text("about"),
                changed: text("changed_at"),
                entries,
            })
        });
        let (Some(collection), None) = (found.next(), found.next()) else {
            return None;
        };
        Some(collection)
    }
}

impl Grants {
    /// How long one collection answer may take in all (each read in it has the records door's own bound).
    pub fn reach_seconds(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.reach.most_seconds)
    }
}

impl Collection {
    /// The label of the sharing record, after the record prefix.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Every record kind this share reaches, once each.
    pub fn kinds(&self) -> Vec<&str> {
        let mut kinds: Vec<&str> = self.entries.iter().map(|entry| entry.kind.as_str()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        kinds
    }

    /// Whether `other` reaches the same records (the title and words may change under a call; the reach may not).
    pub fn same_reach(&self, other: &Collection) -> bool {
        self.label == other.label && self.entries == other.entries
    }

    /// Whether a door read lies inside the reach: `listing` says a list of one kind, otherwise a read of one record. The
    /// input names exactly `read_fields` or only `list_fields` (and, to list, its `type`), and falls inside an entry.
    pub fn covers(&self, grants: &Grants, listing: bool, input: &Value) -> bool {
        let Some(fields) = input.as_object() else { return false };
        let allowed = if listing { &grants.reach.list_fields } else { &grants.reach.read_fields };
        if fields.keys().any(|key| !allowed.contains(key)) {
            return false;
        }
        let text = |key: &str| fields.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
        let Some(kind) = text("type") else { return false };
        if listing {
            let fits = |key: &str, shape: fn(&Value) -> bool| fields.get(key).is_none_or(shape);
            if !(fits("prefix", Value::is_string) && fits("after", Value::is_string) && fits("limit", Value::is_u64)) {
                return false;
            }
            let prefix = text("prefix");
            self.entries.iter().any(|entry| entry.kind == kind && match &entry.scope {
                Scope::Kind => true,
                Scope::Prefix(start) => prefix.is_some_and(|prefix| prefix.starts_with(start.as_str())),
                Scope::Id(_) => false,
            })
        } else {
            let Some(id) = text("id") else { return false };
            fields.len() == allowed.len()
                && self.entries.iter().any(|entry| entry.kind == kind && match &entry.scope {
                    Scope::Kind => true,
                    Scope::Id(exact) => exact == id,
                    Scope::Prefix(start) => id.starts_with(start.as_str()),
                })
        }
    }

    /// The collection's answer, its records read through `ask(listing, input)` (a door read or list, answered as the door
    /// answers it): `{kind: "collection", title, about, changed, items: [{id, type, value}], truncated}`. A record read
    /// that is absent is left out; the first read the reader will not make or cannot make is the answer instead. The answer stops at `most_records` records or `most_bytes` bytes of values.
    pub fn answer(&self, grants: &Grants, mut ask: impl FnMut(bool, Value) -> Read) -> Read {
        let bounds = &grants.reach;
        let (mut items, mut bytes, mut truncated) = (Vec::<Value>::new(), 0usize, false);
        let take = |record: &Value, items: &mut Vec<Value>, bytes: &mut usize| -> bool {
            let (Some(id), Some(kind)) = (record.get("id").and_then(Value::as_str), record.get("type").and_then(Value::as_str)) else {
                return true;
            };
            let value = record.get("value").cloned().unwrap_or(Value::Null);
            let size = value.to_string().len();
            if items.len() >= bounds.most_records || *bytes + size > bounds.most_bytes {
                return false;
            }
            *bytes += size;
            items.push(json!({"id": id, "type": kind, "value": value}));
            true
        };
        'entries: for entry in &self.entries {
            match &entry.scope {
                Scope::Id(id) => {
                    let record = match ask(false, json!({"id": id, "type": entry.kind})) {
                        Read::Records(record) => record,
                        other => return other,
                    };
                    if record.get("type").and_then(Value::as_str) == Some(entry.kind.as_str()) && !take(&record, &mut items, &mut bytes) {
                        truncated = true;
                        break 'entries;
                    }
                }
                scope => {
                    let mut after: Option<String> = None;
                    loop {
                        let mut input = Map::new();
                        input.insert("type".into(), json!(entry.kind));
                        if let Scope::Prefix(prefix) = scope {
                            input.insert("prefix".into(), json!(prefix));
                        }
                        input.insert("limit".into(), json!(bounds.page_rows));
                        if let Some(after) = &after {
                            input.insert("after".into(), json!(after));
                        }
                        let page = match ask(true, Value::Object(input)) {
                            Read::Records(page) => page,
                            other => return other,
                        };
                        for record in page.get("records").and_then(Value::as_array).into_iter().flatten() {
                            if !take(record, &mut items, &mut bytes) {
                                truncated = true;
                                break 'entries;
                            }
                        }
                        match page.get("next").and_then(Value::as_str) {
                            Some(next) => after = Some(next.to_owned()),
                            None => break,
                        }
                    }
                }
            }
        }
        Read::Records(json!({"kind": "collection", "title": self.title, "about": self.about, "changed": self.changed,
            "items": items, "truncated": truncated}))
    }
}

/// `&`, `<`, `>`, `"` and `'` as entities: the only way a value enters the page.
fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// A cell: text as it is, a list of texts joined, anything else as its JSON text.
fn cell(value: &Value, empty: &str) -> String {
    match value {
        Value::Null => empty.to_owned(),
        Value::String(text) => text.clone(),
        Value::Array(parts) if parts.iter().all(Value::is_string) => {
            parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
        }
        other => other.to_string(),
    }
}

/// One table: its heading, the columns `(id, label)` and the rows' values.
struct Table<'a> {
    heading: String,
    columns: Vec<(String, String)>,
    rows: Vec<(&'a str, &'a Value)>,
    /// Whether the record id leads each row: not when the definition's title field leads the columns in its place.
    id_leads: bool,
    /// The definition's own fields and saved views, and the columns that hold days.
    fields: Vec<Value>,
    views: Vec<&'a Value>,
    days: Vec<String>,
    /// The definition that drew this table, for how its views are written.
    definition: Option<usize>,
}

impl Table<'_> {
    fn head(&self, data: &PageData) -> (String, String) {
        let columns: String = self.columns.iter().map(|(_, label)| filled(&data.column, &[("text", &escaped(label))])).collect();
        let id_head = if self.id_leads { filled(&data.id_head, &[("text", &escaped(&data.id_column))]) } else { String::new() };
        (id_head, columns)
    }

    fn row_html(&self, id: &str, value: &Value, data: &PageData) -> String {
        let cells: String = self.columns.iter()
            .map(|(column, _)| {
                let shown = value.get(column).unwrap_or(&Value::Null);
                let text = if self.days.contains(column) { day(shown).unwrap_or_else(|| cell(shown, &data.empty_cell)) } else { cell(shown, &data.empty_cell) };
                filled(&data.cell, &[("text", &escaped(&text))])
            })
            .collect();
        let id_cell = if self.id_leads { filled(&data.id_cell, &[("text", &escaped(id))]) } else { String::new() };
        filled(&data.row, &[("id_cell", &id_cell), ("cells", &cells)])
    }

    fn html(&self, data: &PageData) -> String {
        let (id_head, columns) = self.head(data);
        let rows: String = self.rows.iter().map(|(id, value)| self.row_html(id, value, data)).collect();
        filled(&data.table, &[("heading", &escaped(&self.heading)), ("id_head", &id_head), ("columns", &columns), ("rows", &rows)])
    }
}

/// The plain date of a day or a timestamp that starts with one; None for any other value.
fn day(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let rest = text.get(10..)?;
    (super::is_day(text) && (rest.is_empty() || rest.starts_with(['T', ' ']))).then(|| text[..10].to_owned())
}

/// The order of two values under a view's sort: numbers by size, texts by their letters, anything else by its JSON text;
/// a missing value is after every other, whichever way the sort runs.
fn order(left: &Value, right: &Value, descending: bool) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (left_none, right_none) = (left.is_null(), right.is_null());
    if left_none || right_none {
        return left_none.cmp(&right_none);
    }
    let ordering = match (left.as_f64(), right.as_f64(), left.as_str(), right.as_str()) {
        (Some(a), Some(b), _, _) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
        (_, _, Some(a), Some(b)) => a.cmp(b),
        _ => left.to_string().cmp(&right.to_string()),
    };
    if descending { ordering.reverse() } else { ordering }
}

/// `template` with each `{name}` replaced by its value in `values`, in one pass: a value is never searched for names, so
/// a value that looks like a name stays as it is. A `{name}` no value names is kept.
fn filled(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}').and_then(|close| values.iter().find(|(name, _)| *name == &after[..close]).map(|(_, value)| (close, *value))) {
            Some((close, value)) => {
                out.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// What decides which rows a saved view's rules let through: the engine's own rules compiler and evaluator, behind this so
/// the page stays pure over values.
pub trait ViewMatcher {
    /// For each of `rows` (record values) whether it passes `rules` (a saved view's rules tree) over the list's `fields`;
    /// None when the rules cannot be applied (an operator the compiler cannot map, an incomplete tree).
    fn matches(&mut self, rules: &Value, fields: &[Value], rows: &[&Value]) -> Option<Vec<bool>>;
}

/// The matcher of a place that has no rules engine: every view with rules is a notice.
pub struct NoViews;

impl ViewMatcher for NoViews {
    fn matches(&mut self, _rules: &Value, _fields: &[Value], _rows: &[&Value]) -> Option<Vec<bool>> {
        None
    }
}

/// The page's words a test may check a page against.
#[cfg(test)]
pub struct PageWords {
    pub view_totals_notice: String,
    pub view_unsupported_notice: String,
}

impl Grants {
    /// The notices the page prints in place of what it does not show.
    #[cfg(test)]
    pub fn page_words(&self) -> PageWords {
        PageWords { view_totals_notice: self.reach.page.view_totals_notice.clone(), view_unsupported_notice: self.reach.page.view_unsupported_notice.clone() }
    }

    /// The collection answer of `Collection::answer` as a read-only page. None for an answer that is not a collection's.
    pub fn page(&self, answer: &Value, matcher: &mut dyn ViewMatcher) -> Result<Option<Page>, Refusal> {
        if answer.get("kind").and_then(Value::as_str) != Some("collection") {
            return Ok(None);
        }
        let data = &self.reach.page;
        let items: Vec<&Value> = answer.get("items").and_then(Value::as_array).into_iter().flatten().collect();
        let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
        // A definition's rows are drawn under it with its columns; every other kind is one table of its own, columns in the
        // order its values first show them.
        let mut tables: Vec<Table> = Vec::new();
        let mut defined: BTreeMap<String, usize> = BTreeMap::new();
        for item in &items {
            let kind = text(item, "type");
            let Some(definition) = self.reach.definitions.iter().find(|definition| definition.kind == kind) else { continue };
            let value = item.get("value").unwrap_or(&Value::Null);
            let Some(row_type) = value.get(&definition.rows_kind_field).and_then(Value::as_str) else { continue };
            let mut columns: Vec<(String, String)> = value.get(&definition.fields_field).and_then(Value::as_array).into_iter().flatten()
                .filter_map(|field| {
                    let id = field.get(&definition.field_id)?.as_str()?;
                    let label = field.get(&definition.field_label).and_then(Value::as_str).unwrap_or(id);
                    Some((id.to_owned(), label.to_owned()))
                })
                .collect();
            // The list's own title field leads its rows in place of the record id.
            let titled = value.get(&definition.title_field).and_then(Value::as_str)
                .and_then(|title| columns.iter().position(|(id, _)| id == title));
            if let Some(at) = titled {
                let lead = columns.remove(at);
                columns.insert(0, lead);
            }
            let id_leads = titled.is_none();
            let fields: Vec<Value> = value.get(&definition.fields_field).and_then(Value::as_array).cloned().unwrap_or_default();
            let days: Vec<String> = fields.iter()
                .filter(|field| field.get(&definition.field_kind).and_then(Value::as_str).is_some_and(|kind| definition.date_kinds.iter().any(|date| date == kind)))
                .filter_map(|field| field.get(&definition.field_id).and_then(Value::as_str).map(str::to_owned))
                .collect();
            let views: Vec<&Value> = value.get(&definition.views_field).and_then(Value::as_array).into_iter().flatten().collect();
            let heading = value.get(&definition.label_field).and_then(Value::as_str).map_or_else(|| text(item, "id"), str::to_owned);
            defined.insert(format!("{}{row_type}", definition.rows_kind_prefix), tables.len());
            tables.push(Table { heading, columns, rows: Vec::new(), id_leads, fields, views, days, definition: self.reach.definitions.iter().position(|each| each.kind == kind) });
        }
        let mut loose: BTreeMap<String, usize> = BTreeMap::new();
        for item in &items {
            let kind = text(item, "type");
            if self.reach.definitions.iter().any(|definition| definition.kind == kind) {
                continue;
            }
            let value = item.get("value").unwrap_or(&Value::Null);
            let at = match (defined.get(&kind), loose.get(&kind)) {
                (Some(at), _) | (None, Some(at)) => *at,
                (None, None) => {
                    tables.push(Table { heading: data.kind_title.replace("{kind}", &kind), columns: Vec::new(), rows: Vec::new(), id_leads: true, fields: Vec::new(), views: Vec::new(), days: Vec::new(), definition: None });
                    loose.insert(kind.clone(), tables.len() - 1);
                    tables.len() - 1
                }
            };
            if !defined.contains_key(&kind) {
                if let Some(fields) = value.as_object() {
                    for key in fields.keys() {
                        if !tables[at].columns.iter().any(|(id, _)| id == key) {
                            tables[at].columns.push((key.clone(), key.clone()));
                        }
                    }
                }
            }
            tables[at].rows.push((item.get("id").and_then(Value::as_str).unwrap_or(""), value));
        }
        let mut nonce = [0u8; 18];
        SystemRandom::new().fill(&mut nonce).map_err(|error| crate::carry_cause!(Refusal::Unavailable, error))?;
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let title = answer.get("title").and_then(Value::as_str).unwrap_or("");
        let mut body = filled(&data.heading, &[("text", &escaped(title))]);
        if let Some(about) = answer.get("about").and_then(Value::as_str).filter(|about| !about.is_empty()) {
            body.push_str(&filled(&data.about_line, &[("text", &escaped(about))]));
        }
        body.push_str(&filled(&data.note_line, &[("text", &escaped(&data.read_only))]));
        if tables.is_empty() {
            body.push_str(&filled(&data.plain_line, &[("text", &escaped(&data.nothing))]));
        }
        for table in &tables {
            body.push_str(&table.html(data));
            for view in &table.views {
                if let Some(definition) = table.definition.and_then(|at| self.reach.definitions.get(at)) {
                    body.push_str(&self.view_html(table, view, definition, matcher));
                }
            }
        }
        if answer.get("truncated").and_then(Value::as_bool) == Some(true) {
            body.push_str(&filled(&data.note_line, &[("text", &escaped(&data.truncated))]));
        }
        let html = filled(&data.document, &[("language", &escaped(&data.language)), ("title", &escaped(title)),
            ("nonce", &nonce), ("style", &data.style), ("body", &body)]);
        Ok(Some(Page { html, content_security_policy: filled(&data.policy, &[("nonce", &nonce)]) }))
    }

    /// One saved view as its own section under its list: the list's rows its rules let through (decided by `matcher`),
    /// sorted by the view's sort and in a group for each value of the view's group fields, each group with the number of
    /// its rows. A view that asks for totals says they are not shown; a view the matcher cannot apply says so and draws no row.
    fn view_html(&self, table: &Table, view: &Value, definition: &Definition, matcher: &mut dyn ViewMatcher) -> String {
        let data = &self.reach.page;
        let keys = &definition.view;
        let label = view.get(&keys.label).and_then(Value::as_str).unwrap_or("");
        let mut notices = String::new();
        let mut totals_path = view;
        for key in &keys.totals_path {
            totals_path = totals_path.get(key).unwrap_or(&Value::Null);
        }
        if totals_path.as_array().is_some_and(|measures| !measures.is_empty()) {
            notices.push_str(&filled(&data.view_notice, &[("text", &escaped(&data.view_totals_notice))]));
        }
        let rows: Vec<&(&str, &Value)> = table.rows.iter().collect();
        let values: Vec<&Value> = rows.iter().map(|(_, value)| *value).collect();
        let passes = match view.get(&keys.rules).filter(|rules| !rules.is_null()) {
            Some(rules) => matcher.matches(rules, &table.fields, &values),
            None => Some(vec![true; rows.len()]),
        }.filter(|passes| passes.len() == rows.len());
        let Some(passes) = passes else {
            notices.push_str(&filled(&data.view_notice, &[("text", &escaped(&data.view_unsupported_notice))]));
            return filled(&data.view_section, &[("heading", &escaped(label)), ("notices", &notices), ("groups", "")]);
        };
        let mut kept: Vec<&(&str, &Value)> = rows.into_iter().zip(passes).filter_map(|(row, keep)| keep.then_some(row)).collect();
        let sorts: Vec<(&str, bool)> = view.get(&keys.sort).and_then(Value::as_array).into_iter().flatten()
            .filter_map(|sort| Some((sort.get(&keys.sort_field)?.as_str()?, sort.get(&keys.sort_direction).and_then(Value::as_str) == Some(keys.sort_descending.as_str()))))
            .collect();
        kept.sort_by(|(_, left), (_, right)| sorts.iter().map(|(field, descending)| {
            order(left.get(*field).unwrap_or(&Value::Null), right.get(*field).unwrap_or(&Value::Null), *descending)
        }).find(|ordering| ordering.is_ne()).unwrap_or(std::cmp::Ordering::Equal));
        let by: Vec<&str> = view.get(&keys.groups).and_then(Value::as_array).into_iter().flatten()
            .filter_map(|group| group.get(&keys.group_field).and_then(Value::as_str)).collect();
        let mut groups: BTreeMap<String, Vec<&(&str, &Value)>> = BTreeMap::new();
        for row in kept {
            let name = by.iter().map(|field| cell(row.1.get(*field).unwrap_or(&Value::Null), &data.empty_cell)).collect::<Vec<_>>().join(", ");
            groups.entry(name).or_default().push(row);
        }
        let (id_head, columns) = table.head(data);
        let drawn: String = groups.iter().map(|(name, rows)| {
            let heading = if by.is_empty() { String::new() } else { filled(&data.view_group_heading, &[("text", &escaped(name))]) };
            let count = if rows.len() == 1 { data.view_count_one.clone() } else { filled(&data.view_count, &[("count", &rows.len().to_string())]) };
            let rows: String = rows.iter().map(|(id, value)| table.row_html(id, value, data)).collect();
            filled(&data.view_group, &[("heading", &heading), ("count", &escaped(&count)), ("id_head", &id_head), ("columns", &columns), ("rows", &rows)])
        }).collect();
        filled(&data.view_section, &[("heading", &escaped(label)), ("notices", &notices), ("groups", &drawn)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEARER: &[u8] = b"shr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn grants() -> &'static Grants {
        Grants::shipped().expect("share-grant.json door_grant")
    }
    /// The shipped DATA with `most_records` and `most_bytes` replaced, to see the bounds stop an answer.
    fn bounded(most_records: usize, most_bytes: usize) -> Grants {
        let mut data: Value = serde_json::from_slice(super::super::DATA).unwrap();
        data["door_grant"]["reach"]["most_records"] = json!(most_records);
        data["door_grant"]["reach"]["most_bytes"] = json!(most_bytes);
        serde_json::from_value::<super::super::Data>(data).unwrap().door_grant
    }
    fn digest_of(bearer: &[u8]) -> String {
        content_crypto::advanced::blake3::hash(bearer).to_hex().to_string()
    }
    /// A sharing record's value naming `bearer`, with `patch` laid over it.
    fn record(reach: Value, patch: Value) -> Value {
        let mut record = json!({"reach": reach, "title": "T", "can": ["view"], "changed_at": "x",
            "people": [{"principal": "p", "key_blake3": digest_of(BEARER)}]});
        record.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        record
    }
    fn sharing(value: Value) -> BTreeMap<String, Value> {
        BTreeMap::from([(format!("{}week", grants().record_prefix), value)])
    }
    fn collection(reach: Value) -> Collection {
        // Any bearer whose digest the record names; the digest is computed from the same bytes `Grants::digest` hashes.
        let bearer = format!("shr_{}", URL_SAFE_NO_PAD.encode([0u8; 32]));
        let record = record(reach, json!({"people": [{"principal": "p", "key_blake3": digest_of(bearer.as_bytes())}]}));
        grants().collection(&sharing(record), bearer.as_bytes(), Utc::now()).expect("an open reach share")
    }

    #[test]
    fn a_reach_share_is_one_open_well_formed_record_naming_the_bearer() {
        let bearer = format!("shr_{}", URL_SAFE_NO_PAD.encode([0u8; 32]));
        let named = json!([{"principal": "p", "key_blake3": digest_of(bearer.as_bytes())}]);
        let reach = json!([{"type": "a"}]);
        let now = Utc::now();
        let open = |patch: Value| {
            let mut value = record(reach.clone(), json!({"people": named}));
            value.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            grants().collection(&sharing(value), bearer.as_bytes(), now).is_some()
        };
        assert!(open(json!({})));
        for (why, patch) in [
            ("revoked", json!({"revoked_at": "2020-01-01T00:00:00Z"})),
            ("expired", json!({"expires_at": "2020-01-01T00:00:00Z"})),
            ("unpublished", json!({"published": false})),
            ("no view", json!({"can": []})),
            ("another person", json!({"people": [{"principal": "p", "key_blake3": digest_of(b"other")}]})),
            ("also a record", json!({"record": "x"})),
            ("also a grant", json!({"grant": {}})),
            ("no entry", json!({"reach": []})),
            ("a text entry", json!({"reach": ["a"]})),
            ("an empty kind", json!({"reach": [{"type": ""}]})),
            ("an id and a prefix", json!({"reach": [{"type": "a", "id": "i", "prefix": "p"}]})),
            ("an unknown field", json!({"reach": [{"type": "a", "where": {}}]})),
            ("an empty id", json!({"reach": [{"type": "a", "id": ""}]})),
            ("too many entries", json!({"reach": vec![json!({"type": "a"}); grants().reach.most_items + 1]})),
        ] {
            assert!(!open(patch), "{why}");
        }
        // A bearer two records name reaches none; a label that is itself a sharing label is no share.
        let value = record(reach.clone(), json!({"people": named}));
        let mut twice = sharing(value.clone());
        twice.insert(format!("{}other", grants().record_prefix), value.clone());
        assert!(grants().collection(&twice, bearer.as_bytes(), now).is_none());
        let nested = BTreeMap::from([(format!("{0}{0}x", grants().record_prefix), value)]);
        assert!(grants().collection(&nested, bearer.as_bytes(), now).is_none());
        assert!(grants().collection(&sharing(record(reach, json!({"people": named}))), b"shr_not-a-bearer", now).is_none());
    }

    #[test]
    fn a_door_read_is_covered_only_inside_an_entry_with_only_the_declared_fields() {
        let reach = collection(json!([{"type": "list", "id": "list:a"}, {"type": "row", "prefix": "row:a:"}, {"type": "text"}]));
        let (read, list) = (false, true);
        let yes = |listing, input: Value| reach.covers(grants(), listing, &input);
        assert!(yes(read, json!({"id": "list:a", "type": "list"})));
        assert!(yes(read, json!({"id": "row:a:1", "type": "row"})));
        assert!(yes(read, json!({"id": "anything", "type": "text"})));
        assert!(yes(list, json!({"type": "row", "prefix": "row:a:b", "limit": 5, "after": "c"})));
        assert!(yes(list, json!({"type": "text"})));
        assert!(!yes(read, json!({"id": "list:b", "type": "list"})));
        assert!(!yes(read, json!({"id": "row:b:1", "type": "row"})));
        assert!(!yes(read, json!({"id": "list:a", "type": "row"})));
        assert!(!yes(read, json!({"id": "list:a"})));
        assert!(!yes(read, json!({"id": "list:a", "type": "list", "at": 1})));
        assert!(!yes(read, json!("list:a")));
        assert!(!yes(list, json!({"type": "list"})), "an exact-id entry answers no list");
        assert!(!yes(list, json!({"type": "row"})), "a prefix entry answers no list of the whole kind");
        assert!(!yes(list, json!({"type": "row", "prefix": "row:"})));
        assert!(!yes(list, json!({"type": "row", "prefix": "row:a:", "where": {}})));
        assert!(!yes(list, json!({"type": "text", "limit": "5"})));
        assert!(!yes(list, json!({"prefix": "row:a:"})));
        assert_eq!(reach.kinds(), ["list", "row", "text"]);
    }

    #[test]
    fn an_answer_pages_each_entry_and_stops_at_its_bounds() {
        let reach = collection(json!([{"type": "list", "id": "list:a"}, {"type": "row", "prefix": "row:"}]));
        let rows = |from: u32, to: u32| (from..to).map(|n| json!({"id": format!("row:{n}"), "type": "row", "value": {"n": n}})).collect::<Vec<_>>();
        let mut asked = Vec::new();
        let read = |asked: &mut Vec<Value>, listing: bool, input: Value| {
            asked.push(json!({"listing": listing, "input": input.clone()}));
            if !listing {
                return Read::Records(json!({"id": "list:a", "type": "list", "value": {"label": "L"}}));
            }
            match input.get("after").and_then(Value::as_str) {
                None => Read::Records(json!({"records": rows(0, 3), "next": "c"})),
                Some(_) => Read::Records(json!({"records": rows(3, 5), "next": null})),
            }
        };
        let Read::Records(answer) = reach.answer(grants(), |listing, input| read(&mut asked, listing, input)) else { panic!("answered") };
        assert_eq!(answer["items"].as_array().unwrap().len(), 6, "{answer}");
        assert_eq!((answer["kind"].as_str(), answer["truncated"].as_bool()), (Some("collection"), Some(false)));
        assert_eq!(asked.len(), 3, "a read, then two pages: {asked:?}");
        assert_eq!(asked[1]["input"], json!({"type": "row", "prefix": "row:", "limit": grants().reach.page_rows}));
        assert_eq!(asked[2]["input"]["after"], "c");
        let few = bounded(4, usize::MAX);
        let Read::Records(cut) = reach.answer(&few, |listing, input| read(&mut Vec::new(), listing, input)) else { panic!("answered") };
        assert_eq!((cut["items"].as_array().unwrap().len(), cut["truncated"].as_bool()), (4, Some(true)), "{cut}");
        let small = bounded(usize::MAX, 20);
        let Read::Records(cut) = reach.answer(&small, |listing, input| read(&mut Vec::new(), listing, input)) else { panic!("answered") };
        assert_eq!(cut["truncated"], true, "{cut}");
        assert!(cut["items"].as_array().unwrap().len() < 6);
        // A part the reader refuses or cannot read is the answer: nothing of the rest is shown.
        assert_eq!(reach.answer(grants(), |_, _| Read::OutsideReach), Read::OutsideReach);
        assert_eq!(reach.answer(grants(), |listing, _| if listing { Read::CannotRead } else { Read::Records(json!({"type": null})) }), Read::CannotRead);
    }

    #[test]
    fn the_page_draws_a_definition_with_its_own_labels_and_escapes_every_value() {
        let answer = json!({"kind": "collection", "title": "<b>T&C</b>", "about": "\"quoted\" 'single'", "truncated": true, "items": [
            {"id": "list:a", "type": "list", "value": {"label": "A <list>", "row_type": "row", "fields": [{"id": "x", "label": "X <col>"}, {"id": "y"}]}},
            {"id": "row:1", "type": "record:row", "value": {"x": "<script>alert(1)</script>", "y": ["a", "b"], "z": "hidden"}},
            {"id": "n:1", "type": "n", "value": {"text": "hi", "count": 3}}]});
        let page = grants().page(&answer, &mut NoViews).unwrap().expect("a collection page");
        let html = &page.html;
        assert!(html.contains("<title>&lt;b&gt;T&amp;C&lt;/b&gt;</title>") && html.contains("&quot;quoted&quot; &#39;single&#39;"), "{html}");
        assert!(html.contains("<h2>A &lt;list&gt;</h2>") && html.contains("<th>X &lt;col&gt;</th>") && html.contains("<th>y</th>"), "{html}");
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;") && html.contains("<td>a, b</td>") && !html.contains("hidden"), "{html}");
        assert!(html.contains("<h2>n</h2>") && html.contains("<th>count</th>") && html.contains("<td>3</td>"), "{html}");
        assert!(html.contains(&grants().reach.page.truncated) && html.contains(&grants().reach.page.read_only), "{html}");
        assert!(!html.contains("<script") && !html.contains("<b>"), "{html}");
        let nonce = page.content_security_policy.split("'nonce-").nth(1).unwrap().split('\'').next().unwrap().to_owned();
        assert!(html.contains(&format!("nonce=\"{nonce}\"")) && page.content_security_policy.starts_with("default-src 'none'"));
        let other = grants().page(&answer, &mut NoViews).unwrap().unwrap();
        assert_ne!(other.content_security_policy, page.content_security_policy, "a fresh nonce for each response");
        // A list's own title field leads its rows in place of the record id.
        let titled = json!({"kind": "collection", "title": "T", "items": [
            {"id": "list:a", "type": "list", "value": {"label": "A", "row_type": "row", "title_field": "y", "fields": [{"id": "x", "label": "X"}, {"id": "y", "label": "Y"}]}},
            {"id": "record:row:1", "type": "record:row", "value": {"x": "ex", "y": "why"}}]});
        let html = grants().page(&titled, &mut NoViews).unwrap().unwrap().html;
        assert!(html.contains("<thead><tr><th>Y</th><th>X</th></tr></thead>") && html.contains("<tr><td>why</td><td>ex</td></tr>") && !html.contains("record:row:1"), "{html}");
        assert!(grants().page(&json!({"kind": "list"}), &mut NoViews).unwrap().is_none());
        assert!(grants().page(&json!({"kind": "collection", "title": "T", "items": []}), &mut NoViews).unwrap().unwrap().html.contains(&grants().reach.page.nothing));
    }

    /// A matcher that keeps the rows whose `kind` value is one of the first rule's `values`, or none when told it cannot.
    struct Stub {
        works: bool,
        asked: usize,
    }
    impl ViewMatcher for Stub {
        fn matches(&mut self, rules: &Value, _fields: &[Value], rows: &[&Value]) -> Option<Vec<bool>> {
            self.asked += 1;
            if !self.works {
                return None;
            }
            let values = rules["rules"][0]["params"]["values"].as_array().cloned().unwrap_or_default();
            Some(rows.iter().map(|row| values.contains(&row["kind"])).collect())
        }
    }

    fn viewed() -> Value {
        let view = json!({"id": "v", "label": "By category <purchases>", "rules": {"kind": "group", "combinator": "and", "negate": false,
            "rules": [{"kind": "rule", "field": "kind", "operator": "is_any_of", "params": {"values": ["purchase"]}}]},
            "groups": [{"field": "category"}], "sort": [{"field": "date", "direction": "desc"}],
            "display": {"as": "table", "settings": {"totals": {"group_by": "category", "measures": [{"op": "count"}, {"field": "amount", "op": "sum"}]}}}});
        let row = |n: u32, kind: &str, category: &str, date: &str| json!({"id": format!("record:tx:{n}"), "type": "record:tx",
            "value": {"kind": kind, "category": category, "date": date, "amount": 12.5}});
        json!({"kind": "collection", "title": "T", "items": [
            {"id": "list:tx", "type": "list", "value": {"label": "Transactions", "row_type": "tx", "views": [view], "fields": [
                {"id": "date", "label": "Date", "kind": "date"}, {"id": "kind", "label": "Kind", "kind": "choice"},
                {"id": "category", "label": "Category", "kind": "choice"}, {"id": "amount", "label": "Amount", "kind": "number"}]}},
            row(1, "purchase", "Food", "2026-01-05T14:30:00Z"), row(2, "payment", "Food", "2026-01-09"),
            row(3, "purchase", "Food", "2026-02-01"), row(4, "purchase", "Auto", "2026-03-01T00:00:00.000Z")]})
    }

    #[test]
    fn a_saved_view_is_its_own_table_filtered_sorted_and_grouped_with_counts_only() {
        let mut stub = Stub { works: true, asked: 0 };
        let html = grants().page(&viewed(), &mut stub).unwrap().unwrap().html;
        assert_eq!(stub.asked, 1, "the matcher is asked once for the view");
        assert!(html.contains("By category &lt;purchases&gt;") && !html.contains("<purchases>"), "{html}");
        let view = html.split("By category &lt;purchases&gt;").nth(1).expect("the view's own section");
        // Filtered: the payment row is not in the view; grouped by category, a group heading with its row count.
        let food = view.find("Food").expect("a Food group");
        let auto = view.find("Auto").expect("an Auto group");
        assert!(auto < food, "groups in key order: {view}");
        assert!(view.contains("2 rows") && view.contains("1 row"), "{view}");
        assert!(!view.contains("2026-01-09"), "the payment is filtered out: {view}");
        // Sorted by date, newest first, inside the group.
        assert!(view.find("2026-02-01").unwrap() < view.find("2026-01-05").unwrap(), "{view}");
        // Dates are plain dates, in the list's own table too.
        assert!(html.contains("<td>2026-01-05</td>") && !html.contains("T14:30:00Z") && !html.contains("T00:00:00.000Z"), "{html}");
        // Totals are not shown: a notice says so, and the amounts are never summed.
        assert!(view.contains(&grants().reach.page.view_totals_notice) && !view.contains("25"), "{view}");
    }

    #[test]
    fn a_view_the_matcher_cannot_apply_is_a_notice_and_never_a_guess() {
        let mut stub = Stub { works: false, asked: 0 };
        let html = grants().page(&viewed(), &mut stub).unwrap().unwrap().html;
        let view = html.split("By category &lt;purchases&gt;").nth(1).expect("the view's own section");
        assert!(view.contains(&grants().reach.page.view_unsupported_notice), "{view}");
        assert!(!view.contains("2026-02-01") && !view.contains("rows"), "no rows drawn for a view that cannot be applied: {view}");
        assert!(html.contains("<td>2026-02-01</td>"), "the list's own table is still there: {html}");
    }
}
