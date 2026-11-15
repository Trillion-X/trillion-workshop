//! The record store resources of the selected account's own stores, as DATA (`record_store_resources.json`).
//!
//! Purpose: one list of every record store resource the native account reads, where it is placed (which file of the account,
//! through which supply), which source files read it, where its data was before record store (the old store's tables, or none)
//! and which startup preparation phases copy that old data in. A reader resolves its resource name here
//! (`resource_of`), so a resource no row declares cannot be read through it, and every placement file is opened by the
//! one opener here (`open`, `native`), so no owner carries its own copy of the open steps.
//!
//! Non-Negotiable Invariants:
//! - Every resource with old tables names either the startup phases that copy them or the owner that moves them in
//!   (`moved_by`), never both, and every phase it names is one the startup preparation runs
//!   (`crate::native_boot::own_records_start::phases`). A resource whose old data no phase copies would read empty on
//!   a real account; `uncopied` answers each such resource and the test `every_old_source_is_copied_at_startup`
//!   refuses it.
//! - A resource that holds new data only says why (`old.none`) and names no phase.
//! - A resource whose old tables move in row by row names each in `copy` (a family of src/storage/families.json, walked
//!   by its one-field key or a declared order, optionally filtered and shaped as the account's own records) and the
//!   generic copy phase; each is one of its own old tables, and only a resource placed in the file the old tables are
//!   in (`OLD_TABLES_OBJECT`) has one (`every_copied_resource_names_a_declared_family_and_the_copy_phase`).
//! - Every placement names a supply this program links (`SUPPLIES`), and a state-folder file is one plain name.
//! - A malformed DATA file answers no resource at all; it is never partly accepted.
//!
//! Key Concepts:
//! - Placement: the file a resource lives in and the supply that reads and writes it. The file is a file of the
//!   account's state folder by name (`{"state": "held-values.sqlite"}`), a per-resource state file
//!   (`{"state-resource": {"prefix": "db-", "suffix": ".sqlite"}}`), or the file of the account's own restored
//!   object with a binding (`{"object": "RECORD_BOOK"}`, found in the restore index). Moving a resource to another
//!   file is a new row value, not code. Resources that name one file share it, and so share its one writer.
//! - Old source: the old store's tables in the account's RecordBook file that held the resource's data.
//!
//! Security Considerations:
//! - Names only. No row holds a value, a path or a key.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
#[cfg_attr(hosted_records, allow(unused_imports))]
use crate::records::Error;
use serde::Deserialize;
#[cfg_attr(hosted_records, allow(unused_imports))]
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::OnceLock,
};
// The module computer (cfg `hosted_records`) opens no placement file: what opens one is left out of its build.
#[cfg(not(hosted_records))]
use crate::{
    sqlite_work::WorkMeter,
    storage::{
        record_store::{full_store::FullStoreRecovery, settings, RecordStore, RealClock},
        sqlite::{self, Access, Handle, Spend, Supply},
        Storage,
    },
};
#[cfg(not(hosted_records))]
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

/// Restart-safe carry state for one source-owned invariant group.
#[path = "record_store_resources/carry.rs"]
pub mod carry;

/// Command-local observations supplied by the selected physical adapter.
#[cfg(not(hosted_records))]
pub(crate) use crate::storage::sqlite::CommandMemo as CommandMemory;



/// Lend the default native command adapter without exporting a concrete
/// supplier to record/key/receipt consumers. The retained writer owns the
/// connection and the caller owns its outer transaction and admission.
#[cfg(not(hosted_records))]
pub(crate) fn command_storage<'a>(
    db: &'a sqlite::Connection, memo: Option<Arc<CommandMemory>>,
) -> crate::storage::Result<Box<dyn Storage + 'a>> {
    let supply = sqlite::lend(db, crate::storage::record_store::SCHEMA, Access::Write)?;
    let supply = match memo { Some(memo) => supply.with_command_memo(memo)?, None => supply };
    Ok(Box::new(supply))
}

/// An account's volume in more than one store (old trillion own-record-volume.json): overflow stores by order.
#[cfg(not(hosted_records))]
#[path = "record_store_resources/books.rs"]
pub mod books;
pub mod book_directory;

/// A list may name its own store (old trillion 2341372f7c): which store a list's rows live in.
#[cfg(not(hosted_records))]
#[path = "record_store_resources/lists.rs"]
pub mod lists;

/// Complete admitted identities select record domains without directory reads.
#[path = "record_store_resources/domains.rs"]
pub mod domains;

const DATA: &[u8] = include_bytes!("record_store_resources.json");
/// Resources only the unit tests declare; never compiled into a shipped build.
#[cfg(test)]
const TEST_DATA: &[u8] = include_bytes!("record_store_test_resources.json");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Data {
    #[serde(rename = "_what")]
    _what: String,
    resources: Vec<Resource>,
    #[serde(default)]
    retire: Option<Retire>,
}

/// The old store's tables the account's RecordBook drops once the migration of `after` is finished (DATA `retire`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Retire {
    #[serde(rename = "_what")]
    pub what: String,
    /// The resource whose finished migration moved the last of their data into record store.
    pub after: String,
    /// The tables named here.
    pub tables: Vec<String>,
    /// The old store's catalogues of its own tables, read before anything is dropped.
    pub listed_in: Vec<ListedIn>,
    /// Bindings of the account's own old object files (the restore index `objects.ndjson`) whose data has moved:
    /// each such file is emptied whole (`sqlite::empty_old_file`). Another account's objects are never touched.
    #[serde(default)]
    pub objects: Vec<String>,
    /// Tables an emptied object file keeps (a name ending in `*` keeps every name it starts): what is kept until it
    /// is ruled on or moved (saved logins, the billing ledgers, data about other people).
    #[serde(default)]
    pub objects_keep: Vec<String>,
}

/// One catalogue of old tables: each row of `table` names one in `column`, with `prefix` put before it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListedIn {
    pub table: String,
    pub column: String,
    #[serde(default)]
    pub prefix: String,
}

/// What retiring the old tables did: the tables dropped, and the file's bytes before and after its rewrite.
#[derive(Debug, serde::Serialize)]
pub struct Retired {
    pub tables: u64,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

/// One record store resource of the account's own stores.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub resource: String,
    pub placement: Placement,
    #[serde(rename = "_what")]
    pub what: String,
    pub readers: Vec<String>,
    pub old: Old,
    #[serde(default)]
    pub startup: Vec<String>,
    /// The resource is a family of names: every resource name that starts with `resource` (the account files' per-folder
    /// name and folder scopes).
    #[serde(default)]
    pub prefix: bool,
    /// The owner file that moves the old tables in (an operator move, not a startup phase), for a resource whose
    /// file the native account does not open at start.
    #[serde(default)]
    pub moved_by: Option<String>,
    /// The old tables the generic startup copy (`own-records-copy`, src/local_account/own_records.rs) moves into this
    /// resource row by row, in order. A resource no copy fills names none.
    #[serde(default)]
    pub copy: Vec<Copy>,
    /// What a replaced version of one of this resource's records becomes: `keep` (the default), a history row kept
    /// for the undo window, so an as-of read reaches it; or `overwrite`, the current row rewritten over itself and no
    /// history row kept, for a resource that holds one large record rewritten as a whole (the secrets snapshot:
    /// old trillion kept it as one `secrets` row overwritten as a whole). Adding a resource that overwrites is a
    /// value here, never code.
    #[serde(default)]
    pub history: History,
    /// The undo window profile of this resource's replaced versions (`settings.json` `undo_windows`): `records` (the
    /// default, 30 days), or `vault` (1 day, so a value overwritten by a put is undoable for a day).
    #[serde(default)]
    pub undo: Undo,
}

/// The undo window profile of a resource (`Resource::undo`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Undo {
    #[default]
    Records,
    Vault,
}

/// The undo window profile of `resource`; `records` when no row declares it.
pub fn undo_of(resource: &str) -> Undo {
    row_of(resource).map_or(Undo::Records, |row| row.undo)
}

/// What a replaced version of a resource's record becomes (`Resource::history`).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum History {
    /// A history row, kept for the undo window.
    #[default]
    Keep,
    /// No history row: the current row is rewritten over itself.
    Overwrite,
}

/// One old table read through the storage boundary (its schema and family in src/storage/families.json) and how its
/// rows become records. Without `order` the walk is the family's key, which must be one field: each row is one record,
/// its id that key and its value every declared field by name.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Copy {
    /// What the copy carries, for the reader of the DATA.
    #[serde(rename = "_what", default)]
    pub what: Option<String>,
    /// The word a Ready position records this copy under (`copied`); the resource's name when absent.
    #[serde(default)]
    pub name: Option<String>,
    pub schema: String,
    pub family: String,
    /// Walk this declared order of the family instead of its key.
    #[serde(default)]
    pub order: Option<String>,
    /// Only rows whose first walked field starts with this text.
    #[serde(default)]
    pub prefix: Option<String>,
    /// The rows are versions of what this field names (the walked order's first field): only the newest, the last in
    /// the order, is copied.
    #[serde(default)]
    pub newest_per: Option<String>,
    /// Rows to leave out: a row is left out when one of these holds.
    #[serde(default)]
    pub skip: Vec<Skip>,
    /// Write each row as one of the account's own records (src/storage/record_store/native.rs `body`) instead of its fields.
    #[serde(default)]
    pub own_record: Option<OwnRecord>,
}

/// A row is left out when its `field` holds JSON text with a non-null value at `pointer`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skip {
    pub field: String,
    pub pointer: String,
}

/// How a copied row becomes one of the account's own records.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnRecord {
    /// The fields naming the record (each text or an integer); the copy's `prefix` is taken off the first. One
    /// field's value is the id as it is; the values of two or more (a table keyed by several fields) are joined by
    /// `:`, each `%` and `:` in a value written `%25` and `%3A`, so two keys never join to one id.
    pub id: Vec<String>,
    /// Put before every copied id, so a kind copied from a table keyed by its own ids keeps them apart from others'.
    #[serde(default)]
    pub id_prefix: Option<String>,
    /// The record kind every copied record has.
    pub kind: String,
    /// The field holding the record's stored JSON text. Absent: the stored value is the row's declared fields by
    /// name, each `json` field as the JSON its text holds.
    #[serde(default)]
    pub stored: Option<String>,
    /// With no `stored`: the fields whose text is JSON.
    #[serde(default)]
    pub json: Vec<String>,
    /// The field holding the time the row was written, which orders the record's sequence: ISO 8601 text, a day
    /// (`YYYY-MM-DD`, its start in UTC) or milliseconds since 1970. Absent when the table keeps no time: every copied
    /// record's sequence is then the start of 1970.
    #[serde(default)]
    pub time: Option<String>,
}

impl Copy {
    /// The word a Ready position records this copy under.
    pub fn name<'a>(&'a self, row: &'a Resource) -> &'a str {
        self.name.as_deref().unwrap_or(&row.resource)
    }
}

/// Where a resource's records are kept: one file of the account, read and written through one supply.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub file: FileOf,
    /// The supply that reads and writes the file: one of `SUPPLIES`.
    pub supply: String,
}

/// A file of the account.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum FileOf {
    /// A file in the account's state folder, by its one plain name.
    State(String),
    /// The file of the account's own restored object with this binding (its row in the restore index).
    Object(String),
    /// One state-folder file per declared resource. A prefix row uses its name suffix; an exact row uses its whole
    /// name. The key is percent-encoded as one filename component between these fixed pieces, so a resource name can
    /// never select a parent or sibling path.
    #[serde(rename = "state-resource")]
    StateResource { prefix: String, suffix: String },
}

impl Placement {
    /// Whether the file is in the account's state folder (not an object's file).
    pub fn in_state_folder(&self) -> bool {
        matches!(self.file, FileOf::State(_) | FileOf::StateResource { .. })
    }

    /// The file's path for the account whose state folder is `state`; None for an object's file, which the account
    /// finds in its restore index.
    pub fn in_state(&self, state: &Path) -> Option<PathBuf> {
        match &self.file {
            FileOf::State(name) => Some(state.join(name)),
            FileOf::Object(_) | FileOf::StateResource { .. } => None,
        }
    }

    /// The path for a declared resource and state folder. A `state-resource` placement uses the suffix of a prefix
    /// row or the full name of an exact row as a filename component; an undeclared resource or unsafe/oversized
    /// component has no path.
    pub fn in_state_for(&self, resource: &str, state: &Path) -> Option<PathBuf> {
        match &self.file {
            FileOf::State(_) => self.in_state(state),
            FileOf::Object(_) => None,
            FileOf::StateResource { prefix, suffix } => {
                let row = row_of(resource)?;
                if !std::ptr::eq(&row.placement, self) {
                    return None;
                }
                let id = if row.prefix {
                    resource.strip_prefix(&row.resource)?
                } else if resource == row.resource {
                    resource
                } else {
                    return None;
                };
                // A file-name component cannot exceed the common filesystem NAME_MAX (255 bytes). This early raw
                // bound avoids expanding an arbitrarily large resource name before the escaped-name bound below.
                if id.is_empty()
                    || id.len() > 255
                    || !plain_name(prefix)
                    || !plain_name(suffix)
                    || prefix.len() + suffix.len() >= 255
                {
                    return None;
                }
                let mut encoded = String::with_capacity(id.len());
                for byte in id.bytes() {
                    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
                        encoded.push(byte as char);
                    } else {
                        use std::fmt::Write as _;
                        write!(&mut encoded, "%{byte:02X}").ok()?;
                    }
                }
                if encoded.len() + prefix.len() + suffix.len() > 255 {
                    return None;
                }
                let name = format!("{prefix}{encoded}{suffix}");
                plain_name(&name).then(|| state.join(name))
            }
        }
    }
}

/// The supplies this program links. A placement naming any other refuses the whole DATA file.
pub const SUPPLIES: [&str; 1] = ["sqlite"];
/// The restored object whose file holds the old store's tables: a resource whose old tables are copied row by row
/// (`copy`) is placed in it, since the copy reads them through the resource's own file.
pub const OLD_TABLES_OBJECT: &str = "RECORD_BOOK";
/// The family schema of every placement file.
#[cfg_attr(hosted_records, allow(dead_code))]
const SCHEMA: &str = "record_store";

/// Where a resource's data was before record store.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum Old {
    /// The old store's tables in the account's RecordBook file.
    Tables(Vec<String>),
    /// New data only, and why.
    None(String),
}

fn parse(bytes: &[u8]) -> Option<Vec<Resource>> {
    parse_data(bytes).map(|data| data.resources)
}

fn parse_data(bytes: &[u8]) -> Option<Data> {
    let data: Data = serde_json::from_slice(bytes).ok()?;
    let mut seen = std::collections::BTreeSet::new();
    let valid = data.resources.iter().all(|row| {
        seen.insert(row.resource.as_str())
            && !row.resource.is_empty()
            && !row.readers.is_empty()
            && SUPPLIES.contains(&row.placement.supply.as_str())
            && match &row.placement.file {
                FileOf::State(name) => plain_name(name),
                FileOf::Object(binding) => !binding.is_empty(),
                FileOf::StateResource { prefix, suffix } => {
                    plain_name(prefix) && plain_name(suffix) && prefix.len() + suffix.len() < 255
                }
            }
            && row.copy.iter().all(|copy| {
                row.placement.file == FileOf::Object(OLD_TABLES_OBJECT.into())
                    && matches!(&row.old, Old::Tables(tables) if tables.contains(&copy.family))
            })
            && match &row.old {
                Old::Tables(tables) => {
                    !tables.is_empty() && row.startup.is_empty() == row.moved_by.is_some()
                }
                Old::None(why) => {
                    !why.is_empty() && row.startup.is_empty() && row.moved_by.is_none()
                }
            }
    });
    // The old tables are retired from the file the old store kept them in, after a resource placed there, and a
    // catalogue is retired with what it lists.
    let retire_valid = data.retire.as_ref().is_none_or(|retire| {
        !retire.tables.is_empty()
            && data.resources.iter().any(|row| {
                row.resource == retire.after
                    && !row.prefix
                    && row.placement.file == FileOf::Object(OLD_TABLES_OBJECT.into())
            })
            && retire
                .listed_in
                .iter()
                .all(|listed| retire.tables.contains(&listed.table))
    });
    (valid && retire_valid).then_some(data)
}

/// One file name: no folder, not `.` or `..`, no NUL.
fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0'])
}

/// Every declared resource; empty when the DATA is malformed.
pub fn all() -> &'static [Resource] {
    static LOADED: OnceLock<Vec<Resource>> = OnceLock::new();
    LOADED.get_or_init(|| {
        #[cfg_attr(not(test), allow(unused_mut))]
        let mut rows = parse(DATA).unwrap_or_default();
        #[cfg(test)]
        rows.extend(parse(TEST_DATA).unwrap_or_default());
        rows
    })
}

/// The shipped old tables to retire; None when the DATA declares none or is malformed.
pub fn retire() -> Option<&'static Retire> {
    static LOADED: OnceLock<Option<Retire>> = OnceLock::new();
    LOADED
        .get_or_init(|| parse_data(DATA).and_then(|data| data.retire))
        .as_ref()
}

#[cfg(not(hosted_records))]
/// Retire the old store's tables (`retire`) from the RecordBook at `path` (canonical), once `finished` says the
/// migration of `retire.after` is done on the record store over that file: resolve every name (the named tables, then
/// each catalogue's list, read before anything is dropped since the catalogues go too), drop them all in one write
/// transaction, then rewrite the file (`Storage::reclaim`) so their bytes leave it. Run with the account's app quit:
/// the rewrite needs the file to itself, and the volume must have room for a second copy of it, or nothing is
/// dropped. A file that no longer has the tables drops none and is still rewritten.
pub fn retire_old(
    path: &Path,
    meter: WorkMeter,
    finished: impl FnOnce(&RecordStore<Supply<Handle>>) -> Result<bool, Error>,
) -> Result<Retired, Error> {
    let retire = retire().ok_or(Error::Invalid(
        "record_store_resources.json declares no old tables to retire",
     crate::cause!()))?;
    let store = open(path, meter)?;
    if !finished(&store)? {
        return Err(Error::Invalid(
            "the migration is not finished; its startup phases still read the old tables",
         crate::cause!()));
    }
    let supply = store.storage();
    let bytes_before = std::fs::metadata(path)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
        .len();
    if settings::volume_free_bytes(path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? <= bytes_before {
        return Err(crate::cause!(Error::Unavailable));
    }
    let mut names = retire.tables.clone();
    for listed in &retire.listed_in {
        names.extend(
            supply
                .old_table_names(&listed.table, &listed.column, &listed.prefix)
                .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        );
    }
    let tables = supply
        .drop_old_tables(&names)
        .map_err(|error| match error {
            crate::storage::Error::Invalid(_) => {
                Error::Invalid("an old table name is not plain, or is a family of the store", crate::cause!())
            }
            crate::storage::Error::Conflict(_) => {
                Error::Invalid("a view or trigger of a kept table names an old table", crate::cause!())
            }
            _ => crate::cause!(Error::Unavailable),
        })?;
    supply.reclaim().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let bytes_after = std::fs::metadata(path)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
        .len();
    Ok(Retired {
        tables,
        bytes_before,
        bytes_after,
    })
}

#[cfg(not(hosted_records))]
/// One old object file emptied by `retire_old_objects`: its binding, the rows carried out of it first, the tables
/// dropped, and its bytes before and after.
#[derive(Debug, serde::Serialize)]
pub struct EmptiedObject {
    pub binding: String,
    pub carried: u64,
    pub tables: u64,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

#[cfg(not(hosted_records))]
/// Empty the account's own old object files whose bindings `retire.objects` lists, in the state folder `state_root`
/// (canonical): each row of the restore index `objects.ndjson` with such a binding and a name naming one of
/// `account_ids` (the account's user and owner ids) is first carried (`carry_old_rows`) into `owner`'s record store in
/// the RecordBook at `book`, then emptied whole but for `retire.objects_keep` (`sqlite::empty_old_file`). A row naming
/// no account id is another account's and stays as it is; a path outside the state folder refuses the whole call
/// before anything is carried or emptied, and so does `allowed` returning false (`own_records::retire_old_objects`:
/// the migration is finished and its first Ready is inside the undo window). Run with the app quit, after the journal
/// records only those files held are carried (examples/old_object_carry.rs).
pub fn retire_old_objects(
    state_root: &Path,
    book: &Path,
    owner: &str,
    account_ids: &[&str],
    meter: WorkMeter,
    allowed: impl FnOnce(&RecordStore<Supply<Handle>>) -> Result<bool, Error>,
) -> Result<Vec<EmptiedObject>, Error> {
    let retire = retire().ok_or(Error::Invalid(
        "record_store_resources.json declares no old tables to retire",
     crate::cause!()))?;
    if account_ids.iter().any(|id| id.len() < 8) {
        return Err(Error::Invalid(
            "an account id is too short to match its objects",
         crate::cause!()));
    }
    let index = std::fs::read(state_root.join("objects.ndjson")).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let mut files = Vec::new();
    for line in index
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let row: serde_json::Value = serde_json::from_slice(line)
            .map_err(|_| Error::Invalid("the restore index is unreadable", crate::cause!()))?;
        let Some(binding) = row["binding"]
            .as_str()
            .filter(|binding| retire.objects.iter().any(|kept| kept == binding))
        else {
            continue;
        };
        let own = row["names"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .any(|name| account_ids.iter().any(|id| name.contains(id)));
        if !own {
            continue;
        }
        let relative = row["sqlite"]
            .as_str()
            .ok_or(Error::Invalid("an object row names no file", crate::cause!()))?;
        let path = state_root
            .join(relative)
            .canonicalize()
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !path.starts_with(state_root) {
            return Err(Error::Invalid("an object file is outside the state folder", crate::cause!()));
        }
        files.push((binding.to_owned(), path));
    }
    let mut store = open(book, meter)?;
    if !allowed(&store)? {
        return Err(Error::Invalid("refused: the carry is allowed only from the migration's finish until its first Ready plus the store's undo window (record_store/settings.json `undo_window_ms`; the moment is `own_records::old_objects_carry_until`); past that a deleted record's tombstone has left, so an old file could bring the record back", crate::cause!()));
    }
    let mut emptied = Vec::with_capacity(files.len());
    for (binding, path) in files {
        let bytes_before = std::fs::metadata(&path)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
            .len();
        if settings::volume_free_bytes(&path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? <= bytes_before {
            return Err(crate::cause!(Error::Unavailable));
        }
        let carried = carry_old_rows(&mut store, owner, &path)?;
        let tables =
            sqlite::empty_old_file(&path, &retire.objects_keep).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let bytes_after = std::fs::metadata(&path)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
            .len();
        emptied.push(EmptiedObject {
            binding,
            carried,
            tables,
            bytes_before,
            bytes_after,
        });
    }
    Ok(emptied)
}

#[cfg(not(hosted_records))]
/// The most rows one page of `carry_old_rows` reads and imports.
const CARRY_ROWS: usize = 256;

#[cfg(not(hosted_records))]
/// Carry every row of the old object file at `object` in a table a `copy` declares (the startup copy's own reader,
/// `old_record_tables::rows_after`, on one read snapshot of the file) into `owner`'s resource of that copy, each id the record store
/// store never held: a held id (a later write, or a deletion's tombstone) stays as it is, as in the startup copy.
/// Every imported value reads back the same, or the carry refuses. Answers the records written.
fn carry_old_rows(
    store: &mut RecordStore<Supply<Handle>>,
    owner: &str,
    object: &Path,
) -> Result<u64, Error> {
    use crate::import::{ImportError, ImportResult, ReadLimits};
    let limits = ReadLimits {
        rows: CARRY_ROWS,
        cell_bytes: 8 * 1024 * 1024,
        result_bytes: 32 * 1024 * 1024,
        vm_steps: 50_000_000,
        elapsed: Duration::from_secs(30),
        ..ReadLimits::default()
    };
    let seen = std::fs::metadata(object).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let watched = object.to_path_buf();
    let witness = move || -> ImportResult<()> {
        let now = std::fs::metadata(&watched)?;
        if now.len() != seen.len() || now.modified()? != seen.modified()? {
            return Err(ImportError::Refused(
                "the old object file changed during the carry",
             crate::cause!()));
        }
        Ok(())
    };
    let flags =
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection =
        rusqlite::Connection::open_with_flags(object, flags).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut source =
        crate::record_source::SnapshotRecordSql::begin(connection, limits, witness, cancelled)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let mut carried = 0u64;
    for (row, copy) in copies() {
        let resource = row.resource.as_str();
        let mut after = None;
        while let Some(page) = crate::storage::old_record_tables::rows_after(
            &mut source,
            copy,
            after.as_ref(),
            CARRY_ROWS,
        )? {
            let mut batch = Vec::with_capacity(page.rows.len());
            for (id, value) in page.rows {
                if store.held_version(owner, resource, &id)? == 0 {
                    batch.push((id, value));
                }
            }
            if !batch.is_empty() {
                store.import(owner, resource, &batch)?;
                let ids: Vec<&str> = batch.iter().map(|(id, _)| id.as_str()).collect();
                let back = store.get_many(owner, resource, &ids)?;
                if !back.iter().zip(&batch).all(|(record, (_, value))| {
                    record.as_ref().is_some_and(|record| &record.value == value)
                }) {
                    return Err(Error::Invalid("a carried record reads back different", crate::cause!()));
                }
                carried += batch.len() as u64;
            }
            match page.last {
                Some(last) => after = Some(last),
                None => break,
            }
        }
    }
    Ok(carried)
}

/// The row of `resource`: its exact name, or a name under a `prefix` row.
fn row_of(resource: &str) -> Option<&'static Resource> {
    all()
        .iter()
        .filter(|row| {
            if row.prefix {
                resource.starts_with(row.resource.as_str())
            } else {
                row.resource == resource
            }
        })
        .max_by_key(|row| row.resource.len())
}

/// Whether `resource` has a row. The record store refuses every other resource (`crate::storage::record_store`), so a reader
/// cannot invent a resource no row declares.
pub fn declares(resource: &str) -> bool {
    row_of(resource).is_some()
}

/// Whether a replaced version of a record of `resource` is rewritten over itself with no history row (`History::Overwrite`).
pub fn overwrites(resource: &str) -> bool {
    row_of(resource).is_some_and(|row| row.history == History::Overwrite)
}

/// Where `resource` is placed; None when no row declares it.
pub fn placement(resource: &str) -> Option<&'static Placement> {
    row_of(resource).map(|row| &row.placement)
}

/// The one resource that `reader` (a source file, `file!()`) reads; None when no row, or more than one, declares it.
pub fn resource_of(reader: &str) -> Option<&'static str> {
    let mut found = all()
        .iter()
        .filter(|row| row.readers.iter().any(|known| known == reader));
    let row = found.next()?;
    found.next().is_none().then_some(row.resource.as_str())
}

#[cfg(not(hosted_records))]
/// The limits of a store of `supply` in the file at `path` on this computer: the computer's record bound (record store settings) and the
/// byte budget the computer's own report gives, sized to the disk the file is on.
pub fn computer_limits(supply: &impl Storage, path: &Path) -> Result<settings::Limits, Error> {
    let volume = settings::Volume {
        store_bytes: supply.allocated_bytes().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        free_bytes: settings::volume_free_bytes(path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
    };
    computer_limits_from(crate::account::computers::this_computer(), &volume)
}

#[cfg(not(hosted_records))]
/// The limits a computer with `report` gives a store on a volume of `volume`.
pub fn computer_limits_from(
    report: &crate::account::computers::ComputerReport,
    volume: &settings::Volume,
) -> Result<settings::Limits, Error> {
    let shipped = settings::shipped().ok_or(crate::cause!(Error::Unavailable))?;
    let byte_budget =
        settings::budget_bytes(report.storage, Some(*volume)).ok_or(crate::cause!(Error::Unavailable))?;
    Ok(settings::Limits {
        max_record_bytes: shipped.computer_record_bytes,
        byte_budget,
    })
}

/// The store budget of a placement file: its limits and the volume reserve this computer keeps (`None` for a fixed budget).
/// The production values come from `computer_limits` and `this_computer_reserve`; a test passes its own.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StoreBudget {
    pub limits: settings::Limits,
    pub reserve: Option<u64>,
}

/// The volume reserve this computer keeps: its keep-free floor, or none when its report fixes the budget in bytes.
pub fn this_computer_reserve() -> Option<u64> {
    match crate::account::computers::this_computer().storage {
        settings::Budget::KeepFreeBytes(reserve) => Some(reserve),
        settings::Budget::Bytes(_) => None,
    }
}

#[cfg(not(hosted_records))]
/// The record store over `supply`, a handle on the placement file at `path` its owner keeps (a command transaction, a
/// retained handle), with the native limits for that file.
pub fn native<S: Storage>(supply: S, path: &Path) -> Result<RecordStore<S>, Error> {
    let limits = computer_limits(&supply, path)?;
    native_with_limits(supply, path, limits, this_computer_reserve())
}

#[cfg(not(hosted_records))]
/// The record store over `supply` for the placement file at `path`, with the limits its owner already holds (`limits`, the
/// one a caller computed from the same computer's report). Every placement store goes through here, so each gets the
/// full-store recovery and the computer's keep-free reserve (D37), whichever limits its owner passes.
pub fn native_with_limits<S: Storage>(supply: S, path: &Path, limits: settings::Limits, reserve: Option<u64>) -> Result<RecordStore<S>, Error> {
    // Each placement file has its one full-store recovery in this process (full_store.rs, beside the record store). The
    // computer's keep-free reserve is checked before each write on the file's volume (`with_volume_reserve`, D37).
    let store = RecordStore::new(supply, Box::new(RealClock), limits)?.with_recovery(FullStoreRecovery::for_store(path));
    Ok(match reserve {
        Some(reserve) => store.with_volume_reserve(reserve),
        None => store,
    })
}

#[cfg(not(hosted_records))]
/// The bounds of every placement file handle: a 64 MiB value bound, no work or time allowance of its own (each
/// operation's owner bounds it), and five seconds for another writer of the file.
pub(crate) fn bounds() -> sqlite::Bounds {
    sqlite::Bounds {
        value_bytes: 64 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    }
}

#[cfg(not(hosted_records))]
/// Whether `folder` (canonical) is an ephemeral root a kept store must never use: the system temporary folders, which a
/// reboot or power cut clears (2026-11-11: /private/tmp was wiped with every lane's uncommitted work), or a tmpfs.
pub fn ephemeral_root(folder: &Path) -> bool {
    ["/tmp", "/private/tmp", "/private/var/tmp"].iter().any(|root| folder.starts_with(root)) || is_tmpfs(folder)
}

#[cfg(all(not(hosted_records), target_os = "linux"))]
fn is_tmpfs(folder: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    const TMPFS_MAGIC: i64 = 0x0102_1994;
    let Ok(name) = std::ffi::CString::new(folder.as_os_str().as_bytes()) else {
        return false;
    };
    let mut buffer = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: statfs fills the buffer only when it returns 0, and the buffer is read only after that.
    if unsafe { libc::statfs(name.as_ptr(), buffer.as_mut_ptr()) } != 0 {
        return false;
    }
    // SAFETY: the successful call above initialised the buffer.
    let filesystem = unsafe { buffer.assume_init() };
    filesystem.f_type as i64 == TMPFS_MAGIC
}

#[cfg(all(not(hosted_records), not(target_os = "linux")))]
fn is_tmpfs(_folder: &Path) -> bool {
    false
}

#[cfg(not(hosted_records))]
/// Open the placement file at `path` (canonical) for reading and writing, creating it with every record store family when
/// absent: durable WAL commits and the work of every statement counted on `meter`. A file has one such writer. A kept
/// store never opens on an ephemeral root (D36): the parent folder must resolve to a durable one.
pub fn open(path: &Path, meter: WorkMeter) -> Result<RecordStore<Supply<Handle>>, Error> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let folder = std::fs::canonicalize(parent).map_err(|_| crate::cause!(Error::Unavailable))?;
    if ephemeral_root(&folder) {
        return Err(crate::cause!(Error::Unavailable));
    }
    // A file made here starts with the shipped page size (src/storage/record_store/settings.json `page_bytes`); a file that
    // already has pages keeps its own.
    let page_bytes = settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.page_bytes;
    native(
        sqlite::open_owned_observed_paged(path, SCHEMA, bounds(), meter, Some(page_bytes))
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        path,
    )
}

#[cfg(not(hosted_records))]
/// Open an existing selected placement for reads only: no create, schema migration, recovery write or immutable
/// snapshot assumption. The SQLite owner applies READ_ONLY, NOFOLLOW and query_only while retaining current WAL
/// visibility, work accounting and the same record and volume limits as the writable placement owner.
pub fn open_read_only(path: &Path, meter: WorkMeter) -> Result<RecordStore<Supply<Handle>>, Error> {
    // SQLite NOFOLLOW refuses links anywhere in its filename, including this computer's /var alias. As the
    // existing vault placement opener does, resolve the parent only, preserving the final name for NOFOLLOW and
    // symlink_metadata to refuse. Resolving the whole path would silently admit a final symbolic link.
    let file = path.file_name().ok_or(crate::cause!(Error::Unavailable))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let path = std::fs::canonicalize(parent)
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
        .join(file);
    if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
        return Err(crate::cause!(Error::Unavailable));
    }
    let selected = sqlite::Selected {
        access: Access::Read,
        bounds: bounds(),
        meter: Some(meter),
        trusted_schema: false,
    };
    let supply = sqlite::open_selected(&path, SCHEMA, selected).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let limits = computer_limits(&supply, &path)?;
    RecordStore::new(supply, Box::new(RealClock), limits)
}

#[cfg(not(hosted_records))]
/// Resolve and open a resource placed in the account's state folder. Static files and resource-derived files use the
/// same opener; an object placement must be resolved by its restore-index owner instead. Returns the path alongside
/// the store so that the consumer can retain matching readers/writers and verify the selected file on reopen.
pub fn open_state_resource(
    resource: &str,
    state: &Path,
    meter: WorkMeter,
) -> Result<(PathBuf, RecordStore<Supply<Handle>>), Error> {
    let state = state.canonicalize().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    let path = placement(resource)
        .and_then(|placement| placement.in_state_for(resource, &state))
        .ok_or(Error::Invalid("the resource has no state-folder placement", crate::cause!()))?;
    let store = open(&path, meter)?;
    Ok((path, store))
}

#[cfg(not(hosted_records))]
/// The state-folder resource owner: resolve every access through declared
/// placement and share one reader/writer owner for each physical file. A
/// resource address is the routing key; this does not infer a partition from
/// arbitrary record ids or kinds.
pub struct StateResources {
    state: PathBuf,
    meter: WorkMeter,
    readers: Mutex<HashMap<PathBuf, std::sync::Weak<Readers>>>,
    writers: Mutex<HashMap<PathBuf, std::sync::Weak<WriterEntry>>>,
    idle_readers: Mutex<Vec<Arc<Readers>>>,
    idle_writers: Mutex<Vec<Arc<Writer>>>,
}

#[cfg(not(hosted_records))]
/// One physical file's initialization, independent of the common map. A failed open leaves this entry empty so
/// another call can try again; callers of that same file never race its schema installation.
struct WriterEntry {
    writer: Mutex<std::sync::Weak<Writer>>,
}

#[cfg(not(hosted_records))]
impl StateResources {
    /// Bind to an existing canonical state folder. No data file is opened yet.
    pub fn new(state: &Path, meter: WorkMeter) -> Result<Self, Error> {
        let state = state.canonicalize().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !state.is_dir() {
            return Err(crate::cause!(Error::Unavailable));
        }
        Ok(Self {
            state,
            meter,
            readers: Mutex::new(HashMap::new()),
            writers: Mutex::new(HashMap::new()),
            idle_readers: Mutex::new(Vec::new()),
            idle_writers: Mutex::new(Vec::new()),
        })
    }

    fn path(&self, resource: &str) -> Result<PathBuf, Error> {
        placement(resource)
            .and_then(|placement| placement.in_state_for(resource, &self.state))
            .ok_or(Error::Invalid("the resource has no state-folder placement", crate::cause!()))
    }

    /// Resolve one declared resource to its physical file's shared readers.
    pub fn readers(&self, resource: &str) -> Result<Arc<Readers>, Error> {
        let path = self.path(resource)?;
        let limit = settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.idle_resources;
        let reader = {
            let mut readers = self.readers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            readers.retain(|_, reader| reader.strong_count() > 0);
            if let Some(reader) = readers.get(&path).and_then(std::sync::Weak::upgrade) { reader }
            else {
                let reader = Arc::new(Readers::new(path.clone(), self.meter.clone()));
                readers.insert(path, Arc::downgrade(&reader));
                reader
            }
        };
        let retired = {
            let mut idle = self.idle_readers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !idle.iter().any(|held| Arc::ptr_eq(held, &reader)) { idle.push(reader.clone()); }
            let excess = idle.len().saturating_sub(limit);
            idle.drain(..excess).collect::<Vec<_>>()
        };
        // Active callers keep this exact owner alive after its cache reference leaves.
        drop(retired);
        Ok(reader)
    }

    /// Resolve one declared resource to its physical file's shared writer.
    /// The common opener creates/validates the record store family before a retained
    /// command writer can borrow the path.
    /// The record store settings of the account this state folder holds: the shipped settings plus the orders its
    /// installed tools join (`own_records::installed_settings`), the settings its writers open with.
    pub fn settings(&self) -> Result<&'static settings::Settings, Error> {
        crate::local_account::own_records::installed_settings(&self.state).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    pub fn writer(&self, resource: &str) -> Result<Arc<Writer>, Error> {
        self.writer_for(resource, true)
    }

    /// Open only an existing domain. Ordinary calls never create or migrate a
    /// missing resource, even when a previous handle remains in the registry.
    pub(crate) fn existing_writer(&self, resource: &str) -> Result<Arc<Writer>, Error> {
        self.writer_for(resource, false)
    }

    fn writer_for(&self, resource: &str, create: bool) -> Result<Arc<Writer>, Error> {
        let path = self.path(resource)?;
        if !create {
            file_at(&path)?;
        }
        // Publish the file's initialization entry before opening it, then drop the common map hold. Opening or
        // installing this book waits only on this entry, never on another resource's initialization.
        let limit = settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.idle_resources;
        let entry = {
            let mut writers = self.writers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            writers.retain(|_, entry| entry.strong_count() > 0);
            if let Some(entry) = writers.get(&path).and_then(std::sync::Weak::upgrade) { entry }
            else {
                let entry = Arc::new(WriterEntry { writer: Mutex::new(std::sync::Weak::new()) });
                writers.insert(path.clone(), Arc::downgrade(&entry));
                entry
            }
        };
        let mut kept = entry
            .writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let writer = if let Some(writer) = kept.upgrade() { writer } else {
        // The same physical file has one schema installer. Only success fills the entry: a source error is still
        // answered to this caller, while a later call may retry without replacing the shared entry under waiters.
        if create {
            let (_opened_path, store) = open_state_resource(resource, &self.state, self.meter.clone())?;
            drop(store);
        }
        let mut writer = Writer::new(
            path,
            self.meter.clone(),
            64 * 1024 * 1024,
        );
        writer.entry = Some(entry.clone());
        let writer = Arc::new(writer);
        *kept = Arc::downgrade(&writer);
        writer
        };
        drop(kept);
        let retired = {
            let mut idle = self.idle_writers.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !idle.iter().any(|held| Arc::ptr_eq(held, &writer)) { idle.push(writer.clone()); }
            let excess = idle.len().saturating_sub(limit);
            idle.drain(..excess).collect::<Vec<_>>()
        };
        // Closing handles can perform I/O and happens outside all registry holds.
        drop(retired);
        Ok(writer)
    }
}

#[cfg(not(hosted_records))]
/// The shipped record store settings (the readers' default when no tool's orders are joined).
fn shipped_settings() -> Result<&'static settings::Settings, Error> {
    settings::shipped().ok_or(crate::cause!(Error::Unavailable))
}

/// The most idle readers a placement file keeps.
const IDLE_READERS: usize = 8;

#[cfg(not(hosted_records))]
/// Read-only handles of one placement file, kept for the next read. A read takes one (`read`), holds one read
/// transaction on it (one WAL snapshot: the read sees one committed state of the file and never waits on its writer),
/// reads through a fresh record store lent that handle, so no memory a store keeps between reads outlives the read, and
/// gives the handle back.
pub struct Readers {
    path: PathBuf,
    meter: WorkMeter,
    /// The native limits of the file, sized when the first handle opened.
    limits: OnceLock<settings::Limits>,
    idle: Mutex<Vec<Supply<Handle>>>,
}

#[cfg(not(hosted_records))]
impl Readers {
    /// The readers of the existing placement file at `path` (canonical), their work counted on `meter`.
    pub fn new(path: PathBuf, meter: WorkMeter) -> Self {
        Self {
            path,
            meter,
            limits: OnceLock::new(),
            idle: Mutex::new(Vec::new()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The account's books at this placement, for a read that spans every book (the books share the placement's meter).
    pub fn books(&self) -> books::Books {
        books::Books::new(&self.path, self.meter.clone(), None)
    }

    /// Run `read` on a store over one handle inside one read transaction. The handle goes back to the idle readers
    /// only when the read and its transaction both ended cleanly.
    pub fn read<T, E: From<Error>>(
        &self,
        read: impl for<'c> FnOnce(RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.read_with(shipped_settings().map_err(E::from)?, read)
    }

    /// `read` with the record store settings of the account's installed tools (`settings::with_joined_orders`): the
    /// orders the tools declare are the ones a list reads through.
    pub fn read_with<T, E: From<Error>>(
        &self,
        settings: &'static settings::Settings,
        read: impl for<'c> FnOnce(RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.read_handle(self.take()?, true, settings, read)
    }

    /// A single current physical read with its owner's existing cancellation,
    /// time and work budget. A fresh handle spends one whole allowance, so it
    /// cannot inherit an idle reader's old budget or retain an expired one.
    pub fn read_bounded<T, E: From<Error>>(
        &self,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        until: std::time::Instant,
        read: impl for<'c> FnOnce(RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.read_bounded_with(shipped_settings().map_err(E::from)?, cancel, until, read)
    }

    /// `read_bounded` with the record store settings of the account's installed tools (see `read_with`).
    pub fn read_bounded_with<T, E: From<Error>>(
        &self,
        settings: &'static settings::Settings,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        until: std::time::Instant,
        read: impl for<'c> FnOnce(RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
    ) -> Result<T, E> {
        let left = until.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(E::from(crate::cause!(Error::Unavailable)));
        }
        let mut allowance = bounds();
        allowance.work = COMMAND_STEPS;
        allowance.deadline = left;
        allowance.spend = Spend::WholeHandle;
        allowance.cancel = Some(cancel);
        allowance.busy = left;
        let handle = sqlite::open_selected(&self.path, SCHEMA, sqlite::Selected {
            access: Access::Read,
            bounds: allowance,
            meter: Some(self.meter.clone()),
            trusted_schema: false,
        }).map_err(|error| E::from(crate::carry_cause!(Error::Unavailable, error)))?;
        self.read_handle(handle, false, settings, read)
    }

    fn read_handle<T, E: From<Error>>(
        &self,
        handle: Supply<Handle>,
        keep_idle: bool,
        settings: &'static settings::Settings,
        read: impl for<'c> FnOnce(RecordStore<Supply<&'c sqlite::Connection>>) -> Result<T, E>,
    ) -> Result<T, E> {
        let limits = match self.limits.get() {
            Some(limits) => *limits,
            None => {
                let sized = computer_limits(&handle, &self.path)?;
                *self.limits.get_or_init(|| sized)
            }
        };
        // The door and tool reads share this boundary. A retained physical handle
        // starts a NEW snapshot after the preceding acknowledged commit. In
        // particular, never reuse an open snapshot and sample a later frontier
        // beside it. RecordStore's caches are new for this transaction too.
        let scope = crate::storage::Scope::current_read(&handle)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let answer = RecordStore::with_settings(handle.lent_read(), Box::new(RealClock), settings, limits)
            .map_err(E::from)
            .and_then(read);
        let closed = scope.commit();
        if keep_idle && answer.is_ok() && closed.is_ok() {
            let mut idle = self
                .idle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if idle.len() < IDLE_READERS {
                idle.push(handle);
            }
        }
        let answer = answer?;
        closed.map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(answer)
    }

    fn take(&self) -> Result<Supply<Handle>, Error> {
        if let Some(handle) = self
            .idle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop()
        {
            return Ok(handle);
        }
        let selected = sqlite::Selected {
            access: Access::Read,
            bounds: bounds(),
            meter: Some(self.meter.clone()),
            trusted_schema: false,
        };
        sqlite::open_selected(&self.path, SCHEMA, selected).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }
}

#[cfg(not(hosted_records))]
/// The page cache of a kept writer, in KiB (64 MiB, filled only as pages are read).
const WRITER_CACHE_KIB: u32 = 64 * 1024;
#[cfg(not(hosted_records))]
/// The SQLite steps one command may take on a lent writer, and how often its stop is read.
const COMMAND_STEPS: u64 = 2_000_000;
#[cfg(not(hosted_records))]
const COMMAND_STEP_CHECK: i32 = 1000;
#[cfg(not(hosted_records))]
/// The longest a command's first transaction waits for another connection of its file to give up the write lock
/// (`LentWriter::begin_waiting`); within the command's own deadline.
const BEGIN_WAIT: Duration = Duration::from_secs(1);

/// Run one step that may need another connection's lock, waiting up to `BEGIN_WAIT` (never past `deadline`) for it, then leave
/// the connection at no wait: every later statement of the command fails at once on contention, as before. The one wait every
/// write path uses: the command's transaction, its delivery, and the writer's own opening statements. `failed` names a
/// failure to set the wait (`busy_timeout`) as the caller's error.
fn waiting_for_lock<'a, T, E>(
    db: &'a rusqlite::Connection,
    deadline: std::time::Instant,
    failed: impl Fn(rusqlite::Error) -> E,
    step: impl FnOnce(&'a rusqlite::Connection) -> Result<T, E>,
) -> Result<T, E> {
    let wait = deadline.saturating_duration_since(std::time::Instant::now()).min(BEGIN_WAIT);
    db.busy_timeout(wait).map_err(&failed)?;
    let stepped = step(db);
    let stopped = db.busy_timeout(Duration::ZERO);
    let value = stepped?;
    stopped.map_err(&failed)?;
    Ok(value)
}

#[cfg(not(hosted_records))]
/// The one read-write handle of a placement file kept for its account's commands, beside its `Readers`: kept
/// between commands, so each command after the first finds the schema parsed and the pages it read last still
/// cached (the interior pages of every index a write descends; SQLite's default 2 MiB cache holds too few of them
/// for an account of millions of pages). A command borrows it (`lend`) only while it is open on the file now at the
/// path (the same device and inode); it comes back with no progress handler and no open transaction, or it is
/// closed. A borrow still out, another file at the path or a transaction left open makes the next command open its
/// own handle. Removed bytes are overwritten as they commit (`PRAGMA secure_delete=ON`, as `sqlite::open_owned`),
/// so a destroyed record leaves the file on this handle too.
pub struct Writer {
    path: PathBuf,
    meter: WorkMeter,
    /// Keeps the single-flight registry entry alive while any caller or cache holds this owner.
    /// The entry points back weakly, so inactive owners have no cycle.
    entry: Option<Arc<WriterEntry>>,
    /// The longest value one statement may hold on this handle.
    value_bytes: i32,
    kept: Mutex<Option<WriterHandle>>,
}

#[cfg(not(hosted_records))]
/// One read-write connection of a placement file, the file (device, inode) it was opened on, and the record store search
/// memory its last committed command left (`LentWriter::keep_search`).
pub struct WriterHandle {
    observed: crate::sqlite_work::ObservedConnection,
    file: (u64, u64),
    search: std::cell::RefCell<Option<crate::storage::record_store::SearchMemory>>,
}

#[cfg(not(hosted_records))]
/// A writer lent to one command, armed with its budget; dropping it gives the handle back (`Writer`).
pub struct LentWriter {
    writer: std::sync::Arc<Writer>,
    handle: Option<WriterHandle>,
}

#[cfg(not(hosted_records))]
/// The device and inode of the file at `path`, not following a link.
fn file_at(path: &Path) -> Result<(u64, u64), Error> {
    use crate::tool_runs::os::{OwnerFiles, This};
    let meta = std::fs::symlink_metadata(path).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if !meta.file_type().is_file() {
        return Err(crate::cause!(Error::Unavailable));
    }
    let facts = This::facts(&meta).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    Ok((facts.device, facts.inode))
}

#[cfg(not(hosted_records))]
impl Writer {
    /// The writer of the existing placement file at `path` (canonical), its work counted on `meter`, a statement's
    /// values bounded by `value_bytes`.
    pub fn new(path: PathBuf, meter: WorkMeter, value_bytes: i32) -> Self {
        Self {
            path,
            meter,
            entry: None,
            value_bytes,
            kept: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Lend the kept handle (or a new one) to one command, which stops at `cancel`, at `deadline` or after
    /// `COMMAND_STEPS` SQLite steps.
    pub fn lend(
        self: &std::sync::Arc<Self>,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        deadline: std::time::Instant,
    ) -> Result<LentWriter, Error> {
        let file = file_at(&self.path)?;
        let kept = self
            .kept
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let handle = match kept {
            Some(handle) if handle.file == file => handle,
            _ => self.open(file)?,
        };
        handle.arm(cancel, deadline);
        Ok(LentWriter {
            writer: self.clone(),
            handle: Some(handle),
        })
    }

    fn open(&self, file: (u64, u64)) -> Result<WriterHandle, Error> {
        let db = rusqlite::Connection::open_with_flags(
            &crate::storage::sqlite::no_follow_path(&self.path),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
                | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        // SAFETY: a connection opened just now has no prepared statement and no trace hook.
        let observed = unsafe {
            crate::sqlite_work::ObservedConnection::attach_untraced(db, self.meter.clone())
        }
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let db = observed.connection();
        db.busy_timeout(Duration::ZERO)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        db.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            self.value_bytes,
        );
        let opened = std::time::Instant::now() + BEGIN_WAIT;
        waiting_for_lock(db, opened, |error| crate::carry_cause!(Error::Unavailable, error), |db| {
            db.execute_batch("PRAGMA secure_delete=ON").map_err(|error| crate::carry_cause!(Error::Unavailable, error))
        })?;
        waiting_for_lock(db, opened, |error| crate::carry_cause!(Error::Unavailable, error), |db| {
            sqlite::keep_pages(db, WRITER_CACHE_KIB).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
        })?;
        Ok(WriterHandle {
            observed,
            file,
            search: std::cell::RefCell::new(None),
        })
    }
}

#[cfg(not(hosted_records))]
impl WriterHandle {
    fn connection(&self) -> &rusqlite::Connection {
        self.observed.connection()
    }

    /// End a command on this handle: no progress handler, and a transaction still open rolled back. Answers whether
    /// the handle is back in autocommit.
    /// Stop at `cancel`, at `deadline` or after `COMMAND_STEPS` SQLite steps.
    fn arm(
        &self,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        deadline: std::time::Instant,
    ) {
        let steps = std::sync::atomic::AtomicU64::new(0);
        self.connection().progress_handler(
            COMMAND_STEP_CHECK,
            Some(move || {
                cancel.load(std::sync::atomic::Ordering::Acquire)
                    || std::time::Instant::now() >= deadline
                    || steps.fetch_add(
                        COMMAND_STEP_CHECK as u64,
                        std::sync::atomic::Ordering::Relaxed,
                    ) >= COMMAND_STEPS
            }),
        );
    }

    fn release(&self) -> bool {
        self.connection().progress_handler(0, None::<fn() -> bool>);
        let _ = self.connection().busy_timeout(Duration::ZERO);
        if !self.connection().is_autocommit() {
            let _ = self.connection().execute_batch("ROLLBACK");
        }
        self.connection().is_autocommit()
    }
}

#[cfg(not(hosted_records))]
impl LentWriter {
    fn held(&self) -> &WriterHandle {
        self.handle
            .as_ref()
            .expect("a lent writer holds its handle until it is dropped")
    }

    pub fn connection(&self) -> &rusqlite::Connection {
        self.held().connection()
    }

    /// The selected adapter of this retained writer. It opens no second
    /// connection and owns no transaction; all physical calls remain here.
    pub(crate) fn storage(&self) -> Result<Box<dyn Storage + '_>, Error> {
        command_storage(self.connection(), None).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    /// Independent command-local schema/layout memo, bound to this actual
    /// observed connection. The observer invalidates it on DDL and rollback.
    pub(crate) fn command_memory(&self) -> Arc<CommandMemory> {
        sqlite::CommandMemo::new(self.held().observed.schema_observation())
    }

    /// The SQLite handle's address: the identity a command's steps check they still run on.
    pub fn handle(&self) -> usize {
        // SAFETY: only the pointer's address is read; it is never dereferenced or used as a handle here.
        (unsafe { self.connection().handle() }) as usize
    }

    pub fn begin(
        &self,
        behavior: rusqlite::TransactionBehavior,
    ) -> Result<rusqlite::Transaction<'_>, Error> {
        rusqlite::Transaction::new_unchecked(self.connection(), behavior)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    /// Begin the command's transaction, waiting up to `BEGIN_WAIT` (never past `deadline`) while another connection
    /// of the file (another process, a startup copy) holds its write lock, instead of failing at once. Only the begin
    /// waits: every later statement of the command fails at once on contention, as before.
    pub fn begin_waiting(
        &self,
        behavior: rusqlite::TransactionBehavior,
        deadline: std::time::Instant,
    ) -> Result<rusqlite::Transaction<'_>, Error> {
        waiting_for_lock(
            self.connection(),
            deadline,
            |error| crate::carry_cause!(Error::Unavailable, error),
            |db| rusqlite::Transaction::new_unchecked(db, behavior).map_err(|error| crate::carry_cause!(Error::Unavailable, error)),
        )
    }

    /// The record store search memory the last command on this handle kept (`keep_search`), for this command's stores; empty
    /// on a new handle. Each scope in it is checked against the file at its use (`RecordStore::carry_search`).
    pub fn take_search(&self) -> crate::storage::record_store::SearchMemory {
        self.held().search.borrow_mut().take().unwrap_or_default()
    }

    /// Keep `memory` on this handle for the next command; only a command whose transaction committed keeps it.
    pub fn keep_search(&self, memory: crate::storage::record_store::SearchMemory) {
        *self.held().search.borrow_mut() = Some(memory);
    }

    /// End the command's budget at its commit and give the read that delivers its answer its own: it stops at
    /// `cancel` or after `bound` (or `COMMAND_STEPS` steps), and waits up to `bound` for another connection of the
    /// file instead of failing at once. A committed command's answer then never fails on the budget its writes spent.
    pub fn bound_delivery(
        &self,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        bound: Duration,
    ) -> Result<(), Error> {
        let handle = self.held();
        handle.arm(cancel, std::time::Instant::now() + bound);
        handle
            .connection()
            .busy_timeout(bound)
            .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
    }

    /// Stop counting this command's budget: a transaction it keeps open past its command reads nothing more.
    pub fn clear_progress(&self) {
        self.connection().progress_handler(0, None::<fn() -> bool>);
    }
}

#[cfg(not(hosted_records))]
impl Drop for LentWriter {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        if handle.release() {
            *self
                .writer
                .kept
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(handle);
        }
    }
}

/// Every copy the generic startup copy runs, with the resource it fills, in DATA order.
pub fn copies() -> impl Iterator<Item = (&'static Resource, &'static Copy)> {
    all()
        .iter()
        .flat_map(|row| row.copy.iter().map(move |copy| (row, copy)))
}

/// The resources whose old tables no phase in `phases` copies: each with the phases it names that do not run.
pub fn uncopied<'a>(rows: &'a [Resource], phases: &[&str]) -> Vec<(&'a str, Vec<&'a str>)> {
    rows.iter()
        .filter(|row| row.moved_by.is_none() && matches!(row.old, Old::Tables(_)))
        .filter_map(|row| {
            let missing: Vec<&str> = row
                .startup
                .iter()
                .map(String::as_str)
                .filter(|phase| !phases.contains(phase))
                .collect();
            (row.startup.is_empty() || !missing.is_empty())
                .then_some((row.resource.as_str(), missing))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kept_store_refuses_an_ephemeral_root() {
        assert!(ephemeral_root(Path::new("/private/tmp")));
        assert!(ephemeral_root(Path::new("/tmp/lane-export")));
        assert!(!ephemeral_root(Path::new("/Users/example/dev/trillion-rust/.git/scratch")));
        let refused = open(Path::new("/private/tmp/trillion-d36-refusal/records.sqlite"), WorkMeter::new());
        assert!(refused.is_err(), "a placement file on /private/tmp must not open");
        assert!(!Path::new("/private/tmp/trillion-d36-refusal").exists(), "the refusal creates nothing");
    }

    /// The production budget (`StoreBudget` with no test value, as `own_records` builds it) is this computer's own
    /// limits and keep-free reserve: the reserve is the report's floor, and the byte budget is the one the same report
    /// gives a volume.
    #[cfg(not(hosted_records))]
    #[test]
    fn the_production_budget_is_this_computers_limits_and_reserve() {
        let report = crate::account::computers::this_computer();
        let expected_reserve = match report.storage {
            settings::Budget::KeepFreeBytes(reserve) => Some(reserve),
            settings::Budget::Bytes(_) => None,
        };
        assert_eq!(this_computer_reserve(), expected_reserve);
        let volume = settings::Volume { store_bytes: 1 << 20, free_bytes: 1 << 40 };
        let limits = computer_limits_from(report, &volume).unwrap();
        assert_eq!(Some(limits.byte_budget), settings::budget_bytes(report.storage, Some(volume)));
        assert_eq!(limits.max_record_bytes, settings::shipped().unwrap().computer_record_bytes);
    }

    /// Concurrent first users of one physical file share its cold initialization and the published owner.
    #[cfg(not(hosted_records))]
    #[test]
    fn inactive_resource_owners_are_bounded_and_active_owners_survive_churn() {
        use std::{sync::atomic::AtomicBool, time::Instant};
        let temporary = tempfile::tempdir().unwrap();
        let resources = StateResources::new(temporary.path(), WorkMeter::new()).unwrap();
        let limit = settings::shipped().unwrap().idle_resources;
        let active = resources.writer("@list/active").unwrap();
        let lent = active.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(10)).unwrap();
        let reader = resources.readers("@list/active").unwrap();
        let first = resources.writer("@list/first").unwrap();
        let expired = Arc::downgrade(&first);
        drop(first);
        for index in 0..(limit * 3) {
            let name = format!("@list/churn-{index}");
            let writer = resources.writer(&name).unwrap();
            drop(writer.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(10)).unwrap());
            resources.readers(&name).unwrap();
        }
        assert!(expired.upgrade().is_none(), "an inactive owner's connection must close");
        assert!(resources.idle_writers.lock().unwrap().len() <= limit);
        assert!(resources.idle_readers.lock().unwrap().len() <= limit);
        assert!(Arc::ptr_eq(&active, &resources.writer("@list/active").unwrap()), "active leases preserve the same single-flight owner");
        assert!(Arc::ptr_eq(&reader, &resources.readers("@list/active").unwrap()));
        drop(lent);
        resources.existing_writer("@list/first").unwrap();
    }

    /// Concurrent first users of one physical file share its cold initialization and the published owner.
    #[cfg(not(hosted_records))]
    #[test]
    fn concurrent_cold_openers_of_one_resource_share_one_writer() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let resources = Arc::new(StateResources::new(&state, WorkMeter::new()).unwrap());
        let start = Arc::new(std::sync::Barrier::new(8));
        let workers = (0..8).map(|_| {
            let (resources, start) = (resources.clone(), start.clone());
            std::thread::spawn(move || { start.wait(); resources.writer("@list/shared") })
        }).collect::<Vec<_>>();
        let owners = workers.into_iter().map(|worker| worker.join().unwrap().unwrap()).collect::<Vec<_>>();
        assert!(owners.iter().all(|owner| Arc::ptr_eq(owner, &owners[0])));
        let value = serde_json::json!({"words":"after simultaneous opens"});
        assert_eq!(written_back(&state, "@list/shared", "same-path", &value), value);
    }

    /// Write one record into the state resource `resource` and read it back from the file.
    #[cfg(not(hosted_records))]
    fn written_back(state: &Path, resource: &str, id: &str, value: &serde_json::Value) -> serde_json::Value {
        use crate::records::Records;
        let (_, mut store) = open_state_resource(resource, state, WorkMeter::new()).unwrap();
        store.mutate("account", resource, crate::records::Mutation { id: id.into(), expected_version: 0,
            request_key: format!("{id}-written"), deleted: false, value: value.clone() }).unwrap();
        store.get("account", resource, id).unwrap().record.unwrap().value
    }

    /// A refused initialization does not poison the entry or publish a writer over a source that did not open.
    #[cfg(not(hosted_records))]
    #[test]
    fn a_failed_cold_writer_open_can_be_retried_on_the_same_entry() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let resources = StateResources::new(&state, WorkMeter::new()).unwrap();
        let path = resources.path("@list/retry").unwrap();
        // A directory at the file's path cannot be opened as a database. Move it aside intact after the refusal,
        // making the same declared placement available without replacing the resource owner.
        std::fs::create_dir(&path).unwrap();
        assert!(resources.writer("@list/retry").is_err(), "a failed schema open is refused");
        std::fs::rename(&path, state.join("held-directory")).unwrap();
        let writer = resources.writer("@list/retry").expect("the repaired source can be opened on a later call");
        assert!(Arc::ptr_eq(&writer, &resources.writer("@list/retry").unwrap()));
        let value = serde_json::json!({"words":"durable after a refused cold open"});
        assert_eq!(written_back(&state, "@list/retry", "row-retry", &value), value);
    }

    /// A stalled cold opener belongs to its file. It cannot make another list wait for the shared handle map.
    #[cfg(not(hosted_records))]
    #[test]
    fn opening_one_lists_writer_does_not_hold_up_another_lists_writer() {
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let blocked_path = placement("@list/alpha").unwrap().in_state_for("@list/alpha", &state).unwrap();
        let held = rusqlite::Connection::open(&blocked_path).unwrap();
        // A real partially initialized WAL book: opening it needs to install the declared families, and the held
        // write reservation prevents that until this test releases it. No injected opener or mutex stands in for I/O.
        held.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE seed(value); BEGIN IMMEDIATE").unwrap();
        let meter = WorkMeter::new();
        let resources = Arc::new(StateResources::new(&state, meter.clone()).unwrap());
        let alpha_resources = resources.clone();
        let alpha = std::thread::spawn(move || alpha_resources.writer("@list/alpha"));
        let until = std::time::Instant::now() + Duration::from_secs(2);
        while !meter.snapshot().is_ok_and(|observed| observed.active_statements > 0) {
            assert!(std::time::Instant::now() < until, "the first opener never reached its database work");
            assert!(!alpha.is_finished(), "the first opener must remain blocked on its own book");
            std::thread::yield_now();
        }
        let beta_resources = resources.clone();
        let (sent, received) = std::sync::mpsc::channel();
        let started = std::time::Instant::now();
        let beta_state = state.clone();
        let beta = std::thread::spawn(move || {
            let writer = beta_resources.writer("@list/beta");
            if writer.is_ok() {
                let value = serde_json::json!({"words":"durable while alpha is blocked"});
                assert_eq!(written_back(&beta_state, "@list/beta", "row-beta", &value), value);
            }
            sent.send(writer).unwrap();
        });
        let independent = received.recv_timeout(Duration::from_secs(1));
        let elapsed = started.elapsed();
        held.execute_batch("ROLLBACK").unwrap();
        let alpha_writer = alpha.join().unwrap().unwrap();
        beta.join().unwrap();
        let beta_writer = independent.expect("another list waited for the first list's cold opener").unwrap();
        assert_ne!(alpha_writer.path(), beta_writer.path());
        assert!(Arc::ptr_eq(&beta_writer, &resources.writer("@list/beta").unwrap()), "the handle owner is still shared per file");
        crate::quiet_println!("independent list writer initialization: beta_completed_before_alpha_release=true elapsed_ms={:.3}", elapsed.as_secs_f64()*1000.0);
    }

    #[test]
    fn every_old_source_is_copied_at_startup() {
        let rows = all();
        assert!(!rows.is_empty(), "record_store_resources.json is malformed");
        let phases = crate::native_boot::own_records_start::phases();
        assert_eq!(
            uncopied(rows, &phases),
            Vec::<(&str, Vec<&str>)>::new(),
            "a resource's old tables have no startup phase"
        );
        // Every copying phase the startup runs fills a declared resource, so a phase is never added for a resource
        // this DATA does not know.
        for phase in phases
            .iter()
            .filter(|phase| !crate::native_boot::own_records_start::DERIVED_PHASES.contains(phase))
        {
            assert!(
                rows.iter()
                    .any(|row| row.startup.iter().any(|named| named == phase)),
                "{phase} fills no declared resource"
            );
        }
    }

    #[test]
    fn every_copied_resource_names_a_declared_family_and_the_copy_phase() {
        let copy_phase = crate::native_boot::own_records_start::COPY_PHASE;
        for row in all() {
            let names_phase = row.startup.iter().any(|phase| phase == copy_phase);
            assert_eq!(
                names_phase,
                !row.copy.is_empty(),
                "{}: {copy_phase} is named exactly when a table is copied",
                row.resource
            );
            for copy in &row.copy {
                let family = crate::storage::schema(&copy.schema)
                    .and_then(|schema| schema.family(&copy.family))
                    .unwrap_or_else(|_| {
                        panic!(
                            "{} copies {}/{}, which families.json does not declare",
                            row.resource, copy.schema, copy.family
                        )
                    });
                let walked = match &copy.order {
                    Some(order) => {
                        &family
                            .order(order)
                            .unwrap_or_else(|_| {
                                panic!("{} walks an undeclared order {order}", copy.family)
                            })
                            .fields
                    }
                    None => &family.key,
                };
                if copy.own_record.is_none() {
                    assert!(
                        copy.order.is_none() && family.key.len() == 1,
                        "{} copies {}: a record id needs one key field",
                        row.resource,
                        copy.family
                    );
                }
                if let Some(per) = &copy.newest_per {
                    assert_eq!(
                        walked.first(),
                        Some(per),
                        "{}: newest_per must be the walked order's first field",
                        copy.family
                    );
                }
                if let Some(own) = &copy.own_record {
                    assert!(
                        !own.id.is_empty(),
                        "{}: a copied record is named by at least one field",
                        copy.family
                    );
                    assert!(
                        own.stored.is_none() || own.json.is_empty(),
                        "{}: `json` fields belong to a stored value made of the row",
                        copy.family
                    );
                }
                let own = copy.own_record.iter().flat_map(|own| {
                    own.id
                        .iter()
                        .chain(&own.time)
                        .chain(&own.stored)
                        .chain(&own.json)
                });
                for field in copy.skip.iter().map(|skip| &skip.field).chain(own) {
                    assert!(
                        family.fields.contains(field),
                        "{} names {field}, which {} does not hold",
                        row.resource,
                        copy.family
                    );
                }
            }
        }
        let names: Vec<&str> = copies().map(|(row, copy)| copy.name(row)).collect();
        assert!(!names.is_empty(), "the copy phase fills no resource");
        assert_eq!(
            names
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            names.len(),
            "two copies share a name"
        );
    }

    #[test]
    fn every_resource_the_engine_names_is_declared() {
        // The account's own records, its workspace and its screen revision share the one file the account's own
        // store opens (the commands write them in one transaction).
        let book = placement(crate::local_account::own_records::RESOURCE)
            .expect("own-records is not declared");
        for name in [
            crate::local_account::own_records::KEYS,
            crate::local_account::own_records::COMMANDS,
            crate::local_account::own_records::POSITION_RESOURCE,
            crate::workspace_store::resource().unwrap(),
        ] {
            assert_eq!(
                placement(name),
                Some(book),
                "{name} is not declared in the account's own file"
            );
        }
        assert!(placement(crate::secrets::resource().unwrap())
            .is_some_and(|held| held.in_state(Path::new("s")).is_some()));
        // Each reader file exists and names its resource, or resolves it here by its own file name.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let tests_only = parse(TEST_DATA).unwrap();
        for row in all()
            .iter()
            .filter(|row| tests_only.iter().all(|test| test.resource != row.resource))
        {
            for reader in &row.readers {
                let text = std::fs::read_to_string(root.join(reader))
                    .unwrap_or_else(|_| panic!("{reader} is missing"));
                // A prefix row's owner names the start of the names it builds.
                let named = if row.prefix {
                    format!("\"{}", row.resource)
                } else {
                    format!("\"{}\"", row.resource)
                };
                assert!(
                    text.contains(&named) || text.contains("record_store_resources::resource_of"),
                    "{reader} neither names {} nor resolves it here",
                    row.resource
                );
            }
            if let Some(mover) = &row.moved_by {
                assert!(
                    root.join(mover).is_file(),
                    "{} names a mover {mover} that does not exist",
                    row.resource
                );
            }
        }
    }

    #[test]
    fn the_store_refuses_a_resource_no_row_declares() {
        use crate::records::{Error, Mutation, Records};
        assert!(
            declares("own-records")
                && declares("@namespace/names/a/b")
                && !declares("own-records-invented")
        );
        let limits = crate::storage::record_store::settings::Limits::fixed(1 << 20, 10 << 30);
        let mut store = crate::storage::record_store::RecordStore::new(
            crate::storage::memory::Memory::open("record_store").unwrap(),
            Box::new(crate::storage::record_store::RealClock),
            limits,
        )
        .unwrap();
        let write = |id: &str| Mutation {
            id: id.into(),
            expected_version: 0,
            request_key: id.into(),
            deleted: false,
            value: serde_json::json!({}),
        };
        assert!(store.mutate("account", "own-records", write("one")).is_ok());
        assert!(matches!(
            store.mutate("account", "own-records-invented", write("two")),
            Err(Error::Invalid(_, _))
        ));
        assert!(matches!(
            store.get("account", "own-records-invented", "two"),
            Err(Error::Invalid(_, _))
        ));
    }

    #[test]
    fn a_resource_with_old_tables_and_no_running_phase_is_uncopied() {
        let rows = parse(
            br#"{"_what": "t", "resources": [
                {"resource": "kept", "placement": {"file": {"object": "RECORD_BOOK"}, "supply": "sqlite"}, "_what": "t",
                 "readers": ["a.rs"], "old": {"tables": ["kept_table"]}, "startup": ["kept-copy"]},
                {"resource": "forgotten", "placement": {"file": {"object": "RECORD_BOOK"}, "supply": "sqlite"}, "_what": "t",
                 "readers": ["b.rs"], "old": {"tables": ["forgotten_table"]}, "startup": ["forgotten-copy"]},
                {"resource": "moved", "placement": {"file": {"state": "moved.sqlite"}, "supply": "sqlite"}, "_what": "t",
                 "readers": ["c.rs"], "old": {"tables": ["moved_table"]}, "moved_by": "c.rs"},
                {"resource": "fresh", "placement": {"file": {"state": "fresh.sqlite"}, "supply": "sqlite"}, "_what": "t",
                 "readers": ["d.rs"], "old": {"none": "new data only"}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            uncopied(&rows, &["kept-copy"]),
            vec![("forgotten", vec!["forgotten-copy"])]
        );
        // Old tables with neither a phase nor a mover, or with both, new data that names a phase, a supply this
        // program does not link, or a state file that is not one plain name: each refuses the whole file.
        let one = |row: &str| {
            parse(format!(r#"{{"_what": "t", "resources": [{{"resource": "r", "_what": "t", "readers": ["a.rs"], {row}}}]}}"#).as_bytes())
        };
        let book = r#""placement": {"file": {"object": "RECORD_BOOK"}, "supply": "sqlite"}"#;
        assert!(one(&format!(r#"{book}, "old": {{"none": "new"}}"#)).is_some());
        assert!(one(&format!(r#"{book}, "old": {{"tables": ["t"]}}"#)).is_none());
        assert!(one(&format!(
            r#"{book}, "old": {{"tables": ["t"]}}, "startup": ["p"], "moved_by": "m.rs""#
        ))
        .is_none());
        assert!(one(&format!(
            r#"{book}, "old": {{"none": "new"}}, "startup": ["p"]"#
        ))
        .is_none());
        assert!(one(r#""placement": {"file": {"object": "RECORD_BOOK"}, "supply": "postgres"}, "old": {"none": "new"}"#).is_none());
        assert!(one(r#""placement": {"file": {"state": "../up.sqlite"}, "supply": "sqlite"}, "old": {"none": "new"}"#).is_none());
        assert!(one(
            r#""placement": {"file": {"state": ".."}, "supply": "sqlite"}, "old": {"none": "new"}"#
        )
        .is_none());
    }

    #[test]
    fn a_placement_file_opens_once_and_every_resource_in_it_shares_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().canonicalize().unwrap();
        let grants = placement("computer-grants")
            .unwrap()
            .in_state(&state)
            .unwrap();
        assert_eq!(grants, state.join("computer-grants.sqlite"));
        assert_eq!(
            placement("@namespace/names/a/b"),
            placement("@namespace/files")
        );
        assert!(placement("own-records").unwrap().in_state(&state).is_none());
        let mut store = open(&grants, WorkMeter::new()).unwrap();
        let write = crate::records::Mutation {
            id: "one".into(),
            expected_version: 0,
            request_key: "one".into(),
            deleted: false,
            value: serde_json::json!({"a": 1}),
        };
        use crate::records::Records;
        store.mutate("account", "computer-grants", write).unwrap();
        drop(store);
        let again = open(&grants, WorkMeter::new()).unwrap();
        assert_eq!(
            again
                .get("account", "computer-grants", "one")
                .unwrap()
                .record
                .unwrap()
                .value,
            serde_json::json!({"a": 1})
        );
    }

    #[test]
    fn a_resource_prefix_opens_an_independent_file_and_reopens_its_committed_data() {
        use crate::records::{Mutation, Records};
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().canonicalize().unwrap();
        let first_name = "@test-db/alpha";
        let second_name = "@test-db/beta";
        let routes = StateResources::new(&state, WorkMeter::new()).unwrap();
        let first_writer = routes.writer(first_name).unwrap();
        let second_writer = routes.writer(second_name).unwrap();
        assert_ne!(first_writer.path(), second_writer.path());
        assert!(std::sync::Arc::ptr_eq(
            &first_writer,
            &routes.writer(first_name).unwrap()
        ));
        assert!(
            std::sync::Arc::ptr_eq(
                &routes.readers(first_name).unwrap(),
                &routes.readers(first_name).unwrap()
            ),
            "readers resolve by the same declared placement"
        );
        assert!(
            !std::sync::Arc::ptr_eq(
                &routes.readers(first_name).unwrap(),
                &routes.readers(second_name).unwrap()
            ),
            "different resource placements have separate reader owners"
        );
        let first_path = placement(first_name)
            .unwrap()
            .in_state_for(first_name, &state)
            .unwrap();
        let second_path = placement(second_name)
            .unwrap()
            .in_state_for(second_name, &state)
            .unwrap();
        assert_ne!(
            first_path, second_path,
            "independent resources get independent files"
        );
        let ordinary_path = placement("test-ordinary-records")
            .unwrap()
            .in_state_for("test-ordinary-records", &state)
            .unwrap();
        assert_ne!(
            first_path, ordinary_path,
            "an ordinary exact resource can have its own file too"
        );
        let nested_path = placement("@test-db/private/item")
            .unwrap()
            .in_state_for("@test-db/private/item", &state)
            .unwrap();
        assert_eq!(nested_path.file_name().unwrap(), "private-item.sqlite");

        let (_ordinary_path, mut ordinary) =
            open_state_resource("test-ordinary-records", &state, WorkMeter::new()).unwrap();
        ordinary
            .mutate(
                "account",
                "test-ordinary-records",
                Mutation {
                    id: "same-id".into(),
                    expected_version: 0,
                    request_key: "ordinary-write".into(),
                    deleted: false,
                    value: serde_json::json!({"owner": "ordinary"}),
                },
            )
            .unwrap();
        drop(ordinary);

        let (first_path, mut first) =
            open_state_resource(first_name, &state, WorkMeter::new()).unwrap();
        assert_eq!(
            first_path,
            placement(first_name)
                .unwrap()
                .in_state_for(first_name, &state)
                .unwrap()
        );
        let mutation = Mutation {
            id: "same-id".into(),
            expected_version: 0,
            request_key: "first-write".into(),
            deleted: false,
            value: serde_json::json!({"owner": "first"}),
        };
        let committed = first
            .mutate("account", first_name, mutation.clone())
            .unwrap();
        assert_eq!(
            first
                .mutate("account", first_name, mutation.clone())
                .unwrap(),
            committed,
            "an in-process retry returns the original result",
        );
        let stale = Mutation {
            request_key: "stale-cas".into(),
            ..mutation.clone()
        };
        assert!(matches!(
            first.mutate("account", first_name, stale),
            Err(Error::Conflict(_))
        ));
        drop(first);

        let (_second_path, second) =
            open_state_resource(second_name, &state, WorkMeter::new()).unwrap();
        assert!(second
            .get("account", second_name, "same-id")
            .unwrap()
            .record
            .is_none());
        drop(second);
        let ordinary = open_state_resource("test-ordinary-records", &state, WorkMeter::new())
            .unwrap()
            .1;
        assert_eq!(
            ordinary
                .get("account", "test-ordinary-records", "same-id")
                .unwrap()
                .record
                .unwrap()
                .value,
            serde_json::json!({"owner": "ordinary"}),
        );
        drop(ordinary);
        let (reopened_path, mut reopened) =
            open_state_resource(first_name, &state, WorkMeter::new()).unwrap();
        assert_eq!(reopened_path, first_path);
        assert_eq!(
            reopened
                .get("account", first_name, "same-id")
                .unwrap()
                .record
                .unwrap()
                .value,
            serde_json::json!({"owner": "first"}),
            "a fresh consumer recovers the committed value from the resource's placed file",
        );
        assert_eq!(
            reopened.mutate("account", first_name, mutation).unwrap(),
            committed,
            "retrying a committed request after reopening returns its original result"
        );
        assert!(matches!(
            open_state_resource("@test-db/", &state, WorkMeter::new()),
            Err(Error::Invalid(_, _)),
        ));
        assert!(matches!(
            open_state_resource("@test-db-missing/alpha", &state, WorkMeter::new()),
            Err(Error::Invalid(_, _)),
        ));
    }

    #[test]
    fn independent_resource_writers_keep_their_atomic_group_and_recover_after_restart() {
        use crate::{
            local_account::own_records::InCommand,
            storage::{record_store::settings::Limits, sqlite::Access},
            workspace_store::Workspace,
        };
        use std::collections::BTreeMap;

        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().canonicalize().unwrap();
        let routes = StateResources::new(&state, WorkMeter::new()).unwrap();
        let alpha = routes.writer("@test-db/alpha").unwrap();
        let beta = routes.writer("@test-db/beta").unwrap();
        let alpha_key = [11_u8; 32];
        let beta_key = [22_u8; 32];
        // `catch_up_original` is the original tools' facts table on its existing account handle: this program
        // declares it and never creates it (src/storage/families.json, "no overlay or new storage"). The opener
        // makes only the record store families, so the group's file is given the existing table here, in the
        // original layout (as tests/workshop_page.rs and tests/local_account/records_write.rs give theirs).
        rusqlite::Connection::open(alpha.path())
            .unwrap()
            .execute_batch("CREATE TABLE workshop_facts(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,entity TEXT NOT NULL,value TEXT NOT NULL);CREATE INDEX workshop_facts_entity ON workshop_facts(entity,seq)")
            .unwrap();

        fn write_group(
            writer: &std::sync::Arc<Writer>,
            id: &str,
            text: &str,
            key: &[u8; 32],
            with_workspace: bool,
            commit: bool,
        ) {
            let source = writer
                .lend(
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    std::time::Instant::now() + Duration::from_secs(2),
                )
                .unwrap();
            let tx = source
                .begin(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            let limits = InCommand::limits(&tx, writer.path()).unwrap_or(Limits {
                max_record_bytes: 4 * 1024 * 1024,
                byte_budget: 64 * 1024 * 1024,
            });
            let mut records = InCommand::lend(&tx, "account", limits).unwrap();
            let form = crate::legacy_records::StoredRecord {
                id: id.into(),
                record_type: "note".into(),
                sequence: "2026-10-31T00:00:00.000Z".into(),
                value_json: format!("{{\"text\":{}}}", serde_json::to_string(text).unwrap()),
                meta_json: None,
                protected_key_present: true,
            };
            let forms = BTreeMap::from([(id.to_owned(), Some(form))]);
            records
                .write(&forms, &[(id, key)], "request", || Ok(()))
                .unwrap();
            records
                .put_command(
                    "permit",
                    0,
                    serde_json::json!({"state": "committed"}),
                    || Ok(()),
                )
                .unwrap();
            drop(records);
            if with_workspace {
                let mut workspace = Workspace::lend(&tx, "account", Access::Write).unwrap();
                workspace
                    .change(
                        "screen",
                        0,
                        Some(
                            &crate::ecma_json::parse(text.as_bytes(), Default::default()).unwrap(),
                        ),
                        "workspace-request",
                    )
                    .unwrap();
                let facts = sqlite::lend(&tx, "catch_up_original", Access::Write).unwrap();
                facts
                    .put(
                        "workshop_facts",
                        &[
                            ("seq", crate::storage::Value::Null),
                            ("at", "2026-10-31T00:00:00.000Z".into()),
                            ("entity", "catch-up-devices".into()),
                            (
                                "value",
                                serde_json::to_string(&serde_json::json!({"value": text}))
                                    .unwrap()
                                    .into(),
                            ),
                        ],
                        crate::storage::When::New,
                    )
                    .unwrap();
                drop(facts);
                drop(workspace);
            }
            if commit {
                tx.commit().unwrap();
            } else {
                tx.rollback().unwrap();
            }
        }

        // An interrupted attempt leaves no record, key, completion receipt,
        // workspace value, or catch-up fact. Retrying the original request then
        // commits all joined state on the same group's file.
        write_group(&beta, "same-id", "beta", &beta_key, false, false);
        write_group(&beta, "same-id", "beta", &beta_key, false, true);
        write_group(
            &alpha,
            "same-id",
            "{\"screen\":true}",
            &alpha_key,
            true,
            true,
        );

        drop(alpha);
        drop(beta);
        drop(routes);
        let reopened_routes = StateResources::new(&state, WorkMeter::new()).unwrap();
        let reopened_alpha = reopened_routes.writer("@test-db/alpha").unwrap();
        let reopened_beta = reopened_routes.writer("@test-db/beta").unwrap();

        for (writer, expected, key, has_joined) in [
            (&reopened_alpha, "{\"screen\":true}", &alpha_key, true),
            (&reopened_beta, "beta", &beta_key, false),
        ] {
            let reopened = writer
                .lend(
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    std::time::Instant::now() + Duration::from_secs(2),
                )
                .unwrap();
            let tx = reopened
                .begin(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            let records = InCommand::lend(
                &tx,
                "account",
                Limits {
                    max_record_bytes: 4 * 1024 * 1024,
                    byte_budget: 64 * 1024 * 1024,
                },
            )
            .unwrap();
            // The record's value is the JSON text `{"text": <the text written>}`: read the text back, not its escaped form.
            let held: serde_json::Value =
                serde_json::from_str(&records.stored("same-id").unwrap().unwrap().value_json)
                    .unwrap();
            assert_eq!(held["text"], expected, "{held}");
            assert!(matches!(
                records.key("same-id").unwrap(),
                crate::record_value::KeyState::Present(_)
            ));
            assert_eq!(
                records.command("permit").unwrap().1,
                Some(serde_json::json!({"state": "committed"}))
            );
            if has_joined {
                let workspace = Workspace::lend(&tx, "account", Access::Read).unwrap();
                assert!(workspace.get("screen").unwrap().1.is_some());
                drop(workspace);
                let facts = sqlite::lend(&tx, "catch_up_original", Access::Read).unwrap();
                assert_eq!(
                    facts
                        .count("workshop_facts", &crate::storage::Range::all())
                        .unwrap(),
                    1
                );
                drop(facts);
            } else {
                let workspace = Workspace::lend(&tx, "account", Access::Read).unwrap();
                assert!(workspace.get("screen").unwrap().1.is_none());
                drop(workspace);
            }
            assert!(key.iter().any(|byte| *byte != 0));
            drop(records);
            tx.rollback().unwrap();
        }
    }

    #[test]
    fn a_resource_derived_path_encodes_path_separators_and_refuses_bad_declarations() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path();
        let path = placement("@test-db/../outside")
            .unwrap()
            .in_state_for("@test-db/../outside", state)
            .unwrap();
        assert_eq!(path.parent(), Some(state));
        assert!(path.file_name().unwrap().to_string_lossy().contains("%2F"));
        assert!(placement("@test-db/")
            .unwrap()
            .in_state_for("@test-db/", state)
            .is_none());

        let parse_one = |placement: &str, prefix: bool| {
            parse(format!(
                r#"{{"_what":"test","resources":[{{"resource":"@db/","placement":{placement},"prefix":{prefix},"_what":"test","readers":["a.rs"],"old":{{"none":"test"}}}}]}}"#
            ).as_bytes())
        };
        assert!(parse_one(
            r#"{"file":{"state-resource":{"prefix":"../","suffix":".sqlite"}},"supply":"sqlite"}"#,
            true
        )
        .is_none());
        assert!(parse_one(r#"{"file":{"state-resource":{"prefix":"db-","suffix":".sqlite"}},"supply":"sqlite"}"#, false).is_some(),
            "an exact resource row may also name its own derived file");
    }

    #[test]
    fn a_reader_reads_the_last_commit_and_never_waits_on_the_files_writer() {
        use crate::records::{Mutation, Records};
        let dir = tempfile::tempdir().unwrap();
        let path = placement("notes")
            .unwrap()
            .in_state(&dir.path().canonicalize().unwrap())
            .unwrap();
        let mut writer = open(&path, WorkMeter::new()).unwrap();
        let note = |n: i64| Mutation {
            id: "one".into(),
            expected_version: n - 1,
            request_key: format!("note-{n}"),
            deleted: false,
            value: serde_json::json!({"n": n}),
        };
        writer.mutate("account", "notes", note(1)).unwrap();
        let readers = Readers::new(path.clone(), WorkMeter::new());
        let seen = |readers: &Readers| {
            readers.read(|store| {
                Ok::<_, Error>(
                    store
                        .held_record_with_version("account", "notes", "one")?
                        .1
                        .map(|record| record.value),
                )
            })
        };
        assert_eq!(seen(&readers).unwrap(), Some(serde_json::json!({"n": 1})));
        // The writer holds the file's write transaction with a change not committed yet: a read neither waits for it
        // nor sees it.
        writer.storage().open_scope(crate::storage::Intent::Write).unwrap();
        writer.mutate("account", "notes", note(2)).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(seen(&readers).unwrap(), Some(serde_json::json!({"n": 1})));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "the read waited on the writer"
        );
        writer.storage().close_scope(true).unwrap();
        // The handle the last read gave back reads the new commit.
        assert_eq!(seen(&readers).unwrap(), Some(serde_json::json!({"n": 2})));
        // A reader never writes: a write through its store is refused.
        let refused = readers.read(|mut store| {
            store
                .mutate_local_with_check("account", "notes", note(3), || Ok(()))
                .map(drop)
        });
        assert!(refused.is_err());
        assert_eq!(seen(&readers).unwrap(), Some(serde_json::json!({"n": 2})));
    }

    #[test]
    fn readers_of_one_file_read_at_once() {
        use crate::records::{Mutation, Records};
        let dir = tempfile::tempdir().unwrap();
        let path = placement("notes")
            .unwrap()
            .in_state(&dir.path().canonicalize().unwrap())
            .unwrap();
        let mut writer = open(&path, WorkMeter::new()).unwrap();
        for n in 0..64 {
            let write = Mutation {
                id: format!("id-{n:02}"),
                expected_version: 0,
                request_key: format!("w-{n}"),
                deleted: false,
                value: serde_json::json!({"n": n}),
            };
            writer.mutate("account", "notes", write).unwrap();
        }
        let readers = std::sync::Arc::new(Readers::new(path, WorkMeter::new()));
        // Eight reads hold their read transactions together (each waits at the barrier inside its transaction), so
        // none of them waits for another.
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let reads: Vec<_> = (0..8)
            .map(|n| {
                let (readers, barrier) = (readers.clone(), barrier.clone());
                std::thread::spawn(move || {
                    readers.read(|store| {
                        barrier.wait();
                        Ok::<_, Error>(
                            store
                                .held_record_with_version(
                                    "account",
                                    "notes",
                                    &format!("id-{n:02}"),
                                )?
                                .1
                                .map(|record| record.value),
                        )
                    })
                })
            })
            .collect();
        for (n, read) in reads.into_iter().enumerate() {
            assert_eq!(
                read.join().unwrap().unwrap(),
                Some(serde_json::json!({"n": n}))
            );
        }
        assert!(readers.idle.lock().unwrap().len() <= IDLE_READERS);
    }

    #[test]
    fn retired_tables_are_no_copy_source_and_no_store_family() {
        let retire =
            retire().expect("record_store_resources.json declares the old tables to retire");
        assert_eq!(retire.after, crate::local_account::own_records::RESOURCE);
        let store = crate::storage::schema(SCHEMA).unwrap();
        for table in &retire.tables {
            assert!(
                store.family(table).is_err(),
                "{table} is a family of the store, never an old table"
            );
            assert!(
                copies().all(|(_, copy)| &copy.family != table),
                "{table} is still read by a copy"
            );
        }
    }

    /// A RecordBook-like file: the record store families with one record, the old store's tables (a typed table listed in
    /// its catalogue, a key run listed in its catalogue, the journal with a trigger) holding `marker`, and a kept
    /// table with a view.
    fn old_book(marker: &str) -> (tempfile::TempDir, PathBuf) {
        use crate::records::{Mutation, Records};
        let dir = tempfile::tempdir().unwrap();
        let path = placement("notes")
            .unwrap()
            .in_state(&dir.path().canonicalize().unwrap())
            .unwrap();
        let mut store = open(&path, WorkMeter::new()).unwrap();
        let note = Mutation {
            id: "one".into(),
            expected_version: 0,
            request_key: "one".into(),
            deleted: false,
            value: serde_json::json!({"n": 1}),
        };
        store.mutate("account", "notes", note).unwrap();
        drop(store);
        let db = rusqlite::Connection::open(&path).unwrap();
        let filler = marker.repeat(64);
        db.execute_batch(
            "CREATE TABLE _record_tables_kinds(kind TEXT, table_name TEXT);
             INSERT INTO _record_tables_kinds VALUES('note', 'rt_ab12');
             CREATE TABLE rt_ab12(_id TEXT PRIMARY KEY, f_text TEXT);
             CREATE TABLE record_keys_runs(run INTEGER);
             INSERT INTO record_keys_runs VALUES(7);
             CREATE TABLE record_keys_run_7(k BLOB);
             CREATE TABLE record_log(id TEXT, envelopes TEXT);
             CREATE TABLE record_log_seen(id TEXT);
             CREATE TRIGGER record_log_after AFTER INSERT ON record_log BEGIN INSERT INTO record_log_seen VALUES(new.id); END;
             CREATE TABLE kept(x TEXT);
             CREATE VIEW kept_view AS SELECT x FROM kept;",
        )
        .unwrap();
        db.execute("INSERT INTO rt_ab12 VALUES('one', ?1)", [&filler])
            .unwrap();
        db.execute(
            "INSERT INTO record_keys_run_7 VALUES(CAST(?1 AS BLOB))",
            [&filler],
        )
        .unwrap();
        db.execute("INSERT INTO record_log VALUES('one', ?1)", [&filler])
            .unwrap();
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        (dir, path)
    }

    fn holds(path: &Path, marker: &str) -> bool {
        let bytes = std::fs::read(path).unwrap();
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        let wal = std::fs::read(PathBuf::from(wal)).unwrap_or_default();
        [bytes, wal].iter().any(|file| {
            file.windows(marker.len())
                .any(|window| window == marker.as_bytes())
        })
    }

    fn tables(path: &Path) -> Vec<String> {
        let db = rusqlite::Connection::open(path).unwrap();
        let mut statement = db
            .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn retiring_drops_every_old_table_and_their_bytes_leave_the_file() {
        use crate::records::Records;
        let marker = "an-erased-value-7Qx";
        let (_dir, path) = old_book(marker);
        assert!(holds(&path, marker));
        let retired = retire_old(&path, WorkMeter::new(), |_| Ok(true)).unwrap();
        // The named catalogue, the typed table it lists, the run catalogue, the run it lists, and the journal; the
        // journal's trigger goes with it. Named tables the file never had are not counted.
        assert_eq!(retired.tables, 5);
        let left = tables(&path);
        for old in [
            "_record_tables_kinds",
            "rt_ab12",
            "record_keys_runs",
            "record_keys_run_7",
            "record_log",
        ] {
            assert!(
                !left.iter().any(|name| name == old),
                "{old} is still in the file"
            );
        }
        assert!(
            left.iter().any(|name| name == "kept")
                && left.iter().any(|name| name == "record_log_seen")
        );
        assert!(
            !holds(&path, marker),
            "an old table's value is still in the file's bytes"
        );
        assert!(retired.bytes_after < retired.bytes_before);
        // The store's own records stay.
        let store = open(&path, WorkMeter::new()).unwrap();
        assert_eq!(
            store
                .get("account", "notes", "one")
                .unwrap()
                .record
                .unwrap()
                .value,
            serde_json::json!({"n": 1})
        );
        // Run again on a file without them: nothing is dropped.
        drop(store);
        assert_eq!(
            retire_old(&path, WorkMeter::new(), |_| Ok(true))
                .unwrap()
                .tables,
            0
        );
    }

    /// The account's own old object files are carried, then emptied: each ledger row record store never held becomes an own
    /// record (a table keyed by several fields named by all of them, a day its time), a row whose id record store holds stays
    /// as record store has it, every table but the kept ones goes, and another account's file is not opened.
    #[test]
    fn the_accounts_own_old_objects_are_emptied_whole_and_another_accounts_stay() {
        let marker = "an-old-person-value-8Jw";
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().canonicalize().unwrap();
        let make = |name: &str| {
            let path = state.join(name);
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE old_facts(seq INTEGER PRIMARY KEY, value TEXT);
                 CREATE VIRTUAL TABLE search_words USING fts5(text);
                 CREATE VIEW recent AS SELECT value FROM old_facts;
                 CREATE TRIGGER facts_seen AFTER INSERT ON old_facts BEGIN SELECT 1; END;",
            )
            .unwrap();
            db.execute(
                "INSERT INTO old_facts(value) VALUES(?1)",
                [marker.repeat(64)],
            )
            .unwrap();
            db.execute_batch(
                "CREATE TABLE shares_sent(id TEXT); INSERT INTO shares_sent VALUES('kept');",
            )
            .unwrap();
            db.execute("INSERT INTO search_words(text) VALUES(?1)", [marker])
                .unwrap();
            db.execute_batch(
                "CREATE TABLE model_spend(day TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL,
                   refused INTEGER NOT NULL, remembered INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
                   paid_by TEXT NOT NULL, PRIMARY KEY(day, purpose, model));
                 INSERT INTO model_spend VALUES('2026-10-02', 'a:b', 'sample-model', 3, 0, 1, 120, 40, 'sample-payer');
                 CREATE TABLE metered_use_days(day TEXT NOT NULL PRIMARY KEY, purposes TEXT NOT NULL, windows TEXT, judgement TEXT) WITHOUT ROWID;
                 INSERT INTO metered_use_days VALUES('2026-10-03', '[\"older\"]', '[]', NULL);
                 INSERT INTO metered_use_days VALUES('2026-10-04', '[\"only-here\"]', '[]', NULL);",
            )
            .unwrap();
            path
        };
        let (own, other) = (make("own.sqlite"), make("other.sqlite"));
        std::fs::write(
            state.join("objects.ndjson"),
            "{\"binding\":\"PERSON\",\"names\":[\"user-aaaaaaaa-1\"],\"sqlite\":\"own.sqlite\"}\n\
             {\"binding\":\"PERSON\",\"names\":[\"user-bbbbbbbb-2\"],\"sqlite\":\"other.sqlite\"}\n\
             {\"binding\":\"ACCOUNT_CONTROL\",\"names\":[\"user-aaaaaaaa-1\"],\"sqlite\":\"missing.sqlite\"}\n",
        )
        .unwrap();
        let records = crate::local_account::own_records::RESOURCE;
        // The account's RecordBook (an object's file, which a real state finds in its restore index).
        let book = state.join("book.sqlite");
        let held = crate::records::Mutation {
            id: "metered-use-day:2026-10-03".into(),
            expected_version: 0,
            request_key: "newer".into(),
            deleted: false,
            value: serde_json::json!({"kind": "record:metered-use-day", "sequence": "019a000000000000000", "stored": "{\"day\":\"2026-10-03\"}", "meta": null, "protected": false}),
        };
        crate::records::Records::mutate(
            &mut open(&book, WorkMeter::new()).unwrap(),
            "account",
            records,
            held.clone(),
        )
        .unwrap();
        let retire = |ids: &[&str], allowed: bool| {
            retire_old_objects(&state, &book, "account", ids, WorkMeter::new(), |_| {
                Ok(allowed)
            })
        };
        assert!(
            retire(&["aa"], true).is_err(),
            "a short id could match another account"
        );
        assert!(
            retire(&["user-aaaaaaaa-1"], false).is_err(),
            "the owner's guard refused"
        );
        assert!(holds(&own, marker), "a refused retire emptied a file");
        let emptied = retire(&["user-aaaaaaaa-1"], true).unwrap();
        assert_eq!(emptied.len(), 1);
        assert_eq!(emptied[0].binding, "PERSON");
        assert_eq!(
            emptied[0].carried, 2,
            "the spend row and the day only the old file held"
        );
        let store = open(&book, WorkMeter::new()).unwrap();
        let get = |id: &str| {
            store
                .get_many("account", records, &[id])
                .unwrap()
                .remove(0)
                .map(|record| record.value)
        };
        let spend = get("model-spend:2026-10-02:a%3Ab:sample-model")
            .expect("the spend row is an own record, named by its whole key");
        assert_eq!(spend["kind"], "record:model-spend");
        assert_eq!(
            spend["sequence"], "01a0f9e920000000000",
            "a day orders from its start in UTC"
        );
        let stored: serde_json::Value =
            serde_json::from_str(spend["stored"].as_str().unwrap()).unwrap();
        assert_eq!(stored["input_tokens"], 120);
        assert_eq!(
            get("metered-use-day:2026-10-03"),
            Some(held.value),
            "an id record store holds stays as record store has it"
        );
        let only: serde_json::Value = serde_json::from_str(
            get("metered-use-day:2026-10-04").unwrap()["stored"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            only["purposes"],
            serde_json::json!(["only-here"]),
            "a JSON field is carried as JSON"
        );
        assert!(
            emptied[0].tables >= 3,
            "the virtual table, the view and the table"
        );
        let objects = |path: &Path| -> i64 {
            rusqlite::Connection::open(path)
                .unwrap()
                .query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))
                .unwrap()
        };
        // Only the kept table is left (the shares sent, data about other people, stay until they are ruled on).
        assert_eq!(objects(&own), 1);
        let kept: i64 = rusqlite::Connection::open(&own)
            .unwrap()
            .query_row("SELECT count(*) FROM shares_sent", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 1);
        assert!(
            !holds(&own, marker),
            "an emptied file still holds an old value"
        );
        assert!(objects(&other) > 0, "another account's object was touched");
        assert!(holds(&other, marker));
    }

    #[test]
    fn a_retired_view_goes_with_the_old_tables_it_reads() {
        let marker = "an-old-activity-value-4Kp";
        let (_dir, path) = old_book(marker);
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE activity_g21(id TEXT, what TEXT); CREATE VIEW activity AS SELECT id, what FROM activity_g21;").unwrap();
        db.execute(
            "INSERT INTO activity_g21 VALUES('one', ?1)",
            [marker.repeat(64)],
        )
        .unwrap();
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        drop(db);
        // The five old tables of the book, the activity table and the view over it.
        assert_eq!(
            retire_old(&path, WorkMeter::new(), |_| Ok(true))
                .unwrap()
                .tables,
            7
        );
        let db = rusqlite::Connection::open(&path).unwrap();
        let views: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type='view' AND name='activity'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(views, 0);
        assert!(!holds(&path, marker));
    }

    #[test]
    fn retiring_drops_nothing_before_the_migration_is_finished_or_when_a_kept_view_names_an_old_table(
    ) {
        let marker = "an-erased-value-7Qx";
        let (_dir, path) = old_book(marker);
        let before = tables(&path);
        assert!(retire_old(&path, WorkMeter::new(), |_| Ok(false)).is_err());
        assert_eq!(tables(&path), before);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE VIEW kept_log AS SELECT id FROM record_log;")
            .unwrap();
        assert_eq!(
            retire_old(&path, WorkMeter::new(), |_| Ok(true)).unwrap_err(),
            Error::Invalid("a view or trigger of a kept table names an old table", crate::cause!())
        );
        assert_eq!(tables(&path), before);
        assert!(holds(&path, marker));
    }

    /// A placement file (an empty file is an empty SQLite database) in its own folder, and its writer.
    fn writer_of(name: &str) -> (tempfile::TempDir, PathBuf, std::sync::Arc<Writer>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .canonicalize()
            .unwrap()
            .join(format!("{name}.sqlite"));
        std::fs::write(&path, b"").unwrap();
        let writer = std::sync::Arc::new(Writer::new(path.clone(), WorkMeter::new(), 1024 * 1024));
        (dir, path, writer)
    }
    fn lend(writer: &std::sync::Arc<Writer>) -> LentWriter {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        writer
            .lend(
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                deadline,
            )
            .unwrap()
    }

    #[test]
    fn the_next_command_borrows_the_same_writer_while_the_file_is_the_same() {
        let (_dir, _path, writer) = writer_of("same");
        let first = lend(&writer);
        let handle = first.handle();
        drop(first);
        assert_eq!(lend(&writer).handle(), handle);
    }

    #[test]
    fn another_file_at_the_path_or_a_borrow_still_out_opens_a_new_writer() {
        let (dir, path, writer) = writer_of("changed");
        let first = lend(&writer);
        // A second borrow while the first is out opens its own handle.
        let second = lend(&writer);
        assert_ne!(second.handle(), first.handle());
        drop(second);
        drop(first);
        let kept = lend(&writer);
        let before = kept.held().file;
        drop(kept);
        // Another file renamed over the path: the next borrow is a handle on that file.
        let other = dir.path().canonicalize().unwrap().join("other.sqlite");
        std::fs::write(&other, b"").unwrap();
        std::fs::rename(&other, &path).unwrap();
        let replaced = lend(&writer);
        assert_eq!(replaced.held().file, file_at(&path).unwrap());
        assert_ne!(replaced.held().file, before);
    }

    #[test]
    fn a_borrow_given_back_with_its_transaction_open_is_rolled_back_and_kept() {
        let (_dir, _path, writer) = writer_of("open");
        let lent = lend(&writer);
        std::mem::forget(
            lent.begin(rusqlite::TransactionBehavior::Immediate)
                .unwrap(),
        );
        assert!(!lent.connection().is_autocommit());
        let handle = lent.handle();
        drop(lent);
        let again = lend(&writer);
        assert_eq!(again.handle(), handle);
        assert!(
            again.connection().is_autocommit(),
            "the open transaction was rolled back"
        );
    }

    /// A destroyed record's bytes leave the file as its removal commits on the kept writer too.
    #[test]
    fn the_writer_overwrites_removed_bytes() {
        let (_dir, _path, writer) = writer_of("secure");
        let lent = lend(&writer);
        let on: i64 = lent
            .connection()
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .unwrap();
        assert_eq!(on, 1);
    }

    /// A command stops at its step budget: a statement past `COMMAND_STEPS` is interrupted.
    #[test]
    fn a_lent_writer_stops_at_its_step_budget() {
        let (_dir, _path, writer) = writer_of("budget");
        let lent = lend(&writer);
        let counted = lent.connection().query_row(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n",
            [], |row| row.get::<_, i64>(0));
        assert!(counted.is_err(), "an endless statement is stopped");
    }

    /// Many resources, each in a file of its own made on first open, each with a different value shape: every create,
    /// compare-and-set update, read, stale write and reopen answers exactly, and the time to make each file (its file,
    /// every family and the record store over it) is printed as p50 / p99. The default run makes
    /// `QUICK_RESOURCES`; `STORE_CREATE_RESOURCES=10000` runs the full measure (run it with `--release`).
    #[test]
    fn each_resource_file_is_made_quickly_and_every_record_answers_exactly() {
        use crate::records::{Mutation, Records};
        const QUICK_RESOURCES: usize = 200;
        let count = std::env::var("STORE_CREATE_RESOURCES")
            .ok()
            .and_then(|text| text.parse().ok())
            .unwrap_or(QUICK_RESOURCES);
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().canonicalize().unwrap();
        let shape = |n: usize, round: u64| {
            let mut value = serde_json::Map::new();
            for field in 0..=(n % 13) {
                let name = format!("f{}_{field}", n % 7);
                let entry = match (n + field) % 5 {
                    0 => serde_json::json!(n as u64 * 31 + round),
                    1 => serde_json::json!(format!("text {n} {round}")),
                    2 => serde_json::json!(n as f64 / 3.0 + round as f64),
                    3 => serde_json::json!([n, round, "item"]),
                    _ => serde_json::json!({"nested": {"n": n, "round": round}}),
                };
                value.insert(name, entry);
            }
            serde_json::Value::Object(value)
        };
        let put = |id: &str, expected: i64, key: String, value: serde_json::Value| Mutation {
            id: id.into(),
            expected_version: expected,
            request_key: key,
            deleted: false,
            value,
        };
        let (mut create, mut write, mut read) = (
            Vec::with_capacity(count),
            Vec::with_capacity(count),
            Vec::with_capacity(count),
        );
        for n in 0..count {
            let resource = format!("@test-db/bench-{n}");
            let started = std::time::Instant::now();
            let (path, mut store) =
                open_state_resource(&resource, &state, WorkMeter::new()).unwrap();
            create.push(started.elapsed());
            assert!(path.is_file(), "{resource} has its own file");
            let made = store
                .mutate(
                    "account",
                    &resource,
                    put("item", 0, format!("make-{n}"), shape(n, 0)),
                )
                .unwrap();
            assert_eq!(made.version, 1);
            let started = std::time::Instant::now();
            let changed = store
                .mutate(
                    "account",
                    &resource,
                    put("item", 1, format!("change-{n}"), shape(n, 1)),
                )
                .unwrap();
            write.push(started.elapsed());
            assert_eq!(changed.version, 2);
            assert!(
                matches!(
                    store.mutate(
                        "account",
                        &resource,
                        put("item", 1, format!("stale-{n}"), shape(n, 2))
                    ),
                    Err(Error::Conflict(_))
                ),
                "a stale write conflicts"
            );
            let started = std::time::Instant::now();
            let got = store
                .get("account", &resource, "item")
                .unwrap()
                .record
                .unwrap();
            read.push(started.elapsed());
            assert_eq!((got.version, &got.value), (2, &shape(n, 1)));
        }
        // Each file holds only its own resource's record, and survives a reopen.
        for n in (0..count).step_by(97) {
            let resource = format!("@test-db/bench-{n}");
            let (_path, store) = open_state_resource(&resource, &state, WorkMeter::new()).unwrap();
            assert_eq!(
                store
                    .get("account", &resource, "item")
                    .unwrap()
                    .record
                    .unwrap()
                    .value,
                shape(n, 1)
            );
            let other = format!("@test-db/bench-{}", (n + 1) % count);
            if other != resource {
                assert!(
                    store
                        .get("account", &other, "item")
                        .unwrap()
                        .record
                        .is_none(),
                    "{other} is not in {resource}'s file"
                );
            }
        }
        let quantile = |times: &mut Vec<Duration>, q: f64| {
            times.sort_unstable();
            times[((times.len() - 1) as f64 * q).round() as usize].as_secs_f64() * 1000.0
        };
        crate::quiet_println!(
            "{count} resource files: create p50 {:.2} ms p99 {:.2} ms; write p50 {:.2} ms p99 {:.2} ms; read p50 {:.3} ms p99 {:.3} ms",
            quantile(&mut create, 0.5), quantile(&mut create, 0.99), quantile(&mut write, 0.5), quantile(&mut write, 0.99),
            quantile(&mut read, 0.5), quantile(&mut read, 0.99),
        );
    }
}

#[cfg(test)]
mod computer_budget_tests {
    use super::*;
    use crate::account::computers::ComputerReport;
    use crate::storage::record_store::settings::{Budget, Volume};

    fn report(storage: Budget) -> ComputerReport {
        ComputerReport {
            sealed_versions: None,
            storage,
            reach: "reach".into(),
            cost_per_month_cents: 0,
            contained_tools: false,
            always_on: None,
            local_ports: Default::default(),
            program_folders: vec![],
            takes_new_accounts: false,
            store_size: None,
            unknown_keys: Default::default(),
        }
    }

    #[test]
    fn the_byte_budget_comes_from_the_computer_report() {
        let volume = Volume {
            store_bytes: 1000,
            free_bytes: 5000,
        };
        let fixed = computer_limits_from(&report(Budget::Bytes(777)), &volume).unwrap();
        assert_eq!(fixed.byte_budget, 777);
        let kept = computer_limits_from(&report(Budget::KeepFreeBytes(1000)), &volume).unwrap();
        assert_eq!(
            kept.byte_budget,
            1000 + (5000 - 1000),
            "what the store holds plus the free bytes above the reserve"
        );
        let other = computer_limits_from(&report(Budget::KeepFreeBytes(4000)), &volume).unwrap();
        assert_eq!(
            other.byte_budget,
            1000 + 1000,
            "a different report gives a different budget"
        );
        assert_eq!(
            fixed.max_record_bytes, kept.max_record_bytes,
            "the record bound is the computer's shipped bound"
        );
    }
}

/// Every module that builds a record store directly (`RecordStore::new`), outside the placement opener above and the record
/// store's own module. A new direct construction in another module fails this test: route it through `native_with_limits`.
/// A module listed here keeps its construction because its store is not a placement file (a lent handle inside one
/// transaction, an in-memory store, a recording wrapper, a test or the hosted build); the reason is beside each entry.
#[cfg(test)]
mod opener_guard_tests {
    use std::path::{Path, PathBuf};

    const ALLOWED: &[(&str, &str)] = &[
        ("storage/record_store_resources.rs", "the placement opener itself (native, native_with_limits)"),
        ("storage/record_store/mod.rs", "the record store's own module and tests"),
        ("native_entry/computer/domain_transfer.rs", "a lent handle inside a move's activation, no placement path"),
        ("local_account/own_records.rs", "the own store's recording wrapper (from_boxed_storage: no placement path)"),
        ("account/computers/copies.rs", "lent and mirrored copies inside an open transaction, plus test fixtures"),
        ("native_entry/live.rs", "in-memory store in a test"),
        ("native_entry/module_computer/object.rs", "the hosted build's object store (no placement path)"),
        ("account_files/history_keeper.rs", "test fixture"),
        ("account_files/take.rs", "test fixture"),
        ("account_files/write.rs", "test fixture"),
        ("account_files/usage.rs", "in-memory store in a test"),
        ("storage/kind_views.rs", "in-memory store in a test"),
        ("storage/record_store/segments.rs", "test fixture"),
        ("storage/supplies/tests/write_reads.rs", "test fixture"),
        ("local_account/native_command_context.rs", "a command's record view inside its own transaction"),
        ("storage/record_store_resources/domains.rs", "test fixture for the domain authority (its construction is in a test)"),
    ];

    fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn no_module_builds_a_record_store_outside_the_opener_unless_it_is_listed() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&src, &mut files);
        let mut bypass = Vec::new();
        for file in files {
            let relative = file.strip_prefix(&src).unwrap().to_string_lossy().replace('\\', "/");
            if relative.ends_with("_tests.rs") || relative.ends_with("/tests.rs") || relative.contains("/tests/") {
                continue;
            }
            let text = std::fs::read_to_string(&file).unwrap();
            if !text.contains("RecordStore::new(") {
                continue;
            }
            if !ALLOWED.iter().any(|(listed, _)| *listed == relative) {
                bypass.push(relative);
            }
        }
        assert!(bypass.is_empty(), "these modules build a record store outside the opener, route them through native_with_limits or list them with a reason: {bypass:?}");
    }
}

#[cfg(all(test, not(hosted_records)))]
mod lock_wait_tests {
    use super::{waiting_for_lock, BEGIN_WAIT};
    use std::time::{Duration, Instant};

    fn hold_lock_for(path: std::path::PathBuf, held: std::time::Duration) -> (std::sync::mpsc::Receiver<()>, std::thread::JoinHandle<()>) {
        let (ready, lock_held) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let other = rusqlite::Connection::open(path).unwrap();
            other.execute_batch("BEGIN IMMEDIATE").unwrap();
            ready.send(()).unwrap();
            std::thread::sleep(held);
            other.execute_batch("ROLLBACK").unwrap();
        });
        (lock_held, holder)
    }

    /// A step that needs the write lock waits for a connection that holds it briefly, then succeeds, and the connection is
    /// left at no wait: against a lock held for longer, the next statement fails at once.
    #[test]
    fn a_lock_step_waits_for_a_brief_holder_then_succeeds_and_then_fails_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock.sqlite");
        rusqlite::Connection::open(&path).unwrap().execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t (v INTEGER);").unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();

        let (lock_held, holder) = hold_lock_for(path.clone(), Duration::from_millis(150));
        lock_held.recv().unwrap();
        let started = Instant::now();
        let waited = waiting_for_lock(&db, Instant::now() + BEGIN_WAIT, |error| error, |db| db.execute_batch("BEGIN IMMEDIATE; ROLLBACK"));
        assert!(waited.is_ok(), "the step waits for the brief holder and succeeds: {waited:?}");
        assert!(started.elapsed() >= Duration::from_millis(100), "it waited for the lock, not failed at once");
        holder.join().unwrap();

        let (lock_held, holder) = hold_lock_for(path, Duration::from_millis(1500));
        lock_held.recv().unwrap();
        let started = Instant::now();
        let at_once = db.execute_batch("BEGIN IMMEDIATE");
        assert!(at_once.is_err() && started.elapsed() < Duration::from_millis(500), "after the step the connection waits no more: {at_once:?}");
        holder.join().unwrap();
    }
}

#[cfg(test)]
mod list_books_tests {
    // The id-ordered list of an account whose records span two books: every row comes back once, across the page walk.
    // The primary book holds the low ids and an overflow book the high ids; the span directory names the overflow book's
    // span. Red before `OwnRead::ids_of_type` walked the spans (7113f4746: the primary book's rows only).
    use crate::local_account::own_records::{publish_directory, read_own_with_keys, OwnRecords, RESOURCE};
    use crate::record_value::list::{list, ListQuery, ListRange, MAX_LIST_WALK};
    use crate::records::Error;
    use crate::record_value::{Limits, OpenPolicy};
    use crate::records::{Mutation, Records};
    use crate::storage::record_store_resources::book_directory::Directory;
    use crate::storage::record_store_resources::books::Books;
    use crate::storage::record_store_resources::Readers;
    use serde_json::json;

    #[test]
    fn a_list_by_id_across_two_books_returns_every_row_once() {
        let dir = tempfile::tempdir().unwrap();
        let primary = dir.path().canonicalize().unwrap().join("own-records.sqlite");
        let owner = "synthetic-owner";
        let meter = crate::sqlite_work::WorkMeter::new();
        const ROWS: usize = 40;
        const SPLIT: usize = 20;
        let books = Books::new(&primary, meter.clone(), None);
        OwnRecords::initialize_new_work_store(&mut books.open_book(0).unwrap(), owner, 1).unwrap();
        for (order, rows) in [(0usize, 0..SPLIT), (1usize, SPLIT..ROWS)] {
            let mut book = books.open_book(order).unwrap();
            for n in rows {
                book.mutate(owner, RESOURCE, Mutation {
                    id: format!("c{n:03}"),
                    expected_version: 0,
                    request_key: format!("check-{n}"),
                    deleted: false,
                    value: json!({"kind": "check", "sequence": "1", "stored": format!("{{\"n\":{n}}}"), "meta": null, "protected": false}),
                })
                .unwrap();
            }
        }
        let directory = Directory::new().split(0, &format!("c{SPLIT:03}"), 1).unwrap();
        publish_directory(&mut books.open_book(0).unwrap(), owner, &directory).unwrap();
        let readers = Readers::new(primary, meter);
        let ids = read_own_with_keys(&readers, owner, None, |view| -> Result<Vec<String>, Error> {
            let (mut ids, mut after) = (Vec::new(), None);
            loop {
                let query = ListQuery {
                    kind: "check",
                    order: None,
                    range: ListRange::default(),
                    reverse: true,
                    limit: 5,
                    walk_limit: MAX_LIST_WALK,
                    after: after.take(),
                };
                let page = list(view, &query, &OpenPolicy::default(), Limits::default()).unwrap();
                ids.extend(page.rows.iter().map(|row| row.id().to_owned()));
                match page.next {
                    Some(next) => after = Some(next),
                    None => return Ok(ids),
                }
            }
        })
        .unwrap()
        .0;
        let expected: Vec<String> = (0..ROWS).rev().map(|n| format!("c{n:03}")).collect();
        assert_eq!(ids, expected, "every row of both books, newest id first, once");
    }
}
