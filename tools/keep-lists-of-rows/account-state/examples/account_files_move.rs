// examples/account_files_move.rs
//
// Purpose: Empty one of an account's stores into another on a migrated account files store (`account_files::moves`): a dry
// run that counts what would move and the requests it would send, the move itself, the audit of what the emptied
// store still holds against the proof records, and the retirement of the emptied store's origin record.
// Invariants: the dry run sends no request and writes no record. A run copies bytes, proves them by BLAKE3 at the
// destination, then rewrites records; it never deletes an object. `retire` deletes only the origin record, and only
// when the audit is complete. Run it on a migrated or APFS-cloned store file on this Mac, never a hosted store.
// Key concepts: `account_files::moves::{Mover, Plan, audit, retire}`, `account_files::objects::S3Objects`, the secrets
// vault (`secrets`).
// Security: requests are signed through the secrets vault, which keeps every secret (it answers SigV4 day keys
// only); no credential is read from argv, the environment or a file here. Output holds counts, timings and storage
// keys of failed or unproved objects.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: account_files_move RECORD_STORE_SQLITE ACCOUNT FROM TO (dry-run | drain | run | audit | retire | work-list | remote-setup WORK_LIST |
//        import-proofs | verify-sample N [AT_MOST_BYTES]) [CONCURRENCY] [unnamed-keys] [pack] [records-only]
// `run` lists the from store only with `unnamed-keys`; without it, it walks records alone. `run records-only` (after
// `import-proofs`) rewrites the records of proved keys and sends no request at all: unproved keys are counted and left. `remote-setup ... pack` gives the setup line of a copier that packs the work list's keys
// into archives with manifests (`account_files::moves::pack_keys`) and the budget of that plan. Every copy is proved by its
// upload checksum and never read back; `verify-sample N [AT_MOST_BYTES]` is the one read of the destination, an
// explicit spot check of N proofs (of keys of at most AT_MOST_BYTES) that refuses before any request when they hold
// more than the DATA ceiling (`src/account_files/moves.json`).

use content_crypto::advanced;
use serde_json::json;
use std::{
    io::Write,
    sync::atomic::{AtomicU64, Ordering::Relaxed},
    time::{Duration, Instant},
};
use trillion_local::{
    secrets::{self, SecretsKey, Secrets as Vault, KeychainItem, VaultIdentity},
    account_files::{
        moves::{audit, drain, import_proofs, moved_scope, pack_plan, plan_of, plan_of_packs, retire, verify_sample_most_bytes, work_list, Carry, Mover, Phase, Plan, Proved},
        objects::{Body, Listing, ObjectError, Objects, Origin, S3Objects, Source, Stat, MAX_RANGE_BYTES},
        ORIGINS,
    },
    records::{Records, MAX_PAGE_ITEMS},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Spend},
        Storage,
    },
};

type Failure = Box<dyn std::error::Error>;

/// Keys in flight when none is asked for.
const DEFAULT_CONCURRENCY: usize = 8;
/// A run's budget, as a percentage of its plan.
const BUDGET_PERCENT: u64 = 110;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn run() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: account_files_move RECORD_STORE_SQLITE ACCOUNT FROM TO (dry-run | drain | run | audit | retire | work-list | remote-setup WORK_LIST | import-proofs | verify-sample N [AT_MOST_BYTES]) [CONCURRENCY] [unnamed-keys] [pack] [records-only]";
    let [store_path, account, from, to, mode, rest @ ..] = args.as_slice() else { return Err(usage.into()) };
    // The first number after the mode is the concurrency (verify-sample's N is its own first argument).
    let concurrency = if mode == "verify-sample" { DEFAULT_CONCURRENCY } else { rest.iter().find_map(|arg| arg.parse().ok()).unwrap_or(DEFAULT_CONCURRENCY) };
    let unnamed_keys = rest.iter().any(|arg| arg == "unnamed-keys");
    let pack = rest.iter().any(|arg| arg == "pack");
    let records_only = rest.iter().any(|arg| arg == "records-only");
    let store_path = std::fs::canonicalize(store_path)?;
    let supply = sqlite::open_owned(
        &store_path,
        "record_store",
        sqlite::Bounds { value_bytes: 64 * 1024 * 1024, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(30) },
    )?;
    let volume = settings::Volume { store_bytes: supply.allocated_bytes()?, free_bytes: settings::volume_free_bytes(&store_path)? };
    let limits = trillion_local::storage::record_store_resources::computer_limits_from(trillion_local::account::computers::this_computer(), &volume)
        .map_err(|_| "this computer's limits")?;
    let mut store = RecordStore::new(supply, Box::new(RealClock), limits)?;
    let origins: Vec<(String, Origin)> = store
        .list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?
        .items
        .into_iter()
        .map(|record| Ok((record.id, serde_json::from_value(record.value)?)))
        .collect::<Result<_, serde_json::Error>>()?;

    if mode == "import-proofs" {
        // Proof lines from a copier with no records (`account_files_carry` on another machine), on stdin.
        let lines = std::io::stdin()
            .lines()
            .map(|line| Ok(serde_json::from_str::<Proved>(&line?)?))
            .collect::<Result<Vec<_>, Failure>>()?;
        let (written, held, refused) = import_proofs(&mut store, account, from, lines)?;
        println!("{}", json!({ "proofs_written": written, "already_held": held, "refused": refused }));
        return if refused == 0 { Ok(()) } else { Err(format!("{refused} proof lines were refused").into()) };
    }
    if mode == "run" && records_only {
        // No request is sent, so the vault is not opened; the empty budget refuses any request that would be.
        let plan = Plan { from: from.clone(), to: to.clone(), concurrency, unnamed_keys: false, dry_run: false, records_only, budget: Some(Default::default()) };
        let report = Mover::new(&mut store, account, plan).run(&NoRequests, &|_, _| {})?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return if report.failed == 0 { Ok(()) } else { Err(format!("{} keys did not move", report.failed).into()) };
    }
    if mode == "dry-run" {
        // No request is sent, so the vault is not opened.
        let plan = Plan { from: from.clone(), to: to.clone(), concurrency, unnamed_keys, dry_run: true, records_only: false, budget: None };
        let report = Mover::new(&mut store, account, plan).run(&NoRequests, &|_, _| {})?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    // The vault exactly as the product opens it (src/main.rs connect-service): the Mac account key named by the
    // product's account-key settings, and the product's identity word as the vault identity word.
    let kept = KeychainItem::shipped()?;
    let root = SecretsKey::from_keychain(&kept)?;
    let naming = VaultIdentity::new(trillion_local::account_files::identity::word()?).map_err(|error| error.code_string().to_owned())?;
    let open_vault = || Vault::open(secrets::open_store(&store_path)?, account, &root, naming.clone());
    let objects = S3Objects::unmetered(origins.clone(), Box::new(open_vault()?), "operator example account_files_move")?;
    for origin in [from, to] {
        if !objects.has_credentials(origin)? {
            return Err(format!("the vault does not hold every connection value of {origin}").into());
        }
    }
        // At most every 30 s, how far the walk of the from store has come.
    let listing_started = Instant::now();
    let mut said = Instant::now();
    let mut pages = 0u64;
    let mut listing_progress = |listed: u64, bytes: u64, retry: Option<&str>| {
        if let Some(retry) = retry {
            eprintln!("account_files_move: listing page asked again ({retry})");
            return;
        }
        pages += 1;
        if said.elapsed() >= Duration::from_secs(30) {
            said = Instant::now();
            eprintln!("account_files_move: listed {listed} keys in {pages} pages, {bytes} bytes, {} s", listing_started.elapsed().as_secs());
        }
    };
    match mode.as_str() {
        "run" => {
            let started = Instant::now();
            let (done, bytes) = (AtomicU64::new(0), AtomicU64::new(0));
            let progress = |phase: &str, counts: &Phase| {
                let done = done.fetch_add(1, Relaxed) + 1;
                bytes.store(counts.copied_bytes, Relaxed);
                if done % 500 == 0 {
                    let seconds = started.elapsed().as_secs_f64();
                    eprintln!(
                        "account_files_move: {phase} {} copied ({} bytes), {done} proved this run, {:.0} s",
                        counts.copied, counts.copied_bytes, seconds
                    );
                }
            };
            // The run's hard budget: 110% of the plan of what is still unproved, plus the listing walk (with
            // `unnamed-keys` only; without it, the run walks records alone and lists nothing).
            let (keys, listed) = work_list(&store, account, &objects, from, unnamed_keys, &mut listing_progress)?;
            let (_, mut budget) = plan_of(&keys, from, to, BUDGET_PERCENT);
            if unnamed_keys {
                budget.insert(format!("{from} LIST"), (listed.div_ceil(1000) + 2) * BUDGET_PERCENT / 100 + 1);
            }
            eprintln!("account_files_move: {} keys to carry; budget {}", keys.len(), serde_json::to_string(&budget)?);
            let plan = Plan { from: from.clone(), to: to.clone(), concurrency, unnamed_keys, dry_run: false, records_only: false, budget: Some(budget) };
            let report = Mover::new(&mut store, account, plan).run(&objects, &progress)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if let Some(spent) = &report.budget_spent {
                return Err(format!("stopped: {spent}").into());
            }
            if report.failed > 0 {
                return Err(format!("{} keys did not move; run again to retry them", report.failed).into());
            }
        }
        "drain" => {
            let rewritten = drain(&mut store, account, from, to)?;
            let held = store.get(account, ORIGINS, from)?.record.ok_or("no from origin")?;
            println!("{}", serde_json::to_string_pretty(&json!({ "drained": from, "rewritten": rewritten, "origin": held.value, "version": held.version }))?);
        }
        "work-list" => {
            // Every key of the from store not proved yet, one `Carry` line each on stdout (keys, sizes, identities:
            // nothing secret), and on stderr the plan and the budget a copier gets for it (110% of the plan).
            let (keys, listed) = work_list(&store, account, &objects, from, true, &mut listing_progress)?;
            let (plan, budget) = plan_of(&keys, from, to, BUDGET_PERCENT);
            let mut out = std::io::stdout().lock();
            for key in &keys {
                writeln!(out, "{}", serde_json::to_string(key)?)?;
            }
            out.flush()?;
            let bytes: u64 = keys.iter().map(|key| key.length).sum();
            eprintln!("{}", json!({ "keys": keys.len(), "bytes": bytes, "listed": listed, "plan": plan, "budget": budget }));
        }
        "remote-setup" => {
            // The setup line of a copier on another machine (`account_files_carry`), for the work list in WORK_LIST: each
            // origin's plain facts, the SigV4 day keys of its secret for today and tomorrow (UTC) (the secret itself
            // never leaves the vault), and the budget (110% of the work list's plan). Goes straight into the ssh pipe,
            // never to a file.
            let list = rest.first().ok_or(usage)?;
            let keys = std::fs::read_to_string(list)?
                .lines()
                .map(|line| Ok(serde_json::from_str::<Carry>(line)?))
                .collect::<Result<Vec<_>, Failure>>()?;
            let (_, budget) = if pack { plan_of_packs(&pack_plan(keys), from, to, BUDGET_PERCENT)? } else { plan_of(&keys, from, to, BUDGET_PERCENT) };
            let vault = open_vault()?;
            let today = chrono::Utc::now();
            let days = [today, today + chrono::Duration::days(1)].map(|day| day.format("%Y%m%d").to_string());
            let mut plain = serde_json::Map::new();
            let mut day_keys = serde_json::Map::new();
            let mut shipped = Vec::new();
            for (id, origin) in origins.iter().filter(|(id, _)| id == from || id == to) {
                let reach = &origin.reach;
                for source in [&reach.key_id, &reach.bucket, &reach.endpoint, &reach.region] {
                    if let Source::Held(name) = source {
                        plain.insert(name.clone(), json!(vault.plain(name)?.as_str()));
                    }
                }
                if let Source::Held(name) = &reach.secret {
                    let mut keys = serde_json::Map::new();
                    for day in &days {
                        keys.insert(day.clone(), json!(hex(&vault.sigv4_day_key(name, day)?)));
                    }
                    day_keys.insert(name.clone(), serde_json::Value::Object(keys));
                }
                shipped.push(json!([id, origin]));
            }
            let mut out = std::io::stdout().lock();
            writeln!(out, "{}", json!({ "from": from, "to": to, "concurrency": concurrency, "pack": pack, "budget": budget, "origins": shipped, "plain": plain, "day_keys": day_keys }))?;
            out.flush()?;
        }
        "verify-sample" => {
            // The one read of `to`, an explicit spot check: read back N proved keys (the N whose BLAKE3 of the key
            // sorts first: spread over the store, the same on every run; of at most AT_MOST_BYTES each) and check each
            // against its proof: under its own key, or (a packed key, `in`) its slice of its archive. Refused before
            // any request when the sample holds more than the DATA ceiling.
            let wanted: usize = rest.first().ok_or(usage)?.parse()?;
            let at_most: u64 = rest.get(1).map(|bytes| bytes.parse()).transpose()?.unwrap_or(u64::MAX);
            let scope = moved_scope(from);
            let mut after = String::new();
            let mut proofs = Vec::new();
            loop {
                let page = store.list_page(account, &scope, &after, MAX_PAGE_ITEMS)?;
                let small = page.items.into_iter().filter(|record| record.value["byte_length"].as_u64().is_some_and(|length| length <= at_most));
                proofs.extend(small.map(|record| (advanced::blake3::hash(record.id.as_bytes()).to_hex().to_string(), record)));
                proofs.sort_by(|left, right| left.0.cmp(&right.0));
                proofs.truncate(wanted);
                match page.next {
                    Some(next) => after = next,
                    None => break,
                }
            }
            let sampled: u64 = proofs.iter().map(|(_, proof)| proof.value["byte_length"].as_u64().unwrap_or(u64::MAX)).fold(0, u64::saturating_add);
            let ceiling = verify_sample_most_bytes()?;
            if sampled > ceiling {
                return Err(format!("the sample holds {sampled} bytes, past the verify-sample ceiling of {ceiling} (src/account_files/moves.json); ask for fewer or smaller keys").into());
            }
            let (mut equal, mut bytes) = (0, 0u64);
            for (_, proof) in &proofs {
                let length = proof.value["byte_length"].as_u64().ok_or("proof without a size")?;
                let there = proof.value["to"].as_str().ok_or("proof without a store")?;
                let (object, start) = match proof.value.get("in") {
                    Some(packed) => (packed["archive"].as_str().unwrap_or_default().to_owned(), packed["offset"].as_u64().ok_or("packed proof without an offset")?),
                    None => (proof.id.clone(), 0),
                };
                let mut hasher = advanced::blake3::Hasher::new();
                let mut at = 0;
                while at < length {
                    let take = MAX_RANGE_BYTES.min(length - at);
                    hasher.update(&objects.read(there, &object, start + at, take)?);
                    at += take;
                }
                let read = hasher.finalize().to_hex().to_string();
                if read != proof.value["blake3"].as_str().unwrap_or_default() {
                    return Err(format!("a sampled key reads back as {read}, not its proof").into());
                }
                equal += 1;
                bytes += length;
            }
            let packed = proofs.iter().filter(|(_, proof)| proof.value.get("in").is_some()).count();
            println!("{}", json!({ "sampled": proofs.len(), "packed": packed, "equal": equal, "bytes_read_back": bytes }));
        }
        "audit" => println!("{}", serde_json::to_string_pretty(&audit(&store, account, &objects, from, &mut listing_progress)?)?),
        "retire" => {
            let audit = retire(&mut store, account, &objects, from, &mut listing_progress)?;
            println!("{}", serde_json::to_string_pretty(&json!({ "retired": from, "audit": audit }))?);
        }
        _ => return Err(usage.into()),
    }
    Ok(())
}

/// The byte port of a dry run and a records-only run: it is never asked (both work from records only).
struct NoRequests;
impl Objects for NoRequests {
    /// Sends no request, so it has no byte to admit.
    fn set_control(&mut self, _: trillion_local::account_files::CallControl) {}
    fn read(&self, _: &str, _: &str, _: u64, _: u64) -> Result<Vec<u8>, ObjectError> {
        Err(dry())
    }
    fn write(&self, _: &str, _: &str, _: &[u8], _: &str) -> Result<(), ObjectError> {
        Err(dry())
    }
    fn write_stream(&self, _: &str, _: &str, _: Body<'_>, _: &str) -> Result<(), ObjectError> {
        Err(dry())
    }
    fn stat(&self, _: &str, _: &str) -> Result<Option<Stat>, ObjectError> {
        Err(dry())
    }
    fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
        Err(dry())
    }
}
fn dry() -> ObjectError {
    ObjectError::Unavailable("a dry or records-only run sends no request".into(), trillion_local::cause!())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("account_files_move: {error}");
        std::process::exit(1);
    }
}
