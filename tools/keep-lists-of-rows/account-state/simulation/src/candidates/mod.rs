//! Candidate adapters and their DATA definitions.
//!
//! A candidate run = one adapter (Rust, this folder) + one params block
//! (`simulation/candidates/<id>.json`). Variants of one design are params
//! files, never new code. See `simulation/README.md` "Add a candidate".

pub mod kit;
pub mod layout;
pub mod log;
pub mod receipts;
pub mod s0_record_log;
pub mod s1_record_log;
pub mod s2_log_current;
pub mod s2h_history_on_replace;
pub mod s3_tiered;
pub mod s4_typed_tables;
pub mod s5_versioned_row;
pub mod search;
pub mod product_s2h;

use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use workload_simulation::{
    candidate::MeterDefinition, Candidate, Capability, Opened, SimError, StoreContext, StoreError,
};

pub const FORMAT: &str = "storage-sim-candidate/1";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Adapter {
    S0RecordLog,
    S1RecordLog,
    S2LogCurrent,
    S2hHistoryOnReplace,
    S3Tiered,
    S4TypedTables,
    S5VersionedRow,
    ProductS2h,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub format: String,
    pub id: String,
    /// Survivor id in plan 03 (S0, S0+O, S1..S5).
    pub plan_id: String,
    pub about: String,
    pub adapter: Adapter,
    pub params: Value,
}

pub fn load(dir: &Path, id: &str) -> Result<Box<dyn Candidate>, SimError> {
    let path = dir.join(format!("{id}.json"));
    let def: Definition = workload_simulation::load_json(&path)?;
    if def.format != FORMAT || def.id != id {
        return Err(SimError::Data(format!(
            "{}: needs format {FORMAT} and id {id}",
            path.display()
        )));
    }
    let wrap = |e: StoreError| SimError::Data(format!("{}: {e}", path.display()));
    let inner: Box<dyn Candidate> = match def.adapter {
        Adapter::ProductS2h => Box::new(product_s2h::ProductS2h::new(def.id, def.params).map_err(wrap)?),
        Adapter::S0RecordLog => Box::new(s0_record_log::S0::new(def.id, def.params).map_err(wrap)?),
        Adapter::S1RecordLog => Box::new(s1_record_log::S1::new(def.id, def.params).map_err(wrap)?),
        Adapter::S2LogCurrent => {
            Box::new(s2_log_current::S2::new(def.id, def.params).map_err(wrap)?)
        }
        Adapter::S2hHistoryOnReplace => {
            Box::new(s2h_history_on_replace::S2h::new(def.id, def.params).map_err(wrap)?)
        }
        Adapter::S3Tiered => Box::new(s3_tiered::S3::new(def.id, def.params).map_err(wrap)?),
        Adapter::S4TypedTables => {
            Box::new(s4_typed_tables::S4::new(def.id, def.params).map_err(wrap)?)
        }
        Adapter::S5VersionedRow => {
            Box::new(s5_versioned_row::S5::new(def.id, def.params).map_err(wrap)?)
        }
    };
    let about = format!(
        "{} — {} [adapter: {}]",
        def.plan_id,
        def.about,
        inner.about()
    );
    Ok(Box::new(Defined { inner, about }))
}

/// A DATA-defined candidate: the adapter plus its plan id and description.
struct Defined {
    inner: Box<dyn Candidate>,
    about: String,
}

impl Candidate for Defined {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn about(&self) -> String {
        self.about.clone()
    }
    fn meters(&self) -> Vec<&'static str> {
        self.inner.meters()
    }
    fn meter_definitions(&self) -> Vec<MeterDefinition> {
        self.inner.meter_definitions()
    }
    fn capabilities(&self) -> Vec<Capability> {
        self.inner.capabilities()
    }
    fn params(&self) -> Value {
        self.inner.params()
    }
    fn open(&self, ctx: StoreContext) -> Result<Opened, StoreError> {
        self.inner.open(ctx)
    }
}
