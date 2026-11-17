// src/store/ranges.rs
//
// Purpose: What a tool that keeps people's records (live-records) asks of the rows beyond what the files ask: a scope's rows in id order
// or the reverse within bounds (`Range`), several rows changed in one transaction, the scopes under a prefix, and the rows of a scope
// that hold every one of some words anywhere in their text. Each is one statement over the same tables as `Rows`, the same in SQLite and
// Postgres.
//
// Non-Negotiable Invariants:
// - Ids compare as bytes (the id column's own collation), so a bound and an order mean the same in both databases.
// - `mutate_all` changes every row or none: the first refusal rolls back the changes before it. The change order and each scope's stamp
//   move inside the same transaction, exactly as for one change.
// - A word is matched as a plain substring, lower-cased, with `%`, `_` and `\` taken literally.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{link::Cell, unavailable, Change, Error, Mutation, Page, Record, SqlStore, MAX_PAGE_BYTES, MAX_PAGE_ITEMS};

/// One end of a range of ids and whether the id it names is inside.
#[derive(Debug, Clone, PartialEq)]
pub struct Bound {
    pub id: String,
    pub inclusive: bool,
}

/// The ids of a scope a read covers and the way it walks them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Range {
    pub lower: Option<Bound>,
    pub upper: Option<Bound>,
    /// Greatest id first.
    pub reverse: bool,
}

impl Range {
    /// The ids that start with `prefix`: from it up to, not including, the first id that does not (none past it when it ends in the
    /// greatest character). An empty prefix is every id.
    pub fn prefix(prefix: &str, reverse: bool) -> Self {
        let mut upper = None;
        let mut text = prefix.to_owned();
        while let Some(last) = text.pop() {
            if let Some(next) = (last as u32 + 1..=char::MAX as u32).find_map(char::from_u32) {
                text.push(next);
                upper = Some(Bound { id: text, inclusive: false });
                break;
            }
        }
        Self { lower: (!prefix.is_empty()).then(|| Bound { id: prefix.to_owned(), inclusive: true }), upper, reverse }
    }
}

/// `text` as the pattern of a `LIKE ... ESCAPE '\'` that holds it anywhere, lower-cased.
fn contains(text: &str) -> String {
    let escaped: String = text.to_lowercase().chars().flat_map(|c| if matches!(c, '%' | '_' | '\\') { vec!['\\', c] } else { vec![c] }).collect();
    format!("%{escaped}%")
}

impl SqlStore {
    pub(super) fn range_page(&self, scope: &str, range: &Range, limit: usize) -> Result<Page<Record, String>, Error> {
        let limit = limit.clamp(1, MAX_PAGE_ITEMS);
        let (mut tail, mut params) = (String::new(), Vec::new());
        if let Some(bound) = &range.lower {
            tail.push_str(if bound.inclusive { " AND id >= ?" } else { " AND id > ?" });
            params.push(Cell::text(&bound.id));
        }
        if let Some(bound) = &range.upper {
            tail.push_str(if bound.inclusive { " AND id <= ?" } else { " AND id < ?" });
            params.push(Cell::text(&bound.id));
        }
        tail.push_str(if range.reverse { " ORDER BY id DESC LIMIT ?" } else { " ORDER BY id LIMIT ?" });
        params.push(Cell::int(limit as i64 + 1));
        let mut link = self.link.lock().map_err(unavailable)?;
        let rows = self.read_rows(&mut link, scope, &tail, &params)?;
        let mut items = Vec::new();
        let (mut bytes, mut more) = (0usize, false);
        for (record, _, _) in rows {
            let size = serde_json::to_vec(&record.value).map_err(unavailable)?.len();
            if items.len() == limit || (!items.is_empty() && bytes + size > MAX_PAGE_BYTES) {
                more = true;
                break;
            }
            bytes += size;
            items.push(record);
        }
        let next = more.then(|| items.last().map(|record| record.id.clone())).flatten();
        Ok(Page { items, next, serialized_item_bytes: bytes })
    }

    pub(super) fn mutate_all_in(&self, changes: &[(String, Mutation)]) -> Result<Vec<Change>, Error> {
        if changes.iter().any(|(_, input)| input.id.is_empty()) {
            return Err(Error::Invalid("a record has an id", crate::cause!()));
        }
        let mut link = self.link.lock().map_err(unavailable)?;
        link.begin()?;
        let mut done = Vec::with_capacity(changes.len());
        for (scope, input) in changes {
            match self.change(&mut link, scope, input) {
                Ok(change) => done.push(change),
                Err(error) => {
                    link.rollback();
                    return Err(error);
                }
            }
        }
        link.commit()?;
        drop(link);
        self.signal.beat();
        Ok(done)
    }

    pub(super) fn scopes_in(&self, prefix: &str, limit: usize) -> Result<Vec<String>, Error> {
        let bounds = Range::prefix(prefix, false);
        let (mut sql, mut params) = (format!("SELECT DISTINCT scope FROM {} WHERE scope >= ?", super::declared().generic), vec![Cell::text(prefix)]);
        if let Some(upper) = &bounds.upper {
            sql.push_str(" AND scope < ?");
            params.push(Cell::text(&upper.id));
        }
        sql.push_str(" ORDER BY scope LIMIT ?");
        params.push(Cell::int(limit as i64));
        let mut link = self.link.lock().map_err(unavailable)?;
        Ok(link.query(&sql, &params)?.iter().filter_map(|cells| cells[0].as_text()).collect())
    }

    pub(super) fn find_text_in(&self, scope: &str, words: &[String], hits: usize) -> Result<Vec<Record>, Error> {
        let (mut tail, mut params) = (String::new(), Vec::new());
        for word in words {
            tail.push_str(" AND LOWER(value) LIKE ? ESCAPE '\\'");
            params.push(Cell::text(&contains(word)));
        }
        tail.push_str(" ORDER BY changed DESC, id LIMIT ?");
        params.push(Cell::int(hits.clamp(1, MAX_PAGE_ITEMS) as i64));
        let mut link = self.link.lock().map_err(unavailable)?;
        Ok(self.read_rows(&mut link, scope, &tail, &params)?.into_iter().map(|(record, _, _)| record).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{RecordRows, Rows, SqlStore};
    use super::*;
    use serde_json::json;

    fn put(store: &SqlStore, scope: &str, id: &str, value: serde_json::Value) {
        let version = store.held_record_with_version(scope, id).unwrap().0;
        store.mutate(scope, Mutation { id: id.into(), expected_version: version, request_key: format!("k-{id}-{version}"), deleted: false, value }).unwrap();
    }

    #[test]
    fn a_prefix_is_a_range_that_ends_before_the_first_id_that_does_not_start_with_it() {
        assert_eq!(Range::prefix("ab", false).upper, Some(Bound { id: "ac".into(), inclusive: false }));
        assert_eq!(Range::prefix("a\u{10FFFF}", false).upper, Some(Bound { id: "b".into(), inclusive: false }));
        assert_eq!(Range::prefix("", true), Range { lower: None, upper: None, reverse: true });
    }

    #[test]
    fn rows_are_read_in_id_order_or_the_reverse_within_bounds_a_page_at_a_time() {
        let store = SqlStore::memory().unwrap();
        for id in ["a1", "a2", "a3", "b1", "b2"] {
            put(&store, "s", id, json!({ "n": id }));
        }
        let ids = |page: &Page<Record, String>| page.items.iter().map(|record| record.id.clone()).collect::<Vec<_>>();
        let page = store.list_range("s", &Range::prefix("a", true), 2).unwrap();
        assert_eq!((ids(&page), page.next.as_deref()), (vec!["a3".to_owned(), "a2".to_owned()], Some("a2")));
        let rest = Range { upper: Some(Bound { id: "a2".into(), inclusive: false }), ..Range::prefix("a", true) };
        assert_eq!(ids(&store.list_range("s", &rest, 2).unwrap()), vec!["a1".to_owned()]);
        let between = Range { lower: Some(Bound { id: "a1".into(), inclusive: false }), upper: Some(Bound { id: "b2".into(), inclusive: false }), reverse: false };
        assert_eq!(ids(&store.list_range("s", &between, 9).unwrap()), vec!["a2", "a3", "b1"]);
    }

    #[test]
    fn several_rows_change_together_or_not_at_all() {
        let store = SqlStore::memory().unwrap();
        put(&store, "s", "x", json!({ "n": 1 }));
        let new = |id: &str, version: i64| (String::from("s"), Mutation { id: id.into(), expected_version: version, request_key: "batch".into(), deleted: false, value: json!({ "n": 2 }) });
        assert!(store.mutate_all(&[new("y", 0), new("x", 5)]).is_err(), "a stale row refuses the whole batch");
        assert!(store.get("s", "y").unwrap().record.is_none(), "the row before the refusal was not kept");
        let done = store.mutate_all(&[new("y", 0), new("x", 1)]).unwrap();
        assert_eq!(done.len(), 2);
        assert_eq!(store.get("s", "x").unwrap().record.unwrap().value, json!({ "n": 2 }));
    }

    #[test]
    fn a_scope_is_searched_for_rows_holding_every_word_and_the_scopes_under_a_prefix_are_named() {
        let store = SqlStore::memory().unwrap();
        put(&store, "@r/a", "1", json!({ "title": "Red Boat 100%" }));
        put(&store, "@r/a", "2", json!({ "title": "red car" }));
        put(&store, "@r/b", "3", json!({ "title": "blue boat" }));
        put(&store, "@q/c", "4", json!({ "title": "red boat" }));
        let found = store.find_text("@r/a", &["RED".to_owned(), "boat".to_owned()], 10).unwrap();
        assert_eq!(found.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), vec!["1"]);
        assert_eq!(store.find_text("@r/a", &["100%".to_owned()], 10).unwrap().len(), 1, "a percent sign is only itself");
        assert_eq!(store.find_text("@r/a", &["1_0".to_owned()], 10).unwrap().len(), 0, "an underscore is only itself");
        assert_eq!(store.scopes("@r/", 10).unwrap(), vec!["@r/a".to_owned(), "@r/b".to_owned()]);
    }
}
