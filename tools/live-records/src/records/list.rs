// src/records/list.rs
//
// Purpose: `records:list { type, order?, prefix?, above?, below?, reverse?, limit?, after?, fields?, where? }` answers `{ records, next }`:
// the rows of one type in id order, greatest first unless `reverse` is false, within the ids `prefix`, `above` and `below` bound, a
// page at a time. `after` is a previous page's `next` (the id of the last row read).
//
// Non-Negotiable Invariants:
// - A page is cut before the row that would pass the message (`answer_bytes`); its `next` names the last row shown, so the next page
//   starts strictly after it and no row is skipped. A first row too big alone is shown alone and goes as byte pages.
// - Without `where`, `limit` bounds the rows read. With `where`, it bounds the rows shown: the answer reads on until `limit` rows match,
//   the ids walked reach `where_walk_most`, the time `walk_seconds` is spent or a message is full, and then names `next`: the last id read.
// - `next` is null only when the range is exhausted.
// - `order` (a declared order over a field) and `view` are not answered here; asking for them is refused, never ignored.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{closed, Records, Refusal};
use rows_store::store::{Bound, Range, Record};
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};

/// The bytes of an answer around its rows: `{"records":[],"next":null}` and the room for a long `next`.
const AROUND: usize = 600;

/// What a list call asked for, checked.
struct Query<'a> {
    kind: &'a str,
    range: Range,
    limit: usize,
    fields: Option<Vec<&'a str>>,
    wanted: Option<&'a Map<String, Value>>,
}

impl Records {
    pub(super) fn list(&self, input: &Map<String, Value>, started: Instant) -> Result<Value, Refusal> {
        closed(input, &["type", "order", "prefix", "above", "below", "reverse", "limit", "after", "fields", "where", "view"])?;
        let query = self.query(input)?;
        let scope = self.records_scope(query.kind);
        let bounds = &self.settings.bounds;
        let walk_until = started + Duration::from_secs(bounds.walk_seconds);
        let (mut shown, mut size) = (Vec::<Value>::new(), AROUND);
        let (mut range, mut walked, mut last_read) = (query.range.clone(), 0usize, None::<String>);
        let mut exhausted = false;
        'walk: loop {
            // Without `where` the page asked for is the page read; with it a chunk of the list is read and filtered.
            let chunk = if query.wanted.is_some() { bounds.list_walk.min(bounds.where_walk_most - walked) } else { query.limit };
            let page = self.store.list_range(&scope, &range, chunk)?;
            for (at, record) in page.items.iter().enumerate() {
                let matched = query.wanted.is_none_or(|wanted| matches_where(&record.value, wanted));
                if matched {
                    let row = project(record, query.fields.as_deref(), query.kind);
                    let row_bytes = serde_json::to_vec(&row).map_err(|_| Refusal::source())?.len() + 1;
                    if !shown.is_empty() && size + row_bytes > bounds.answer_bytes {
                        break 'walk;
                    }
                    size += row_bytes;
                    shown.push(row);
                }
                last_read = Some(record.id.clone());
                walked += 1;
                if shown.len() == query.limit {
                    exhausted = page.next.is_none() && at + 1 == page.items.len();
                    break 'walk;
                }
            }
            match page.next {
                None => {
                    exhausted = true;
                    break;
                }
                Some(next) => range = continue_after(range, &next),
            }
            if query.wanted.is_none() || walked >= bounds.where_walk_most || Instant::now() >= walk_until {
                break;
            }
        }
        // The page stopped with rows left unless the walk ran out of them with the last row it read: a chunk read to its end
        // that held no more is exhausted; every other stop is a place to go on from.
        let next = if exhausted { None } else { last_read };
        Ok(json!({"records": shown, "next": next}))
    }

    fn query<'a>(&self, input: &'a Map<String, Value>) -> Result<Query<'a>, Refusal> {
        let bounds = &self.settings.bounds;
        let kind = self.name_of(input, "type")?;
        // A declared order and a typed view are not served here.
        if !matches!(input.get("order"), None | Some(Value::Null)) || !matches!(input.get("view"), None | Some(Value::Bool(false)) | Some(Value::Null)) {
            return Err(Refusal::input());
        }
        let text = |field: &str| match input.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.as_str())),
            Some(_) => Err(Refusal::input()),
        };
        let reverse = match input.get("reverse") {
            None | Some(Value::Null) => true,
            Some(Value::Bool(reverse)) => *reverse,
            Some(_) => return Err(Refusal::input()),
        };
        let limit = match input.get("limit") {
            None | Some(Value::Null) => bounds.list_page,
            Some(limit) => limit.as_u64().and_then(|limit| usize::try_from(limit).ok()).filter(|limit| (1..=bounds.list_most).contains(limit)).ok_or_else(Refusal::input)?,
        };
        let mut range = Range::prefix(text("prefix")?.unwrap_or(""), reverse);
        if let Some(above) = text("above")? {
            range = tighten_lower(range, above, false);
        }
        if let Some(below) = text("below")? {
            range = tighten_upper(range, below, false);
        }
        if let Some(after) = text("after")? {
            range = continue_after(range, after);
        }
        let fields = match input.get("fields") {
            None | Some(Value::Null) => None,
            Some(Value::Array(names)) if names.len() <= bounds.names_most => Some(
                names.iter().map(|name| name.as_str().filter(|name| !name.is_empty()).ok_or_else(Refusal::input)).collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(Refusal::input()),
        };
        let wanted = match input.get("where") {
            None | Some(Value::Null) => None,
            Some(Value::Object(wanted)) if !wanted.is_empty() && wanted.len() <= bounds.names_most && wanted.keys().all(|name| !name.is_empty()) => Some(wanted),
            Some(_) => return Err(Refusal::input()),
        };
        Ok(Query { kind, range, limit, fields, wanted })
    }
}

/// `range` made to go on strictly after `id` in its own direction.
fn continue_after(range: Range, id: &str) -> Range {
    if range.reverse { tighten_upper(range, id, false) } else { tighten_lower(range, id, false) }
}

/// `range` with its lower end at `id` when that is tighter than the one it has.
fn tighten_lower(mut range: Range, id: &str, inclusive: bool) -> Range {
    let tighter = match &range.lower {
        None => true,
        Some(held) => id > held.id.as_str() || (id == held.id && held.inclusive && !inclusive),
    };
    if tighter {
        range.lower = Some(Bound { id: id.to_owned(), inclusive });
    }
    range
}

/// `range` with its upper end at `id` when that is tighter than the one it has.
fn tighten_upper(mut range: Range, id: &str, inclusive: bool) -> Range {
    let tighter = match &range.upper {
        None => true,
        Some(held) => id < held.id.as_str() || (id == held.id && held.inclusive && !inclusive),
    };
    if tighter {
        range.upper = Some(Bound { id: id.to_owned(), inclusive });
    }
    range
}

/// Whether a value holds every field `wanted` names, each equal as JSON to the value given.
fn matches_where(value: &Value, wanted: &Map<String, Value>) -> bool {
    wanted.iter().all(|(name, expected)| value.get(name) == Some(expected))
}

/// One row as the door lists it: id, type and value, the value narrowed to `fields` when they are named (and left out when they name none).
fn project(record: &Record, fields: Option<&[&str]>, kind: &str) -> Value {
    match fields {
        None => json!({"id": record.id, "type": kind, "value": record.value}),
        Some([]) => json!({"id": record.id, "type": kind}),
        Some(names) => {
            let value: Map<String, Value> = names.iter().filter_map(|name| record.value.get(*name).map(|field| ((*name).to_owned(), field.clone()))).collect();
            json!({"id": record.id, "type": kind, "value": value})
        }
    }
}
