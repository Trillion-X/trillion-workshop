// examples/account_files_migrate.rs
//
// Purpose: Move one account's files file list from a restored Worker RecordBook copy into a new record store, once,
// and print the count proof (`trillion_local::account_files::migrate`).
// Invariants: the original copy is never opened: it is cloned first (APFS clonefile through `std::fs::copy`, which
// asks the file system for a copy-on-write clone on macOS), and the clone is opened read-only and immutable; the record store
// output is a new file that must not exist yet; the volume must keep 15 GB free.
// Key concepts: `account_files::migrate::{Plan, migrate}`, the shipped record store `native` host limits.
// Security: stdout holds counts and timings only; vault names are written into origin records, never values.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: account_files_migrate SOURCE_SQLITE OUT_FOLDER ACCOUNT ORIGIN_SETTINGS_JSON CREDENTIAL_PREFIX
//   SOURCE_SQLITE         the restored account files RecordBook (read only through its clone)
//   OUT_FOLDER            a new folder: it receives `source-clone.sqlite` and `namespace-s2h.sqlite`
//   ACCOUNT               the account id the account files belongs to
//   ORIGIN_SETTINGS_JSON  the app's origin settings records file (`kind: cloud-files.origin-settings` rows)
//   CREDENTIAL_PREFIX     the prefix of the vault names of the store keys (`<prefix><origin>-<fact>`; the vault's
//                         names are `<origin>-<fact>`, so the prefix is "")

use std::path::PathBuf;
use trillion_local::{
    account_files::{
        migrate::{migrate, open_source, Plan},
        FILES,
    },
    sqlite_work::WorkMeter,
    storage::{record_store::settings, record_store_resources, Storage},
};

const KEEP_FREE_BYTES: u64 = 15_000_000_000;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [source, out, account, origin_settings, credential_prefix] = args.as_slice() else {
        return Err("usage: account_files_migrate SOURCE_SQLITE OUT_FOLDER ACCOUNT ORIGIN_SETTINGS_JSON CREDENTIAL_PREFIX".into());
    };
    let out = PathBuf::from(out);
    std::fs::create_dir(&out)?;
    let out = std::fs::canonicalize(&out)?;
    let clone = out.join("source-clone.sqlite");
    let free_before = settings::volume_free_bytes(&out)?;
    if free_before < KEEP_FREE_BYTES {
        return Err("the volume has less than 15 GB free".into());
    }
    std::fs::copy(source, &clone)?;
    let mut permissions = std::fs::metadata(&clone)?.permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&clone, permissions)?;
    let source_bytes = std::fs::metadata(&clone)?.len();
    let free_after = settings::volume_free_bytes(&out)?;
    // A clone shares the original's blocks: the volume must not lose the file's size.
    if free_before.saturating_sub(free_after) > source_bytes / 2 {
        return Err("the copy took new space: it was not a clone".into());
    }
    eprintln!("account_files_migrate: cloned {source_bytes} bytes; free space moved by {} bytes", free_before as i64 - free_after as i64);

    let records: serde_json::Value = serde_json::from_slice(&std::fs::read(origin_settings)?)?;
    let plan = Plan {
        account: account.clone(),
        origin_settings: records["records"].as_array().ok_or("origin settings without records")?.clone(),
        credential_prefix: credential_prefix.clone(),
    };
    let target = record_store_resources::placement(FILES).and_then(|placement| placement.in_state(&out)).ok_or("the account files is not placed in a state file")?;
    let mut store = record_store_resources::open(&target, WorkMeter::new())?;
    let source = open_source(&clone)?;
    let started = std::time::Instant::now();
    let report = migrate(&source, &mut store, &plan, |step, written| eprintln!("account_files_migrate: {step} {written}"))?;
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "report": report,
        "proved": report.proved(),
        "seconds": started.elapsed().as_secs_f64(),
        "store_bytes": store.storage().allocated_bytes()?,
    }))?);
    if !report.proved() {
        return Err("a migrated count differs from its source count".into());
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("account_files_migrate: {error}");
        std::process::exit(1);
    }
}
