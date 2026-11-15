// src/storage/record_store/find.rs
//
// Purpose: The records whose named fields hold every word asked, newest change first, each with its title: the first
// named field that holds words (old trillion `find`). It walks the scope's records along the `changed` order (the
// newest stamp first, every kind in one walk), reads a bounded number of records per call, and answers where to
// resume.
//
// Ported one to one from old trillion `parts/record-log/do-work/record-log-store.mjs:3691` `find({ words, fields,
// leaveOut, types, limit, budget, resume })` (tag old-trillion-before-worker-retire): each word matched, ignoring case,
// inside the JSON text of a named field's string (`JSON.stringify(text).toLocaleLowerCase().includes(term)`); a record
// matches when one named field does; the title is the first named field holding words, whitespace folded; `limit`
// 1..200 (30 when none); `budget` bounds the records examined; `next` resumes after the last record examined. The old
// walk merged one cursor per type, newest first; the `changed` order here is that same merge over every kind.
// Dropped: the old `typesKey` catalog of types (here a kind is the value's `kind_field`, read off each record).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{text, unavailable, validate, Bound, Order, Range, RecordStore, Storage, Value, Version, CURRENT, ROW, VERSIONS};
use crate::records::Error;

/// The most records one `find` answers, and its default (old `Math.min(200, ...)`, `limit = 30`).
pub const FIND_MOST: usize = 200;
pub const FIND_DEFAULT: usize = 30;
/// The records one walk step reads (old: 64 keys a cursor refill).
const STEP: usize = 64;

/// What `find` looks for.
#[derive(Clone, Debug, Default)]
pub struct Find<'a> {
    pub words: &'a [&'a str],
    /// Field-name paths, in title order.
    pub fields: &'a [&'a [&'a str]],
    pub leave_out: &'a [&'a str],
    pub kinds: Option<&'a [&'a str]>,
    pub limit: Option<usize>,
    /// At most this many records examined (None: until `limit` match or the scope ends).
    pub budget: Option<usize>,
    /// A previous answer's `next`.
    pub resume: Option<FindCursor>,
}
/// Where a find stopped: the stamp and id of the last record it examined.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindCursor {
    pub stamp: i64,
    pub id: String,
}
/// One record found, with its kind and title.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Titled {
    pub id: String,
    pub kind: Option<String>,
    pub title: String,
}

fn text_at<'v>(value: &'v serde_json::Value, path: &[&str]) -> Option<&'v str> {
    let mut at = value;
    for step in path {
        at = at.get(*step)?;
    }
    at.as_str()
}

impl<S: Storage> RecordStore<S> {
    /// Records whose named fields hold every word, newest change first (old `find`).
    pub fn find(&self, account: &str, resource: &str, query: &Find<'_>) -> Result<(Vec<Titled>, Option<FindCursor>), Error> {
        validate(account, resource, "find")?;
        if query.fields.is_empty() || !query.fields.iter().all(|path| !path.is_empty() && path.iter().all(|name| !name.is_empty())) {
            return Err(Error::Invalid("find needs fields: a list of field-name paths", crate::cause!()));
        }
        let page = query.limit.unwrap_or(FIND_DEFAULT).clamp(1, FIND_MOST);
        let looked = query.budget.unwrap_or(usize::MAX).max(1);
        let terms: Vec<String> = query.words.iter().map(|word| word.to_lowercase()).filter(|word| !word.is_empty()).collect();
        let scope = vec![text(account), text(resource)];
        let mut high = match &query.resume {
            Some(cursor) => Bound::Excluded([scope.as_slice(), &[Value::Integer(cursor.stamp)]].concat()),
            None => Bound::Included(scope.clone()),
        };
        let (mut out, mut examined, mut last) = (Vec::new(), 0usize, None);
        loop {
            let range = Range { order: Order::Named("changed"), from: high.clone(), to: Bound::Included(scope.clone()), reverse: true, limit: Some(STEP) };
            let rows = self.scan_rows(VERSIONS, &range, &ROW).map_err(unavailable)?;
            let full = rows.len() == STEP;
            for row in rows {
                if examined >= looked {
                    return Ok((out, last));
                }
                let version = Version::from_row(row, CURRENT)?;
                examined += 1;
                last = Some(FindCursor { stamp: version.valid_from, id: version.id.clone() });
                // A scope's stamps are unique (minted strictly rising), so the stamp alone is the walk's position.
                high = Bound::Excluded([scope.as_slice(), &[Value::Integer(version.valid_from)]].concat());
                if version.deleted {
                    continue;
                }
                let kind = version.kind.clone();
                if kind.as_deref().is_some_and(|kind| query.leave_out.contains(&kind)) || query.kinds.is_some_and(|kinds| !kind.as_deref().is_some_and(|kind| kinds.contains(&kind))) {
                    continue;
                }
                let Some(value) = version.value()? else { continue };
                let texts: Vec<Option<&str>> = query.fields.iter().map(|path| text_at(&value, path)).collect();
                let matches = texts.iter().flatten().any(|said| {
                    let quoted = serde_json::to_string(said).unwrap_or_default().to_lowercase();
                    !said.trim().is_empty() && terms.iter().all(|term| quoted.contains(term.as_str()))
                });
                if !matches {
                    continue;
                }
                let title = texts.iter().flatten().find(|said| !said.trim().is_empty()).map(|said| said.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_default();
                out.push(Titled { id: version.id, kind, title });
                if out.len() >= page {
                    return Ok((out, last));
                }
            }
            if !full {
                return Ok((out, None));
            }
        }
    }
}
