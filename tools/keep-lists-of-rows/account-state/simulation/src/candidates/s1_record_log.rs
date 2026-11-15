//! S1 (plan 03, "repaired record-log"): the same `RecordLog` + `kept_runs`
//! store as S0, one per resource, with background work moved into writes
//! (layer O6). It has no alarm at all: its params have no `alarm` field, so a
//! wake cannot be configured. The memtable is published when it fills inside
//! a write, and every write that adds bytes takes one bounded merge step
//! (`KeptRuns::maintain`), so the run count stays bounded with 0 wakes.
//!
//! Params (`candidates/s1-*.json`), each optional, overriding
//! `kept_runs::Settings` (plan 03 sweeps the merge fan-in):
//! `memtable_bytes`, `fan_in`, `merge_backlog_runs`, `merge_pace`.
//!
//! Not built here: the maintained canonical head (F6 integrated reader) and
//! the checksum steps that plan 03 also lists for S1.

use local_engine::kept_runs::Settings;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use workload_simulation::{Candidate, Capability, Opened, StoreContext, StoreError};

use super::s0_record_log;
use crate::meter::err;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memtable_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fan_in: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_backlog_runs: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_pace: Option<usize>,
}

pub struct S1 {
    id: String,
    params: Params,
    settings: Settings,
}

impl S1 {
    pub fn new(id: String, params: Value) -> Result<Self, StoreError> {
        let params: Params = serde_json::from_value(params).map_err(err)?;
        let d = Settings::default();
        let settings = Settings {
            memtable_bytes: params.memtable_bytes.unwrap_or(d.memtable_bytes),
            fan_in: params.fan_in.unwrap_or(d.fan_in),
            merge_backlog_runs: params.merge_backlog_runs.unwrap_or(d.merge_backlog_runs),
            merge_pace: params.merge_pace.unwrap_or(d.merge_pace),
            ..d
        };
        Ok(Self {
            id,
            params,
            settings,
        })
    }
}

impl Candidate for S1 {
    fn id(&self) -> &str {
        &self.id
    }
    fn about(&self) -> String {
        "S1 record layer: record_log::RecordLog + kept_runs of the parent crate, one store per resource, no alarm; flush when full and merge steps inside writes"
            .into()
    }
    fn meters(&self) -> Vec<&'static str> {
        s0_record_log::meters()
    }
    fn capabilities(&self) -> Vec<Capability> {
        s0_record_log::capabilities()
    }
    fn params(&self) -> Value {
        serde_json::to_value(&self.params).unwrap_or(Value::Null)
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        s0_record_log::open(self.settings.clone(), None, ctx)
    }
}
