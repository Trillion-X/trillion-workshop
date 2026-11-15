//! `storage-sim`: simulate Trillion storage candidates N days forward.
//!
//! ```text
//! cargo run --release -- --candidates s0-record-log,s2-log-current,s5-versioned-row \
//!   --days 30 --seed 42 --faults light --out <run folder>
//! ```
//!
//! Run from this folder (inside the parent crate) so the parent's
//! `.cargo/config.toml` builds SQLite with SQLITE_ENABLE_STMT_SCANSTATUS
//! (the work meter refuses to run without it).

use storage_sim::{
    candidates,
    files::{require_free, resolve, write_json, HOME},
    real_seed,
};

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::ExitCode,
};
use workload_simulation::{
    report::{CandidateHeader, FailedRun, RunHeader, SeedSource, WorkloadHeader, FORMAT},
    run, CostModel, FaultProfile, RunConfig, SimError, SimulationResult, Workload,
};


struct Args {
    workloads: Vec<String>,
    candidates: Vec<String>,
    days: u32,
    seed: u64,
    faults: String,
    cost_models: Vec<String>,
    roots: BTreeMap<String, PathBuf>,
    rate_scale: f64,
    seed_from: Option<PathBuf>,
    seed_limit: usize,
    final_sample: usize,
    out: Option<PathBuf>,
    keep_work: bool,
    list: bool,
}

const USAGE: &str = "storage-sim --out <dir> [--workloads a,b|all] [--candidates x,y|all] [--days 30] [--seed 42]
  [--faults none|light|heavy|<path>] [--cost-models <path>,<path>] [--root <name>=<dir> ...] [--rate-scale 1.0]
  [--seed-from <dir of cloned *.sqlite>] [--seed-limit 20000] [--final-sample 512] [--keep-work] [--list]";

fn parse() -> Result<Args, String> {
    let mut a = Args {
        workloads: vec!["all".into()],
        candidates: vec!["all".into()],
        days: 30,
        seed: 42,
        faults: "light".into(),
        cost_models: vec![
            format!("{HOME}/cost-models/cloudflare-do-sqlite.json"),
            format!("{HOME}/cost-models/mac-local-sqlite.json"),
        ],
        roots: BTreeMap::new(),
        rate_scale: 1.0,
        seed_from: None,
        seed_limit: 20_000,
        final_sample: 512,
        out: None,
        keep_work: false,
        list: false,
    };
    let mut it = std::env::args().skip(1);
    let list = |v: String| {
        v.split(',')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect::<Vec<_>>()
    };
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--workloads" => a.workloads = list(value()?),
            "--candidates" => a.candidates = list(value()?),
            "--days" => a.days = value()?.parse().map_err(|e| format!("--days: {e}"))?,
            "--seed" => a.seed = value()?.parse().map_err(|e| format!("--seed: {e}"))?,
            "--faults" => a.faults = value()?,
            "--cost-models" => a.cost_models = list(value()?),
            "--root" => {
                let v = value()?;
                let (name, dir) = v
                    .split_once('=')
                    .ok_or_else(|| format!("--root needs <name>=<dir>, got {v}"))?;
                a.roots.insert(name.to_owned(), PathBuf::from(dir));
            }
            "--rate-scale" => {
                a.rate_scale = value()?.parse().map_err(|e| format!("--rate-scale: {e}"))?
            }
            "--seed-from" => a.seed_from = Some(PathBuf::from(value()?)),
            "--seed-limit" => {
                a.seed_limit = value()?.parse().map_err(|e| format!("--seed-limit: {e}"))?
            }
            "--final-sample" => {
                a.final_sample = value()?
                    .parse()
                    .map_err(|e| format!("--final-sample: {e}"))?
            }
            "--out" => a.out = Some(PathBuf::from(value()?)),
            "--keep-work" => a.keep_work = true,
            "--list" => a.list = true,
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown flag {other}\n{USAGE}")),
        }
    }
    if a.days == 0 || !(a.rate_scale > 0.0 && a.rate_scale.is_finite()) {
        return Err("--days must be >= 1 and --rate-scale > 0".into());
    }
    Ok(a)
}

fn names(dir: &str, wanted: &[String]) -> Result<Vec<String>, SimError> {
    if wanted != ["all"] {
        return Ok(wanted.to_vec());
    }
    let mut out: Vec<String> = std::fs::read_dir(format!("{HOME}/{dir}"))?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension()? != "json" {
                return None;
            }
            Some(p.file_stem()?.to_string_lossy().into_owned())
        })
        .collect();
    out.sort();
    Ok(out)
}

fn main() -> ExitCode {
    match real_main() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("storage-sim: {e}");
            ExitCode::FAILURE
        }
    }
}

fn real_main() -> Result<(), SimError> {
    let args = parse().map_err(SimError::Data)?;
    let workload_names = names("workloads", &args.workloads)?;
    let candidate_names = names("candidates", &args.candidates)?;
    if args.list {
        println!("workloads: {}", workload_names.join(", "));
        println!("candidates: {}", candidate_names.join(", "));
        return Ok(());
    }
    let out = args
        .out
        .clone()
        .ok_or_else(|| SimError::Data(format!("--out is required\n{USAGE}")))?;
    std::fs::create_dir_all(out.join("runs"))?;
    require_free(&out)?;
    let workloads = workload_names
        .iter()
        .map(|n| Workload::load(&resolve("workloads", n)))
        .collect::<Result<Vec<_>, _>>()?;
    let cands = candidate_names
        .iter()
        .map(|n| candidates::load(&PathBuf::from(format!("{HOME}/candidates")), n))
        .collect::<Result<Vec<_>, _>>()?;
    let faults = FaultProfile::load(&resolve("faults", &args.faults))?;
    let cost_models = args
        .cost_models
        .iter()
        .map(|p| CostModel::load(Path::new(p), &args.roots))
        .collect::<Result<Vec<_>, _>>()?;
    let (seed_records, seed_source) = match &args.seed_from {
        Some(dir) => real_seed::load(dir, args.seed_limit)?,
        None => (
            Vec::new(),
            SeedSource {
                kind: "synthetic".into(),
                records: 0,
                detail: serde_json::Value::Null,
            },
        ),
    };
    let cfg = RunConfig {
        seed: args.seed,
        days: args.days,
        rate_scale: args.rate_scale,
        faults: faults.clone(),
        cost_models: cost_models.clone(),
        work_dir: out.join("work"),
        seed_records,
        final_sample: args.final_sample,
    };
    let mut results = Vec::new();
    let mut failed = Vec::new();
    let mut walls = Vec::new();
    for w in &workloads {
        for c in &cands {
            eprintln!("storage-sim: {} / {} ({} days)", c.id(), w.name, args.days);
            match run(c.as_ref(), w, &cfg) {
                Ok((result, wall)) => {
                    write_json(
                        &out.join("runs")
                            .join(format!("{}--{}.json", c.id(), w.name)),
                        &result,
                    )?;
                    results.push(result);
                    walls.push(wall);
                }
                Err(e) => failed.push(FailedRun {
                    candidate: c.id().into(),
                    workload: w.name.clone(),
                    error: e.to_string(),
                }),
            }
            if !args.keep_work {
                let dir = cfg.work_dir.join(c.id()).join(&w.name);
                if dir.exists() {
                    std::fs::remove_dir_all(dir)?;
                }
            }
        }
    }
    let sim = SimulationResult {
        format: FORMAT,
        run: RunHeader {
            seed: args.seed,
            days: args.days,
            rate_scale: args.rate_scale,
            faults,
            cost_models,
            seed_source,
            candidates: cands
                .iter()
                .map(|c| CandidateHeader {
                    id: c.id().into(),
                    about: c.about(),
                    params: c.params(),
                    meters: c.meters().into_iter().map(String::from).collect(),
                    meter_definitions: c.meter_definitions(),
                    capabilities: c.capabilities(),
                })
                .collect(),
            workloads: workloads
                .iter()
                .map(|w| WorkloadHeader {
                    name: w.name.clone(),
                    plan_ids: w.plan_ids.clone(),
                    about: w.about.clone(),
                    stores: w.stores,
                })
                .collect(),
        },
        results,
        failed_runs: failed,
    };
    write_json(&out.join("result.json"), &sim)?;
    write_json(&out.join("wall-clock.json"), &walls)?;
    let table = workload_simulation::render_table(&sim);
    std::fs::write(out.join("table.txt"), &table)?;
    print!("{table}");
    eprintln!(
        "storage-sim: wrote {} (deterministic), table.txt, wall-clock.json (measured, not deterministic), runs/",
        out.join("result.json").display()
    );
    Ok(())
}
