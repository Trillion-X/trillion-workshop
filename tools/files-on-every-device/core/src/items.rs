//! The items the folder shows: stable item ids from the contract, each with its current full name and versions.
//!
//! Invariants
//!   - An item's id never changes: a rename or a move is the same item under a new name (f1 bug class "path as id").
//!   - The content version is the BLAKE3 content identity; the metadata version is the contract's name generation.
//!   - Dates are never invented: a file without a modified time has none, and a folder's date is its newest known
//!     child's (f1 bug 5, "1969").
//!   - A change to an item is also a change to its folder (the folder's date and listing moved), so both are
//!     reported (f1 bug 13, stale ancestor revisions).

use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::data::Contract;
use crate::names;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub folder: bool,
    pub identity: Option<String>,
    /// The row's own version, which every write names as `expected_version`.
    pub version: Option<i64>,
    pub generation: Option<String>,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub media_type: Option<String>,
    pub read_only: bool,
    /// Whether a pin rule of this device keeps it here, as the contract answered.
    pub kept: bool,
}

/// What a shell shows for one item.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ItemView {
    pub id: String,
    pub parent: String,
    pub name: String,
    pub folder: bool,
    pub content_version: Option<String>,
    pub metadata_version: Option<String>,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub media_type: Option<String>,
    pub writable: bool,
    pub pinned: bool,
    pub uploaded: bool,
}

/// A contract row read as an item, or why it cannot be: a row with no stable item id is refused, never given a
/// path as its id.
pub fn item_of_row(contract: &Contract, row: &Value, folder: bool) -> Option<Item> {
    let text = |job: &str| row.get(contract.field(job)).and_then(Value::as_str).map(str::to_owned);
    let number = |job: &str| row.get(contract.field(job)).and_then(Value::as_u64);
    let generation = row.get(contract.field("generation")).and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    });
    Some(Item {
        id: text("item")?,
        name: text("name")?,
        folder,
        identity: if folder { None } else { text("identity") },
        version: row.get(contract.field("version")).and_then(Value::as_i64),
        generation,
        size: if folder { None } else { number("byte_length") },
        modified_ms: number("modified_ms"),
        media_type: if folder { None } else { text("media_type") },
        read_only: row.get(contract.field("read_only")).and_then(Value::as_bool).unwrap_or(false),
        kept: row.get(contract.field("kept")).and_then(Value::as_bool).unwrap_or(false),
    })
}

#[derive(Default, Serialize, Deserialize)]
pub struct ItemTable {
    items: HashMap<String, Item>,
    by_name: HashMap<String, String>,
    children: HashMap<String, BTreeSet<String>>,
}

impl ItemTable {
    pub fn get(&self, id: &str) -> Option<&Item> {
        self.items.get(id)
    }

    pub fn id_of_name(&self, name: &str) -> Option<&str> {
        self.by_name.get(name).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Keep an item; answers the ids whose view changed (the item, its folder, and its old folder after a move).
    pub fn upsert(&mut self, item: Item) -> Vec<String> {
        let mut touched = vec![item.id.clone()];
        if let Some(old) = self.items.get(&item.id) {
            if *old == item {
                return Vec::new();
            }
            if old.name != item.name {
                let old_name = old.name.clone();
                self.by_name.remove(&old_name);
                if let Some(siblings) = self.children.get_mut(names::parent(&old_name)) {
                    siblings.remove(&item.id);
                }
                touched.extend(self.by_name.get(names::parent(&old_name)).cloned());
            }
        }
        // A name another item held before is that item's no longer.
        if let Some(previous) = self.by_name.get(&item.name).filter(|previous| **previous != item.id).cloned() {
            self.items.remove(&previous);
        }
        self.by_name.insert(item.name.clone(), item.id.clone());
        self.children.entry(names::parent(&item.name).to_owned()).or_default().insert(item.id.clone());
        touched.extend(self.by_name.get(names::parent(&item.name)).cloned());
        self.items.insert(item.id.clone(), item);
        touched.dedup();
        touched
    }

    /// Forget an item; answers the ids whose view changed (its folder).
    pub fn remove(&mut self, id: &str) -> Vec<String> {
        let Some(item) = self.items.remove(id) else { return Vec::new() };
        self.by_name.remove(&item.name);
        let folder = names::parent(&item.name);
        if let Some(siblings) = self.children.get_mut(folder) {
            siblings.remove(id);
        }
        self.by_name.get(folder).cloned().into_iter().collect()
    }

    /// The ids of an item and of every known item under it, when it is a folder.
    fn tree(&self, id: &str) -> Vec<String> {
        let Some(item) = self.items.get(id) else { return Vec::new() };
        let under = format!("{}/", item.name.trim_end_matches('/'));
        let mut ids = vec![id.to_owned()];
        if item.folder {
            ids.extend(self.items.values().filter(|other| other.name.starts_with(&under)).map(|other| other.id.clone()));
        }
        ids
    }

    /// An item and everything under it moved to a new name; answers the ids whose view changed.
    pub fn rename(&mut self, id: &str, to: &str) -> Vec<String> {
        let Some(from) = self.items.get(id).map(|item| item.name.clone()) else { return Vec::new() };
        let mut touched = Vec::new();
        for moved in self.tree(id) {
            let Some(mut item) = self.items.get(&moved).cloned() else { continue };
            item.name = format!("{to}{}", &item.name[from.len()..]);
            touched.extend(self.upsert(item));
        }
        touched.dedup();
        touched
    }

    /// An item and everything under it forgotten; answers the ids whose view changed (its folder).
    pub fn remove_tree(&mut self, id: &str) -> Vec<String> {
        let ids = self.tree(id);
        let mut touched = Vec::new();
        for gone in ids.iter().rev() {
            touched.extend(self.remove(gone));
        }
        touched.retain(|touched| !ids.contains(touched));
        touched
    }

    /// The newest modified time among a folder's known children, the folder's own date.
    fn newest_child(&self, folder: &str) -> Option<u64> {
        self.children
            .get(folder)?
            .iter()
            .filter_map(|id| self.items.get(id))
            .filter_map(|child| child.modified_ms.or_else(|| child.folder.then(|| self.newest_child(&child.name)).flatten()))
            .max()
    }

    /// The view of an item; `uploaded` is whether every edit of it is kept by the contract.
    pub fn view(&self, contract: &Contract, id: &str, uploaded: bool) -> Option<ItemView> {
        let item = self.items.get(id)?;
        let folder = names::parent(&item.name);
        let parent = if folder == contract.root.folder {
            contract.root.id.clone()
        } else {
            self.by_name.get(folder)?.clone()
        };
        Some(ItemView {
            id: item.id.clone(),
            parent,
            name: names::leaf(&item.name).to_owned(),
            folder: item.folder,
            content_version: item.identity.clone(),
            metadata_version: item.generation.clone(),
            size: item.size,
            modified_ms: if item.folder { item.modified_ms.or_else(|| self.newest_child(&item.name)) } else { item.modified_ms },
            media_type: item.media_type.clone(),
            writable: !item.read_only,
            pinned: item.kept,
            uploaded,
        })
    }

    /// The root's view: the folder the OS shows, never invented beyond its newest child.
    pub fn root_view(&self, contract: &Contract) -> ItemView {
        ItemView {
            id: contract.root.id.clone(),
            parent: contract.root.id.clone(),
            name: contract.root.name.clone(),
            folder: true,
            content_version: None,
            metadata_version: None,
            size: None,
            modified_ms: self.newest_child(&contract.root.folder),
            media_type: None,
            writable: true,
            pinned: false,
            uploaded: true,
        }
    }

    /// The facts of an item an ignore rule may name (contract.json `item_facts`).
    pub fn facts(contract: &Contract, name: &str, folder: bool, media_type: Option<&str>, size: Option<u64>) -> Value {
        let kind = if folder { &contract.item_kinds.folder } else { &contract.item_kinds.file };
        let mut facts = Map::new();
        for fact in &contract.item_facts {
            let value = match fact.id.as_str() {
                "name" => json!(names::leaf(name)),
                "path" => json!(name),
                "folder" => json!(names::parent(name)),
                "extension" => json!(names::extension(name)),
                "media_type" => json!(media_type),
                "size" => json!(size),
                "kind" => json!(kind),
                _ => Value::Null,
            };
            facts.insert(fact.id.clone(), value);
        }
        Value::Object(facts)
    }
}
