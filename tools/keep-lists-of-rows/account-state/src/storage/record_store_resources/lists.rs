// src/storage/record_store_resources/lists.rs
//
// Purpose: Every list keeps its rows in a store of its own, as old trillion's placed lists did (2341372f7c, src/lists.mjs
// `checkPlacement`, src/placed-lists.mjs): a list record holding `placement: {"database": "<name>"}` keeps its rows
// (records of kind `record:<row_type>`) in the account's store `@list/<name>` (one state-folder file, `list-<name>.sqlite`,
// by the resource row in src/storage/record_store_resources.json), so a large list such as `record:library` never fills the
// account's primary RecordBook. A list made now is given the store of its own row type (`saved_placement`); a list kept
// in the primary before stays there until it is moved, a page at a time (`step`, old placed-lists.mjs `move` and
// `continueMoves`).
//
// A list's store is an own-records store holding that one list's rows: the same `own-records` and `own-record-keys`
// scopes, the same position and identity rows (`OwnRecords::initialize_new_work_store`), so the account's own-records
// reader opens it through the one routed read it already has for its other stores (src/local_account/own_records.rs
// `OwnRead::read_routed`) and the native command writes it through the same `InCommand::write`.
//
// Two small records in the primary answer where a row is, both written in the primary command's own transaction:
// - `own-list-homes` / `homes`: the store each list's rows are read from now, by row type (`Homes`). A list absent from
//   it is read from the primary. It changes only when a list is given a store, or a move flips a list's home.
// - `own-row-homes` / `<row id>`: `{"type": "record:<row_type>"}` for each row kept in a list's store (a move's target
//   included). A read by id alone (a link, a shared child, an agent's read with no type) finds the row's list from it:
//   library row ids such as `x-money:2065295911677460584` do not name their list, and the person's account keeps 213 lists
//   (2026-11-14), so asking every list's store on each read is not an answer.
//
// Non-Negotiable Invariants:
// - One store answers for a list's rows: its home (`placement.database`, or the primary when it names none). Reads go
//   there and never fall back to another store (old placed-lists.mjs invariant 1).
// - A home name is `[a-zA-Z0-9_-]{1,100}` (old trillion's PLACED_DATABASE), so it is one safe filename component; any
//   other placement is refused, never guessed.
// - A save never points a list away from the rows it has: an ordinary save keeps the placement it has; a save that
//   names another database starts a move there (old placed-lists.mjs `wrapped.save`: "A list given another store moves
//   there with its rows"); only the move (`step`) changes the placement after that.
// - A move holds nothing longer than one page (invariant 4): each step copies one page from the home into the target,
//   writes those rows' pointers, then moves the cursor kept in the list record, so an interrupted move resumes where its
//   last cursor is. While it moves, the old home still answers and every write lands in both. Once the last page is
//   copied the home flips to the target (checked against the record as it is then), and the old home's copies are
//   retired a page at a time. The old home keeps the rows' history before the flip, and the record names it in `earlier`.
// - The pointers and the homes index are written in the same primary transaction as the list record and the receipt
//   of the command that writes them. A list's rows are written in their own store in its own transaction, before the
//   primary commits, under the same request key, exactly as old trillion's database command for a placed list
//   committed apart from the account's (placed-lists.mjs `store(home).putRows`): a primary that then rolls back leaves
//   the rows written, and the same request again finds them unchanged and writes only what the primary lost.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::{
    ecma_json,
    legacy_records::StoredRecord,
    records::{Error, Mutation},
    storage::{record_store::RecordStore, Storage},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The resource prefix of a list's own store (its row in src/storage/record_store_resources.json).
pub const LIST_HOME: &str = "@list/";
/// The primary's scope of row pointers: one record per row kept in a list's store, `{"type": <kind>}`.
pub const ROW_HOMES: &str = "own-row-homes";
/// The primary's scope of the homes index: one record (`HOMES_ID`), the store each placed list is read from now.
pub const LIST_HOMES: &str = "own-list-homes";
const HOMES_ID: &str = "homes";
/// The longest home name.
const MOST_NAME_BYTES: usize = 100;
/// The kind of a list record.
const LIST_KIND: &str = "list";

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MOST_NAME_BYTES && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The resource of the store named `database`.
pub fn resource(database: &str) -> String {
    format!("{LIST_HOME}{database}")
}

/// The row type a record kind of a list's rows names (`record:<row_type>`); None for any other kind.
pub fn row_type(kind: &str) -> Option<&str> {
    kind.strip_prefix("record:").filter(|row_type| !row_type.is_empty())
}

/// A list's placement, old placed-lists.mjs's shape: the store its rows live in (`database`, none: the primary), a move
/// under way (`moving`), the old home being emptied after a move (`retiring`), and the homes it had before (`earlier`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moving: Option<Moving>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retiring: Option<Earlier>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub earlier: Vec<Earlier>,
}

/// A move under way: the store it copies into, the last row id copied (none: not started) and how many it copied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Moving {
    pub to: String,
    pub cursor: Option<String>,
    pub copied: u64,
}

/// A home a list had until `until` (none: the primary).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Earlier {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    pub until: String,
}

impl Placement {
    /// The placement a list record's value holds, None when it names none. A malformed placement is refused.
    pub fn of(list: &Value) -> Result<Option<Placement>, Error> {
        let Some(placement) = list.get("placement").filter(|placement| !placement.is_null()) else { return Ok(None) };
        let placement: Placement = serde_json::from_value(placement.clone())
            .map_err(|_| Error::Invalid("a list's placement is {database, moving, retiring, earlier}", crate::cause!()))?;
        let names = placement.database.iter()
            .chain(placement.moving.iter().map(|moving| &moving.to))
            .chain(placement.retiring.iter().chain(&placement.earlier).filter_map(|earlier| earlier.database.as_ref()));
        for name in names {
            if !valid_name(name) {
                return Err(Error::Invalid("a list's database is 1 to 100 letters, digits, - or _", crate::cause!()));
            }
        }
        if placement.moving.is_some() && placement.retiring.is_some() {
            return Err(Error::Invalid("a list moves or retires its old home, one at a time", crate::cause!()));
        }
        if placement.moving.as_ref().is_some_and(|moving| placement.database.as_ref() == Some(&moving.to)) {
            return Err(Error::Invalid("a list moves to another store than its home", crate::cause!()));
        }
        Ok(Some(placement))
    }

    /// The resource the list's rows are read from now: its home, None for the primary.
    pub fn home(&self) -> Option<String> {
        self.database.as_deref().map(resource)
    }

    /// The resource a move under way copies into.
    pub fn moving_to(&self) -> Option<String> {
        self.moving.as_ref().map(|moving| resource(&moving.to))
    }

    fn settled(&self) -> bool {
        self.moving.is_none() && self.retiring.is_none()
    }
}

/// The placement a save of a list record keeps (old trillion `checkPlacement` and `wrapped.save`). `given` is the
/// placement the save names, `kept` the one the list has, `fresh` whether the list is made by this save. A list made
/// now is given the store of its own row type when it names none; a list kept in the primary before stays there until
/// a save names a database for it, which starts its move; a list that has a placement keeps it, and a save naming
/// another database moves it there. A save cannot set a move's own state.
pub fn saved_placement(given: Option<&Value>, kept: Option<Placement>, fresh: bool, row_type: Option<&str>) -> Result<Option<Placement>, Error> {
    let given = match given.filter(|given| !given.is_null()) {
        Some(given) => Placement::of(&serde_json::json!({ "placement": given }))?,
        None => None,
    };
    let Some(given) = given else {
        return Ok(kept.or_else(|| fresh.then(|| row_type.filter(|name| valid_name(name)).map(|name| Placement { database: Some(name.to_owned()), ..Placement::default() })).flatten()));
    };
    if kept.as_ref() == Some(&given) {
        return Ok(kept);
    }
    let asked = given.database.clone().filter(|_| given.settled() && given.earlier.is_empty())
        .ok_or(Error::Invalid("a save names only a list's database; its move is the store's own", crate::cause!()))?;
    match kept {
        None if fresh => Ok(Some(given)),
        kept => start_move(kept.unwrap_or_default(), &asked).map(Some),
    }
}

/// `kept` moving to `to` (old placed-lists.mjs `move`): unchanged when it is there already or moving there, refused while
/// another move or a retiring is under way.
fn start_move(kept: Placement, to: &str) -> Result<Placement, Error> {
    if kept.moving.as_ref().is_some_and(|moving| moving.to == to) || kept.settled() && kept.database.as_deref() == Some(to) {
        return Ok(kept);
    }
    if !kept.settled() {
        return Err(Error::Invalid("the list is still moving to its own store; move it again once that finishes", crate::cause!()));
    }
    Ok(Placement { moving: Some(Moving { to: to.to_owned(), cursor: None, copied: 0 }), ..kept })
}

/// A list record's stored form with `placement` set in its value, every other field kept in its own order.
pub fn with_placement(form: &StoredRecord, placement: &Placement) -> Result<StoredRecord, Error> {
    let limits = ecma_json::Limits::default();
    let mut value = ecma_json::parse(form.value_json.as_bytes(), limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let ecma_json::Value::Object(object) = &mut value else {
        return Err(Error::Invalid("a list record's value is an object", crate::cause!()));
    };
    let text = serde_json::to_string(placement).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let placement = ecma_json::parse(text.as_bytes(), limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    object.insert(ecma_json::JsString::from("placement"), placement);
    Ok(StoredRecord {
        id: form.id.clone(),
        record_type: form.record_type.clone(),
        sequence: form.sequence.clone(),
        value_json: ecma_json::stringify(&value, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        meta_json: form.meta_json.clone(),
        protected_key_present: form.protected_key_present,
    })
}

fn form_value(form: &StoredRecord) -> Result<Value, Error> {
    serde_json::from_str(&form.value_json).map_err(|_| Error::Invalid("a stored form's value is unreadable", crate::cause!()))
}

/// The primary's index of placed lists (`own-list-homes` / `homes`), by row type: the store each placed list's rows
/// are read from now (`homes`), the store a move under way copies them into too (`moving_to`), and the list records
/// whose move or retiring is under way (`moving`, old placed-lists.mjs `moves`, the one row the alarm reads to learn
/// which lists still move, however many lists there are). It is the one answer to where a row type's rows go: a list
/// record's id need not name its row type (91 of the 214 lists of the person's account on 2026-11-14 do not).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Index {
    #[serde(default)]
    pub homes: BTreeMap<String, String>,
    #[serde(default)]
    pub moving_to: BTreeMap<String, String>,
    #[serde(default)]
    pub moving: BTreeSet<String>,
}

impl Index {
    /// The stores the rows of `kind` are written in: its home (None: the primary), and a move's target.
    fn targets(&self, kind: &str) -> Vec<Option<String>> {
        let Some(row_type) = row_type(kind) else { return vec![None] };
        let mut targets = vec![self.homes.get(row_type).cloned()];
        if let Some(to) = self.moving_to.get(row_type) {
            targets.push(Some(to.clone()));
        }
        targets
    }

    fn change(&mut self, plan: &Plan) {
        for (changes, kept) in [(&plan.homes, &mut self.homes), (&plan.moving_to, &mut self.moving_to)] {
            for (row_type, store) in changes {
                match store {
                    Some(store) => { kept.insert(row_type.clone(), store.clone()); }
                    None => { kept.remove(row_type); }
                }
            }
        }
        for (list, moving) in &plan.moving {
            if *moving { self.moving.insert(list.clone()); } else { self.moving.remove(list); }
        }
    }
}

/// The index the primary holds, with its version.
pub fn index<S: Storage>(primary: &RecordStore<S>, account: &str) -> Result<(i64, Index), Error> {
    let (version, held) = primary.held_record_with_version(account, LIST_HOMES, HOMES_ID)?;
    let index = match held {
        Some(record) => serde_json::from_value(record.value)
            .map_err(|_| Error::Invalid("the account's list homes are unreadable", crate::cause!()))?,
        None => Index::default(),
    };
    Ok((version, index))
}

/// The store the rows of `kind` are read from now, by the homes index: None for the primary.
pub fn kind_home<S: Storage>(primary: &RecordStore<S>, account: &str, kind: &str) -> Result<Option<String>, Error> {
    let Some(row_type) = row_type(kind) else { return Ok(None) };
    Ok(index(primary, account)?.1.homes.remove(row_type))
}

/// The store the row `id` is read from now: its pointer's list's home. None when the row has no pointer, or its list
/// is read from the primary (rows a move is still copying out of the primary are read there).
pub fn point_home<S: Storage>(primary: &RecordStore<S>, account: &str, id: &str) -> Result<Option<String>, Error> {
    let (_, mut index) = index(primary, account)?;
    if index.homes.is_empty() {
        return Ok(None);
    }
    let Some(kind) = pointer(primary, account, id)? else { return Ok(None) };
    Ok(row_type(&kind).and_then(|row_type| index.homes.remove(row_type)))
}

/// Every store a placed list is read from now (the fan-out of a read across kinds: search, referrers, kind schemas).
pub fn every_home<S: Storage>(primary: &RecordStore<S>, account: &str) -> Result<Vec<String>, Error> {
    let homes: BTreeSet<String> = index(primary, account)?.1.homes.into_values().collect();
    Ok(homes.into_iter().collect())
}

fn pointer<S: Storage>(primary: &RecordStore<S>, account: &str, id: &str) -> Result<Option<String>, Error> {
    Ok(primary.held_record_with_version(account, ROW_HOMES, id)?.1
        .and_then(|record| record.value.get("type").and_then(Value::as_str).map(str::to_owned)))
}

/// Where one write puts its records (`plan`), and what it changes in the primary's index.
#[derive(Default)]
pub struct Plan {
    /// The forms the primary keeps: every record that is not a placed list's row, list records with their kept placement.
    pub primary: BTreeMap<String, Option<StoredRecord>>,
    /// The forms each list store keeps, by its resource.
    pub stores: BTreeMap<String, BTreeMap<String, Option<StoredRecord>>>,
    /// The row pointers that change: a row now kept in a list's store (its kind), or no longer (None).
    pub pointers: BTreeMap<String, Option<String>>,
    /// The homes that change, by row type: a list read from a store now (its resource), or from the primary (None).
    pub homes: BTreeMap<String, Option<String>>,
    /// The move targets that change, by row type: a store a move copies into (its resource), or none.
    pub moving_to: BTreeMap<String, Option<String>>,
    /// The lists whose move starts (true) or ends (false), by list record id.
    pub moving: BTreeMap<String, bool>,
}

impl Plan {
    /// The pointer writes this plan makes, over the versions the primary holds now (a move writes a page of them in one
    /// batch, `RecordStore::mutate_many`).
    pub fn pointer_writes<S: Storage>(&self, primary: &RecordStore<S>, account: &str, request: &str) -> Result<Vec<Mutation>, Error> {
        self.pointers.iter().map(|(id, kind)| Ok(Mutation {
            id: id.clone(),
            expected_version: primary.held_version(account, ROW_HOMES, id)?,
            request_key: format!("{ROW_HOMES}-{request}-{id}"),
            deleted: kind.is_none(),
            value: kind.as_ref().map_or(Value::Null, |kind| serde_json::json!({ "type": kind })),
        })).collect()
    }

    /// Write the index this plan changes (the list homes record) into the primary, under `request`.
    pub fn write_homes<S: Storage>(&self, primary: &mut RecordStore<S>, account: &str, request: &str, check: impl FnMut() -> Result<(), Error>) -> Result<usize, Error> {
        if self.homes.is_empty() && self.moving_to.is_empty() && self.moving.is_empty() {
            return Ok(0);
        }
        let (version, mut index) = index(primary, account)?;
        index.change(self);
        primary.mutate_local_with_check(account, LIST_HOMES, Mutation {
            id: HOMES_ID.into(),
            expected_version: version,
            request_key: format!("{LIST_HOMES}-{request}"),
            deleted: false,
            value: serde_json::to_value(&index).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        }, check)?;
        Ok(1)
    }

    /// Write the pointers and the index this plan changes into the primary, under `request`.
    pub fn write_index<S: Storage>(
        &self,
        primary: &mut RecordStore<S>,
        account: &str,
        request: &str,
        mut check: impl FnMut() -> Result<(), Error>,
    ) -> Result<usize, Error> {
        let mut written = 0;
        for pointer in self.pointer_writes(primary, account, request)? {
            primary.mutate_local_with_check(account, ROW_HOMES, pointer, &mut check)?;
            written += 1;
        }
        Ok(written + self.write_homes(primary, account, request, check)?)
    }
}

/// Where each record of one write goes. `forms` are the write's records (None: removed); `current` reads a record as
/// it is now wherever it is kept (the routed read). A list record keeps its placement (`saved_placement`); a list's row
/// goes to its list's home and, while the list moves, to the move's target too; a row whose kind changed leaves the
/// stores of its old kind it is no longer kept in. Every other record stays in the primary. A list record and its rows
/// written together go where the record written here places them.
pub fn plan<S: Storage>(
    primary: &RecordStore<S>,
    account: &str,
    forms: &BTreeMap<String, Option<StoredRecord>>,
    mut current: impl FnMut(&str) -> Result<Option<StoredRecord>, Error>,
) -> Result<Plan, Error> {
    let (_, kept) = index(primary, account)?;
    let mut plan = Plan::default();
    for (id, form) in forms {
        let Some(form) = form.as_ref().filter(|form| form.record_type == LIST_KIND) else { continue };
        let value = form_value(form)?;
        let held = current(id)?;
        let kept_placement = held.as_ref().filter(|held| held.record_type == LIST_KIND).map(form_value).transpose()?
            .map(|held| Placement::of(&held)).transpose()?.flatten();
        let row_type = value.get("row_type").and_then(Value::as_str).map(str::to_owned);
        let placement = saved_placement(value.get("placement"), kept_placement, held.is_none(), row_type.as_deref())?;
        let written = match &placement {
            Some(placement) if Placement::of(&value)?.as_ref() != Some(placement) => with_placement(form, placement)?,
            _ => form.clone(),
        };
        if let (Some(row_type), Some(placement)) = (&row_type, &placement) {
            if kept.homes.get(row_type) != placement.home().as_ref() {
                plan.homes.insert(row_type.clone(), placement.home());
            }
            if kept.moving_to.get(row_type) != placement.moving_to().as_ref() {
                plan.moving_to.insert(row_type.clone(), placement.moving_to());
            }
            if kept.moving.contains(id) == placement.settled() {
                plan.moving.insert(id.clone(), !placement.settled());
            }
        }
        plan.primary.insert(id.clone(), Some(written));
    }
    // A store the index names (a list's new home, a move's target) is made with this write, before any row reaches it:
    // every read across kinds opens every home.
    for store in plan.homes.values().chain(plan.moving_to.values()).flatten() {
        plan.stores.entry(store.clone()).or_default();
    }
    // Where each row type's rows go once this write's list records are kept.
    let mut now = kept;
    now.change(&plan);
    for (id, form) in forms {
        if form.as_ref().is_some_and(|form| form.record_type == LIST_KIND) {
            continue;
        }
        let held = current(id)?;
        let new_targets = form.as_ref().map_or_else(Vec::new, |form| now.targets(&form.record_type));
        let old_targets = held.as_ref().map_or_else(|| vec![None], |held| now.targets(&held.record_type));
        // A write goes to the stores its kind is kept in; a removal, and a write whose kind left a store, to the
        // stores the record is kept in now.
        let mut writes: Vec<(Option<String>, Option<StoredRecord>)> = new_targets.iter().map(|target| (target.clone(), form.clone())).collect();
        for target in old_targets.iter().filter(|target| !new_targets.contains(target)) {
            writes.push((target.clone(), None));
        }
        for (target, form) in writes {
            match target {
                None => { plan.primary.insert(id.clone(), form); }
                Some(store) => { plan.stores.entry(store).or_default().insert(id.clone(), form); }
            }
        }
        let kept_apart = form.as_ref().filter(|_| new_targets.iter().any(Option::is_some)).map(|form| form.record_type.clone());
        if pointer(primary, account, id)? != kept_apart {
            plan.pointers.insert(id.clone(), kept_apart);
        }
    }
    Ok(plan)
}

/// src/storage/record_store_resources/list-moves.json: how a list moves into a store of its own.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveSettings {
    #[serde(rename = "_what")]
    _what: String,
    pub page_rows: usize,
    pub earlier: usize,
    pub lists_per_pass: usize,
}

/// The shipped move settings; None when the DATA is malformed or out of its bounds.
pub fn move_settings() -> Option<&'static MoveSettings> {
    static SETTINGS: std::sync::OnceLock<Option<MoveSettings>> = std::sync::OnceLock::new();
    SETTINGS.get_or_init(|| {
        serde_json::from_slice::<MoveSettings>(include_bytes!("list-moves.json")).ok()
            .filter(|settings| (1..=crate::records::MAX_PAGE_ITEMS).contains(&settings.page_rows) && settings.page_rows <= crate::record_log::MAX_BATCH_RECORDS
                && settings.earlier > 0 && settings.lists_per_pass > 0)
    }).as_ref()
}

/// What one step of a list's move did (`step`).
#[derive(Debug, PartialEq, Eq)]
pub enum Stepped {
    /// The list has no move or retiring under way.
    Settled,
    /// One page was copied into the move's target; the cursor moved to the last id copied.
    Copied { rows: usize },
    /// The last page was copied: the list's home is its target now, and its old home's copies retire.
    Flipped,
    /// One page of the old home's copies was removed.
    Retired { rows: usize },
    /// The old home holds no copy any more: the move is done.
    Done,
}

/// The stores one step of a move reads and writes, given by the account's own-records owner: a page of a list's rows
/// read from a store (`None`: the primary), records copied into a store or removed from it, each store's write in its
/// own transaction, and the list record and the index written in the primary.
pub trait MoveStores {
    /// The live ids of `kind` in `store`, ascending, strictly after `after`, at most `limit`.
    fn ids_after(&mut self, store: Option<&str>, kind: &str, after: Option<&str>, limit: usize) -> Result<Vec<String>, Error>;
    /// Copy each id's current record and field key from `from` into `to` (a list's store), as they are kept, in one
    /// transaction of `to`; an id `to` already holds equal is left as it is.
    fn copy(&mut self, from: Option<&str>, to: &str, ids: &[String], request: &str) -> Result<(), Error>;
    /// Remove each id's record and field key from `store`, in one transaction of that store.
    fn remove(&mut self, store: Option<&str>, ids: &[String], request: &str) -> Result<(), Error>;
    /// The list record `id` as the primary holds it now, with its version.
    fn list(&mut self, id: &str) -> Result<(i64, Option<StoredRecord>), Error>;
    /// Write `index` (pointers and homes), then the list record (when given) over its version, in the primary. Each step
    /// can be made again: the index first, so a lost list write leaves only a page to copy again, equal.
    fn keep(&mut self, list: Option<(&StoredRecord, i64)>, index: &Plan, request: &str) -> Result<(), Error>;
    /// The time a flip is kept with, as ISO 8601 text.
    fn now(&self) -> String;
}

/// One step of the move of the list `list_id` (old placed-lists.mjs `step`): copy one page of its rows from its home
/// into the move's target, flip its home once the last page is copied, then retire the old home's copies a page at a
/// time, then mark the move done. Each step is checked against the record as it is now, so two steps at once never move
/// a list twice.
pub fn step(stores: &mut dyn MoveStores, list_id: &str, settings: &MoveSettings) -> Result<Stepped, Error> {
    let (version, list) = stores.list(list_id)?;
    let request = format!("move-{list_id}-{version}");
    // A list that was removed, or has no move under way, leaves the moving lists.
    let settled = |stores: &mut dyn MoveStores| -> Result<Stepped, Error> {
        stores.keep(None, &Plan { moving: BTreeMap::from([(list_id.to_owned(), false)]), ..Plan::default() }, &request)?;
        Ok(Stepped::Settled)
    };
    let Some(list) = list.filter(|list| list.record_type == LIST_KIND) else { return settled(stores) };
    let value = form_value(&list)?;
    let Some(placement) = Placement::of(&value)?.filter(|placement| !placement.settled()) else { return settled(stores) };
    let row_type = value.get("row_type").and_then(Value::as_str).filter(|name| valid_name(name))
        .ok_or(Error::Invalid("a placed list names its row type", crate::cause!()))?.to_owned();
    let kind = format!("record:{row_type}");
    let from = placement.home();
    if let Some(moving) = &placement.moving {
        let to = resource(&moving.to);
        let ids = stores.ids_after(from.as_deref(), &kind, moving.cursor.as_deref(), settings.page_rows)?;
        if !ids.is_empty() {
            stores.copy(from.as_deref(), &to, &ids, &request)?;
            let index = Plan { pointers: ids.iter().map(|id| (id.clone(), Some(kind.clone()))).collect(), ..Plan::default() };
            let next = Placement {
                moving: Some(Moving { to: moving.to.clone(), cursor: ids.last().cloned(), copied: moving.copied + ids.len() as u64 }),
                ..placement.clone()
            };
            stores.keep(Some((&with_placement(&list, &next)?, version)), &index, &request)?;
            return Ok(Stepped::Copied { rows: ids.len() });
        }
        let gone = Earlier { database: placement.database.clone(), until: stores.now() };
        let mut earlier = placement.earlier.clone();
        earlier.push(gone.clone());
        let skip = earlier.len().saturating_sub(settings.earlier);
        let next = Placement { database: Some(moving.to.clone()), moving: None, retiring: Some(gone), earlier: earlier.split_off(skip) };
        let index = Plan { homes: BTreeMap::from([(row_type.clone(), Some(to))]), moving_to: BTreeMap::from([(row_type, None)]), ..Plan::default() };
        stores.keep(Some((&with_placement(&list, &next)?, version)), &index, &request)?;
        return Ok(Stepped::Flipped);
    }
    let retiring = placement.retiring.as_ref().ok_or(crate::cause!(Error::Unavailable))?;
    let source = retiring.database.as_deref().map(resource);
    let ids = stores.ids_after(source.as_deref(), &kind, None, settings.page_rows)?;
    if !ids.is_empty() {
        stores.remove(source.as_deref(), &ids, &request)?;
        return Ok(Stepped::Retired { rows: ids.len() });
    }
    let next = Placement { retiring: None, ..placement };
    let index = Plan { moving: BTreeMap::from([(list_id.to_owned(), false)]), ..Plan::default() };
    stores.keep(Some((&with_placement(&list, &next)?, version)), &index, &request)?;
    Ok(Stepped::Done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn placed(value: Value) -> Placement {
        Placement::of(&json!({ "placement": value })).unwrap().unwrap()
    }

    #[test]
    fn a_placement_names_safe_stores_and_one_move_at_a_time() {
        for bad in [json!({"database": ""}), json!({"database": "../up"}), json!({"database": "a/b"}), json!({"database": "x", "other": 1}),
            json!("library"), json!({"database": "x".repeat(101)}), json!({"database": "a", "moving": {"to": "a", "cursor": null, "copied": 0}}),
            json!({"moving": {"to": "b", "cursor": null, "copied": 0}, "retiring": {"until": "2026-11-14T00:00:00.000Z"}}),
            json!({"moving": {"to": "../b", "cursor": null, "copied": 0}})] {
            assert!(Placement::of(&json!({"placement": bad})).is_err(), "{bad}");
        }
        assert_eq!(Placement::of(&json!({"row_type": "notes"})).unwrap(), None);
        let moving = placed(json!({"moving": {"to": "library", "cursor": "x-1", "copied": 3}}));
        assert_eq!((moving.home(), moving.moving_to().as_deref()), (None, Some("@list/library")), "a move from the primary reads the primary");
        assert_eq!(placed(json!({"database": "library"})).home().as_deref(), Some("@list/library"));
        assert_eq!(row_type("record:library"), Some("library"));
        assert_eq!(row_type("library"), None);
    }

    #[test]
    fn a_save_keeps_its_placement_and_a_named_store_starts_a_move() {
        let kept = placed(json!({"database": "library"}));
        // A new list is given the store of its own row type; a list kept in the primary before stays there.
        assert_eq!(saved_placement(None, None, true, Some("notes")).unwrap(), Some(placed(json!({"database": "notes"}))));
        assert_eq!(saved_placement(None, None, true, Some("not a name")).unwrap(), None);
        assert_eq!(saved_placement(None, None, false, Some("notes")).unwrap(), None);
        // An ordinary save keeps the placement, whatever it names of it.
        assert_eq!(saved_placement(None, Some(kept.clone()), false, Some("library")).unwrap(), Some(kept.clone()));
        assert_eq!(saved_placement(Some(&json!({"database": "library"})), Some(kept.clone()), false, None).unwrap(), Some(kept.clone()));
        // A save naming another store moves the list there, from the primary or from its own store.
        assert_eq!(saved_placement(Some(&json!({"database": "library"})), None, false, Some("library")).unwrap(),
            Some(placed(json!({"moving": {"to": "library", "cursor": null, "copied": 0}}))));
        let moving = saved_placement(Some(&json!({"database": "other"})), Some(kept.clone()), false, None).unwrap().unwrap();
        assert_eq!(moving, placed(json!({"database": "library", "moving": {"to": "other", "cursor": null, "copied": 0}})));
        // While it moves, the same store asked again changes nothing, and another is refused; a save never sets a move.
        assert_eq!(saved_placement(Some(&json!({"database": "other"})), Some(moving.clone()), false, None).unwrap(), Some(moving.clone()));
        assert!(saved_placement(Some(&json!({"database": "third"})), Some(moving.clone()), false, None).is_err());
        assert!(saved_placement(Some(&json!({"moving": {"to": "x", "cursor": null, "copied": 0}})), None, true, None).is_err());
    }

    #[test]
    fn a_placement_written_into_a_list_keeps_its_other_fields_in_order() {
        let form = StoredRecord { id: "list:notes".into(), record_type: "list".into(), sequence: "1".into(),
            value_json: r#"{"row_type":"notes","label":"Notes","fields":[]}"#.into(), meta_json: None, protected_key_present: false };
        let written = with_placement(&form, &placed(json!({"database": "notes"}))).unwrap();
        assert_eq!(written.value_json, r#"{"row_type":"notes","label":"Notes","fields":[],"placement":{"database":"notes"}}"#);
        assert!(move_settings().is_some(), "the shipped move DATA reads");
    }
}
