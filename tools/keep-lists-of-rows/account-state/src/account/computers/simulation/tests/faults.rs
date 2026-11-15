//! Fault rows: each row is DATA (`src/account/computers/simulation/faults.json`) that names one fault and its
//! parameters. The world applies a row by its kind; no scenario carries its own fault code.

use super::World;
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Fault {
    /// The clock jumps forward by `ms` at once (a computer whose clock was wrong).
    ClockBump { ms: i64 },
    Partition { a: String, b: String },
    Heal { a: String, b: String },
    /// The node stops for good: it sends and receives nothing.
    Kill { node: String },
    /// The node stops answering; its messages wait until it resumes.
    Pause { node: String },
    Resume { node: String },
    /// The disk holds at most `capacity_bytes` in every view of it.
    Enospc { capacity_bytes: usize },
    /// Power is lost: every write not yet fsynced is gone.
    PowerCut,
    /// A second process opens the identity of a live node.
    DuplicateIdentity { node: String },
    /// The node's config fails to load at its next start.
    ConfigLoadFailure { node: String },
    /// The node runs release `version`, which may differ from the others'.
    VersionSkew { node: String, version: u32 },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FaultRow {
    pub id: String,
    pub fault: Fault,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FaultRows {
    pub format: String,
    pub about: String,
    pub rows: Vec<FaultRow>,
}

impl World {
    pub fn apply(&mut self, fault: &Fault) {
        match fault {
            Fault::ClockBump { ms } => self.jump(*ms),
            Fault::Partition { a, b } => self.partition(a, b),
            Fault::Heal { a, b } => self.heal(a, b),
            Fault::Kill { node } => self.kill(node),
            Fault::Pause { node } => self.pause(node),
            Fault::Resume { node } => self.resume(node),
            Fault::Enospc { capacity_bytes } => self.limit_disk(*capacity_bytes),
            Fault::PowerCut => self.power_cut(),
            Fault::DuplicateIdentity { node } => self.duplicate_identity(node),
            Fault::ConfigLoadFailure { node } => self.break_config(node),
            Fault::VersionSkew { node, version } => self.set_version(node, *version),
        }
    }
}

/// The fault rows of the corpus, by id. The format string is checked so a reader of another format fails loudly.
pub fn load(json: &str) -> Vec<FaultRow> {
    let rows: FaultRows = serde_json::from_str(json).expect("fault rows parse");
    assert_eq!(rows.format, "deterministic-world-faults/1", "unknown fault row format");
    assert!(!rows.about.is_empty(), "fault rows name their purpose");
    rows.rows
}
