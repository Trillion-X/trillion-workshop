//! DATA the command-bookkeeping simulator reads: variants, workload shapes,
//! fault extras, and the per-transaction chances of `faults/<name>.json`.

use serde::Deserialize;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum Protocol {
    /// Lease blocks per basis, gate permits, the behavior journal and read checkpoints (origin/main 050254ab91).
    #[serde(rename = "lease-blocks-per-basis")]
    LeaseBlocks,
    /// One receipt in the domain's own transaction; a use envelope and an admission lease per book.
    #[serde(rename = "envelope-commit-receipts")]
    Envelope,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Params {
    pub most_commands: u32,
    pub grant_growth_window_ms: u64,
    pub block_age_ms: u64,
    pub forget_after_ms: u64,
    pub metered_use_interval_ms: u64,
    pub unexecuted_release_after_ms: u64,
    pub receipt_days: u64,
    pub idle_flush_ms: u64,
    pub generation_allowance_reads: u32,
    pub envelope_demand_times: f64,
    // Negative controls: each removes one rule of the floor design, so the oracles can be seen to catch its absence.
    /// A book that lost its memory begins work under a lease without asking the gate whether it still stands.
    pub skip_lease_confirm: bool,
    /// A policy drain closes a lease while work still runs under it.
    pub skip_drain_wait: bool,
    /// A generation holds unrecorded reads without registering.
    pub skip_registration: bool,
    /// The receipt is written in its own transaction after the domain's.
    pub receipt_after_commit: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Variant {
    pub id: String,
    pub protocol: Protocol,
    pub about: String,
    pub params: Params,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Extra {
    pub count: u64,
    pub chance: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RowsSpec {
    pub base: u64,
    pub extra: Vec<Extra>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Range {
    pub min: u64,
    pub max: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReadSpec {
    pub purpose: String,
    pub rows_read: Range,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PaidSpec {
    pub price: f64,
    pub fails: bool,
    #[serde(default)]
    pub refund_rows: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CommandSpec {
    pub operation: String,
    pub purpose: String,
    pub domain_rows: RowsSpec,
    pub derived_rows: RowsSpec,
    pub rows_read: Range,
    /// How long the command's own work runs between its begin and its commit.
    pub work_ms: Range,
    pub reads: Vec<ReadSpec>,
    #[serde(default)]
    pub paid: Option<PaidSpec>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReplaySpec {
    pub operation: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WorkloadSpec {
    pub id: String,
    pub source: String,
    pub commands: Vec<CommandSpec>,
    pub replays: Vec<ReplaySpec>,
    #[serde(default)]
    pub paid_ceiling_per_day: Option<f64>,
    /// A fixed schedule instead of the source's rate: the code probe's own shape, for calibration.
    #[serde(default)]
    pub schedule: Option<Schedule>,
}

/// `count` commands `every_ms` apart from `start_ms`; rows are measured over the commands after the first `warmup`.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Schedule {
    pub start_ms: u64,
    pub every_ms: u64,
    pub count: u64,
    pub warmup: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Prices {
    pub rows_read_dollars: f64,
    pub rows_written_dollars: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Workloads {
    pub prices: Prices,
    pub workloads: Vec<WorkloadSpec>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Client {
    pub attempts: u32,
    pub first_backoff_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProfileExtra {
    pub restarts_per_day: f64,
    pub policy_updates_per_day: f64,
    /// A client step that stalls before it is sent (a slow worker, a retry held in a queue): its chance and how long.
    #[serde(default)]
    pub client_stall: Option<Stall>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Stall {
    pub chance: f64,
    pub min_ms: u64,
    pub max_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PolicyUpdate {
    pub revoke_chance: f64,
    pub revoke_minutes: u64,
    pub ceiling_change_chance: f64,
    pub low_ceiling_per_day: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FaultExtras {
    pub client: Client,
    pub rpc_ms: Range,
    pub evict_idle_ms: Range,
    pub profiles: std::collections::BTreeMap<String, ProfileExtra>,
    pub policy_update: PolicyUpdate,
}

/// The per-transaction chances of a `faults/<name>.json` profile.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PerAttempt {
    pub crash_before_commit: f64,
    pub crash_after_commit: f64,
    pub interrupt_mid_statement: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct FaultFile {
    pub name: String,
    pub per_attempt: PerAttempt,
}

/// One workload as the run uses it: each command shape with its rate per day.
#[derive(Clone, Debug)]
pub struct Plan {
    pub id: String,
    pub commands: Vec<(CommandSpec, f64)>,
    pub replays_per_day: f64,
    pub paid_ceiling_per_day: Option<f64>,
    pub schedule: Option<Schedule>,
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// The rate of `operation` in a source workload file: its `per_day`.
pub fn per_day(source: &Path, operation: &str) -> Result<f64, String> {
    let file: serde_json::Value = read_json(source)?;
    file["operations"]
        .as_array()
        .and_then(|ops| ops.iter().find(|op| op["name"] == operation))
        .and_then(|op| op["per_day"].as_f64())
        .ok_or_else(|| format!("{}: no operation named {operation:?} with a per_day", source.display()))
}

impl WorkloadSpec {
    pub fn plan(&self, home: &Path) -> Result<Plan, String> {
        let source = home.join(&self.source);
        let commands = self
            .commands
            .iter()
            .map(|c| per_day(&source, &c.operation).map(|rate| (c.clone(), rate)))
            .collect::<Result<Vec<_>, _>>()?;
        let replays_per_day = self
            .replays
            .iter()
            .map(|r| per_day(&source, &r.operation))
            .sum::<Result<f64, _>>()?;
        Ok(Plan { id: self.id.clone(), commands, replays_per_day, paid_ceiling_per_day: self.paid_ceiling_per_day, schedule: self.schedule })
    }
}
