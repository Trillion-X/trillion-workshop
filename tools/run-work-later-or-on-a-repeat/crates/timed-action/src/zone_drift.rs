//! crates/timed-action/src/zone_drift.rs
//!
//! Purpose
//!   Whether the zone a device now shows differs from the zone a person plans in, and whether to ask about it. Pure.
//!   This is the Rust reading of do-work/zone-drift.ts.
//!
//! Non-negotiable invariants
//!   1. The planning zone and the device's display zone are two facts; a difference is never fixed silently.
//!   2. A newly detected zone is asked about once: a zone already asked about is not asked again.
//!   3. An unknown zone name on either side is refused (TypeError), never read as UTC.

use serde_json::Value;

use crate::js::{self, Refused, Res};
use crate::wall_time;

/// `zoneDrift(planningZone, deviceZone, askedZones = [])`.
pub fn zone_drift(planning: &Value, device: &Value, asked: Option<&Value>) -> Res<Value> {
    let planning_zone = wall_time::time_zone_name(planning);
    let device_zone = wall_time::time_zone_name(device);
    let (Some(planning_zone), Some(device_zone)) = (planning_zone, device_zone) else {
        return Err(Refused::type_error("Both zones must be time zones like America/New_York."));
    };
    let asked_items: Vec<Value> = match asked {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(Value::Null) => {
            return Err(Refused::type_error("Cannot read properties of null (reading 'map')"));
        }
        Some(_) => return Err(Refused::type_error("askedZones.map is not a function")),
    };
    let asked_names: Vec<String> = asked_items.iter().filter_map(wall_time::time_zone_name).collect();
    let drifted = planning_zone != device_zone;
    let ask = drifted && !asked_names.contains(&device_zone);
    Ok(js::object(vec![
        ("planning_zone", Value::from(planning_zone)),
        ("device_zone", Value::from(device_zone)),
        ("drifted", Value::Bool(drifted)),
        ("ask", Value::Bool(ask)),
    ]))
}
