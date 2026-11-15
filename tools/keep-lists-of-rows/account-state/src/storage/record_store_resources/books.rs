// src/storage/record_store_resources/books.rs
//
// Purpose: An account's volume in more than one store. Old trillion moved incoming volume into further RecordBooks
// once a book passed the level that refuses growth (own-record-volume.json, 46485cba04: `overflow:1`, `overflow:2`).
// Here a further store is the primary placement file's sibling, named by its order (`<stem>.overflow-1.<ext>`), opened
// through the one placement opener (`open`) with the same size row. A create of a volume command lands in the head: the
// first store in order that has not reached `volume_stores.next_store_at` of that row, read live from the store. When
// every store has reached it the next one is made. A store that has reached the `full` level is split: the span of its
// records from the median id moves to the new store, and the directory publishes the next generation. Old trillion's
// hosted object naming is dropped; the order, the levels and the operations are its DATA.
//
// Non-Negotiable Invariants:
// - The level and the operations come from DATA (`settings.json` `volume_stores`, the store's size row); no number
//   here.
// - A store's order is its name: a second ask for the next store names the same file, so two writers never make two
//   different "next" stores. Stores are contiguous: order N exists only after N-1.
// - A record lives in one store. Only a create (expected version 0) of a volume command picks the head store; any
//   other write of a record goes to the store that holds it, and a read looks in every store, newest first.
// - No count cap: the stores are unlimited and small (the person's rule, 2026-11-03: never one everything-store). A limit on
//   how many stores an account holds would be an assumed number, so there is none.
// - A store's level is read live (`RecordStore::level`: its page count and size, a constant-cost read). No report is
//   kept beside the store, so no in-memory state can go stale across instances.
// - A split moves the records before it publishes: the directory names the new owner only once the records are there.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{book_directory::Directory, open};
use crate::{
    records::{Change, Error, Mutation, Record, Records, MAX_PAGE_ITEMS},
    sqlite_work::WorkMeter,
    storage::{
        record_store::{settings, store_size::SizeRow, RecordStore},
        sqlite::{Handle, Supply},
    },
};
use std::path::{Path, PathBuf};

/// The head of the volume: the store a create lands in. `create` names a store not yet made (it is made and registered
/// when it is opened).
#[derive(Debug, PartialEq, Eq)]
pub struct Head {
    pub order: usize,
    pub create: bool,
}

/// A split that was published: the boundary its span starts at, the store that now holds that span, and the generation
/// the directory published.
#[derive(Debug, PartialEq, Eq)]
pub struct Split {
    pub at: String,
    pub to_store: usize,
    pub generation: u64,
}

/// The account's span directory, as the caller reads and publishes it. The directory row lives in the primary store, and
/// the accounts layer owns that row, so the volume takes its read and its publish from the caller rather than naming them.
pub trait SpanDirectory {
    /// The directory the primary store holds for `account` (the one default span when none is published yet).
    fn read(&self, primary: &RecordStore<Supply<Handle>>, account: &str) -> Result<Directory, Error>;
    /// Publishes `directory` in the primary store, only after the records it moves are in their new store.
    fn publish(&self, primary: &mut RecordStore<Supply<Handle>>, account: &str, directory: &Directory) -> Result<(), Error>;
}

/// Where record `id` is held now: the owning store's order, and the directory generation the answer was read from.
#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub order: usize,
    pub generation: u64,
}

/// What a routed commit answered: `Done` with its answer, or `Stale` when the directory generation it checked under has
/// moved, so the owner must be resolved again.
pub enum Commit<T> {
    Done(T),
    Stale,
}

/// The file of the store at `order` of the volume whose primary file is `primary`: the primary itself at 0, else its
/// sibling `<stem>.overflow-<order>.<ext>`. None when the primary names no file.
pub fn book_path(primary: &Path, order: usize) -> Option<PathBuf> {
    if order == 0 {
        return Some(primary.to_path_buf());
    }
    let stem = primary.file_stem()?.to_str()?;
    let name = match primary.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => format!("{stem}.overflow-{order}.{ext}"),
        None => format!("{stem}.overflow-{order}"),
    };
    Some(primary.with_file_name(name))
}

/// One account's volume stores: the primary placement file and its further stores, all under one size row.
pub struct Books {
    primary: PathBuf,
    meter: WorkMeter,
    /// The size row every store of the volume runs under (`store_size::resolve`); None: the shipped default.
    row: Option<SizeRow>,
}

impl Books {
    /// The volume whose primary file is `primary` (canonical), its stores run under `row`.
    pub fn new(primary: &Path, meter: WorkMeter, row: Option<SizeRow>) -> Self {
        Self { primary: primary.to_path_buf(), meter, row }
    }

    fn volume() -> Result<&'static crate::storage::record_store::store_size::VolumeStores, Error> {
        Ok(&settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.volume_stores)
    }

    /// Open the store at `order` (creating its file when absent) under the volume's row.
    pub fn open_book(&self, order: usize) -> Result<RecordStore<Supply<Handle>>, Error> {
        let path = book_path(&self.primary, order).ok_or(Error::Invalid("the primary store names no file", crate::cause!()))?;
        let mut store = open(&path, self.meter.clone())?;
        if let Some(row) = &self.row {
            store.set_size_row(row.clone())?;
        }
        Ok(store)
    }

    /// The orders of the stores the volume holds now (the primary always), oldest first: the contiguous run of files.
    pub fn held(&self) -> Result<Vec<usize>, Error> {
        let mut orders = vec![0];
        while book_path(&self.primary, orders.len()).is_some_and(|path| path.exists()) {
            orders.push(orders.len());
        }
        Ok(orders)
    }

    /// Whether `operation` (a command's name) is a volume command: its create may land in a further store.
    pub fn is_volume_operation(&self, operation: &str) -> Result<bool, Error> {
        Ok(Self::volume()?.is_volume(operation))
    }

    /// Whether store `order` has reached `volume_stores.next_store_at` of its row now (its live level).
    fn at_next_store(&self, order: usize) -> Result<bool, Error> {
        let next_store_at = &Self::volume()?.next_store_at;
        Ok(self.open_book(order)?.level()?.reached(next_store_at))
    }

    /// The store a create of a volume command lands in: the first held store in order that has not reached the next
    /// store level; when every held store has reached it, the next order to make.
    pub fn head(&self) -> Result<Head, Error> {
        let held = self.held()?;
        for order in held.iter().copied() {
            if !self.at_next_store(order)? {
                return Ok(Head { order, create: false });
            }
        }
        Ok(Head { order: held.len(), create: true })
    }

    /// The store holding the record `id` of `resource`, newest first, with the record; None when no store holds it.
    pub fn find(&self, account: &str, resource: &str, id: &str) -> Result<Option<(usize, Record)>, Error> {
        for order in self.held()?.into_iter().rev() {
            if let Some(record) = self.open_book(order)?.get(account, resource, id)?.record {
                return Ok(Some((order, record)));
            }
        }
        Ok(None)
    }

    /// Write one record of a volume command: a create lands in the head store (`head`); any other write goes to the
    /// store that holds the record. Answers the store's order and the change.
    pub fn write(&self, account: &str, resource: &str, mutation: Mutation) -> Result<(usize, Change), Error> {
        let (order, mut store) = if mutation.expected_version == 0 {
            if let Some((order, _)) = self.find(account, resource, &mutation.id)? {
                (order, self.open_book(order)?)
            } else {
                let head = self.head()?;
                (head.order, self.open_book(head.order)?)
            }
        } else {
            let (order, _) = self.find(account, resource, &mutation.id)?.ok_or(crate::cause!(Error::Conflict))?;
            (order, self.open_book(order)?)
        };
        let change = store.mutate(account, resource, mutation)?;
        Ok((order, change))
    }

    /// Resolves the store that owns record `id` of `account` from the span directory, as the directory reads now: the
    /// owner's order and the generation the answer came from. A point read and a write both start here.
    pub fn resolve(&self, account: &str, id: &str, directory: &impl SpanDirectory) -> Result<Resolved, Error> {
        let published = directory.read(&self.open_book(0)?, account)?;
        Ok(Resolved { order: published.owner(id), generation: published.generation() })
    }

    /// Runs `commit` against the store that owns `id`, under the generation it was resolved from. `commit` answers
    /// `Stale` when the generation it checked under its own lock has moved (a split was published between the resolve and
    /// the write); then the owner is resolved again and `commit` runs once more on the new owner. A second stale answer
    /// is refused as a conflict, never retried a third time.
    pub fn route<T>(
        &self,
        account: &str,
        id: &str,
        directory: &impl SpanDirectory,
        mut commit: impl FnMut(&Resolved) -> Result<Commit<T>, Error>,
    ) -> Result<T, Error> {
        for _ in 0..2 {
            let resolved = self.resolve(account, id, directory)?;
            match commit(&resolved)? {
                Commit::Done(answer) => return Ok(answer),
                Commit::Stale => continue,
            }
        }
        Err(crate::cause!(Error::Conflict))
    }

    /// Splits the span of store `order` once that store has reached its `full` level. The span starts at the median
    /// of the `movable` ids the store holds (the records a volume command placed, not the account's own state); the
    /// records from there up move to the next store, and only then does `directory` publish the next generation.
    /// None when the store is not full or holds no movable record.
    pub fn split_full(
        &self,
        account: &str,
        resource: &str,
        order: usize,
        movable: impl Fn(&str) -> bool,
        directory: &impl SpanDirectory,
    ) -> Result<Option<Split>, Error> {
        let mut source = self.open_book(order)?;
        if !source.level()?.reached("full") {
            return Ok(None);
        }
        let mut ids = Vec::new();
        let mut after = String::new();
        loop {
            let page = source.list_page(account, resource, &after, MAX_PAGE_ITEMS)?;
            ids.extend(page.items.iter().map(|record| record.id.clone()).filter(|id| movable(id)));
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
        if ids.is_empty() {
            return Ok(None);
        }
        ids.sort();
        let at = ids[ids.len() / 2].clone();
        let to_store = self.held()?.len();
        let published = directory.read(&self.open_book(0)?, account)?;
        let next = published
            .split(published.generation(), &at, to_store)
            .map_err(|_| crate::cause!(Error::Conflict))?;
        let mut target = self.open_book(to_store)?;
        for id in ids.iter().filter(|id| id.as_str() >= at.as_str()) {
            let record = source.get(account, resource, id)?.record.ok_or(crate::cause!(Error::Conflict))?;
            target.mutate(account, resource, Mutation {
                id: id.clone(),
                expected_version: 0,
                request_key: format!("split-{}-{id}", next.generation()),
                deleted: false,
                value: record.value.clone(),
            })?;
            source.mutate(account, resource, Mutation {
                id: id.clone(),
                expected_version: record.version,
                request_key: format!("split-out-{}-{id}", next.generation()),
                deleted: true,
                value: serde_json::Value::Null,
            })?;
        }
        drop(source);
        drop(target);
        let mut primary = self.open_book(0)?;
        directory.publish(&mut primary, account, &next)?;
        Ok(Some(Split { at, to_store, generation: next.generation() }))
    }
}

#[cfg(test)]
#[path = "books/tests.rs"]
mod tests;
