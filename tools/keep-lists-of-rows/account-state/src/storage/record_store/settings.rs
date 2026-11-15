// src/storage/record_store/settings.rs
//
// Purpose: Load and validate the record store's settings DATA (`settings.json`) once, and resolve a store's byte budget
// from a budget shape (a computer's own report, src/account/computers.rs).
//
// Non-Negotiable Invariants:
// - Every bound is positive, and the receipt window is no longer than the undo window, so a tombstone always
//   outlives the receipts it carries.
// - A malformed file refuses every store open; it is never partly accepted.
// - A byte budget is never one number for every computer: each computer reports its own (src/account/computers.rs).
//
// Key Concepts:
// - `Settings`: receipts, undo window, exit step, search port, kind field, declared `orders` and `totals`, and the
//   largest record a computer's store keeps (`computer_record_bytes`).
// - `Budget`: a fixed byte count, or what the store holds now plus the volume's free bytes above a reserve the store
//   must leave free (`budget_bytes`).
// - `Limits`: one store's record bound and byte budget, resolved at open.
//
// Security Considerations:
// - Settings bound work and bytes; they grant nothing. `volume_free_bytes` reads one filesystem statistic.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{orders::Declared, search::Layout};
use serde::{Deserialize, Serialize};
use std::{io, path::Path, sync::OnceLock};

const DATA: &[u8] = include_bytes!("settings.json");

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipts {
    pub window_ms: u64,
    pub max_entries: usize,
}

/// How large a computer lets a store grow.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Budget {
    /// A fixed number of bytes (a platform's storage limit).
    Bytes(u64),
    /// What the store holds now plus the volume's free bytes above this reserve, resolved at open.
    KeepFreeBytes(u64),
}

/// The limits of one store: its largest record and its byte budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_record_bytes: usize,
    /// The store refuses a change that leaves it larger.
    pub byte_budget: u64,
}

impl Limits {
    /// Fixed limits: records up to `max_record_bytes`, the store growing to `byte_budget`. A computer's own stores take
    /// their limits from its report (`record_store_resources::computer_limits`); a store with no computer (one in memory, a scratch
    /// file) names its own.
    pub fn fixed(max_record_bytes: usize, byte_budget: u64) -> Self {
        Self {
            max_record_bytes,
            byte_budget,
        }
    }
}

/// The volume a store's file lives on, for a budget sized to the disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Volume {
    /// Bytes the store holds now (`Storage::allocated_bytes`).
    pub store_bytes: u64,
    /// Bytes free to an unprivileged writer on its volume (`volume_free_bytes`).
    pub free_bytes: u64,
}

/// The full-store recovery's DATA.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FullStore {
    #[serde(rename = "_what")]
    pub what: String,
    /// How long a recovery that freed nothing is not asked again.
    pub idle_ms: i64,
}

/// The per-arrival growth guard's DATA: a simulated month of arrivals, and the bytes per arrival a store may keep.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerArrival {
    #[serde(rename = "_what")]
    pub what: String,
    pub days: u32,
    pub arrivals_per_day: u32,
    pub seed: u64,
    pub database_bytes_per_arrival: u64,
    pub late_growth_ratio: f64,
    pub settle_hours: u32,
}

/// When a store file is vacuumed once (`settings.json` `vacuum`).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vacuum {
    #[serde(rename = "_why", default)]
    pub why: Option<String>,
    /// The share of the file's pages that must be free before the vacuum runs.
    pub free_fraction: f64,
    /// How many times the file's size the volume must have free: a vacuum rewrites the file beside itself.
    pub free_disk_factor: f64,
    /// How long the store must have been idle (no commit in its scope) before the vacuum runs.
    pub idle_ms: u64,
}

impl Vacuum {
    pub fn valid(&self) -> bool {
        self.free_fraction > 0.0 && self.free_fraction <= 1.0 && self.free_disk_factor > 0.0 && self.idle_ms > 0
    }
}

/// The writer's holder match index DATA (`settings.json` `holders`, `holders.rs`), in milliseconds.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Holders {
    #[serde(rename = "_why", default)]
    pub why: String,
    pub lease_ms: u64,
    pub lag_ms: u64,
}

/// The undo window of each profile (`settings.json` `undo_windows`), in milliseconds.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoWindows {
    #[serde(rename = "_why", default)]
    pub why: String,
    pub records: u64,
    pub vault: u64,
}

impl UndoWindows {
    /// The window of `profile`.
    pub fn of(&self, profile: crate::storage::record_store_resources::Undo) -> u64 {
        match profile {
            crate::storage::record_store_resources::Undo::Records => self.records,
            crate::storage::record_store_resources::Undo::Vault => self.vault,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    pub what: String,
    pub receipts: Receipts,
    pub undo_windows: UndoWindows,
    pub holders: Holders,
    pub exit_step_rows: usize,
    /// The most pages one `reclaim_step` gives back to the volume: the longest a step holds the store.
    pub reclaim_step_pages: u64,
    /// The one-time full vacuum that makes a file incremental auto-vacuum (`RecordStore::vacuum_if_due`).
    pub vacuum: Vacuum,
    /// The top-level text field of a record value that names its kind (the `live_kind` order lists by it).
    pub kind_field: String,
    pub search: Layout,
    /// Declared field orders (`orders.rs`): one `ordered` row per record per order that covers it. Adding one is a row.
    #[serde(default)]
    pub orders: Vec<Declared>,
    /// Declared totals (`totals.rs`): one `totals` row per account, total and group, kept with every write. Adding one
    /// is a row.
    #[serde(default)]
    pub totals: Vec<super::totals::Declared>,
    /// The largest record value a store of a computer keeps. A computer's byte budget comes from its own report.
    pub computer_record_bytes: usize,
    /// One item larger than a page (`records::MAX_PAGE_BYTES`) is answered as a page of its own up to this many bytes
    /// (old trillion src/resource-state-carry.mjs:11 `ROW_BYTES`, 16 MiB).
    pub one_item_page_bytes: usize,
    /// The bounds of record sync (`record_sync.rs`).
    pub settle: super::record_sync::Bounds,
    /// Whether every write also makes its records into the settle store of its scope (`mod.rs` `mirror_settle`).
    pub settle_mirror: bool,
    /// Bound retained inactive resource owners; active callers retain their own leases.
    pub idle_resources: usize,
    /// Bound work framing an admitted logical history, on every supply.
    pub identity_text_bytes: usize,
    /// Bounded copy turns and foreground capture while a complete native domain moves.
    pub live_adoption: crate::storage::record_store_resources::carry::live_adopt::Limits,
    /// How big one store may grow: the default size row and the commands that only add (`store_size.rs`, old trillion
    /// src/store-size.json).
    pub store_size: super::store_size::StoreSize,
    /// Which commands land in a further store once theirs reaches a level (`store_size.rs`, old trillion
    /// own-record-volume.json).
    pub volume_stores: super::store_size::VolumeStores,
    /// Replaced versions bounded by bytes as well as time (`store_size.rs`, old trillion src/record-history.json).
    pub history: super::store_size::HistoryBound,
    /// Which resources keep their replaced versions as chained files before they leave (`history_archive.rs`, old
    /// trillion src/record-history.json); none unless the DATA names one.
    pub history_archive: super::history_archive::ArchiveSettings,
    /// How a keep rule's row is read (`keep.rs`): the person's rules for how long a kind of records is kept.
    pub keep: super::keep::Settings,
    /// Kinds whose named object fields are stored once by content (`shared.rs`); none unless the DATA names one.
    #[serde(default)]
    pub shared_children: Vec<super::shared::SharedChildren>,
    #[serde(rename = "_shared_children_why", default)]
    pub shared_children_why: Option<String>,
    /// Kinds whose named fields point to other records, kept in the referrers index (`referrers.rs`); none unless the
    /// DATA names one.
    #[serde(default)]
    pub referrer_parts: Vec<super::referrers::ReferrerPart>,
    #[serde(rename = "_referrer_parts_why", default)]
    pub referrer_parts_why: Option<String>,
    /// The records erased with one record of a kind (`cascade.rs` `erase_cascading`, old record-model.json
    /// `erase_with`); none unless the DATA names one.
    #[serde(default)]
    pub erase_with: Vec<super::cascade::EraseWith>,
    #[serde(rename = "_erase_with_why", default)]
    pub erase_with_why: Option<String>,
    /// The most records one referrers walk step reads (`referrers.rs` `walk_referrers`, old record-log-store.mjs `MODEL_PAGE`).
    pub referrers_walk_rows: usize,
    #[serde(rename = "_referrers_walk_rows_why", default)]
    pub referrers_walk_rows_why: Option<String>,
    /// The full-store recovery (`full_store.rs`, old trillion src/full-store-recovery.mjs).
    pub full_store: FullStore,
    /// The per-arrival growth guard a simulated month holds a store to (`month_tests.rs`, old trillion
    /// src/reliability-ceilings.json `month`, test/store-month.test.mjs).
    pub per_arrival: PerArrival,
    /// The page size a store file starts with (`page_tests.rs` measures it): a power of two from 512 to 65,536.
    pub page_bytes: u32,
    #[serde(rename = "_page_bytes_why", default)]
    pub page_bytes_why: Option<String>,
}

impl Settings {
    /// Whether every bound holds; the store refuses settings that fail.
    pub fn valid(&self) -> bool {
        self.receipts.window_ms > 0
            && self.idle_resources > 0
            && self.identity_text_bytes > 0
            && self.live_adoption.page_rows > 0
            && self.live_adoption.page_bytes > 0
            && self.live_adoption.commit_bytes > 0
            && self.live_adoption.capture_bytes >= self.live_adoption.commit_bytes
            && self.receipts.max_entries > 0
            && self.undo_windows.records >= self.receipts.window_ms
            && self.undo_windows.vault > 0
            && self.holders.lease_ms > 0
            && self.holders.lag_ms > 0
            && self.exit_step_rows > 0
            && self.reclaim_step_pages > 0
            && self.vacuum.valid()
            && !self.kind_field.is_empty()
            && self.search.valid()
            && self.orders.iter().all(Declared::valid)
            && self.orders.iter().enumerate().all(|(at, one)| {
                self.orders[..at]
                    .iter()
                    .all(|other| other.order != one.order)
            })
            && self.totals.iter().all(super::totals::Declared::valid)
            && self.totals.iter().enumerate().all(|(at, one)| {
                self.totals[..at]
                    .iter()
                    .all(|other| other.total != one.total)
            })
            && self.computer_record_bytes > 0
            && self.one_item_page_bytes >= crate::records::MAX_PAGE_BYTES
            && self.store_size.valid()
            && self.volume_stores.valid(&self.store_size.default)
            && self.history.valid(&self.store_size.default)
            && self.history_archive.valid()
            && self.keep.valid()
            && self
                .referrer_parts
                .iter()
                .all(super::referrers::ReferrerPart::valid)
            && self.erase_with.iter().all(super::cascade::EraseWith::valid)
            && (1..=crate::records::MAX_PAGE_ITEMS).contains(&self.referrers_walk_rows)
            && self.full_store.idle_ms > 0
            && self.per_arrival.days >= 4
            && self.per_arrival.arrivals_per_day > 0
            && self.per_arrival.database_bytes_per_arrival > 0
            && self.per_arrival.late_growth_ratio.is_finite()
            && self.per_arrival.late_growth_ratio >= 1.0
            && (512..=65536).contains(&self.page_bytes)
            && self.page_bytes.is_power_of_two()
    }
}

/// The byte budget `budget` gives a store: a fixed count, or what the store holds now plus the volume's free bytes
/// above the reserve. A reserve needs the store's `volume`; without it there is no budget.
pub fn budget_bytes(budget: Budget, volume: Option<Volume>) -> Option<u64> {
    Some(match budget {
        Budget::Bytes(bytes) => bytes,
        Budget::KeepFreeBytes(reserve) => {
            let volume = volume?;
            volume
                .store_bytes
                .saturating_add(volume.free_bytes.saturating_sub(reserve))
        }
    })
}

/// Bytes free to an unprivileged writer on the volume holding `path`, as the computer says it (`statvfs` on a POSIX
/// computer: available blocks times fragment size; src/tool_runs/os.rs `OwnerFiles`, and a computer that cannot say
/// keeps no store: the free-space floor then refuses).
/// The module computer (cfg `hosted_records`) has no volume of its own: it answers `Unsupported`, and its store's budget
/// comes from its report (`Budget::Bytes`), never from a disk.
#[cfg(hosted_records)]
pub fn volume_free_bytes(_path: &Path) -> io::Result<u64> {
    crate::io_operation!(Err(io::Error::from(io::ErrorKind::Unsupported)))
}
#[cfg(not(hosted_records))]
pub fn volume_free_bytes(path: &Path) -> io::Result<u64> {
    crate::io_operation!(<crate::tool_runs::os::This as crate::tool_runs::os::OwnerFiles>::free_bytes(path))
}

/// Inodes free to an unprivileged writer on the volume holding `path` (`statvfs`, as `volume_free_bytes`).
#[cfg(hosted_records)]
pub fn volume_free_inodes(_path: &Path) -> io::Result<u64> {
    crate::io_operation!(Err(io::Error::from(io::ErrorKind::Unsupported)))
}
#[cfg(not(hosted_records))]
pub fn volume_free_inodes(path: &Path) -> io::Result<u64> {
    crate::io_operation!(<crate::tool_runs::os::This as crate::tool_runs::os::OwnerFiles>::free_inodes(path))
}

/// The shipped settings with the orders the installed tools join (`record_model_policy` `orders`): one leaked
/// `&'static Settings` per distinct joined set, kept by the BLAKE3 of its canonical JSON (serde_json's maps are key-sorted,
/// so one set has one text). The same idiom as `schema::runtime_family`: a set laid out again returns the one held, so
/// the leaks are bounded by the distinct installed tool sets. An order the shipped settings or another joined order
/// already names refuses the set (`Settings::valid`), so a joined order never shadows a shipped one.
pub fn with_joined_orders(joined: &serde_json::Value) -> Result<&'static Settings, crate::records::Error> {
    static HELD: std::sync::Mutex<std::collections::BTreeMap<String, &'static Settings>> =
        std::sync::Mutex::new(std::collections::BTreeMap::new());
    let refused = || crate::records::Error::Invalid("joined record orders DATA is invalid", crate::cause!());
    let text = serde_json::to_vec(joined).map_err(|_| refused())?;
    let key = content_crypto::advanced::blake3::hash(&text).to_hex().to_string();
    let mut held = HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(known) = held.get(&key) {
        return Ok(known);
    }
    let declared: Vec<Declared> = serde_json::from_value(joined.clone()).map_err(|_| refused())?;
    let mut settings = shipped().ok_or_else(refused)?.clone();
    settings.orders.extend(declared);
    if !settings.valid() {
        return Err(refused());
    }
    let leaked: &'static Settings = Box::leak(Box::new(settings));
    held.insert(key, leaked);
    Ok(leaked)
}

/// The shipped settings, validated once.
pub fn shipped() -> Option<&'static Settings> {
    static LOADED: OnceLock<Option<Settings>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            serde_json::from_slice::<Settings>(DATA)
                .ok()
                .filter(Settings::valid)
        })
        .as_ref()
}

#[cfg(test)]
mod joined_orders_tests {
    use super::*;
    use serde_json::json;

    fn order(name: &str, kind: &str) -> serde_json::Value {
        json!([{"_why": "a joined test order", "order": name, "kind": kind, "path": ["stored", "status"]}])
    }

    #[test]
    fn the_same_join_is_one_settings_and_a_different_join_is_another() {
        let first = with_joined_orders(&order("ai-job/status", "ai-job")).unwrap();
        let again = with_joined_orders(&order("ai-job/status", "ai-job")).unwrap();
        assert!(std::ptr::eq(first, again), "the same joined set keeps the one settings it holds");
        let other = with_joined_orders(&order("ai-job/state", "ai-job")).unwrap();
        assert!(!std::ptr::eq(first, other));
        assert!(other.orders.iter().any(|one| one.order == "ai-job/state"));
        assert!(other.orders.iter().any(|one| one.order == "decision/created_at"), "shipped orders stay");
        assert!(!shipped().unwrap().orders.iter().any(|one| one.order == "ai-job/state"), "the shipped settings are unchanged");
    }

    #[test]
    fn a_join_that_names_a_shipped_or_repeated_order_refuses() {
        assert!(with_joined_orders(&order("decision/created_at", "decision")).is_err());
        let twice = json!([
            {"_why": "a", "order": "ai-job/status", "kind": "ai-job", "path": ["stored", "status"]},
            {"_why": "b", "order": "ai-job/status", "kind": "ai-job", "path": ["stored", "state"]}
        ]);
        assert!(with_joined_orders(&twice).is_err());
    }
}
