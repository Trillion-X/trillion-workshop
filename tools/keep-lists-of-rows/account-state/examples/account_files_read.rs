// examples/account_files_read.rs
//
// Purpose: Read the bytes of account files by content identity (`1f:<blake3>`) or drive-store alias (`12:<sha256>`)
// into local files, one file with an optional byte range, or many files from a TSV in one run.
// Invariants: reads only (ranged GETs on the origin the file's record names); nothing is written to a bucket. A whole
// file read is checked against its identity (BLAKE3 of the bytes must equal a `1f:` identity) and reported, never
// assumed. A row the current account files or vault refuses is reported on its line and the run goes on; this diagnostic
// does not establish which credentials are held for an unqueried origin.
// Key concepts: `account_files::AccountFiles::{find_file, read_range}`, `account_files::objects::S3Objects`, the secrets vault.
// Security: requests are signed through the secrets vault, which keeps the secret; stdout holds identities, sizes
// and statuses only.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage:
//   account_files_read RECORD_STORE_SQLITE ACCOUNT one ID OUT_FILE [OFFSET [LENGTH]]
//   account_files_read RECORD_STORE_SQLITE ACCOUNT batch TSV OUT_DIR
//   account_files_read RECORD_STORE_SQLITE ACCOUNT list FOLDER [AFTER]
// Listing uses the same account files owner and returns one bounded page of names and folders; it reads no object bytes.
// The TSV has a header line; the `identity` column names each file (empty cells are skipped) and the optional `ext`
// column gives the output extension. Each output file is `OUT_DIR/<identity hex>.<ext>`. Stdout: one line per row,
// `identity<TAB>bytes<TAB>status` (status `ok`, `ok-range`, `blake3-mismatch` or `error: ...`).

use content_crypto::advanced::blake3;
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    time::Duration,
};
use trillion_local::{
    secrets::{self, SecretsKey, Secrets as Vault, KeychainItem, VaultIdentity},
    account_files::{
        objects::{Origin, S3Objects},
        AccountFiles, FILES, ORIGINS,
    },
    records::{Records, MAX_PAGE_ITEMS},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Spend},
        Storage,
    },
};

/// The most bytes one ranged read asks for.
const STEP: u64 = 8 * 1024 * 1024;

type Failure = Box<dyn std::error::Error>;

/// Reads `[offset, offset + length)` of the file named by `id` into `out`, returning the bytes written and, for a whole
/// file, whether its BLAKE3 equals its `1f:` identity.
fn read_into(ns: &AccountFiles<impl Storage + Send>, account: &str, id: &str, out: &Path, offset: u64, length: Option<u64>) -> Result<(u64, Option<bool>), Failure> {
    let row = ns.find_file(id)?;
    let identity = row["identity"].as_str().ok_or("the file has no identity")?.to_owned();
    let size = row["byte_length"].as_u64().ok_or("the file has no length")?;
    let file = ns.store.get(account, FILES, &identity)?.record.ok_or("file record")?;
    let end = length.map_or(size, |length| offset.saturating_add(length)).min(size);
    let whole = offset == 0 && end == size;
    let mut sink = BufWriter::new(File::create(out)?);
    let mut hash = blake3::Hasher::new();
    let mut at = offset;
    while at < end {
        let bytes = ns.read_range(&file, at, STEP.min(end - at))?;
        if bytes.is_empty() {
            return Err("the origin returned no bytes".into());
        }
        sink.write_all(&bytes)?;
        hash.update(&bytes);
        at += bytes.len() as u64;
    }
    sink.flush()?;
    let verified = (whole && identity.starts_with("1f:")).then(|| format!("1f:{}", hash.finalize().to_hex()) == identity);
    Ok((at - offset, verified))
}

fn run() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let usage = "usage: account_files_read RECORD_STORE_SQLITE ACCOUNT one ID OUT_FILE [OFFSET [LENGTH]] | batch TSV OUT_DIR | list FOLDER [AFTER]";
    let [store_path, account, mode, rest @ ..] = args.as_slice() else { return Err(usage.into()) };
    let store_path = std::fs::canonicalize(store_path)?;
    let supply = sqlite::open_owned(
        &store_path,
        "record_store",
        sqlite::Bounds { value_bytes: 64 * 1024 * 1024, work: u64::MAX / 2, deadline: Duration::MAX, spend: Spend::EachOperation, cancel: None, busy: Duration::from_secs(5) },
    )?;
    let volume = settings::Volume { store_bytes: supply.allocated_bytes()?, free_bytes: settings::volume_free_bytes(&store_path)? };
    let limits = trillion_local::storage::record_store_resources::computer_limits_from(trillion_local::account::computers::this_computer(), &volume)
        .map_err(|_| "this computer's limits")?;
    let store = RecordStore::new(supply, Box::new(RealClock), limits)?;
    let kept = KeychainItem::shipped()?;
    let root = SecretsKey::from_keychain(&kept)?;
    let naming = VaultIdentity::new(trillion_local::account_files::identity::word()?).map_err(|error| error.code_string().to_owned())?;
    let vault = Vault::open(secrets::open_store(&store_path)?, account, &root, naming)?;
    let origins: Vec<(String, Origin)> = store
        .list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?
        .items
        .into_iter()
        .map(|record| Ok((record.id, serde_json::from_value(record.value)?)))
        .collect::<Result<_, serde_json::Error>>()?;
    let objects = S3Objects::unmetered(origins, Box::new(vault), "operator example account_files_read")?;
    let ns = AccountFiles::with_objects(store, account, Box::new(objects));

    match (mode.as_str(), rest) {
        ("list", [folder, cursor @ ..]) if cursor.len() <= 1 => {
            println!("{}", ns.list_files(Some(folder), cursor.first().map(String::as_str), Some(1000))?);
        }
        ("one", [id, out, range @ ..]) => {
            let offset = range.first().map(|text| text.parse::<u64>()).transpose()?.unwrap_or(0);
            let length = range.get(1).map(|text| text.parse::<u64>()).transpose()?;
            let (bytes, verified) = read_into(&ns, account, id, Path::new(out), offset, length)?;
            let status = match verified {
                Some(true) => "ok",
                Some(false) => "blake3-mismatch",
                None => "ok-range",
            };
            println!("{id}\t{bytes}\t{status}");
        }
        ("batch", [tsv, out_dir]) => {
            std::fs::create_dir_all(out_dir)?;
            let text = std::fs::read_to_string(tsv)?;
            let mut lines = text.lines();
            let header: Vec<&str> = lines.next().ok_or("the TSV is empty")?.split('\t').collect();
            let column = |name: &str| header.iter().position(|cell| *cell == name);
            let identity_at = column("identity").ok_or("the TSV has no `identity` column")?;
            let ext_at = column("ext");
            for line in lines {
                let cells: Vec<&str> = line.split('\t').collect();
                let id = cells.get(identity_at).copied().unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                let ext = ext_at.and_then(|at| cells.get(at)).copied().unwrap_or("");
                let name = id.split_once(':').map_or(id, |(_, hex)| hex);
                let target = Path::new(out_dir).join(if ext.is_empty() { name.to_owned() } else { format!("{name}.{ext}") });
                match read_into(&ns, account, id, &target, 0, None) {
                    Ok((bytes, Some(false))) => println!("{id}\t{bytes}\tblake3-mismatch"),
                    Ok((bytes, _)) => println!("{id}\t{bytes}\tok"),
                    Err(error) => {
                        let _ = std::fs::remove_file(&target);
                        println!("{id}\t0\terror: {error}");
                    }
                }
            }
        }
        _ => return Err(usage.into()),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("account_files_read: {error}");
        std::process::exit(1);
    }
}
