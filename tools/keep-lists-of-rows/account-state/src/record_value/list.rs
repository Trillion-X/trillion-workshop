// src/record_value/list.rs
//
// Purpose: The one generic list read tools call. A tool names, as its own DATA, the record kind it lists, a declared
// record store order (src/storage/record_store/settings.json `orders`), a range of order values and a page size; the engine answers the
// logical records in that range, in order, and the cursor past the page. No tool's record prefix, order, field,
// split or page size lives here.
//
// Non-Negotiable Invariants:
// - Order values are the ordered field's ECMA JSON text compared by UTF-16 code unit, then by id, exactly as the
//   store keys its order rows (`storage::record_store::orders`). Range bounds are ECMA JSON texts in that same comparison.
// - A row is in range when its order value starts with `prefix` (when given), is strictly above `above` and strictly
//   below `below` (when given). The walk stops at the first value past the range, so a page costs the rows shown plus
//   one look past them, whatever the order holds.
// - Every row is opened through `record_value::read` (fresh key state, sealed fields, erasure), never from the
//   order row's stored body. A row whose kind differs from the query's kind refuses the page (`Invalid`).
// - One page walks at most MAX_LIST_WALK positions; a short page with `next` is a page cut there, not the end.
// - Cursor rule: the cursor is the exact position of the last row walked (its order value and id, or its id alone),
//   and the next page starts strictly after it; equal order values are one run broken by id. Every position the walk
//   passes is either shown or refuses the page: a listed live id (a live order row, a live id of the kind) that reads as
//   missing, or as another kind, refuses the page (`Source`) instead of being left out while the cursor moves past it.
//   Leaving it out was how a page skipped rows a later read found: the walk lists ids from where they are kept, and the
//   read opens each id where the account's route directory says it is (`OwnRead::stored`), so a row the two disagree
//   on vanished from every page and from every count made from the pages (measured 2026-11-04 on 40,700 check rows).
//   A refusal is a retryable failure the caller sees (the door answers it as its source being unavailable).
// - Order rows and record reads are one supply (`OrderedSupply`), held under the caller's admission and witness.
//
// Key Concepts:
// - `ListQuery`: kind, order, `ListRange`, direction, page size and continuation cursor. No order lists the kind by
//   id, greatest first (the store's live-kind walk, `CurrentIds`); its range bounds are id texts, not JSON texts.
// - `ListPage`: the logical records shown and the cursor past them (none when the range is exhausted).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{read, CurrentIds, Error, Limits, LogicalRecord, OpenPolicy, Result, Supply};
use crate::storage::record_store::{orders, settings, OrderCursor, Ordered};

/// The most rows one list page may show (the store's page bound).
pub const MAX_LIST_ROWS: usize = crate::records::MAX_PAGE_ITEMS - 1;
/// The most order rows or ids one list page walks. Past it the page ends at the last position walked, so a run of
/// tombstoned ids costs a bounded page, not an unbounded walk.
pub const MAX_LIST_WALK: usize = crate::records::MAX_PAGE_ITEMS;

/// A supply that also pages a declared order and walks a kind's ids: the account's own records.
pub trait OrderedSupply: Supply + CurrentIds {
    /// Bind derived indexes to the same installed model that opens this read. A supply without derived indexes
    /// needs no setup; account stores override this before either reads or writes use the parts index.
    fn set_model(&mut self, _model: &crate::record_model_policy::Installed) -> Result<()> {
        Ok(())
    }
    /// One bounded page of the existing reverse-part index, in whole-holder order. It proposes candidates only;
    /// the logical consumer opens and checks each holder under current policy before answering it.
    fn referrers(
        &mut self,
        _target: &str,
        _role: Option<&str>,
        _after: Option<&str>,
        _limit: usize,
    ) -> Result<crate::storage::record_store::referrers::Referrers> {
        Err(crate::cause!(Error::Source))
    }
    /// The settings DATA of the store the orders are declared in.
    fn settings(&self) -> &'static settings::Settings;
    /// One page of `order`, greatest first when `reverse`, strictly past `cursor`.
    fn ordered(
        &mut self,
        order: &str,
        cursor: Option<&OrderCursor>,
        reverse: bool,
        limit: usize,
    ) -> Result<Ordered>;
    /// The ids of live records whose searched words hold `word` (the store's word index, `RecordStore::search`, fed at write
    /// time), newest change first, at most `limit` (1..=1000). The door's search proposes candidates from it and
    /// checks each against its opened value. A supply that keeps no index answers `Source`.
    fn search_ids(&mut self, word: &str, limit: usize) -> Result<Vec<String>> {
        let _ = (word, limit);
        Err(crate::cause!(Error::Source))
    }
    /// Whether the word index is still walking the rows written before it existed (`RecordStore::search_walk`): a
    /// search then names its records lane `pending`, since an older row may not be proposed yet. A supply that keeps no walk
    /// has none pending.
    fn search_pending(&mut self) -> Result<bool> {
        Ok(false)
    }
}

/// A records-list source that can bind a complete generic walk to source-owned revisions.
///
/// The native owner implements `query_witness` from its complete resource/catalog/model/schema read. A query consumer
/// uses `complete_query` around its whole pagination loop; it never builds the witness from the page's returned rows.
pub trait QueryWitnessSupply: OrderedSupply + crate::record_value::query_witness::Source {}

impl<T> QueryWitnessSupply for T where T: OrderedSupply + crate::record_value::query_witness::Source {}

/// Capture and recheck one complete list-derived query around every internal page.
///
/// The closure must return `Incomplete` if any continuation remains or any declared walk bound prevented a complete
/// result. No witness is returned on incomplete pagination, source refusal, or any revision change during the walk.
/// A caller retaining the result passes its witness to the write owner, which validates it under the same current query
/// authority before starting effects.
pub fn complete_query<S, T>(
    supply: &mut S,
    binding: &crate::record_value::query_witness::QueryBinding,
    query: impl FnOnce(&mut S) -> Result<crate::record_value::query_witness::QueryResult<T>>,
) -> Result<crate::record_value::query_witness::Witnessed<T>>
where
    S: QueryWitnessSupply,
{
    crate::record_value::query_witness::complete_query(supply, binding, query)
}

/// A range of order values, each bound an ECMA JSON text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListRange {
    /// Only values whose JSON text starts with this text.
    pub prefix: Option<String>,
    /// Only values strictly above this text.
    pub above: Option<String>,
    /// Only values strictly below this text.
    pub below: Option<String>,
}

/// One list read, as a tool declares it.
#[derive(Clone, Debug)]
pub struct ListQuery<'a> {
    /// The record kind every listed record has.
    pub kind: &'a str,
    /// A declared record store order covering `kind`; none lists `kind` by id, greatest first only.
    pub order: Option<&'a str>,
    pub range: ListRange,
    /// Greatest value first.
    pub reverse: bool,
    /// Rows to show, 1..=MAX_LIST_ROWS.
    pub limit: usize,
    /// Order positions or ids to walk before returning a continuation, 1..=MAX_LIST_WALK.
    pub walk_limit: usize,
    /// Continue strictly past this position (a previous page's `next`).
    pub after: Option<OrderCursor>,
}

/// One list page: the records shown, in order, and the position past them while the range holds more.
#[derive(Debug)]
pub struct ListPage {
    pub rows: Vec<LogicalRecord>,
    pub next: Option<OrderCursor>,
    /// Order positions or ids walked, including tombstones. The door uses this to bound one streamed answer.
    pub walked: usize,
}

fn units(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

/// The position in `order` of the live record `id` of kind `kind`: a continuation a tool rebuilds from a row it showed
/// (its page carried only the row's id). None when the record is absent, of another kind, or outside the order.
pub fn position_of(
    supply: &mut impl OrderedSupply,
    kind: &str,
    order: &str,
    id: &str,
) -> Result<Option<OrderCursor>> {
    let declared = declared(supply.settings(), order, kind)?;
    let Some(stored) = supply.stored(id)? else {
        return Ok(None);
    };
    if stored.record_type != kind {
        return Ok(None);
    }
    let value = orders::value_of(
        declared,
        Some(kind),
        &crate::storage::record_store::native::body(&stored),
    )
    .map_err(|error| crate::carry_cause!(Error::InvalidStored, error))?;
    Ok(value.map(|value| OrderCursor {
        value,
        id: id.to_owned(),
    }))
}

/// The declared order that lists `kind` by the top-level field `field` first, if one is declared (a first path of
/// `[field]`, or `["stored", field]` as the native seam keeps a record's value), and the text every order value of a
/// row whose field equals `wanted` starts with: the field's ECMA JSON text, and for an order that lists by further
/// fields the opening `[` and the `,` after it. A row whose field is another value of the same text start (a number
/// `1` among `10`) is also in that run, so a reader still checks the field it asked for. None when no order is
/// declared for the field or `wanted` is not a single value (text, number, true, false or null).
pub fn order_for_field<'a>(
    settings: &'static settings::Settings,
    kind: &str,
    field: &str,
    wanted: &serde_json::Value,
) -> Option<(&'static str, String)> {
    if wanted.is_array() || wanted.is_object() {
        return None;
    }
    let declared = settings.orders.iter().find(|declared| {
        declared
            .kind
            .as_deref()
            .is_none_or(|covered| covered == kind)
            && (declared.path == [field]
                || declared
                    .path
                    .iter()
                    .map(String::as_str)
                    .eq(["stored", field]))
    })?;
    let bytes = orders::field_value(wanted).ok()?;
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    let text = String::from_utf16(&units).ok()?;
    let prefix = if declared.then.is_empty() {
        text
    } else {
        format!("[{text},")
    };
    Some((declared.order.as_str(), prefix))
}

/// The declared order `order` of `settings`, which must cover `kind`.
fn declared(
    settings: &'static settings::Settings,
    order: &str,
    kind: &str,
) -> Result<&'static orders::Declared> {
    let declared = settings
        .orders
        .iter()
        .find(|declared| declared.order == order)
        .ok_or(crate::cause!(Error::Invalid))?;
    if declared
        .kind
        .as_deref()
        .is_some_and(|covered| covered != kind)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    Ok(declared)
}

/// The order value of `text` as a cursor that sorts before every id of that value (`""`) or after every id of it.
fn edge(value: Vec<u8>, after_every_id: bool) -> OrderCursor {
    OrderCursor {
        value,
        id: if after_every_id {
            String::from("\u{10FFFF}")
        } else {
            String::new()
        },
    }
}

/// Where the walk starts: the continuation, else the range's near edge, else the order's end.
fn start(query: &ListQuery<'_>) -> Option<OrderCursor> {
    if let Some(after) = &query.after {
        return Some(after.clone());
    }
    let prefix = query.range.prefix.as_deref().map(units);
    if query.reverse {
        // Greatest first: start just below `below`, or just above every value carrying the prefix.
        let below = query
            .range
            .below
            .as_deref()
            .map(|below| edge(units(below), false));
        let over_prefix = prefix.map(|mut value| {
            value.extend([0xff, 0xff, 0xff]);
            edge(value, true)
        });
        match (below, over_prefix) {
            (Some(below), Some(over)) => Some(if below.value <= over.value {
                below
            } else {
                over
            }),
            (below, over) => below.or(over),
        }
    } else {
        // Least first: start just above `above`, or just below every value carrying the prefix.
        let above = query
            .range
            .above
            .as_deref()
            .map(|above| edge(units(above), true));
        let under_prefix = prefix.map(|value| edge(value, false));
        match (above, under_prefix) {
            (Some(above), Some(under)) => Some(if above.value >= under.value {
                above
            } else {
                under
            }),
            (above, under) => above.or(under),
        }
    }
}

/// Whether `value` is inside the range on the side the walk moves toward (the near side is the start cursor).
fn inside(range: &ListRange, reverse: bool, value: &[u8]) -> bool {
    if let Some(prefix) = &range.prefix {
        if !value.starts_with(&units(prefix)) {
            return false;
        }
    }
    let past = if reverse {
        range.above.as_deref()
    } else {
        range.below.as_deref()
    };
    past.is_none_or(|bound| {
        let bound = units(bound);
        if reverse {
            value > bound.as_slice()
        } else {
            value < bound.as_slice()
        }
    })
}

/// Read one page of `query` from `supply`, every row opened under `policy` within `limits`.
pub fn list(
    supply: &mut impl OrderedSupply,
    query: &ListQuery<'_>,
    policy: &OpenPolicy,
    limits: Limits,
) -> Result<ListPage> {
    if query.kind.is_empty()
        || !(1..=MAX_LIST_ROWS).contains(&query.limit)
        || !(1..=MAX_LIST_WALK).contains(&query.walk_limit)
    {
        return Err(crate::cause!(Error::Invalid));
    }
    let Some(order) = query.order else {
        return list_by_id(supply, query, policy, limits);
    };
    let declared = declared(supply.settings(), order, query.kind)?;
    let mut cursor = start(query);
    let mut rows = Vec::with_capacity(query.limit);
    let mut walked = 0usize;
    loop {
        if walked >= query.walk_limit {
            return Ok(ListPage {
                rows,
                next: cursor,
                walked,
            });
        }
        // One look past the page tells a full last page from more rows.
        let request = (query.limit + 1 - rows.len()).min(query.walk_limit - walked);
        let page = supply.ordered(order, cursor.as_ref(), query.reverse, request)?;
        let more_in_store = page.next.is_some();
        for record in page.records {
            walked += 1;
            let value = orders::value_of(declared, Some(query.kind), &record.value)
                .map_err(|error| crate::carry_cause!(Error::InvalidStored, error))?
                .ok_or(crate::cause!(Error::InvalidStored))?;
            if !inside(&query.range, query.reverse, &value) {
                return Ok(ListPage {
                    rows,
                    next: None,
                    walked,
                });
            }
            if rows.len() == query.limit {
                // An in-range row past a full page: continue after the last row shown.
                return Ok(ListPage {
                    rows,
                    next: cursor,
                    walked,
                });
            }
            // A live order row names a live record: one that reads as missing is a source that moved under the walk.
            let shown = read(&record.id, supply, policy, limits)?.ok_or(crate::cause!(Error::Source))?;
            if shown.record_type() != query.kind {
                return Err(crate::cause!(Error::Invalid));
            }
            cursor = Some(OrderCursor {
                value,
                id: record.id,
            });
            rows.push(shown);
        }
        if !more_in_store {
            return Ok(ListPage {
                rows,
                next: None,
                walked,
            });
        }
    }
}

/// `list` with no order: the kind's live ids, greatest first, strictly below the continuation (`after.id`) or the
/// range's upper edge, stopping at the first id outside the range. A tombstoned id the walk meets is skipped.
fn list_by_id(
    supply: &mut impl OrderedSupply,
    query: &ListQuery<'_>,
    policy: &OpenPolicy,
    limits: Limits,
) -> Result<ListPage> {
    if !query.reverse {
        return Err(crate::cause!(Error::Invalid));
    }
    let range = &query.range;
    let over_prefix = range
        .prefix
        .as_ref()
        .map(|prefix| format!("{prefix}\u{10FFFF}"));
    let mut before = match (&query.after, range.below.as_ref(), over_prefix) {
        (Some(after), _, _) => Some(after.id.clone()),
        (None, Some(below), Some(over)) => Some(if below.as_str() <= over.as_str() {
            below.clone()
        } else {
            over
        }),
        (None, below, over) => below.cloned().or(over),
    };
    let in_range = |id: &str| {
        range
            .prefix
            .as_deref()
            .is_none_or(|prefix| id.starts_with(prefix))
            && range.above.as_deref().is_none_or(|above| id > above)
    };
    let mut rows = Vec::with_capacity(query.limit);
    let mut walked = 0usize;
    loop {
        if walked >= query.walk_limit {
            let last = before.ok_or(crate::cause!(Error::Source))?;
            return Ok(ListPage {
                rows,
                next: Some(OrderCursor {
                    value: Vec::new(),
                    id: last,
                }),
                walked,
            });
        }
        let request = (query.limit + 1 - rows.len()).min(query.walk_limit - walked);
        let (ids, next) = supply.ids_of_type(query.kind, before.as_deref(), request)?;
        for id in ids {
            if !in_range(&id) {
                return Ok(ListPage {
                    rows,
                    next: None,
                    walked,
                });
            }
            walked += 1;
            if rows.len() == query.limit {
                let last = before.take().ok_or(crate::cause!(Error::Source))?;
                return Ok(ListPage {
                    rows,
                    next: Some(OrderCursor {
                        value: Vec::new(),
                        id: last,
                    }),
                    walked,
                });
            }
            // A live id of the kind names a live record of that kind: one that reads as missing, or as another kind, is a
            // source that moved under the walk (or a route that names another source for it). The page refuses rather
            // than leave the row out while its cursor moves past it.
            let shown = read(&id, supply, policy, limits)?.ok_or(crate::cause!(Error::Source))?;
            if shown.record_type() != query.kind {
                return Err(crate::cause!(Error::Source));
            }
            before = Some(id);
            rows.push(shown);
        }
        if next.is_none() {
            return Ok(ListPage {
                rows,
                next: None,
                walked,
            });
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    //! The list read over a real record store (in-memory supply, the shipped settings plus two test orders), prefilled
    //! directly with stored forms through `Records::mutate`; no old-engine fixture.
    use super::*;
    use crate::{
        legacy_records::StoredRecord,
        record_value::{CurrentKeys, KeyState},
        records::{Mutation, Records},
        storage::{
            memory::Memory,
            record_store::{native, orders::Declared, RecordStore, RealClock},
        },
    };
    use serde_json::json;

    const ACCOUNT: &str = "account";
    const RESOURCE: &str = "own-records";
    /// Tasks by `facts.open`, then `time`: the field `open` sits after `time` inside `facts` in every prefill.
    const BY_OPEN_THEN_TIME: &str = "test order by open then time";
    const BY_PARENT: &str = "test order by parent";

    fn test_settings() -> &'static settings::Settings {
        let mut settings = settings::shipped().unwrap().clone();
        let stored = |field: &str| vec![String::from("stored"), field.to_owned()];
        settings.orders.push(Declared {
            why: "list tests".into(),
            order: BY_OPEN_THEN_TIME.into(),
            kind: Some("task".into()),
            path: vec!["stored".into(), "facts".into(), "open".into()],
            then: vec![stored("time")],
            carry: Vec::new(),
        });
        settings.orders.push(Declared {
            why: "list tests".into(),
            order: BY_PARENT.into(),
            kind: Some("note".into()),
            path: stored("parent"),
            then: Vec::new(),
            carry: Vec::new(),
        });
        Box::leak(Box::new(settings))
    }

    /// The sandbox store the list and door tests read: in memory by default, or over any other supply (`with_supply`,
    /// SQLite in the door's paging tests), so a read is proven on the supply an account keeps.
    pub(crate) struct Prefilled<S: crate::storage::Storage + Send = Memory> {
        pub(crate) store: RecordStore<S>,
        pub(crate) domain: Option<serde_json::Value>,
        written: usize,
        schemas: std::collections::BTreeMap<String, crate::storage::kind_views::KindSchema>,
        /// Ids the walk lists but the record read does not find (`hide`): a route that names another source for them.
        hidden: std::collections::BTreeSet<String>,
        /// Records opened through `Supply::stored` since the sandbox was made: what a read cost, counted exactly.
        pub(crate) opened: usize,
        /// Whether `ordered` fills an order before answering it (the default) or answers as a store does whose order
        /// is still being filled by idle upkeep: refused (`Invalid`), as `OwnRead` maps the store's refusal.
        pub(crate) fills_orders: bool,
    }
    impl Prefilled {
        pub(crate) fn new() -> Self {
            Self::with_supply(Memory::open("record_store").unwrap())
        }
    }
    impl<S: crate::storage::Storage + Send> Prefilled<S> {
        /// The sandbox over `supply` (a `record_store` schema), with the shipped settings and the two test orders.
        pub(crate) fn with_supply(supply: S) -> Self {
            let settings = test_settings();
            let limits = crate::storage::record_store::settings::Limits::fixed(1 << 20, 10 << 30);
            let store = RecordStore::with_settings(supply, Box::new(RealClock), settings, limits)
                .unwrap();
            Self {
                store,
                domain: None,
                written: 0,
                schemas: Default::default(),
                hidden: Default::default(),
                opened: 0,
                fills_orders: true,
            }
        }
        /// From now on `id` is listed (by id and in every order) but reads as missing, as a record whose route names
        /// another source does at a routed read.
        pub(crate) fn hide(&mut self, id: &str) {
            self.hidden.insert(id.to_owned());
        }
        /// The typed schema `kind` answers (what its schema history would fold to).
        pub(crate) fn schema(
            &mut self,
            kind: &str,
            fields: &[(&str, crate::storage::kind_views::FieldType)],
        ) {
            let fields = fields
                .iter()
                .map(|(name, typed)| ((*name).to_owned(), *typed))
                .collect();
            self.schemas.insert(
                kind.to_owned(),
                crate::storage::kind_views::KindSchema {
                    fields,
                    indexes: Default::default(),
                },
            );
        }
        /// A new record, or a new version of an existing one (compare-and-set at the held version).
        pub(crate) fn put(&mut self, id: &str, kind: &str, value: serde_json::Value) {
            self.write(id, kind, value);
        }
        /// Destroy the record: its versions leave history, a tombstone stays.
        pub(crate) fn destroy(&mut self, id: &str) {
            self.store.erase(ACCOUNT, RESOURCE, id).unwrap();
        }
        fn write(&mut self, id: &str, kind: &str, value: serde_json::Value) {
            self.written += 1;
            let stored = StoredRecord {
                id: id.into(),
                record_type: kind.into(),
                sequence: format!("seq-{}", self.written),
                value_json: value.to_string(),
                meta_json: None,
                protected_key_present: false,
            };
            let expected_version = self.store.held_version(ACCOUNT, RESOURCE, id).unwrap();
            self.store
                .mutate(
                    ACCOUNT,
                    RESOURCE,
                    Mutation {
                        id: id.into(),
                        expected_version,
                        request_key: format!("prefill-{id}-{}", self.written),
                        deleted: false,
                        value: native::body(&stored),
                    },
                )
                .unwrap();
        }
        pub(crate) fn remove(&mut self, id: &str) {
            let version = self
                .store
                .get(ACCOUNT, RESOURCE, id)
                .unwrap()
                .record
                .unwrap()
                .version;
            self.store
                .mutate(
                    ACCOUNT,
                    RESOURCE,
                    Mutation {
                        id: id.into(),
                        expected_version: version,
                        request_key: format!("remove-{id}"),
                        deleted: true,
                        value: serde_json::Value::Null,
                    },
                )
                .unwrap();
        }
    }
    impl<S: crate::storage::Storage + Send> crate::storage::kind_views::KindSchemas for Prefilled<S> {
        fn kind_schema(
            &mut self,
            kind: &str,
        ) -> crate::record_value::Result<Option<crate::storage::kind_views::KindSchema>> {
            Ok(self.schemas.get(kind).cloned())
        }
    }
    impl<S: crate::storage::Storage + Send> CurrentKeys for Prefilled<S> {
        fn assert_current(&mut self) -> Result<()> {
            Ok(())
        }
        fn key(&mut self, _owner_id: &str) -> Result<KeyState> {
            Ok(KeyState::Missing)
        }
    }
    impl<S: crate::storage::Storage + Send> Supply for Prefilled<S> {
        fn record_domain(&self) -> Option<serde_json::Value> { self.domain.clone() }
        fn stored(&mut self, id: &str) -> Result<Option<StoredRecord>> {
            if self.hidden.contains(id) {
                return Ok(None);
            }
            self.opened += 1;
            let read = self
                .store
                .get(ACCOUNT, RESOURCE, id)
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            read.record
                .map(|record| {
                    native::stored_form(id, &record.value).map_err(|error| crate::carry_cause!(Error::InvalidStored, error))
                })
                .transpose()
        }
    }
    impl<S: crate::storage::Storage + Send> crate::record_value::history::VersionSupply
        for Prefilled<S>
    {
        fn versions(
            &mut self,
            id: &str,
            before: Option<i64>,
            limit: usize,
        ) -> Result<crate::record_value::history::StoredHistory> {
            let page = self
                .store
                .history(ACCOUNT, RESOURCE, id, before, limit)
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            let versions = page
                .versions
                .into_iter()
                .map(|held| {
                    Ok(crate::record_value::history::StoredVersion {
                        version: held.version,
                        at_ms: crate::storage::record_store::stamp_ms(held.valid_from),
                        stored: held
                            .value
                            .as_ref()
                            .filter(|_| !held.deleted)
                            .map(|value| {
                                native::stored_form(id, value).map_err(|error| crate::carry_cause!(Error::InvalidStored, error))
                            })
                            .transpose()?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(crate::record_value::history::StoredHistory {
                versions,
                next: page.next,
            })
        }
    }
    impl<S: crate::storage::Storage + Send> CurrentIds for Prefilled<S> {
        fn ids_of_type(
            &mut self,
            kind: &str,
            before: Option<&str>,
            limit: usize,
        ) -> Result<(Vec<String>, Option<String>)> {
            self.store
                .ids_of_kind(ACCOUNT, RESOURCE, kind, before, limit)
                .map_err(|error| crate::carry_cause!(Error::Source, error))
        }
    }
    impl<S: crate::storage::Storage + Send> OrderedSupply for Prefilled<S> {
        fn set_model(&mut self, model: &crate::record_model_policy::Installed) -> Result<()> {
            self.store
                .set_referrer_model(model.referrer_parts().to_vec(), Some(vec!["stored".into()]))
                .map_err(|error| crate::carry_cause!(Error::Source, error))
        }
        fn referrers(
            &mut self,
            target: &str,
            role: Option<&str>,
            after: Option<&str>,
            limit: usize,
        ) -> Result<crate::storage::record_store::referrers::Referrers> {
            self.store
                .referrers_of(ACCOUNT, RESOURCE, target, role, after, Some(limit))
                .map_err(|error| crate::carry_cause!(Error::Source, error))
        }
        fn settings(&self) -> &'static settings::Settings {
            self.store.settings()
        }
        fn ordered(
            &mut self,
            order: &str,
            cursor: Option<&OrderCursor>,
            reverse: bool,
            limit: usize,
        ) -> Result<Ordered> {
            // The prefill writes go first, so the order holds the past only once filled (as the migration fills it).
            if self.fills_orders {
                while !self
                    .store
                    .fill_order(ACCOUNT, RESOURCE, order, 500)
                    .map_err(|error| crate::carry_cause!(Error::Source, error))?
                {}
            }
            self.store
                .ordered_page(ACCOUNT, RESOURCE, order, cursor, reverse, limit)
                .map_err(|error| match error {
                    crate::records::Error::Invalid(_, cause) => Error::Invalid(cause),
                    _ => Error::Source(error.cause()),
                })
        }
        fn search_ids(&mut self, word: &str, limit: usize) -> Result<Vec<String>> {
            let found = self
                .store
                .search(
                    ACCOUNT,
                    RESOURCE,
                    self.store.settings().search.every_text(),
                    word,
                    limit,
                )
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            Ok(found.records.into_iter().map(|record| record.id).collect())
        }
    }

    impl<S: crate::storage::Storage + Send> crate::record_value::query_witness::Source
        for Prefilled<S>
    {
        fn query_witness(
            &mut self,
            binding: &crate::record_value::query_witness::QueryBinding,
        ) -> crate::record_value::Result<crate::record_value::query_witness::QueryWitness> {
            use crate::record_value::query_witness::{QueryWitness, ResourceRevision};

            let stamp = self
                .store
                .stamp(ACCOUNT, RESOURCE)
                .map_err(|error| crate::carry_cause!(Error::Source, error))?;
            QueryWitness::from_source(
                ACCOUNT.into(),
                binding.clone(),
                vec![ResourceRevision::new(
                    RESOURCE.into(),
                    "test-resource-generation".into(),
                    stamp,
                )?],
                "test-model-generation".into(),
                "test-schema-generation".into(),
            )
        }
    }

    fn task(prefilled: &mut Prefilled, n: u32, open: u8) {
        let time = format!("2026-10-{n:02}T00:00:00.000Z");
        prefilled.put(
            &format!("t{n:02}"),
            "task",
            json!({"time": time, "facts": {"time": time, "open": open}}),
        );
    }

    fn query<'a>(
        order: Option<&'a str>,
        kind: &'a str,
        prefix: Option<&str>,
        reverse: bool,
        limit: usize,
    ) -> ListQuery<'a> {
        ListQuery {
            kind,
            order,
            range: ListRange {
                prefix: prefix.map(str::to_owned),
                ..ListRange::default()
            },
            reverse,
            limit,
            walk_limit: MAX_LIST_WALK,
            after: None,
        }
    }

    fn test_query_binding() -> crate::record_value::query_witness::QueryBinding {
        use crate::record_value::query_witness::{QueryBinding, ReadScope};

        QueryBinding::new(
            "read".into(),
            serde_json::Value::Null,
            vec![ReadScope::new(
                RESOURCE.into(),
                "read".into(),
                serde_json::Value::Null,
            )
            .unwrap()],
        )
        .unwrap()
    }

    fn ids(page: &ListPage) -> Vec<&str> {
        page.rows.iter().map(LogicalRecord::id).collect()
    }

    #[test]
    fn runs_of_explicit_fields_list_newest_first_whatever_the_writers_key_order() {
        let mut prefilled = Prefilled::new();
        for n in 1..=6 {
            task(&mut prefilled, n, (n % 2) as u8);
        }
        let policy = OpenPolicy::default();
        let open = list(
            &mut prefilled,
            &query(Some(BY_OPEN_THEN_TIME), "task", Some("[1,"), true, 10),
            &policy,
            Limits::default(),
        )
        .unwrap();
        assert_eq!(ids(&open), ["t05", "t03", "t01"]);
        assert!(open.next.is_none());
        let done = list(
            &mut prefilled,
            &query(Some(BY_OPEN_THEN_TIME), "task", Some("[0,"), true, 10),
            &policy,
            Limits::default(),
        )
        .unwrap();
        assert_eq!(ids(&done), ["t06", "t04", "t02"]);
    }

    #[test]
    fn a_full_page_continues_exactly_after_its_last_row_and_from_a_rebuilt_position() {
        let mut prefilled = Prefilled::new();
        for n in 1..=5 {
            task(&mut prefilled, n, 0);
        }
        let policy = OpenPolicy::default();
        let mut paged = query(Some(BY_OPEN_THEN_TIME), "task", Some("[0,"), true, 2);
        let page = list(&mut prefilled, &paged, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&page), ["t05", "t04"]);
        paged.after = page.next;
        let page = list(&mut prefilled, &paged, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&page), ["t03", "t02"]);
        // A tool that kept only the last id shown rebuilds the same continuation.
        paged.after = position_of(&mut prefilled, "task", BY_OPEN_THEN_TIME, "t02").unwrap();
        let page = list(&mut prefilled, &paged, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&page), ["t01"]);
        assert!(page.next.is_none());
    }

    #[test]
    fn an_exact_value_prefix_lists_only_that_value_ascending() {
        let mut prefilled = Prefilled::new();
        for (id, parent) in [("n1", "p1"), ("n2", "p10"), ("n3", "p1"), ("n4", "p2")] {
            prefilled.put(id, "note", json!({"parent": parent}));
        }
        let page = list(
            &mut prefilled,
            &query(Some(BY_PARENT), "note", Some("\"p1\""), false, 10),
            &OpenPolicy::default(),
            Limits::default(),
        )
        .unwrap();
        assert_eq!(ids(&page), ["n1", "n3"]);
    }

    #[test]
    fn id_order_skips_removed_records_and_pages_by_id() {
        let mut prefilled = Prefilled::new();
        for n in 1..=5 {
            prefilled.put(
                &format!("m{n}"),
                "line",
                json!({"text": format!("line {n}")}),
            );
        }
        prefilled.remove("m4");
        let policy = OpenPolicy::default();
        let mut by_id = query(None, "line", None, true, 2);
        let page = list(&mut prefilled, &by_id, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&page), ["m5", "m3"]);
        by_id.after = page.next;
        let page = list(&mut prefilled, &by_id, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&page), ["m2", "m1"]);
        // Ascending id order is not a walk the store offers.
        assert!(matches!(
            list(
                &mut prefilled,
                &query(None, "line", None, false, 2),
                &policy,
                Limits::default()
            ),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn the_walk_limit_bounds_id_pages_and_continues_without_skipping_rows() {
        let mut prefilled = Prefilled::new();
        for n in 1..=9 {
            prefilled.put(&format!("n{n}"), "note", json!({"n": n}));
        }
        let policy = OpenPolicy::default();
        let mut page_query = query(None, "note", None, true, 9);
        page_query.walk_limit = 4;
        let first = list(&mut prefilled, &page_query, &policy, Limits::default()).unwrap();
        assert_eq!(first.walked, 4);
        assert_eq!(ids(&first), ["n9", "n8", "n7", "n6"]);
        assert_eq!(
            first.next.as_ref().map(|cursor| cursor.id.as_str()),
            Some("n6")
        );
        page_query.after = first.next;
        let second = list(&mut prefilled, &page_query, &policy, Limits::default()).unwrap();
        assert_eq!(second.walked, 4);
        assert_eq!(ids(&second), ["n5", "n4", "n3", "n2"]);
        page_query.after = second.next;
        let last = list(&mut prefilled, &page_query, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&last), ["n1"]);
        assert!(last.next.is_none());
    }

    #[test]
    fn the_walk_limit_bounds_order_pages_and_keeps_the_order_cursor() {
        let mut prefilled = Prefilled::new();
        for n in 1..=6 {
            prefilled.put(&format!("n{n}"), "note", json!({"parent": format!("p{n}")}));
        }
        let policy = OpenPolicy::default();
        let mut page_query = query(Some(BY_PARENT), "note", None, true, 6);
        page_query.walk_limit = 3;
        let first = list(&mut prefilled, &page_query, &policy, Limits::default()).unwrap();
        assert_eq!(first.walked, 3);
        assert_eq!(ids(&first), ["n6", "n5", "n4"]);
        let last = first.next.as_ref().unwrap().clone();
        page_query.after = first.next;
        let second = list(&mut prefilled, &page_query, &policy, Limits::default()).unwrap();
        assert_eq!(ids(&second), ["n3", "n2", "n1"]);
        assert_eq!(second.next, None);
        assert!(last.id == "n4");
    }

    #[test]
    fn an_order_of_another_kind_an_undeclared_order_or_an_empty_page_refuses() {
        let mut prefilled = Prefilled::new();
        let policy = OpenPolicy::default();
        assert!(matches!(
            list(
                &mut prefilled,
                &query(Some(BY_OPEN_THEN_TIME), "note", None, true, 2),
                &policy,
                Limits::default()
            ),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            list(
                &mut prefilled,
                &query(Some("no such order"), "note", None, true, 2),
                &policy,
                Limits::default()
            ),
            Err(Error::Invalid(_))
        ));
        assert!(matches!(
            list(
                &mut prefilled,
                &query(None, "line", None, true, 0),
                &policy,
                Limits::default()
            ),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn the_generic_complete_query_witness_spans_every_list_page() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"n": 1}));
        prefilled.put("n2", "note", json!({"n": 2}));
        let policy = OpenPolicy::default();
        let binding = test_query_binding();
        let witnessed = complete_query(&mut prefilled, &binding, |supply| {
            let mut after = None;
            let mut rows = Vec::new();
            for _ in 0..3 {
                let mut page_query = query(None, "note", None, true, 1);
                page_query.after = after;
                let page = list(supply, &page_query, &policy, Limits::default())?;
                rows.extend(page.rows.iter().map(|row| row.id().to_owned()));
                match page.next {
                    Some(cursor) => after = Some(cursor),
                    None => {
                        return Ok(crate::record_value::query_witness::QueryResult::Complete(
                            rows,
                        ));
                    }
                }
            }
            Ok(crate::record_value::query_witness::QueryResult::Incomplete)
        })
        .unwrap();
        assert_eq!(witnessed.answer(), &["n2".to_owned(), "n1".to_owned()]);
        assert!(
            crate::record_value::query_witness::validate(
                &mut prefilled,
                witnessed.witness(),
                &binding,
            )
            .unwrap()
        );
    }

    #[test]
    fn a_source_change_between_list_pages_refuses_the_complete_query() {
        let mut prefilled = Prefilled::new();
        prefilled.put("n1", "note", json!({"n": 1}));
        prefilled.put("n2", "note", json!({"n": 2}));
        let policy = OpenPolicy::default();
        let result = complete_query(&mut prefilled, &test_query_binding(), |supply| {
            let mut page_query = query(None, "note", None, true, 1);
            let first = list(supply, &page_query, &policy, Limits::default())?;
            let after = first.next.ok_or(crate::cause!(Error::Source))?;
            // A record change between pages makes this query an invalid snapshot.
            supply.put("n1", "note", json!({"n": "changed"}));
            page_query.after = Some(after);
            let second = list(supply, &page_query, &policy, Limits::default())?;
            if second.next.is_some() {
                return Ok(crate::record_value::query_witness::QueryResult::Incomplete);
            }
            Ok(crate::record_value::query_witness::QueryResult::Complete(
                second
                    .rows
                    .iter()
                    .map(|row| row.id().to_owned())
                    .collect::<Vec<String>>(),
            ))
        });
        assert!(matches!(result, Err(Error::Source(_))));
    }

    #[test]
    fn a_phantom_conflict_does_not_mutate_the_target_record() {
        let mut prefilled = Prefilled::new();
        prefilled.put("row-one", "test-row", json!({"enabled": true}));
        let binding = test_query_binding();
        let witnessed = complete_query(&mut prefilled, &binding, |_| {
            Ok(crate::record_value::query_witness::QueryResult::Complete(()))
        })
        .unwrap();
        let (_, expected) = witnessed.into_parts();

        // A policy row inserted after the query changes the source revision, even though it was not in the result.
        prefilled.put("row-phantom", "test-row", json!({"enabled": false}));
        let write = crate::record_value::query_witness::write_if_current(
            &mut prefilled,
            &expected,
            &binding,
            |supply| {
                supply.put("target", "test-row", json!({"written": true}));
                Ok(())
            },
        );
        assert!(matches!(write, Err(Error::Source(_))));
        assert!(prefilled
            .store
            .get(ACCOUNT, RESOURCE, "target")
            .unwrap()
            .record
            .is_none());
    }
}
