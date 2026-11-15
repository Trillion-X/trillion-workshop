// examples/account_files_carry.rs
//
// Purpose: The record-free half of emptying one store into another, run on a machine with a fast link (a short-lived
// cloud server): it reads, on stdin, `account_files_move remote-setup` (line 1: both stores' facts and SigV4 day keys, the
// budget; then the work list) and carries every key with `account_files::moves::carry_keys`, or, when line 1 says `pack`,
// packs the keys into archives with manifests per group (`account_files::moves::pack_keys`), writing one proof line per
// proved key to stdout. The Mac writes those proofs as records with `account_files_move import-proofs`, and its own `run`
// then only rewrites records.
// Invariants: a key is proved by its upload checksum and never read back: its BLAKE3 is computed while it streams from
// the source (and checked against its identity when it names one), its SHA-256 is signed into the PUT so the
// destination refuses any other body, and one HEAD finds it at its length; the budget on line 1 is a hard stop; nothing is deleted; nothing is written to disk here: the
// day keys live only in this process's memory and stdout carries proofs (keys, sizes, hashes) only.
// Key concepts: `account_files::moves::{carry_keys, pack_keys, pack_plan, Carry, Proved}`, `account_files::objects::{S3Objects, Secrets}`.
// Security: the store secrets never reach this machine; only day keys valid for two UTC days do. Progress and the final
// report on stderr hold counts only: failures are counted by reason, never listed by key (the store may hold other
// people's keys).
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: (account_files_move ... remote-setup LIST; cat LIST) | ssh <server> account_files_carry > proofs.jsonl
// Exit: 0 every key proved; 1 some keys failed (run again with a new work list); 2 the budget stopped the run.

use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap},
    io::{BufRead, Write},
    time::{Duration, Instant},
};
use trillion_local::account_files::{
    moves::{self, carry_keys, pack_keys, pack_plan, Budget, Carry, Proved, Route},
    objects::{Secrets, ObjectError, Origin, S3Objects},
};
use zeroize::Zeroizing;

type Failure = Box<dyn std::error::Error>;

/// How often progress goes to stderr.
const PROGRESS_EVERY: Duration = Duration::from_secs(60);

/// Line 1 of the input.
#[derive(Deserialize)]
struct Setup {
    from: String,
    to: String,
    concurrency: usize,
    /// Pack the work list into archives with manifests instead of carrying each key under its own key.
    #[serde(default)]
    pack: bool,
    budget: Budget,
    origins: Vec<(String, Origin)>,
    plain: HashMap<String, String>,
    day_keys: HashMap<String, HashMap<String, String>>,
}

/// The values line 1 carried, held in memory only, answered the way the secrets vault answers.
struct Carried {
    plain: HashMap<String, Zeroizing<String>>,
    day_keys: HashMap<String, HashMap<String, Zeroizing<Vec<u8>>>>,
}
impl Secrets for Carried {
    fn plain(&self, name: &str) -> Result<Zeroizing<String>, ObjectError> {
        self.plain.get(name).cloned().ok_or_else(|| ObjectError::NotHeld(name.into(), trillion_local::cause!()))
    }
    fn sigv4_day_key(&self, name: &str, day: &str) -> Result<Zeroizing<Vec<u8>>, ObjectError> {
        self.day_keys.get(name).and_then(|days| days.get(day)).cloned().ok_or_else(|| ObjectError::NotHeld(format!("{name} for {day}"), trillion_local::cause!()))
    }
    fn holds(&self, name: &str) -> Result<bool, ObjectError> {
        Ok(self.plain.contains_key(name) || self.day_keys.contains_key(name))
    }
}

fn unhex(text: &str) -> Result<Vec<u8>, Failure> {
    (0..text.len()).step_by(2).map(|at| Ok(u8::from_str_radix(text.get(at..at + 2).ok_or("odd hex")?, 16)?)).collect()
}

fn run() -> Result<i32, Failure> {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let setup: Setup = serde_json::from_str(&Zeroizing::new(lines.next().ok_or("no setup line")??))?;
    let mut day_keys = HashMap::new();
    for (name, days) in setup.day_keys {
        let mut held = HashMap::new();
        for (day, key) in days {
            held.insert(day, Zeroizing::new(unhex(&key)?));
        }
        day_keys.insert(name, held);
    }
    let vault = Carried { plain: setup.plain.into_iter().map(|(name, value)| (name, Zeroizing::new(value))).collect(), day_keys };
    let objects = S3Objects::unmetered(setup.origins, Box::new(vault), "operator example account_files_carry")?;
    for origin in [&setup.from, &setup.to] {
        if !objects.has_credentials(origin)? {
            return Err(format!("the setup line does not reach {origin}").into());
        }
    }
    let keys = lines.map(|line| Ok(serde_json::from_str::<Carry>(&line?)?)).collect::<Result<Vec<_>, Failure>>()?;
    let (total, total_bytes) = (keys.len(), keys.iter().map(|key| key.length).sum::<u64>());
    eprintln!("{}", json!({ "carry": total, "bytes": total_bytes, "budget": setup.budget }));

    let started = Instant::now();
    let mut last = Instant::now();
    let (mut proved, mut proved_bytes) = (0u64, 0u64);
    let mut out = std::io::stdout().lock();
    let mut written = Ok(());
    let proved_line = |line: &Proved, requests: &BTreeMap<String, u64>, bytes: &BTreeMap<String, u64>| {
        proved += 1;
        proved_bytes += line.byte_length;
        // Each proof leaves this machine the moment it is proved, so a lost connection loses no finished work.
        if written.is_ok() {
            written = serde_json::to_string(line).map_err(std::io::Error::other).and_then(|text| writeln!(out, "{text}")).and_then(|()| out.flush());
        }
        if last.elapsed() >= PROGRESS_EVERY {
            last = Instant::now();
            let progress: BTreeMap<&str, serde_json::Value> = BTreeMap::from([
                ("seconds", json!(started.elapsed().as_secs())),
                ("proved", json!(proved)),
                ("of", json!(total)),
                ("proved_bytes", json!(proved_bytes)),
                ("requests", json!(requests)),
                ("bytes", json!(bytes)),
            ]);
            eprintln!("{}", json!(progress));
        }
    };
    let report = if setup.pack {
        let packs = pack_plan(keys);
        eprintln!("{}", json!({ "archives": packs.len() }));
        pack_keys(&objects, &setup.from, &setup.to, setup.concurrency, Some(setup.budget), packs, proved_line)
    } else {
        let route = Route { from: &setup.from, to: &setup.to, width: setup.concurrency };
        carry_keys(&objects, route, Some(setup.budget), keys, proved_line)
    };
    written?;
    eprintln!("{}", serde_json::to_string(&json!({ "done": summary(&report) }))?);
    Ok(if report.budget_spent.is_some() { 2 } else if report.failed > 0 { 1 } else { 0 })
}

/// The final report with its failures counted by reason (no key leaves this machine on stderr).
fn summary(report: &moves::Carried) -> serde_json::Value {
    let mut reasons: BTreeMap<&str, u64> = BTreeMap::new();
    for failed in &report.failures {
        *reasons.entry(failed.why.as_str()).or_default() += 1;
    }
    json!({
        "proved": report.proved, "proved_bytes": report.proved_bytes, "failed": report.failed,
        "failure_reasons_of_first_reported": reasons, "requests": report.requests, "bytes": report.bytes,
        "budget_spent": report.budget_spent, "seconds": report.seconds,
    })
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("account_files_carry: {error}");
            std::process::exit(3);
        }
    }
}
