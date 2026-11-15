//! `usage-table`: what a team pays per month, by profile x team size x
//! provider, as a low–high range over seeds and fault profiles.
//!
//! ```text
//! usage-table --table usage/seat-month-table.json --profiles usage/profiles.json \
//!   --out <run folder> --jobs 6 --root provider_prices=<folder of local-cost-pricing.json>
//! ```
//!
//! The question, the pricing and the table are the engine's
//! (`workload_simulation::usage`); this binary only supplies Trillion's
//! candidates and DATA and runs the planned simulations. Each run is one
//! child process (the engine's fault injection is process-wide), saved as
//! `runs/<run id>--<identity>.json`, where the identity is a BLAKE3 of the
//! source that produces a run (this package's library, the parent crate and
//! the engine, the path dependencies in `Cargo.toml`, without the pricing and
//! table code that cannot change a run's meters), the child's run settings
//! and the run's workload, candidate and fault files. A run whose file exists
//! is reused, so an interrupted table resumes, and a new provider or a pricing
//! fix is priced from the runs already saved (`--price-only`).

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Child, Command, ExitCode},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use content_crypto::advanced::blake3;
use storage_sim::{
    candidates,
    files::{require_free, resolve, write_json, HOME},
};
use workload_simulation::{
    faults::FaultProfile,
    run,
    usage::{self, Profiles, Provider, RunKey, RunView, TableSpec},
    CostModel, RunConfig, SimError, StoreShape, Workload,
};

const USAGE: &str = "usage-table --table <spec.json> --profiles <profiles.json> --out <dir>
  [--jobs 4] [--max-load 80] [--root <name>=<dir> ...] [--price-only]";

struct Args {
    table: PathBuf,
    profiles: PathBuf,
    out: PathBuf,
    jobs: usize,
    /// A new run starts only while the 1-minute load average is below this
    /// (the Mac is shared with other work).
    max_load: f64,
    roots: BTreeMap<String, PathBuf>,
    price_only: bool,
    /// Internal: run exactly this key in this process and write `child_out`.
    child: Option<RunKey>,
    child_out: Option<PathBuf>,
}

fn parse() -> Result<Args, String> {
    let mut table = None;
    let mut profiles = None;
    let mut out = None;
    let mut a = Args {
        table: PathBuf::new(),
        profiles: PathBuf::new(),
        out: PathBuf::new(),
        jobs: 4,
        max_load: 80.0,
        roots: BTreeMap::new(),
        price_only: false,
        child: None,
        child_out: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--table" => table = Some(PathBuf::from(value()?)),
            "--profiles" => profiles = Some(PathBuf::from(value()?)),
            "--out" => out = Some(PathBuf::from(value()?)),
            "--jobs" => a.jobs = value()?.parse().map_err(|e| format!("--jobs: {e}"))?,
            "--max-load" => {
                a.max_load = value()?.parse().map_err(|e| format!("--max-load: {e}"))?
            }
            "--root" => {
                let v = value()?;
                let (name, dir) = v
                    .split_once('=')
                    .ok_or_else(|| format!("--root needs <name>=<dir>, got {v}"))?;
                a.roots.insert(name.to_owned(), PathBuf::from(dir));
            }
            "--price-only" => a.price_only = true,
            "--child" => {
                a.child = Some(serde_json::from_str(&value()?).map_err(|e| format!("--child: {e}"))?)
            }
            "--child-out" => a.child_out = Some(PathBuf::from(value()?)),
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown flag {other}\n{USAGE}")),
        }
    }
    a.table = table.ok_or_else(|| format!("--table is required\n{USAGE}"))?;
    a.profiles = profiles.ok_or_else(|| format!("--profiles is required\n{USAGE}"))?;
    a.out = out.ok_or_else(|| format!("--out is required\n{USAGE}"))?;
    if a.jobs == 0 {
        return Err("--jobs must be >= 1".into());
    }
    Ok(a)
}

fn main() -> ExitCode {
    match real_main() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("usage-table: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Everything the table names, loaded once.
struct Inputs {
    spec: TableSpec,
    profiles: Profiles,
    workloads: BTreeMap<String, Workload>,
}

fn inputs(args: &Args) -> Result<Inputs, SimError> {
    let spec: TableSpec = workload_simulation::load_json(&args.table)?;
    let profiles: Profiles = workload_simulation::load_json(&args.profiles)?;
    let mut workloads = BTreeMap::new();
    for p in &profiles.profiles {
        for m in &p.mix {
            if !workloads.contains_key(&m.workload) {
                let w = Workload::load(&resolve("workloads", &m.workload))?;
                workloads.insert(m.workload.clone(), w);
            }
        }
    }
    Ok(Inputs {
        spec,
        profiles,
        workloads,
    })
}

/// Source trees compiled into this binary (the path dependencies of
/// `Cargo.toml`, relative to this package).
const SOURCE_ROOTS: [&str; 3] = ["src", "../src", "../../architect/crates/workload-simulation/src"];
/// Files inside those trees that only price, tabulate or launch: they never
/// change a run's meters, so a fix to them keeps every saved run.
const NOT_IN_A_RUN: [&str; 5] = [
    "src/bin",
    "src/main.rs",
    "src/files.rs",
    "../../architect/crates/workload-simulation/src/usage.rs",
    "../../architect/crates/workload-simulation/src/shape.rs",
];
/// The child's run settings (see `run_child`), part of every run's identity.
const CHILD_SETTINGS: &str = "final_sample=512 cost_models=none seed_records=none";

/// `HOME` joined with `rel`, with `..` removed by text, not by the file
/// system: `HOME` may be a link, and Cargo resolved the path dependencies
/// from the link's own location, so the file system's `..` would name a
/// different tree than the one compiled.
fn lexical(rel: &str) -> PathBuf {
    let mut out = PathBuf::from(HOME);
    for part in Path::new(rel).components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// BLAKE3 over every file of the source trees, path and bytes, in order.
fn code_identity() -> Result<blake3::Hash, SimError> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for e in std::fs::read_dir(dir)? {
            let p = e?.path();
            if p.is_dir() {
                walk(&p, out)?;
            } else {
                out.push(p);
            }
        }
        Ok(())
    }
    let skip: Vec<PathBuf> = NOT_IN_A_RUN.iter().map(|p| lexical(p)).collect();
    let mut h = blake3::Hasher::new();
    h.update(CHILD_SETTINGS.as_bytes());
    for root in SOURCE_ROOTS {
        let base = lexical(root);
        let mut files = Vec::new();
        walk(&base, &mut files)?;
        files.retain(|f| !skip.iter().any(|s| f.starts_with(s)));
        files.sort();
        for f in files {
            h.update(root.as_bytes());
            h.update(f.strip_prefix(&base).unwrap_or(&f).to_string_lossy().as_bytes());
            h.update(&std::fs::read(&f)?);
        }
    }
    Ok(h.finalize())
}

/// BLAKE3 of the code and the run's DATA files: a saved run is reused only
/// when nothing that produced it has changed.
fn identity(code: &blake3::Hash, spec: &TableSpec, key: &RunKey) -> Result<String, SimError> {
    let mut h = blake3::Hasher::new();
    h.update(code.as_bytes());
    for path in [
        resolve("workloads", &key.workload),
        PathBuf::from(format!("{HOME}/candidates/{}.json", spec.candidate)),
        resolve("faults", &key.faults),
    ] {
        h.update(path.to_string_lossy().as_bytes());
        h.update(&std::fs::read(&path)?);
    }
    h.update(key.id().as_bytes());
    Ok(h.finalize().to_hex()[..16].to_owned())
}

fn physical_unix_ms() -> Result<u128, SimError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| SimError::Data(format!("physical clock before Unix epoch: {error}")))
}

fn git_revision() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn producer_source_revision() -> Result<blake3::Hash, SimError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/bin/usage_table.rs");
    let bytes = std::fs::read(path)?;
    let mut hash = blake3::Hasher::new();
    hash.update(b"storage-sim-usage-table-producer-source/v1\0");
    hash.update(&bytes);
    Ok(hash.finalize())
}

fn run_child(args: &Args, key: &RunKey) -> Result<(), SimError> {
    let out = args
        .child_out
        .as_ref()
        .ok_or_else(|| SimError::Data("--child needs --child-out".into()))?;
    let physical_started_at_unix_ms = physical_unix_ms()?;
    let source_revision = code_identity()?;
    let producer_source_revision = producer_source_revision()?;
    let inputs = inputs(args)?;
    let run_identity = identity(&source_revision, &inputs.spec, key)?;
    let candidate = candidates::load(
        &PathBuf::from(format!("{HOME}/candidates")),
        &inputs.spec.candidate,
    )?;
    let workload = inputs
        .workloads
        .get(&key.workload)
        .ok_or_else(|| SimError::Data(format!("workload {} is in no profile", key.workload)))?;
    let work = out.with_extension("work");
    // A child outlives a runner that is killed, so its scratch is claimed by
    // its own process id, beside it (the engine owns the folder's contents).
    let claim = out.with_extension(CLAIM);
    std::fs::write(&claim, format!("{}\n", std::process::id()))?;
    let cfg = RunConfig {
        seed: key.seed,
        days: key.days,
        rate_scale: key.rate_scale,
        faults: FaultProfile::load(&resolve("faults", &key.faults))?,
        // Pricing happens later, per provider, from the saved meters.
        cost_models: Vec::new(),
        work_dir: work.clone(),
        seed_records: Vec::new(),
        final_sample: 512,
    };
    let result = run(candidate.as_ref(), workload, &cfg);
    if work.exists() {
        std::fs::remove_dir_all(&work)?;
    }
    std::fs::remove_file(&claim)?;
    let (result, _wall) = result?;
    let physical_finished_at_unix_ms = physical_unix_ms()?;
    let mut report = serde_json::to_value(result).map_err(|error| SimError::Data(error.to_string()))?;
    report
        .as_object_mut()
        .ok_or_else(|| SimError::Data("run result must serialize as an object".into()))?
        .insert(
            "execution".into(),
            serde_json::json!({
                "producer": "storage-sim usage-table run_child",
                "producer_git_revision": git_revision(),
                "producer_source_revision": {
                    "algorithm": "BLAKE3",
                    "digest": producer_source_revision.to_hex().to_string()
                },
                "simulation_source_revision": {
                    "algorithm": "BLAKE3",
                    "digest": source_revision.to_hex().to_string()
                },
                "run_identity": {
                    "algorithm": "BLAKE3",
                    "digest": run_identity
                },
                "physical_started_at_unix_ms": physical_started_at_unix_ms,
                "physical_finished_at_unix_ms": physical_finished_at_unix_ms,
                "physical_time_unit": "milliseconds since Unix epoch",
                "simulated_window": {
                    "first_day": 1,
                    "last_day_inclusive": key.days,
                    "unit": "simulated_day"
                }
            }),
        );
    write_json(out, &report)
}

fn providers(args: &Args, spec: &TableSpec) -> Result<Vec<Provider>, SimError> {
    spec.providers
        .iter()
        .map(|p| {
            Ok(Provider {
                name: p.name.clone(),
                model: CostModel::load(&resolve("cost-models", &p.cost_model), &args.roots)?,
                shape: p
                    .shape
                    .as_ref()
                    .map(|s| StoreShape::load(&resolve("shapes", s)))
                    .transpose()?,
            })
        })
        .collect()
}

fn real_main() -> Result<(), SimError> {
    let args = parse().map_err(SimError::Data)?;
    if let Some(key) = &args.child {
        return run_child(&args, key);
    }
    let inputs = inputs(&args)?;
    // Load every provider before any simulation, so a bad price stops early.
    let providers = providers(&args, &inputs.spec)?;
    let keys = usage::plan(&inputs.spec, &inputs.profiles, &inputs.workloads)?;
    let runs_dir = args.out.join("runs");
    std::fs::create_dir_all(&runs_dir)?;
    let _lock = OutLock::take(&args.out)?;
    remove_abandoned_work(&runs_dir)?;
    let exe_path = std::env::current_exe()?;
    let code = code_identity()?;
    let mut files = BTreeMap::new();
    for k in &keys {
        let name = format!("{}--{}.json", k.id(), identity(&code, &inputs.spec, k)?);
        files.insert(k.id(), runs_dir.join(name));
    }
    let mut missing: Vec<&RunKey> = keys.iter().filter(|k| !files[&k.id()].exists()).collect();
    // Cheapest first: most of the table is saved early, the largest runs last.
    let size = |k: &RunKey| {
        inputs.workloads[&k.workload].expected_requests_per_day(k.rate_scale) * f64::from(k.days)
    };
    missing.sort_by(|a, b| size(a).total_cmp(&size(b)).then_with(|| a.id().cmp(&b.id())));
    eprintln!(
        "usage-table: {} runs planned, {} saved, {} to simulate",
        keys.len(),
        keys.len() - missing.len(),
        missing.len()
    );
    if !missing.is_empty() {
        if args.price_only {
            return Err(SimError::Data(format!(
                "--price-only, but {} planned runs are not saved (first: {})",
                missing.len(),
                missing[0].id()
            )));
        }
        simulate(&args, &exe_path, &missing, &files)?;
    }
    let mut runs = BTreeMap::new();
    for k in &keys {
        let view: RunView = workload_simulation::load_json(&files[&k.id()])?;
        runs.insert(k.id(), view);
    }
    let table = usage::build_table(
        &inputs.spec,
        &inputs.profiles,
        &inputs.workloads,
        &providers,
        &runs,
    )?;
    let json = args.out.join("usage-table.json");
    write_json(&json, &table)?;
    let md = usage::render_markdown(&table);
    std::fs::write(args.out.join("usage-table.md"), &md)?;
    print!("{md}");
    eprintln!("usage-table: wrote {} and usage-table.md", json.display());
    Ok(())
}

/// One runner per `--out` folder: `runner.lock` holds the runner's process
/// id and is removed when the runner ends. A lock whose process is gone is
/// taken over.
struct OutLock(PathBuf);

impl OutLock {
    fn take(out: &Path) -> Result<Self, SimError> {
        let path = out.join("runner.lock");
        if let Some(pid) = live_owner(&path) {
            return Err(SimError::Data(format!(
                "{} is used by runner process {pid}",
                out.display()
            )));
        }
        std::fs::write(&path, format!("{}\n", std::process::id()))?;
        Ok(Self(path))
    }
}

impl Drop for OutLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Extension of the file beside `<run>.work` that names the child process
/// using that scratch.
const CLAIM: &str = "claim";

/// The process named in `path`, when that process is still running.
fn live_owner(path: &Path) -> Option<i32> {
    let pid: i32 = std::fs::read_to_string(path).ok()?.trim().parse().ok()?;
    // SAFETY: signal 0 sends nothing; it only checks that the process exists.
    (pid > 0 && unsafe { libc::kill(pid, 0) } == 0).then_some(pid)
}

/// A `<run>.work` folder is the scratch of one run. A child of a killed
/// runner keeps running and keeps its claim; this runner would start the
/// same run on the same scratch, so it refuses until that child ends.
/// Scratch with no live claim is from a run that ended without writing its
/// result and is removed, with its claim.
fn remove_abandoned_work(runs: &Path) -> Result<(), SimError> {
    for e in std::fs::read_dir(runs)? {
        let p = e?.path();
        // Removing a scratch folder also removes its claim, which this
        // listing may still name.
        if !p.exists() {
            continue;
        }
        // A claim whose child was killed before its scratch was made.
        if p.extension().is_some_and(|x| x == CLAIM)
            && !p.with_extension("work").exists()
            && live_owner(&p).is_none()
        {
            std::fs::remove_file(&p)?;
            continue;
        }
        if !(p.is_dir() && p.extension().is_some_and(|x| x == "work")) {
            continue;
        }
        let claim = p.with_extension(CLAIM);
        if let Some(pid) = live_owner(&claim) {
            return Err(SimError::Data(format!(
                "{} is still being run by process {pid}, a child of an earlier runner; \
                 start again when it ends (its result is then reused)",
                p.display()
            )));
        }
        std::fs::remove_dir_all(&p)?;
        if claim.exists() {
            std::fs::remove_file(&claim)?;
        }
        eprintln!("usage-table: removed abandoned scratch {}", p.display());
    }
    Ok(())
}

/// The 1-minute load average (0 when it cannot be read, so work proceeds).
fn load_average() -> f64 {
    let mut l = [0.0f64; 3];
    // SAFETY: `l` has room for the 3 samples requested.
    let n = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    if n >= 1 {
        l[0]
    } else {
        0.0
    }
}

/// Run the missing keys, at most `jobs` child processes at once, and a new
/// one only while the machine's load is under `max_load` (one always runs).
fn simulate(
    args: &Args,
    exe: &Path,
    missing: &[&RunKey],
    files: &BTreeMap<String, PathBuf>,
) -> Result<(), SimError> {
    let mut queue: Vec<&RunKey> = missing.iter().rev().copied().collect();
    let mut live: Vec<(Child, String, Instant)> = Vec::new();
    let mut failed = Vec::new();
    let total = missing.len();
    let mut finished = 0;
    while !queue.is_empty() || !live.is_empty() {
        while live.len() < args.jobs && (live.is_empty() || load_average() < args.max_load) {
            let Some(key) = queue.pop() else { break };
            require_free(&args.out)?;
            let mut cmd = Command::new(exe);
            cmd.arg("--table")
                .arg(&args.table)
                .arg("--profiles")
                .arg(&args.profiles)
                .arg("--out")
                .arg(&args.out)
                .arg("--child")
                .arg(serde_json::to_string(key).map_err(|e| SimError::Data(e.to_string()))?)
                .arg("--child-out")
                .arg(&files[&key.id()]);
            live.push((cmd.spawn()?, key.id(), Instant::now()));
        }
        std::thread::sleep(Duration::from_millis(200));
        let mut still = Vec::new();
        for (mut child, id, started) in live {
            match child.try_wait()? {
                None => still.push((child, id, started)),
                Some(status) => {
                    finished += 1;
                    eprintln!(
                        "usage-table: [{finished}/{total}] {id} {} in {:.0} s",
                        if status.success() { "done" } else { "FAILED" },
                        started.elapsed().as_secs_f64()
                    );
                    if !status.success() {
                        failed.push(id);
                    }
                }
            }
        }
        live = still;
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(SimError::Data(format!(
            "{} runs failed (the table needs every run): {}",
            failed.len(),
            failed.join(", ")
        )))
    }
}
