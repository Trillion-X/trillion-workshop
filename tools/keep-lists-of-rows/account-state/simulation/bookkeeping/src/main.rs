//! `command-bookkeeping`: the durable writes around one command, simulated under faults, with oracles for money,
//! authority and acknowledged answers. Runs each variant over each workload, fault profile, seed and eviction setting,
//! prints rows written per command beside the oracles, and writes every report to `--out`.
//!
//! Two computational models are its protocols (`variants/*.json` picks one and its parameters): lease blocks per basis
//! as origin/main 050254ab91 keeps them, and the floor design. Workload rates come from `../workloads/*.json`, fault
//! chances from `../faults/*.json`; `faults.json` here adds eviction, restarts and policy updates.

mod data;
mod driver;
mod envelope;
mod lease_blocks;
mod quota;
mod report;
mod store;
mod world;

use data::{read_json, FaultExtras, FaultFile, Variant, Workloads};
use std::path::{Path, PathBuf};
use world::{Run, World};

/// This package's folder (its DATA); the storage simulator's folder above it holds the workloads and fault profiles.
const HERE: &str = env!("CARGO_MANIFEST_DIR");

struct Args {
    variants: Vec<String>,
    workloads: Vec<String>,
    faults: Vec<String>,
    days: u64,
    seeds: Vec<u64>,
    evict: Vec<bool>,
    out: Option<PathBuf>,
}

fn args() -> Result<Args, String> {
    let mut a = Args { variants: vec!["main-050254ab91".into(), "floor".into()], workloads: vec!["u18".into(), "u22".into(), "u32".into()],
        faults: vec!["none".into(), "light".into(), "heavy".into()], days: 30, seeds: vec![42], evict: vec![true], out: None };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{flag} needs a value"));
        let list = |v: String| v.split(',').map(str::to_owned).collect::<Vec<_>>();
        match flag.as_str() {
            "--variants" => a.variants = list(value()?),
            "--workloads" => a.workloads = list(value()?),
            "--faults" => a.faults = list(value()?),
            "--days" => a.days = value()?.parse().map_err(|e| format!("--days: {e}"))?,
            "--seeds" => a.seeds = value()?.split(',').map(|s| s.parse().map_err(|e| format!("--seeds: {e}"))).collect::<Result<_, _>>()?,
            "--evict" => a.evict = value()?.split(',').map(|v| v != "off").collect(),
            "--out" => a.out = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(a)
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let part = path.with_extension("json.part");
    std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(part, path).map_err(|e| e.to_string())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("command-bookkeeping: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let a = args()?;
    let here = Path::new(HERE);
    let home = here.parent().ok_or("this package lives inside the storage simulator's folder")?;
    let shapes: Workloads = read_json(&here.join("workloads.json"))?;
    let extras: FaultExtras = read_json(&here.join("faults.json"))?;
    let mut reports = Vec::new();
    println!("{:<16} {:<5} {:<6} {:>5} {:>5} {:>8} {:>8} {:>8} {:>7} {:>6} {:>7} {:>6} {:>6} {:>6} {:>7} {:>6}",
        "variant", "work", "faults", "seed", "evict", "commands", "bookkeep", "+derived", "prune", "money", "auth", "lost", "unknwn", "refusd", "updates", "waits");
    for variant_id in &a.variants {
        let variant: Variant = read_json(&here.join("variants").join(format!("{variant_id}.json")))?;
        for workload in &a.workloads {
            let spec = shapes.workloads.iter().find(|w| &w.id == workload).ok_or_else(|| format!("no workload {workload}"))?;
            let plan = spec.plan(home)?;
            for fault in &a.faults {
                let file: FaultFile = read_json(&home.join("faults").join(format!("{fault}.json")))?;
                for (&seed, &evict) in a.seeds.iter().flat_map(|s| a.evict.iter().map(move |e| (s, e))) {
                    let mut world = World::new(variant.clone(), plan.clone(), shapes.prices.clone(), extras.clone(),
                        (file.name.clone(), file.per_attempt.clone()), Run { days: a.days, seed, evict });
                    world.run();
                    let r = world.report(a.days, seed);
                    println!("{:<16} {:<5} {:<6} {:>5} {:>5} {:>8} {:>8.3} {:>8.3} {:>7.3} {:>6} {:>7} {:>6} {:>6} {:>6} {:>7} {:>6}",
                        r.variant, r.workload, r.faults, seed, if evict { "on" } else { "off" }, r.commands, r.bookkeeping_per_command,
                        r.bookkeeping_per_command + r.derived_per_command, r.prune_per_command, r.money.discrepancies(), r.authority_violations,
                        r.lost_acks, r.unknown, r.refused.values().sum::<u64>(), r.updates_finished, r.drain_waits);
                    reports.push(r);
                }
            }
        }
    }
    if let Some(out) = a.out {
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        write_json(&out.join("command-bookkeeping.json"), &reports)?;
    }
    Ok(())
}
