// examples/account_files_inventory.rs
//
// Purpose: List every key of one account files origin (a bucket) with its size, so the bucket's real contents can be
// totalled by prefix and compared with the RecordBook.
// Invariants: reads only (list requests); writes nothing to the bucket. Output is `key<TAB>bytes` lines, one per
// object, in key order, to the named file.
// Key concepts: `account_files::objects::{Objects, S3Objects}`, the secrets vault (`secrets`).
// Security: requests are signed through the secrets vault, which keeps the secret; output holds keys and sizes.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: account_files_inventory RECORD_STORE_SQLITE ACCOUNT ORIGIN PREFIX OUT_TSV

use std::{io::Write, time::Duration};
use trillion_local::{
    secrets::{self, SecretsKey, Secrets as Vault, KeychainItem, VaultIdentity},
    account_files::{
        objects::{Objects, Origin, S3Objects},
        ORIGINS,
    },
    records::{Records, MAX_PAGE_ITEMS},
    storage::{
        record_store::{settings, RecordStore, RealClock},
        sqlite::{self, Spend},
        Storage,
    },
};

/// The most keys one S3 list request returns.
const LISTING_KEYS: usize = 1000;

type Failure = Box<dyn std::error::Error>;

fn run() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [store_path, account, origin, prefix, out] = args.as_slice() else {
        return Err("usage: account_files_inventory RECORD_STORE_SQLITE ACCOUNT ORIGIN PREFIX OUT_TSV".into());
    };
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
    let objects = S3Objects::unmetered(origins, Box::new(vault), "operator example account_files_inventory")?;
    let mut file = std::io::BufWriter::new(std::fs::File::create(out)?);
    let (mut after, mut count, mut bytes) = (String::new(), 0u64, 0u64);
    loop {
        let page = objects.list(origin, prefix, &after, LISTING_KEYS)?;
        for (key, size) in &page.objects {
            writeln!(file, "{key}\t{size}")?;
            count += 1;
            bytes += size;
        }
        match page.objects.last() {
            Some((last, _)) if page.more => after = last.clone(),
            _ => break,
        }
    }
    file.flush()?;
    println!("{origin} {prefix}: {count} objects, {bytes} bytes");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("account_files_inventory: {error}");
        std::process::exit(1);
    }
}
