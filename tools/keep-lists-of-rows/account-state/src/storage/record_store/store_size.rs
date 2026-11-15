// src/storage/record_store/store_size.rs
//
// Purpose: How big one record store may grow, as DATA rows: the size levels of old trillion's src/store-size.json, the
// further (overflow) stores of its own-record-volume.json, and the history bound of its src/record-history.json, all
// ported one to one into `settings.json` (`store_size`, `volume_stores`, `history`). A store's row comes from the
// account's plan or contract row, else the computer's own row (src/account/computers.rs `ComputerReport::store_size`), else the
// shipped default (old trillion's numbers). No limit is a number in this code.
//
// Non-Negotiable Invariants:
// - A row is DATA. Code never names a byte count, a share or a level id; `next_store_at` and `from_level` name a level
//   of the row by its id.
// - A malformed row is refused whole (`SizeRow::parse`): a store never runs on half a row. A malformed shipped default
//   refuses every store open (`Settings::valid`).
// - The highest level reached is the store's level (levels are listed lowest first, as old trillion listed them).
// - Growth is refused only when the store's level says `refuses: ["growth"]`; the person's own writes are never refused
//   by a level (old trillion: "every other command, the person's own writes among them, goes through").
// - trillion-local never knows what machine it runs on: a computer reports its own row, an account's plan or contract its own.
//
// Key Concepts:
// - `SizeRow`: `limit_bytes` and its `levels` (`LevelRow`: `at_share` of the limit, or `headroom_bytes` below it).
// - `Level`: where a store of `bytes` stands on a row: the level reached (if any), whether it refuses growth, whether
//   calls wait for recovery.
// - `resolve`: the row a store runs under (account's plan or contract row, else the computer's, else the default).
// - `VolumeStores`: which operations are volume, how further stores are named, the most an account holds, and the
//   level at which the next store opens.
// - `HistoryBound`: replaced versions leave after `keep_ms` once the store reaches `from_level` (bytes as well as time).
//
// Security Considerations:
// - Rows bound bytes; they grant nothing. An account row is read from the account's own record, never from a request.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde::Deserialize;

/// What a level refuses: `growth`, the commands that only add (`StoreSize::growth_operations`).
pub const GROWTH: &str = "growth";

/// One level of a size row.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LevelRow {
    pub id: String,
    /// Reached at this share of the row's `limit_bytes`.
    #[serde(default)]
    pub at_share: Option<f64>,
    /// Reached within this many bytes of the row's `limit_bytes`.
    #[serde(default)]
    pub headroom_bytes: Option<u64>,
    /// What a store at this level refuses (`GROWTH`), nothing else.
    pub refuses: Vec<String>,
    /// Whether calls wait for verified recovery first at this level.
    #[serde(default)]
    pub waits_for_recovery: bool,
    #[serde(rename = "_why", default)]
    pub why: Option<String>,
}

impl LevelRow {
    fn valid(&self) -> bool {
        let share_ok = self.at_share.is_none_or(|share| share.is_finite() && share > 0.0 && share <= 1.0);
        !self.id.is_empty()
            && self.at_share.is_some() != self.headroom_bytes.is_some()
            && share_ok
            && self.refuses.iter().all(|what| what == GROWTH)
    }

    /// Whether a store holding `bytes` under a limit of `limit` has reached this level.
    fn reached(&self, bytes: u64, limit: u64) -> bool {
        match (self.at_share, self.headroom_bytes) {
            // Compared in integers: the share's byte count rounds up, so a level is never reached early.
            (Some(share), _) => bytes as f64 >= (limit as f64 * share).ceil(),
            (_, Some(headroom)) => bytes.saturating_add(headroom) >= limit,
            _ => false,
        }
    }
}

/// One size row: the default, a computer's own, or an account's plan or contract row.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SizeRow {
    #[serde(rename = "_why", default)]
    pub why: Option<String>,
    /// The store's hard limit.
    pub limit_bytes: u64,
    /// Lowest first; the highest reached is the store's level.
    pub levels: Vec<LevelRow>,
}

impl SizeRow {
    /// Whether the row holds: a positive limit, at least one level, every level valid, ids unique.
    pub fn valid(&self) -> bool {
        self.limit_bytes > 0
            && !self.levels.is_empty()
            && self.levels.iter().all(LevelRow::valid)
            && self.levels.iter().enumerate().all(|(at, one)| self.levels[..at].iter().all(|other| other.id != one.id))
    }

    /// A row given as JSON (an account's plan or contract record, a computer's report); None when it is not a valid row.
    pub fn parse(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value::<Self>(value.clone()).ok().filter(Self::valid)
    }

    /// Where a store holding `bytes` stands on this row.
    pub fn level(&self, bytes: u64) -> Level<'_> {
        let at = self.levels.iter().rposition(|level| level.reached(bytes, self.limit_bytes));
        Level { row: self, at, bytes }
    }

    /// The position of the level named `id`, when the row has one.
    pub fn position(&self, id: &str) -> Option<usize> {
        self.levels.iter().position(|level| level.id == id)
    }
}

/// Where a store stands on its row.
#[derive(Clone, Copy, Debug)]
pub struct Level<'a> {
    row: &'a SizeRow,
    /// The highest level reached, by position; None below every level.
    at: Option<usize>,
    /// The bytes the store holds.
    pub bytes: u64,
}

impl Level<'_> {
    /// The id of the highest level reached; None below every level.
    pub fn id(&self) -> Option<&str> {
        self.at.map(|at| self.row.levels[at].id.as_str())
    }

    /// Whether the store refuses growth here.
    pub fn refuses_growth(&self) -> bool {
        self.at.is_some_and(|at| self.row.levels[at].refuses.iter().any(|what| what == GROWTH))
    }

    /// Whether calls wait for verified recovery here.
    pub fn waits_for_recovery(&self) -> bool {
        self.at.is_some_and(|at| self.row.levels[at].waits_for_recovery)
    }

    /// Whether the store has reached the level named `id` or one above it. A row without that level never reaches it.
    pub fn reached(&self, id: &str) -> bool {
        matches!((self.at, self.row.position(id)), (Some(at), Some(wanted)) if at >= wanted)
    }

    /// The row's hard limit.
    pub fn limit_bytes(&self) -> u64 {
        self.row.limit_bytes
    }
}

/// The `store_size` DATA: the default row and the commands that only add.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoreSize {
    #[serde(rename = "_what")]
    pub what: String,
    pub default: SizeRow,
    pub growth_operations: Vec<String>,
    #[serde(rename = "_growth_operations_why", default)]
    pub growth_operations_why: Option<String>,
}

impl StoreSize {
    pub fn valid(&self) -> bool {
        self.default.valid() && self.growth_operations.iter().all(|operation| !operation.is_empty())
    }

    /// Whether `operation` (a command's name) only adds.
    pub fn is_growth(&self, operation: &str) -> bool {
        self.growth_operations.iter().any(|known| known == operation)
    }
}

/// The row a store runs under: the account's plan or contract row when it has one, else the computer's own row, else
/// the shipped default. A row is never merged with another: the first one given is the whole row.
pub fn resolve<'a>(account: Option<&'a SizeRow>, computer: Option<&'a SizeRow>, default: &'a SizeRow) -> &'a SizeRow {
    account.or(computer).unwrap_or(default)
}

/// The `volume_stores` DATA (old trillion own-record-volume.json).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VolumeStores {
    #[serde(rename = "_what")]
    pub what: String,
    /// The commands whose records may land in a further store.
    pub operations: Vec<String>,
    /// How a further store is named, before its order (`overflow:1`).
    pub overflow_prefix: String,
    /// The level (by id, of the store's row) at which the next store opens.
    pub next_store_at: String,
    #[serde(rename = "_overflow_why", default)]
    pub overflow_why: Option<String>,
}

impl VolumeStores {
    pub fn valid(&self, default: &SizeRow) -> bool {
        !self.overflow_prefix.is_empty()
            && default.position(&self.next_store_at).is_some()
            && self.operations.iter().all(|operation| !operation.is_empty())
    }

    /// Whether `operation` (a command's name) is volume.
    pub fn is_volume(&self, operation: &str) -> bool {
        self.operations.iter().any(|known| known == operation)
    }

    /// The name of the store at `order` (0: the primary, which has no name of its own).
    pub fn name(&self, order: usize) -> Option<String> {
        (order > 0).then(|| format!("{}{order}", self.overflow_prefix))
    }
}

/// The `history` DATA (old trillion src/record-history.json): replaced versions bounded by bytes as well as time.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryBound {
    #[serde(rename = "_what")]
    pub what: String,
    /// How long a replaced version stays once the store reached `from_level`.
    pub keep_ms: u64,
    /// The level (by id, of the store's row) from which replaced versions leave after `keep_ms`.
    pub from_level: String,
    /// The most replaced versions one write removes from `from_level`.
    pub rows_per_step: usize,
    /// The most one write removes at a level that waits for recovery.
    pub full_store_rows_per_step: usize,
}

impl HistoryBound {
    pub fn valid(&self, default: &SizeRow) -> bool {
        self.keep_ms > 0
            && self.rows_per_step > 0
            && self.full_store_rows_per_step >= self.rows_per_step
            && default.position(&self.from_level).is_some()
    }

    /// How long replaced versions stay in a store at `level`, and the most one write removes: None when the store is
    /// below `from_level` (the undo window holds).
    pub fn pressed(&self, level: &Level<'_>) -> Option<(u64, usize)> {
        if !level.reached(&self.from_level) {
            return None;
        }
        Some((self.keep_ms, if level.waits_for_recovery() { self.full_store_rows_per_step } else { self.rows_per_step }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shipped() -> &'static super::super::settings::Settings {
        super::super::settings::shipped().expect("the shipped settings hold")
    }

    #[test]
    fn the_default_row_is_old_trillions_numbers() {
        let size = &shipped().store_size;
        let row = &size.default;
        assert_eq!(row.limit_bytes, 10 * 1024 * 1024 * 1024);
        assert_eq!(row.level(0).id(), None);
        assert_eq!(row.level(row.limit_bytes * 69 / 100).id(), None);
        assert_eq!(row.level(row.limit_bytes * 7 / 10).id(), Some("warn"));
        assert!(!row.level(row.limit_bytes * 7 / 10).refuses_growth());
        assert_eq!(row.level(row.limit_bytes * 85 / 100).id(), Some("refuse-growth"));
        assert!(row.level(row.limit_bytes * 85 / 100).refuses_growth());
        let full = row.level(row.limit_bytes - 256 * 1024 * 1024);
        assert_eq!(full.id(), Some("full"));
        assert!(full.waits_for_recovery() && full.reached("warn") && full.reached("refuse-growth"));
        assert!(size.is_growth("inbound:take") && !size.is_growth("records:write"));
        let volume = &shipped().volume_stores;
        assert!(volume.is_volume("inbound:take"));
        assert_eq!((volume.name(0), volume.name(2)), (None, Some("overflow:2".to_owned())));
        let history = &shipped().history;
        assert_eq!(history.keep_ms, 3_600_000, "record-history.json keep_days 0.0416666666667");
        assert_eq!(history.pressed(&row.level(1)), None, "an empty store keeps history for the undo window");
        assert_eq!(history.pressed(&row.level(row.limit_bytes * 7 / 10)), Some((3_600_000, 1024)));
        assert_eq!(history.pressed(&full), Some((3_600_000, 4096)));
    }

    #[test]
    fn a_row_change_moves_the_limit_and_the_account_row_wins_over_the_computer() {
        let default = &shipped().store_size.default;
        let mut computer = default.clone();
        computer.limit_bytes = 1024 * 1024;
        let account = SizeRow::parse(&json!({
            "limit_bytes": 100 * 1024 * 1024,
            "levels": [{"id": "refuse-growth", "at_share": 0.5, "refuses": ["growth"]}]
        }))
        .expect("an account row with one level is a row");
        let bytes = 900 * 1024;
        assert!(!resolve(None, None, default).level(bytes).refuses_growth());
        assert!(resolve(None, Some(&computer), default).level(bytes).refuses_growth(), "the computer's row moved the limit");
        assert!(!resolve(Some(&account), Some(&computer), default).level(bytes).refuses_growth(), "the account's plan wins");
        assert!(resolve(Some(&account), Some(&computer), default).level(60 * 1024 * 1024).refuses_growth());
    }

    #[test]
    fn a_malformed_row_is_refused_whole() {
        for bad in [
            json!({"limit_bytes": 0, "levels": [{"id": "a", "at_share": 0.5, "refuses": []}]}),
            json!({"limit_bytes": 10, "levels": []}),
            json!({"limit_bytes": 10, "levels": [{"id": "a", "at_share": 1.5, "refuses": []}]}),
            json!({"limit_bytes": 10, "levels": [{"id": "a", "at_share": 0.5, "headroom_bytes": 1, "refuses": []}]}),
            json!({"limit_bytes": 10, "levels": [{"id": "a", "at_share": 0.5, "refuses": ["reads"]}]}),
            json!({"limit_bytes": 10, "levels": [{"id": "a", "at_share": 0.5, "refuses": []}, {"id": "a", "at_share": 0.6, "refuses": []}]}),
            json!({"limit_bytes": 10, "levels": [{"id": "a", "at_share": 0.5, "refuses": []}], "unknown": 1}),
        ] {
            assert!(SizeRow::parse(&bad).is_none(), "{bad}");
        }
    }

    // ---- Ported from old trillion test/growth-admission.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
    // deleted by Trillion-X/trillion #243. Old src/growth-admission.mjs refuseGrowth(store, operation) refused a command
    // when the store's level refused growth and the command only adds; here that decision is the store's level
    // (`Level::refuses_growth`) over the shipped `growth_operations` (`StoreSize::is_growth`). The old refusal's
    // `store-full` code and the RecordBook source check are left out: no running code answers a growth command with a
    // refusal code (searched src for store_full, store-full, refuses_growth: only the overflow-book choice in
    // src/local_account/resource_affinity.rs and src/storage/record_store_resources/books.rs reads the level).

    /// Whether a store holding `share` of the default row's limit turns `operation` away (old refuseGrowth's decision).
    fn refuses(share: f64, operation: &str) -> bool {
        let size = &shipped().store_size;
        let bytes = (size.default.limit_bytes as f64 * share).ceil() as u64;
        size.default.level(bytes).refuses_growth() && size.is_growth(operation)
    }

    /// Ported from old test/growth-admission.test.mjs, "at the warning level (70%) nothing is refused".
    #[test]
    fn old_growth_admission_at_the_warning_level_nothing_is_refused() {
        for operation in shipped().store_size.growth_operations.iter().map(String::as_str).chain(["records:write"]) {
            assert!(!refuses(0.7, operation), "{operation}");
        }
    }

    /// Ported from old test/growth-admission.test.mjs, "at 85% and when full the commands that only add are refused with
    /// store-full, the rest go through".
    #[test]
    fn old_growth_admission_at_85_percent_and_full_the_commands_that_only_add_are_refused() {
        for share in [0.85, 0.9, 0.9999] {
            for operation in &shipped().store_size.growth_operations {
                assert!(refuses(share, operation), "{operation} at {share}");
            }
            for operation in ["records:write", "lists:put", "workspace:write", "claims:handOff"] {
                assert!(!refuses(share, operation), "{operation} at {share}");
            }
        }
    }

    /// Ported from old test/growth-admission.test.mjs, "a store that reports no size refuses nothing": a store with
    /// nothing measured stands below every level.
    #[test]
    fn old_growth_admission_a_store_that_reports_no_size_refuses_nothing() {
        let size = &shipped().store_size;
        assert_eq!(size.default.level(0).id(), None);
        for operation in &size.growth_operations {
            assert!(!(size.default.level(0).refuses_growth() && size.is_growth(operation)), "{operation}");
        }
    }
}
